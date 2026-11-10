/**
 * 给人看的文本：表格与诊断块。
 *
 * 这里只做**排版**，不做判断 —— 调用方把已经算好的事实（名字、可用性、剩余天数、
 * 今日记录）塞进 `Row`，于是改文案/列宽不会改行为，也不会为了取一个字段去
 * import 一堆模块（曾经的循环依赖就是这么来的）。
 */

import { fit, pad } from './mask.ts'
import type { CheckinOutcome } from './accounts.ts'

const OUTCOME_ICON: Readonly<Record<CheckinOutcome, string>> = {
  claimed: '✅',
  done: '☑️',
  inactive: '⏸️',
  ineligible: '🚫',
  expired: '🔑',
  failed: '❌',
}

const OUTCOME_TEXT: Readonly<Record<CheckinOutcome, string>> = {
  claimed: '已领',
  done: '已签',
  inactive: '无活动',
  ineligible: '不可参与',
  expired: '需重登',
  failed: '失败',
}

export function outcomeIcon(outcome: CheckinOutcome): string {
  return OUTCOME_ICON[outcome] ?? '·'
}

export function outcomeText(outcome: CheckinOutcome): string {
  return OUTCOME_TEXT[outcome] ?? outcome
}

export function regionLabel(region: string): string {
  return region === 'global' ? '国际版' : '国内版'
}

export function sourceLabel(source: string): string {
  if (source === 'vault') return '扫码登录'
  if (source === 'book') return '账号簿'
  if (source === 'desktop') return '桌面端只读'
  return source
}

/** 表格的一行 —— 所有字段都是调用方算好的展示值。 */
export interface Row {
  /** 当前号标记（`◉` / 空格）。 */
  mark: string
  name: string
  region: string
  /** `剩 29.3 天` / `已过期 2.0 天` / `到期未知`。 */
  expiry: string
  /** `今日 已签 +100`。 */
  today: string
  /** 可用性说明（空 = 正常）。 */
  status: string
  /** 诊断块的附加行（路径、token 有无等）。 */
  details: string[]
}

/** 账号总览表（`/wb status`）。 */
export function overviewTable(title: string, rows: readonly Row[]): string[] {
  const lines = [title, '']
  lines.push(`    ${fit('账号', 22)}${pad('区域', 8)}${pad('token', 14)}${pad('今日', 18)}状态`)
  for (const row of rows) {
    // 当前号标记并进定宽的名字格，避免它把后面所有列挤歪
    lines.push(
      `  ${fit(`${row.mark} ${row.name}`, 22)}${pad(row.region, 8)}${pad(row.expiry, 14)}${pad(row.today, 18)}${row.status}`,
    )
  }
  return lines
}

/** 诊断（`/wb doctor`）里每个账号的详情块。 */
export function doctorBlock(row: Row): string[] {
  return [
    `${row.mark === ' ' ? '' : `${row.mark} `}${row.name}`,
    `    ${row.region} · ${row.expiry} · ${row.today}${row.status === '' ? '' : ` · ⚠ ${row.status}`}`,
    ...row.details.map(line => `    ${line}`),
  ]
}
