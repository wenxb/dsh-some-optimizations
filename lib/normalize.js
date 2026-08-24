/**
 * Pure SSE tool-call id normalization — no DSH imports so tests run standalone.
 *
 * Relays translating native tool calls into OpenAI/Anthropic wire shapes often
 * fabricate deterministic ids such as `read:0` (Kimi-style `<name>:<index>`).
 * Every model response restarts the numbering, so a session log accumulates
 * repeated callIds and the client's conversation replay aborts on the second
 * start event for one context ("received more than one start Match").
 *
 * Every synthetic id is therefore rewritten unconditionally to
 * `<id>#<n>-<tag>`: `n` is monotonic per process, `tag` is random per boot, so
 * replacements are unique within a process, across restarts, and against any
 * plain id already sitting in an older log. Opaque provider ids (UUIDs,
 * `call_*`, `toolu_*`, signature references) never match and pass through
 * byte-identical, keeping provider-internal id-keyed maps coherent.
 *
 * @module dsh-llm-callid-normalizer/normalize
 */
import { randomBytes } from 'node:crypto'

/** Ids shaped like `<name>:<index>` — the relay-fabricated collision source. */
export const SYNTHETIC_ID_RE = /^[A-Za-z0-9_.-]{1,64}:\d{1,6}$/

/**
 * Create the id mapper.
 * @param {object} [options]
 * @param {string} [options.tag] - boot-scoped partition tag; defaults to random.
 * @returns {(id: string) => string} mapper from wire id to normalized id.
 */
export function createIdRewriter({ tag = randomBytes(3).toString('hex') } = {}) {
  let n = 0
  return (id) => {
    if (id === '') return `norm-${++n}-${tag}`
    if (!SYNTHETIC_ID_RE.test(id)) return id
    return `${id}#${++n}-${tag}`
  }
}

/**
 * Rewrite one SSE `data:` payload when it carries tool-call ids to normalize.
 * @param {string} payload - the text after `data:` up to (not incl.) the terminator.
 * @param {(id: string) => string} mapId - mapper from {@link createIdRewriter}.
 * @returns {string | null} the rewritten payload, or null when nothing changed.
 */
export function rewriteDataPayload(payload, mapId) {
  if (!payload.includes('"tool_calls"') && !payload.includes('"tool_use"')) return null
  let obj
  try {
    obj = JSON.parse(payload)
  } catch {
    return null
  }
  let changed = false
  const sub = (holder, key) => {
    const value = holder[key]
    if (typeof value !== 'string') return
    const mapped = mapId(value)
    if (mapped !== value) {
      holder[key] = mapped
      changed = true
    }
  }
  for (const choice of Array.isArray(obj.choices) ? obj.choices : []) {
    const delta = choice?.delta ?? choice?.message ?? {}
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      sub(call, 'id')
    }
  }
  if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
    sub(obj.content_block, 'id')
  }
  return changed ? JSON.stringify(obj) : null
}

/**
 * Create a line-oriented SSE rewriter as a Web TransformStream over bytes.
 *
 * Framing is preserved exactly: terminators (`\n` / `\r\n`) round-trip,
 * comments and payloads that fail JSON parsing pass through untouched, and
 * `[DONE]` is never modified.
 *
 * @param {(id: string) => string} mapId - mapper from {@link createIdRewriter}.
 * @returns {TransformStream<Uint8Array, Uint8Array>} for `response.body.pipeThrough`.
 */
export function createSseRewriteTransform(mapId) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const rewriteLine = (line) => {
    if (!line.startsWith('data:')) return line
    const cut = line.endsWith('\r\n') ? 2 : line.endsWith('\n') ? 1 : 0
    const body = cut === 0 ? line : line.slice(0, -cut)
    const raw = body.slice(5)
    const payload = raw.startsWith(' ') ? raw.slice(1) : raw
    if (payload === '[DONE]') return line
    const rewritten = rewriteDataPayload(payload, mapId)
    return rewritten === null ? line : `data:${rewritten}${cut === 2 ? '\r\n' : cut === 1 ? '\n' : ''}`
  }
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut + 1)
        buffer = buffer.slice(cut + 1)
        controller.enqueue(encoder.encode(rewriteLine(line)))
      }
    },
    flush(controller) {
      if (buffer.length > 0) controller.enqueue(encoder.encode(rewriteLine(buffer)))
    },
  })
}
