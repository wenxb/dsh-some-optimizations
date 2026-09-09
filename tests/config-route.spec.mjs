import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../lib/index.js'

const BASE = {
  hosts: [], normalizeCallIds: true, unboundedStreamTimeouts: true,
  bodyTimeoutMs: 0, headersTimeoutMs: 0, announce: false,
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
  assert.equal(body.imageShed, true)
  assert.equal(typeof body.normalizeCallIds, 'boolean')
})

test('POST 合法 patch 生效并回显新值', async () => {
  const h = harness(BASE)
  const r = res()
  await h.handler(req('POST', '/dsh-some-optimizations/config', JSON.stringify({ patch: { imageShed: false } })), r)
  assert.equal(r.statusCode, 200)
  assert.equal(JSON.parse(r.body).imageShed, false)
  const g = res()
  await h.handler(req('GET', '/dsh-some-optimizations/config'), g)
  assert.equal(JSON.parse(g.body).imageShed, false)
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
