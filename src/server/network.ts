import * as http from 'node:http'

export const MAX_PROVIDER_API_ATTEMPTS = 5

export type ProviderRetryWait = (
  failedAttempts: number,
  signal: AbortSignal,
) => Promise<void>

export function configureNetworkProxy(env: NodeJS.ProcessEnv = process.env) {
  const proxyUrl = env.LINGGO_PROXY_URL?.trim()
  if (proxyUrl) validateProxyUrl(proxyUrl)
  const httpProxy = proxyUrl || env.HTTP_PROXY || env.http_proxy
  const httpsProxy = proxyUrl || env.HTTPS_PROXY || env.https_proxy || httpProxy
  const noProxy = env.NO_PROXY || env.no_proxy || 'localhost,127.0.0.1'
  const proxyEnv: http.ProxyEnv = {
    ...env,
    HTTP_PROXY: httpProxy,
    HTTPS_PROXY: httpsProxy,
    NO_PROXY: noProxy,
    http_proxy: httpProxy,
    https_proxy: httpsProxy,
    no_proxy: noProxy,
  }
  if (!httpProxy && !httpsProxy) return false
  if (typeof http.setGlobalProxyFromEnv !== 'function')
    throw new Error(
      'Proxy support requires Node.js 24.14 or newer',
    )
  http.setGlobalProxyFromEnv(proxyEnv)
  return true
}

export async function waitForProviderRetry(
  failedAttempts: number,
  signal: AbortSignal,
) {
  const delayMs = Math.min(4_000, 500 * 2 ** (failedAttempts - 1))
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timeout = setTimeout(finish, delayMs)
    const abort = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, {once: true})
  })
}

export function publicProviderError(
  error: unknown,
  fallback = 'Provider request failed',
) {
  const message = error instanceof Error ? error.message : fallback
  const redacted = message.replace(/(?:sk-|AIza)[A-Za-z0-9_-]+/g, '[redacted]')
  if (
    /Client network socket disconnected before secure TLS connection was established/i.test(
      redacted,
    )
  )
    return `${redacted} If LingGo runs in WSL with Clash Verge on Windows, enable Allow LAN in Clash and set LINGGO_PROXY_URL to its reachable HTTP proxy.`
  return redacted
}

function validateProxyUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('LINGGO_PROXY_URL must be a valid HTTP proxy URL')
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('LINGGO_PROXY_URL must use http:// or https://')
}
