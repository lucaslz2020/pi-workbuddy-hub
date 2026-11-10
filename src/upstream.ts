/**
 * 上游网关常量 —— 账号层与协议层共用的**唯一**一份。
 *
 * 这里是「实测出来的上游事实」，不是本包的策略：域名、路径、UA、业务码。
 * 策略（何时换号、何时重试、怎么展示）在 failover.ts / runner.ts。
 *
 * 端点全部实测自两个独立实现，取交集：
 *   - lorlike/pi-provider-workbuddy
 *   - xmgzxmgz/workbuddy-account-hub（Rust，多账号批量签到）
 *
 * 两个实现的分歧点只有一个：计费基址。plugin 用 `www.codebuddy.cn`，
 * hub 用 `copilot.tencent.com`。本包默认跟 plugin，404/405/5xx 时自动回落。
 *
 * ## 为什么协议层（src/provider/）也读这份
 *
 * 内置 provider 曾经自带 upstream.ts，与这份几乎逐字重复（域名、路径、
 * UA、业务码）。两份一旦漂移，签到用的基址和聊天用的基址就会不一样。
 * 现在 provider 只保留它自己的「请求形态」（UA 变体、超时、错误体上限），
 * 事实常量全部回到这里。
 */

export type Region = 'cn' | 'global'

// ---------------------------------------------------------------------------
// 基址
// ---------------------------------------------------------------------------

/** 国内版网关（聊天 / 模型目录）。 */
export const CN_CHAT_BASE = 'https://copilot.tencent.com'

/** 国内版计费基址候选，按优先级尝试。 */
export const CN_BILLING_BASES: readonly string[] = [
  'https://www.codebuddy.cn',
  'https://copilot.tencent.com',
]

/** 国内版计费基址（首选）。 */
export const CN_BILLING_BASE = CN_BILLING_BASES[0]

/** 国际版网关（workbuddy.ai 品牌）。 */
export const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** 国际版网关（codebuddy.ai 品牌）—— 与上面是两个品牌域、一套栈。 */
export const GLOBAL_CODEBUDDY_BASE = 'https://www.codebuddy.ai'

/**
 * 国际版网关：token 的签发域决定用哪个。
 * 一个域签发的 token 会被另一个域的网关拒（HTML 401），所以这里必须跟凭据走。
 */
export function globalBase(domain: string): string {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return GLOBAL_CODEBUDDY_BASE
  return GLOBAL_BASE
}

/** 聊天基址：国际版跟随签发域，国内版固定一个网关。 */
export function chatBase(credential: { domain: string }): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_CHAT_BASE
}

/** 计费基址（首选）。退避/多候选用 `billingBasesFor`（见 checkin.ts）。 */
export function billingBase(credential: { domain: string }): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : CN_BILLING_BASE
}

/** Origin / Referer：网关会校验请求来源与登录域一致。 */
export function originReferer(credential: { domain: string }): string {
  return billingBase(credential)
}

/** 登录域 → 区域。空域按国内版处理（与上游工具一致）。 */
export function regionOf(domain: string): Region {
  const lowered = domain.trim().toLowerCase()
  if (lowered === '') return 'cn'
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 聊天（OpenAI 兼容，强制 `stream: true`）。 */
export const CHAT_PATH = '/v2/chat/completions'

/** 模型目录：客户端自己读的那份配置（含价格、活动信息）。 */
export const GLOBAL_CONFIG_PATH = '/v3/config'

/** 旧版国内模型目录 —— `/v3/config` 失败时的后备。 */
export const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'

/** token 续期；refreshToken 只出现在这里。 */
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh'

/** 签到活动状态。现代端点优先，旧拼写作后备。 */
export const CHECKIN_STATUS_PATHS: readonly string[] = [
  '/v2/billing/meter/checkin-activity-status',
  '/v2/billing/meter/checkin-status',
]

/** 领取今日积分（每个北京日只该成功一次）。 */
export const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'

// ---------------------------------------------------------------------------
// 身份与超时
// ---------------------------------------------------------------------------

/** 聊天通道的 UA：上游按 CLI agent 计费与限流。 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * 产品配置通道的 UA：App 自己的身份，逐字节照抄 `/v3/config` 的请求。
 * 决定返回哪份文档的是通道（UA 声明的是谁），不是里面的版本号。
 */
export const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'

/** 普通签名请求（签到、续期）的超时。 */
export const JSON_TIMEOUT_MS = 20_000



/** 错误体最多这么长，超出的截断（不把整段 HTML 灌进日志）。 */
export const ERROR_BODY_LIMIT = 4096

// ---------------------------------------------------------------------------
// 业务码：这些是「关于今天/这个号的答案」，不是可重试的失败
// ---------------------------------------------------------------------------

/** 签到：今天已经领过。 */
export const CODE_ALREADY = 1001
/** 签到：该账号不能参与。 */
export const CODE_INELIGIBLE = 1002
/** 签到：活动已结束。 */
export const CODE_ENDED = 1003

/** 上游把这类也当限流处理（与 429 同逻辑），规则见 failover.ts。 */
export const CODE_RATE_LIMIT = 37

/** 聊天：积分耗尽。 */
export const CODE_CREDITS_EXHAUSTED = 14018
/** 聊天：会话失效。 */
export const CODE_SESSION_DEAD = 12153
/** 聊天：模型负载高（换号没用，换模型）。 */
export const CODE_MODEL_BUSY = 14003
/** 聊天：内容策略拒绝。 */
export const CODE_CONTENT_POLICY = 11140
/** 聊天：渠道指纹拦截。 */
export const CODE_CHANNEL_REJECT = 11128
/** 聊天：prompt 超出模型窗口。 */
export const CODE_CONTEXT_TOO_LONG = 11115
/** 聊天：排队（三档）。 */
export const CODE_QUEUE_POSITION = 6020
export const CODE_QUEUE_FULL = 6021
export const CODE_QUEUE_PER_ACCOUNT = 6022
