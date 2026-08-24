import z from '@deepseek-ai/schemastery'
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { createIdRewriter, createSseRewriteTransform } from './normalize.js'
import { installModelPin } from './pin.js'

// Optional integration: the official settings wire API only serves apiproxy-
// allowlisted namespaces, so third-party plugins cannot rely on it. We still
// normalize the namespace name through the host package when available.
let settingsNamespace
try {
  ;({ settingsNamespace } = await import('@deepseek-ai/dsh-settings'))
} catch {}

/**
 * 我自己的优化 (dsh-some-optimizations) — a switchboard of personal LLM-path
 * fixes for DeepSeek Harness, each toggleable from settings.
 *
 * Both optimizations live below every adapter at the global `fetch`, so they
 * cover openai-completions and anthropic-messages providers alike without
 * touching pi-ai internals:
 *
 * - **unboundedStreamTimeouts** — relays that buffer reasoning or prefill send
 *   zero body bytes for minutes; Node/undici defaults (`bodyTimeout` /
 *   `headersTimeout`, 300s each) abort the read and the harness surfaces
 *   "Stream ended without finish_reason". Installs a process-wide dispatcher
 *   with those timeouts disabled (or raised via config).
 * - **normalizeCallIds** — relays mint deterministic tool-call ids (`read:0`,
 *   Kimi-style `<name>:<index>`). The numbering restarts per response, so a
 *   session log collects repeated callIds and conversation replay aborts
 *   ("received more than one start Match"): history fails to load and display
 *   freezes mid-session. Streaming SSE responses are piped through a
 *   framing-safe line rewriter making every such id unique.
 *
 * Installed through `ctx.effect()`: stopping or reloading the plugin restores
 * both the exact `fetch` and the exact dispatcher it replaced.
 *
 * @module dsh-some-optimizations
 */

/** Stable Cordis plugin name. */
const name = 'some-optimizations'

/** Settings namespace this plugin owns; also the browser card key. */
const SETTINGS_NAMESPACE = settingsNamespace?.('some-optimizations')

const Config = z.object({
  /**
   * Host allowlist. Empty means every host; entries match the resolved URL
   * host (hostname plus port when present), e.g. `127.0.0.1:8601`.
   */
  hosts: z.array(z.string()).default([]).description('restrict all optimizations to these URL hosts; empty = all hosts'),
  /** Rewrite relay-fabricated tool-call ids in streaming responses. */
  normalizeCallIds: z.boolean().default(true).description('make synthetic tool-call ids unique across responses'),
  /** Disable Node/undici response timeouts that kill long silent thinking/prefill. */
  unboundedStreamTimeouts: z.boolean().default(true).description('remove 300s stream idle limits'),
  /** Response-body idle timeout in ms when the limiter is enabled; 0 disables. */
  bodyTimeoutMs: z.number().default(0).description('body idle timeout ms; 0 = disabled'),
  /** Response headers timeout in ms when the limiter is enabled; 0 disables (long prefills delay headers too). */
  headersTimeoutMs: z.number().default(0).description('headers timeout ms; 0 = disabled'),
  /** Force every request onto the last model picked in the UI, whatever else decides otherwise. */
  modelPin: z.boolean().default(true).description('pin all requests to the last UI-selected model'),
  /** Report activation once. */
  announce: z.boolean().default(true),
})

/**
 * Resolve a `fetch` argument to its URL without consuming any body.
 * @param {unknown} input - the first `fetch` argument.
 * @returns {URL | undefined} parsed URL, or undefined when absent.
 */
function urlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof input === 'object' && input !== null && typeof input.url === 'string') return new URL(input.url)
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Whether one request falls inside the configured host scope.
 * @param {URL | undefined} url - resolved request URL.
 * @param {string[]} hosts - configured allowlist; empty means all.
 */
function selected(url, hosts) {
  if (url === undefined) return false
  if (hosts.length === 0) return true
  return hosts.some((host) => host.trim().toLowerCase() === url.host.toLowerCase())
}

/**
 * Wrap one `fetch` so its streaming SSE responses carry normalized call ids.
 *
 * Only successful `text/event-stream` bodies are transformed; everything else
 * flows through byte-faithfully, and status/headers are preserved except a
 * now-stale `content-length`.
 *
 * @param {typeof fetch} native - fetch this wrapper delegates to.
 * @param {() => ReturnType<typeof Config>} current - reads the live section.
 * @returns {typeof fetch} the wrapping fetch.
 */
function normalizingFetch(native, current) {
  return async function someOptimizationsFetch(input, init) {
    const response = await native(input, init)
    const config = current()
    if (!config.normalizeCallIds) return response
    const url = urlOf(input)
    if (!selected(url, config.hosts)) return response
    const type = String(response.headers.get('content-type') ?? '')
    if (!response.ok || !type.includes('text/event-stream')) return response

    const rewriter = createIdRewriter()
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(
      response.body.pipeThrough(createSseRewriteTransform(rewriter)),
      { status: response.status, statusText: response.statusText, headers },
    )
  }
}

/**
 * Install the optimizations and expose the section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof Config>} config - resolved entry configuration.
 */
function apply(ctx, config) {
  // Live section. When the settings service exists we register our namespace
  // (same pattern as dsh-better-retry): the resolved value becomes the source
  // of truth and watches keep `latest` in sync; otherwise entry config rules.
  let latest = Config(config)
  const current = () => latest

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: Config(config) })
    const adopt = () => {
      latest = scope.get()
    }
    adopt()
    scope.watch(adopt)
  })

  // Same-origin config route for the browser half. The official settings wire
  // API (settings.describe/mutate) only serves apiproxy-allowlisted namespaces,
  // so third-party toggles read/write through this route instead.
  ctx.inject(['webServer', 'settings'], (wctx) => {
    const disposeRoute = wctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-some-optimizations',
      async handler(req, res) {
        const url = new URL(req.url ?? '/', 'http://dsh')
        const pathname = url.pathname.replace(/\/+$/, '')
        if (pathname !== '/dsh-some-optimizations/config') {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(current()))
          return
        }
        if (req.method === 'POST') {
          let payload
          try {
            payload = JSON.parse(await readRequestBody(req))
          } catch {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'invalid json body' }))
            return
          }
          const patch = payload && typeof payload === 'object' ? payload.patch : undefined
          if (typeof patch !== 'object' || patch === null) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'patch object required' }))
            return
          }
          // Only fields already present in the resolved section are writable.
          const resolved = current()
          for (const key of Object.keys(patch)) {
            if (!Object.hasOwn(resolved, key)) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: `unknown field: ${key}` }))
              return
            }
          }
          try {
            await wctx.settings.update(SETTINGS_NAMESPACE, patch)
          } catch (error) {
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(current()))
          return
        }
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'method not allowed' }))
      },
    })
    wctx.effect(() => disposeRoute, 'some-optimizations: web config route')
  })

  // Stream-timeout hardening: undici's shared registry is the one knob the
  // built-in fetch honors. Scoped per-host dispatchers are not — a foreign
  // Agent passed through init deadlocks the request.
  ctx.effect(() => {
    const config2 = current()
    if (!config2.unboundedStreamTimeouts) return () => {}
    const previous = getGlobalDispatcher()
    setGlobalDispatcher(new Agent({ bodyTimeout: config2.bodyTimeoutMs, headersTimeout: config2.headersTimeoutMs }))
    return () => {
      setGlobalDispatcher(previous)
    }
  })

  ctx.effect(() => {
    const previous = globalThis.fetch
    if (typeof previous !== 'function') {
      ctx.logger.warn('some-optimizations: no global fetch present; nothing to wrap')
      return () => {}
    }
    const wrapped = normalizingFetch(previous, () => current())
    globalThis.fetch = wrapped
    return () => {
      // Restore only what this plugin installed; later wrappers stay owned.
      if (globalThis.fetch === wrapped) globalThis.fetch = previous
    }
  })

  // model-pin: enforce the last UI-selected model on every request (outermost
  // agent/request listener = final say over the routed provider/model).
  let disposePin
  ctx.effect(() => {
    disposePin = installModelPin(ctx, {
      enabled: () => Boolean(current().modelPin),
      logger: ctx.logger,
    })
    return () => {
      try {
        disposePin?.()
      } catch {}
      disposePin = undefined
    }
  })

  if (config.announce) {
    ctx.logger.info(
      'some-optimizations: %s (bodyTimeout=%dms headersTimeout=%dms)',
      [
        config.normalizeCallIds ? 'callid-norm' : null,
        config.unboundedStreamTimeouts ? 'stream-timeouts' : null,
        config.modelPin ? 'model-pin' : null,
      ].filter(Boolean).join('+') || 'idle',
      config.bodyTimeoutMs,
      config.headersTimeoutMs,
    )
  }
}

/**
 * Read a request body as text (bounded to 4 KiB — settings payloads are tiny).
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the body text.
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4096) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export { Config, SETTINGS_NAMESPACE, apply, name, normalizingFetch }
