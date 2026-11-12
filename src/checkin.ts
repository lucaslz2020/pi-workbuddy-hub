/**
 * 签到核心 —— 全项目**唯一**的签到实现（agent 命令、CLI、定时任务共用）。
 *
 * 顺序严格照客户端的做法，任何一步都不跳：
 *   1. 查活动状态（只读、无副作用）
 *   2. 活动没开 / 今天已签 → 直接给结论，**不发领奖请求**
 *   3. 否则领一次，并把业务码当「关于今天的答案」而非「失败」
 *
 * 因此本模块天然幂等：一天跑几次，只有第一次真的 POST 领奖。
 *
 * 401 是「登录态失效」，与「活动没开」完全不同 —— 前者要人去重登，
 * 后者是正常状态。混在一起报会把一个本来能用的号误判成坏了。
 */

import {
  CHECKIN_STATUS_PATHS,
  CLIENT_UA,
  CODE_ALREADY,
  CODE_ENDED,
  CODE_INELIGIBLE,
  CN_BILLING_BASES,
  CREDITS_PATH,
  DAILY_CHECKIN_PATH,
  ENTERPRISE_CREDITS_PATH,
  JSON_TIMEOUT_MS,
  REFRESH_PATH,
  globalBase,
  regionOf,
} from './upstream.ts'
import { boolOf, envelopeCode, envelopeData, envelopeMessage, intOf, optional, strOf } from './fields.ts'
import { isPlainObject } from './jsonfile.ts'
import type { AccountCredential, CheckinOutcome } from './accounts.ts'

// ---------------------------------------------------------------------------
// 费用类请求的公共管道
// ---------------------------------------------------------------------------

/** 一次账务 POST 的解析结果。非 JSON 也保留 HTTP 状态，交给调用方分类。 */
export interface BillingAnswer {
  httpStatus: number
  code: number
  message?: string
  data: Record<string, unknown>
  /** false = 网关回的不是 JSON（WAF 挑战页等），绝不能按业务成功解释。 */
  json: boolean
}

/** 这个凭据能用的计费基址（国际版跟随签发域，国内版有候选）。 */
export function billingBasesFor(credential: AccountCredential): string[] {
  return regionOf(credential.domain) === 'global'
    ? [globalBase(credential.domain)]
    : [...CN_BILLING_BASES]
}

/** 账务接口认的 header（客户端的，不是 CLI 的）。 */
function billingHeaders(credential: AccountCredential): Record<string, string> {
  return {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': CLIENT_UA,
    ...(credential.uid === '' ? {} : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? {}
      : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? {} : { 'X-Domain': credential.domain }),
  }
}

/** 解析一次 HTTP 响应成信封。非 JSON 的正文当 message（截断）。 */
async function readAnswer(response: Response): Promise<BillingAnswer> {
  const text = await response.text()
  let document: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (isPlainObject(parsed)) document = parsed
  } catch {
    document = undefined
  }
  if (document === undefined) {
    return { httpStatus: response.status, code: 0, message: text.slice(0, 120), data: {}, json: false }
  }
  const message = envelopeMessage(document)
  return {
    httpStatus: response.status,
    code: envelopeCode(document),
    ...(message === undefined ? {} : { message }),
    data: envelopeData(document),
    json: true,
  }
}

export interface BillingRequest {
  credential: AccountCredential
  base: string
  path: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** 一次账务 POST（唯一的 fetch 出口）。 */
export async function billingPost(request: BillingRequest): Promise<BillingAnswer> {
  const response = await fetch(`${request.base}${request.path}`, {
    method: 'POST',
    headers: request.headers ?? billingHeaders(request.credential),
    body: JSON.stringify(request.body ?? {}),
    signal: request.signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  return readAnswer(response)
}

/**
 * 依次试基址/路径，直到拿到「网关认了」的响应。
 *
 * 只对**网关层失败**（404/405/5xx/非 JSON）换下一个候选 —— 401 和业务码
 * 都是真实答案，换基址只会把同一个答案再问一遍。
 */
async function billingWithFallback(
  credential: AccountCredential,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<BillingAnswer> {
  let lastError: unknown
  let lastAnswer: BillingAnswer | undefined
  for (const base of billingBasesFor(credential)) {
    for (const path of paths) {
      let answer: BillingAnswer
      try {
        answer = await billingPost({ credential, base, path, signal })
      } catch (error) {
        lastError = error
        continue
      }
      // 非 JSON（WAF 挑战页等）一律按网关异常换候选：HTML 200 不是「成功」，
      // 按成功解释会在领奖路径记一条假的 claimed、当天不再重试
      const gatewayBroken = answer.httpStatus === 404 || answer.httpStatus === 405
        || answer.httpStatus >= 500 || answer.json === false
      if (gatewayBroken) {
        lastAnswer = answer
        continue
      }
      return answer
    }
  }
  // JSON 的「坏答案」（404/业务码）是真实答案，调用方自己分类；
  // 非 JSON 的只能是网关/WAF 拦截，绝不能返回去当业务成功解释
  if (lastAnswer !== undefined && lastAnswer.json) return lastAnswer
  if (lastError instanceof Error) throw lastError
  throw new BillingError(
    `计费接口返回了非 JSON（可能是网关/WAF 拦截），已试完所有基址/路径${
      lastAnswer === undefined ? '' : `（http ${lastAnswer.httpStatus}）`}`,
    { retryable: true },
  )
}

/** 上游业务错误，带「是否值得重试」「是否要重登」两个判定。 */
export class BillingError extends Error {
  readonly retryable: boolean
  readonly unauthorized: boolean

  // 不用 TS 参数属性：Node 的类型擦除（strip-only）不支持它，而 bin/*.mjs 直接 import 本文件。
  constructor(message: string, options: { retryable?: boolean, unauthorized?: boolean } = {}) {
    super(message)
    this.name = 'BillingError'
    this.retryable = options.retryable === true
    this.unauthorized = options.unauthorized === true
  }
}

// ---------------------------------------------------------------------------
// 状态 / 领奖
// ---------------------------------------------------------------------------

export interface CheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays?: number
  dailyCredit?: number
  todayCredit?: number
  totalCredits?: number
  weekCheckinDays?: number
  activityName?: string
}

export function parseStatus(data: Record<string, unknown>): CheckinStatus {
  return {
    active: boolOf(data, 'active', 'Active'),
    todayCheckedIn: boolOf(data, 'today_checked_in', 'todayCheckedIn'),
    ...optional('streakDays', intOf(data, 'streak_days', 'streakDays')),
    ...optional('dailyCredit', intOf(data, 'daily_credit', 'dailyCredit')),
    ...optional('todayCredit', intOf(data, 'today_credit', 'todayCredit')),
    ...optional('totalCredits', intOf(data, 'total_credits', 'totalCredits')),
    ...optional('weekCheckinDays', intOf(data, 'week_checkin_days', 'weekCheckinDays')),
    ...optional('activityName', strOf(data, 'activity_name', 'activityName')),
  }
}

/** 查活动状态。401 抛「需重登」，其余失败分可重试/不可重试。 */
export async function fetchStatus(
  credential: AccountCredential,
  signal?: AbortSignal,
): Promise<CheckinStatus> {
  const answer = await billingWithFallback(credential, CHECKIN_STATUS_PATHS, signal)
  if (answer.httpStatus === 401) {
    throw new BillingError('登录态失效（http 401），需要重新登录该账号', { unauthorized: true })
  }
  if (answer.httpStatus >= 400) {
    throw new BillingError(
      `查询签到状态失败（http ${answer.httpStatus}）：${answer.message ?? `code=${answer.code}`}`,
      { retryable: true },
    )
  }
  if (answer.code !== 0) {
    throw new BillingError(
      `查询签到状态失败（code=${answer.code}）：${answer.message ?? '上游未说明'}`,
      { retryable: false },
    )
  }
  return parseStatus(answer.data)
}

export interface ClaimResult {
  /** 上游说「领到了」。 */
  claimed: boolean
  /** 业务码（0 = 成功）。1001/1002/1003 是关于今天的答案。 */
  code: number
  message?: string
  data: Record<string, unknown>
}

/** 领一次。业务码不抛，作为数据返回。 */
export async function claimDaily(credential: AccountCredential, signal?: AbortSignal): Promise<ClaimResult> {
  const answer = await billingWithFallback(credential, [DAILY_CHECKIN_PATH], signal)
  if (answer.httpStatus === 401) {
    throw new BillingError('签到请求被拒（http 401），登录态已失效', { unauthorized: true })
  }
  if (answer.httpStatus >= 400) {
    throw new BillingError(
      `签到失败（http ${answer.httpStatus}）：${answer.message ?? `code=${answer.code}`}`,
      { retryable: answer.httpStatus >= 500 },
    )
  }
  return { claimed: answer.code === 0, code: answer.code, ...optional('message', answer.message), data: answer.data }
}

// ---------------------------------------------------------------------------
// 余额（钱包里还剩多少积分）
// ---------------------------------------------------------------------------

/**
 * 账号当前可用积分。
 *
 * `remaining` 是「还能花多少」（钱包/资源包口径）；`periodCredits` 是签到活动
 * 口径的累计（`total_credits`，见 `CheckinStatus`）。两个字段含义不同、可能同时
 * 存在，所以分开报，绝不加在一起。
 */
export interface CreditBalance {
  /** 剩余可用积分（所有未过期资源包求和）。 */
  remaining: number
  /** 明细条数（资源包条目），排障用。 */
  packages?: number
}

/** 资源包条目里「还剩多少」：优先 Precise 字段，退化到整数，再按周期/总额切换。 */
function packageRemain(raw: Record<string, unknown>): number {
  const precise = (key: string): number | undefined => {
    const value = raw[`${key}Precise`]
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
    if (typeof value === 'number' && Number.isFinite(value)) return value
    return intOf(raw, key)
  }
  // 月度包按「本周期还剩」算，其它包按「总额还剩」算
  const hasCycle = raw['CycleCapacityRemain'] !== undefined || raw['CycleCapacityRemainPrecise'] !== undefined
  return Math.max(0, precise(hasCycle ? 'CycleCapacityRemain' : 'CapacityRemain') ?? 0)
}

/**
 * 个人账号：`/v2/billing/meter/get-user-resource`，把未过期资源包的剩余累加。
 *
 * 上游把明细包在 `Response.Data.Accounts` 里（两层信封），所以这里不用
 * `envelopeData` 那一层，直接按已知形状取；取不到就当「不知道」。
 */
function balanceOfUserResource(data: Record<string, unknown>): CreditBalance | undefined {
  const response = data['Response']
  const inner = typeof response === 'object' && response !== null && !Array.isArray(response)
    ? (response as Record<string, unknown>)['Data']
    : undefined
  const accounts = typeof inner === 'object' && inner !== null && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)['Accounts']
    : undefined
  if (!Array.isArray(accounts)) return undefined

  let remaining = 0
  let packages = 0
  for (const entry of accounts) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    packages += 1
    // 月度包即使剩余 0 也在列表里；非月度包剩 0 就是真的没有，跳过不影响求和
    remaining += packageRemain(raw)
  }
  return { remaining, packages }
}

/** 企业成员：`limitNum - credit`。 */
function balanceOfEnterprise(data: Record<string, unknown>): CreditBalance | undefined {
  const wrapper = data['Data']
  const inner = typeof wrapper === 'object' && wrapper !== null && !Array.isArray(wrapper)
    ? wrapper as Record<string, unknown>
    : data
  const limit = intOf(inner, 'limitNum', 'LimitNum')
  const used = intOf(inner, 'credit', 'Credit')
  if (limit === undefined || used === undefined) return undefined
  return { remaining: Math.max(0, limit - used) }
}

/** 上游的 Precise 字段带一串尾数（`4035.5700005`），报给人看只留 2 位。 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 一次余额查询的结果。`reason` 只在没读到时存在 —— 它是「这次为什么不知道」，
 * 而不是一个错误码：余额是展示项，读不到不该把签到/status 整个弄失败。
 */
export interface CreditLookup {
  balance?: CreditBalance
  /** 没读到时的原因（给人看，不含 token）。 */
  reason?: string
}

/** 「这次没读到」分类成人话，避免「未知」看起来像「0 分」。 */
function lookupFailureOf(answer: BillingAnswer): string {
  if (answer.json === false) return `非 JSON（可能是网关/WAF 拦截，http ${answer.httpStatus}）`
  if (answer.httpStatus === 401) return '登录态失效（http 401）'
  if (answer.httpStatus === 429) return '上游限流（http 429）'
  if (answer.httpStatus >= 500) return `上游 ${answer.httpStatus}`
  if (answer.httpStatus >= 400) return `http ${answer.httpStatus}`
  return `上游业务码 ${answer.code}`
}

/**
 * 查账号剩余积分（只读、不花钱），并把失败原因带出来。
 *
 * 网关抖动/限流/非 JSON 重试一次再下结论；401 和业务码是「真实答案」，
 * 重试只会把同一个答案再问一遍，所以不重试。
 */
export async function fetchCreditBalanceLookup(
  credential: AccountCredential,
  signal?: AbortSignal,
): Promise<CreditLookup> {
  const enterprise = credential.enterpriseId !== undefined && credential.enterpriseId !== ''
  const paths = [enterprise ? ENTERPRISE_CREDITS_PATH : CREDITS_PATH]
  let reason = '未知原因'

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const answer = await billingWithFallback(credential, paths, signal)
      const definitive = answer.httpStatus === 401 || (answer.json && answer.httpStatus < 500)
      if (answer.httpStatus >= 400 || answer.code !== 0) {
        reason = lookupFailureOf(answer)
        if (definitive) return { reason }
      } else {
        const balance = enterprise ? balanceOfEnterprise(answer.data) : balanceOfUserResource(answer.data)
        if (balance !== undefined) {
          return { balance: { ...balance, remaining: roundCredits(balance.remaining) } }
        }
        // 网关认了请求但没有资源包明细：重试也不会变，直接说清楚
        return { reason: '上游返回里没有资源包明细' }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
    if (attempt === 0 && signal?.aborted !== true) {
      await new Promise<void>(resolve => { setTimeout(resolve, 400) })
    }
  }
  return { reason }
}

/**
 * 查账号剩余积分（只读、不花钱）。
 *
 * 与 `fetchStatus` 一样走 `billingWithFallback`：网关层失败才换基址/路径，401 与
 * 业务码是真实答案。查询失败**不抛**，返回 `undefined` —— 余额只是展示项，
 * 不能让「读不到余额」把一次签到/一次 status 整个弄失败。
 */
export async function fetchCreditBalance(
  credential: AccountCredential,
  signal?: AbortSignal,
): Promise<CreditBalance | undefined> {
  return (await fetchCreditBalanceLookup(credential, signal)).balance
}

// ---------------------------------------------------------------------------
// 一个账号的完整签到
// ---------------------------------------------------------------------------

export interface CheckinResult {
  outcome: CheckinOutcome
  credit?: number
  streakDays?: number
  status?: CheckinStatus
  /** 给人看的一句话。 */
  message: string
  /** 是否应该重试（网络/网关抖动）。业务码答案为 false。 */
  retryable: boolean
}

/** 连签提示；上游没给天数就什么都不说。 */
export function streakText(days: number | undefined): string {
  return days === undefined ? '' : `（连签 ${days} 天）`
}

function doneResult(status: CheckinStatus, credit: number | undefined, streakDays: number | undefined): CheckinResult {
  const gained = credit === undefined ? '' : `，今日 +${credit} 积分`
  return {
    outcome: 'done',
    status,
    ...optional('credit', credit),
    ...optional('streakDays', streakDays),
    message: `今天已经签到过了${streakText(streakDays)}${gained}`,
    retryable: false,
  }
}

/**
 * 一个账号的完整签到。**幂等**：今天已签就只读不写。
 *
 * `dryRun` 时只查状态，一个 POST 领奖都不发 —— CLI 的 `--dry-run` 就是它。
 */
export async function checkinAccount(
  credential: AccountCredential,
  signal?: AbortSignal,
): Promise<CheckinResult> {
  const status = await fetchStatus(credential, signal)

  if (!status.active) {
    return {
      outcome: 'inactive',
      status,
      message: '当前没有进行中的签到活动（或活动已结束），今天没有可领的积分',
      retryable: false,
    }
  }
  if (status.todayCheckedIn) return doneResult(status, status.todayCredit, status.streakDays)

  const claimed = await claimDaily(credential, signal)
  const credit = intOf(claimed.data, 'credit', 'Credit') ?? status.dailyCredit
  const streakDays = intOf(claimed.data, 'streak_days', 'streakDays') ?? status.streakDays
  const delayed = boolOf(claimed.data, 'credit_delayed', 'creditDelayed')

  if (claimed.claimed) {
    return {
      outcome: 'claimed',
      status,
      ...optional('credit', credit),
      ...optional('streakDays', streakDays),
      message: `签到成功，今日 +${credit === undefined ? '（上游未说明）' : credit} 积分`
        + `${streakText(streakDays)}${delayed ? '（上游提示积分稍后到账）' : ''}`,
      retryable: false,
    }
  }

  switch (claimed.code) {
    case CODE_ALREADY:
      return { ...doneResult(status, credit, streakDays), message: `今天已经签到过了${streakText(streakDays)}（上游 code ${CODE_ALREADY}）` }
    case CODE_INELIGIBLE:
      return {
        outcome: 'ineligible',
        status,
        message: `该账号不能参与本次签到：${claimed.message ?? `code ${CODE_INELIGIBLE}`}`,
        retryable: false,
      }
    case CODE_ENDED:
      return {
        outcome: 'inactive',
        status,
        message: `签到活动已结束：${claimed.message ?? `code ${CODE_ENDED}`}`,
        retryable: false,
      }
    default:
      return {
        outcome: 'failed',
        status,
        message: `签到失败（code=${claimed.code}）：${claimed.message ?? '上游未说明'}`,
        retryable: false,
      }
  }
}

// ---------------------------------------------------------------------------
// token 续期
// ---------------------------------------------------------------------------

/**
 * 用 refreshToken 换新 AT。**refreshToken 只出现在这里**，绝不进聊天请求。
 *
 * 各计费基址轮询（`billingBasesFor`），网关层失败换下一个；续期端点回 401 说明
 * refreshToken 已被上游拒绝 —— 直接抛 `unauthorized`，调用方不要再把它当
 * 「网关抖动」重试，也不要记成可恢复的冷却。
 *
 * 返回 undefined = 「不知道」（网关不可达/端点不认/业务码拒绝），调用方按失败处理。
 */
export async function refreshCredential(
  credential: AccountCredential,
  signal?: AbortSignal,
): Promise<AccountCredential | undefined> {
  if (credential.refreshToken === '') return undefined
  const headers: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
    'Content-Type': 'application/json',
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? {}
      : { 'X-Enterprise-Id': credential.enterpriseId }),
  }

  for (const base of billingBasesFor(credential)) {
    let answer: BillingAnswer
    try {
      answer = await billingPost({ credential, base, path: REFRESH_PATH, headers, signal })
    } catch {
      continue
    }
    // 网关不认识这个路径/挂了：换基址，别把「网关坏」当成「token 坏」
    if (answer.httpStatus === 404 || answer.httpStatus === 405 || answer.httpStatus >= 500) continue
    // JSON 的 401 才是上游的明确拒绝；HTML 401 可能是 WAF，按「不知道」继续试
    if (answer.httpStatus === 401 && answer.json) {
      throw new BillingError('refreshToken 已被上游拒绝（http 401），需要重新登录该账号', { unauthorized: true })
    }
    if (answer.code !== 0) continue
    const accessToken = typeof answer.data['accessToken'] === 'string' ? answer.data['accessToken'] : undefined
    if (accessToken === undefined) continue
    const expiresIn = intOf(answer.data, 'expiresIn')
    return {
      ...credential,
      accessToken,
      ...optional('refreshToken', strOf(answer.data, 'refreshToken')),
      expiresAtMs: expiresIn === undefined || expiresIn <= 0
        ? credential.expiresAtMs
        : Date.now() + expiresIn * 1000,
      ...optional('domain', strOf(answer.data, 'domain')),
    }
  }
  return undefined
}

/** 是否该续期：有 refreshToken，且无到期时间或 60 秒内到期。 */
export function needsRefresh(credential: AccountCredential): boolean {
  if (credential.refreshToken === '') return false
  if (credential.expiresAtMs === 0) return true
  return credential.expiresAtMs <= Date.now() + 60_000
}

/** 是否已经硬过期（本地可判，无需请求）。 */
export function isExpired(credential: AccountCredential): boolean {
  return credential.expiresAtMs > 0 && credential.expiresAtMs <= Date.now()
}
