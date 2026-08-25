import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {browserKeys, forgetBrowserKey, rememberBrowserKey} from './browserKeys'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

describe('browser API key storage', () => {
  beforeEach(() => {
    Object.defineProperties(globalThis, {
      localStorage: {configurable: true, value: new MemoryStorage()},
      sessionStorage: {configurable: true, value: new MemoryStorage()},
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
    Reflect.deleteProperty(globalThis, 'sessionStorage')
  })

  it('persists and removes keys in local storage', () => {
    rememberBrowserKey('provider-1', '  sk-persistent  ')

    expect(browserKeys()).toEqual({'provider-1': 'sk-persistent'})
    expect(sessionStorage.length).toBe(0)

    forgetBrowserKey('provider-1')
    expect(browserKeys()).toEqual({})
    expect(localStorage.length).toBe(0)
  })

  it('migrates keys saved by the old session-only implementation', () => {
    sessionStorage.setItem(
      'linggo-session-api-keys',
      JSON.stringify({'provider-1': 'sk-legacy'}),
    )

    expect(browserKeys()).toEqual({'provider-1': 'sk-legacy'})
    expect(sessionStorage.getItem('linggo-session-api-keys')).toBeNull()
    expect(JSON.parse(localStorage.getItem('linggo-api-keys') ?? '{}')).toEqual(
      {
        'provider-1': 'sk-legacy',
      },
    )
  })
})
