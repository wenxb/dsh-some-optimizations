import z from '@deepseek-ai/schemastery'
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { createIdRewriter, createSseRewriteTransform } from './normalize.js'

// Optional integration: the settings card appears only where the host exposes
// the settings plane; otherwise configuration comes from the cordis entry.
let installSettingsSection, settingsNamespace
try {
  ;({ installSettingsSection, settingsNamespace } = await import('@deepseek-ai/dsh-settings'))
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
  let current = () => config
  if (installSettingsSection && SETTINGS_NAMESPACE) {
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {},
    })
  }

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

  if (config.announce) {
    ctx.logger.info(
      'some-optimizations: %c%c (bodyTimeout=%dms headersTimeout=%dms)',
      [
        config.normalizeCallIds ? 'callid-norm' : null,
        config.unboundedStreamTimeouts ? 'stream-timeouts' : null,
      ].filter(Boolean).join('+') || 'idle',
      installSettingsSection ? '' : ' (configure via cordis entry; no settings plane)',
      config.bodyTimeoutMs,
      config.headersTimeoutMs,
    )
  }
}

export { Config, SETTINGS_NAMESPACE, apply, name, normalizingFetch }
