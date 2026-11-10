/**
 * WorkBuddy 上游的 wire 常量。
 *
 * 【本包改动】这份文件原本自带一份完整的「区域 / 域名 / 路径 / UA / 业务码」表，
 * 与账号层的 `src/upstream.ts` 几乎逐字重复。两份一旦漂移，聊天用的基址和签到用的
 * 基址就会不一样，而且没人会发现 —— 所以现在事实常量只有一份，这里只留
 * provider 独有的「请求形态」常量并做转发。
 *
 * 协议行为（哪些路径、哪个 UA、哪个业务码）见 `src/upstream.ts` 的说明。
 */

export {
  CHAT_PATH,
  CHECKIN_STATUS_PATHS,
  CLIENT_UA,
  CN_BILLING_BASE,
  CN_BILLING_BASES,
  CN_CHAT_BASE,
  CODE_CHANNEL_REJECT,
  CODE_CONTENT_POLICY,
  CODE_CONTEXT_TOO_LONG,
  CODE_CREDITS_EXHAUSTED,
  CODE_MODEL_BUSY,
  CODE_QUEUE_FULL,
  CODE_QUEUE_PER_ACCOUNT,
  CODE_QUEUE_POSITION,
  CODE_RATE_LIMIT,
  CODE_SESSION_DEAD,
  DAILY_CHECKIN_PATH,
  ERROR_BODY_LIMIT,
  GLOBAL_BASE,
  GLOBAL_CODEBUDDY_BASE,
  GLOBAL_CONFIG_PATH,
  JSON_TIMEOUT_MS,
  MODELS_CATALOG_PATH,
  PRODUCT_UA,
  REFRESH_PATH,
  billingBase,
  chatBase,
  globalBase,
  originReferer,
  regionOf,
} from '../upstream.ts'

export type { Region as WorkBuddyRegion, Region } from '../upstream.ts'


/**
 * provider 侧的请求超时。与账号层的 `JSON_TIMEOUT_MS` 分开：流式对话和拉目录
 * 比一次账务请求慢，混用一份会把聊天卡在 20 秒。
 */
export const UPSTREAM_TIMEOUT_MS = 30_000
