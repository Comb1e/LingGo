import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {BenchmarkRun} from '../shared/types'
import {createApp} from './app'
import {Store} from './database'

let store: Store
let app: ReturnType<typeof createApp>['app']

beforeEach(() => {
  store = new Store(':memory:')
  app = createApp({store}).app
})
afterEach(() => app.close())

describe('game API', () => {
  it('serves client assets created after server startup', async () => {
    const clientDir = mkdtempSync(join(tmpdir(), 'linggo-client-'))
    writeFileSync(join(clientDir, 'index.html'), '<div id="root"></div>')
    const production = createApp({
      store: new Store(':memory:'),
      clientDir,
    }).app
    await production.ready()
    writeFileSync(join(clientDir, 'index-new.js'), 'window.lingGoLoaded = true')

    try {
      const response = await production.inject({
        method: 'GET',
        url: '/index-new.js',
      })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain(
        'application/javascript',
      )
      expect(response.body).toBe('window.lingGoLoaded = true')
    } finally {
      await production.close()
      rmSync(clientDir, {recursive: true, force: true})
    }
  })

  it('creates, mutates, and exports a game', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        black: {type: 'human', name: 'Black'},
        white: {type: 'human', name: 'White'},
      },
    })
    expect(created.statusCode).toBe(201)
    const game = created.json()
    expect(game.size).toBe(19)
    const moved = await app.inject({
      method: 'POST',
      url: `/api/games/${game.id}/commands`,
      payload: {expectedVersion: game.version, type: 'play', coordinate: 'D4'},
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().moves).toHaveLength(1)
    const sgf = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}/export.sgf`,
    })
    expect(sgf.body).toContain('SZ[19]')
  })

  it('changes LLM analysis sharing without changing the game version', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        black: {type: 'human', name: 'Black'},
        white: {type: 'human', name: 'White'},
      },
    })
    const game = created.json()
    const response = await app.inject({
      method: 'PUT',
      url: `/api/games/${game.id}/analysis`,
      payload: {shareWithLlm: true},
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      enabled: true,
      shareWithLlm: true,
    })
    expect((await app.inject({method: 'GET', url: `/api/games/${game.id}`})).json().version).toBe(game.version)
  })

  it('enables analysis when a new game shares it with LLM players', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        black: {type: 'human', name: 'Black'},
        white: {type: 'human', name: 'White'},
        analysisEnabled: false,
        shareAnalysisWithLlm: true,
      },
    })
    const game = response.json()
    expect(game.analysisEnabled).toBe(true)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/games/${game.id}/analysis`,
        })
      ).json(),
    ).toMatchObject({enabled: true, shareWithLlm: true})
  })

  it('never returns an API key', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'OpenAI',
        kind: 'openai',
        supportsStructuredOutput: true,
        apiKey: 'sk-secret-value',
      },
    })
    const response = await app.inject({method: 'GET', url: '/api/connections'})
    expect(response.body).not.toContain('sk-secret-value')
  })

  it('persists custom base URLs for official providers', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'Private OpenAI proxy',
        kind: 'openai',
        baseUrl: 'https://models.example.test/openai/v1',
        supportsStructuredOutput: true,
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().baseUrl).toBe('https://models.example.test/openai/v1')
  })

  it('requires a base URL for OpenAI-compatible providers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'Self-hosted model',
        kind: 'compatible',
        supportsStructuredOutput: false,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('Base URL is required')
  })

  it('deletes games', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        black: {type: 'human', name: 'Disposable Black'},
        white: {type: 'human', name: 'Disposable White'},
      },
    })
    const {id} = created.json()

    expect(
      (await app.inject({method: 'DELETE', url: `/api/games/${id}`}))
        .statusCode,
    ).toBe(200)
    expect(
      (await app.inject({method: 'GET', url: `/api/games/${id}`})).statusCode,
    ).toBe(404)
  })

  it('edits game details with version control', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        black: {type: 'human', name: 'Black'},
        white: {type: 'human', name: 'White'},
      },
    })
    const game = created.json()
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/games/${game.id}`,
      payload: {
        expectedVersion: game.version,
        blackName: 'Renamed Black',
        whiteName: 'Renamed White',
        commentsVisible: false,
        moveCap: 500,
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      version: game.version + 1,
      black: {name: 'Renamed Black'},
      white: {name: 'Renamed White'},
      commentsVisible: false,
      moveCap: 500,
    })
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/games/${game.id}`,
          payload: {
            expectedVersion: game.version,
            blackName: 'Stale',
            whiteName: 'Stale',
            commentsVisible: true,
            moveCap: 500,
          },
        })
      ).statusCode,
    ).toBe(409)
  })

  it('edits provider connections and player profiles', async () => {
    const connection = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'Original API',
        kind: 'openai',
        supportsStructuredOutput: true,
      },
    })
    const connectionId = connection.json().id as string
    const updatedConnection = await app.inject({
      method: 'PUT',
      url: `/api/connections/${connectionId}`,
      payload: {
        name: 'Edited API',
        kind: 'openai',
        baseUrl: 'https://edited.example.test/v1',
        supportsStructuredOutput: false,
      },
    })
    expect(updatedConnection.statusCode).toBe(200)
    expect(updatedConnection.json()).toMatchObject({
      id: connectionId,
      name: 'Edited API',
      baseUrl: 'https://edited.example.test/v1',
      supportsStructuredOutput: false,
    })

    const profile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        name: 'Original player',
        connectionId,
        modelId: 'old-model',
        temperature: 0.7,
      },
    })
    const profileId = profile.json().id as string
    const updatedProfile = await app.inject({
      method: 'PUT',
      url: `/api/profiles/${profileId}`,
      payload: {
        name: 'Edited player',
        connectionId,
        modelId: 'gpt-5.6-sol',
        temperature: 0.2,
        requestOptions: [
          {name: 'reasoning', content: '{"effort":"high"}'},
        ],
        stylePrompt: 'Prefer influence.',
      },
    })
    expect(updatedProfile.statusCode).toBe(200)
    expect(updatedProfile.json()).toMatchObject({
      id: profileId,
      name: 'Edited player',
      modelId: 'gpt-5.6-sol',
      temperature: 0.2,
      requestOptions: [
        {name: 'reasoning', content: '{"effort":"high"}'},
      ],
      stylePrompt: 'Prefer influence.',
    })
  })

  it('tests an unsaved profile and validates request option content', async () => {
    const tested = await app.inject({
      method: 'POST',
      url: '/api/profiles/test',
      payload: {
        name: 'Test profile',
        connectionId: 'builtin-fake',
        modelId: 'deterministic-v1',
        temperature: 0,
        requestOptions: [{name: 'reasoning', content: '{"effort":"high"}'}],
      },
    })
    expect(tested.statusCode).toBe(200)
    expect(tested.json()).toMatchObject({
      ok: true,
      model: 'deterministic-v1',
    })

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/profiles/test',
      payload: {
        name: 'Invalid profile',
        connectionId: 'builtin-fake',
        modelId: 'deterministic-v1',
        temperature: 0,
        requestOptions: [{name: 'reasoning', content: '{invalid'}],
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toContain('Invalid JSON value')
  })

  it('deletes profiles and cascades connection deletion safely', async () => {
    const connectionResponse = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'Disposable API',
        kind: 'openai',
        supportsStructuredOutput: true,
      },
    })
    const connectionId = connectionResponse.json().id as string
    const createProfile = (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/profiles',
        payload: {
          name,
          connectionId,
          modelId: 'test-model',
          temperature: 0,
        },
      })

    const unusedProfileId = (await createProfile('Unused')).json().id as string
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/profiles/${unusedProfileId}`,
        })
      ).statusCode,
    ).toBe(200)

    const usedProfileId = (await createProfile('In use')).json().id as string
    const game = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        black: {type: 'llm', name: 'In use', profileId: usedProfileId},
        white: {type: 'human', name: 'White'},
      },
    })
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/connections/${connectionId}`,
        })
      ).statusCode,
    ).toBe(409)

    await app.inject({method: 'DELETE', url: `/api/games/${game.json().id}`})
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/connections/${connectionId}`,
        })
      ).statusCode,
    ).toBe(200)
    expect(store.getProfile(usedProfileId)).toBeUndefined()
  })

  it('protects the built-in connection and profile', async () => {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/connections/builtin-fake',
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/profiles/builtin-fake-profile',
        })
      ).statusCode,
    ).toBe(400)
  })

  it('returns conflict for another live benchmark on the same profile', async () => {
    const now = new Date().toISOString()
    const profile = store.getProfile('builtin-fake-profile')!
    const existing: BenchmarkRun = {
      id: 'existing-benchmark',
      status: 'paused',
      phase: 'training',
      config: {
        profileId: profile.id,
        finalColor: 'B',
        visits: 25,
        includeTrainingWinRates: false,
        notebookMode: 'continue',
      },
      profileSnapshot: profile,
      modelFingerprint: 'test',
      currentGame: 0,
      currentTurn: 0,
      gameIds: [],
      usage: {calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0},
      notebook: {profileId: profile.id},
      createdAt: now,
      updatedAt: now,
    }
    store.saveBenchmark(existing)

    const response = await app.inject({
      method: 'POST',
      url: '/api/benchmarks',
      payload: existing.config,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: 'This player profile already has a queued, running, or paused benchmark',
    })
  })
})
