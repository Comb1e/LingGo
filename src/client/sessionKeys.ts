const storageKey = 'linggo-session-api-keys'

export function sessionKeys(): Record<string, string> {
  try {
    const value = sessionStorage.getItem(storageKey)
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

export function rememberSessionKey(connectionId: string, apiKey: string) {
  const key = apiKey.trim()
  if (!key) return forgetSessionKey(connectionId)
  writeSessionKeys({...sessionKeys(), [connectionId]: key})
}

export function forgetSessionKey(connectionId: string) {
  const keys = sessionKeys()
  delete keys[connectionId]
  writeSessionKeys(keys)
}

function writeSessionKeys(keys: Record<string, string>) {
  try {
    if (Object.keys(keys).length)
      sessionStorage.setItem(storageKey, JSON.stringify(keys))
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Server-side memory still works when browser storage is unavailable.
  }
}
