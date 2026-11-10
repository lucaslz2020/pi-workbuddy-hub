/**
 * 读上游那些「两种拼写都出现过」的字段。
 *
 * WorkBuddy 的网关是几套服务拼起来的，同一个字段在不同端点上时而
 * `snake_case`、时而 `camelCase`，值时而是数字、时而像数字的字符串。
 * 每个模块以前各写一份 `boolOf` / `intOf` / `strOf`，改一处漏三处。
 *
 * 这里的约定：**拿不到就是 undefined**，绝不猜默认值 —— 调用方才知道
 * 「没有这个字段」意味着什么（活动没开？连签天数未知？）。
 */

function firstValue(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in source) return source[key]
  }
  return undefined
}

export function boolOf(source: Record<string, unknown>, ...keys: string[]): boolean {
  const value = firstValue(source, keys)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value === 'true' || value === '1'
  return false
}

export function intOf(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = firstValue(source, keys)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

export function strOf(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = firstValue(source, keys)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 时间戳统一成毫秒：秒级与毫秒级历史上都出现过。 */
export function expiryToMs(value: unknown): number {
  const raw = typeof value === 'string' ? Number(value) : value
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return raw > 1e12 ? raw : raw * 1000
}

/** 只带出有值的可选字段，避免 `{ foo: undefined }` 这样的半成品对象。 */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

/** 从一个信封里取 `data`（不是对象就当空对象）。 */
export function envelopeData(document: Record<string, unknown>): Record<string, unknown> {
  const data = document['data']
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
}

/** 信封里给人看的那句话：`msg` / `message` 都可能出现。 */
export function envelopeMessage(document: Record<string, unknown>): string | undefined {
  return strOf(document, 'msg', 'message')
}

/** 业务码：只认数字形态，别的当 0（= 成功/未声明）。 */
export function envelopeCode(document: Record<string, unknown>): number {
  const code = document['code']
  return typeof code === 'number' ? code : 0
}
