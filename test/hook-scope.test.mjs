/**
 * 回归测试（issue #1）：debug 日志与故障提示只在 WorkBuddy provider 的请求上生效。
 *
 * 事故表现：装了扩展之后，任何 provider 的会话都会在 TUI 上多出
 * `[workbuddy-hub] hook after_provider_response 事件 keys: …`；别的 provider 的
 * 5xx/429 还会弹「上游模型负载高，与账号无关」这类 WorkBuddy 的提示，甚至把
 * WorkBuddy 的号记成故障。
 *
 * 这里用一个假的 `pi` 把扩展挂起来，直接投递 hook 事件，检查：
 *   · 非 `workbuddy` / `workbuddy-global` 的请求：没有日志、没有提示、不写 failover.json
 *   · 本扩展的请求：照旧提示、照旧记账，且记在**发请求的那个 provider** 的号上
 *   · 调试日志默认关闭，`PI_WORKBUDDY_DEBUG=1` 才输出
 *   · `message_end` 按消息自带的 `provider` 归因（ctx.model 已经切走也不会误判）
 *
 * 用 Node 的 TypeScript 转换直接 import `src/*.ts`（pi 也是这么加载的）：
 *   node --experimental-transform-types --test test/
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/** 每个用例一个独立 HOME，绝不碰用户真实的 ~/.pi。 */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'wbh-hook-'))
  const agentDir = join(home, '.pi', 'agent')
  mkdirSync(join(agentDir, 'workbuddy', 'workbuddy-vault', 'cn'), { recursive: true })
  mkdirSync(join(agentDir, 'workbuddy', 'workbuddy-vault', 'global'), { recursive: true })
  process.env['HOME'] = home
  process.env['PI_CODING_AGENT_DIR'] = agentDir
  for (const key of [
    'WORKBUDDY_AUTH_FILE', 'WORKBUDDY_PLUGIN_AUTH_FILE', 'WORKBUDDY_PLUGIN_DATA_DIR',
    'WORKBUDDY_DEBUG', 'PI_WORKBUDDY_DEBUG',
  ]) {
    delete process.env[key]
  }
  return agentDir
}

function documentOf(uid, domain, nickname) {
  return {
    format: 1,
    accountId: uid,
    auth: { accessToken: `token-${uid}`, refreshToken: `refresh-${uid}`, expiresAt: Date.now() + 86_400_000, domain },
    account: { uid, nickname },
  }
}

/** 别真连网：注册 provider 时会拉一次模型目录。 */
globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { models: [] } }), { status: 200 })

const agentDir = sandbox()
const cnAuth = { access: 'token-u1', refresh: 'refresh-u1', expires: Date.now() + 86_400_000, domain: 'www.codebuddy.cn', uid: 'u1' }
const globalAuth = { access: 'token-u9', refresh: 'refresh-u9', expires: Date.now() + 86_400_000, domain: 'www.workbuddy.ai', uid: 'u9' }

writeFileSync(join(agentDir, 'workbuddy', 'workbuddy-vault', 'cn', 'u1.json'), JSON.stringify(documentOf('u1', 'www.codebuddy.cn', 'cn-one')))
writeFileSync(join(agentDir, 'workbuddy', 'workbuddy-vault', 'cn', 'u2.json'), JSON.stringify(documentOf('u2', 'www.codebuddy.cn', 'cn-two')))
writeFileSync(join(agentDir, 'workbuddy', 'workbuddy-vault', 'global', 'u9.json'), JSON.stringify(documentOf('u9', 'www.workbuddy.ai', 'global-one')))
writeFileSync(join(agentDir, 'workbuddy', 'auth.cn.json'), JSON.stringify(documentOf('u1', 'www.codebuddy.cn', 'cn-one')))
writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
  workbuddy: { type: 'oauth', ...cnAuth },
  'workbuddy-global': { type: 'oauth', ...globalAuth },
  anthropic: { type: 'apikey', key: 'sk-test' },
}))

const handlers = new Map()
const notifications = []
const pi = {
  on(name, handler) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(handler)
  },
  registerCommand() {},
  registerProvider() {},
}

const emit = async (name, event, ctx) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
}

/** 一次 hook 触发的上下文；`provider` 是 pi 的当前模型（已切走的场景会故意和消息不一致）。 */
function context(provider) {
  return {
    model: { provider, id: 'some-model' },
    modelRegistry: {},
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
  }
}

const response = status => ({ type: 'after_provider_response', status, headers: {} })
const assistantEnd = (provider, errorMessage) => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    provider,
    model: 'some-model',
    api: 'x',
    content: [],
    usage: {},
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  },
})

/** 截获 console.warn（debug 日志走这里）；整个测试文件都保持截获，别恢复。 */
const logs = []
console.warn = (...args) => { logs.push(args.join(' ')) }

const { default: workbuddyHub } = await import('../src/index.ts')
await workbuddyHub(pi)

const takeLogs = () => { const out = [...logs]; logs.length = 0; return out }
const takeNotifications = () => { const out = [...notifications]; notifications.length = 0; return out }
const faultFile = () => join(agentDir, 'workbuddy', 'failover.json')
const faults = () => (existsSync(faultFile()) ? JSON.parse(readFileSync(faultFile(), 'utf8')) : {})
const activeUid = providerId => JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))[providerId]?.uid

test('debug 日志：默认关闭；开了 debug 也只对本扩展的 provider 输出', async () => {
  // 默认（未开 debug）：任何 provider 都不打
  await emit('before_provider_request', { type: 'before_provider_request', payload: {} }, context('anthropic'))
  await emit('after_provider_response', response(200), context('anthropic'))
  assert.deepEqual(takeLogs(), [], '默认不该有任何 hook 调试输出')

  // 开了 debug：别的 provider 仍然不打（issue #1 的核心）
  process.env['PI_WORKBUDDY_DEBUG'] = '1'
  await emit('before_provider_request', { type: 'before_provider_request', payload: {} }, context('anthropic'))
  await emit('after_provider_response', response(200), context('anthropic'))
  assert.deepEqual(takeLogs(), [], 'debug 只用来排查本扩展，不该被别的 provider 刷屏')

  // 开了 debug + 本扩展的 provider：打一行，并带上 provider
  await emit('before_provider_request', { type: 'before_provider_request', payload: {} }, context('workbuddy'))
  await emit('after_provider_response', response(200), context('workbuddy'))
  const withDebug = takeLogs()
  assert.equal(withDebug.length, 1)
  assert.match(withDebug[0], /hook after_provider_response/)
  assert.match(withDebug[0], /provider: workbuddy/)
  delete process.env['PI_WORKBUDDY_DEBUG']
})

test('别的 provider 的 429 / 上游忙：不提示、不记账、不换号', async () => {
  const before = activeUid('workbuddy')
  await emit('before_provider_request', { type: 'before_provider_request', payload: {} }, context('anthropic'))
  await emit('after_provider_response', response(429), context('anthropic'))
  await emit('message_end', assistantEnd('anthropic', '模型负载过高，请稍后重试'), context('anthropic'))

  assert.deepEqual(takeNotifications(), [], 'WorkBuddy 的故障提示不该出现在别的 provider 的请求上')
  assert.deepEqual(faults(), {}, '不该把别的 provider 的失败记到 WorkBuddy 账号上')
  assert.equal(activeUid('workbuddy'), before, '不该动 WorkBuddy 的槽位')
})

test('本扩展的请求：照旧提示，且按发请求的 provider 归因', async () => {
  // 国际版 429：记在 global 的号上，不碰国内号
  await emit('before_provider_request', { type: 'before_provider_request', payload: {} }, context('workbuddy-global'))
  await emit('after_provider_response', response(429), context('workbuddy-global'))
  const notes = takeNotifications()
  assert.equal(notes.length, 1)
  assert.match(notes[0].message, /workbuddy-global/)
  const keys = Object.keys(faults())
  assert.equal(keys.length, 1)
  assert.match(keys[0], /^workbuddy-global\|/)
  assert.equal(activeUid('workbuddy'), 'u1', '国际版故障不该切国内号')
})

test('上游忙只提示不换号（本扩展的请求）', async () => {
  await emit('before_provider_request', { type: 'before_provider_request', payload: {} }, context('workbuddy'))
  await emit('message_end', assistantEnd('workbuddy', '模型负载过高'), context('workbuddy'))
  const notes = takeNotifications()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].type, 'warning')
  assert.match(notes[0].message, /上游模型负载高/)
  assert.equal(activeUid('workbuddy'), 'u1')
})

test('message_end 用消息自带的 provider：ctx.model 切走了也不会误判', async () => {
  // 模型已经切到 anthropic，但在这之前发出的 workbuddy 消息刚刚结束
  await emit('message_end', assistantEnd('workbuddy', '积分不足'), context('anthropic'))
  const notes = takeNotifications()
  assert.equal(notes.length, 1, 'workbuddy 的消息已经要照常处理')
  assert.match(notes[0].message, /积分耗尽/)
  assert.equal(activeUid('workbuddy'), 'u2', '国内号有备用账号，应该真的换过去')
})

test('请求前自动换号只对 WorkBuddy 的 provider 生效', async () => {
  // 让当前国内号 u2 也进冷却；u1 还在「明天恢复」的额度冷却里，于是没有号可预换
  await emit('before_provider_request', { type: 'before_provider_request', payload: {} }, context('workbuddy'))
  await emit('after_provider_response', response(429), context('workbuddy'))
  takeNotifications()                                        // 这一轮记账的提示，先清掉
  const active = activeUid('workbuddy')

  await emit('before_agent_start', { type: 'before_agent_start', messageType: 'user', prompt: 'hi' }, context('anthropic'))
  assert.deepEqual(takeNotifications(), [], '别的 provider 的请求不该触发 WorkBuddy 的预换')
  assert.equal(activeUid('workbuddy'), active)

  await emit('before_agent_start', { type: 'before_agent_start', messageType: 'user', prompt: 'hi' }, context('workbuddy'))
  assert.deepEqual(takeNotifications(), [], '没有可用备用号时不预换、也不报假成功')
})
