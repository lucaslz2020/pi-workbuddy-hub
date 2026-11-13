/**
 * 账号切换：把一个账号变成「pi 现在正在用的号」。
 *
 * ## 为什么切换要「写 auth.json」
 *
 * pi 的 provider 凭据是单槽位：`auth.json` 里一个 provider 只有一份
 * `{access, refresh, expires, domain, uid}`。provider 注册了
 * `workbuddy`（国内）/ `workbuddy-global`（国际）两个 provider，于是：
 *   · 跨区域能并存
 *   · **同区域只能挂一个号**，切就是覆盖
 *
 * ## 为什么切换后必须让 provider 重新读
 *
 * `WorkBuddyCredentialStore` 在**进程内缓存**解析结果。只改 auth.json 而不让
 * 缓存失效，provider 会继续用旧 token 发请求 —— 表现就是「切换成功但账号没变」，
 * 而且新账号一直失败（请求实际上还是旧号发的）。
 *
 * 失效走 provider 模块导出的 `invalidateCredentialCache()`（见
 * `src/provider/register.ts`），由 index.ts 在启动时注入到本文件 —— 这里不直接
 * import，避免与 provider 互相依赖。
 *
 * 曾经走的 **`provider.oauth.refreshToken()`** 路线不成立：本包用
 * `pi.registerProvider(id, config)`（legacy 形态）注册，它落在 modelRegistry 的
 * `extensionProviders` 里，而 `getRegisteredNativeProvider(id)` 读的是
 * `nativeExtensionProviders` —— 对 legacy 注册永远是 `undefined`。那条路拿到
 * 空对象直接返回 false，缓存一点没动，于是「切了但号没变」永远修不掉。
 *
 * 所以「激活账号」= ① 写进 vault（对应区域）② 写进刷新副本 ③ 写进 auth.json
 * ④ 调 `invalidateCredentialCache()` 丢缓存。缺任何一步都是假切换。
 *
 * 为什么①也要做：provider 的 `pickBest()` 让刷新副本与 vault 都排在 auth.json
 * 之前，只写 auth.json 会被它们**静默覆盖**。
 */

import { join } from 'node:path'
import { credentialDocument, piAgentDir, pluginCopyPath, vaultDir, type Account } from './accounts.ts'
import { readJsonObject, writeJsonAtomic } from './jsonfile.ts'
import { regionOf, type Region } from './upstream.ts'

// ---------------------------------------------------------------------------
// auth.json（pi 的 provider 凭据槽位）
// ---------------------------------------------------------------------------

interface AuthSlot {
  type: string
  access: string
  refresh: string
  expires: number
  domain: string
  uid: string
}

function authFilePath(): string {
  return join(piAgentDir(), 'auth.json')
}

/** 两个 provider 槽位 id（顺序固定：国内在前）。 */
export const PROVIDER_IDS: Readonly<Record<Region, string>> = {
  cn: 'workbuddy',
  global: 'workbuddy-global',
}

export const PROVIDER_NAMES: Readonly<Record<Region, string>> = {
  cn: 'WorkBuddy (CN)',
  global: 'WorkBuddy AI (Global)',
}

/** 这个账号落在哪个 provider 槽位上。 */
export function providerIdFor(account: Pick<Account, 'domain'>): string {
  return PROVIDER_IDS[regionOf(account.domain)]
}

function readAuthFile(): Record<string, unknown> {
  return readJsonObject(authFilePath())
}

export function activeUidFor(providerId: string): string | undefined {
  const slot = readAuthFile()[providerId]
  if (typeof slot !== 'object' || slot === null) return undefined
  const uid = (slot as Record<string, unknown>)['uid']
  return typeof uid === 'string' ? uid : undefined
}

/** 账号 → auth.json 槽位。字段与 pi 自己写的一模一样，不多塞。 */
function slotFor(account: Account): AuthSlot {
  return {
    type: 'oauth',
    access: account.accessToken,
    refresh: account.refreshToken,
    expires: account.expiresAtMs,
    domain: account.domain,
    uid: account.uid,
  }
}

export function isActive(account: Account): boolean {
  return activeUidFor(providerIdFor(account)) === account.uid
}

/**
 * 备份 auth.json 并用新内容原子替换，只改指定 provider 的键。
 * auth.json 也会被 pi 自己写，所以这里**必须**留备份。
 */
function writeAuthSlot(providerId: string, slot: AuthSlot): { backupPath?: string, error?: string } {
  try {
    const backupPath = writeJsonAtomic(authFilePath(), { ...readAuthFile(), [providerId]: slot }, { backup: true })
    return backupPath === undefined ? {} : { backupPath }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把账号写进 provider 的 vault（持久化的「当前号」记录；OAuth 登录的账号也住这里）。
 * 用的是账号层同一个文档格式 —— 两处各写一遍 JSON 迟早会漂移。
 */
function writeVault(account: Account): { ok: boolean, error?: string } {
  try {
    const filePath = join(vaultDir(regionOf(account.domain)), `${account.id}.json`)
    writeJsonAtomic(filePath, credentialDocument(account, account.id))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 同步 provider 自己的刷新副本（`auth.<region>.json`）。
 *
 * 不写它切换就是假的：`pickBest()` 按「刷新副本 > 桌面端 > vault」排序，
 * 缓存失效后 resolve 会直接拿旧副本，等于把切换 undo 掉。
 */
function writePluginCopy(account: Account): { ok: boolean, error?: string } {
  try {
    writeJsonAtomic(pluginCopyPath(regionOf(account.domain)), credentialDocument(account, account.id))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// 切换结果
// ---------------------------------------------------------------------------

export interface ActivateResult {
  ok: boolean
  account: Account
  providerId: string
  message: string
  backupPath?: string
  previousUid?: string
}

/** 纯存储层激活：写 vault + 刷新副本 + auth.json。不动 provider 缓存。 */
function activateStorage(account: Account): ActivateResult {
  const providerId = providerIdFor(account)
  const previousUid = activeUidFor(providerId)
  const base = {
    account,
    providerId,
    ...(previousUid === undefined ? {} : { previousUid }),
  }

  const vault = writeVault(account)
  if (!vault.ok) {
    return { ...base, ok: false, message: `写入 vault 失败：${vault.error ?? '未知错误'}（provider 可能仍会用旧账号）` }
  }

  const copy = writePluginCopy(account)
  if (!copy.ok) {
    return { ...base, ok: false, message: `写入 provider 刷新副本失败：${copy.error ?? '未知错误'}（旧副本会 undo 本次切换）` }
  }

  const written = writeAuthSlot(providerId, slotFor(account))
  if (written.error !== undefined) {
    return {
      ...base,
      ok: false,
      ...(written.backupPath === undefined ? {} : { backupPath: written.backupPath }),
      message: `写入 auth.json 失败：${written.error}`,
    }
  }

  return {
    ...base,
    ok: true,
    ...(written.backupPath === undefined ? {} : { backupPath: written.backupPath }),
    message: `已把 ${account.label} 设为 ${providerId} 的当前账号`,
  }
}

/**
 * provider 的凭据解析器句柄。由 index.ts 在注册时塞进来 ——
 * 这里不直接 import provider，避免耦合它的内部路径。
 *
 * 返回 false = 「没能让 provider 丢掉缓存」。
 */
export type CredentialRefresher = (providerId: string, ctx?: unknown) => Promise<boolean>

let refresher: CredentialRefresher | undefined

export function setCredentialRefresher(fn: CredentialRefresher): void {
  refresher = fn
}

/**
 * 完整激活：存储层 + 让 provider 丢缓存。
 *
 * 第三步失败不算切换失败（凭据确实换好了，只是要等 provider 下次自然失效），
 * 但要在消息里说清楚，别让人以为「切了但没生效」是数据问题。
 */
export async function activateAccount(account: Account, ctx?: unknown): Promise<ActivateResult> {
  const result = activateStorage(account)
  if (!result.ok) return result
  if (refresher === undefined) return { ...result, message: `${result.message}。` }

  let invalidated = false
  try {
    invalidated = await refresher(result.providerId, ctx)
  } catch {
    invalidated = false
  }
  return invalidated
    ? { ...result, message: `${result.message}。` }
    : {
        ...result,
        message: `${result.message}；但没能让 provider 丢掉凭据缓存，下一次请求可能仍用旧号 —— 请 /reload 或重启 pi 后再试`,
      }
}

/** 切换成功与否的校验：auth.json 里真的变成这个 uid 了吗。 */
export function verifyActive(account: Account): boolean {
  return activeUidFor(providerIdFor(account)) === account.uid
}
