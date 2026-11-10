/**
 * WorkBuddy 的流式实现。
 *
 * 不重写 OpenAI Completions 的 wire 处理，而是委托给 pi-ai 的
 * `openai-completions`，只通过它提供的接缝叠加上游特有的东西：
 *
 * - `options.headers` 放 WorkBuddy 的 header（Bearer access token、会话身份三件套、
 *   `X-User-Id`/`X-Enterprise-Id`/`X-Domain`、CLI UA）。
 * - `options.onPayload` 改写每个请求的 body（强制 `stream: true`、摊平
 *   `tool_choice`、`developer`→`system`、保证 system 开头、挪开渠道指纹）。
 * - `options.fetch` 用到真实上游，于是 SDK 的流式解析、用量统计、取消全部照常工作；
 *   access token 不出现在 `apiKey` 里（SDK 仍要求一个，这里给占位符，真实 header 覆盖它）。
 * - 错误文本被规范化（排队位置、溢出标记），让 pi 的重试/压缩机制认得。
 *
 * 额外的一层：模型会把工具调用写进**文本**（DSML 标记），`delta.tool_calls` 里什么都没有。
 * 那层恢复在 `dsml.ts`，这里只负责把 SSE 帧喂给它。
 */

import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai/compat'

import {
  KIND_STATUS,
  WorkBuddyUpstreamClient,
  failureMessage,
  prepareChatBody,
  type UpstreamErrorKind,
} from './client.ts'
import { DsmlStreamBuffer } from './dsml.ts'
import { chatHeaders } from './client.ts'
import { chatBase, regionOf, globalBase } from '../upstream.ts'
import type { WorkBuddyCredential } from './store.ts'

/**
 * 每次请求现解一份凭据：store 负责续期，于是会话中途的续期不需要重载。
 */
export type CredentialResolver = () => Promise<WorkBuddyCredential>

function placeholderMessage(model: Model<Api>, errorMessage: string, aborted: boolean): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage,
    timestamp: Date.now(),
  }
}

/** 凭据所属区域的上游基址。 */
function upstreamBaseFor(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential.domain) : chatBase(credential)
}

/**
 * 流式跑一次对话。
 *
 * 重活（请求转换、工具处理、用量统计、取消）属于 pi-ai 的 openai-completions；
 * 这个包装存在只为了 (a) 把 WorkBuddy 的 header 与 body 改写放上 wire，
 * (b) 恢复模型写进文本里的 DSML 工具调用 —— 内层流不可能知道这件事。
 */
export function createWorkBuddyStream(
  resolveCredential: CredentialResolver,
): (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream()

    void (async () => {
      try {
        const credential = await resolveCredential()

        // DSML 闸门骑在请求自己的工具声明上（与内层 api 读的是同一来源）。
        const declaredTools = getCurrentTools(context.messages)
        const buffer = declaredTools.length === 0
          ? undefined
          : new DsmlStreamBuffer({
              declaredNames: new Set(declaredTools.map(tool => tool.name)),
              requiredParameters: new Map(declaredTools.map((tool) => {
                const parameters = (tool as { parameters?: { required?: string[] } }).parameters
                return [tool.name, Array.isArray(parameters?.required) ? parameters.required : []]
              })),
              acceptedParameters: new Map(declaredTools.map((tool) => {
                const parameters = (tool as { parameters?: { properties?: Record<string, unknown> } }).parameters
                return [tool.name, new Set(Object.keys(parameters?.properties ?? {}))]
              })),
            })

        const headers = chatHeaders(credential)
        const base = upstreamBaseFor(credential)
        const upstream = new WorkBuddyUpstreamClient()

        const innerOptions: SimpleStreamOptions = {
          ...options,
          apiKey: 'workbuddy-managed',
          headers,
          onPayload: (payload: unknown) => {
            const params = payload as Record<string, unknown>
            params['stream'] = true
            return params
          },
          fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const bodyJson = typeof init?.body === 'string' ? init.body : ''
            const prepared = prepareChatBody(bodyJson)
            const result = await upstream.chatStream(credential, prepared, init?.signal ?? options?.signal)
            if (!result.ok) {
              const kind: UpstreamErrorKind = result.kind ?? 'server'
              const error = new Error(failureMessage(kind, result.status, result.message ?? '')) as Error & {
                status?: number
                headers?: Headers
              }
              error.status = KIND_STATUS[kind]
              const responseHeaders = new Headers()
              // 排队对宿主来说也是 429，但重试一个排在第几千位的请求只是白花请求：
              // 明确告诉所有会重试的客户端「别重试」。
              if (kind === 'model_queue') responseHeaders.set('x-should-retry', 'false')
              error.headers = responseHeaders
              throw error
            }
            // 后处理 SSE：在内层 api 解析帧之前，把写进 delta.content 的 DSML 调用捞出来
            if (buffer === undefined || result.response === undefined) {
              return result.response ?? new Response(null, { status: 200 })
            }
            return transformSse(result.response, buffer)
          }) as typeof fetch,
        }

        const { openAICompletionsApi } = await import('@earendil-works/pi-ai/compat')
        const inner = openAICompletionsApi().streamSimple({ ...model, baseUrl: base }, context, innerOptions)
        for await (const event of inner) stream.push(event)
        stream.end()
      } catch (error) {
        stream.push({
          type: 'error',
          reason: options?.signal?.aborted ? 'aborted' : 'error',
          error: placeholderMessage(
            model,
            error instanceof Error ? error.message : String(error),
            options?.signal?.aborted === true,
          ),
        })
        stream.end()
      }
    })()

    return stream
  }
}

/**
 * 把上游 SSE 过一个 DSML 恢复缓冲：重写 `delta.content` 帧 —— 恢复出来的调用变成
 * 真正的 `delta.tool_calls` 增量，门禁没通过的标记原样保留。
 */
function transformSse(response: Response, buffer: DsmlStreamBuffer): Response {
  const decoder = new TextDecoder()
  const reader = response.body!.getReader()
  let carry = ''

  const textStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          const flushed = buffer.flush()
          if (flushed.text !== '') {
            // 收尾的残余文本属于**最后一帧**内容；单独发一帧，免得上游半路结束时把它丢了
            controller.enqueue(encodeFrame(contentDeltaFrame(flushed.text)))
          }
          controller.enqueue(ENCODER.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        carry += decoder.decode(value, { stream: true })
        // 帧之间用空行分隔；尾部不完整的那段留着
        let boundary: number
        while ((boundary = carry.indexOf('\n\n')) !== -1) {
          const frame = carry.slice(0, boundary + 2)
          carry = carry.slice(boundary + 2)
          for (const rewritten of processFrame(frame, buffer)) controller.enqueue(encodeFrame(rewritten))
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return new Response(textStream, { status: response.status, headers: response.headers })
}

const ENCODER = new TextEncoder()

function encodeFrame(frame: string): Uint8Array {
  return ENCODER.encode(frame.endsWith('\n\n') ? frame : frame.endsWith('\n') ? `${frame}\n` : `${frame}\n\n`)
}

/** 一个最小的 OpenAI chunk 帧，带文本增量。 */
function contentDeltaFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
}

/**
 * 重写一帧：把它 `delta.content` 里的调用捞出来，用剩下的文本替换内容，
 * 再把捞到的调用追加成原生 `delta.tool_calls` 增量。
 */
function processFrame(frame: string, buffer: DsmlStreamBuffer): string[] {
  if (!frame.startsWith('data:')) return [frame]
  const payload = frame.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return [frame]
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return [frame]
  }
  if (typeof parsed !== 'object' || parsed === null) return [frame]
  const chunk = parsed as Record<string, unknown>
  const choices = chunk['choices']
  if (!Array.isArray(choices) || choices.length === 0) return [frame]
  const choice = choices[0] as Record<string, unknown>
  const delta = typeof choice['delta'] === 'object' && choice['delta'] !== null
    ? choice['delta'] as Record<string, unknown>
    : undefined
  if (delta === undefined) return [frame]

  // 推理内容原样透传；没有 content 就没有缓冲要看的东西
  const content = delta['content']
  if (typeof content !== 'string' || content === '') return [frame]

  const outcome = buffer.add(content)
  delta['content'] = outcome.text
  if (outcome.calls !== undefined && outcome.calls.length > 0) {
    delta['tool_calls'] = outcome.calls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return [`data: ${JSON.stringify(chunk)}\n\n`]
}
