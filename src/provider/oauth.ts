/**
 * OAuth 扫码登录：不装桌面端也能加账号。
 *
 * 流程（对上游 cockpit 实测）：
 *   1. POST `{base}/v2/plugin/auth/state?platform=workbuddy` → `{state, authUrl}`；
 *   2. 用户在浏览器打开授权链接并登录；
 *   3. 轮询 GET `{base}/v2/plugin/auth/token?state={state}` 直到带 token；
 *   4. GET `{base}/v2/plugin/login/account` 取资料（只是展示信息，拿不到**不能**让
 *      一个已经拿到 token 的登录失败）。
 *
 * 登录会话绑定到「区域 + 基址」，只活在进程内存里：重启即作废。国际版两个品牌域
 * （`workbuddy.ai` / `codebuddy.ai`）都能登录，但一个域签发的 token 会被另一个域
 * 拒绝，所以选域发生在**签发 state 之前**。
 */

import { randomUUID } from 'node:crypto'
import { CN_BILLING_BASE, GLOBAL_BASE, regionOf } from '../upstream.ts'
import { envelopeData, expiryToMs, intOf } from '../fields.ts'
import { isPlainObject } from '../jsonfile.ts'
import type { Region } from '../upstream.ts'

const API_PREFIX = '/v2/plugin'

export const OAUTH_LOGIN_TIMEOUT_SECONDS = 600

const REQUEST_TIMEOUT_MS = 30_000

/** 一次登录成功后的凭据形状。 */
export interface WorkBuddyOAuthSuccess {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  domain: string
  uid: string
  nickname?: string
  uin?: string
  enterpriseId?: string
}

export type WorkBuddyOAuthPollResult =
  | { done: false }
  | { done: true, account: WorkBuddyOAuthSuccess }
  | { done: true, error: string }

/** 某个区域的登录应从哪个基址开始。 */
function oauthBillingBase(region: Region, explicitBase?: string): string {
  if (region === 'cn') return CN_BILLING_BASE
  const trimmed = explicitBase?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed.replace(/\/+$/, '') : GLOBAL_BASE
}

interface LoginSession {
  region: Region
  base: string
  state: string
  expiresAtMs: number
  done: boolean
  result?: WorkBuddyOAuthSuccess
  error?: string
}

const sessions = new Map<string, LoginSession>()

/** 读一个 JSON 对象；不是对象/解析失败都返回 undefined（调用方按「还没好」处理）。 */
async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await response.text())
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 上游把字段名在 camelCase / PascalCase / snake_case 之间换着写，逐个试。 */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function optionalString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = firstString(source, keys)
  return value === '' ? undefined : value
}

function optionalField(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value }
}

/**
 * 启动一次登录：向上游要 state，返回让用户打开的 URL。
 * 上游拒绝**不抛**，作为 `error` 返回（调用方直接展示）。
 */
export async function oauthStart(
  region: Region,
  options?: { base?: string },
): Promise<{ loginId: string, verificationUri: string, expiresIn: number } | { error: string }> {
  const base = oauthBillingBase(region, options?.base)
  let response: Response
  try {
    response = await fetch(`${base}${API_PREFIX}/auth/state?platform=workbuddy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { error: `连不上 ${base}，无法开始登录（${error instanceof Error ? error.message : String(error)}）` }
  }
  const document = await readJson(response)
  if (document === undefined) {
    return { error: `登录服务返回了非 JSON（http ${response.status}）` }
  }
  const data = envelopeData(document)
  const state = firstString(data, ['state', 'State'])
  if (state === '') return { error: `登录服务没有签发 state（http ${response.status}）` }

  const authUrl = firstString(data, ['authUrl', 'auth_url', 'url', 'Url'])
    || `${base}/login?state=${encodeURIComponent(state)}`
  const loginId = `wbo_${randomUUID().replaceAll('-', '')}`
  sessions.set(loginId, {
    region,
    base,
    state,
    expiresAtMs: Date.now() + OAUTH_LOGIN_TIMEOUT_SECONDS * 1000,
    done: false,
  })
  return { loginId, verificationUri: authUrl, expiresIn: OAUTH_LOGIN_TIMEOUT_SECONDS }
}

/** 轮询一次登录结果。`done` 是唯一的停止信号。 */
export async function oauthPoll(loginId: string, region: Region): Promise<WorkBuddyOAuthPollResult> {
  const session = sessions.get(loginId)
  if (session === undefined) return { done: true, error: '登录会话不存在，请重新发起' }
  if (session.region !== region) return { done: true, error: '登录会话属于另一个区域' }
  if (session.done) return terminalOf(session)
  if (Date.now() > session.expiresAtMs) {
    sessions.delete(loginId)
    return { done: true, error: '登录已超时，请重新发起' }
  }

  let response: Response
  try {
    response = await fetch(`${session.base}${API_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    // 传输抖动不等于登录死了：用户可能还在扫码
    return { done: false }
  }
  const document = await readJson(response)
  if (document === undefined) return { done: false }
  const code = typeof document['code'] === 'number' ? document['code'] : -1
  if (code !== 0 && code !== 200) return { done: false }
  const data = envelopeData(document)
  const accessToken = firstString(data, ['accessToken', 'access_token', 'AccessToken'])
  if (accessToken === '') return { done: false }

  session.done = true
  try {
    const account = await collectAccount(session, accessToken, data)
    sessions.delete(loginId)
    return { done: true, account }
  } catch (error) {
    sessions.delete(loginId)
    return { done: true, error: error instanceof Error ? error.message : String(error) }
  }
}

function terminalOf(session: LoginSession): WorkBuddyOAuthPollResult {
  if (session.result !== undefined) return { done: true, account: session.result }
  return { done: true, error: session.error ?? '登录结束但没有结果' }
}

/** token 已到手，再补一次资料（失败不影响登录成功）。 */
async function collectAccount(
  session: LoginSession,
  accessToken: string,
  tokenData: Record<string, unknown>,
): Promise<WorkBuddyOAuthSuccess> {
  const headers: Record<string, string> = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
  const domain = firstString(tokenData, ['domain', 'Domain'])
  if (domain !== '') headers['X-Domain'] = domain

  let profile: Record<string, unknown> = {}
  try {
    const response = await fetch(`${session.base}${API_PREFIX}/login/account`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const document = await readJson(response)
    if (document !== undefined) profile = envelopeData(document)
  } catch {
    // 展示信息而已
  }

  const expiresAt = intOf(tokenData, 'expiresAt', 'expires_at')
  const expiresIn = intOf(tokenData, 'expiresIn', 'expires_in')
  return {
    accessToken,
    refreshToken: firstString(tokenData, ['refreshToken', 'refresh_token', 'RefreshToken']),
    expiresAtMs: expiresAt !== undefined ? expiryToMs(expiresAt)
      : expiresIn !== undefined && expiresIn > 0 ? Date.now() + expiresIn * 1000
      : 0,
    // token 自己的域优先：它决定哪个网关认这份凭据；profile 里的只是后备
    domain: domain !== '' ? domain : firstString(profile, ['domain', 'Domain']),
    uid: firstString(profile, ['uid', 'Uid', 'userId', 'UserID']),
    ...optionalField('nickname', optionalString(profile, ['nickname', 'NickName', 'ScreenName'])),
    ...optionalField('uin', optionalString(profile, ['uin', 'Uin'])),
    ...optionalField('enterpriseId', optionalString(profile, ['enterpriseId', 'EnterpriseId'])),
  }
}

/** 一次登录拿到的凭据属于哪个区域。 */
export function regionOfOAuthAccount(account: Pick<WorkBuddyOAuthSuccess, 'domain'>): Region {
  return regionOf(account.domain)
}
