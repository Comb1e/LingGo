import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {BenchmarkRun} from '../shared/types'
import {createApp} from './app'
import {Store} from './database'
import type {KataGoAnalyzer} from './katago'

let store: Store
let app: ReturnType<typeof createApp>['app']
let games: ReturnType<typeof createApp>['games']

beforeEach(() => {
  store = new Store(':memory:')
  const created = createApp({store})
  app = created.app
  games = created.games
})
afterEach(() => app.close())

describe('game API', () => {
  it('serves sanitized life-and-death problems and scores one human answer', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/life-death/problem-sets',
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()[0]).toMatchObject({
      id: 'default',
      version: '1.1',
      count: 4,
    })
    expect(listed.json()[1]).toMatchObject({
      id: 'gogameguru-easy',
      count: 140,
      license: 'CC BY-NC-SA 4.0',
    })
    expect(listed.json()[2]).toMatchObject({
      id: 'gogameguru-hard',
      count: 140,
      license: 'CC BY-NC-SA 4.0',
    })
    expect(listed.json()[3]).toMatchObject({
      id: 'gogameguru-intermediate',
      count: 140,
      license: 'CC BY-NC-SA 4.0',
    })
    expect(listed.json()[4]).toMatchObject({
      id: 'gogameguru-other',
      count: 1,
      license: 'CC BY-NC-SA 4.0',
    })

    const loaded = await app.inject({
      method: 'GET',
      url: '/api/life-death/problem-sets/default',
    })
    expect(loaded.statusCode).toBe(200)
    expect(loaded.json().problems[0]).toMatchObject({
      id: 'black-corner-capture',
      size: 19,
      sideToMove: 'B',
    })
    expect(loaded.json().problems[0]).not.toHaveProperty('expected')
    expect(loaded.json().problems[0]).not.toHaveProperty('expectedAction')

    const correct = await app.inject({
      method: 'POST',
      url: '/api/life-death/problem-sets/default/problems/black-corner-capture/answers',
      payload: {action: 'play', coordinate: 'B1'},
    })
    expect(correct.statusCode).toBe(200)
    expect(correct.json()).toMatchObject({
      problemId: 'black-corner-capture',
      legal: true,
      correct: true,
      expectedAction: {action: 'play', coordinate: 'B1'},
    })
    expect(correct.json().board[18][1]).toBe(1)
  })

  it('marks an occupied life-and-death intersection as a failed answer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/life-death/problem-sets/default/problems/black-corner-capture/answers',
      payload: {action: 'play', coordinate: 'A2'},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({legal: false, correct: false})
    expect(response.json().failureReason).toContain('occupied')
  })

  it('scores a scraped setup-position problem against its imported board', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/life-death/problem-sets/gogameguru-easy/problems/ggg-easy-01/answers',
      payload: {action: 'play', coordinate: 'S1'},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({legal: true, correct: true})
    expect(response.json().board[18][17]).toBe(1)
  })

  it('scores a difficult scraped problem against its imported board', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/life-death/problem-sets/gogameguru-hard/problems/ggg-hard-01/answers',
      payload: {action: 'play', coordinate: 'C2'},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({legal: true, correct: true})
  })

  it('scores a multi-step scraped solution one move at a time', async () => {
    const first = {action: 'play' as const, coordinate: 'S1', comment: ''}
    const second = {action: 'play' as const, coordinate: 'S2', comment: ''}
    const third = {action: 'play' as const, coordinate: 'O1', comment: ''}
    const stepOne = await app.inject({
      method: 'POST',
      url: '/api/life-death/problem-sets/gogameguru-easy/problems/ggg-easy-01/answers',
      payload: {...first, sequence: [first]},
    })
    expect(stepOne.statusCode).toBe(200)
    expect(stepOne.json()).toMatchObject({
      correct: true,
      complete: false,
      step: 1,
    })

    const stepTwo = await app.inject({
      method: 'POST',
      url: '/api/life-death/problem-sets/gogameguru-easy/problems/ggg-easy-01/answers',
      payload: {...second, sequence: [first, second]},
    })
    expect(stepTwo.json()).toMatchObject({
      correct: true,
      complete: false,
      step: 2,
    })

    const solved = await app.inject({
      method: 'POST',
      url: '/api/life-death/problem-sets/gogameguru-easy/problems/ggg-easy-01/answers',
      payload: {...third, sequence: [first, second, third]},
    })
    expect(solved.json()).toMatchObject({
      correct: true,
      complete: true,
      step: 3,
    })
  })

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

  it('returns only the visible LLM messages for a game', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        size: 9,
        black: {type: 'human', name: 'Black'},
        white: {type: 'human', name: 'White'},
      },
    })
    const game = created.json()
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/games/${game.id}/llm-messages`,
        })
      ).json(),
    ).toEqual([])

    const profile = store.getProfile('builtin-fake-profile')!
    const connection = store.getConnection(profile.connectionId)!
    const prepared = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    const response = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}/llm-messages`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([
      {
        color: 'B',
        status: 'active',
        providerKind: 'fake',
        continuationMode: 'transcript',
        messages: [
          {role: 'user', content: prepared.request.content, pending: true},
        ],
      },
    ])
    expect(response.body).not.toContain('modelFingerprint')
    expect(response.body).not.toContain('providerContinuationId')
  })

  it('replays immutable board positions and validates the turn', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        size: 9,
        black: {type: 'human', name: 'Black'},
        white: {type: 'human', name: 'White'},
      },
    })
    let game = created.json()
    for (const command of [
      {type: 'play', coordinate: 'A1'},
      {type: 'play', coordinate: 'B1'},
      {type: 'play', coordinate: 'B2'},
      {type: 'pass'},
      {type: 'play', coordinate: 'C1'},
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/games/${game.id}/commands`,
        payload: {expectedVersion: game.version, ...command},
      })
      expect(response.statusCode).toBe(200)
      game = response.json()
    }

    const empty = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}/positions/0`,
    })
    expect(empty.json()).toMatchObject({
      gameId: game.id,
      turn: 0,
      toMove: 'B',
      captures: {B: 0, W: 0},
    })
    expect(
      empty
        .json()
        .board.flat()
        .every((stone: number) => stone === 0),
    ).toBe(true)

    const afterPass = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}/positions/4`,
    })
    expect(afterPass.json()).toMatchObject({turn: 4, toMove: 'B'})
    const current = await app.inject({
      method: 'GET',
      url: `/api/games/${game.id}/positions/5`,
    })
    expect(current.json()).toMatchObject({
      turn: 5,
      toMove: 'W',
      captures: {B: 1, W: 0},
    })

    for (const turn of ['-1', '6', '1.5', 'not-a-turn'])
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/games/${game.id}/positions/${turn}`,
          })
        ).statusCode,
      ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/games/missing/positions/0',
        })
      ).statusCode,
    ).toBe(404)

    const undone = await app.inject({
      method: 'POST',
      url: `/api/games/${game.id}/commands`,
      payload: {expectedVersion: game.version, type: 'undo'},
    })
    expect(undone.statusCode).toBe(200)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/games/${game.id}/positions/5`,
        })
      ).statusCode,
    ).toBe(400)
  })

  it('analyzes a reviewed position with the configured visits', async () => {
    const inputs: Parameters<KataGoAnalyzer['analyze']>[0][] = []
    const kataGo: KataGoAnalyzer = {
      async analyze(input) {
        inputs.push(input)
        return {
          id: 'review',
          rootInfo: {winrate: 0.6, scoreLead: 2, visits: input.visits},
          moveInfos: [
            {move: 'pass', visits: 100, winrate: 0.6, scoreLead: 2},
            ...['A9', 'B8', 'C7', 'D6', 'E5', 'F4'].map((move, index) => ({
              move,
              visits: 90 - index,
              winrate: 0.6 - index / 100,
              scoreLead: 2,
            })),
          ],
        }
      },
      async close() {},
    }
    const reviewStore = new Store(':memory:')
    const reviewApp = createApp({store: reviewStore, kataGo}).app

    try {
      const created = await reviewApp.inject({
        method: 'POST',
        url: '/api/games',
        payload: {
          size: 9,
          black: {type: 'human', name: 'Black'},
          white: {type: 'human', name: 'White'},
          analysisEnabled: false,
        },
      })
      const game = created.json()
      await reviewApp.inject({
        method: 'POST',
        url: `/api/games/${game.id}/commands`,
        payload: {
          expectedVersion: game.version,
          type: 'play',
          coordinate: 'D4',
        },
      })

      const response = await reviewApp.inject({
        method: 'POST',
        url: `/api/games/${game.id}/positions/1/katago`,
      })

      expect(response.statusCode).toBe(200)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({visits: 5_000, priority: 75})
      expect(inputs[0].moves).toHaveLength(1)
      expect(response.json()).toMatchObject({
        gameId: game.id,
        turn: 1,
        toMove: 'W',
        visits: 5_000,
      })
      expect(response.json().candidates).toHaveLength(5)
      expect(response.json().candidates[0]).toMatchObject({
        move: 'A9',
        point: [0, 0],
        winRate: 0.4,
      })
    } finally {
      await reviewApp.close()
    }
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
    expect(
      (await app.inject({method: 'GET', url: `/api/games/${game.id}`})).json()
        .version,
    ).toBe(game.version)
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

  it('allows KataGo visit settings up to 100,000', async () => {
    const current = store.getKataGoSettings()
    const payload = {
      executablePath: current.executablePath,
      modelPath: current.modelPath,
      configPath: current.configPath,
      analysisVisits: 100_000,
    }
    const accepted = await app.inject({
      method: 'PUT',
      url: '/api/katago/settings',
      payload,
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().analysisVisits).toBe(100_000)

    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/katago/settings',
      payload: {...payload, analysisVisits: 100_001},
    })
    expect(rejected.statusCode).toBe(400)
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

  it('allows DeepSeek to use its default API endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connections',
      payload: {
        name: 'DeepSeek',
        kind: 'deepseek',
        supportsStructuredOutput: false,
      },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({name: 'DeepSeek', kind: 'deepseek'})
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
        reasoningEnabled: false,
        requestOptions: [{name: 'reasoning', content: '{"effort":"high"}'}],
        stylePrompt: 'Prefer influence.',
      },
    })
    expect(updatedProfile.statusCode).toBe(200)
    expect(updatedProfile.json()).toMatchObject({
      id: profileId,
      name: 'Edited player',
      modelId: 'gpt-5.6-sol',
      temperature: 0.2,
      reasoningEnabled: false,
      requestOptions: [{name: 'reasoning', content: '{"effort":"high"}'}],
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

  it('manages named notebooks and protects one selected by a live benchmark', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles/builtin-fake-profile/notebooks',
      payload: {name: '  Fuseki  '},
    })
    expect(created.statusCode).toBe(201)
    const notebook = created.json()
    expect(notebook.name).toBe('Fuseki')

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/profiles/builtin-fake-profile/notebooks',
      payload: {name: 'fUsEkI'},
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json().error).toContain('already exists')

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/builtin-fake-profile/notebooks/${notebook.id}`,
      payload: {name: 'Opening'},
    })
    expect(renamed.json().name).toBe('Opening')
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/profiles/builtin-fake-profile/notebooks/${notebook.id}.md`,
        })
      ).statusCode,
    ).toBe(200)

    const now = new Date().toISOString()
    const profile = store.getProfile('builtin-fake-profile')!
    store.saveBenchmark({
      id: 'notebook-user',
      protocolVersion: 2,
      status: 'paused',
      phase: 'training_game',
      substate: {kind: 'paused', previous: {kind: 'ready'}},
      config: {
        profileId: profile.id,
        finalColor: 'B',
        trainingGameCount: 1,
        notebookSeed: {mode: 'refine_existing', notebookId: notebook.id},
        trainingFeedback: 'none',
        notebookTokenBudget: 8000,
        trainingVisits: 25,
        evaluationVisits: 25,
      },
      profileSnapshot: profile,
      modelFingerprint: 'test',
      kataGoFingerprint: 'katago',
      currentGame: 0,
      currentTurn: 0,
      gameIds: [],
      usage: {calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0},
      notebook: {profileId: profile.id, notebookId: notebook.id},
      notebookVersion: 1,
      notebookEstimatedTokens: 1,
      createdAt: now,
      updatedAt: now,
    })
    const conflict = await app.inject({
      method: 'DELETE',
      url: `/api/profiles/builtin-fake-profile/notebooks/${notebook.id}`,
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toContain('active benchmark')
  })

  it('returns conflict for another live benchmark on the same profile', async () => {
    const now = new Date().toISOString()
    const profile = store.getProfile('builtin-fake-profile')!
    const existing: BenchmarkRun = {
      id: 'existing-benchmark',
      protocolVersion: 2,
      status: 'paused',
      phase: 'training_game',
      substate: {kind: 'paused', previous: {kind: 'ready'}},
      config: {
        profileId: profile.id,
        finalColor: 'B',
        trainingGameCount: 10,
        notebookSeed: {mode: 'rules_only'},
        trainingFeedback: 'none',
        notebookTokenBudget: 8000,
        trainingVisits: 25,
        evaluationVisits: 25,
      },
      profileSnapshot: profile,
      modelFingerprint: 'test',
      kataGoFingerprint: 'katago',
      currentGame: 0,
      currentTurn: 0,
      gameIds: [],
      usage: {calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0},
      notebook: {profileId: profile.id},
      notebookVersion: 1,
      notebookEstimatedTokens: 1,
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
      error:
        'This player profile already has a queued, running, or paused benchmark',
    })
  })

  it('creates a six-stage session and rejects an early continue', async () => {
    store.saveConnection({
      id: 'session-no-key',
      name: 'Session provider',
      kind: 'openai',
      supportsStructuredOutput: true,
    })
    store.saveProfile({
      id: 'session-profile',
      name: 'Session profile',
      connectionId: 'session-no-key',
      modelId: 'session-model',
      temperature: 0,
    })
    const life = store.createNotebook('session-profile', 'Session life')
    const ordinary = store.createNotebook('session-profile', 'Session ordinary')
    const payload = {
      profileId: 'session-profile',
      lifeDeathNotebookId: life.id,
      ordinaryNotebookId: ordinary.id,
      finalColor: 'B',
      trainingGameCount: 2,
      trainingGamesWithWinRates: 1,
      trainingGamesWithoutWinRates: 1,
      trainingFeedback: 'structured',
      notebookTokenBudget: 10_000,
      trainingVisits: 25,
      evaluationVisits: 25,
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/benchmark-sessions',
      payload,
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      status: 'running',
      currentStage: 'life_death_notebook',
      stages: [
        {stageKey: 'life_death_notebook', status: 'running', attempt: 1},
        {stageKey: 'easy', status: 'pending', attempt: 0},
        {stageKey: 'medium', status: 'pending', attempt: 0},
        {stageKey: 'hard', status: 'pending', attempt: 0},
        {stageKey: 'ordinary_notebook', status: 'pending', attempt: 0},
        {stageKey: 'ordinary', status: 'pending', attempt: 0},
      ],
    })
    const sessionId = created.json().id
    const early = await app.inject({
      method: 'POST',
      url: `/api/benchmark-sessions/${sessionId}/continue`,
    })
    expect(early.statusCode).toBe(400)
    expect(early.json().error).toContain('must complete')

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/benchmark-sessions',
      payload,
    })
    expect(duplicate.statusCode).toBe(409)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/benchmark-sessions/${sessionId}/commands`,
      payload: {type: 'cancel'},
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().status).toBe('cancelled')
  })

  it('rejects duplicate notebook roles at the session API boundary', async () => {
    const notebook = store.createNotebook(
      'builtin-fake-profile',
      'One session notebook',
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/benchmark-sessions',
      payload: {
        profileId: 'builtin-fake-profile',
        lifeDeathNotebookId: notebook.id,
        ordinaryNotebookId: notebook.id,
        finalColor: 'B',
        trainingGameCount: 2,
        trainingGamesWithWinRates: 1,
        trainingGamesWithoutWinRates: 1,
        trainingFeedback: 'structured',
        notebookTokenBudget: 10_000,
        trainingVisits: 25,
        evaluationVisits: 25,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('must be distinct')
  })
})
