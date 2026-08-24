import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizingFetch, apply } from '../lib/index.js'

const CFG = (over = {}) => {
  const config = { hosts: [], normalizeCallIds: true, unboundedStreamTimeouts: false, bodyTimeoutMs: 0, headersTimeoutMs: 0, announce: false, ...over }
  return () => config
}

const SSE = (id) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id }] } }] })}\ndata: [DONE]\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })

test('normalizeCallIds=true rewrites synthetic ids on selected hosts', async () => {
  const wrapped = normalizingFetch(async () => SSE('read:0'), CFG())
  const text = await (await wrapped('http://any.host/v1/chat/completions', {})).text()
  assert.match(text, /"id":"read:0#1-[0-9a-f]+"/)
})

test('normalizeCallIds=false leaves streams byte-faithful', async () => {
  const raw = SSE('read:0')
  const expected = await raw.text()
  const wrapped = normalizingFetch(async () => SSE('read:0'), CFG({ normalizeCallIds: false }))
  assert.equal(await (await wrapped('http://any.host/v1/chat/completions', {})).text(), expected)
})

test('hosts outside the allowlist are untouched', async () => {
  const raw = SSE('read:0')
  const expected = await raw.text()
  const wrapped = normalizingFetch(async () => SSE('read:0'), CFG({ hosts: ['10.0.0.1:9999'] }))
  assert.equal(await (await wrapped('https://api.example.com/v1/chat', {})).text(), expected)
})

const base = (over = {}) => ({
    hosts: [], normalizeCallIds: true, unboundedStreamTimeouts: true,
    bodyTimeoutMs: 0, headersTimeoutMs: 0, announce: false, ...over,
  })

  function fakeCtx() {
    const disposers = []
    const target = {
      disposers,
      effect(fn) { disposers.push(fn()) },
      logger: { info() {}, warn() {} },
    }
    // 设置面会调用 inject/on 等宿主方法;未知方法一律 no-op。
    return new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop]
        return () => {}
      },
    })
  }

test('unboundedStreamTimeouts swaps the global dispatcher and restores it', async () => {
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const original = getGlobalDispatcher()
  setGlobalDispatcher(original)
  const ctx = fakeCtx()
  apply(ctx, base())
  assert.notEqual(getGlobalDispatcher(), original, 'a hardening Agent must be installed')
  for (const dispose of ctx.disposers.reverse()) dispose?.()
  assert.equal(getGlobalDispatcher(), original, 'the previous dispatcher must be restored')
})

test('unboundedStreamTimeouts=false installs no dispatcher', async () => {
  const { getGlobalDispatcher } = await import('undici')
  const original = getGlobalDispatcher()
  const ctx = fakeCtx()
  apply(ctx, base({ unboundedStreamTimeouts: false }))
  assert.equal(getGlobalDispatcher(), original)
  for (const dispose of ctx.disposers.reverse()) dispose?.()
})
