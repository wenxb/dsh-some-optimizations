import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, pinsStore } from '../lib/index.js'

/** 每个用例独立的 pins 存储路径，避免互相串扰。 */
function isolatePins() {
  pinsStore.path = join(tmpdir(), `dso-test-pins-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  pinsStore.cache = {}
}

const BASE = {
  hosts: [], normalizeCallIds: true, unboundedStreamTimeouts: true,
  bodyTimeoutMs: 0, headersTimeoutMs: 0, modelPin: true, announce: false,
}

/** 可工作的 settings/webServer 桩：真实走 apply 的两条 inject。 */
function harness(initial) {
  let section = Config(initial)
  let watcher
  const routes = []
  const disposers = []
  const listeners = new Map()
  const settingsSvc = {
    register(ns, schema, opts) {
      section = Config(opts.base)
      return {
        get: () => section,
        watch(fn) { watcher = fn },
      }
    },
    async update(ns, patch) {
      section = { ...section, ...Config({ ...section, ...patch }) }
      watcher?.()
      return section
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { disposers.push(fn?.()) },
    on(name, cb) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(cb)
      return () => {
        const l = listeners.get(name)
        const i = l.indexOf(cb)
        if (i >= 0) l.splice(i, 1)
      }
    },
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({
          settings: settingsSvc,
          effect(fn) { disposers.push(fn?.()) },
          webServer: { register(route) { routes.push(route); return () => {} } },
        })
      } else {
        cb({ settings: settingsSvc })
      }
    },
  }
  apply(ctx, initial)
  assert.equal(routes.length, 1, 'the config route must be registered')
  return { handler: routes[0].handler, get section() { return section }, listeners }
}

/** cordis waterfall 语义：先注册者最外层；最内层返回 seed。 */
async function runWaterfall(listeners, seed, payload = {}) {
  const cbs = [...(listeners.get('agent/request') ?? [])]
  const call = (i) => async () => (i < cbs.length ? cbs[i](payload, call(i + 1)) : seed)
  return call(0)()
}

const req = (method, url, body) => ({
  method,
  url,
  on(ev, cb) {
    if (ev === 'data' && body != null) cb(Buffer.from(body))
    if (ev === 'end') cb()
  },
})

const res = () => {
  const r = { statusCode: 0, headers: {}, body: '', writeHead(code, headers) { r.statusCode = code; Object.assign(r.headers, headers) }, end(b) { r.body = b ?? '' } }
  return r
}

test('GET /config 返回解析后的完整配置段', async () => {
  const h = harness(BASE)
  const r = res()
  await h.handler(req('GET', '/dsh-some-optimizations/config'), r)
  assert.equal(r.statusCode, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.modelPin, true)
  assert.equal(typeof body.normalizeCallIds, 'boolean')
})

test('POST 合法 patch 生效并回显新值', async () => {
  const h = harness(BASE)
  const r = res()
  await h.handler(req('POST', '/dsh-some-optimizations/config', JSON.stringify({ patch: { modelPin: false } })), r)
  assert.equal(r.statusCode, 200)
  assert.equal(JSON.parse(r.body).modelPin, false)
  const g = res()
  await h.handler(req('GET', '/dsh-some-optimizations/config'), g)
  assert.equal(JSON.parse(g.body).modelPin, false)
})

test('POST 多字段合法 patch 一并生效', async () => {
  const h = harness(BASE)
  const r = res()
  await h.handler(req('POST', '/dsh-some-optimizations/config', JSON.stringify({ patch: { normalizeCallIds: false, unboundedStreamTimeouts: false } })), r)
  assert.equal(r.statusCode, 200)
  const body = JSON.parse(r.body)
  assert.equal(body.normalizeCallIds, false)
  assert.equal(body.unboundedStreamTimeouts, false)
})

test('POST 未知字段 → 400', async () => {
  const h = harness(BASE)
  const r = res()
  await h.handler(req('POST', '/dsh-some-optimizations/config', JSON.stringify({ patch: { evil: 1 } })), r)
  assert.equal(r.statusCode, 400)
  assert.match(r.body, /unknown field/)
})

test('POST 非法 JSON → 400；缺 patch → 400', async () => {
  const h = harness(BASE)
  const bad = res()
  await h.handler(req('POST', '/dsh-some-optimizations/config', '{oops'), bad)
  assert.equal(bad.statusCode, 400)

  const nopatch = res()
  await h.handler(req('POST', '/dsh-some-optimizations/config', JSON.stringify({ value: 1 })), nopatch)
  assert.equal(nopatch.statusCode, 400)
})

test('其他路径 → 404；其他方法 → 405', async () => {
  const h = harness(BASE)
  const nf = res()
  await h.handler(req('GET', '/dsh-some-optimizations/other'), nf)
  assert.equal(nf.statusCode, 404)

  const dm = res()
  await h.handler(req('DELETE', '/dsh-some-optimizations/config'), dm)
  assert.equal(dm.statusCode, 405)
})

// ===== /click（会话级钉子写入端）=====

test('POST /click 记录会话选择并原子持久化', async () => {
  isolatePins()
  const h = harness(BASE)
  const r = res()
  await h.handler(req('POST', '/dsh-some-optimizations/click', JSON.stringify({
    sessionId: 'sess-aabbccdd', provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'max',
  })), r)
  assert.equal(r.statusCode, 200)
  assert.deepEqual(JSON.parse(r.body), { ok: true, count: 1 })
  assert.deepEqual(pinsStore.cache['sess-aabbccdd'], { provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'max' })
  // flush 在响应前完成 → 文件已落盘
  const raw = JSON.parse(await readFile(pinsStore.path, 'utf8'))
  assert.equal(raw.version, 1)
  assert.deepEqual(raw.pins['sess-aabbccdd'], { provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'max' })
})

test('POST /click 缺字段 → 400；GET /click → 405', async () => {
  isolatePins()
  const h = harness(BASE)

  const missing = res()
  await h.handler(req('POST', '/dsh-some-optimizations/click', JSON.stringify({ sessionId: 's', provider: 'p' })), missing)
  assert.equal(missing.statusCode, 400)

  const badJson = res()
  await h.handler(req('POST', '/dsh-some-optimizations/click', '{oops'), badJson)
  assert.equal(badJson.statusCode, 400)

  const wrongMethod = res()
  await h.handler(req('GET', '/dsh-some-optimizations/click'), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
})

test('端到端：click 后该会话被钉住，其他会话不受影响', async () => {
  isolatePins()
  const h = harness(BASE)

  const click = res()
  await h.handler(req('POST', '/dsh-some-optimizations/click', JSON.stringify({
    sessionId: 'sess-pinned', provider: 'nvidia', model: 'kimi-k3',
  })), click)
  assert.equal(click.statusCode, 200)

  // 内层模拟官方覆盖：一律改回 claude
  h.listeners.get('agent/request')?.push(async (_p, next) => {
    const resolved = await next()
    return { ...resolved, provider: 'agentrouter-claude', model: 'claude-opus-5' }
  })

  const seed = { provider: 'agentrouter-claude', model: 'claude-opus-5' }
  const pinned = await runWaterfall(h.listeners, seed, { agent: { session: { id: 'sess-pinned' } } })
  assert.deepEqual(pinned, { provider: 'nvidia', model: 'kimi-k3' })

  const other = await runWaterfall(h.listeners, seed, { agent: { session: { id: 'sess-other' } } })
  assert.deepEqual(other, seed)
})
