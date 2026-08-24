/**
 * model-pin — 把「UI 里最后一次点选的模型」钉死成之后所有 LLM 请求的强制路由。
 *
 * 背景（2026-08 会话取证结论）：DSH 官方链路里，选择器写入的是 api-proxy 内一个
 * per-agent WeakMap 变量（`selectionFor(agent).current`），每个 step 组装请求时经
 * `agent/request` waterfall 覆盖到最终 config。该变量理论上只有 selectModel rpc
 * 一个写入点，但任何未来的/未知的代码路径一旦改写它，用户的选择就会静默丢失
 * （实际发生过一次：turn 错误结束后下一轮请求回到了 claude）。
 *
 * 本模块在更外层再压一道：
 *
 * - 数据源：官方 `selectModel` 每次都会把选择尽力保存进 settings 的
 *   `agent-default-model` namespace（@deepseek-ai/dsh-agent-default-model 所有，
 *   这里只读不写）。所以「用户最后点了什么」直接读 settings 即可，无需自己维护状态。
 * - 生效点：`ctx.on("agent/request", ...)`。cordis waterfall 语义是先注册者在最外层、
 *   最外层的返回值是最终结果；插件在启动时注册，早于任何 agent 创建，因此本监听
 *   位于所有内层覆盖（包括官方 installModelSelection）之外 —— `await next()` 之后
 *   改写即最后一锤定音。
 *
 * 结果：不管中间哪层把模型改成了什么，只要用户点过一次选择器，之后的每个请求都
 * 会被改写到那个模型上，直到用户下一次点选。
 *
 * 注意：这是全局钉（所有会话、含子代理会话）。标题生成等非 agent 链路不走这个
 * waterfall，天然不受影响。
 *
 * @module dsh-some-optimizations/pin
 */

/** 官方默认模型选择的 settings namespace（只读）。 */
export const PIN_SOURCE_NAMESPACE = 'agent-default-model'

/**
 * 从活的 settings 服务读出「应被钉住的选择」。
 * 不存在/格式不对时返回 undefined（此时放行原始路由）。
 *
 * @param {{ get?: (ns: unknown) => unknown } | undefined} settings - settings 服务。
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function desiredSelection(settings) {
  let section
  try {
    section = settings?.get?.(PIN_SOURCE_NAMESPACE)
  } catch {
    return undefined
  }
  if (typeof section !== 'object' || section === null) return undefined
  const provider = typeof section.provider === 'string' ? section.provider.trim() : ''
  const model = typeof section.model === 'string' ? section.model.trim() : ''
  if (!provider || !model) return undefined
  const rawEffort = typeof section.reasoningEffort === 'string' ? section.reasoningEffort.trim() : ''
  // ReasoningEffortId 在运行时是恒等函数，字符串可直接透传给 config。
  return rawEffort ? { provider, model, reasoningEffort: rawEffort } : { provider, model }
}

/**
 * 安装钉子监听。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} options
 * @param {() => boolean} options.enabled - 实时开关（设置面可热切）。
 * @param {Console | undefined} options.logger - 日志出口。
 * @returns {() => void} 注销函数。
 */
export function installModelPin(ctx, { enabled, logger }) {
  /** 最近一次已宣告的目标（限流日志：重试同目标不重复刷屏）。 */
  let announced

  const disposeRequest = ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    if (!enabled()) return resolved
    const want = desiredSelection(ctx.get('settings'))
    if (!want) return resolved
    if (resolved.provider === want.provider && resolved.model === want.model) return resolved

    // 路由不同：整体接管。官方语义是「所选无 effort 时清除继承的 effort」，
    // 这里保持一致；钉子里带了 effort 则显式下发。
    const { reasoningEffort: _inherited, ...rest } = resolved
    const merged = { ...rest, provider: want.provider, model: want.model }
    if (want.reasoningEffort !== undefined) merged.reasoningEffort = want.reasoningEffort
    const key = `${want.provider}/${want.model}`
    if (announced !== key) {
      announced = key
      const from = `${resolved.provider || '(none)'}/${resolved.model || '(none)'}`
      logger?.info?.(`some-optimizations model-pin: ${from} -> ${key}`)
    }
    return merged
  })

  // 点击落盘的即时回执（不等下一个请求）：直接回应「切换到底生效没有」。
  const disposeUpdated = ctx.on('settings/updated', (ns, nextValue) => {
    if (ns !== PIN_SOURCE_NAMESPACE) return
    if (typeof nextValue?.provider !== 'string' || typeof nextValue?.model !== 'string') return
    logger?.info?.(`some-optimizations model-pin: selection saved -> ${nextValue.provider}/${nextValue.model}`)
    announced = `${nextValue.provider}/${nextValue.model}`
  })

  return () => {
    disposeRequest()
    disposeUpdated()
  }
}
