/**
 * model-pin（会话作用域）—— 在某个会话里点选的模型，钉死为该会话之后所有请求
 * 的强制路由；其他会话完全不受影响。
 *
 * 数据流：
 *   浏览器端 client.js 的 fetch fence 观察到 `session.selectModel` rpc
 *   → POST /dsh-some-optimizations/click {sessionId, provider, model, …}
 *   → 宿主半边 upsert 进 pins 存储（~/.dsh/some-optimizations-pins.json，LRU 100 条）
 *   → 本模块的全局 `agent/request` 监听按 payload.agent.session.id 查表，
 *     只改写命中会话的路由。
 *
 * 身份依据（源码取证）：agentEvents 把 agent 融进每个事件 payload
 * （@deepseek-ai/dsh-agent/lib/index.js:336 `fused = (payload) => ({...payload, agent})`），
 * 而 agent.session.id 即会话 id。拿不到身份时一律放行——宁可不钉，不误伤。
 *
 * 生效点：插件启动期注册的全局 waterfall 监听 ⇒ cordis 先注册者在最外层，
 * `await next()` 之后改写即最后一锤定音（盖过官方 installModelSelection）。
 *
 * @module dsh-some-optimizations/pin
 */

/**
 * 从 fused waterfall payload 里尽力解析会话 id。
 * @param {unknown} payload - `agent/request` waterfall 的 payload。
 * @returns {string | undefined}
 */
export function sessionIdOf(payload) {
  const candidates = [payload?.agent, payload?.turn?.agent, payload?.step?.agent]
  for (const agent of candidates) {
    const id = agent?.session?.id
    if (typeof id === 'string' && id) return id
  }
  return undefined
}

/**
 * 查某会话应被钉住的选择；表缺失/条目格式不对返回 undefined（放行）。
 * @param {Record<string, unknown>} pins - sessionId → selection 映射。
 * @param {string | undefined} sessionId
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function selectionForSession(pins, sessionId) {
  if (typeof pins !== 'object' || pins === null || !sessionId) return undefined
  const entry = pins[sessionId]
  if (typeof entry !== 'object' || entry === null) return undefined
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
  const model = typeof entry.model === 'string' ? entry.model.trim() : ''
  if (!provider || !model) return undefined
  const rawEffort = typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort.trim() : ''
  // ReasoningEffortId 运行时恒等，字符串可直接透传给 config。
  return rawEffort ? { provider, model, reasoningEffort: rawEffort } : { provider, model }
}

/**
 * 安装会话级钉子监听。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} options
 * @param {() => boolean} options.enabled - 实时总开关（设置面可热切）。
 * @param {() => Record<string, unknown>} options.pins - 活的 sessionId→selection 表。
 * @param {Console | undefined} options.logger - 日志出口。
 * @returns {() => void} 注销函数。
 */
export function installModelPin(ctx, { enabled, pins, logger }) {
  /** 最近一次已宣告目标 `${sessionId}:${provider}/${model}`（限流日志）。 */
  let announced

  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    if (!enabled()) return resolved
    const sessionId = sessionIdOf(payload)
    if (!sessionId) return resolved
    const want = selectionForSession(pins(), sessionId)
    if (!want) return resolved
    if (resolved.provider === want.provider && resolved.model === want.model) return resolved

    // 路由不同：整体接管。官方语义是「所选无 effort 时清除继承的 effort」；
    // 钉子里带了 effort 则显式下发。
    const { reasoningEffort: _inherited, ...rest } = resolved
    const merged = { ...rest, provider: want.provider, model: want.model }
    if (want.reasoningEffort !== undefined) merged.reasoningEffort = want.reasoningEffort

    const key = `${sessionId}:${want.provider}/${want.model}`
    if (announced !== key) {
      announced = key
      const from = `${resolved.provider || '(none)'}/${resolved.model || '(none)'}`
      logger?.info?.(`some-optimizations model-pin [${sessionId.slice(0, 8)}]: ${from} -> ${want.provider}/${want.model}`)
    }
    return merged
  })

  return disposeRequest
}
