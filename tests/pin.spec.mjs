import test from 'node:test'
import assert from 'node:assert/strict'
import { installModelPin, selectionForSession, sessionIdOf } from '../lib/pin.js'

/** 最小 cordis ctx 替身：记录 on() 注册，支持注销。 */
function fakeCtx() {
  const listeners = new Map()
  const logs = []
  return {
    logs,
    logger: { info: (...a) => logs.push(a), warn: (...a) => logs.push(['warn', ...a]) },
    on(name, cb) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(cb)
      return () => {
        const l = listeners.get(name)
        const i = l.indexOf(cb)
        if (i >= 0) l.splice(i, 1)
      }
    },
    listeners,
  }
}

/** 按 cordis waterfall 语义执行：先注册者最外层；最内层默认返回 seed。 */
async function runWaterfall(listeners, seed, payload = {}) {
  const cbs = [...(listeners.get('agent/request') ?? [])]
  const call = (i) => async () => (i < cbs.length ? cbs[i](payload, call(i + 1)) : seed)
  return call(0)()
}

const enabledOn = () => true
const agentPayload = (id) => ({ agent: { session: { id } } })
const PIN_A = { provider: 'nvidia', model: 'kimi-k3' }

test('sessionIdOf: agent / turn.agent / step.agent 三级回退', () => {
  assert.equal(sessionIdOf(agentPayload('sess-a')), 'sess-a')
  assert.equal(sessionIdOf({ turn: { agent: { session: { id: 'sess-b' } } } }), 'sess-b')
  assert.equal(sessionIdOf({ step: { agent: { session: { id: 'sess-c' } } } }), 'sess-c')
  assert.equal(sessionIdOf({}), undefined)
  assert.equal(sessionIdOf(undefined), undefined)
  assert.equal(sessionIdOf({ agent: { session: {} } }), undefined)
})

test('selectionForSession: 合法条目 trim 后透传（含/不含 effort）', () => {
  const pins = {
    s1: { provider: ' nvidia ', model: ' moonshotai/kimi-k3 ', reasoningEffort: ' max ' },
    s2: { provider: 'openrouter', model: 'x/y' },
  }
  assert.deepEqual(selectionForSession(pins, 's1'), { provider: 'nvidia', model: 'moonshotai/kimi-k3', reasoningEffort: 'max' })
  const s2 = selectionForSession(pins, 's2')
  assert.deepEqual(s2, { provider: 'openrouter', model: 'x/y' })
  assert.ok(!('reasoningEffort' in s2))
})

test('selectionForSession: 畸形表/条目一律 undefined', () => {
  assert.equal(selectionForSession(undefined, 's'), undefined)
  assert.equal(selectionForSession(null, 's'), undefined)
  assert.equal(selectionForSession({}, 's'), undefined)
  assert.equal(selectionForSession({}, undefined), undefined)
  assert.equal(selectionForSession({ s: null }, 's'), undefined)
  assert.equal(selectionForSession({ s: 'nope' }, 's'), undefined)
  assert.equal(selectionForSession({ s: { provider: '', model: 'm' } }, 's'), undefined)
  assert.equal(selectionForSession({ s: { provider: 'p', model: 42 } }, 's'), undefined)
})

test('被钉会话：内层改写成什么都被压回钉住的路由', async () => {
  const ctx = fakeCtx()
  installModelPin(ctx, { enabled: enabledOn, pins: () => ({ 'sess-a': PIN_A }), logger: ctx.logger })

  // 内层监听模拟官方 installModelSelection：把路由改成 claude（「被改回去」的场景）
  ctx.on('agent/request', async (_p, next) => {
    const resolved = await next()
    return { ...resolved, provider: 'agentrouter-claude', model: 'claude-opus-5', reasoningEffort: 'max' }
  })

  const out = await runWaterfall(ctx.listeners, { provider: 'seed', model: 'seed/m', maxTokens: 128000 }, agentPayload('sess-a'))
  assert.equal(out.provider, 'nvidia')
  assert.equal(out.model, 'kimi-k3')
  // 钉子无 effort → 清除继承的 effort（与官方语义一致），其余字段保留
  assert.equal(out.reasoningEffort, undefined)
  assert.equal(out.maxTokens, 128000)
})

test('未钉会话完全不受影响（会话隔离）', async () => {
  const ctx = fakeCtx()
  installModelPin(ctx, { enabled: enabledOn, pins: () => ({ 'sess-a': PIN_A }), logger: ctx.logger })

  // 内层监听模拟官方 installModelSelection：把路由改成 claude（「被改回去」的场景）
  ctx.on('agent/request', async (_p, next) => {
    const resolved = await next()
    return { ...resolved, provider: 'agentrouter-claude', model: 'claude-opus-5' }
  })

  const seed = { provider: 'agentrouter-claude', model: 'claude-opus-5', maxTokens: 1 }
  const outB = await runWaterfall(ctx.listeners, seed, agentPayload('sess-b'))
  assert.deepEqual(outB, seed)
  const outNone = await runWaterfall(ctx.listeners, seed, {}) // 无身份 payload
  assert.deepEqual(outNone, seed)
})

test('同路由不动作：保留内层决定的全部字段', async () => {
  const ctx = fakeCtx()
  installModelPin(ctx, { enabled: enabledOn, pins: () => ({ 'sess-a': { ...PIN_A, reasoningEffort: 'high' } }), logger: ctx.logger })

  const out = await runWaterfall(
    ctx.listeners,
    { provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'low', maxTokens: 99 },
    agentPayload('sess-a'),
  )
  assert.deepEqual(out, { provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'low', maxTokens: 99 })
})

test('钉子带 effort 时显式下发', async () => {
  const ctx = fakeCtx()
  installModelPin(ctx, { enabled: enabledOn, pins: () => ({ 'sess-a': { provider: 'a', model: 'b', reasoningEffort: 'medium' } }), logger: ctx.logger })

  const out = await runWaterfall(ctx.listeners, { provider: 'x', model: 'y', reasoningEffort: 'max' }, agentPayload('sess-a'))
  assert.equal(out.provider, 'a')
  assert.equal(out.reasoningEffort, 'medium')
})

test('开关关闭 / 表里无此会话 → 原样放行', async () => {
  const off = fakeCtx()
  installModelPin(off, { enabled: () => false, pins: () => ({ 'sess-a': PIN_A }), logger: off.logger })
  const seed = { provider: 'keep', model: 'keep' }
  assert.deepEqual(await runWaterfall(off.listeners, seed, agentPayload('sess-a')), seed)

  const emptyTable = fakeCtx()
  installModelPin(emptyTable, { enabled: enabledOn, pins: () => ({}), logger: emptyTable.logger })
  assert.deepEqual(await runWaterfall(emptyTable.listeners, seed, agentPayload('sess-zz')), seed)

  const broken = fakeCtx()
  installModelPin(broken, { enabled: enabledOn, pins: () => undefined, logger: broken.logger })
  assert.deepEqual(await runWaterfall(broken.listeners, seed, agentPayload('sess-a')), seed)
})

test('空路由（NO_ADAPTER 场景）也会被钉住', async () => {
  const ctx = fakeCtx()
  installModelPin(ctx, { enabled: enabledOn, pins: () => ({ 'sess-a': { provider: 'a', model: 'b' } }), logger: ctx.logger })
  const out = await runWaterfall(ctx.listeners, { provider: '', model: '' }, agentPayload('sess-a'))
  assert.deepEqual(out, { provider: 'a', model: 'b' })
})

test('日志限流按「会话+目标」：同目标不刷屏，换会话/换目标才宣告', async () => {
  const pins = { 'sess-a': { ...PIN_A }, 'sess-b': { ...PIN_A } }
  const ctx = fakeCtx()
  installModelPin(ctx, { enabled: enabledOn, pins: () => pins, logger: ctx.logger })

  await runWaterfall(ctx.listeners, { provider: 'old', model: 'old' }, agentPayload('sess-a')) // 宣告 sess-a→kimi
  await runWaterfall(ctx.listeners, { provider: 'old', model: 'old' }, agentPayload('sess-a')) // 重试同目标：不重复
  await runWaterfall(ctx.listeners, { provider: 'old', model: 'old' }, agentPayload('sess-b')) // 换会话：宣告
  pins['sess-a'].model = 'claude-opus-5' // 换目标：宣告
  await runWaterfall(ctx.listeners, { provider: 'old', model: 'old' }, agentPayload('sess-a'))

  const infos = ctx.logs.filter((a) => String(a[0]).includes('model-pin ['))
  assert.equal(infos.length, 3)
  assert.match(String(infos[0][0]), /sess-a.* -> nvidia\/kimi-k3$/)
  assert.match(String(infos[1][0]), /sess-b.* -> nvidia\/kimi-k3$/)
  assert.match(String(infos[2][0]), /sess-a.* -> nvidia\/claude-opus-5$/)
})

test('注销函数移除监听', async () => {
  const ctx = fakeCtx()
  const dispose = installModelPin(ctx, { enabled: enabledOn, pins: () => ({ 'sess-a': PIN_A }), logger: ctx.logger })
  assert.ok((ctx.listeners.get('agent/request') ?? []).length === 1)
  dispose()
  assert.equal((ctx.listeners.get('agent/request') ?? []).length, 0)
})
