/**
 * Model catalog per region: a static fallback list, replaced by the upstream's
 * dynamic catalog once it loads. The fallback keeps the provider usable before
 * the first fetch lands or while offline; each region keeps its own list so an
 * account never shows the other region's roster.
 */

import type { WorkBuddyUpstreamModel } from './store.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/** Static CLI models captured from the CN endpoint (dsh-connect-workbuddy). */
const FALLBACK_CN: readonly WorkBuddyUpstreamModel[] = [
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000 },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, maxTokens: 50_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000 },
]

/**
 * Static CLI models captured from the international gateway's desktop-channel
 * product config (`www.workbuddy.ai/v3/config`). `default-model` (the region's
 * `auto` router) is deliberately absent.
 */
const FALLBACK_GLOBAL: readonly WorkBuddyUpstreamModel[] = [
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000, creditMultiplier: 0.34 },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.59 },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 3.31 },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000, creditMultiplier: 3.33 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 6.67 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, creditMultiplier: 0 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.47 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 1.39 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0.14 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 3.31 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.65 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, maxTokens: 72_000, creditMultiplier: 1.25 },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, maxTokens: 65_536, creditMultiplier: 0.99 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.79 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, creditMultiplier: 0.79 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, creditMultiplier: 1.62 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.52 },
]

export function fallbackModelsFor(region: WorkBuddyRegion): readonly WorkBuddyUpstreamModel[] {
  return region === 'global' ? FALLBACK_GLOBAL : FALLBACK_CN
}

/** Model ids documented as native multimodal (vendored vendor-documentation table). */
const NATIVE_MULTIMODAL: ReadonlySet<string> = new Set([
  // `-sg` 是同一模型的新加坡区域变体，与主 id 能力相同；漏登记会落到 unclassified，
  // 而 unclassified 按约定不继承，结果就是明明能看图却被判成纯文本。
  'deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg', 'glm-5.3-flash', 'glm-5v-turbo',
  'kimi-k2.6', 'kimi-k2.7', 'kimi-k3-1', 'minimax-m3',
])

/** Model ids documented as text-only. */
const NATIVE_TEXT: ReadonlySet<string> = new Set([
  'deepseek-v4-pro', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'hy3', 'hy4-preview',
])

/**
 * Image-input capability, by the vendor-documentation table rather than the
 * platform's `supportsImages` flag (which is `true` for text-only models on
 * live data). Unknown ids stay `undefined` — unclassified, never inherited.
 */
export function nativeImageInput(modelId: string): boolean | undefined {
  if (NATIVE_MULTIMODAL.has(modelId)) return true
  if (NATIVE_TEXT.has(modelId)) return false
  return undefined
}

/**
 * Models observed to REFUSE `reasoning_effort: "off"` with HTTP 400 despite
 * declaring `canDisableThinking: true`. The level, once offered, also becomes
 * the implicit default for requests that name no effort (compaction among
 * them), so offering a level that always fails costs the user every request.
 * The table errs toward hiding.
 */
export const REFUSES_OFF_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
])
