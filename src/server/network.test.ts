import {describe, expect, it} from 'vitest'
import {configureNetworkProxy, publicProviderError} from './network'

describe('provider network configuration', () => {
  it('does nothing when no proxy is configured', () => {
    expect(configureNetworkProxy({})).toBe(false)
  })

  it('rejects invalid dedicated proxy URLs', () => {
    expect(() =>
      configureNetworkProxy({LINGGO_PROXY_URL: 'socks5://127.0.0.1:7890'}),
    ).toThrow('LINGGO_PROXY_URL must use http:// or https://')
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
