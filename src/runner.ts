/**
 * 批量执行：把「一堆账号」跑成「一堆结论」。
 *
 * 四条纪律：
 *   1. **一个账号失败不影响其它账号**。全部收敛成结果对象，不向外抛。
 *   2. **每个账号串行处理自己的重试**，账号之间才并发。这样既不会同时打爆
 *      上游，也不会因为某个号慢而拖住整批。
 *   3. **先续期再签到**。过期 token 直接签会拿到 401，然后被误标成「需重登」，
 *      而实际上 refreshToken 还能用。
 *   4. **结论一定落盘**（成功失败都记当天结论），避免「没看到的一天被当成已签到」。
 *
 * 这里是 `runOne` 的**唯一**实现：`/wb sign`、`wb-checkin`、session 内定时签到
 * 全部走它。CLI 的 `--dry-run` 走同一份并发池的 `probeMany`（只查不领）。
 */

import { beijingDay, daysLeftOf } from './time.ts'
import { optional } from './fields.ts'
import {
  readRecords,
  recordKey,
  saveAccount,
  saveRecord,
  type Account,
  type AccountCredential,
  type AccountSource,
  type CheckinOutcome,
  type DayRecord,
} from './accounts.ts'
import {
  BillingError,
  checkinAccount,
  fetchStatus,
  isExpired,
  needsRefresh,
  refreshCredential,
  type CheckinStatus,
} from './checkin.ts'

export interface RunOneResult {
  account: Account
  outcome: CheckinOutcome
  message: string
  credit?: number
  streakDays?: number
  /** 本次是否续期过 token。 */
  refreshed: boolean
  /** token 剩余有效期天数（负数=已过期）。 */
  daysLeft?: number
  /** 失败是否值得重试。 */
  retryable: boolean
  attempts: number
}

export interface RunOptions {
  signal?: AbortSignal
  /** 账号间并发度，默认 3 —— 上游对同 IP 并发敏感，别开大。 */
  concurrency?: number
  /** 失败重试次数（仅对 retryable 生效），默认 2。 */
  retries?: number
  /** 单个账号进度回调，用于 TUI/CLI 实时输出。 */
  onProgress?: (result: RunOneResult) => void
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** 并发跑一个数组，结果顺序与入参一致。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  }
  const workers = Math.min(Math.max(1, limit), items.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

// ---------------------------------------------------------------------------
// 凭据在「一个账号的一次处理」内的状态
// ---------------------------------------------------------------------------

interface CredentialKeeper {
  credential: AccountCredential
  refreshed: boolean
  /** 续期一次并写回原来源；已有新 token 时不重复请求。 */
  renew(): Promise<boolean>
}

function keeperFor(account: Account): CredentialKeeper {
  const keeper: CredentialKeeper = {
    credential: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAtMs: account.expiresAtMs,
      domain: account.domain,
      uid: account.uid,
      ...optional('uin', account.uin),
      ...optional('enterpriseId', account.enterpriseId),
      ...optional('nickname', account.nickname),
      ...optional('displayName', account.displayName),
    },
    refreshed: false,
    async renew(): Promise<boolean> {
      const next = await refreshCredential(keeper.credential).catch(() => undefined)
      if (next === undefined) return false
      keeper.credential = next
      keeper.refreshed = true
      try {
        // 写回原来源：vault 号写回 vault，provider 仍能用
        saveAccount(next, account.source satisfies AccountSource)
      } catch {
        // 写不进去不影响本次签到，下次还会再刷
      }
      return true
    },
  }
  return keeper
}

// ---------------------------------------------------------------------------
// 一个账号
// ---------------------------------------------------------------------------

function resultOf(
  account: Account,
  keeper: CredentialKeeper,
  base: Omit<RunOneResult, 'account' | 'refreshed' | 'daysLeft'>,
  daysLeft: number | undefined,
): RunOneResult {
  return {
    account,
    refreshed: keeper.refreshed,
    ...(daysLeft === undefined ? {} : { daysLeft }),
    ...base,
  }
}

/** 跑一个账号：续期 → 签到 → 失败重试。 */
async function runOne(account: Account, options: RunOptions): Promise<RunOneResult> {
  const retries = options.retries ?? 2
  const keeper = keeperFor(account)
  const daysLeft = (): number | undefined => daysLeftOf(keeper.credential.expiresAtMs)

  // 1) 续期（本地快到期的才续，避免无谓请求）
  if (needsRefresh(keeper.credential)) await keeper.renew()

  // 2) 本地已硬过期且续期失败 → 不必发请求，直接判定
  if (keeper.credential.refreshToken === '' && isExpired(keeper.credential)) {
    return resultOf(account, keeper, {
      outcome: 'expired',
      message: '登录态已过期且没有 refreshToken，需要重新登录该账号',
      retryable: false,
      attempts: 0,
    }, daysLeft())
  }

  // 3) 签到，仅对可重试错误退避重试
  let lastMessage = ''
  let lastRetryable = true
  let attempts = 0

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts = attempt + 1
    if (options.signal?.aborted === true) break
    try {
      const result = await checkinAccount(keeper.credential, options.signal)
      return resultOf(account, keeper, {
        outcome: result.outcome,
        message: result.message,
        ...optional('credit', result.credit),
        ...optional('streakDays', result.streakDays),
        retryable: result.retryable,
        attempts,
      }, daysLeft())
    } catch (error) {
      const classified = asBillingError(error)
      lastMessage = classified.message
      lastRetryable = classified.retryable

      if (classified.unauthorized) {
        // 401：再试一次续期，仍不行就明确要人重登
        if (!keeper.refreshed && await keeper.renew()) continue
        return resultOf(account, keeper, {
          outcome: 'expired',
          message: `${lastMessage}。请重新登录该账号（桌面端登录后运行 /wb sync，或 /wb add 粘贴新 token）`,
          retryable: false,
          attempts,
        }, daysLeft())
      }
      if (attempt < retries && lastRetryable) {
        await sleep(600 * (attempt + 1))
        continue
      }
      break
    }
  }

  return resultOf(account, keeper, {
    outcome: 'failed',
    message: lastMessage === '' ? '未知失败' : lastMessage,
    retryable: lastRetryable,
    attempts,
  }, daysLeft())
}

/** 把任意抛出物收敛成「一句话 + 两个判定」。认不出来的一律当可重试的网络抖动。 */
function asBillingError(error: unknown): { message: string, retryable: boolean, unauthorized: boolean } {
  if (error instanceof BillingError) {
    return { message: error.message, retryable: error.retryable, unauthorized: error.unauthorized }
  }
  return { message: error instanceof Error ? error.message : String(error), retryable: true, unauthorized: false }
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/** 一次结论 → 当天记录。成功失败都记：**没记录**和**失败**是两件事。 */
function recordOf(result: RunOneResult): DayRecord {
  return {
    day: beijingDay(),
    at: Date.now(),
    outcome: result.outcome,
    ...optional('credit', result.credit),
    ...optional('streakDays', result.streakDays),
    message: result.message,
  }
}

/** 批量签到。结果顺序与入参一致（便于稳定输出）。 */
export async function runMany(accounts: readonly Account[], options: RunOptions = {}): Promise<RunOneResult[]> {
  const results = await mapWithConcurrency(accounts, options.concurrency ?? 3, async (account) => {
    const result = await runOne(account, options)
    saveRecord(result.account.region, result.account.id, recordOf(result))
    options.onProgress?.(result)
    return result
  })
  return results.filter((entry): entry is RunOneResult => entry !== undefined)
}

// ---------------------------------------------------------------------------
// 只查不领（CLI --dry-run）
// ---------------------------------------------------------------------------

export interface ProbeResult {
  account: Account
  status?: CheckinStatus
  /** 查询失败时的原因（脱敏交给调用方）。 */
  error?: string
}

/** 只查状态，一个领奖请求都不发。 */
export async function probeMany(
  accounts: readonly Account[],
  options: { concurrency?: number, signal?: AbortSignal } = {},
): Promise<ProbeResult[]> {
  return mapWithConcurrency(accounts, options.concurrency ?? 3, async (account): Promise<ProbeResult> => {
    try {
      return { account, status: await fetchStatus(account, options.signal) }
    } catch (error) {
      return { account, error: asBillingError(error).message }
    }
  })
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/** 汇总成一行人话。 */
export function summarize(results: readonly RunOneResult[]): string {
  if (results.length === 0) return '没有账号可处理'
  const labels: readonly (readonly [CheckinOutcome, string])[] = [
    ['claimed', '个新领'],
    ['done', '个今日已签'],
    ['inactive', '个活动未开启'],
    ['ineligible', '个不可参与'],
    ['expired', '个需重登'],
    ['failed', '个失败'],
  ]
  const parts = labels
    .map(([outcome, label]) => [results.filter(r => r.outcome === outcome).length, label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
  return parts.join('，')
}

/** 需要人处理的结论（失败 / 需重登）。 */
export function needsAttention(result: RunOneResult): boolean {
  return result.outcome === 'failed' || result.outcome === 'expired'
}

/** 新领到的总积分。 */
export function totalCredit(results: readonly RunOneResult[]): number {
  return results.reduce((sum, r) => sum + (r.outcome === 'claimed' ? r.credit ?? 0 : 0), 0)
}

// ---------------------------------------------------------------------------
// 今日进度
// ---------------------------------------------------------------------------

/** 哪些账号今天还没有结论（没跑过 / 记录不是今天的）。 */
export function accountsPendingToday(accounts: readonly Account[], day: string = beijingDay()): Account[] {
  const records = readRecords()
  return accounts.filter((account) => {
    const record = records[recordKey(account.region, account.id)]
    return record === undefined || record.day !== day
  })
}

export { daysLeftOf } from './time.ts'
