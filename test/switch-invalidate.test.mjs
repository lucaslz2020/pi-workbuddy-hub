/**
 * 回归测试：切号后 provider 的进程内缓存必须真的被丢掉。
 *
 * 曾经的事故：`/wb use` 把 vault / 刷新副本 / auth.json 三处都写对了，界面也报
 * 「已切换」，但 provider 的 `WorkBuddyCredentialStore` 还缓存着上一个号，于是
 * **之后的请求仍然用旧 token 发出**，新号一直「失败」。根因是失效回调走
 * `getRegisteredNativeProvider(id).oauth.refreshToken()`，而本包用 legacy 的
 * `pi.registerProvider(id, config)` 注册，那个 getter 永远是 `undefined`。
 *
 * 用 Node 的 TypeScript 转换直接 import `src/*.ts`（pi 也是这么加载的）：
 *   node --experimental-transform-types --test test/
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/** 每个用例一个独立 HOME，绝不碰用户真实的 ~/.pi。 */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'wbh-test-'))
  const agentDir = join(home, '.pi', 'agent')
  mkdirSync(join(agentDir, 'workbuddy', 'workbuddy-vault', 'cn'), { recursive: true })
  process.env['HOME'] = home
  process.env['PI_CODING_AGENT_DIR'] = agentDir
  for (const key of ['WORKBUDDY_AUTH_FILE', 'WORKBUDDY_PLUGIN_AUTH_FILE', 'WORKBUDDY_PLUGIN_DATA_DIR']) {
    delete process.env[key]
  }
  return {
    /** provider 自己的刷新副本（pickBest 的第一优先来源）。 */
    copyPath: join(agentDir, 'workbuddy', 'auth.cn.json'),
    /** pi 的 provider 凭据槽位。 */
    authPath: join(agentDir, 'auth.json'),
  }
}

/** 与 provider 读的文档格式一致（`credentialDocument()` 的产物）。 */
function documentOf(uid, accessToken) {
  return {
    format: 1,
    accountId: uid,
    auth: { accessToken, refreshToken: `refresh-${uid}`, expiresAt: Date.now() + 86_400_000, domain: 'www.codebuddy.cn' },
    account: { uid },
  }
}

/** 记录每个出站请求带的 Authorization，别真连网。 */
function stubFetch() {
  const seen = []
  globalThis.fetch = async (_url, init) => {
    const headers = init?.headers ?? {}
    seen.push(headers.Authorization ?? headers.authorization)
    return new Response(JSON.stringify({ code: 0, data: { models: [] } }), { status: 200 })
  }
  return seen
}

test('其它上下文改了磁盘：cache 自己校对出变化（跨进程切号也能生效）', async () => {
  const box = sandbox()
  writeFileSync(box.copyPath, JSON.stringify(documentOf('u1', 'token-A')))

  const { WorkBuddyCredentialStore } = await import('../src/provider/store.ts')
  const store = new WorkBuddyCredentialStore('cn')

  assert.equal((await store.resolve()).accessToken, 'token-A')
  // 没经过本进程的 invalidate()：比如另一个 pi 窗口跑的 /wb use
  writeFileSync(box.copyPath, JSON.stringify(documentOf('u2', 'token-B')))
  assert.equal(
    (await store.resolve()).accessToken,
    'token-B',
    '磁盘上换了 uid，缓存必须自己让位 —— 否则就是「切了还是上一个号」',
  )
})

test('同 uid 的续期不会让缓存失效（token 被合法改写不该触发重解析）', async () => {
  const box = sandbox()
  writeFileSync(box.copyPath, JSON.stringify(documentOf('u1', 'token-A')))
  writeFileSync(box.authPath, JSON.stringify({
    workbuddy: { type: 'oauth', access: 'token-A', refresh: 'refresh-u1', expires: Date.now() + 86_400_000, domain: 'www.codebuddy.cn', uid: 'u1' },
  }))

  const { WorkBuddyCredentialStore } = await import('../src/provider/store.ts')
  const store = new WorkBuddyCredentialStore('cn')
  const first = await store.resolve()

  const renewed = { ...documentOf('u1', 'token-A2') }
  writeFileSync(box.copyPath, JSON.stringify(renewed))
  // 缓存的还是上一份 token：不因为 token 改了就去重读（那是续期自己写的）
  assert.equal((await store.resolve()).accessToken, first.accessToken)
})

test('invalidateCredentialCache() 让 provider 下一次请求真的用新号', async () => {
  const box = sandbox()
  writeFileSync(box.copyPath, JSON.stringify(documentOf('u1', 'token-A')))
  const seen = stubFetch()

  const register = await import('../src/provider/register.ts')
  await register.refreshModelCatalog()                    // ① 让 provider 缓存住 A
  assert.equal(seen.at(-1), 'Bearer token-A')

  // ② 模拟 /wb use 的存储层：刷新副本 + auth.json 都写成 B
  writeFileSync(box.copyPath, JSON.stringify(documentOf('u2', 'token-B')))
  writeFileSync(box.authPath, JSON.stringify({
    workbuddy: { type: 'oauth', access: 'token-B', refresh: 'refresh-u2', expires: Date.now() + 86_400_000, domain: 'www.codebuddy.cn', uid: 'u2' },
  }))

  assert.equal(register.invalidateCredentialCache('workbuddy'), true, 'workbuddy 是本扩展注册的 provider')
  await register.refreshModelCatalog()                    // ③ 下一次请求
  assert.equal(seen.at(-1), 'Bearer token-B', '切号后必须换号发出')
})

test('invalidateCredentialCache() 只认自己注册的 provider', async () => {
  sandbox()
  const register = await import('../src/provider/register.ts')
  assert.equal(register.invalidateCredentialCache('anthropic'), false)
  assert.equal(register.invalidateCredentialCache('workbuddy-global'), true)
  assert.equal(register.invalidateCredentialCache(), true, '不传参数 = 两个区域都丢')
})

test('provider 是按名字注册的，getRegisteredNativeProvider() 拿不到它（根因）', async () => {
  const box = sandbox()
  writeFileSync(box.authPath, '{}')

  // 深路径直接引：这个模块不在 package exports 里，但 model runtime 就在那儿
  const { ModelRuntime } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js')
  const runtime = await ModelRuntime.create({ authPath: box.authPath, modelsPath: null, refreshOnCreate: false })
  runtime.registerProvider('workbuddy', { name: 'WorkBuddy (CN)', api: 'openai-completions', models: [] })

  assert.equal(
    runtime.getRegisteredNativeProvider('workbuddy'),
    undefined,
    'legacy 注册落在 extensionProviders；native getter 永远返回 undefined',
  )
  assert.notEqual(runtime.getRegisteredProviderConfig('workbuddy'), undefined)
})
