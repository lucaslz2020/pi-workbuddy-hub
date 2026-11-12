/**
 * 账号池：读所有来源的账号，写回原处，记每日签到结论。
 *
 * ## 账号从哪来
 *
 * | 来源 | 位置 | 谁写 | 我们能写吗 |
 * |---|---|---|---|
 * | `vault` | `<workbuddy>/workbuddy-vault/<region>/<id>.json` | provider 扫码登录 | 能（刷新 token 时原地更新） |
 * | `book` | `<workbuddy>/multi/<id>.json` | 本包：桌面端导入 / 手贴 token | 能 |
 * | 桌面端镜像 | `<CodeBuddyExtension>/…/workbuddy-desktop.info` | 桌面端 App | **只读**，永不回写 |
 *
 * 三条来源都是同一个文档格式（嵌套 `{format, accountId, auth, account}` 或扁平形态），
 * 所以只有一个解析器、一个序列化器。accountId 用 `sha256(uin||uid)` 前 16 位，
 * 与 provider 完全一致 —— 同一个账号从三个来源读进来会自然合并，不会签三次。
 *
 * ## 为什么绝不复用 provider 的 `auth.<region>.json`
 *
 * 那是「当前生效凭据」的单槽位。多个账号轮流刷新会互相覆盖，直接导致签到串号。
 * 账号池只读写 vault / 账号簿 / 桌面端。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJsonObject, writeJsonAtomic, writeJsonQuietly } from './jsonfile.ts'
import { optional } from './fields.ts'
import {
  cachedAtRestKey,
  containsEncryptedField,
  ensureAtRestKey,
  keyMatchesDevice,
  readField,
  type AtRestKey,
} from './at-rest.ts'
import { regionOf, type Region } from './upstream.ts'

/** 一个账号完整的可用凭据（与 provider 的 `WorkBuddyCredential` 结构兼容）。 */
export interface AccountCredential {
  accessToken: string
  refreshToken: string
  /** 绝对时间戳；0 表示上游没给到期时间。 */
  expiresAtMs: number
  domain: string
  uid: string
  uin?: string
  enterpriseId?: string
  nickname?: string
  displayName?: string
}

/**
 * 账号来源，决定写回哪里、什么时候可以覆盖。
 *
 * - `vault`：provider 扫码登录的（OAuth），pickBest 里排第二，仅次于刷新副本；
 * - `book`：本包自己录的（桌面端导入/手贴/刷新后的新 token 都落这里）；
 * - `desktop`：桌面端 live 文件的只读镜像 —— 展示用，不可删、不可改。
 *
 * 写回映射：`vault` → vault，`book`/`desktop` → 账号簿。桌面端镜像刷新出新 token
 * 后落到账号簿（`source` 还是 `desktop`，文件已经是我们的拷贝了），桌面端原文件
 * 永不回写。
 */
export type AccountSource = 'vault' | 'book' | 'desktop'

export interface Account extends AccountCredential {
  /** 稳定 id：sha256(uin||uid) 前 16 位。 */
  id: string
  region: Region
  source: AccountSource
  /** 人类可读标签（昵称优先）。 */
  label: string
  /** 来源文件，排障用；不含 token。 */
  filePath: string
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

/** pi 的 agent 目录；`PI_CODING_AGENT_DIR` 覆盖。 */
export function piAgentDir(): string {
  const override = process.env['PI_CODING_AGENT_DIR']
  if (override !== undefined && override.trim() !== '') return override.trim()
  return join(process.env['HOME'] ?? homedir(), '.pi', 'agent')
}

/** 与 provider 共用的数据根。 */
export function workbuddyDataDir(): string {
  const override = process.env['WORKBUDDY_PLUGIN_DATA_DIR']
  if (override !== undefined && override.trim() !== '') return override.trim()
  return join(piAgentDir(), 'workbuddy')
}

/** vault 目录（provider 扫码登录的账号）。 */
export function vaultDir(region: Region): string {
  return join(workbuddyDataDir(), 'workbuddy-vault', region)
}

/**
 * provider 自己的刷新副本路径（`auth.<region>.json`）。
 *
 * pickBest 按「刷新副本 > 桌面端 > vault」排序，所以切号时必须同步写这份，
 * 否则旧副本复活、把刚写好的切换 undo 掉。provider 侧复用同一函数，路径不会漂。
 */
export function pluginCopyPath(region: Region): string {
  const override = process.env['WORKBUDDY_PLUGIN_AUTH_FILE']
  if (override !== undefined && override.trim() !== '') return override.trim()
  return join(workbuddyDataDir(), `auth.${region}.json`)
}

/** 账号簿目录（本包自己录的账号）。 */
function bookDir(): string {
  return join(workbuddyDataDir(), 'multi')
}

const REGIONS: readonly Region[] = ['cn', 'global']

// ---------------------------------------------------------------------------
// 身份
// ---------------------------------------------------------------------------

function identityBasis(credential: Pick<AccountCredential, 'uin' | 'uid'>): string {
  return credential.uin !== undefined && credential.uin !== '' ? credential.uin : credential.uid
}

/**
 * 这份凭据有没有稳定身份。空身份的 sha256 全是 `e3b0c44…` —— 两个没 uid/uin 的
 * 裸 token 会算出同一个 id，后存的静默覆盖先存的，所以调用方必须先查这个再存。
 */
export function hasStableIdentity(credential: Pick<AccountCredential, 'uin' | 'uid'>): boolean {
  return identityBasis(credential) !== ''
}

export function accountIdOf(credential: Pick<AccountCredential, 'uin' | 'uid'>): string {
  return createHash('sha256').update(identityBasis(credential)).digest('hex').slice(0, 16)
}

export function accountLabelOf(credential: Pick<AccountCredential, 'nickname' | 'displayName' | 'uin' | 'uid'>): string {
  const nickname = credential.nickname ?? credential.displayName
  if (nickname !== undefined && nickname.trim() !== '') return nickname.trim()
  const basis = identityBasis(credential)
  if (basis === '') return '(unknown)'
  return basis.length <= 4 ? basis : `${basis.slice(0, 2)}***${basis.slice(-2)}`
}

// ---------------------------------------------------------------------------
// 文档 ↔ 凭据
// ---------------------------------------------------------------------------

/**
 * 解析一份凭据文档。两种形态都吃：
 *   - 嵌套 `{auth:{...}, account:{...}}`（vault / provider / 桌面端）
 *   - 扁平 `{accessToken, uid, ...}`（面板形态、手贴 token）
 *
 * 拿不到 accessToken 就返回 undefined（「读不了」），绝不猜。
 * `key` 是 at-rest 密钥：加密字段有密钥就解，没密钥就当「读不了」。
 */
export function parseCredentialDocument(text: string, key?: AtRestKey): AccountCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const doc = parsed as Record<string, unknown>
  const nested = typeof doc['auth'] === 'object' && doc['auth'] !== null && !Array.isArray(doc['auth'])
  const auth = nested ? (doc['auth'] as Record<string, unknown>) : doc
  const identity = nested && typeof doc['account'] === 'object' && doc['account'] !== null
    ? (doc['account'] as Record<string, unknown>)
    : doc

  const accessToken = readField(auth['accessToken'], key)
  if (accessToken === undefined) return undefined
  const expiresAt = typeof auth['expiresAt'] === 'number' ? auth['expiresAt'] : 0
  return {
    accessToken,
    refreshToken: readField(auth['refreshToken'], key) ?? '',
    expiresAtMs: expiresAt > 1e12 ? expiresAt : expiresAt > 0 ? expiresAt * 1000 : 0,
    domain: readField(auth['domain'], key) ?? '',
    uid: readField(identity['uid'], key) ?? '',
    ...optional('uin', readField(identity['uin'], key)),
    ...optional('enterpriseId', readField(identity['enterpriseId'], key)),
    ...optional('nickname', readField(identity['nickname'], key)),
    ...optional('displayName', readField(identity['displayName'], key)),
  }
}

/**
 * 文档内容：vault 认的嵌套形态（provider 可继续读）。
 * `expiresAt` 一律写毫秒 —— 与 provider 自己写的一致。
 */
export function credentialDocument(credential: AccountCredential, id: string): Record<string, unknown> {
  return {
    format: 1,
    accountId: id,
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAtMs,
      domain: credential.domain,
    },
    account: {
      uid: credential.uid,
      ...optional('uin', credential.uin),
      ...optional('enterpriseId', credential.enterpriseId),
      ...optional('nickname', credential.nickname),
      ...optional('displayName', credential.displayName),
    },
  }
}

/** 读一份账号文件；读不了就 undefined。 */
function readCredentialFile(filePath: string, key?: AtRestKey): AccountCredential | undefined {
  try {
    return parseCredentialDocument(readFileSync(filePath, 'utf8'), key)
  } catch {
    return undefined
  }
}

function accountFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

function makeAccount(credential: AccountCredential, source: AccountSource, filePath: string): Account {
  return {
    ...credential,
    id: accountIdOf(credential),
    region: regionOf(credential.domain),
    source,
    label: accountLabelOf(credential),
    filePath,
  }
}

function readAccountsFrom(dir: string, source: AccountSource, key?: AtRestKey): Account[] {
  const out: Account[] = []
  for (const name of accountFiles(dir)) {
    const filePath = join(dir, name)
    const credential = readCredentialFile(filePath, key)
    // 读不了就跳过，别让一个坏文件拖垮整批
    if (credential !== undefined) out.push(makeAccount(credential, source, filePath))
  }
  return out
}

/** vault 里的全部账号（provider 扫码登录过的）。 */
function readVaultAccounts(key?: AtRestKey): Account[] {
  return REGIONS.flatMap(region => readAccountsFrom(vaultDir(region), 'vault', key))
}

/** 账号簿里的全部账号（桌面端登录导入 / 手贴 token）。 */
function readBookAccounts(): Account[] {
  return readAccountsFrom(bookDir(), 'book')
}

/** 桌面端 live 文件路径（平台相关，内部用）。 */
function desktopAuthPath(): string {
  const override = process.env['WORKBUDDY_AUTH_FILE']
  if (override !== undefined && override.trim() !== '') return override.trim()
  const home = process.env['HOME'] ?? homedir()
  const relative = ['CodeBuddyExtension', 'Data', 'Public', 'auth']
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    return join(local, ...relative, 'workbuddy-desktop.info')
  }
  if (process.platform === 'linux') {
    const config = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
    return join(config, ...relative, 'workbuddy-desktop.info')
  }
  return join(home, 'Library', 'Application Support', ...relative, 'workbuddy-desktop.info')
}

export interface DesktopReadResult {
  account?: Account
  /** 为什么读不到（给人看，不含 token）。 */
  reason?: string
  /** 文件存在且含加密字段，但本机没有 at-rest 密钥。 */
  encrypted?: boolean
}

/**
 * 桌面端当前登录。平台路径与 provider 一致。
 * 加密字段（Windows/macOS 5.6.0+）解不了就明确报「读不了」，而不是装作未登录。
 */
export function readDesktopAccount(key: AtRestKey | undefined = cachedAtRestKey()): DesktopReadResult {
  const filePath = desktopAuthPath()
  if (!existsSync(filePath)) return { reason: `未安装/未登录桌面端（不存在 ${filePath}）` }

  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return { reason: `读不了桌面端凭据（${filePath}）：macOS 隐私保护或权限不足（TCC）` }
  }

  const encrypted = containsEncryptedField(text)
  if (encrypted && key === undefined) {
    return {
      encrypted: true,
      reason: '桌面端凭据已加密，本机还没有 at-rest 密钥。\n'
        + '    取密钥（一次性，需 Node ≥ 21）：node bin/extract-at-rest-key.mjs\n'
        + '    或直接 /wb add 粘贴明文 token',
    }
  }
  if (encrypted && key !== undefined && keyMatchesDevice(key.key) === false) {
    return {
      encrypted: true,
      reason: '桌面端凭据已加密，但本机密钥与 ~/.workbuddy/keyblob 不匹配'
        + '（客户端重装过？）。请重新提取：node bin/extract-at-rest-key.mjs',
    }
  }

  const credential = parseCredentialDocument(text, key)
  if (credential === undefined) {
    return {
      encrypted,
      reason: encrypted ? '桌面端凭据已加密，但用本机密钥解不开' : '桌面端凭据里没有可用 accessToken',
    }
  }
  return { account: makeAccount(credential, 'desktop', filePath) }
}

/** 按 id / uid / uin / 昵称在一个列表里找账号（命令层用）。 */
export function findAccounts(accounts: readonly Account[], target: string): Account[] {
  const wanted = target.trim()
  if (wanted === '') return []
  return accounts.filter(a =>
    a.id === wanted || a.uid === wanted || (a.uin ?? '') === wanted || a.label.includes(wanted))
}

/** 来源优先级：账号簿（用户显式录入/刷新过，最新）> vault > 桌面端镜像。 */
const SOURCE_RANK: Record<AccountSource, number> = { book: 2, vault: 1, desktop: 0 }

/**
 * 同一个人只留一条：`uid` 相同就是同一个号。
 *
 * 光按 `id` 去重不够 —— id 的口径是 `uin||uid`，同一个号从「只有 uid」的登录态
 * 变成「带 uin」的登录态就会算成两个 id（`/wb status` 里两行一模一样的昵称与说明，
 * 定时签到在两个 id 上各记一条）。所以先按 id 去重，再按「区域 + uid」合并，
 * 留下 token 最新、来源更可信的那条（id 也跟着它走，切号/写回才不会落到旧文件上）。
 */
function mergeSameAccount(accounts: readonly Account[]): Account[] {
  const byUid = new Map<string, Account>()
  const anonymous: Account[] = []
  for (const account of accounts) {
    const uid = account.uid.trim()
    if (uid === '') {
      anonymous.push(account)
      continue
    }
    const key = `${account.region}|${uid}`
    const existing = byUid.get(key)
    if (existing === undefined || preferredOver(account, existing)) byUid.set(key, account)
  }
  return [...anonymous, ...byUid.values()]
}

function preferredOver(candidate: Account, incumbent: Account): boolean {
  const rank = SOURCE_RANK[candidate.source] - SOURCE_RANK[incumbent.source]
  if (rank !== 0) return rank > 0
  if (candidate.expiresAtMs !== incumbent.expiresAtMs) return candidate.expiresAtMs > incumbent.expiresAtMs
  // 同一份 token 的两个副本：带 uin 的那条信息更全，id 也更稳
  return (candidate.uin ?? '') !== '' && (incumbent.uin ?? '') === ''
}

/**
 * 全部账号，按 `id` 去重，再按 `uid` 合并同一个号的重复记录。
 *
 * 优先级：账号簿 > vault > 桌面端镜像（桌面端排最后，因为它是只读镜像，token 可能更旧）。
 */
export function listAccounts(): Account[] {
  const key = cachedAtRestKey()
  const byId = new Map<string, Account>()
  for (const account of [...readBookAccounts(), ...readVaultAccounts(key)]) {
    const existing = byId.get(account.id)
    if (existing === undefined || (account.source === 'book' && existing.source === 'vault')) {
      byId.set(account.id, account)
    }
  }
  const desktop = readDesktopAccount(key).account
  if (desktop !== undefined && !byId.has(desktop.id)) byId.set(desktop.id, desktop)
  return mergeSameAccount([...byId.values()]).sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

/**
 * 启动/命令入口处调用一次：把 at-rest 密钥准备好，让随后的同步 `listAccounts()`
 * 能读到加密来源的账号。
 */
export async function prepareAccounts(): Promise<void> {
  await ensureAtRestKey()
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

function saveCredentialTo(dir: string, credential: AccountCredential): string {
  const id = accountIdOf(credential)
  // 写失败直接抛：调用方（/wb add、切号）必须如实告诉人，而不能报假成功
  writeJsonAtomic(join(dir, `${id}.json`), credentialDocument(credential, id))
  return id
}

/** 写进 vault —— 只在账号本来就来自 vault 时用，保持 provider 可读。 */
export function saveVaultAccount(credential: AccountCredential): string {
  return saveCredentialTo(vaultDir(regionOf(credential.domain)), credential)
}

/** 写进账号簿（桌面端 token、手贴 token、刷新后的新 token）。 */
export function saveBookAccount(credential: AccountCredential): string {
  return saveCredentialTo(bookDir(), credential)
}

/**
 * 按账号原来的来源写回：来源影响 provider 能否继续用这个 token。
 * `desktop` 镜像刷新出的新 token 落到账号簿（桌面端原文件永不回写）。
 */
export function saveAccount(credential: AccountCredential, source: AccountSource): string {
  return source === 'vault' ? saveVaultAccount(credential) : saveBookAccount(credential)
}

/** 删除账号簿里的一个账号（vault 与桌面端不动）。 */
export function removeBookAccount(id: string): boolean {
  const filePath = join(bookDir(), `${id}.json`)
  if (!existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 签到记录（与 provider 同一个文件，双方互认）
// ---------------------------------------------------------------------------

export type CheckinOutcome =
  | 'claimed'    // 本次领到了
  | 'done'       // 今天已经领过
  | 'inactive'   // 活动未开启/已结束
  | 'ineligible' // 该账号不能参与
  | 'expired'    // 登录态失效，需要重新登录
  | 'failed'     // 其它失败

export interface DayRecord {
  /** 北京日 `YYYY-MM-DD`。 */
  day: string
  /** 结论产生时刻。 */
  at: number
  outcome: CheckinOutcome
  credit?: number
  streakDays?: number
  message?: string
}

type RecordFile = Record<string, DayRecord>

function recordPath(): string {
  return join(workbuddyDataDir(), 'workbuddy-checkin.json')
}

/** 记录键与 provider 一致：`<region>|<accountId>`。 */
export function recordKey(region: Region, id: string): string {
  return `${region}|${id}`
}

export function readRecords(): RecordFile {
  return readJsonObject<RecordFile>(recordPath())
}

export function saveRecord(region: Region, id: string, record: DayRecord): void {
  const file = readRecords()
  file[recordKey(region, id)] = record
  // 只读数据目录只影响下次离线展示，绝不让签到本身失败
  writeJsonQuietly(recordPath(), file)
}
