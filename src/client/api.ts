import type {
  Game,
  NewGameInput,
  PlayerProfile,
  ProviderConnection,
} from '../shared/types'

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
  connections: () => request<ProviderConnection[]>('/api/connections'),
  saveConnection: (input: Record<string, unknown>) =>
    request<ProviderConnection>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateConnection: (id: string, input: Record<string, unknown>) =>
    request<ProviderConnection>(`/api/connections/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteConnection: (id: string) =>
    request<{ok: true}>(`/api/connections/${id}`, {method: 'DELETE'}),
  setKey: (id: string, apiKey: string) =>
    request<{ok: boolean}>(`/api/connections/${id}/key`, {
      method: 'PUT',
      body: JSON.stringify({apiKey}),
    }),
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
  importSgf: (sgf: string) =>
    request<{game: Game; warnings: string[]}>('/api/import', {
      method: 'POST',
      body: JSON.stringify({sgf}),
    }),
}
