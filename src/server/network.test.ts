import {describe, expect, it} from 'vitest'
import {
  configureNetworkProxy,
  providerFailure,
  publicProviderError,
  shouldRetryProviderError,
  verifyDedicatedProxy,
} from './network'

describe('provider network configuration', () => {
  it('does nothing when no proxy is configured', () => {
    expect(configureNetworkProxy({})).toBe(false)
  })

  it('rejects invalid dedicated proxy URLs', () => {
    expect(() =>
      configureNetworkProxy({LINGGO_PROXY_URL: 'socks5://127.0.0.1:7890'}),
    ).toThrow('LINGGO_PROXY_URL must use http:// or https://')
  })

  it('checks the dedicated proxy host and port before startup', async () => {
    const checked: Array<[string, number, number]> = []
    await verifyDedicatedProxy(
      {LINGGO_PROXY_URL: 'http://127.0.0.1:7897'},
      async (proxy, timeoutMs) => {
        checked.push([proxy.hostname, Number(proxy.port), timeoutMs])
      },
    )
    expect(checked).toEqual([['127.0.0.1', 7897, 3_000]])
  })

  it('reports a useful mirrored-WSL error for unreachable proxies', async () => {
    await expect(
      verifyDedicatedProxy(
        {LINGGO_PROXY_URL: 'http://198.18.0.2:7890'},
        async () => {
          throw new Error('connect refused')
        },
      ),
    ).rejects.toThrow(
      'With WSL mirrored networking, use http://127.0.0.1:<port>',
    )
  })

  it('adds WSL and Clash guidance to TLS disconnects', () => {
    const message = publicProviderError(
      new Error(
        'Cannot connect to API: Client network socket disconnected before secure TLS connection was established',
      ),
    )
    expect(message).toContain('enable Allow LAN in Clash')
    expect(message).toContain('LINGGO_PROXY_URL')
  })

  it('preserves nested transport causes and socket error codes', () => {
    const socketError = Object.assign(
      new Error(
        'Client network socket disconnected before secure TLS connection was established',
      ),
      {code: 'ECONNRESET'},
    )
    const error = Object.assign(new Error('Cannot connect to API'), {
      isRetryable: true,
      cause: new TypeError('fetch failed', {cause: socketError}),
    })

    expect(providerFailure(error)).toMatchObject({
      kind: 'network',
      retryable: true,
    })
    expect(publicProviderError(error)).toContain('fetch failed')
    expect(publicProviderError(error)).toContain('[ECONNRESET]')
  })

  it('explains that a closed response socket can leave provider work running', () => {
    const error = Object.assign(
      new Error('Cannot connect to API: other side closed'),
      {
        cause: Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        }),
      },
    )

    expect(publicProviderError(error)).toContain(
      'The provider may still finish the request',
    )
    expect(publicProviderError(error)).toContain('[UND_ERR_SOCKET]')
  })

  it('does not retry permanent provider request errors', () => {
    const error = Object.assign(new Error('Unsupported request field'), {
      statusCode: 400,
      isRetryable: false,
    })
    expect(shouldRetryProviderError(error)).toBe(false)
    expect(providerFailure(error).kind).toBe('request')
  })

  it('reads retry-after headers case-insensitively', () => {
    const error = Object.assign(new Error('Rate limited'), {
      statusCode: 429,
      isRetryable: true,
      responseHeaders: {'Retry-After-Ms': '4250'},
    })
    expect(providerFailure(error)).toMatchObject({
      kind: 'rate-limit',
      retryable: true,
      retryAfterMs: 4_250,
    })
  })
})
