/**
 * provider 注册：把 WorkBuddy（CodeBuddy）的模型接到 pi 上。
 *
 * 两个 provider，一个区域一个：
 *   - `workbuddy`         → 国内网关（copilot.tencent.com）
 *   - `workbuddy-global`  → 国际网关（www.workbuddy.ai / www.codebuddy.ai）
 *
 * 有可用账号的区域才列出模型；没有账号的区域仍然注册 provider（它本来就是登录
 * 入口），但只列该区域自己的一小段 fallback 名单 —— 列出来的模型点了就报错没有意义。
 *
 * 模型名带上游的积分倍率（如 `GLM-5.3 · x0.79`）；图像输入按厂商文档的表格判定
 * （而不是平台那个过宽的 `supportsImages`）；思考档位只映射上游真的为该模型声明的档位。
 *
 * 上游协议与 wire 行为依据 dingminhua/dsh-connect-workbuddy（MIT），其致谢
 * corrinehu/dsh-workbuddy-connect、Sliverkiss/workbuddy2api 与
 * hawklithm/workbuddy2api（均 MIT）。
 *
 * 风险提示：WorkBuddy 限制非官方客户端，上游随时可能改坏。每次调用都按上游声明的
 * 倍率花**你自己账号**的积分。
 *
 * 【本包改动】
 *   · 不再注册任何斜杠命令：`status` / `sign` 由 `/wb status` / `/wb sign` 取代；
 *     `refresh` / `logout` 保留为导出函数（它们要用本模块私有的 stores / catalogs），
 *     由 `/wb refresh` / `/wb logout` 调用。详见 NOTICE.md。
 *   · provider id / 名字从 `src/switch.ts` 取（账号层要用同一对 id 操作 auth.json）。
 */

import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai/compat'

import { fallbackModelsFor, nativeImageInput, REFUSES_OFF_MODEL_IDS } from './catalog.ts'
import { WorkBuddyCredentialStore, type WorkBuddyUpstreamModel } from './store.ts'
import { WorkBuddyUpstreamClient } from './client.ts'
import { createWorkBuddyStream } from './stream.ts'
import { oauthPoll, oauthStart, regionOfOAuthAccount } from './oauth.ts'
import { CN_CHAT_BASE, GLOBAL_BASE, type Region } from '../upstream.ts'
import { PROVIDER_IDS, PROVIDER_NAMES } from '../switch.ts'
import { clearStoredCredentials } from './auth-io.ts'

/** 两个 provider 服务的区域，顺序固定（国内在前）。 */
const REGIONS: readonly Region[] = ['cn', 'global']

/** 每个区域的登录会话挂在内存里；重启即失效。 */
const stores = new Map<Region, WorkBuddyCredentialStore>()
const catalogs = new Map<Region, readonly WorkBuddyUpstreamModel[]>()
const catalogFetchedAt = new Map<Region, number>()

const CATALOG_REFRESH_MS = 10 * 60 * 1000

function log(message: string): void {
  console.warn(`[workbuddy-hub] ${message}`)
}

function storeFor(region: Region): WorkBuddyCredentialStore {
  let store = stores.get(region)
  if (store === undefined) {
    store = new WorkBuddyCredentialStore(region, message => log(`${region} ${message}`))
    stores.set(region, store)
  }
  return store
}

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

async function fetchCatalog(region: Region, force = false): Promise<readonly WorkBuddyUpstreamModel[]> {
  const cached = catalogs.get(region)
  const fetchedAt = catalogFetchedAt.get(region) ?? 0
  if (!force && cached !== undefined && Date.now() - fetchedAt < CATALOG_REFRESH_MS) return cached

  try {
    const credential = await storeFor(region).resolve()
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential)
    if (models.length > 0) {
      catalogs.set(region, models)
      catalogFetchedAt.set(region, Date.now())
      return models
    }
  } catch (error) {
    log(`${region} 模型目录刷新失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (cached !== undefined) return cached

  const fallback = fallbackModelsFor(region)
  catalogs.set(region, fallback)
  catalogFetchedAt.set(region, Date.now())
  return fallback
}

/** 模型显示名：裸名，或 `名字 · x0.79`。 */
function displayName(info: WorkBuddyUpstreamModel): string {
  return info.creditMultiplier === undefined ? info.name : `${info.name} · x${info.creditMultiplier.toFixed(2)}`
}

/**
 * 只映射模型真的声明的思考档位，没声明的保持 `null`（不可用）。
 * `off` 只在该模型声明可关闭、且不在实测「声明了也会拒」的表里时才给。
 */
function thinkingLevelMapFor(info: WorkBuddyUpstreamModel): Record<string, string | null> | undefined {
  const supported = info.reasoning?.supportedEfforts
    ?.filter(effort => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
  if (supported === undefined || supported.length === 0) return undefined
  const map: Record<string, string | null> = {}
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    map[level] = supported.includes(level) ? level : null
  }
  // pi-ai 把 `off: null` 读成「不支持」，于是不会发关闭思考的请求；这里再查一遍
  // 拒绝表，免得依赖每个调用方自己记得标记。
  map['off'] = info.reasoning?.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(info.id) ? 'off' : null
  return map
}

function toModelConfigs(models: readonly WorkBuddyUpstreamModel[]): ProviderConfig['models'] {
  return models.map((info) => {
    const thinkingLevelMap = thinkingLevelMapFor(info)
    return {
      id: info.id,
      name: displayName(info),
      reasoning: thinkingLevelMap !== undefined,
      ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      input: nativeImageInput(info.id) === true ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: info.contextWindow,
      maxTokens: info.maxTokens,
      compat: {
        // 网关拒绝 `developer` 角色（11128），`reasoning_effort` 也只认模型自己的阶梯
        supportsDeveloperRole: false,
        supportsReasoningEffort: thinkingLevelMap !== undefined,
        maxTokensField: 'max_tokens',
        supportsStore: false,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// provider 配置（启动注册与登录后重注册共用同一份）
// ---------------------------------------------------------------------------

function streamFor(region: Region) {
  return createWorkBuddyStream(async () => storeFor(region).resolve())
}

/** 把「模型列表」变成一个完整的 provider 配置。只此一份，别处不要再拼。 */
function providerConfig(pi: ExtensionAPI, region: Region, models: readonly WorkBuddyUpstreamModel[]): ProviderConfig {
  return {
    name: PROVIDER_NAMES[region],
    baseUrl: region === 'cn' ? CN_CHAT_BASE : GLOBAL_BASE,
    api: 'workbuddy-api',
    models: toModelConfigs(models),
    oauth: {
      name: PROVIDER_NAMES[region],
      async login(callbacks) {
        const started = await oauthStart(region)
        if ('error' in started) throw new Error(started.error)
        callbacks.onAuth({
          url: started.verificationUri,
          instructions: '在浏览器中打开该链接并登录 WorkBuddy（国内版扫码，国际版网页登录），完成后此处会自动继续',
        })
        callbacks.onProgress?.('等待你在浏览器中完成登录…')

        const deadline = Date.now() + started.expiresIn * 1000
        while (Date.now() < deadline) {
          if (callbacks.signal?.aborted) throw new Error('登录已取消')
          await new Promise(resolve => setTimeout(resolve, 2000))
          const polled = await oauthPoll(started.loginId, region)
          if (!polled.done) continue
          if ('error' in polled) throw new Error(polled.error)

          const account = polled.account
          const credentialRegion = regionOfOAuthAccount(account)
          if (credentialRegion !== region) {
            throw new Error(`该账号属于${credentialRegion === 'global' ? '国际版' : '国内版'}，请使用对应的 /login 入口`)
          }
          storeFor(region).acceptOAuthCredential({
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAtMs: account.expiresAtMs,
            domain: account.domain,
            uid: account.uid,
            ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
            ...(account.uin === undefined ? {} : { uin: account.uin }),
            ...(account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId }),
            source: 'oauth',
            filePath: '(oauth)',
          })
          // 立刻重注册，让这个区域的模型不用重启就出现
          const models = await fetchCatalog(region, true)
          pi.registerProvider(PROVIDER_IDS[region], providerConfig(pi, region, models))
          return {
            refresh: account.refreshToken,
            access: account.accessToken,
            expires: account.expiresAtMs,
            domain: account.domain,
            uid: account.uid,
          }
        }
        throw new Error('登录超时，请重试')
      },
      async refreshToken(credentials, signal) {
        // 续期走 store：它拥有上游端点与 provider 自己的副本。
        // 返回值就是 pi 写进 auth.json 的凭据形状。
        const store = storeFor(region)
        store.invalidate()
        const credential = await store.resolve()
        void signal
        return {
          refresh: credential.refreshToken || credentials.refresh,
          access: credential.accessToken,
          expires: credential.expiresAtMs || (Date.now() + 3600 * 1000),
          domain: credential.domain,
          uid: credential.uid,
        }
      },
      getApiKey: credentials => credentials.access,
    },
    streamSimple: streamFor(region),
  }
}

/** 注册（或重注册）一个区域的 provider。 */
function registerRegion(pi: ExtensionAPI, region: Region, models: readonly WorkBuddyUpstreamModel[]): void {
  pi.registerProvider(PROVIDER_IDS[region], providerConfig(pi, region, models))
}

/** Which region a model belongs to, from its provider stamp. */
function providerRegionOf(model: { provider?: string }): Region {
  return model.provider === PROVIDER_IDS.global ? 'global' : 'cn'
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default async function registerWorkBuddyProviders(pi: ExtensionAPI): Promise<void> {
  // 启动：读凭据 → 拉目录 → 两个区域都注册
  for (const region of REGIONS) {
    try {
      if ((await storeFor(region).status()).signedIn) {
        registerRegion(pi, region, await fetchCatalog(region, true))
      } else {
        // 没账号也要注册：它的登录卡片就是这个区域的登录入口
        registerRegion(pi, region, fallbackModelsFor(region).slice(0, 3))
      }
    } catch (error) {
      log(`${region} 启动失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 注册自定义 api 实现：委托给内置 openai-completions，再加 WorkBuddy 的 wire 改写
  const compat = await import('@earendil-works/pi-ai/compat')
  if (typeof compat.registerApiProvider !== 'function') {
    log('api 注册失败：pi-ai 没有导出 registerApiProvider')
    return
  }
  compat.registerApiProvider(
    {
      api: 'workbuddy-api',
      stream: (model, context, options) =>
        streamFor(providerRegionOf(model))(model, context, options as SimpleStreamOptions | undefined),
      streamSimple: (model, context, options) => streamFor(providerRegionOf(model))(model, context, options),
    },
    'provider:workbuddy',
  )
}

/**
 * 重新拉取模型目录。[本包改动：原为 `workbuddy.refresh` 命令的 handler]
 * 调用方：`/wb refresh`。
 */
export async function refreshModelCatalog(): Promise<string> {
  const parts: string[] = []
  for (const region of REGIONS) {
    const models = await fetchCatalog(region, true)
    parts.push(`${PROVIDER_NAMES[region]}: ${models.length} 个模型`)
  }
  return parts.join('\n')
}

/**
 * 清除本地凭据（不动桌面端登录）。[本包改动：原为 `workbuddy.logout` 命令的 handler]
 * 调用方：`/wb logout [cn|global]`。
 */
export function clearLocalCredentials(target: string): string {
  const wanted = target.trim().toLowerCase()
  const regions = wanted === 'cn' ? (['cn'] as const) : wanted === 'global' ? (['global'] as const) : REGIONS
  for (const region of regions) {
    clearStoredCredentials(region)
    stores.get(region)?.invalidate()
    catalogs.delete(region)
  }
  return regions.map(region => PROVIDER_IDS[region]).join(', ')
}
