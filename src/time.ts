/**
 * 时间口径：**一律按北京日（UTC+8，固定偏移）**。
 *
 * 签到活动按北京时间划天；用固定偏移而不是 `Intl`/系统时区，是因为部分 Windows
 * 环境不带 tzdata，`toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})` 会抛。
 *
 * 「明天 00:00」只有这一处实现：积分耗尽的冷却、连败升级、签到跨天都靠它，
 * 各自算一遍迟早差一小时。
 */

const DAY_MS = 86_400_000
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** 北京日 `YYYY-MM-DD`。 */
export function beijingDay(at: number = Date.now()): string {
  return new Date(at + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/** 下一个北京时间 00:00 的 epoch ms。 */
export function nextBeijingMidnight(now: number = Date.now()): number {
  const beijingNow = now + BEIJING_OFFSET_MS
  const dayStart = Math.floor(beijingNow / DAY_MS) * DAY_MS
  return dayStart + DAY_MS - BEIJING_OFFSET_MS
}

/** 到某个 epoch ms 还剩多少分钟（向上取整，用于「还剩 N 分钟」）。 */
export function minutesUntil(targetMs: number, now: number = Date.now()): number {
  return Math.ceil((targetMs - now) / 60_000)
}

/** token 剩余有效期天数（一位小数）；无到期时间返回 undefined。 */
export function daysLeftOf(expiresAtMs: number, now: number = Date.now()): number | undefined {
  if (expiresAtMs <= 0) return undefined
  return Math.round((expiresAtMs - now) / DAY_MS * 10) / 10
}
