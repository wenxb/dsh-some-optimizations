/**
 * image-shed 回归测试（v2 滚动保留策略）。
 *
 * 规则：全表面只保留最新 `keepLatest` 个图片块（默认 2），更老的按宿主持久化
 * 替换协议换成文本占位符。事件内的数组次序即时间次序（末位最新）。fixture
 * 复刻真实 DSH 形状（session f99704f5 取证：tool-result 嵌套 content 内的
 * {type:'image',attachment:{…}}，检查点为 source.plugin==='compact' 的
 * user/message），协议字段对齐宿主 dsh-compaction-tool-result-pruner。
 * @module dsh-some-optimizations/imageshed.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isImageBlock,
  describeImageBlock,
  shedImagesInContent,
  estimateHostContent,
  hostPriceEvent,
  shadowedTokensViaMeter,
  shedToLatestImages,
  installImageShed,
} from '../lib/imageshed.js'

// ── 最小宿主会话替身：append-only 日志 + 表面折叠（replace 语义）─────────

/** @returns {any} */
function makeSession(initial = []) {
  const session = {
    events: [],
    /** 表面节点（seq 折叠序）。 */
    surface: { nodes: [] },
    /** @type {{type:string,data:any,opts:any,seq:number}[]} */
    appended: [],
    append(type, data, opts = {}) {
      const seq = session.events.length
      session.events.push({ type, data, seq })
      const op = opts?.surfaceOp
      if (op && op.op === 'replace') {
        const startIdx = session.surface.nodes.indexOf(op.start)
        const endIdx = session.surface.nodes.indexOf(op.end)
        assert.ok(startIdx >= 0 && endIdx >= startIdx, `replace span ${op.start}..${op.end} not on surface`)
        session.surface.nodes.splice(startIdx, endIdx - startIdx + 1, seq)
      } else if (['user/message', 'assistant/message', 'tool/result'].includes(type)) {
        session.surface.nodes.push(seq)
      }
      session.appended.push({ type, data, opts, seq })
      return { seq }
    },
  }
  for (const event of initial) session.append(event.type, event.data)
  return session
}

const attImage = (hash, name, bytes, w, h) => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${hash}`, mediaType: 'image/png', bytes, width: w, height: h, name },
})
const inlineImage = () => ({ type: 'image', mimeType: 'image/jpeg', data: 'QUJDREVG' /* 8 b64 chars ≈ 6B */ })

const userText = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const checkpoint = () => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text: '[summary]' }], source: { plugin: 'compact', compactionId: 'c-1' } },
})
/** 真实形状：tool-result 块内嵌 text + 图片。 */
const shotToolResult = (hash, name) => ({
  type: 'tool/result',
  data: {
    message: {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: `call-${hash.slice(0, 4)}`,
        content: [{ type: 'text', text: 'screenshot captured' }, attImage(hash, name, 452859, 1280, 800)],
      }],
      source: { callId: `call-${hash.slice(0, 4)}` },
    },
  },
})

/** 组装：两张旧图 → 压缩检查点 → 一张新图（共 3 张，超出配额 1 张）。 */
function seededSession() {
  return makeSession([
    userText('hello'),
    shotToolResult('a'.repeat(64), 'old-a.png'),
    shotToolResult('b'.repeat(64), 'old-b.png'),
    checkpoint(),
    shotToolResult('c'.repeat(64), 'fresh.png'),
  ])
}

const flushMicrotasks = async () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)))

// ── 形态判定与占位符 ──────────────────────────────────────────────────

test('isImageBlock covers attachment-ref / inline / wire forms', () => {
  assert.equal(isImageBlock(attImage('f'.repeat(64), 'x.png', 1, 1, 1)), true)
  assert.equal(isImageBlock(inlineImage()), true)
  assert.equal(isImageBlock({ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }), true)
  assert.equal(isImageBlock({ source: { type: 'base64', media_type: 'image/webp' } }), true)
  assert.equal(isImageBlock({ type: 'text', text: 'nope' }), false)
  assert.equal(isImageBlock(null), false)
})

test('describeImageBlock keeps minimal clues only (no payload)', () => {
  const text = describeImageBlock(attImage(`${'96d9d62c'}${'0'.repeat(56)}`, 'browser-screenshot.png', 956084, 1280, 800))
  assert.match(text, /^\[image pruned by some-optimizations: browser-screenshot\.png image\/png 934KB 1280x800 96d9d62c\]$/)
  assert.ok(!text.includes('base64'))
})

test('shedImagesInContent replaces every image form, honours the keep-set', () => {
  const original = {
    role: 'tool',
    content: [
      { type: 'text', text: 'keep me 整' },
      attImage('a'.repeat(64), 'a.png', 10, 1, 1),
      attImage('b'.repeat(64), 'b.png', 10, 1, 1),
      { type: 'tool-result', toolCallId: 't', content: [inlineImage(), { type: 'text', text: 'inner' }] },
    ],
  }
  // 无豁免：全部替换。
  const full = shedImagesInContent(original.content)
  assert.equal(full.removed.length, 3)
  assert.match(full.content[1].text, /^\[image pruned/)
  // 有豁免：a.png 保留、b.png 与内联图替换。
  const keepA = new WeakSet([original.content[1]])
  const partial = shedImagesInContent(original.content, keepA)
  assert.equal(partial.removed.length, 2)
  assert.equal(partial.content[1].type, 'image')
  assert.equal(partial.content[1].attachment.name, 'a.png')
  assert.match(partial.content[2].text, /^\[image pruned by some-optimizations: b\.png/)
  assert.match(partial.content[3].content[0].text, /^\[image pruned/)
  // 输入未被改动。
  assert.equal(original.content[2].type, 'image')
})

// ── 宿主词汇表计价镜像（rule 12）：手算常量 ────────────────────────────

test('estimateHostContent matches the flat-4 host estimator exactly', () => {
  // 字符串 content：每字符落默认分支 4+ceil(len(JSON.stringify(ch))/4)=4+1=5。
  assert.equal(estimateHostContent('abc'), 15)
  // text 块：ceil(4/4)+4=5。
  assert.equal(estimateHostContent([{ type: 'text', text: 'abcd' }]), 5)
})

test('hostPriceEvent mirrors deriveEventMessage edge cases', () => {
  // assistant 空 content → null → 0。
  assert.equal(hostPriceEvent({ type: 'assistant/message', data: { message: { content: [] } } }), 0)
  // 非表面事件 → 0。
  assert.equal(hostPriceEvent({ type: 'turn/start', data: { turn: 1 } }), 0)
  // tool/result 手算（fixture 文本 'screenshot captured'=19 字符，图片块 JSON=200 字符）：
  // role=4；tool-result 块=4；内层 text=ceil(19/4)+4=9；图片默认分支=4+ceil(200/4)=54 ⇒ 71。
  const ev = shotToolResult('e'.repeat(64), 'x.png')
  const imgBlock = ev.data.message.content[0].content[1]
  const expected =
    4 /* role */ +
    4 /* tool-result 块 */ +
    (Math.ceil('screenshot captured'.length / 4) + 4) +
    (4 + Math.ceil(JSON.stringify(imgBlock).length / 4))
  assert.equal(hostPriceEvent(ev), expected)
  assert.equal(hostPriceEvent(ev), 71)
})

test('shadowedTokensViaMeter prefers live meter prices, falls back to mirror', () => {
  const session = seededSession()
  const targetSeq = session.surface.nodes[1]
  const meter = { measure: () => ({ nodes: session.events.map((event) => ({ seq: event.seq, tokens: 77 })) }) }
  assert.equal(shadowedTokensViaMeter(session, [targetSeq], { get: (n) => (n === 'tokenMeter' ? meter : undefined) }), 77)
  // meter 缺失 → 镜像。
  assert.equal(shadowedTokensViaMeter(session, [targetSeq], undefined), hostPriceEvent(session.events[targetSeq]))
  // meter 覆盖不全 → 回落镜像。
  assert.equal(shadowedTokensViaMeter(session, [targetSeq], { get: () => undefined }), hostPriceEvent(session.events[targetSeq]))
})

// ── 滚动主扫描：配额、协议、部分替换、幂等 ─────────────────────────────

test('keeps only the newest N images across checkpoints; protocol pairs stay adjacent', () => {
  const session = seededSession() // 表面：hello, old-a, old-b, checkpoint, fresh —— 3 张图
  const result = shedToLatestImages(session, 2, undefined)

  // 最新两块是 fresh(c) 与 old-b；old-a 超额被 shed——即使它在检查点之前。
  assert.deepEqual(result, { shedEvents: 1, images: 1 })

  // 协议：一条 compaction/prune（claim>0 且等于整节点镜像价）+ 相邻同类型替换。
  const prunes = session.appended.filter((entry) => entry.type === 'compaction/prune')
  assert.equal(prunes.length, 1)
  const prune = prunes[0]
  const targetSeq = prune.data.shadowedSeqs[0]
  assert.equal(session.events[targetSeq].data.message.content[0].content[1].attachment.name, 'old-a.png')
  assert.equal(prune.data.shadowedTokenCount, hostPriceEvent(session.events[targetSeq]))
  assert.ok(prune.data.shadowedTokenCount > 0)
  assert.deepEqual(prune.data.shadowedRange, { start: targetSeq, end: targetSeq })

  const replacements = session.appended.filter((candidate) => candidate.opts.sourceEventSeqs?.[0] === targetSeq)
  assert.equal(replacements.length, 1)
  const replacement = replacements[0]
  assert.equal(replacement.type, 'tool/result')
  assert.deepEqual(replacement.opts.surfaceOp, { op: 'replace', start: targetSeq, end: targetSeq })
  // 消息壳不动：source.callId 与 toolCallId 保留 ⇒ 配对不破。
  assert.equal(replacement.data.message.source.callId, session.events[targetSeq].data.message.source.callId)
  assert.equal(replacement.data.message.content[0].toolCallId, session.events[targetSeq].data.message.content[0].toolCallId)
  // 图片已变占位符、兄弟文本原样。
  const inner = replacement.data.message.content[0]
  assert.equal(inner.content.some((block) => isImageBlock(block)), false)
  assert.match(inner.content.find((block) => block.type === 'text' && block.text.startsWith('[image pruned'))?.text ?? '', /\[image pruned by some-optimizations: old-a\.png image\/png 442KB 1280x800/)
  assert.ok(inner.content.some((block) => block.type === 'text' && block.text === 'screenshot captured'))

  // 幂等：再跑一遍零改动、零追加。
  const before = session.appended.length
  assert.deepEqual(shedToLatestImages(session, 2, undefined), { shedEvents: 0, images: 0 })
  assert.equal(session.appended.length, before)
})

test('a newer event holding two blocks rolls the oldest single image out', () => {
  const session = makeSession([
    shotToolResult('1'.repeat(64), 'one.png'),
    checkpoint(),
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-two',
            content: [attImage('2'.repeat(64), 'two-a.png', 10, 1, 1), attImage('3'.repeat(64), 'two-b.png', 10, 1, 1), { type: 'text', text: 'pair' }],
          }],
          source: { callId: 'call-two' },
        },
      },
    },
  ])
  // 配额按块计数：全表 3 块 > 2 ⇒ 最老的 one.png 出局，新事件里的两块都保留。
  assert.deepEqual(shedToLatestImages(session, 2, undefined), { shedEvents: 1, images: 1 })
  const replacedName = session.events[session.surface.nodes[0]].data.message.content[0].content[1]?.attachment?.name
  assert.equal(replacedName, undefined) // 已变占位符
  assert.match(session.events[session.surface.nodes[0]].data.message.content[0].content[1].text, /one\.png/)
})

test('partial replacement inside ONE event: first-in-array shed, later two kept', () => {
  const session = makeSession([
    checkpoint(),
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'call-tri',
            content: [
              attImage('a'.repeat(64), 'tri-a.png', 10, 1, 1),
              attImage('b'.repeat(64), 'tri-b.png', 10, 1, 1),
              attImage('c'.repeat(64), 'tri-c.png', 10, 1, 1),
              { type: 'text', text: 'burst of shots' },
            ],
          }],
          source: { callId: 'call-tri' },
        },
      },
    },
  ])
  assert.deepEqual(shedToLatestImages(session, 2, undefined), { shedEvents: 1, images: 1 })
  const replacement = session.appended.find((entry) => entry.opts.sourceEventSeqs !== undefined)
  assert.equal(replacement.type, 'tool/result')
  const inner = replacement.data.message.content[0]
  // 数组末两位 = 最新两块，原样保留；首位超员，换占位符。
  assert.equal(inner.content[0].type, 'text')
  assert.match(inner.content[0].text, /tri-a\.png/)
  assert.equal(inner.content[1].attachment.name, 'tri-b.png')
  assert.equal(inner.content[2].attachment.name, 'tri-c.png')
  assert.ok(inner.content.some((block) => block.type === 'text' && block.text === 'burst of shots'))
  // claim = 整个原节点的宿主价（部分替换也按整节点对账，折叠公式 delta=新价−claim）。
  const prune = session.appended.find((entry) => entry.type === 'compaction/prune')
  assert.equal(prune.data.shadowedTokenCount, hostPriceEvent(session.events[prune.data.shadowedSeqs[0]]))
})

test('rolling: appending a newer image sheds the previous oldest one; no checkpoint involved', () => {
  const session = makeSession([
    shotToolResult('1'.repeat(64), 'first.png'),
    shotToolResult('2'.repeat(64), 'second.png'),
  ])
  assert.deepEqual(shedToLatestImages(session, 2, undefined), { shedEvents: 0, images: 0 })
  // 第三张到来 → first.png 立刻超额。
  session.append('tool/result', shotToolResult('3'.repeat(64), 'third.png').data)
  assert.deepEqual(shedToLatestImages(session, 2, undefined), { shedEvents: 1, images: 1 })
  assert.equal(session.events[session.surface.nodes[0]].data.message.content[0].content[1]?.attachment?.name, undefined)
  assert.match(session.events[session.surface.nodes[0]].data.message.content[0].content[1].text, /first\.png/)
})

test('zero quota sheds every image; empty surface is a no-op', () => {
  const killAll = makeSession([
    shotToolResult('1'.repeat(64), 'one.png'),
    shotToolResult('2'.repeat(64), 'two.png'),
  ])
  assert.deepEqual(shedToLatestImages(killAll, 0, undefined), { shedEvents: 2, images: 2 })
  const bare = makeSession([userText('no images at all')])
  assert.deepEqual(shedToLatestImages(bare, 2, undefined), { shedEvents: 0, images: 0 })
})

test('installImageShed: compaction landing triggers a deferred pass; toggle and errors fail soft', async () => {
  const listeners = {}
  const fakeCtx = {
    on(name, fn) {
      listeners[name] = fn
      return () => delete listeners[name]
    },
  }
  let on = true
  let keep = 2
  const logs = []
  const dispose = installImageShed(fakeCtx, {
    enabled: () => on,
    keepLatest: () => keep,
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) },
  })
  assert.equal(typeof listeners['session/event'], 'function')

  const session = seededSession()
  listeners['session/event'](session, { type: 'compaction/summary', data: {} })
  await flushMicrotasks()
  assert.ok(logs.some((line) => line.includes('kept latest 2 image block(s), pruned 1 older one(s)')))
  assert.equal(session.appended.filter((entry) => entry.type === 'compaction/prune').length, 1)

  // 关掉：不写任何东西（幂等扫描本来也无事可做，用重置过的会话验证开关真拦住了写入）。
  on = false
  const fresh = makeSession([shotToolResult('1'.repeat(64), 'x.png'), shotToolResult('2'.repeat(64), 'y.png'), shotToolResult('3'.repeat(64), 'z.png')])
  listeners['session/event'](fresh, { type: 'compaction/summary', data: {} })
  await flushMicrotasks()
  assert.equal(fresh.appended.filter((entry) => entry.type === 'compaction/prune').length, 0)

  // 非 trigger 事件不触发；抛错的会话只 warn 不炸。
  on = true
  listeners['session/event']({ get surface() { throw new Error('boom') } }, { type: 'turn/start', data: {} })
  await flushMicrotasks()
  assert.ok(!logs.some((line) => line.includes('boom')))
  listeners['session/event']({ get surface() { throw new Error('boom') } }, { type: 'compaction/summary', data: {} })
  await flushMicrotasks()
  assert.ok(logs.some((line) => line.startsWith('WARN some-optimizations image-shed skipped: boom')))

  dispose()
})

test('installImageShed: a NEW image append rolls the oldest out automatically', async () => {
  const listeners = {}
  const fakeCtx = { on(name, fn) { listeners[name] = fn; return () => delete listeners[name] } }
  const logs = []
  installImageShed(fakeCtx, { enabled: () => true, keepLatest: () => 2, logger: { info: (line) => logs.push(line) } })

  const session = makeSession([
    shotToolResult('1'.repeat(64), 'first.png'),
    shotToolResult('2'.repeat(64), 'second.png'),
  ])
  // 第三张作为表面事件落地 → 微任务里自动滚动掉第一张。
  const third = shotToolResult('3'.repeat(64), 'third.png')
  session.append('tool/result', third.data)
  listeners['session/event'](session, { type: 'tool/result', data: third.data })
  await flushMicrotasks()

  assert.equal(session.appended.filter((entry) => entry.type === 'compaction/prune').length, 1)
  assert.match(session.events[session.surface.nodes[0]].data.message.content[0].content[1].text, /first\.png/)
  assert.ok(logs.some((line) => line.includes('kept latest 2')))
})

test('performance: one meter.measure per pass; idle re-triggers skip the scan entirely', async () => {
  const listeners = {}
  let measures = 0
  const session = makeSession([
    shotToolResult('1'.repeat(64), 'one.png'),
    shotToolResult('2'.repeat(64), 'two.png'),
    shotToolResult('3'.repeat(64), 'three.png'),
    shotToolResult('4'.repeat(64), 'four.png'),
  ])
  let keep = 2
  const fakeCtx = {
    on(name, fn) { listeners[name] = fn; return () => delete listeners[name] },
    get tokenMeter() {
      measures += 1
      return { measure: (s) => ({ nodes: s.events.map((event) => ({ seq: event.seq, tokens: 42 })) }) }
    },
  }
  const dispose = installImageShed(fakeCtx, { enabled: () => true, keepLatest: () => keep, logger: undefined })

  // 首轮：4 张图超配额 2，shed 最老两张 —— measure 只允许调用一次（批量）。
  listeners['session/event'](session, { type: 'tool/result', data: {} })
  await flushMicrotasks()
  assert.equal(session.appended.filter((entry) => entry.type === 'compaction/prune').length, 2)
  assert.equal(session.appended.filter((entry) => entry.type === 'compaction/prune')[0].data.shadowedTokenCount, 42)
  assert.equal(measures, 1)

  // 空闲重触发（表面尾 seq 未变）：memo 命中，连 measure 都不再发生。
  listeners['session/event'](session, { type: 'compaction/summary', data: {} })
  await flushMicrotasks()
  assert.equal(measures, 1)
  assert.equal(session.appended.filter((entry) => entry.type === 'compaction/prune').length, 2)

  // 新消息落表面（无图）→ 尾 seq 变化允许重扫，但图片数 ≤ 配额在计量前早退，
  // meter 依旧不被打扰——空扫描零成本。
  session.append('user/message', userText('again').data)
  listeners['session/event'](session, { type: 'user/message', data: session.events.at(-1).data })
  await flushMicrotasks()
  assert.equal(measures, 1)
  assert.equal(session.appended.filter((entry) => entry.type === 'compaction/prune').length, 2)

  // 配置变化（keep 2→1）→ 指纹失效击穿 memo，真正重扫并把配额收敛到 1 张。
  keep = 1
  listeners['session/event'](session, { type: 'compaction/summary', data: {} })
  await flushMicrotasks()
  assert.equal(measures, 2)
  const prunes = session.appended.filter((entry) => entry.type === 'compaction/prune')
  assert.equal(prunes.length, 3)
  // 表面上只剩最新一张图（four.png）。
  let survivorName
  for (const node of session.surface.nodes) {
    const blocks = session.events[node]?.data?.message?.content ?? []
    for (const outer of blocks.flatMap((x) => x.content ?? [x])) {
      if (outer.attachment) survivorName = outer.attachment.name
    }
  }
  assert.equal(survivorName, 'four.png')

  dispose()
})
