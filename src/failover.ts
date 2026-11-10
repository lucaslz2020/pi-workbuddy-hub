/**
 * 自动故障转移：一个号被限流/额度用尽/被封，自动换下一个。
 *
 * ## 触发条件（什么算「这个号不能用了」）
 *
 * 分三档，因为它们的正确处理完全不同：
 *
 * | 症状 | 归类 | 动作 |
 * |---|---|---|
 * | `code=37` / 环境异常 / 429 | **rate-limited** | 换号，冷却 10 分钟 |
 * | `14018` 积分耗尽 | **quota** | 换号，冷却到「明天」（跨天自动恢复） |
 * | `12153` 会话失效 / 401 | **revoked** | 先静默续期自救，救不回才换号**永久**跳过 |
 * | `14003` 模型负载高 | **upstream-busy** | **不换号**，退避重试（换号也没用） |
 * | 网络错误 / 5xx | **transient** | 不换号，退避重试 |
 *
 * 最后两行是关键：模型负载高和网络抖动**不是账号问题**。把它们也当限流去换号，
 * 会把所有号的冷却时间白白烧掉，最后「全都限流」其实一个都没限流。
 *
 * ## 状态存哪
 *
 * `~/.pi/agent/workbuddy/failover.json`，按 `providerId|accountId` 记
 * `{ state, until, reason, strikes }`。`until` 是**恢复时间**，到点自动可用；
 * `strikes` 是连续失败次数，成功一次归零，连续 3 次升级成「压到明天」。
 *
 * ## 为什么不持久化「当前是第几个号」
 *
 * 没必要。每次要换号时读一遍全部账号 + 故障状态，按「可用性 → 剩余有效期」
 * 取第一个能用的。这样进程重启、手动切换、外部改 auth.json 都不会让状态错乱。
 */

import { join } from 'node:path'
import { readJsonObject, writeJsonQuietly } from './jsonfile.ts'
import { minutesUntil, nextBeijingMidnight } from './time.ts'
import { workbuddyDataDir, type Account } from './accounts.ts'
import { providerIdFor } from './switch.ts'
import {
  CODE_CREDITS_EXHAUSTED,
  CODE_MODEL_BUSY,
  CODE_QUEUE_PER_ACCOUNT,
  CODE_QUEUE_POSITION,
  CODE_RATE_LIMIT,
  CODE_SESSION_DEAD,
} from './upstream.ts'

export type FaultKind = 'rate-limited' | 'quota' | 'revoked' | 'upstream-busy' | 'transient'

/** 一次失败的判定 + 该怎么做。 */
export interface FaultVerdict {
  kind: FaultKind
  /** 是否应该换号。 */
  switchAccount: boolean
  /** 冷却到什么时候（epoch ms）；0 = 不自动恢复（需人工处理）。 */
  cooldownMs: number
  /** 给人看的一句话。 */
  detail: string
}

interface FaultRecord {
  state: FaultKind
  /** 恢复时间（epoch ms）。0 = 永不自动恢复（需人工处理）。 */
  until: number
  reason: string
  strikes: number
  updatedAt: number
}

type FaultFile = Record<string, FaultRecord>

/**
 * 限流冷却 10 分钟：太短会来回撞墙，太长会浪费可用额度。
 * 401 但续期接口无应答时也借用这档（网关问题≠号废了，先冷却观察）。
 */
export const RATE_LIMITED_COOLDOWN_MS = 10 * 60_000

/** 同一 verdict 60 秒内重复上报算同一次事件（响应后 hook + 消息结束 hook 会各报一次），不累加。 */
const SAME_FAULT_DEDUPE_MS = 60_000

/** 连续失败到这个次数，认定「这个号是真废了」，压到明天。 */
const ESCALATE_STRIKES = 3

function faultPath(): string {
  return join(workbuddyDataDir(), 'failover.json')
}

function readFaults(): FaultFile {
  return readJsonObject<FaultFile>(faultPath())
}

function writeFaults(file: FaultFile): void {
  // 写不进去只影响下次的换号选择，不该打断当前请求
  writeJsonQuietly(faultPath(), file)
}

function keyOf(account: Account): string {
  return `${providerIdFor(account)}|${account.id}`
}

// ---------------------------------------------------------------------------
// 错误 → 故障判定
// ---------------------------------------------------------------------------

export interface ErrorSignal {
  status?: number
  code?: number
  message?: string
  bodyText?: string
}

const hasSome = (text: string, needles: readonly string[]): boolean => needles.some(n => text.includes(n))

/** 关键词表：上游的措辞会变，但业务码相对稳定，所以两边都认。 */
const REVOKED_WORDS = ['会话已失效', 'session expired', '登录已失效', 'invalid token', 'unauthorized', 'offline user session not found']
const QUOTA_WORDS = ['积分不足', '积分已用尽', '积分用完', '额度不足', '额度用尽', '余额不足', '没有积分', 'quota exceeded', 'insufficient credit', 'out of credit', 'payment required']
const RATE_WORDS = ['rate limit', 'too many requests', '环境存在异常', '请求过于频繁', '限流']
const BUSY_WORDS = ['模型负载', '负载过高', 'overloaded', 'server busy', 'service unavailable']
const NETWORK_WORDS = ['econnreset', 'etimedout', 'enotfound', 'fetch failed', 'network', 'socket hang up', 'connection error']

/**
 * 从错误文本/状态码里认出上游的意图。
 *
 * 上游把错误塞在 JSON 的 `code` / `message` / `msg` 里，而 pi 会把它们
 * 拼成一条字符串丢给我们，所以两种都要认：结构化字段（如果有）和文本关键词。
 * 认不出来返回 undefined —— **认不出来就不换号**。
 */
export function classifyError(input: ErrorSignal): FaultVerdict | undefined {
  const text = `${input.message ?? ''} ${input.bodyText ?? ''}`.toLowerCase()
  const status = input.status ?? 0
  const code = input.code ?? 0
  const revoked = (detail: string): FaultVerdict => ({ kind: 'revoked', switchAccount: true, cooldownMs: 0, detail })
  const swap = (kind: FaultKind, cooldownMs: number, detail: string): FaultVerdict =>
    ({ kind, switchAccount: true, cooldownMs, detail })

  // --- 账号真的废了 ---
  if (status === 401 || code === CODE_SESSION_DEAD || hasSome(text, REVOKED_WORDS)) {
    return revoked('登录态失效，换下一个号（该号需重新登录）')
  }
  // --- 额度用尽（按天恢复） ---
  if (code === CODE_CREDITS_EXHAUSTED || hasSome(text, QUOTA_WORDS)) {
    return swap('quota', Math.max(0, nextBeijingMidnight() - Date.now()), '积分耗尽，换下一个号（明天自动恢复）')
  }
  // --- 限流 / 环境异常 ---
  if (status === 429 || code === CODE_RATE_LIMIT
    || (code >= CODE_QUEUE_POSITION && code <= CODE_QUEUE_PER_ACCOUNT) || hasSome(text, RATE_WORDS)) {
    return swap('rate-limited', RATE_LIMITED_COOLDOWN_MS, '被限流，换下一个号（10 分钟后该号自动恢复）')
  }
  // --- 上游忙：换号没用，退避重试 ---
  if (code === CODE_MODEL_BUSY || hasSome(text, BUSY_WORDS)) {
    return { kind: 'upstream-busy', switchAccount: false, cooldownMs: 0, detail: '上游模型负载高，与账号无关；退避重试（不换号）' }
  }
  if (status >= 500) {
    return { kind: 'transient', switchAccount: false, cooldownMs: 0, detail: `上游 ${status}，退避重试（不换号）` }
  }
  // --- 网络层 ---
  if (hasSome(text, NETWORK_WORDS)) {
    return { kind: 'transient', switchAccount: false, cooldownMs: 0, detail: '网络错误，退避重试（不换号）' }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 记录故障
// ---------------------------------------------------------------------------

/** 记一次故障；连续 3 次升级到明天。 */
export function recordFault(account: Account, verdict: FaultVerdict): void {
  if (!verdict.switchAccount) return
  const file = readFaults()
  const key = keyOf(account)
  const previous = file[key]
  const now = Date.now()
  const sameIncident = previous !== undefined
    && previous.state === verdict.kind
    && now - previous.updatedAt < SAME_FAULT_DEDUPE_MS
  const strikes = sameIncident ? previous.strikes : (previous?.strikes ?? 0) + 1
  const escalated = strikes >= ESCALATE_STRIKES && verdict.kind !== 'revoked'
  file[key] = {
    state: verdict.kind,
    until: verdict.kind === 'revoked' ? 0 : escalated ? nextBeijingMidnight() : now + verdict.cooldownMs,
    reason: escalated ? `${verdict.detail}（连续 ${strikes} 次，压到明天）` : verdict.detail,
    strikes,
    updatedAt: now,
  }
  writeFaults(file)
}

/** 成功一次就清掉这个号的故障计数。 */
export function clearFault(account: Account): void {
  const file = readFaults()
  const key = keyOf(account)
  if (file[key] === undefined) return
  delete file[key]
  writeFaults(file)
}

export interface Availability {
  ok: boolean
  reason?: string
}

/** 这个号现在能不能用。冷却到期就恢复（strikes 保留，再失败直接升级）。 */
export function isAvailable(account: Account, now: number = Date.now()): Availability {
  const record = readFaults()[keyOf(account)]
  if (record === undefined) return { ok: true }
  if (record.state === 'revoked' && record.until === 0) {
    return { ok: false, reason: `${record.reason}（需重新登录）` }
  }
  if (record.until > now) {
    return { ok: false, reason: `${record.reason}（还剩 ${minutesUntil(record.until, now)} 分钟）` }
  }
  return { ok: true }
}

/**
 * 按「可用性 → 剩余有效期」挑下一个号。
 *
 * 优先同区域（省掉切 provider 的心智负担），没有可用的同区域号才跨区域兜底；
 * 剩余有效期长的优先（更可能还没被限流过）。
 */
export function pickNextAccount(
  accounts: readonly Account[],
  options: { from?: Account, now?: number } = {},
): Account | undefined {
  const now = options.now ?? Date.now()
  const usable = accounts.filter(a => !isActiveAccount(a) && isAvailable(a, now).ok)
  if (usable.length === 0) return undefined
  const sameRegion = options.from === undefined
    ? usable
    : usable.filter(a => providerIdFor(a) === providerIdFor(options.from!))
  const pool = sameRegion.length > 0 ? sameRegion : usable
  return [...pool].sort((a, b) => b.expiresAtMs - a.expiresAtMs)[0]
}

/** 本模块只需要「是不是当前号」，用 uid 比，避免和 switch.ts 循环依赖。 */
let activeUidLookup: (providerId: string) => string | undefined = () => undefined

export function setActiveUidLookup(lookup: (providerId: string) => string | undefined): void {
  activeUidLookup = lookup
}

function isActiveAccount(account: Account): boolean {
  return activeUidLookup(providerIdFor(account)) === account.uid
}

/** 给人看的故障总览。 */
export function faultSummary(accounts: readonly Account[]): string[] {
  const file = readFaults()
  const now = Date.now()
  const lines: string[] = []
  for (const account of accounts) {
    const record = file[keyOf(account)]
    if (record === undefined) continue
    const state = record.until === 0
      ? '需重新登录'
      : record.until > now
        ? `冷却中，还剩 ${minutesUntil(record.until, now)} 分钟`
        : '冷却已到期'
    lines.push(`${account.label}：${record.state} · ${state} · 连败 ${record.strikes} 次`)
  }
  return lines
}

/** 清掉所有故障状态（/wb failover reset）。 */
export function resetFaults(): number {
  const count = Object.keys(readFaults()).length
  writeFaults({})
  return count
}

export { nextBeijingMidnight }
