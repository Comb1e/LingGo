import * as http from 'node:http'
import {createConnection, type Socket} from 'node:net'
import {connect as createTlsConnection} from 'node:tls'
import {runtimeConfig} from './config'

export const MAX_PROVIDER_API_ATTEMPTS = runtimeConfig.providerRetryLimit

export type ProviderRetryWait = (
  failedAttempts: number,
  signal: AbortSignal,
  error?: unknown,
) => Promise<void>

export type ProviderFailureKind =
  'network' | 'rate-limit' | 'timeout' | 'server' | 'request' | 'unknown'

export interface ProviderFailure {
  kind: ProviderFailureKind
  message: string
  retryable: boolean
  retryAfterMs?: number
}

type ProxyConnector = (proxy: URL, timeoutMs: number) => Promise<void>

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
    throw new Error('Proxy support requires Node.js 24.14 or newer')
  http.setGlobalProxyFromEnv(proxyEnv)
  return true
}

export async function verifyDedicatedProxy(
  env: NodeJS.ProcessEnv = process.env,
  connect: ProxyConnector = connectToProxy,
) {
  const value = env.LINGGO_PROXY_URL?.trim()
  if (!value) return
  const url = validateProxyUrl(value)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  try {
    await connect(url, runtimeConfig.proxyConnectTimeoutMs)
  } catch (error) {
    throw new Error(
      `Cannot establish an HTTPS tunnel through LINGGO_PROXY_URL at ${url.hostname}:${port}. Check Clash Verge's current HTTP or Mixed port. With WSL mirrored networking, use http://127.0.0.1:<port>.`,
      {cause: error},
    )
  }
}

export async function waitForProviderRetry(
  failedAttempts: number,
  signal: AbortSignal,
  error?: unknown,
) {
  const failure = providerFailure(error)
  if (failure.kind === 'network') configureNetworkProxy()
  const delayMs =
    failure.retryAfterMs ?? Math.min(30_000, 2_000 * 2 ** (failedAttempts - 1))
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
  const failure = providerFailure(error, fallback)
  const redacted = failure.message.replace(
    /(?:sk-|AIza)[A-Za-z0-9_-]+/g,
    '[redacted]',
  )
  if (/other side closed|UND_ERR_SOCKET/i.test(redacted))
    return `The API response connection closed before LingGo received complete output. The provider may still finish the request, so a retry can create a duplicate response. Transport details: ${redacted}`
  if (
    /Client network socket disconnected before secure TLS connection was established/i.test(
      redacted,
    )
  )
    return `${redacted} If LingGo runs in WSL with Clash Verge on Windows, enable Allow LAN in Clash and set LINGGO_PROXY_URL to its reachable HTTP proxy.`
  return redacted
}

export function providerFailure(
  error: unknown,
  fallback = 'Provider request failed',
): ProviderFailure {
  const chain = errorChain(error)
  const apiError = chain.find(
    (value) =>
      typeof value.statusCode === 'number' ||
      typeof value.isRetryable === 'boolean',
  )
  const statusCode = apiError?.statusCode
  const messages = chain
    .map((value) => value.message)
    .filter((message): message is string => Boolean(message?.trim()))
  const codes = chain
    .map((value) => value.code)
    .filter((code): code is string => Boolean(code))
  const details = [
    ...new Set([...messages, ...codes.map((code) => `[${code}]`)]),
  ]
  const message = details.length ? details.join(' Caused by: ') : fallback
  const text = `${messages.join(' ')} ${codes.join(' ')}`
  const network =
    /network|socket|tls|fetch failed|failed to fetch|connection (?:reset|refused)|econnreset|econnrefused|epipe|enotfound|und_err/i.test(
      text,
    )
  const timeout = /timeout|timed out|abortsignal\.timeout|etimedout/i.test(text)
  const rateLimit =
    statusCode === 429 || /rate.?limit|too many requests/i.test(text)
  const server = statusCode !== undefined && statusCode >= 500
  const likelyTransientUnknown =
    /temporary|temporarily|transient|unavailable|retry|try again/i.test(text)
  const retryable =
    apiError?.isRetryable ??
    (network ||
      timeout ||
      rateLimit ||
      server ||
      (statusCode === undefined && likelyTransientUnknown))

  return {
    kind: network
      ? 'network'
      : rateLimit
        ? 'rate-limit'
        : timeout
          ? 'timeout'
          : server
            ? 'server'
            : statusCode !== undefined
              ? 'request'
              : 'unknown',
    message,
    retryable,
    retryAfterMs: retryDelayFromHeaders(apiError?.responseHeaders),
  }
}

export function shouldRetryProviderError(error: unknown) {
  return providerFailure(error).retryable
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
  return url
}

interface ErrorDetails {
  message?: string
  code?: string
  statusCode?: number
  isRetryable?: boolean
  responseHeaders?: Record<string, string>
  cause?: unknown
}

function errorChain(error: unknown) {
  const values: ErrorDetails[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && !seen.has(current) && values.length < 8) {
    seen.add(current)
    if (typeof current === 'object') {
      const value = current as ErrorDetails
      values.push(value)
      current = value.cause
    } else {
      values.push({message: String(current)})
      break
    }
  }
  return values
}

function retryDelayFromHeaders(headers: Record<string, string> | undefined) {
  if (!headers) return undefined
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  const retryAfterMs = Number(normalized['retry-after-ms'])
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0)
    return Math.min(60_000, retryAfterMs)
  const retryAfter = normalized['retry-after']
  if (!retryAfter) return undefined
  const seconds = Number(retryAfter)
  const value = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(retryAfter) - Date.now()
  return Number.isFinite(value) && value >= 0
    ? Math.min(60_000, value)
    : undefined
}

function connectToProxy(proxy: URL, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
    const socket: Socket =
      proxy.protocol === 'https:'
        ? createTlsConnection({
            host: proxy.hostname,
            port,
            servername: proxy.hostname,
          })
        : createConnection({host: proxy.hostname, port})
    let response = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const sendConnect = () => {
      const authorization = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
        : ''
      socket.write(
        `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${authorization}Connection: close\r\n\r\n`,
      )
    }
    socket.setTimeout(timeoutMs, () =>
      finish(new Error(`Proxy tunnel timed out after ${timeoutMs} ms`)),
    )
    socket.once(
      proxy.protocol === 'https:' ? 'secureConnect' : 'connect',
      sendConnect,
    )
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')
      if (!response.includes('\r\n\r\n')) return
      const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(response)?.[1]
      if (status?.startsWith('2')) finish()
      else
        finish(new Error(`Proxy CONNECT returned HTTP ${status ?? 'unknown'}`))
    })
    socket.once('error', (error) => finish(error))
    socket.once('end', () =>
      finish(new Error('Proxy closed the connection before responding')),
    )
    socket.once('close', () =>
      finish(new Error('Proxy closed the connection before responding')),
    )
  })
}
