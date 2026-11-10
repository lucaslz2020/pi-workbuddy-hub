/**
 * 凭据来源：桌面端 App 的 auth 文件（只读）、provider 自己刷新后的副本、OAuth vault。
 *
 * ## 与账号层的关系
 *
 * 「一份 WorkBuddy 凭据是什么样」只有一个定义（`AccountCredential`，见
 * `src/accounts.ts`）；解析器、序列化器、加密字段解密也只有一份。本文件只做
 * provider 独有的两件事：
 *
 *   · 平台差异的**候选路径清单**（桌面端在三个系统上放在不同目录）；
 *   · provider 自己的**每区域一份**刷新副本（`auth.<region>.json`）：它的意义是
 *     「我刷出来的 token 比 App 写的新」，所以排序上必须排在 live 文件之前。
 *
 * ## 实测形态（来自 dsh-connect-workbuddy 的现场取证）
 *
 * · 桌面端 live 文件：`<CodeBuddyExtension>/Data/Public/auth/workbuddy-desktop.info`，
 *   嵌套 `{auth:{accessToken,refreshToken,expiresAt,domain}, account:{uid,...}}`。
 *   同目录下的 timestamped 备份里的 token 已被上游吊销，**只有 live 文件算数**。
 * · 5.6.0+（Windows/macOS）把 `accessToken` / `refreshToken`、`nickname` 加密成
 *   `{"$wbEncrypted":1,"envelope":"…"}`。解密统一在 `src/at-rest.ts`；拿不到密钥
 *   就报「读不了」，绝不给半截明文。
 * · vault 一个账号一个文件，文件名就是账号的稳定 id。
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  accountIdOf,
  accountLabelOf,
  credentialDocument,
  parseCredentialDocument,
  pluginCopyPath,
  workbuddyDataDir,
  type AccountCredential,
} from '../accounts.ts'
import { writeJsonAtomic, writeJsonQuietly } from '../jsonfile.ts'
import { regionOf, type Region } from '../upstream.ts'
import type { AtRestKey } from '../at-rest.ts'

/** provider 视角的凭据：账号凭据 + 来源标记。 */
export interface WorkBuddyCredential extends AccountCredential {
  /** 这份凭据是从哪儿读到的（只用于诊断，绝不打印 token）。 */
  source: 'desktop' | 'plugin' | 'oauth' | 'env'
  /** 来源文件（诊断用；不进日志）。 */
  filePath?: string
}

/** 桌面端 live 文件的名字。 */
const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'

/** 覆盖桌面端 auth 文件位置。 */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 桌面端 auth 文件的平台默认目录。 */
function defaultDesktopAuthDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const tail = ['CodeBuddyExtension', 'Data', 'Public', 'auth']
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', ...tail)]
  if (platform === 'win32') {
    const local = nonEmpty(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmpty(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [join(local, ...tail), join(roaming, ...tail)]
  }
  if (platform === 'linux') {
    const config = nonEmpty(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, ...tail)]
  }
  return []
}

/** live 文件的候选绝对路径清单，按探测顺序。 */
function desktopAuthCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = nonEmpty(env[WORKBUDDY_AUTH_FILE_ENV])
  if (fromEnv !== undefined) return [fromEnv]
  return defaultDesktopAuthDirs(process.platform, homedir(), env).map(dir => join(dir, WORKBUDDY_LIVE_FILENAME))
}

export interface ReadCredentialResult {
  credential?: WorkBuddyCredential
  /** 每个被跳过的候选及其原因（诊断用，不含秘密）。 */
  skipped: Array<{ path: string, reason: string }>
}

/**
 * 从桌面端 auth 目录读**这个区域**当前可用的凭据。桌面端文件是只读的 ——
 * 刷新结果只写进 provider 自己的副本，永不回写 App。
 */
export function readDesktopCredential(
  region: Region,
  key?: AtRestKey,
  env: NodeJS.ProcessEnv = process.env,
): ReadCredentialResult {
  const skipped: ReadCredentialResult['skipped'] = []
  for (const filePath of desktopAuthCandidates(env)) {
    if (!existsSync(filePath)) {
      skipped.push({ path: filePath, reason: '不存在' })
      continue
    }
    let text: string
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (error) {
      skipped.push({ path: filePath, reason: `读不了: ${String(error)}` })
      continue
    }
    const credential = parseCredentialDocument(text, key)
    if (credential === undefined) {
      skipped.push({
        path: filePath,
        reason: text.includes('$wbEncrypted')
          ? '字段已加密且拿不到密钥（需要已安装的 WorkBuddy 桌面端）'
          : '没有可用 token',
      })
      continue
    }
    const credentialRegion = regionOf(credential.domain)
    if (credentialRegion !== region) {
      skipped.push({ path: filePath, reason: `属于另一个地区（${credentialRegion === 'global' ? '国际版' : '国内版'}）` })
      continue
    }
    return { credential: { ...credential, source: 'desktop', filePath }, skipped }
  }
  return { skipped }
}

// ---------------------------------------------------------------------------
// provider 自己的凭据副本 + OAuth vault
// ---------------------------------------------------------------------------

function ownAuthPath(region: Region): string {
  // 路径只有一份定义（accounts.ts），这里只转发
  return pluginCopyPath(region)
}

function vaultDir(region: Region): string {
  return join(workbuddyDataDir(), 'workbuddy-vault', region)
}

/** 凭据 → vault 文档对象（唯一的转换点，与账号层同格式）。 */
function documentOf(credential: AccountCredential): Record<string, unknown> {
  return credentialDocument(credential, accountIdOf(credential))
}

/** 写 provider 的刷新副本。写不进去由调用方的报错体现。 */
export function saveOwnCredential(region: Region, credential: WorkBuddyCredential): void {
  writeJsonQuietly(ownAuthPath(region), documentOf(credential))
}

/** 读 provider 的刷新副本。 */
export function readOwnCredential(region: Region): WorkBuddyCredential | undefined {
  const filePath = ownAuthPath(region)
  if (!existsSync(filePath)) return undefined
  try {
    const credential = parseCredentialDocument(readFileSync(filePath, 'utf8'))
    return credential === undefined ? undefined : { ...credential, source: 'plugin', filePath }
  } catch {
    return undefined
  }
}

/** 某个区域 vault 里的全部账号，按账号 id 索引。 */
export function readVaultAccounts(region: Region): Map<string, WorkBuddyCredential> {
  const accounts = new Map<string, WorkBuddyCredential>()
  const dir = vaultDir(region)
  if (!existsSync(dir)) return accounts
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return accounts
  }
  for (const fileName of entries) {
    if (!fileName.endsWith('.json')) continue
    const filePath = join(dir, fileName)
    try {
      const credential = parseCredentialDocument(readFileSync(filePath, 'utf8'))
      if (credential !== undefined) accounts.set(accountIdOf(credential), { ...credential, source: 'oauth', filePath })
    } catch {
      // 一个坏文件不该挡住整批
    }
  }
  return accounts
}

/**
 * 把一个 OAuth 登录来的账号写进 vault，返回账号 id。
 * 写失败直接抛（登录态丢了必须让人知道，调用方负责接住并记日志）。
 */
export function saveVaultAccount(region: Region, credential: WorkBuddyCredential): string {
  const id = accountIdOf(credential)
  writeJsonAtomic(join(vaultDir(region), `${id}.json`), documentOf(credential))
  return id
}

/** 删掉 vault 里的一个账号；返回是否真的删了。 */
export function deleteVaultAccount(region: Region, accountId: string): boolean {
  const filePath = join(vaultDir(region), `${accountId}.json`)
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

export { accountLabelOf }
export type { AccountCredential }
