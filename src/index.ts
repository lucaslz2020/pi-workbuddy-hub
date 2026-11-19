/**
 * WorkBuddy 多账号中枢（pi 全局扩展，自动发现于 ~/.pi/agent/extensions/）
 *
 * 三件事：
 *   1. **账号池 + 每日签到**（多账号批量、幂等、北京时区）
 *   2. **切换 + 自动故障转移**（一个号限流/额度用尽就换下一个）
 *   3. **内置 provider**（`workbuddy` / `workbuddy-global`，见 src/provider/）
 *
 * ## 自动切号是怎么接进去的
 *
 * pi 没有「请求失败时换凭据重试」的公开接口，所以自动切号分三层挂载：
 *
 * | 时机 | Hook | 干什么 |
 * |---|---|---|
 * | 请求前 | `before_agent_start` | 当前号在冷却 → 先换到可用的，让这次请求不白跑 |
 * | 响应后 | `after_provider_response` | 429/5xx/401 → 立刻判定并记故障 |
 * | 消息结束 | `message_end` | 从 `stopReason=error` 的 `errorMessage` 里认出限流/额度/失效 |
 *
 * 切号本身会写 vault + 刷新副本 + auth.json，并调 provider 模块的
 * `invalidateCredentialCache()` 丢掉进程内缓存（详见 switch.ts）。所以**下一次尝试
 * 就用新号**，而不是等重启。
 *
 * （旧实现靠 `provider.oauth.refreshToken()` 失效缓存，但那条路对 legacy 注册的
 * provider 永远是 `undefined`，于是切号只改文件、请求继续走旧号 —— 已修。）
 *
 * 认不出来的错误一律**不切号** —— 换号解决不了的问题，换号只会白烧所有号的额度。
 *
 * ## 文件分工（这就是「不再有重复代码」的意思）
 *
 * | 文件 | 只负责 |
 * |---|---|
 * | `upstream.ts` | 域名/路径/UA/业务码 —— 唯一一份事实表 |
 * | `fields.ts` | 上游字段的 snake/camel 双拼写读取 |
 * | `jsonfile.ts` | 状态文件原子读写 + 备份 |
 * | `at-rest.ts` | 桌面端加密字段 + 密钥来源（唯一一份实现） |
 * | `accounts.ts` | 账号池：三条来源、解析/序列化、签到记录 |
 * | `checkin.ts` | 签到协议 + token 续期（唯一一份） |
 * | `runner.ts` | 一个账号怎么跑、批量并发、兜底重试 |
 * | `switch.ts` | 切号的四个步骤 |
 * | `failover.ts` | 错误 → 故障判定 + 冷却状态 |
 * | `view.ts` / `mask.ts` | 排版 / 脱敏 |
 * | `commands.ts` | `/wb` 的每个子命令 |
 * | `index.ts`（本文件） | 只做接线：注册 provider、挂 hook、注册 `/wb` |
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { listAccounts, prepareAccounts } from './accounts.ts'
import {
  accountForProvider,
  completions,
  dispatch,
  handleFault,
  initialState,
  msUntil,
  parseClock,
  signAccounts,
  type HubContext,
} from './commands.ts'
import { classifyError, clearFault, isAvailable, pickNextAccount, setActiveUidLookup } from './failover.ts'
import { displayContext, resolveMaskLevel } from './mask.ts'
import { accountsPendingToday } from './runner.ts'
import { activateAccount, activeUidFor, PROVIDER_IDS, setCredentialRefresher } from './switch.ts'
import registerWorkBuddyProviders, { invalidateCredentialCache } from './provider/register.ts'

const LOG = '[workbuddy-hub]'

/**
 * 开发调试日志默认**关闭**：只有显式设置 `PI_WORKBUDDY_DEBUG=1`（或 `WORKBUDDY_DEBUG=1`）才输出。
 *
 * 以前 hook 无条件 `console.warn`，装了这个扩展的任何会话都会在 TUI 上多出两行
 * `[workbuddy-hub] hook …`，与用户当前用的 provider 毫无关系。（issue #1）
 */
function debugEnabled(): boolean {
  const raw = process.env['PI_WORKBUDDY_DEBUG'] ?? process.env['WORKBUDDY_DEBUG'] ?? ''
  const value = raw.trim().toLowerCase()
  return value !== '' && value !== '0' && value !== 'false' && value !== 'off' && value !== 'no'
}

/** hook 收到的事件（调试用）每个只打一次 keys；值不打，防 token/uid 进日志。 */
const loggedHookShapes = new Set<string>()
function logHookShape(name: string, event: unknown, providerId: string): void {
  if (!debugEnabled() || loggedHookShapes.has(name)) return
  loggedHookShapes.add(name)
  try {
    const keys = event !== null && typeof event === 'object' ? Object.keys(event).join(',') : typeof event
    console.warn(`${LOG} hook ${name} 事件 keys: ${keys}（provider: ${providerId}）`)
  } catch {
    // 打不出就不打
  }
}

/** 本扩展注册的两个 provider id（`workbuddy` / `workbuddy-global`）。 */
const WORKBUDDY_PROVIDER_IDS: ReadonlySet<string> = new Set(Object.values(PROVIDER_IDS))

/**
 * 这次请求是不是 WorkBuddy 的？
 *
 * 认不出 provider 一律按「不是」处理 —— 宁可少管一次，也不要把别的 provider 的
 * 故障记到 WorkBuddy 账号头上、或替它换号。
 */
function isWorkBuddyProvider(providerId: string | undefined): providerId is string {
  return providerId !== undefined && WORKBUDDY_PROVIDER_IDS.has(providerId)
}

/**
 * 从事件/消息上读这次请求的 provider，读不到退回 `ctx.model`。
 *
 * `message_end` 的 assistant 消息带 `provider`（就是发出这次请求的那个），
 * 比 `ctx.model` 更可靠：异步切模型时 `ctx.model` 可能已经不是发请求的那个了。
 */
function providerOfEvent(source: unknown, ctx: ExtensionContext): string | undefined {
  const stamped = (source as { provider?: unknown } | null | undefined)?.provider
  if (typeof stamped === 'string' && stamped !== '') return stamped
  return ctx.model?.provider
}

/** pi 的扩展上下文 → 命令层的最小接口。 */
function hubContext(ctx: ExtensionContext): HubContext {
  const maybeReload = (ctx as { reload?: unknown }).reload
  return {
    ui: {
      notify: (message, type) => ctx.ui.notify(message, type),
      select: (title, options) => ctx.ui.select(title, options),
      confirm: (title, message) => ctx.ui.confirm(title, message),
      input: (title, placeholder) => ctx.ui.input(title, placeholder),
    },
    // 原始上下文：`/login`、refresh/logout 与切号都可能要读 provider 侧状态
    raw: ctx,
    // `reload` 只在命令上下文里有，hook 上下文没有
    ...(typeof maybeReload === 'function'
      ? { reload: () => (ctx as unknown as { reload(): void }).reload() }
      : {}),
  }
}

export default async function workbuddyHub(pi: ExtensionAPI): Promise<void> {
  // ---- ① 读 at-rest 密钥，再注册 provider ----
  //
  // 必须 await，不能 `void` 发起后不管：pi 在加载扩展后会立刻读一遍 modelRegistry
  // 生成模型列表（`pi --list-models` 甚至不等任何异步）。注册竞态会让 provider 装好
  // 了但模型列表为空。
  //
  // 也必须在 `/wb` 之前：切号的「第④步 让 provider 丢缓存」作用在 provider 模块自己的
  // stores 上；provider 没注册起来就没人调 resolve，切号后第一次请求还是从磁盘现读。
  await prepareAccounts().catch((error: unknown) => {
    console.warn(`${LOG} at-rest 密钥探测失败:`, error instanceof Error ? error.message : error)
  })
  await registerWorkBuddyProviders(pi).catch((error: unknown) => {
    console.warn(`${LOG} provider 注册失败:`, error instanceof Error ? error.message : error)
  })

  const state = initialState()

  // ---- ② 让 switch.ts 能丢掉 provider 进程内的凭据缓存 ----
  //
  // 以前走的是 `ctx.modelRegistry.getRegisteredNativeProvider(id).oauth.refreshToken()`：
  // 本包用 `pi.registerProvider(id, config)`（legacy 形态）注册，它落在 modelRegistry 的
  // `extensionProviders` 里，而 `getRegisteredNativeProvider(id)` 读的是
  // `nativeExtensionProviders` —— 对 legacy 注册永远是 undefined。于是那条路一直在
  // 「跳过缓存失效」，切号只改了文件：**界面说切了，请求还是旧号发的，新号一直失败**。
  // 现在直接从 provider 模块拿 stores 的失效入口，不再依赖上下文里有什么。
  setCredentialRefresher(async (providerId) => invalidateCredentialCache(providerId))

  // failover 用注入的回调查「谁是当前号」，避免与 switch 循环依赖
  setActiveUidLookup(activeUidFor)

  // ---- ③ 定时签到（session 内；无人值守请用 bin/install-launchd.sh） ----
  const scheduleSign = (ctx: ExtensionContext): void => {
    if (state.autoSign.timer !== undefined) clearTimeout(state.autoSign.timer)
    if (!state.autoSign.enabled) return
    const clock = parseClock(state.autoSign.time)
    if (clock === undefined) return

    state.autoSign.timer = setTimeout(() => {
      void (async () => {
        await state.runScheduledSign?.()
        scheduleSign(ctx)
      })()
    }, msUntil(clock.hour, clock.minute))
    state.autoSign.timer.unref?.()
  }

  /** 到点要跑的事：与手动签到完全同一条路径，只是不逐条刷屏。 */
  state.runScheduledSign = async (): Promise<void> => {
    const accounts = listAccounts()
    if (accounts.length === 0) return
    const lines: string[] = []
    // 定时任务没有交互层：结果进日志 + 一条通知
    const quiet: HubContext = {
      ui: {
        notify: (message) => { lines.push(message) },
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
      },
    }
    await signAccounts(quiet, accounts, state, { progress: false })
    console.log(`${LOG} [自动签到 ${state.autoSign.time}]\n${lines.join('\n')}`)
  }

  // ---- ④ hooks ----
  //
  // 下面三个 hook 都会被**所有** provider 的请求触发。先确认「这次请求是不是本扩展
  // 的 provider」，再做日志/记故障/换号 —— 否则别的 provider 的 429/401 会被记到
  // WorkBuddy 账号上，甚至把号切走（issue #1）。
  //
  // `after_provider_response` 的事件只有 `status` / `headers`，没有 provider，所以
  // 在 `before_provider_request` 里记下这次请求实际用的 provider；`message_end`
  // 优先用消息自带的 `provider` 戳。
  let inFlightProvider: string | undefined

  pi.on('before_provider_request', (_event, ctx) => {
    inFlightProvider = ctx.model?.provider
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!state.autoFailover) return
    const providerId = ctx.model?.provider
    if (!isWorkBuddyProvider(providerId)) return
    const accounts = listAccounts()
    const account = accountForProvider(providerId)
    if (account === undefined || isAvailable(account).ok) return
    const next = pickNextAccount(accounts, { from: account, sameProvider: true })
    if (next === undefined) return
    // ctx 必须透传：provider 缓存失效要读 modelRegistry，没有它切换只是改文件
    // 注意：这里不记 lastSwitch —— 预换之后这次请求的失败属于新号，要正常归因
    if (!(await activateAccount(next, ctx)).ok) return
    const ui = displayContext(state.mask ?? resolveMaskLevel(), accounts)
    ctx.ui.notify(`🔀 请求前自动换号：${ui.name(account)}（不可用）→ ${ui.name(next)}`, 'info')
  })

  pi.on('after_provider_response', async (event, ctx) => {
    const providerId = inFlightProvider ?? ctx.model?.provider
    if (!isWorkBuddyProvider(providerId)) return
    logHookShape('after_provider_response', event, providerId)
    const status = (event as { status?: number }).status ?? 0
    if (status !== 429 && status !== 401 && status < 500) return
    const account = accountForProvider(providerId)
    if (account === undefined) return
    const verdict = classifyError({ status })
    if (verdict !== undefined) await handleFault(hubContext(ctx), state, account, verdict)
  })

  pi.on('message_end', async (event, ctx) => {
    const message = (event as {
      message?: { role?: string, provider?: string, stopReason?: string, errorMessage?: string }
    }).message
    if (message?.role !== 'assistant') return
    const providerId = providerOfEvent(message, ctx)
    if (!isWorkBuddyProvider(providerId)) return
    logHookShape('message_end', event, providerId)
    const account = accountForProvider(providerId)
    if (account === undefined) return

    if (message.stopReason !== 'error') {
      // 成功一次就清掉这个号的连败计数
      clearFault(account)
      return
    }

    const errorMessage = message.errorMessage ?? ''
    if (errorMessage === '') return
    const verdict = classifyError({ message: errorMessage })
    if (verdict === undefined) return
    // after_provider_response 很可能已经处理过同一次失败并切了号：
    // 当前号正好是切过去的目标 → 这是重复信号，跳过（防记到新号头上、防二次切号）
    const switched = state.lastSwitch
    if (switched !== undefined && Date.now() - switched.at < 30_000 && account.id === switched.toId) return
    await handleFault(hubContext(ctx), state, account, verdict)
  })

  pi.on('session_shutdown', () => {
    if (state.autoSign.timer !== undefined) clearTimeout(state.autoSign.timer)
    state.autoSign.timer = undefined
  })

  // ---- ⑤ /wb：唯一命令入口 ----
  pi.registerCommand('wb', {
    description: 'WorkBuddy 账号中枢（status/sign/use/sync/add/rm/failover/auto/refresh/logout/mask/doctor）',
    getArgumentCompletions: prefix => completions(prefix),
    handler: async (args, ctx) => {
      await dispatch(hubContext(ctx), args ?? '', state, () => scheduleSign(ctx))
    },
  })

  // ---- ⑥ 启动时的轻量提示 ----
  pi.on('session_start', async (_event, ctx) => {
    const accounts = listAccounts()
    if (accounts.length === 0) return
    const ui = displayContext(state.mask ?? resolveMaskLevel(), accounts)
    const pending = accountsPendingToday(accounts)
    const cooling = accounts.filter(account => !isAvailable(account).ok)
    const notes: string[] = []
    if (pending.length > 0) notes.push(`今天还未签到：${pending.map(a => ui.name(a)).join('、')}（/wb sign）`)
    if (cooling.length > 0) notes.push(`冷却中：${cooling.map(a => ui.name(a)).join('、')}（/wb failover 看详情）`)
    if (notes.length > 0) ctx.ui.notify(`WorkBuddy\n  ${notes.join('\n  ')}`, 'info')
  })
}
