import z from '@deepseek-ai/schemastery'
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { createIdRewriter, createSseRewriteTransform } from './normalize.js'
import { installProjectionCacheGc } from './projcache-gc.js'
import { installImageShed } from './imageshed.js'

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
  /** Reclaim orphaned rows of the persisted session-projection cache (officially has no eviction API). */
  projCacheGc: z.boolean().default(true).description('drop projection-cache rows whose session no longer exists in persistence'),
  /** GC cadence in ms; lower bound 60s. First pass runs after a startup grace period. */
  projCacheGcIntervalMs: z.number().min(60000).default(3600000).description('projection-cache GC cadence ms'),
  /** Rolling policy: keep only the newest N image blocks on the surface (older ones become text placeholders). Fixes provider request-body size walls, e.g. NIM ~8MiB. */
  imageShed: z.boolean().default(true).description('keep only the newest N images on the surface, shed older ones into text placeholders'),
  /** How many of the newest image blocks to keep; 0 sheds every image as soon as a newer one appears. */
  imageShedKeepLatest: z.number().min(0).default(2).description('newest image blocks kept on the surface'),
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

  // projcache-gc: 回收投影缓存的孤儿检查点行。官方 projection-cache 无淘汰
  // 接口（README 已知局限），孤儿行随会话增删无限累积，而该域每次行更新都
  // 全量重写 JSON——膨胀后就是持续 iowait。删除经共享打开句柄走官方路径。
  ctx.effect(() => {
    const disposeGc = installProjectionCacheGc(ctx, {
      enabled: () => Boolean(current().projCacheGc),
      intervalMs: () => current().projCacheGcIntervalMs,
      logger: ctx.logger,
    })
    return () => {
      try {
        disposeGc?.()
      } catch {}
    }
  })

  // image-shed: 表面上只保留最新 N 张图片，更老的换成文本占位符（滚动策略，
  // 不依赖压缩节奏）。背景：官方压缩只摘要文本、图片零成本永不清理，历史截图
  // 无限累积后被 pi-ai 展开成 base64 内联进请求体，撞上 provider 的请求体硬墙
  // （NIM ~8MiB → 内联 "Internal server error"，见 lib/imageshed.js 头注）。
  ctx.effect(() => {
    const disposeShed = installImageShed(ctx, {
      enabled: () => Boolean(current().imageShed),
      keepLatest: () => Number(current().imageShedKeepLatest),
      logger: ctx.logger,
    })
    return () => {
      try {
        disposeShed?.()
      } catch {}
    }
  })

  if (config.announce) {
    ctx.logger.info(
      'some-optimizations: %s (bodyTimeout=%dms headersTimeout=%dms)',
      [
        config.normalizeCallIds ? 'callid-norm' : null,
        config.unboundedStreamTimeouts ? 'stream-timeouts' : null,
        config.projCacheGc ? 'projcache-gc' : null,
      ].filter(Boolean).join('+') || 'idle',
      config.bodyTimeoutMs,
      config.headersTimeoutMs,
    )
    ctx.logger.info(
      'some-optimizations: image-shed %s (keep latest %d image block(s) on surface)',
      config.imageShed ? 'on' : 'off',
      config.imageShedKeepLatest,
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
