/**
 * 凭据解析：给请求挑一份凭据，必要时走上游续期接口换新 token。
 *
 * 来源优先级（越新越优先）：
 *   1. provider 自己刷新出来的副本 —— 一定比 App 上次写的新，所以重启时不能被
 *      live 文件复活成旧 token；
 *   2. 桌面端 App 的 live 文件 —— App 当前的登录；
 *   3. OAuth vault 里的账号 —— 显式登录过的，可作为选择项。
 *
 * 安全红线：聊天路径**绝不**携带 refreshToken，它只出现在续期接口的
 * `X-Refresh-Token` header 里。续期本身走账号层的 `refreshCredential()`
 * （与 CLIs 签到共用同一个实现）。
 */

import {
  readDesktopCredential,
  readOwnCredential,
  readVaultAccounts,
  saveOwnCredential,
  saveVaultAccount,
  type ReadCredentialResult,
  type WorkBuddyCredential,
} from './auth.ts'
import { accountIdOf } from '../accounts.ts'
import { isExpired, needsRefresh, refreshCredential } from '../checkin.ts'
import { ensureAtRestKey } from '../at-rest.ts'
import { CHAT_PATH, regionOf, type Region } from './upstream.ts'

export interface WorkBuddyAuthStatus {
  region: Region
  /** 有可用凭据时为 true。 */
  signedIn: boolean
  label?: string
  /** access token 到期时刻（epoch ms）；0 = 未知。 */
  expiresAtMs?: number
  source?: WorkBuddyCredential['source']
  /** 被跳过的候选路径及原因（诊断，不含秘密）。 */
  candidates: ReadCredentialResult['skipped']
}

export class WorkBuddyCredentialStore {
  /** 上一次解析出来的凭据，按区域缓存。 */
  private resolved: WorkBuddyCredential | undefined

  constructor(
    private readonly region: Region,
    private readonly log?: (message: string) => void,
  ) {}

  getRegion(): Region {
    return this.region
  }

  /**
   * 解决下一次请求要用的凭据；过期就续期。什么都没有时抛一条能照做的错。
   */
  async resolve(): Promise<WorkBuddyCredential> {
    if (this.resolved !== undefined && !needsRefresh(this.resolved)) return this.resolved

    const key = await ensureAtRestKey()
    const desktop = readDesktopCredential(this.region, key)
    const best = pickBest(readOwnCredential(this.region), desktop, readVaultAccounts(this.region))
    if (best === undefined) {
      throw new Error(
        `workbuddy ${this.region}: 没有可用凭据。请登录 WorkBuddy 桌面端`
        + `（或运行 /login workbuddy${this.region === 'global' ? '-global' : ''}）后重试。`,
      )
    }

    let credential = best
    if (needsRefresh(credential)) {
      const refreshed = await refreshCredential(credential).catch((error: unknown) => {
        this.log?.(`workbuddy ${this.region}: token 续期失败: ${String(error)}`)
        return undefined
      })
      if (refreshed === undefined) {
        // 续期失败但还没真过期 —— 有些网关过了声明时间也给 200，值得试一次
        if (isExpired(credential)) throw new Error(`workbuddy ${this.region}: token 已过期且续期失败，请重新登录`)
      } else {
        credential = { ...refreshed, source: 'plugin', ...(credential.filePath === undefined ? {} : { filePath: credential.filePath }) }
        saveOwnCredential(this.region, credential)
      }
    }

    this.resolved = credential
    return credential
  }

  /** 当前状态，不发网络请求（at-rest 密钥会按需探测一次）。 */
  async status(): Promise<WorkBuddyAuthStatus> {
    const key = await ensureAtRestKey()
    const desktop = readDesktopCredential(this.region, key)
    const best = pickBest(readOwnCredential(this.region), desktop, readVaultAccounts(this.region))
    return {
      region: this.region,
      signedIn: best !== undefined,
      ...(best === undefined ? {} : {
        label: best.nickname ?? best.displayName ?? best.uid,
        expiresAtMs: best.expiresAtMs,
        source: best.source,
      }),
      candidates: desktop.skipped,
    }
  }

  /** 丢掉缓存的解析结果（凭据被上游拒绝之后）。 */
  invalidate(): void {
    this.resolved = undefined
  }

  /**
   * 把 OAuth 流程收到的账号写进 vault 并作为当前凭据。
   * vault 写失败只记日志（本次 session 的内存凭据照常用，重启后需重登）。
   */
  acceptOAuthCredential(credential: WorkBuddyCredential): string {
    const accountId = accountIdOf(credential)
    try {
      saveVaultAccount(this.region, credential)
    } catch (error) {
      this.log?.(`vault 写失败（本次登录重启后丢失）：${error instanceof Error ? error.message : String(error)}`)
    }
    this.resolved = credential
    return accountId
  }
}

/** 来源排序：刷新副本 > live 文件 > vault 里到期最晚的那个。 */
const SOURCE_RANK: Readonly<Record<WorkBuddyCredential['source'], number>> = {
  plugin: 0,
  desktop: 1,
  oauth: 2,
  env: 3,
}

function pickBest(
  own: WorkBuddyCredential | undefined,
  desktop: ReadCredentialResult,
  vault: Map<string, WorkBuddyCredential>,
): WorkBuddyCredential | undefined {
  const candidates: WorkBuddyCredential[] = []
  if (own !== undefined) candidates.push({ ...own, source: 'plugin' })
  if (desktop.credential !== undefined) candidates.push(desktop.credential)
  candidates.push(...vault.values())
  if (candidates.length === 0) return undefined
  // 排序：来源优先（已吊销的备份 expiresAt 可以很远，绝不能拿过期时间当主序）
  return candidates.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
    || b.expiresAtMs - a.expiresAtMs)[0]
}

// ---------------------------------------------------------------------------
// 模型目录解析（provider 专用；账号层不需要）
// ---------------------------------------------------------------------------

/** 上游发布的模型条目（解析不了的字段保持 undefined，绝不猜）。 */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** 从上游 `credits` 字符串解析出来的倍率。 */
  creditMultiplier?: number
  supportsImages?: boolean
  reasoning?: {
    supportedEfforts?: string[]
    defaultEffort?: string
    canDisableThinking?: boolean
  }
}

/**
 * 解析上游的 `credits` 字符串。实测形态：`"x0.79 credits"`、`"x0.05"`、
 * `"x0.00 credits"`、以及不出现。解析不了返回 undefined。
 */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** 上游声明的思考档位阶梯（跨网关实测并集）。单数形式 `effort` 折进完整阶梯。 */
const SINGULAR_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function parseReasoning(value: unknown): WorkBuddyUpstreamModel['reasoning'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const declared = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
    : undefined
  const supportedEfforts = declared ?? (effort === undefined
    ? undefined
    : (SINGULAR_EFFORT_LADDER as readonly string[]).includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort])
  const defaultEffort = typeof raw['defaultEffort'] === 'string' ? raw['defaultEffort'] : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
    ? raw['canDisableThinking']
    : (effort !== undefined && declared === undefined && typeof raw['defaultEffort'] !== 'string') ? true : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) return undefined
  return {
    ...(supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(canDisableThinking === undefined ? {} : { canDisableThinking }),
  }
}

/** 上游列出来但其实是**路由器**、不是模型的 id。 */
const ROUTER_MODEL_IDS: ReadonlySet<string> = new Set(['auto', 'default-model'])

/** 解析一条目录条目；没有可用 token 上限的直接丢掉。 */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  // `disabledMultimodal: true` 是对平台 `supportsImages` 的硬否决
  const supportsImages = raw['disabledMultimodal'] === true
    ? false
    : typeof raw['supportsImages'] === 'boolean' ? raw['supportsImages'] : undefined
  return {
    id,
    name: typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id,
    contextWindow: input,
    maxTokens: output,
    ...(creditMultiplier === undefined ? {} : { creditMultiplier }),
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

/** 从目录文档里挑出可聊天的模型，按上游名单顺序。 */
export function selectCliModels(rawModels: unknown, agents: unknown): WorkBuddyUpstreamModel[] {
  const byId = new Map<string, WorkBuddyUpstreamModel>()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    const parsed = parseUpstreamModel(model)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let cliIds: readonly string[] | undefined
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (typeof agent !== 'object' || agent === null) continue
    const wrapped = agent as Record<string, unknown>
    if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
      cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
      break
    }
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
  return ids
    .filter(id => !ROUTER_MODEL_IDS.has(id))
    .map(id => byId.get(id))
    .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
}

export { CHAT_PATH, regionOf }
export type { WorkBuddyCredential } from './auth.ts'
