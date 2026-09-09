/**
 * projcache-gc —— session_projcache 域的孤儿行回收。
 *
 * 背景（源码取证）：
 * - @deepseek-ai/dsh-session-projection-cache 把每个会话的投影检查点写成
 *   storages/session_projcache.json 里的一行（tables.sessions.<sessionId>），
 *   其 README「已知局限」明说不提供淘汰/保留接口——记录按会话持续累积，
 *   清理属于带外维护。孤儿行（持久化里已无对应日志的会话）会永远留在文件里；
 *   而该域每次行更新都全量重写整个文件 ⇒ 文件越大、廉价 SSD 上的持续 iowait
 *   越重（实测 50MB 缓存把一块 SATA SSD 压到 77% 忙碌）。
 *
 * 本模块做的事：
 *   周期性对比「缓存表 keys」与「sessionPersistence.list() 的存活 id 集」，
 *   删除前者中已无归宿的 key。删除走 storageDomain.get('session_projcache')
 *   返回的【共享打开句柄】——DomainFacility 对每个域名强制 single-open，
 *   get() 是官方诊断面，拿到的是 projection-cache 插件正在用的同一个运行态：
 *   删除立即反映到其内存 records，并由 json 后端按既有节流原子落盘。
 *   不绕过、不复制任何内部状态。
 *
 * 安全设计（与宿主 fail-soft 语义对齐）：
 *   - 官方契约「缓存行绝不当权威」：可能陈旧但绝不会错，ver 不匹配读取时即
 *     丢弃。删行的唯一代价是下次冷读多回放一段日志——方向一致，绝不产生错值。
 *   - persistence.list() 抛错 → 整轮跳过。
 *   - list() 返回空集而缓存非空 → 视为基线异常（后端迁移/故障），同样跳过。
 *     宁可不删，不误伤全场。
 *
 * @module dsh-some-optimizations/projcache-gc
 */

/** 域名：与 @deepseek-ai/dsh-session-projection-cache 的 spec.name 一致。 */
export const PROJECTION_CACHE_DOMAIN = 'session_projcache'

/**
 * 计算应回收的孤儿 key。
 * @param {readonly string[]} cacheKeys - 缓存表现有 key。
 * @param {readonly (string | undefined)[]} persistentIds - 持久化层仍存活的会话 id。
 * @returns {string[]} 孤儿 key（保持入参顺序）。
 */
export function orphanIds(cacheKeys, persistentIds) {
  const alive = new Set()
  for (const id of persistentIds) if (typeof id === 'string' && id) alive.add(id)
  const out = []
  for (const key of cacheKeys) if (!alive.has(key)) out.push(key)
  return out
}

/**
 * 安装周期 GC。递归 setTimeout 驱动，每轮实时读开关与节奏（设置面热切生效）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} options
 * @param {() => boolean} options.enabled - 实时总开关（设置面可热切）。
 * @param {() => number} options.intervalMs - 实时节奏毫秒；下限 60s。
 * @param {number} [options.graceMs=60000] - 启动宽限：等 projection-cache 完成挂载。
 * @param {Console | undefined} options.logger - 日志出口。
 * @returns {() => void} 注销函数：停表并丢弃未触发的首轮。
 */
export function installProjectionCacheGc(ctx, { enabled, intervalMs, graceMs = 60_000, logger }) {
  let disposed = false
  let busy = false
  const pending = new Set()

  async function tick() {
    if (busy || disposed || !enabled()) return
    busy = true
    try {
      // 服务未挂载（storage-domain/projection-cache 被禁用）时静默跳过，
      // 下轮再试——不视为错误。
      const domain = ctx.storageDomain?.get?.(PROJECTION_CACHE_DOMAIN)
      if (!domain || !ctx.sessionPersistence?.list) return

      const table = domain.table('sessions')
      const cacheKeys = [...table.keys()]
      if (cacheKeys.length === 0) return

      const headers = await ctx.sessionPersistence.list()
      // 空基线护栏：持久化一个会话都没有而缓存非空，几乎必然是后端异常或
      // 正在迁移——整轮放弃，绝不据此清场。
      if (!Array.isArray(headers) || headers.length === 0) {
        logger?.warn?.('some-optimizations projcache-gc: empty persistence baseline while cache has rows; skipping cycle')
        return
      }

      const orphans = orphanIds(cacheKeys, headers.map((header) => header?.id))
      if (orphans.length === 0) return

      let deleted = 0
      for (const id of orphans) {
        try {
          if (await table.delete(id)) deleted += 1
        } catch (error) {
          logger?.warn?.(`some-optimizations projcache-gc: delete ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (deleted > 0) {
        logger?.info?.(`some-optimizations projcache-gc: reclaimed ${deleted}/${cacheKeys.length} orphaned checkpoint rows`)
      }
    } catch (error) {
      logger?.warn?.(`some-optimizations projcache-gc: cycle skipped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy = false
    }
  }

  function schedule(delayMs) {
    const t = setTimeout(() => {
      pending.delete(t)
      void tick().finally(() => {
        if (!disposed) schedule(Math.max(60_000, intervalMs()))
      })
    }, delayMs)
    // 后台回收不该拖住宿主进程退出（也让测试进程能自然结束）。
    t.unref?.()
    pending.add(t)
  }
  schedule(graceMs)

  return () => {
    disposed = true
    for (const t of pending) clearTimeout(t)
    pending.clear()
  }
}
