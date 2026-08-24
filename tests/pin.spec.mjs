import test from 'node:test'
import assert from 'node:assert/strict'
import { desiredSelection, installModelPin, PIN_SOURCE_NAMESPACE } from '../lib/pin.js'

/** 最小 cordis ctx 替身：记录 on() 注册，支持注销。 */
function fakeCtx({ settings } = {}) {
  const listeners = new Map()
  const logs = []
  return {
    logs,
    logger: { info: (...a) => logs.push(a), warn: (...a) => logs.push(['warn', ...a]) },
    get(name) { return name === 'settings' ? settings : undefined },
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

const settingsWith = (section) => ({ get(ns) { return ns === PIN_SOURCE_NAMESPACE ? section : undefined } })
const enabledOn = () => true

test('desiredSelection: 合法 section 全量透传（含 effort）', () => {
  assert.deepEqual(
    desiredSelection(settingsWith({ provider: ' nvidia ', model: ' moonshotai/kimi-k3 ', reasoningEffort: 'max' })),
    { provider: 'nvidia', model: 'moonshotai/kimi-k3', reasoningEffort: 'max' },
  )
})

test('desiredSelection: 无 effort 字段时省略该键', () => {
  const want = desiredSelection(settingsWith({ provider: 'openrouter', model: 'x/y' }))
  assert.deepEqual(want, { provider: 'openrouter', model: 'x/y' })
  assert.ok(!('reasoningEffort' in want))
})

test('desiredSelection: 缺失/畸形/半空 section 一律 undefined', () => {
  assert.equal(desiredSelection(undefined), undefined)
  assert.equal(desiredSelection({}), undefined)
  assert.equal(desiredSelection(settingsWith(undefined)), undefined)
  assert.equal(desiredSelection(settingsWith(null)), undefined)
  assert.equal(desiredSelection(settingsWith('nope')), undefined)
  assert.equal(desiredSelection(settingsWith({ provider: '', model: 'm' })), undefined)
  assert.equal(desiredSelection(settingsWith({ provider: 'p', model: 42 })), undefined)
  // get 抛异常也不炸
  assert.equal(desiredSelection({ get() { throw new Error('boom') } }), undefined)
})

test('钉子压过内层覆盖：内层改写成什么都以最后点选为准', async () => {
  const ctx = fakeCtx({ settings: settingsWith({ provider: 'nvidia', model: 'kimi-k3' }) })
  installModelPin(ctx, { enabled: enabledOn, logger: ctx.logger })

  // 内层监听模拟官方 installModelSelection：把路由改成 claude（即「被改回去」的场景）
  const inner = async (_p, next) => {
    const resolved = await next()
    return { ...resolved, provider: 'agentrouter-claude', model: 'claude-opus-5', reasoningEffort: 'max' }
  }
  ctx.on('agent/request', inner)

  // 先注册的 pin 在最外层 → 最终返回值由 pin 决定
  const out = await runWaterfall(ctx.listeners, { provider: 'seed', model: 'seed/m', maxTokens: 128000 })
  assert.equal(out.provider, 'nvidia')
  assert.equal(out.model, 'kimi-k3')
  // 钉子无 effort → 清除继承的 effort（与官方语义一致），其余字段保留
  assert.equal(out.reasoningEffort, undefined)
  assert.equal(out.maxTokens, 128000)
})

test('同路由不动作：保留内层决定的全部字段', async () => {
  const ctx = fakeCtx({ settings: settingsWith({ provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'high' }) })
  installModelPin(ctx, { enabled: enabledOn, logger: ctx.logger })

  const out = await runWaterfall(ctx.listeners, {
    provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'low', maxTokens: 99,
  })
  assert.deepEqual(out, { provider: 'nvidia', model: 'kimi-k3', reasoningEffort: 'low', maxTokens: 99 })
})

test('钉子带 effort 时显式下发', async () => {
  const ctx = fakeCtx({ settings: settingsWith({ provider: 'a', model: 'b', reasoningEffort: 'medium' }) })
  installModelPin(ctx, { enabled: enabledOn, logger: ctx.logger })

  const out = await runWaterfall(ctx.listeners, { provider: 'x', model: 'y', reasoningEffort: 'max' })
  assert.equal(out.reasoningEffort, 'medium')
  assert.equal(out.provider, 'a')
})

test('开关关闭 / 无 settings 服务 / namespace 未注册 → 原样放行', async () => {
  const off = fakeCtx({ settings: settingsWith({ provider: 'a', model: 'b' }) })
  installModelPin(off, { enabled: () => false, logger: off.logger })
  const seed = { provider: 'keep', model: 'keep' }
  assert.deepEqual(await runWaterfall(off.listeners, seed), seed)

  const noSettings = fakeCtx({ settings: undefined })
  installModelPin(noSettings, { enabled: enabledOn, logger: noSettings.logger })
  assert.deepEqual(await runWaterfall(noSettings.listeners, seed), seed)

  const unregistered = fakeCtx({ settings: { get: () => undefined } })
  installModelPin(unregistered, { enabled: enabledOn, logger: unregistered.logger })
  assert.deepEqual(await runWaterfall(unregistered.listeners, seed), seed)
})

test('空路由（NO_ADAPTER 场景）也会被钉住', async () => {
  const ctx = fakeCtx({ settings: settingsWith({ provider: 'a', model: 'b' }) })
  installModelPin(ctx, { enabled: enabledOn, logger: ctx.logger })
  const out = await runWaterfall(ctx.listeners, { provider: '', model: '' })
  assert.deepEqual(out, { provider: 'a', model: 'b' })
})

test('切换目标后新目标生效；日志限流（重试同目标不刷屏）', async () => {
  const currentSection = { provider: 'nvidia', model: 'kimi-k3' }
  const ctx = fakeCtx({ settings: { get: (ns) => (ns === PIN_SOURCE_NAMESPACE ? currentSection : undefined) } })
  installModelPin(ctx, { enabled: enabledOn, logger: ctx.logger })

  await runWaterfall(ctx.listeners, { provider: 'old', model: 'old' })   // 第一次：宣告 kimi
  await runWaterfall(ctx.listeners, { provider: 'old', model: 'old' })   // 重试同目标：不重复
  currentSection.model = 'claude-opus-5'
  await runWaterfall(ctx.listeners, { provider: 'old', model: 'old' })   // 切换：宣告新目标

  const pins = ctx.logs.filter((a) => String(a[0]).includes('model-pin:') && !String(a[0]).includes('saved'))
  assert.equal(pins.length, 2)
  assert.match(String(pins[0][0]), /-> nvidia\/kimi-k3$/)
  assert.match(String(pins[1][0]), /-> nvidia\/claude-opus-5$/)
})

test('settings/updated 回执：保存选择即刻确认', async () => {
  const ctx = fakeCtx({})
  installModelPin(ctx, { enabled: enabledOn, logger: ctx.logger })
  for (const cb of ctx.listeners.get('settings/updated') ?? []) {
    cb(PIN_SOURCE_NAMESPACE, { provider: 'nvidia', model: 'moonshotai/kimi-k3' })
    cb('some-other-ns', { provider: 'x', model: 'y' })
  }
  const saved = ctx.logs.filter((a) => String(a[0]).includes('saved'))
  assert.equal(saved.length, 1)
  assert.match(String(saved[0][0]), /selection saved -> nvidia\/moonshotai\/kimi-k3/)
})

test('注销函数移除两个监听', async () => {
  const ctx = fakeCtx({ settings: settingsWith({ provider: 'a', model: 'b' }) })
  const dispose = installModelPin(ctx, { enabled: enabledOn, logger: ctx.logger })
  assert.ok((ctx.listeners.get('agent/request') ?? []).length >= 1)
  assert.ok((ctx.listeners.get('settings/updated') ?? []).length >= 1)
  dispose()
  assert.equal((ctx.listeners.get('agent/request') ?? []).length, 0)
  assert.equal((ctx.listeners.get('settings/updated') ?? []).length, 0)
})
