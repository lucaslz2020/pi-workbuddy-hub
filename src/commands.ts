/**
 * `/wb` 的全部子命令。
 *
 * 每个子命令是一个独立函数，签名统一为 `(ctx, args, state)`：
 *   · handler 只负责「解析参数 → 调一个函数 → 把结果 notify 出去」；
 *   · 状态（脱敏档位、自动换号开关、自动签到时间表）放在 `HubState` 里，由 index.ts 建，
 *     命令函数不持有模块级可变状态。
 *
 * ## 为什么全部收敛到 `/wb`
 *
 * 内置 provider 原本会注册 `workbuddy.status|sign|refresh|logout`，和多账号的 `/wb`
 * 并列，用户分不清哪个管全部账号、哪个只管当前槽位。现在**唯一入口是 `/wb`**；
 * 需要 provider 私有状态的（refresh/logout）由 register.ts 导出函数在这里调。
 */

import {
  accountLabelOf,
  findAccounts,
  hasStableIdentity,
  listAccounts,
  parseCredentialDocument,
  readDesktopAccount,
  readRecords,
  recordKey,
  removeBookAccount,
  saveAccount,
  saveBookAccount,
  type Account,
  type AccountCredential,
  type DayRecord,
} from './accounts.ts'
import { describeAtRestKey } from './at-rest.ts'
import {
  clearFault,
  faultSummary,
  isAvailable,
  pickNextAccount,
  RATE_LIMITED_COOLDOWN_MS,
  recordFault,
  resetFaults,
  type FaultVerdict,
} from './failover.ts'
import { BillingError, fetchCreditBalanceLookup, refreshCredential, type CreditLookup } from './checkin.ts'
import { beijingDay } from './time.ts'
import { displayContext, resolveMaskLevel, type DisplayContext, type MaskLevel } from './mask.ts'
import {
  daysLeftOf,
  needsAttention,
  runMany,
  summarize,
  totalBalance,
  totalCredit,
} from './runner.ts'
import {
  activateAccount,
  activeUidFor,
  isActive,
  providerIdFor,
  verifyActive,
  PROVIDER_IDS,
} from './switch.ts'
import { doctorBlock, outcomeIcon, outcomeText, overviewTable, regionLabel, sourceLabel, type Row } from './view.ts'
import { clearLocalCredentials, refreshModelCatalog } from './provider/register.ts'

/**
 * 命令层看到的最小 UI 接口。pi 的 `ExtensionCommandContext` / `ExtensionContext`
 * 都满足它 —— 这就是 hooks 与斜杠命令能共用同一个实现的原因。
 */
export interface HubUi {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void
  select(title: string, options: string[]): Promise<string | undefined>
  confirm(title: string, message: string): Promise<boolean>
  input(title: string, placeholder?: string): Promise<string | undefined>
}

/** 命令/hook 需要的最小上下文。 */
export interface HubContext {
  ui: HubUi
  /**
   * pi 原始上下文。只用于交给 provider 的 `refreshToken()` 逼缓存失效 ——
   * 它要读 `modelRegistry`，所以不能是这里裁剪过的接口。
   */
  raw?: unknown
  /** `/wb refresh` 之后要重载扩展才生效。 */
  reload?(): void
}

/** `/wb` 的可变状态。index.ts 建一份，所有命令共享。 */
export interface HubState {
  /** 界面显示名的脱敏档位（undefined = 按环境自动）。 */
  mask: MaskLevel | undefined
  autoFailover: boolean
  autoSign: { time: string, enabled: boolean, timer?: ReturnType<typeof setTimeout> }
  /** 自动签到到点时要跑的动作（由 index.ts 注入）。 */
  runScheduledSign?: () => Promise<void>
  /**
   * 最近一次故障触发的自动切换（{从, 到, 时间}）。`message_end` 靠它认出
   * 「这次失败就是刚才已经处理过的那一次」，避免把旧号的错记到新号头上、
   * 避免同一次事件记两次 strike。请求前预换（before_agent_start）不记，
   * 那之后的失败属于新号。
   */
  lastSwitch?: { fromId: string, toId: string, at: number }
}

export function initialState(): HubState {
  return { mask: undefined, autoFailover: true, autoSign: { time: '09:05', enabled: false } }
}

const SUBCOMMANDS: readonly string[] = [
  'status', 'sign', 'use', 'sync', 'add', 'rm', 'failover', 'auto',
  'refresh', 'logout', 'mask', 'doctor',
]

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

/**
 * 当前显示上下文。`state.mask` 只由 `/wb mask` 设置；没设过就按环境走
 * （`WORKBUDDY_MASK` > settings.json > TTY 默认），这样管道/CI 自动脱敏。
 */
function display(state: HubState, accounts: readonly Account[] = []): DisplayContext {
  return displayContext(state.mask ?? resolveMaskLevel(), accounts)
}

/** 按 id / uid / uin / 昵称匹配账号（`/wb use`、`/wb sign`、`/wb rm` 共用）。 */
function matchAccounts(accounts: readonly Account[], target: string): Account[] {
  return findAccounts(accounts, target)
}

function expiryText(account: Account): string {
  const days = daysLeftOf(account.expiresAtMs)
  if (days === undefined) return '到期未知'
  return days < 0 ? `已过期 ${Math.abs(days).toFixed(1)} 天` : `剩 ${days.toFixed(1)} 天`
}

function todayText(account: Account, records: Record<string, DayRecord>): string {
  const record = records[recordKey(account.region, account.id)]
  if (record === undefined) return '无记录'
  const prefix = record.day === beijingDay() ? '今日' : record.day
  const credit = record.credit === undefined ? '' : ` +${record.credit}`
  return `${prefix} ${outcomeText(record.outcome)}${credit}`
}

function rowOf(account: Account, ctx: DisplayContext, records: Record<string, DayRecord>, balance?: number): Row {
  const availability = isAvailable(account)
  return {
    mark: isActive(account) ? '◉' : ' ',
    name: ctx.name(account),
    region: regionLabel(account.region),
    expiry: expiryText(account),
    credit: creditText(balance),
    today: todayText(account, records),
    status: availability.ok ? '' : (availability.reason ?? '不可用'),
    details: [],
  }
}

/**
 * 余额的显示值。`未知` 与 `0` 是两件事：读不到接口不能报成「一分钱没有」。
 * 上游的值是小数（`4035.57`），已经是两位以内，直接照原样打，不四舍五入 ——
 * 否则一列数字加起来对不上合计行。
 */
function creditText(balance: number | undefined): string {
  return balance === undefined ? '未知' : String(balance)
}

/**
 * 并发探一下每个账号的余额；单个读不到就带出原因，绝不抛。
 *
 * 限 3 并发：上游对同 IP 并发敏感，一口气把四个号十二条请求全发出去，
 * 回来的可能就是几个 429 和不必要的「未知」。
 */
async function balancesOf(accounts: readonly Account[]): Promise<CreditLookup[]> {
  const lookups: CreditLookup[] = new Array(accounts.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= accounts.length) return
      lookups[index] = await fetchCreditBalanceLookup(accounts[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, () => worker()))
  return lookups
}

/** 合计行：只算真读到余额的账号；没读到的说清楚「为什么不知道」。 */
function totalCreditText(accounts: readonly Account[], lookups: readonly CreditLookup[]): string {
  const { total, accounts: counted } = totalBalance(lookups.map(lookup => ({ balance: lookup.balance?.remaining })))
  if (counted === 0) {
    return '  积分合计：未知（余额接口没有应答）'
      + reasonsText(lookups)
  }
  const suffix = counted === lookups.length ? '' : `（${counted}/${lookups.length} 个账号读到余额）`
  return `  积分合计：${creditText(total)}${suffix}${reasonsText(lookups)}`
}

/** 把「没读到」的原因归类成一句，挂在合计行后面。 */
function reasonsText(lookups: readonly CreditLookup[]): string {
  const reasons = lookups.map(lookup => lookup.reason).filter((reason): reason is string => reason !== undefined)
  if (reasons.length === 0) return ''
  const counts = new Map<string, number>()
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  const parts = [...counts].map(([reason, count]) => (count > 1 ? `${count} 个账号：${reason}` : reason))
  return `\n  余额没读到：${parts.join('；')}`
}

/** 展开 `~`，诊断里不打印完整家目录。 */
function shortPath(filePath: string): string {
  const home = process.env['HOME']
  return home === undefined || home === '' ? filePath : filePath.replace(home, '~')
}

// ---------------------------------------------------------------------------
// status：账号总览
// ---------------------------------------------------------------------------

async function showStatus(ctx: HubContext, state: HubState): Promise<void> {
  const accounts = listAccounts()
  const desktop = readDesktopAccount()
  if (accounts.length === 0) {
    const lines = [
      `WorkBuddy 账号中枢 · ${beijingDay()}（北京时区）`,
      '',
      '  没有发现任何账号。',
      '',
      '  /wb add      添加账号（桌面端 / 粘贴 token）',
      '  /login workbuddy   扫码登录后自动进 vault',
    ]
    if (desktop.reason !== undefined) lines.push(`  桌面端：${desktop.reason}`)
    ctx.ui.notify(lines.join('\n'), 'info')
    return
  }
  const ui = display(state, accounts)
  const records = readRecords()
  // 余额是现查的（只读、不花钱）：这是「现在有多少积分」唯一的真实口径
  const lookups = await balancesOf(accounts)
  const rows = accounts.map((account, index) => rowOf(account, ui, records, lookups[index]?.balance?.remaining))
  ctx.ui.notify([...overviewTable(
    `WorkBuddy 账号中枢 · ${beijingDay()}（北京时区）`,
    rows,
    [totalCreditText(accounts, lookups)],
  ), '', '  ◉ = pi 正在使用的 provider 账号', '  积分 = 账号当前可用余额（钱包口径），不是签到活动累计得分', '  /wb sign 批量签到 · /wb use 切换 · /wb failover 看故障与自动换号'].join('\n'), 'info')
}

// ---------------------------------------------------------------------------
// sign：批量签到
// ---------------------------------------------------------------------------

/**
 * 真正跑一批账号（手动签到、`/wb sign <x>`、定时签到共用）。
 * 逐条进度进 notify，最后给一段汇总；返回结果供调用方决定颜色/退出码。
 */
export async function signAccounts(
  ctx: HubContext,
  accounts: readonly Account[],
  state: HubState,
  options: { progress?: boolean } = {},
): Promise<readonly import('./runner.ts').RunOneResult[]> {
  const ui = display(state, accounts)
  if (options.progress !== false) ctx.ui.notify(`开始签到 ${accounts.length} 个账号…`, 'info')
  const results = await runMany(accounts, {
    concurrency: 3,
    onProgress: (result) => {
      if (options.progress === false) return
      ctx.ui.notify(
        `${outcomeIcon(result.outcome)} ${ui.name(result.account)}：${ui.scrub(result.message)}`
        + (result.refreshed ? '（已续期 token）' : ''),
        needsAttention(result) ? 'warning' : 'info',
      )
    },
  })
  ctx.ui.notify(summaryBlock(results, ui), results.some(needsAttention) ? 'warning' : 'info')
  return results
}

async function runSign(ctx: HubContext, args: string, state: HubState): Promise<void> {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    ctx.ui.notify('没有账号可签到。先 /wb add。', 'warning')
    return
  }
  const only = args.trim()
  const selected = only === '' ? accounts : matchAccounts(accounts, only)
  if (selected.length === 0) {
    ctx.ui.notify(`没有账号匹配 "${only}"。`, 'warning')
    return
  }
  await signAccounts(ctx, selected, state)
}

/** 「签到完成：…」+ 「需要处理：」两段。定时签到也用它。 */
function summaryBlock(results: readonly import('./runner.ts').RunOneResult[], ui: DisplayContext): string {
  const gained = totalCredit(results)
  const balance = totalBalance(results)
  const bad = results.filter(needsAttention)
  const lines = [`签到完成：${summarize(results)}${gained > 0 ? `，合计 +${gained} 积分` : ''}`]
  if (balance.accounts > 0) {
    lines.push(`当前可用积分：${creditText(balance.total)}`
      + (balance.accounts === balance.known ? '' : `（${balance.accounts}/${balance.known} 个账号读到余额）`))
  }
  const missing = results.map(result => result.balanceReason).filter((reason): reason is string => reason !== undefined)
  if (missing.length > 0) lines.push(`余额没读到：${[...new Set(missing)].join('；')}`)
  if (bad.length > 0) {
    lines.push('', '需要处理：')
    for (const result of bad) lines.push(`  ${outcomeIcon(result.outcome)} ${ui.name(result.account)}：${ui.scrub(result.message)}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// use：切换当前账号
// ---------------------------------------------------------------------------

async function useAccount(ctx: HubContext, args: string, state: HubState): Promise<void> {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    ctx.ui.notify('没有账号可切换。先 /wb add。', 'warning')
    return
  }
  const target = args.trim()
  const ui = display(state, accounts)

  if (target === '') {
    const lines = ['pi 当前使用的 provider 账号：', '']
    for (const account of accounts) {
      const availability = isAvailable(account)
      const state_ = availability.ok ? '' : `  ⚠ ${availability.reason}`
      lines.push(`${isActive(account) ? '◉' : '·'} ${ui.name(account)}  [${account.id}]  → ${providerIdFor(account)}${state_}`)
    }
    lines.push('', '切换：/wb use <id|昵称>')
    lines.push('同一区域只能挂一个号（pi 的 provider 凭据是单槽位）；国际版独立占一个槽位。')
    ctx.ui.notify(lines.join('\n'), 'info')
    return
  }

  const matches = matchAccounts(accounts, target)
  if (matches.length === 0) {
    ctx.ui.notify(`没有账号匹配 "${target}"。\n可用：${accounts.map(a => ui.name(a)).join('、')}`, 'warning')
    return
  }
  if (matches.length > 1) {
    ctx.ui.notify(`"${target}" 匹配多个，请用 id：\n${matches.map(a => `  ${a.id}  ${ui.name(a)}`).join('\n')}`, 'warning')
    return
  }

  const account = matches[0]
  if (isActive(account) && isAvailable(account).ok) {
    ctx.ui.notify(`${ui.name(account)} 已经是当前账号，且可用。`, 'info')
    return
  }

  const providerId = providerIdFor(account)
  const owner = accounts.find(a => a.id !== account.id && isActive(a) && providerIdFor(a) === providerId)
  if (owner !== undefined) {
    const ok = await ctx.ui.confirm(
      '切换会覆盖同区域账号',
      `${providerId} 槽位现在是 ${ui.name(owner)}，切到 ${ui.name(account)} 会覆盖它。\n（两个号都不会被删除，随时可切回。）`,
    )
    if (!ok) {
      ctx.ui.notify('已取消。', 'info')
      return
    }
  }

  const result = await activateAccount(account, ctx.raw)
  // 人为切换优先于自动判断：顺手清掉这个号的故障状态
  if (result.ok) clearFault(account)
  const verified = result.ok && verifyActive(account)
  ctx.ui.notify(
    result.ok
      ? `${result.message}${verified ? '' : '\n⚠ auth.json 校验不一致，请检查 /wb doctor'}`
      : result.message,
    result.ok ? 'info' : 'error',
  )
}

// ---------------------------------------------------------------------------
// 自动换号：判定 + 执行
// ---------------------------------------------------------------------------

/** 当前正在用的账号（按 auth.json 的 uid 反查）。 */
export function currentAccount(accounts: readonly Account[] = listAccounts()): Account | undefined {
  return accounts.find(account => isActive(account))
}

/**
 * 401 先救号：refreshToken 能换出新 AT，说明只是 token 过期、号本身没废 ——
 * 救回来、清掉故障记录，不记永久 revoked。救不回来才按原 verdict 处理。
 */
async function healRevokedAccount(account: Account): Promise<'healed' | 'revoked' | 'unknown'> {
  // Account 本身就是一份 AccountCredential（spread 存的），直接拿去续期
  let renewed: AccountCredential | undefined
  try {
    renewed = await refreshCredential(account)
  } catch (error) {
    return error instanceof BillingError && error.unauthorized ? 'revoked' : 'unknown'
  }
  if (renewed === undefined) return 'unknown'
  try {
    saveAccount(renewed, account.source)
  } catch {
    return 'unknown'
  }
  clearFault(account)
  return 'healed'
}

/**
 * 处理一次判定出来的故障：记账 + 必要时切号。返回是否真的切了。
 * hooks（响应后/消息结束）与 `/wb failover` 共用。
 */
export async function handleFault(ctx: HubContext, state: HubState, account: Account, verdict: FaultVerdict): Promise<boolean> {
  const ui = display(state, listAccounts())
  let effective: FaultVerdict | undefined = verdict
  if (verdict.kind === 'revoked') {
    const healed = await healRevokedAccount(account)
    if (healed === 'healed') {
      effective = undefined
      ctx.ui.notify(
        `🔑 ${ui.name(account)}：登录态 401，但 refreshToken 续期成功，号已救回（本次请求仍会切走）。`,
        'info',
      )
    } else if (healed === 'unknown') {
      // 续期接口无应答：网关问题可能比 token 问题更大，先冷却观察而非永久跳过
      effective = {
        kind: 'rate-limited',
        switchAccount: true,
        cooldownMs: RATE_LIMITED_COOLDOWN_MS,
        detail: `登录态 401，但续期接口无应答（可能是网关故障），先冷却观察：${verdict.detail}`,
      }
    }
  }
  if (effective !== undefined) recordFault(account, effective)
  const active = effective ?? verdict
  if (!active.switchAccount || !state.autoFailover) {
    ctx.ui.notify(`⚠ ${ui.name(account)}：${active.detail}`, 'warning')
    return false
  }

  const next = pickNextAccount(listAccounts(), { from: account })
  if (next === undefined) {
    ctx.ui.notify(
      `⚠ ${ui.name(account)}：${active.detail}\n`
      + '但已经**没有可用的备用账号**了（全部在冷却/需重登）。用 /wb failover 看详情，'
      + '或 /wb failover reset 清掉冷却。',
      'error',
    )
    return false
  }

  // ctx.raw 必须透传：provider 缓存失效要读 modelRegistry，没有它切换只是改文件
  const result = await activateAccount(next, ctx.raw)
  if (!result.ok) {
    ctx.ui.notify(`自动换号失败：${result.message}`, 'error')
    return false
  }
  state.lastSwitch = { fromId: account.id, toId: next.id, at: Date.now() }
  ctx.ui.notify(
    `🔀 ${ui.name(account)} → ${ui.name(next)}\n  ${active.detail}\n  下一个请求会用新账号发出。`,
    'info',
  )
  return true
}

async function showFailover(ctx: HubContext, args: string, state: HubState): Promise<void> {
  const sub = args.trim().toLowerCase()
  if (sub === 'reset') {
    ctx.ui.notify(`已清除 ${resetFaults()} 条故障记录。`, 'info')
    return
  }

  const lines = ['自动故障转移', '']
  if (!state.autoFailover) lines.push('  ⚠ 自动换号当前是**关闭**的：失败只记录，不切账号。', '')
  const faults = faultSummary(listAccounts())
  if (faults.length === 0) {
    lines.push('  所有账号状态正常，没有故障记录。')
  } else {
    lines.push('  故障记录：')
    for (const line of faults) lines.push(`    ${line}`)
  }
  lines.push('')
  lines.push('  触发规则：')
  lines.push('    · 限流 / code=37 / 429      → 换号，冷却 10 分钟')
  lines.push('    · 积分耗尽 14018            → 换号，冷却到明天 00:00')
  lines.push('    · 会话失效 12153 / 401      → 先静默续期，救不回才永久跳过（需重登）')
  lines.push('    · 上游负载 14003 / 5xx      → **不换号**，退避重试')
  lines.push('    · 网络错误                  → **不换号**，退避重试')
  lines.push('    · 同一号连续失败 3 次       → 压到明天')
  lines.push('')
  lines.push(`  开关：/wb failover on | off（当前 ${state.autoFailover ? 'on' : 'off'}）`)
  lines.push('  清空冷却：/wb failover reset')
  ctx.ui.notify(lines.join('\n'), 'info')
}

// ---------------------------------------------------------------------------
// add / rm
// ---------------------------------------------------------------------------

/** 解析一份粘贴内容：完整凭据 JSON 直接收，裸 token 走「补 uid/域」的交互。 */
async function addFromPaste(ctx: HubContext, state: HubState, pasted: string): Promise<void> {
  const credential = parseCredentialDocument(pasted)
  if (credential !== undefined) {
    // 没 uid/uin 的凭据没有稳定身份：两个会算出同一个 id，后存的覆盖先存的
    if (!hasStableIdentity(credential)) {
      ctx.ui.notify('这份凭据里没有 uid/uin，加进来会和其它无身份 token 互相覆盖。请补 uid 后再加（或用 /wb add 走交互）。', 'warning')
      return
    }
    try {
      const id = saveBookAccount(credential)
      ctx.ui.notify(`已添加 ${display(state).scrub(accountLabelOf(credential))}（${id}）`, 'info')
    } catch (error) {
      ctx.ui.notify(`保存失败，账号没有加上：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
    return
  }

  const uid = await ctx.ui.input('该 token 的 uid（X-User-Id，可留空）', '')
  if (uid === undefined) return
  if (uid.trim() === '') {
    ctx.ui.notify('没有 uid 加进来会和其它无身份 token 互相覆盖（同 id）。请填 uid，或粘贴带身份的完整凭据 JSON。', 'warning')
    return
  }
  const domain = await ctx.ui.input('登录域（www.codebuddy.cn / www.workbuddy.ai）', 'www.codebuddy.cn')
  if (domain === undefined) return
  try {
    const id = saveBookAccount({
      accessToken: pasted,
      refreshToken: '',
      expiresAtMs: 0,
      domain: domain.trim(),
      uid: uid.trim(),
    })
    ctx.ui.notify(`已添加（${id}）。无 refreshToken，过期后需重新添加。`, 'info')
  } catch (error) {
    ctx.ui.notify(`保存失败，账号没有加上：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

async function addAccount(ctx: HubContext, args: string, state: HubState): Promise<void> {
  const pasted = args.trim()
  if (pasted !== '') {
    await addFromPaste(ctx, state, pasted)
    return
  }

  const choice = await ctx.ui.select('从哪里添加账号？', [
    '桌面端当前登录（只读导入）',
    '粘贴完整凭据 JSON',
    '粘贴裸 access token',
  ])
  if (choice === undefined) return

  if (choice.startsWith('桌面端')) {
    const desktop = readDesktopAccount()
    if (desktop.account === undefined) {
      ctx.ui.notify(`读不到桌面端账号：${desktop.reason ?? '未知原因'}`, 'warning')
      return
    }
    const id = saveBookAccount(desktop.account)
    ctx.ui.notify(`已导入 ${display(state, [desktop.account]).name(desktop.account)}（${id}）`, 'info')
    return
  }

  const input = await ctx.ui.input(choice.startsWith('粘贴完整') ? '粘贴凭据 JSON' : '粘贴 access token', '')
  if (input === undefined || input.trim() === '') return
  await addFromPaste(ctx, state, input.trim())
}

async function removeAccount(ctx: HubContext, args: string, state: HubState): Promise<void> {
  const target = args.trim()
  if (target === '') {
    ctx.ui.notify('用法：/wb rm <id|昵称>', 'warning')
    return
  }
  const accounts = listAccounts()
  const matches = matchAccounts(accounts, target)
  if (matches.length === 0) {
    ctx.ui.notify(`没有账号匹配 "${target}"。`, 'warning')
    return
  }
  // 歧义时和 /wb use 对齐：报出来让人给 id，绝不猜着删
  if (matches.length > 1) {
    const ui = display(state, accounts)
    ctx.ui.notify(`"${target}" 匹配多个，请用 id 删除：\n${matches.map(a => `  ${a.id}  ${ui.name(a)}`).join('\n')}`, 'warning')
    return
  }
  const account = matches[0]
  const ui = display(state, accounts)
  if (account.source === 'vault') {
    ctx.ui.notify(
      `${ui.name(account)} 来自 vault（扫码登录），单个删不了（删了要重扫码）。`
      + '如需清掉整个区域：/wb logout cn|global（会清该区域全部本地凭据，桌面端登录不受影响）。',
      'warning',
    )
    return
  }
  if (account.source === 'desktop') {
    ctx.ui.notify(
      `${ui.name(account)} 是桌面端登录的只读镜像，不归本扩展管。`
      + '退出桌面端登录它就消失；想固定用它：先 /wb use 切换（会存一份拷贝）。',
      'warning',
    )
    return
  }
  const ok = await ctx.ui.confirm('删除账号', `从账号簿删除 ${ui.name(account)}（${account.id}）？桌面端登录不受影响。`)
  if (!ok) return
  ctx.ui.notify(removeBookAccount(account.id) ? `已删除 ${ui.name(account)}` : '删除失败（文件不存在或不可写）', 'info')
}

// ---------------------------------------------------------------------------
// mask
// ---------------------------------------------------------------------------

async function setMask(ctx: HubContext, args: string, state: HubState): Promise<void> {
  const value = args.trim().toLowerCase()
  if (value === 'full' || value === 'mask' || value === 'hash') {
    state.mask = value
    ctx.ui.notify(`界面显示名已切到 ${value}${value === 'full' ? '' : '（截图/录屏安全）'}。`, 'info')
    return
  }
  ctx.ui.notify(
    '用法：/wb mask full|mask|hash\n'
    + `  当前：${state.mask ?? '按环境自动'}（界面）\n`
    + '  full = 显示真名，mask = Al****99，hash = #1a2b3c4d\n'
    + '  非交互场景（管道/日志/CI）默认自动用 mask，可用 WORKBUDDY_MASK 覆盖。',
    'info',
  )
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function showDoctor(ctx: HubContext, state: HubState): Promise<void> {
  const accounts = listAccounts()
  const desktop = readDesktopAccount()
  const ui = display(state, accounts)
  const lines = ['WorkBuddy 诊断', '']

  lines.push(`北京日：${beijingDay()}`)
  for (const region of ['cn', 'global'] as const) {
    lines.push(`当前 ${PROVIDER_IDS[region]} 槽位 uid：${activeUidFor(PROVIDER_IDS[region]) ?? '(空)'}`)
  }
  lines.push(`桌面端 at-rest 密钥：${describeAtRestKey()}`)
  lines.push('')

  if (accounts.length === 0) {
    lines.push('账号：0 个')
    if (desktop.reason !== undefined) lines.push(`桌面端：${desktop.reason}`)
  } else {
    lines.push(`账号：${accounts.length} 个`)
    const records = readRecords()
    const lookups = await balancesOf(accounts)
    for (const [index, account] of accounts.entries()) {
      lines.push(...doctorBlock({
        ...rowOf(account, ui, records, lookups[index]?.balance?.remaining),
        details: [
          `${sourceLabel(account.source)} · refreshToken ${account.refreshToken === '' ? '无' : '有'}`,
          shortPath(account.filePath),
        ],
      }))
    }
    lines.push(totalCreditText(accounts, lookups))
  }

  if (desktop.account !== undefined) {
    lines.push('', `桌面端：${ui.name(desktop.account)}（${expiryText(desktop.account)}）`)
  } else if (desktop.reason !== undefined) {
    lines.push('', `桌面端：${desktop.reason}`)
  }
  ctx.ui.notify(lines.join('\n'), 'info')
}

// ---------------------------------------------------------------------------
// refresh / logout（provider 私有状态）
// ---------------------------------------------------------------------------

async function refreshCatalog(ctx: HubContext): Promise<void> {
  ctx.ui.notify(await refreshModelCatalog(), 'info')
  ctx.reload?.()
}

async function logout(ctx: HubContext, args: string): Promise<void> {
  ctx.ui.notify(`已清除 ${clearLocalCredentials(args)} 的本地凭据（不影响桌面端登录）`, 'info')
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

async function showSync(ctx: HubContext, state: HubState): Promise<void> {
  const accounts = listAccounts()
  const desktop = readDesktopAccount()
  const lines = [`共 ${accounts.length} 个账号`]
  const bySource = new Map<string, number>()
  for (const account of accounts) bySource.set(account.source, (bySource.get(account.source) ?? 0) + 1)
  for (const [source, count] of bySource) lines.push(`  ${sourceLabel(source)}：${count}`)
  if (desktop.account !== undefined) {
    lines.push(`  桌面端：${display(state, [desktop.account]).name(desktop.account)}`)
  } else if (desktop.reason !== undefined) {
    lines.push(`  桌面端：${desktop.reason}`)
  }
  ctx.ui.notify(lines.join('\n'), 'info')
}

// ---------------------------------------------------------------------------
// auto：session 内定时签到
// ---------------------------------------------------------------------------

/** 解析 `HH:MM`；不合法返回 undefined。 */
export function parseClock(text: string): { hour: number, minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined
}

/** 到下一个 `HH:MM` 还有多少毫秒。 */
export function msUntil(hour: number, minute: number, now: Date = new Date()): number {
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

async function setAutoSign(ctx: HubContext, args: string, state: HubState, schedule: () => void): Promise<void> {
  const value = args.trim()
  const stop = (): void => {
    state.autoSign.enabled = false
    if (state.autoSign.timer !== undefined) clearTimeout(state.autoSign.timer)
    state.autoSign.timer = undefined
  }

  if (value === 'off' || value === '0') {
    stop()
    ctx.ui.notify('已关闭自动签到。', 'info')
    return
  }
  if (value !== '' && value !== 'on') {
    const clock = parseClock(value)
    if (clock === undefined) {
      ctx.ui.notify(`时间格式不对："${value}"。用法 /wb auto 09:05`, 'warning')
      return
    }
    state.autoSign.time = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`
  }
  state.autoSign.enabled = true
  schedule()
  ctx.ui.notify(
    `已开启自动签到：每天 ${state.autoSign.time}（仅本 session）。无人值守请用 bin/install-launchd.sh。`,
    'info',
  )
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

/** `/wb` 的参数补全。 */
export function completions(prefix: string): { value: string, label: string }[] | null {
  const items = SUBCOMMANDS.filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s }))
  return items.length > 0 ? items : null
}

/** `/wb <sub> [rest]`。所有分支都在这里，一眼能看到全部入口。 */
export async function dispatch(ctx: HubContext, args: string, state: HubState, scheduleSign: () => void): Promise<void> {
  const trimmed = (args ?? '').trim()
  const [sub = 'status', ...rest] = trimmed === '' ? [] : trimmed.split(/\s+/)
  const remainder = rest.join(' ')

  switch (sub) {
    case 'status': return showStatus(ctx, state)
    case 'sign': return runSign(ctx, remainder, state)
    case 'use':
    case 'switch': return useAccount(ctx, remainder, state)
    case 'sync': return showSync(ctx, state)
    case 'add': return addAccount(ctx, remainder, state)
    case 'rm':
    case 'remove': return removeAccount(ctx, remainder, state)
    case 'doctor': return showDoctor(ctx, state)
    case 'mask': return setMask(ctx, remainder, state)
    case 'refresh': return refreshCatalog(ctx)
    case 'logout': return logout(ctx, remainder)
    case 'auto': return setAutoSign(ctx, remainder, state, scheduleSign)
    case 'failover': {
      const value = remainder.trim().toLowerCase()
      if (value === 'on' || value === 'off') {
        state.autoFailover = value === 'on'
        ctx.ui.notify(
          state.autoFailover
            ? '已开启自动换号：限流/额度用尽/登录失效时自动切到下一个账号。'
            : '已关闭自动换号：失败时只记录故障，不切账号。',
          'info',
        )
        return
      }
      return showFailover(ctx, remainder, state)
    }
    default:
      ctx.ui.notify(`未知子命令 "${sub}"。可用：${SUBCOMMANDS.join(' / ')}`, 'warning')
  }
}
