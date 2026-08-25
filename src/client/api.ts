import type {
  BenchmarkConfig,
  BenchmarkRun,
  Game,
  GameAnalysis,
  KataGoHealth,
  KataGoSettings,
  NewGameInput,
  PlayerProfile,
  ProviderConnection,
} from '../shared/types'
import {browserKeys, forgetBrowserKey, rememberBrowserKey} from './browserKeys'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json')
  const response = await fetch(url, {
    ...init,
    headers,
  })
  if (!response.ok) {
    const payload = await response
      .json()
      .catch(() => ({error: response.statusText}))
    throw new Error(payload.error ?? response.statusText)
  }
  return response.json() as Promise<T>
}

async function requestText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText)
  return response.text()
}

let restoringKeys: Promise<ProviderConnection[]> | undefined

async function connectionsWithRestoredKeys(): Promise<ProviderConnection[]> {
  if (restoringKeys) return restoringKeys
  restoringKeys = (async () => {
    const connections = await request<ProviderConnection[]>('/api/connections')
    const keys = browserKeys()
    const connectionIds = new Set(connections.map(({id}) => id))
    for (const id of Object.keys(keys)) {
      if (!connectionIds.has(id)) forgetBrowserKey(id)
    }
    const missing = connections.filter(
      (connection) => !connection.hasSessionKey && keys[connection.id],
    )
    await Promise.all(
      missing.map((connection) =>
        request(`/api/connections/${connection.id}/key`, {
          method: 'PUT',
          body: JSON.stringify({apiKey: keys[connection.id]}),
        }),
      ),
    )
    return connections.map((connection) => ({
      ...connection,
      hasSessionKey:
        connection.hasSessionKey || Boolean(keys[connection.id]?.trim()),
    }))
  })()
  try {
    return await restoringKeys
  } finally {
    restoringKeys = undefined
  }
}

export const api = {
  games: () => request<Game[]>('/api/games'),
  game: (id: string) => request<Game>(`/api/games/${id}`),
  createGame: (input: NewGameInput) =>
    request<Game>('/api/games', {method: 'POST', body: JSON.stringify(input)}),
  updateGame: (id: string, input: Record<string, unknown>) =>
    request<Game>(`/api/games/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteGame: (id: string) =>
    request<{ok: true}>(`/api/games/${id}`, {method: 'DELETE'}),
  command: (id: string, command: Record<string, unknown>) =>
    request<Game>(`/api/games/${id}/commands`, {
      method: 'POST',
      body: JSON.stringify(command),
    }),
  analysis: (id: string) => request<GameAnalysis>(`/api/games/${id}/analysis`),
  setAnalysis: (
    id: string,
    input: {enabled?: boolean; shareWithLlm?: boolean},
  ) =>
    request<GameAnalysis>(`/api/games/${id}/analysis`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  backfillAnalysis: (id: string) =>
    request<GameAnalysis>(`/api/games/${id}/analysis/backfill`, {method: 'POST'}),
  kataGoSettings: () => request<KataGoSettings>('/api/katago/settings'),
  saveKataGoSettings: (input: Omit<KataGoSettings, 'updatedAt'>) =>
    request<KataGoSettings>('/api/katago/settings', {method: 'PUT', body: JSON.stringify(input)}),
  testKataGo: () => request<KataGoHealth>('/api/katago/test', {method: 'POST'}),
  connections: connectionsWithRestoredKeys,
  restoreBrowserKeys: connectionsWithRestoredKeys,
  saveConnection: async (input: Record<string, unknown>) => {
    const connection = await request<ProviderConnection>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (typeof input.apiKey === 'string' && input.apiKey.trim())
      rememberBrowserKey(connection.id, input.apiKey)
    return connection
  },
  updateConnection: async (id: string, input: Record<string, unknown>) => {
    const connection = await request<ProviderConnection>(
      `/api/connections/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    if (typeof input.apiKey === 'string' && input.apiKey.trim())
      rememberBrowserKey(id, input.apiKey)
    return connection
  },
  deleteConnection: async (id: string) => {
    const result = await request<{ok: true}>(`/api/connections/${id}`, {
      method: 'DELETE',
    })
    forgetBrowserKey(id)
    return result
  },
  setKey: async (id: string, apiKey: string) => {
    const result = await request<{ok: boolean}>(`/api/connections/${id}/key`, {
      method: 'PUT',
      body: JSON.stringify({apiKey}),
    })
    if (apiKey.trim()) rememberBrowserKey(id, apiKey)
    else forgetBrowserKey(id)
    return result
  },
  profiles: () => request<PlayerProfile[]>('/api/profiles'),
  saveProfile: (input: Record<string, unknown>) =>
    request<PlayerProfile>('/api/profiles', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProfile: (id: string, input: Record<string, unknown>) =>
    request<PlayerProfile>(`/api/profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteProfile: (id: string) =>
    request<{ok: true}>(`/api/profiles/${id}`, {method: 'DELETE'}),
  profileNotebook: (id: string) => requestText(`/api/profiles/${id}/notebook.md`),
  benchmarks: () => request<BenchmarkRun[]>('/api/benchmarks'),
  benchmark: (id: string) => request<BenchmarkRun>(`/api/benchmarks/${id}`),
  createBenchmark: (input: BenchmarkConfig) =>
    request<BenchmarkRun>('/api/benchmarks', {method: 'POST', body: JSON.stringify(input)}),
  benchmarkCommand: (id: string, input: Record<string, unknown>) =>
    request<BenchmarkRun>(`/api/benchmarks/${id}/commands`, {method: 'POST', body: JSON.stringify(input)}),
  deleteBenchmark: (id: string) =>
    request<{ok: true}>(`/api/benchmarks/${id}`, {method: 'DELETE'}),
  benchmarkNotebook: (id: string) => requestText(`/api/benchmarks/${id}/notebook.md`),
  importSgf: (sgf: string) =>
    request<{game: Game; warnings: string[]}>('/api/import', {
      method: 'POST',
      body: JSON.stringify({sgf}),
    }),
}
