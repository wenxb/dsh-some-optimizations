import test from 'node:test'
import assert from 'node:assert/strict'

import { orphanIds, installProjectionCacheGc } from '../lib/projcache-gc.js'

test('orphanIds 删除持久化里已不存在的 key', () => {
  const orphans = orphanIds(
    ['session-a', 'session-b', 'session-c'],
    ['session-b', 'session-d'],
  )
  assert.deepEqual(orphans, ['session-a', 'session-c'])
})

test('orphanIds 空存活集 → 全部视为孤儿（调用方需自行设护栏）', () => {
  assert.deepEqual(orphanIds(['a', 'b'], []), ['a', 'b'])
})

test('orphanIds 空缓存 → 空结果', () => {
  assert.deepEqual(orphanIds([], ['a']), [])
})

test('orphanIds 忽略非字符串 id 并保持缓存侧顺序', () => {
  // @ts-expect-error 运行时防御：header.id 可能缺省。
  const orphans = orphanIds(['z', 'm', 'a'], [undefined, null, 42, 'a', 'z'])
  assert.deepEqual(orphans, ['m'])
})

test('orphanIds 不修改入参', () => {
  const keys = ['x', 'y']
  const ids = ['y']
  orphanIds(keys, ids)
  assert.deepEqual(keys, ['x', 'y'])
  assert.deepEqual(ids, ['y'])
})

test('installProjectionCacheGc 注销后不再触发 tick，且域未挂载时静默跳过', async () => {
  let ticks = 0
  const storageDomain = {
    get(name) {
      ticks += 1
      return undefined // 模拟 projection-cache 尚未挂载
    },
  }
  const ctx = { storageDomain, sessionPersistence: { list: async () => [] } }
  const logger = { warn() {}, info() {} }

  // graceMs=1ms、intervalMs 下限被钳到 60s：注销后循环必须终止。
  const dispose = installProjectionCacheGc(ctx, {
    enabled: () => true,
    intervalMs: () => 60_000,
    graceMs: 1,
    logger,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  dispose()
  const after = ticks
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(ticks, after)
  assert.ok(after >= 1) // 至少跑过一轮宽限 tick。
})

test('空基线护栏：persistence.list() 为空数组时整轮放弃且不删任何行', async () => {
  const deleted = []
  const table = {
    keys: () => ['ghost-1', 'live-1'].values(),
    delete: async (id) => {
      deleted.push(id)
      return true
    },
  }
  const ctx = {
    storageDomain: { get: () => ({ table: () => table }) },
    sessionPersistence: { list: async () => [] }, // 异常空基线
  }
  const warnings = []
  const dispose = installProjectionCacheGc(ctx, {
    enabled: () => true,
    intervalMs: () => 60_000_000, // 只允许宽限那一轮跑。
    graceMs: 1,
    logger: { warn: (msg) => warnings.push(msg), info() {} },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  dispose()
  assert.deepEqual(deleted, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /empty persistence baseline/)
})
