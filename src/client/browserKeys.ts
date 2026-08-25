const storageKey = 'linggo-api-keys'
const legacySessionStorageKey = 'linggo-session-api-keys'

export function browserKeys(): Record<string, string> {
  const persistent = readKeys(getStorage('localStorage'), storageKey)
  const sessionStorage = getStorage('sessionStorage')
  const legacy = readKeys(sessionStorage, legacySessionStorageKey)
  if (!Object.keys(legacy).length) return persistent

  const merged = {...legacy, ...persistent}
  if (writeBrowserKeys(merged)) {
    try {
      sessionStorage?.removeItem(legacySessionStorageKey)
    } catch {
      // The persistent copy is already available.
    }
  }
  return merged
}

export function rememberBrowserKey(connectionId: string, apiKey: string) {
  const key = apiKey.trim()
  if (!key) return forgetBrowserKey(connectionId)
  writeBrowserKeys({...browserKeys(), [connectionId]: key})
}

export function forgetBrowserKey(connectionId: string) {
  const keys = browserKeys()
  delete keys[connectionId]
  writeBrowserKeys(keys)
}

function readKeys(storage: Storage | undefined, key: string) {
  try {
    const value = storage?.getItem(key)
    if (!value) return {}
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && Boolean(entry[1].trim()),
      ),
    )
  } catch {
    return {}
  }
}

function writeBrowserKeys(keys: Record<string, string>) {
  try {
    const storage = getStorage('localStorage')
    if (!storage) return false
    if (Object.keys(keys).length)
      storage.setItem(storageKey, JSON.stringify(keys))
    else storage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

function getStorage(name: 'localStorage' | 'sessionStorage') {
  try {
    return globalThis[name]
  } catch {
    return undefined
  }
}
