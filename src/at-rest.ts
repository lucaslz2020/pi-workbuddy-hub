/**
 * 桌面端 at-rest 加密字段的解密，以及**密钥从哪来**。
 *
 * ## 加密长什么样
 *
 * WorkBuddy 桌面端 5.6.0+ 把 `workbuddy-desktop.info` 里的
 * `accessToken` / `refreshToken` / `nickname` 存成外壳：
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64(JSON)>" }
 *   envelope = { suite:1, keyId:<16 hex>, nonce:<b64>, authTag:<b64>, ciphertext:<b64> }
 *
 *   key       = SHA-256(utf8(atRestSecretKey))        ← 32 字节 AES key
 *   keyId     = SHA-256(key).hex[..16]                ← 校验「这是不是本机的密钥」
 *   plaintext = AES-256-GCM(key, nonce, aad, tag)
 *   AAD       = "WB-AAD\0" + 0x01
 *             + len32("WBEV1") + "WBEV1"            // 字段级帧
 *             + len32("sym-v1") + "sym-v1"
 *             + u32be(1)                             // suite
 *             + len32(keyId) + keyId
 *             + [0x02, 0x00, 0x00]                   // 帧码 / sequence / final 均无
 *
 * **AAD 是最容易漏的一环**：key 对了、nonce/tag 都对了，缺 AAD 一样
 * `bad decrypt`。所以这里按字节重建，并且 field / file 两种帧都试一遍。
 *
 * ## 密钥从哪来（按优先级，取到即止）
 *
 * 1. **桌面端自己**：以 `ELECTRON_RUN_AS_NODE=1` 跑一次 App 可执行文件，
 *    调它原生模块的 `loggerGet()` 拿 `atRestSecretKey`。全自动，不用人干预。
 * 2. `WORKBUDDY_AT_REST_KEY` 环境变量（一次性提取脚本 `bin/extract-at-rest-key.mjs`
 *    的输出可以直接放这里）。
 * 3. `~/.workbuddy-account-hub/at-rest-key` / `~/.workbuddy/at-rest-key` 文件。
 *
 * 三条路都拿到的是**同一个 base64 字符串**，派生方式完全一样。取不到就返回
 * undefined，上层报「已加密、缺密钥」——绝不猜：把外壳当明文会让 token 变成
 * 必 401 的坏值，最后伪装成「登录态失效」。
 *
 * ## 为什么合并成一个模块
 *
 * 本包曾经有两份实现：账号层用「环境变量/文件里的密钥」解密，内置 provider
 * 用「问 App 要密钥」解密。算法是同一套，密钥来源不同，于是两份代码各自演进、
 * 各自有 bug 的窗口。现在只有一份，两条来源都试。
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 外壳识别
// ---------------------------------------------------------------------------

/** 加密字段的外壳形状。 */
export interface EncryptedField {
  $wbEncrypted: number
  envelope: string
}

function isEncryptedField(value: unknown): value is EncryptedField {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapper = value as Record<string, unknown>
  return wrapper['$wbEncrypted'] === 1 && typeof wrapper['envelope'] === 'string'
}

/** 只看文件里有没有加密字段（不需要密钥），用于给出准确提示。 */
export function containsEncryptedField(text: string): boolean {
  return text.includes('$wbEncrypted')
}

// ---------------------------------------------------------------------------
// 密钥
// ---------------------------------------------------------------------------

/** 派生 32 字节 AES key：SHA-256(utf8(secret))。 */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** keyId：派生 key 的 SHA-256 前 16 个 hex 字符。 */
function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** 环境变量覆盖入口（与 `bin/extract-at-rest-key.mjs` 的产物同格式）。 */
const AT_REST_KEY_ENV = 'WORKBUDDY_AT_REST_KEY'

/** 一次性提取脚本写这些路径，按优先级读。 */
function atRestKeyPaths(): string[] {
  const home = process.env['HOME'] ?? homedir()
  return [
    join(home, '.workbuddy-account-hub', 'at-rest-key'),
    join(home, '.workbuddy', 'at-rest-key'),
  ]
}

/** 一个已就绪的密钥，带上它从哪来（排障用，不含密钥本身）。 */
export interface AtRestKey {
  key: Buffer
  /** `app` = 问桌面端要的；`env` / `file` = 人给的。 */
  origin: 'app' | 'env' | 'file'
  secret: string
}

function fromEnvOrFile(): AtRestKey | undefined {
  const fromEnv = process.env[AT_REST_KEY_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const secret = fromEnv.trim()
    return { key: deriveKey(secret), origin: 'env', secret }
  }
  for (const path of atRestKeyPaths()) {
    if (!existsSync(path)) continue
    try {
      const secret = readFileSync(path, 'utf8').trim()
      if (secret !== '') return { key: deriveKey(secret), origin: 'file', secret }
    } catch {
      // 权限不足就试下一个
    }
  }
  return undefined
}

/** 密钥与本机 keyblob 是否匹配（不匹配说明客户端重装过，解出来的必是垃圾）。 */
export function keyMatchesDevice(key: Buffer): boolean | undefined {
  const home = process.env['HOME'] ?? homedir()
  try {
    const blob = JSON.parse(readFileSync(join(home, '.workbuddy', 'keyblob'), 'utf8')) as Record<string, unknown>
    const slots = blob['slots']
    if (!Array.isArray(slots) || slots.length === 0) return undefined
    const slot = slots[0] as Record<string, unknown>
    const want = typeof slot['protectorKeyId'] === 'string' ? slot['protectorKeyId'] : undefined
    if (want === undefined) return undefined
    return keyIdOf(key) === want
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 问桌面端要密钥
// ---------------------------------------------------------------------------

/** 环境变量：指向 WorkBuddy 桌面端可执行文件。 */
const APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

const KEY_FETCH_TIMEOUT_MS = 10_000

/** Windows 上可执行文件的名字。 */
const APP_EXECUTABLE_NAMES: readonly string[] = ['WorkBuddy.exe', 'WorkBuddyAI.exe']

/** Windows 安装目录（相对 %LOCALAPPDATA% / ProgramFiles）。 */
const WINDOWS_APP_SUBDIRECTORIES: readonly (readonly string[])[] = [
  ['Programs', 'WorkBuddy'],
  ['WorkBuddy'],
  ['Programs', 'WorkBuddyAI'],
  ['WorkBuddyAI'],
]

/** macOS 上可能的 App bundle 名。 */
const MACOS_APP_BUNDLE_NAMES: readonly string[] = ['WorkBuddy.app', 'WorkBuddy AI.app']

/** App bundle 的 Info.plist 里声明的可执行文件。 */
function macosBundleExecutable(bundle: string): string | undefined {
  let plist: string
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return undefined
  }
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1]?.trim()
  if (name === undefined || name === '') return undefined
  const executable = join(bundle, 'Contents', 'MacOS', name)
  return existsSync(executable) ? executable : undefined
}

/** 桌面端可执行文件的候选路径，按探测顺序。 */
function appExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: (string | undefined)[] = [env[APP_EXECUTABLE_ENV]?.trim()]
  if (platform === 'win32') {
    const bases = [env['LOCALAPPDATA']?.trim(), env['ProgramFiles']?.trim(), env['ProgramFiles(x86)']?.trim()]
      .filter((base): base is string => base !== undefined && base !== '')
    for (const base of bases) {
      for (const subdirectory of WINDOWS_APP_SUBDIRECTORIES) {
        for (const name of APP_EXECUTABLE_NAMES) {
          // 这些是 Windows 路径，不能用宿主的 path.join（它跟随运行平台）
          candidates.push(`${base}\\${[...subdirectory, name].join('\\')}`)
        }
      }
    }
  } else if (platform === 'darwin') {
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      candidates.push(
        macosBundleExecutable(join('/Applications', name)),
        macosBundleExecutable(join(home, 'Applications', name)),
      )
    }
  }
  return candidates.filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
}

/** 第一个真实存在的候选。 */
function findAppExecutable(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const candidate of appExecutableCandidates(platform, home, env)) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 以纯 Node 模式跑一次 App，让它把密钥 payload 打到 stdout。 */
function fetchKeyPayload(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + 'catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}'
    execFile(
      executable,
      ['-e', source],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`WorkBuddy 桌面端没有给出 at-rest 密钥（${stderr.trim() || error.message}）`))
          return
        }
        const payload = stdout.trim()
        if (payload === '') {
          reject(new Error('WorkBuddy 桌面端返回了空的 at-rest 密钥 payload'))
          return
        }
        resolve(payload)
      },
    )
  })
}

/** payload 是 `{ atRestSecretKey: "<base64>" }`（可能被再包一层字符串）。 */
function secretFromPayload(payloadJson: string): string {
  let payload: unknown = JSON.parse(payloadJson)
  if (typeof payload === 'string') payload = JSON.parse(payload)
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('WorkBuddy: at-rest 密钥 payload 不是对象')
  }
  const secret = (payload as Record<string, unknown>)['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('WorkBuddy: at-rest 密钥 payload 里没有 atRestSecretKey')
  }
  return secret
}

async function fromDesktopApp(): Promise<AtRestKey | undefined> {
  const executable = findAppExecutable()
  if (executable === undefined) return undefined
  const secret = secretFromPayload(await fetchKeyPayload(executable))
  return { key: deriveKey(secret), origin: 'app', secret }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

/** 失败也要记住，否则每次列账号都会去 spawn 一次桌面端。 */
const FAILURE_TTL_MS = 60_000

let cached: AtRestKey | undefined
let inflight: Promise<AtRestKey | undefined> | undefined
let failedAtMs = 0

/**
 * 同步拿「已经就绪的密钥」。
 *
 * 给 `listAccounts()` 这类同步路径用：密钥还没探过就是 undefined（此时报
 * 「已加密、缺密钥」是**正确**的），调用方在启动时先 `await ensureAtRestKey()`。
 */
export function cachedAtRestKey(): AtRestKey | undefined {
  return cached
}

/**
 * 确保密钥就绪（必要时 spawn 一次桌面端）。幂等；失败按 TTL 记住，
 * 不会每次调用都去开 App。
 */
export function ensureAtRestKey(): Promise<AtRestKey | undefined> {
  if (cached !== undefined) return Promise.resolve(cached)
  if (inflight !== undefined) return inflight
  if (failedAtMs !== 0 && Date.now() - failedAtMs < FAILURE_TTL_MS) return Promise.resolve(undefined)

  inflight = (async (): Promise<AtRestKey | undefined> => {
    const explicit = fromEnvOrFile()
    if (explicit !== undefined) return explicit
    try {
      return await fromDesktopApp()
    } catch {
      // 没装/装的是老版本/原生模块变了：都算「拿不到」，由上层给可操作提示
      return undefined
    }
  })().then((resolved) => {
    cached = resolved
    failedAtMs = resolved === undefined ? Date.now() : 0
    return resolved
  }).finally(() => {
    inflight = undefined
  })
  return inflight
}

/** 给人看的密钥状态 —— 不含密钥本身。 */
export function describeAtRestKey(): string {
  if (cached === undefined) {
    return '未提取（桌面端凭据若为明文则不需要）'
  }
  const origin = cached.origin === 'app' ? '读自桌面端' : cached.origin === 'env' ? `环境变量 ${AT_REST_KEY_ENV}` : '密钥文件'
  const matches = keyMatchesDevice(cached.key)
  const verdict = matches === true ? '与本机匹配' : matches === false ? '与本机不匹配' : '本机未知'
  return `已就绪（${origin}，${verdict}）`
}

// ---------------------------------------------------------------------------
// 解密
// ---------------------------------------------------------------------------

/** AAD 里 u32be 长度前缀 + 字节串。 */
function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

/** 帧类型 → AAD 里的标识与帧码。 */
const FRAMING: Readonly<Record<'field' | 'file', { id: string, code: number }>> = {
  field: { id: 'WBEV1', code: 0x02 },
  file: { id: 'WBEF1', code: 0x01 },
}

/** 构造 AAD：字段级与整文件级只差帧标识和帧码。 */
function buildAad(keyId: string, framing: 'field' | 'file'): Buffer {
  const frame = FRAMING[framing]
  const suite = Buffer.allocUnsafe(4)
  suite.writeUInt32BE(1, 0)
  const head: Buffer[] = [
    Buffer.from('WB-AAD\0', 'latin1'),
    Buffer.from([0x01]),
    lengthPrefixed(frame.id),
    lengthPrefixed('sym-v1'),
    suite,
    lengthPrefixed(keyId),
  ]
  return Buffer.concat([...head, Buffer.from([frame.code, 0x00, 0x00])])
}

interface Envelope {
  suite: number
  keyId: string
  nonce: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/** 解析 envelope；形状不对返回 undefined（绝不半懂半猜）。 */
function parseEnvelope(field: EncryptedField): Envelope | undefined {
  let json = field.envelope
  try {
    const decoded = Buffer.from(field.envelope, 'base64').toString('utf8')
    if (decoded.trimStart().startsWith('{')) json = decoded
  } catch {
    // envelope 本来就是 JSON 字符串的形态
  }
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    raw = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof raw['nonce'] !== 'string'
    || typeof raw['authTag'] !== 'string'
    || typeof raw['ciphertext'] !== 'string') return undefined

  let ciphertext = Buffer.from(raw['ciphertext'], 'base64')
  // 密文可能带 6 字节 WBE 帧前缀（"WBEV1\n" / "WBEF1 "），去掉
  if (ciphertext.length > 6 && ciphertext.subarray(0, 3).toString('latin1') === 'WBE') {
    ciphertext = ciphertext.subarray(6)
  }
  return {
    suite: typeof raw['suite'] === 'number' ? raw['suite'] : 1,
    keyId: typeof raw['keyId'] === 'string' ? raw['keyId'] : '',
    nonce: Buffer.from(raw['nonce'], 'base64'),
    authTag: Buffer.from(raw['authTag'], 'base64'),
    ciphertext,
  }
}

/**
 * 解一个加密字段。失败返回 undefined —— 「读不了」是一种结论，不是半截明文。
 *
 * 先用 envelope 声明的 keyId；没声明就用这把 key 自己的 keyId。然后 field / file
 * 两种帧各试一次（GCM 认证失败即密钥或帧不对，换下一个）。
 */
function openEncryptedField(field: EncryptedField, key: Buffer): string | undefined {
  const envelope = parseEnvelope(field)
  if (envelope === undefined) return undefined
  // suite 1 = AES-256-GCM；出现别的值说明上游换了算法，宁可报「读不了」
  if (envelope.suite !== 1) return undefined
  if (envelope.nonce.length !== 12 || envelope.authTag.length !== 16) return undefined

  const keyId = envelope.keyId === '' ? keyIdOf(key) : envelope.keyId
  for (const framing of ['field', 'file'] as const) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce)
      decipher.setAAD(buildAad(keyId, framing))
      decipher.setAuthTag(envelope.authTag)
      const plain = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
      return plain.toString('utf8')
    } catch {
      // 认证失败：密钥不对 / 帧类型不对 / 数据被改过
    }
  }
  return undefined
}

/**
 * 把一个「可能是字符串、也可能是加密外壳」的字段读成明文。
 * 没有密钥时加密字段一律 undefined（调用方必须自己决定怎么报）。
 */
export function readField(value: unknown, key: AtRestKey | Buffer | undefined): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (!isEncryptedField(value)) return undefined
  if (key === undefined) return undefined
  return openEncryptedField(value, Buffer.isBuffer(key) ? key : key.key)
}

