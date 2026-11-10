/**
 * 账号名脱敏。
 *
 * ## 先分清两件事
 *
 * "隐藏某个人名字"是作者侧的清理（README 示例、launchd label 里不该出现作者名
 * —— 这部分已在打包时做掉）。但做成给别人用的插件后，真正要解决的是**每个使用者
 * 自己的昵称不要乱露**：截图发群、贴日志、录屏录到会话、提交 issue —— 这些场景里
 * 泄露的是**用户自己**的账号。
 *
 * ## 三档
 *
 * | 档位 | 显示成 |
 * |---|---|
 * | `full` | `Alice199` |
 * | `mask`（CLI 默认） | `Al****99` |
 * | `hash` | `#1a2b3c4d`（账号 id 前 8 位，可跨日志对齐但不可反推） |
 *
 * ## 开关优先级
 *
 * 1. `WORKBUDDY_MASK=full|mask|hash` 环境变量
 * 2. `~/.pi/agent/settings.json` 的 `workbuddy.mask`
 * 3. 默认：TUI 里 `full`（自己看得到），**非 TTY（管道/日志/CI）`mask`**
 *
 * 最后一条是关键：`| tee`、重定向、CI 跑日志时自动脱敏，不需要人记得加参数。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { piAgentDir, type Account } from './accounts.ts'
import { isPlainObject } from './jsonfile.ts'

export type MaskLevel = 'full' | 'mask' | 'hash'

const LEVELS: readonly MaskLevel[] = ['full', 'mask', 'hash']

function isLevel(value: unknown): value is MaskLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

/** 从 settings.json 读 `workbuddy.mask`；读不到返回 undefined。 */
function levelFromSettings(): MaskLevel | undefined {
  try {
    const path = join(piAgentDir(), 'settings.json')
    if (!existsSync(path)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isPlainObject(parsed)) return undefined
    const wb = parsed['workbuddy']
    if (!isPlainObject(wb)) return undefined
    return isLevel(wb['mask']) ? wb['mask'] : undefined
  } catch {
    return undefined
  }
}

/**
 * 当前生效的脱敏档位。
 *
 * `isTTY` 显式传进来而不是直接读 `process.stdout.isTTY`，这样 TUI 里
 * （用 ctx.ui.notify 输出）可以强制 `full`，而 CLI 管道自动降级。
 */
export function resolveMaskLevel(isTTY: boolean = process.stdout.isTTY === true): MaskLevel {
  const fromEnv = process.env['WORKBUDDY_MASK']
  if (isLevel(fromEnv)) return fromEnv
  return levelFromSettings() ?? (isTTY ? 'full' : 'mask')
}

/**
 * 脱敏一个显示名。
 *
 * - 保留开头 2 个、结尾 1~2 个"视觉字符"（短名只留结尾 1 个），中间用 `*` 填充
 * - 太短（≤3）或像邮箱的，用 hash 更安全（邮箱前缀可能本身就含真名）
 * - 纯数字/长 id 也只留首尾
 */
export function maskLabel(label: string, accountId: string, level: MaskLevel): string {
  if (level === 'full') return label
  if (level === 'hash') return `#${accountId.slice(0, 8)}`

  const trimmed = label.trim()
  // 邮箱：前缀经常就是真名，直接换 hash
  if (trimmed.includes('@')) return `#${accountId.slice(0, 8)}`

  // 按"视觉字符"切分（代理对、组合字符都算一个）
  const chars = [...trimmed]
  if (chars.length <= 3) return '*'.repeat(chars.length)

  const keepTail = chars.length >= 8 ? 2 : 1
  const stars = Math.max(2, chars.length - 2 - keepTail)
  return `${chars.slice(0, 2).join('')}${'*'.repeat(stars)}${chars.slice(-keepTail).join('')}`
}

/**
 * 调用方（TUI / CLI）的显示上下文：一次算好，反复用，别每个函数自己读环境变量。
 */
export interface DisplayContext {
  level: MaskLevel
  name(account: Account): string
  /** 把一段任意文本里的账号名/uid/uin 替换成脱敏形式。 */
  scrub(text: string): string
}

export function displayContext(level: MaskLevel, accounts: readonly Account[] = []): DisplayContext {
  return {
    level,
    name: account => maskLabel(account.label, account.id, level),
    scrub: text => scrub(text, accounts, level),
  }
}

/**
 * 脱敏一段任意文本里的账号名（用于错误消息、日志行）。
 *
 * 上游的错误文本可能带昵称或 uid，直接打出来就泄露了。这里把每个已知
 * 账号的 `label` / `uin` / `uid` 都替换成它的脱敏形式。
 */
export function scrub(
  text: string,
  accounts: readonly Account[],
  level: MaskLevel = resolveMaskLevel(),
): string {
  if (level === 'full') return text
  let out = text
  for (const account of accounts) {
    const masked = maskLabel(account.label, account.id, level)
    if (account.label.length >= 2) out = out.split(account.label).join(masked)
    // uid / uin 一律换掉：它们是稳定标识，泄露了能跨平台关联
    if (account.uid !== '') out = out.split(account.uid).join(masked)
    if (account.uin !== undefined && account.uin !== '') out = out.split(account.uin).join(masked)
  }
  return out
}

/**
 * 终端列宽（中文/全角按 2 列）。TUI 与 CLI 的表格都靠它对齐。
 */
function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u.test(ch) ? 2 : 1
  return width
}

/** 右补空格到指定显示列宽。 */
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** 截到显示列宽内（超出用 `…` 收尾），再补空格。表格列靠它防串位。 */
export function fit(text: string, width: number): string {
  if (displayWidth(text) <= width) return pad(text, width)
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = displayWidth(ch)
    // 留一格给省略号
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return pad(`${out}…`, width)
}
