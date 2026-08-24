import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdRewriter, createSseRewriteTransform, rewriteDataPayload, SYNTHETIC_ID_RE } from '../lib/normalize.js'

const OPENAI_DELTA = (id) =>
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'read', arguments: '' } }] } }] })

const ANTHROPIC_BLOCK = (id) =>
  JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'read', input: {} } })

const MAP = createIdRewriter({ tag: 'test' })

test('synthetic pattern matches relay-style ids only', () => {
  assert.ok(SYNTHETIC_ID_RE.test('read:0'))
  assert.ok(SYNTHETIC_ID_RE.test('browser_click:12'))
  assert.ok(!SYNTHETIC_ID_RE.test('toolu_bdrk_01abc'))
  assert.ok(!SYNTHETIC_ID_RE.test('call_xyz'))
  assert.ok(!SYNTHETIC_ID_RE.test(''))
})

test('every synthetic sighting gets a unique tagged replacement', () => {
  assert.equal(MAP('read:0'), 'read:0#1-test')
  assert.equal(MAP('read:0'), 'read:0#2-test')
  assert.equal(MAP('edit:0'), 'edit:0#3-test')
  assert.equal(createIdRewriter({ tag: 'x' })('read:0'), 'read:0#1-x')
  const uuid = 'd3d64789-c1e4-468a-99c2-f9d6feb7998d'
  assert.equal(MAP(uuid), uuid)
  assert.equal(MAP('toolu_bdrk_01abc'), 'toolu_bdrk_01abc')
})

test('rewriter mints fresh unique ids for empty wire ids', () => {
  const map = createIdRewriter({ tag: 't' })
  const a = map('')
  const b = map('')
  assert.notEqual(a, b)
  assert.match(a, /^norm-\d+-t$/)
})

test('openai delta payloads are rewritten, continuations untouched', () => {
  const map = createIdRewriter({ tag: 't' })
  assert.ok(rewriteDataPayload(OPENAI_DELTA('read:0'), map).includes('"id":"read:0#1-t"'))
  assert.ok(rewriteDataPayload(OPENAI_DELTA('read:0'), map).includes('"id":"read:0#2-t"'))
  const continuation = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"p' } }] } }] })
  assert.equal(rewriteDataPayload(continuation, map), null)
  assert.equal(rewriteDataPayload('not json {', map), null)
  assert.equal(rewriteDataPayload(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }), map), null)
})

test('anthropic tool_use blocks are rewritten', () => {
  const map = createIdRewriter({ tag: 't' })
  assert.ok(rewriteDataPayload(ANTHROPIC_BLOCK('read:0'), map).includes('"id":"read:0#1-t"'))
  assert.ok(rewriteDataPayload(ANTHROPIC_BLOCK('read:0'), map).includes('"id":"read:0#2-t"'))
})

// Read a readable fully and return its text.
async function collect(readable) {
  const reader = readable.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

async function runTransform(chunks, map) {
  const transform = createSseRewriteTransform(map ?? createIdRewriter({ tag: 't' }))
  const writer = transform.writable.getWriter()
  const done = collect(transform.readable)
  for (const c of chunks) await writer.write(c)
  await writer.close()
  return done
}

test('sse framing survives: split lines, CRLF, comments, DONE', async () => {
  const body =
    ': keep-alive\r\n' +
    `data: ${OPENAI_DELTA('toolu_bdrk_ok')}\r\n` +
    '\r\n' +
    'data: [DONE]\n'
  const cut = 40
  const out = await runTransform([Buffer.from(body.slice(0, cut)), Buffer.from(body.slice(cut))])
  assert.equal(out, body)
})

test('ids stay unique across successive responses in one stream', async () => {
  const response = () => `data: ${OPENAI_DELTA('read:0')}\n\ndata: [DONE]\n\n`
  const out = await runTransform(
    [Buffer.from(response()), Buffer.from(response()), Buffer.from(response())],
    createIdRewriter({ tag: 'test' }),
  )
  const ids = [...out.matchAll(/"id":"([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(ids, ['read:0#1-test', 'read:0#2-test', 'read:0#3-test'])
  assert.ok(out.includes('[DONE]'))
})
