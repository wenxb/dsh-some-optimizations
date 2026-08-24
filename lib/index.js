import z from '@deepseek-ai/schemastery'
import { createIdRewriter, createSseRewriteTransform } from './normalize.js'

// Optional integration: the settings card appears only where the host exposes
// the settings plane; otherwise configuration comes from the cordis entry.
let installSettingsSection, settingsNamespace
try {
  ;({ installSettingsSection, settingsNamespace } = await import('@deepseek-ai/dsh-settings'))
} catch {}

/**
 * dsh-llm-callid-normalizer — keep relay-fabricated tool-call ids unique.
 *
 * Relays translating native tool calls into OpenAI/Anthropic wire shapes often
 * mint deterministic ids (`read:0`, Kimi-style `<name>:<index>`). The numbering
 * restarts per response, so a session log collects repeated callIds and the
 * client's conversation replay aborts ("received more than one start Match"),
 * which surfaces as history failing to load and mid-session display freezes.
 *
 * Like the agentrouter fence, the rewrite lives below every adapter at the
 * global `fetch`: streaming SSE responses are piped through a framing-safe
 * line rewriter, so both openai-completions and anthropic-messages providers
 * are covered and no pi-ai internals are touched. Requests are never modified;
 * ids already normalized in the log flow back to the model unchanged and pair
 * with their tool results by construction.
 *
 * Installed through `ctx.effect()`: stopping or reloading the plugin restores
 * the exact `fetch` this plugin replaced.
 *
 * @module dsh-llm-callid-normalizer
 */

/** Stable Cordis plugin name. */
const name = 'llm-callid-normalizer'

/** Settings namespace this plugin owns; also the browser card key. */
const SETTINGS_NAMESPACE = settingsNamespace?.('llm-callid-normalizer')

const Config = z.object({
  /**
   * Host allowlist for interception. Empty means every host; entries match the
   * resolved URL host (hostname plus port when present), e.g. `127.0.0.1:8601`.
   */
  hosts: z.array(z.string()).default([]).description('restrict rewriting to these URL hosts; empty = all hosts'),
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
 * Whether one request should have its SSE response rewritten.
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
 * (non-streaming JSON, errors, other content types) flows through untouched,
 * and status/headers are preserved except a now-stale `content-length`.
 *
 * @param {typeof fetch} native - fetch this wrapper delegates to.
 * @param {() => ReturnType<typeof Config>} current - reads the live section.
 * @returns {typeof fetch} the wrapping fetch.
 */
function normalizingFetch(native, current) {
  return async function callIdNormalizingFetch(input, init) {
    const response = await native(input, init)
    const url = urlOf(input)
    if (!selected(url, current().hosts)) return response
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
 * Install the fetch wrapper and expose the section.
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

  ctx.effect(() => {
    const previous = globalThis.fetch
    if (typeof previous !== 'function') {
      ctx.logger.warn('llm-callid-normalizer: no global fetch present; nothing to wrap')
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
      'llm-callid-normalizer: active (%c%c)',
      config.hosts.length === 0 ? 'all hosts' : config.hosts.join(', '),
      installSettingsSection ? '' : ' (configure via cordis entry; no settings plane)',
    )
  }
}

export { Config, SETTINGS_NAMESPACE, apply, name }
