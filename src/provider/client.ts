/**
 * 上游 HTTP 客户端：聊天流、模型目录、积分，以及网关强制的 wire 改写。
 *
 * wire 行为依据 dingminhua/dsh-connect-workbuddy（MIT）的实测协议，其自身致谢
 * corrinehu/dsh-workbuddy-connect 与 Sliverkiss/workbuddy2api。沿用的安全红线：
 * 聊天请求绝不携带 refresh token；会话身份三件套每个请求现生成。
 *
 * 【本包改动】线索常量与业务码改从 `src/upstream.ts` 取（原先这份文件自带一份
 * 重复的常量表），分类表仍是 provider 独有的「同一状态码对应哪种补救措施」。
 */

import { randomUUID } from 'node:crypto'
import {
  CHAT_PATH,
  CLIENT_UA,
  CODE_CHANNEL_REJECT,
  CODE_CONTENT_POLICY,
  CODE_CONTEXT_TOO_LONG,
  CODE_CREDITS_EXHAUSTED,
  CODE_MODEL_BUSY,
  CODE_QUEUE_FULL,
  CODE_QUEUE_PER_ACCOUNT,
  CODE_QUEUE_POSITION,
  CODE_SESSION_DEAD,
  ERROR_BODY_LIMIT,
  GLOBAL_CONFIG_PATH,
  MODELS_CATALOG_PATH,
  PRODUCT_UA,
  UPSTREAM_TIMEOUT_MS,
  chatBase,
  globalBase,
  originReferer,
  regionOf,
} from './upstream.ts'
import { selectCliModels, type WorkBuddyCredential, type WorkBuddyUpstreamModel } from './store.ts'
import { envelopeData } from '../fields.ts'
import { isPlainObject as isRecord } from '../jsonfile.ts'

/**
 * 上游失败分类 —— 每一类存在，都是因为**补救措施不同**：
 * hard_credit（充值）、soft_rate（等账号配额重置）、model_busy（换模型而不是换号）、
 * session_dead（重登）、policy_reject（内容）、account_restricted（账号被限制）、
 * channel_reject（prompt 指纹）、model_queue（上游给了排队位置）、
 * server/client/transport。
 */
export type UpstreamErrorKind =
  | 'hard_credit' | 'soft_rate' | 'model_busy' | 'session_dead'
  | 'policy_reject' | 'account_restricted' | 'channel_reject'
  | 'model_queue' | 'not_found' | 'server' | 'client'

export interface WorkBuddyChatResult {
  ok: boolean
  status: number
  kind?: UpstreamErrorKind
  message?: string
  response?: Response
}

// ---------------------------------------------------------------------------
// 业务码与关键词（实测表；措辞会漂，码比较稳）
// ---------------------------------------------------------------------------

const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted',
  'out of credit', 'quota exceeded', 'quota exhaust', 'payment required',
  'credit not enough', 'not enough credit', 'credits not enough',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', String(CODE_SESSION_DEAD)]
const ACCOUNT_RESTRICTED_MARKERS: readonly string[] = ['账号存在异常行为', 'restricted due to unusual activity']
const CHANNEL_REJECT_MARKERS: readonly string[] = ['unapproved channel', 'illegal api invocation']
const QUEUE_CODES: readonly number[] = [CODE_QUEUE_POSITION, CODE_QUEUE_FULL, CODE_QUEUE_PER_ACCOUNT]

/** 上游 11115：prompt 超出模型窗口。给宿主 overflow 检测器认的英文短句。 */
export const CONTEXT_OVERFLOW_MARKER = `prompt is too long (upstream code ${CODE_CONTEXT_TOO_LONG})`

/** 解析错误体里的业务码，接受数字/字符串、嵌套/直挂。 */
function businessCodeOf(body: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    const match = /"code"\s*:\s*"?(\d{4,6}(?!\d))/u.exec(body)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  if (!isRecord(parsed)) return undefined
  const direct = asBusinessCode(parsed['code'])
  if (direct !== undefined) return direct
  const error = parsed['error']
  if (isRecord(error)) {
    const data = error['data']
    if (isRecord(data)) return asBusinessCode(data['code'])
  }
  const data = parsed['data']
  if (isRecord(data)) return asBusinessCode(data['code'])
  return undefined
}

function asBusinessCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d{4,6}$/u.test(value.trim())) return Number(value.trim())
  return undefined
}

function isAccountRestrictedBody(body: string): boolean {
  if (businessCodeOf(body) !== CODE_CONTENT_POLICY) return false
  const lower = body.toLowerCase()
  return ACCOUNT_RESTRICTED_MARKERS.some(marker => lower.includes(marker.toLowerCase()))
}

function isChannelRejectBody(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes(String(CODE_CHANNEL_REJECT)) && CHANNEL_REJECT_MARKERS.some(marker => lower.includes(marker))
}

/** 排队条件（6020/6021/6022）及其位置。 */
export interface WorkBuddyQueueReport {
  code: number
  position?: number
  size?: number
}

export function parseQueueAnswer(text: string): WorkBuddyQueueReport | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const read = (code: unknown, data: unknown): WorkBuddyQueueReport | undefined => {
    if (typeof code !== 'number' || !QUEUE_CODES.includes(code)) return undefined
    const record = isRecord(data) ? data : {}
    const position = typeof record['queue_position'] === 'number' ? record['queue_position'] : undefined
    const size = typeof record['queue_size'] === 'number' ? record['queue_size'] : undefined
    return { code, ...(position === undefined ? {} : { position }), ...(size === undefined ? {} : { size }) }
  }
  if (!isRecord(parsed)) return undefined
  const direct = read(parsed['code'], parsed['data'])
  if (direct !== undefined) return direct
  const data = parsed['data']
  if (isRecord(data)) return read(data['code'], data['data'] ?? data)
  return undefined
}

/** 排队这件事用 App 自己的说法讲出来。 */
export function queueNoticeText(report: WorkBuddyQueueReport): string {
  if (report.code === CODE_QUEUE_POSITION) {
    const position = report.position === undefined ? '未知' : `${report.position}`
    const size = report.size === undefined ? '' : `，队列共 ${report.size} 个请求`
    return `模型排队中：你排在第 ${position} 位${size}。请稍后重新发送这条消息，或换一个模型`
  }
  if (report.code === CODE_QUEUE_FULL) return '模型排队已满：当前队列不再接受新的请求。请稍后重试，或换一个模型'
  return '该账号在此模型上的排队请求已达上限：请等待在途请求完成，或换一个模型'
}

export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  if (HARD_CREDIT_MARKERS.some(m => lower.includes(m.toLowerCase()) || body.includes(m))) return 'hard_credit'
  if (businessCodeOf(body) === CODE_CREDITS_EXHAUSTED) return 'hard_credit'
  if (SESSION_DEAD_MARKERS.some(m => body.includes(m))) return 'session_dead'
  if (isAccountRestrictedBody(body)) return 'account_restricted'
  if (businessCodeOf(body) === CODE_CONTENT_POLICY) return 'policy_reject'
  if (isChannelRejectBody(body)) return 'channel_reject'
  if (businessCodeOf(body) === CODE_MODEL_BUSY) return 'model_busy'
  if (parseQueueAnswer(body) !== undefined) return 'model_queue'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/** 每类失败对外呈现的 HTTP 状态码。 */
export const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  model_busy: 429,
  session_dead: 401,
  policy_reject: 403,
  account_restricted: 403,
  channel_reject: 400,
  model_queue: 429,
  not_found: 502,
  server: 502,
  client: 400,
}

/**
 * 一句话解释 + 怎么办。带重置时间的 429 是**账号**层的结论（几小时），宿主的
 * 原地重试预算不该花在它上面；`model_busy` 相反 —— 14003 大约一分钟就恢复。
 */
export function failureMessage(kind: UpstreamErrorKind, status: number, body: string): string {
  const queue = parseQueueAnswer(body)
  if (kind === 'model_queue' && queue !== undefined) return `${queueNoticeText(queue)}（上游 code ${queue.code}）`
  const clipped = body.length > 400 ? `${body.slice(0, 400)}…` : body
  const prefix = `workbuddy 上游失败（http ${status}）：`
  const overflow = businessCodeOf(body) === CODE_CONTEXT_TOO_LONG ? `${CONTEXT_OVERFLOW_MARKER}。` : ''
  switch (kind) {
    case 'hard_credit':
      return `${prefix}${clipped}。积分已用尽，请充值或更换账号`
    case 'soft_rate':
      return `${prefix}${clipped}。该账号的用量限制将在上游声明的时刻重置（与模型负载无关），请稍后再试或换一个账号`
    case 'model_busy':
      return `${prefix}${clipped}。这不是账号被限流，与积分、额度无关——同一凭据下换一个模型即可；请等待约 1 分钟后重试，或切换到负载较低的模型`
    case 'session_dead':
      return `${prefix}${clipped}。登录态已失效，请在 WorkBuddy 桌面端重新登录，或用 /login 重新扫码`
    case 'account_restricted':
      return `${prefix}${clipped}。该账号已被 WorkBuddy 上游按账号限制，与本次请求内容、网络和额度无关；重新登录不改变这一判定`
    case 'policy_reject':
      return `${prefix}${clipped}。该请求被服务端策略拒绝；若说明指向内容，请调整后重试`
    case 'channel_reject':
      return `${prefix}${clipped}。该请求被网关的渠道校验拦截：网关匹配的是 system/assistant 消息的开头指纹，与账号、积分、额度都无关，换账号也不会改变结果`
    default:
      return `${prefix}${overflow}${clipped}`
  }
}

// ---------------------------------------------------------------------------
// wire 改写
// ---------------------------------------------------------------------------

/**
 * 最小替身 system 消息。两个网关都要求对话**以 system 开头**，国际版强制
 * （400/11128 "first message is not system prompt"）。故意写得极小 —— 占位，不是人格。
 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * 被网关判定成「未授权渠道」（业务码 11128）的 system 开头，取 offset 0、
 * 忽略大小写、去掉前导空白后比较。这是实测快照，不是理论：补一个中性开头就能过。
 */
const UNAPPROVED_CHANNEL_OPENINGS: readonly string[] = [
  'you are an ai agent powered by deepseek harness',
  "you are claude code, anthropic's official cli for claude",
]

export function isUnapprovedChannelOpening(text: string): boolean {
  const opening = text.replace(/^\s+/u, '').toLowerCase()
  return UNAPPROVED_CHANNEL_OPENINGS.some(prefix => opening.startsWith(prefix))
}

/** 把每个被扫的消息挪离内容指纹（补中性开头）。数组内容要**逐段**看：闸门读每一段。 */
function neutralizeChannelFingerprints(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const value of messages) {
    if (!isRecord(value)) continue
    const content = value['content']
    if (typeof content === 'string') {
      if (isUnapprovedChannelOpening(content)) value['content'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${content}`
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') continue
      if (isUnapprovedChannelOpening(part['text'])) {
        part['text'] = `${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${part['text']}`
      }
    }
  }
}

/** 保证对话以 system 消息开头。 */
function ensureSystemHead(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) return
  const head = messages[0]
  if (!isRecord(head)) return
  const role = head['role']
  if (role === 'system' || role === 'developer') return
  messages.unshift({ role: 'system', content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT })
}

/** 把 OpenAI 的 `tool_choice` 各种写法收敛成上游要的字符串形态。 */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  if (!('tool_choice' in obj)) return
  const choice = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      delete obj['tools']
      delete obj['functions']
    }
    return
  }
  if (isRecord(choice) && choice['type'] === 'function') {
    const fn = isRecord(choice['function']) ? choice['function'] : {}
    const name = typeof fn['name'] === 'string' ? fn['name'].trim() : ''
    if (name !== '') {
      obj['tool_choice'] = name
      return
    }
  }
  delete obj['tool_choice']
}

/**
 * 把 OpenAI chat-completions 的 body 改写成网关要的样子：强制 `stream: true`
 * （上游拒绝非流式）、摊平 `tool_choice`、`developer` → `system`（网关遇到
 * developer 直接 11128）、保证 system 开头、把已知第三方 agent 的 system 开头
 * 挪离内容指纹。
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (!isRecord(body)) return source
  body['stream'] = true
  if (Array.isArray(body['messages'])) {
    for (const value of body['messages']) {
      if (isRecord(value) && value['role'] === 'developer') value['role'] = 'system'
    }
  }
  ensureSystemHead(body)
  neutralizeChannelFingerprints(body)
  normalizeToolChoice(body)
  return JSON.stringify(body)
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** 所有上游请求共享的 header。 */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/**
 * 聊天端点现在要求的会话身份三件套。任何合法 UUID 都能过；值每个请求现生成，
 * 与官方客户端一致。两个区域都发 —— 只在一侧发的 header 正是闸门隐形的方式。
 */
function conversationHeaders(): Record<string, string> {
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }
}

/** 聊天请求 header，含官方 CLI 的 X-No-* 约定。 */
export function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    'Authorization': `Bearer ${credential.accessToken}`,
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-Product': 'SaaS',
    ...conversationHeaders(),
  }
}

// ---------------------------------------------------------------------------
// 响应读取
// ---------------------------------------------------------------------------

/** 读一个 JSON 信封；失败时按分类抛错。 */
async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy 上游返回了非 JSON（http ${response.status}）：${text.slice(0, 160)}`)
  }
  if (!isRecord(parsed)) throw new Error(`workbuddy 上游返回了意外文档（http ${response.status}）`)
  const code = typeof parsed['code'] === 'number' ? parsed['code'] : 0
  if (!response.ok || code !== 0) {
    const msg = typeof parsed['msg'] === 'string' ? parsed['msg'] : text.slice(0, 160)
    throw new Error(`workbuddy 上游错误（http ${response.status}）：${msg}`)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/**
 * 上游 HTTP 客户端。请求显式带上凭据，这样续期结果对下一次调用立刻生效。
 */
export class WorkBuddyUpstreamClient {
  /** POST 聊天端点；成功时返回原始 SSE 响应。 */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}${CHAT_PATH}`, {
        method: 'POST',
        headers: chatHeaders(credential),
        body: bodyJson,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, status: response.status, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, kind: classifyUpstreamError(response.status, text), message: text }
  }

  /**
   * 读这个凭据所属区域的模型目录。
   *
   * 两个区域都按 **App 身份**读 `/v3/config` —— CLI 通道的答案只是它的子集，
   * 而且不含活动/促销信息。国内版回落到旧的 `/v2` 文档，这样网关不再提供新
   * 端点时是「降级」，而不是「这个区域没有模型」。
   */
  async fetchModels(
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyUpstreamModel[]> {
    const timeout = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    const readCatalog = async (path: string): Promise<readonly WorkBuddyUpstreamModel[]> => {
      const response = await fetch(`${chatBase(credential)}${path}`, {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(credential),
          'Referer': `${originReferer(credential)}/`,
          'User-Agent': PRODUCT_UA,
        },
        signal: timeout,
      })
      const data = envelopeData(await readEnvelope(response))
      return selectCliModels(data['models'], data['agents'])
    }
    try {
      return await readCatalog(GLOBAL_CONFIG_PATH)
    } catch (error) {
      if (regionOf(credential.domain) === 'global') throw error
      console.warn(`[workbuddy-hub] 国内模型目录 ${GLOBAL_CONFIG_PATH} 失败，回落到 ${MODELS_CATALOG_PATH}:`,
        error instanceof Error ? error.message : error)
      return await readCatalog(MODELS_CATALOG_PATH)
    }
  }

  /**
   * 读剩余积分（只读、不花钱）。个人账号读 `/v2/billing/meter/get-user-resource`；
   * 企业成员读 `/billing/meter/get-enterprise-user-usage`（没有 `/v2` 前缀），
   * 剩余 = `limitNum - credit`。
   */
  async fetchCredits(credential: WorkBuddyCredential): Promise<{ total?: number, raw?: string }> {
    const base = regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : 'https://www.codebuddy.cn'
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(credential.uid === '' ? {} : { 'X-User-Id': credential.uid }),
      ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
        ? {}
        : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }),
      ...(credential.domain === '' ? {} : { 'X-Domain': credential.domain }),
    }
    if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      const response = await fetch(`${base}/billing/meter/get-enterprise-user-usage`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      const wrapper = envelopeData(await readEnvelope(response))
      const inner = isRecord(wrapper['Data']) ? wrapper['Data'] : wrapper
      const limit = typeof inner['limitNum'] === 'number' ? inner['limitNum'] : undefined
      const used = typeof inner['credit'] === 'number' ? inner['credit'] : undefined
      return limit !== undefined && used !== undefined ? { total: Math.max(0, limit - used) } : {}
    }

    const stamp = (date: Date): string => `${date.getFullYear().toString().padStart(4, '0')}`
      + ` ${(date.getMonth() + 1).toString().padStart(2, '0')} ${date.getDate().toString().padStart(2, '0')}`
      + ` ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
      + `:${date.getSeconds().toString().padStart(2, '0')}`
    const now = new Date()
    const response = await fetch(`${base}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: stamp(now),
        PackageEndTimeRangeEnd: stamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const wrapper = envelopeData(await readEnvelope(response))
    const responseData = isRecord(wrapper['Response']) ? wrapper['Response'] : {}
    const inner = isRecord(responseData['Data']) ? responseData['Data'] : {}
    let total = 0
    for (const raw of Array.isArray(inner['Accounts']) ? inner['Accounts'] : []) {
      if (!isRecord(raw)) continue
      const precise = (key: string): number => {
        const preciseRaw = raw[`${key}Precise`]
        if (typeof preciseRaw === 'string' && preciseRaw !== '') {
          const parsed = Number.parseFloat(preciseRaw)
          if (Number.isFinite(parsed)) return parsed
        }
        if (typeof preciseRaw === 'number' && Number.isFinite(preciseRaw)) return preciseRaw
        return typeof raw[key] === 'number' ? raw[key] as number : 0
      }
      const monthly = raw['CapacityType'] === 4
      const hasCycle = raw['CycleCapacityRemain'] !== undefined
      const remain = precise(hasCycle ? 'CycleCapacityRemain' : 'CapacityRemain')
      const capped = Math.max(0, remain)
      if (!monthly && capped <= 0) continue
      total += capped
    }
    return { total, raw: JSON.stringify({ total }) }
  }
}

