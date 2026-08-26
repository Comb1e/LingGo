import {describe, expect, it} from 'vitest'
import {
  configureNetworkProxy,
  publicProviderError,
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
})
