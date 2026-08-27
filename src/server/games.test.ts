import {afterEach, describe, expect, it} from 'vitest'
import {NoOutputGeneratedError} from 'ai'
import {Store} from './database'
import {GameService, StaleVersionError} from './games'
import type {PlayerAdapter} from './providers'

let store: Store
let service: GameService
afterEach(() => store?.close())

function setup() {
  store = new Store(':memory:')
  service = new GameService(store)
}

describe('game orchestration', () => {
  it('creates 19x19 by default and rejects stale commands', async () => {
    setup()
    const game = service.create({
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
    } as any)
    expect(game.size).toBe(19)
    await service.command(game.id, {
      expectedVersion: 0,
      type: 'play',
      coordinate: 'D4',
    })
    await expect(
      service.command(game.id, {expectedVersion: 0, type: 'pass'}),
    ).rejects.toBeInstanceOf(StaleVersionError)
  })

  it('undoes one ply and leaves autoplay paused', async () => {
    setup()
    let game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
      commentsVisible: true,
    })
    game = await service.command(game.id, {
      expectedVersion: game.version,
      type: 'play',
      coordinate: 'D4',
    })
    game = await service.command(game.id, {
      expectedVersion: game.version,
      type: 'undo',
    })
    expect(game.moves).toHaveLength(0)
    expect(game.autoplay).toBe(false)
  })

  it('enters scoring after two passes and requires both humans', async () => {
    setup()
    let game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
      commentsVisible: true,
    })
    game = await service.command(game.id, {
      expectedVersion: game.version,
      type: 'pass',
    })
    game = await service.command(game.id, {
      expectedVersion: game.version,
      type: 'pass',
    })
    expect(game.status).toBe('scoring')
    game = await service.command(game.id, {
      expectedVersion: game.version,
      type: 'approve-score',
      color: 'B',
    })
    expect(game.status).toBe('scoring')
    game = await service.command(game.id, {
      expectedVersion: game.version,
      type: 'approve-score',
      color: 'W',
    })
    expect(game.status).toBe('finished')
    expect(game.result).toBe('W+7.5')
  })

  it('runs a fake LLM against a human sequentially', async () => {
    setup()
    const game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'llm', name: 'Bot', profileId: 'builtin-fake-profile'},
      white: {type: 'human', name: 'Human'},
      commentsVisible: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const updated = service.get(game.id)!
    expect(updated.moves).toHaveLength(1)
    expect(updated.moves[0].comment).toBeTruthy()
    expect(updated.moves[0].reasoning).toContain('first legal intersection')
    expect(updated.moves[0].providerKind).toBe('fake')
    expect(updated.toMove).toBe('W')
  })

  it('runs one model action from paused and pauses again', async () => {
    setup()
    const game = pausedModelGame(store, service)

    await service.command(game.id, {
      expectedVersion: game.version,
      type: 'step',
    })

    await waitFor(() => service.get(game.id)?.moves.length === 1)
    expect(service.get(game.id)).toMatchObject({
      status: 'paused',
      autoplay: false,
      pauseAfterMove: false,
    })
  })

  it('arms an in-flight model request without aborting it', async () => {
    store = new Store(':memory:')
    let resolveAction!: (
      value: Awaited<ReturnType<PlayerAdapter['requestAction']>>,
    ) => void
    let requestSignal: AbortSignal | undefined
    const result = new Promise<
      Awaited<ReturnType<PlayerAdapter['requestAction']>>
    >((resolve) => {
      resolveAction = resolve
    })
    const adapter = {
      requestAction(_snapshot, signal) {
        requestSignal = signal
        return result
      },
    } satisfies PlayerAdapter
    service = new GameService(store, () => adapter)
    const game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'llm', name: 'Bot', profileId: 'builtin-fake-profile'},
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    })
    await waitFor(() => service.get(game.id)?.pending === true)

    await service.command(game.id, {
      expectedVersion: service.get(game.id)!.version,
      type: 'step',
    })
    expect(requestSignal?.aborted).toBe(false)
    resolveAction(modelAction('pass'))

    await waitFor(() => service.get(game.id)?.moves.length === 1)
    expect(service.get(game.id)).toMatchObject({
      status: 'paused',
      autoplay: false,
    })
  })

  it('commits exactly one action when both seats are models', async () => {
    setup()
    const game = pausedModelGame(store, service, true)

    await service.command(game.id, {
      expectedVersion: game.version,
      type: 'step',
    })

    await waitFor(() => service.get(game.id)?.status === 'paused')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.get(game.id)?.moves).toHaveLength(1)
  })

  it('preserves terminal and scoring states after a stepped action', async () => {
    store = new Store(':memory:')
    let action: 'resign' | 'pass' = 'resign'
    const adapter = {
      async requestAction() {
        return modelAction(action)
      },
    } satisfies PlayerAdapter
    service = new GameService(store, () => adapter)
    const resigning = pausedModelGame(store, service)
    await service.command(resigning.id, {
      expectedVersion: resigning.version,
      type: 'step',
    })
    await waitFor(() => service.get(resigning.id)?.status === 'finished')
    expect(service.get(resigning.id)?.pauseAfterMove).toBe(false)

    action = 'pass'
    let scoring = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
      commentsVisible: true,
    })
    scoring = await service.command(scoring.id, {
      expectedVersion: scoring.version,
      type: 'pass',
    })
    const persisted = store.getGame(scoring.id)!
    persisted.white = {
      type: 'llm',
      name: 'Bot',
      profileId: 'builtin-fake-profile',
    }
    persisted.status = 'paused'
    persisted.autoplay = false
    store.saveGame(persisted)
    await service.command(persisted.id, {
      expectedVersion: persisted.version,
      type: 'step',
    })
    await waitFor(() => service.get(persisted.id)?.status === 'scoring')
    expect(service.get(persisted.id)?.pauseAfterMove).toBe(false)
  })

  it('rejects stepping human, errored, and benchmark-controlled turns', async () => {
    setup()
    const human = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
      commentsVisible: true,
    })
    await expect(
      service.command(human.id, {
        expectedVersion: human.version,
        type: 'step',
      }),
    ).rejects.toThrow('not controlled by a model')

    const errored = pausedModelGame(store, service)
    errored.error = 'provider failed'
    store.saveGame(errored)
    await expect(
      service.command(errored.id, {
        expectedVersion: errored.version,
        type: 'step',
      }),
    ).rejects.toThrow('without an error')

    const benchmark = pausedModelGame(store, service)
    benchmark.benchmarkRunId = 'benchmark'
    store.saveGame(benchmark)
    await expect(
      service.command(benchmark.id, {
        expectedVersion: benchmark.version,
        type: 'step',
      }),
    ).rejects.toThrow('controlled by their benchmark')
  })

  it('restores a persisted step latch after restart', async () => {
    setup()
    const game = pausedModelGame(store, service)
    game.status = 'active'
    game.autoplay = true
    game.pauseAfterMove = true
    store.saveGame(game)

    service = new GameService(store)
    service.restoreAutoplay()

    await waitFor(() => service.get(game.id)?.moves.length === 1)
    expect(service.get(game.id)).toMatchObject({
      status: 'paused',
      autoplay: false,
      pauseAfterMove: false,
    })
  })

  it('waits for a session key when restoring LLM autoplay', async () => {
    setup()
    store.saveConnection({
      id: 'restart-provider',
      name: 'Restart provider',
      kind: 'openai',
      supportsStructuredOutput: false,
    })
    store.saveProfile({
      id: 'restart-profile',
      name: 'Restart model',
      connectionId: 'restart-provider',
      modelId: 'gpt-5.6-sol',
      temperature: 0,
    })
    const game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'Temporary human'},
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    })
    const persisted = store.getGame(game.id)!
    persisted.black = {
      type: 'llm',
      name: 'Restart model',
      profileId: 'restart-profile',
    }
    store.saveGame(persisted)

    service.restoreAutoplay()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(service.get(game.id)).toMatchObject({
      status: 'active',
      autoplay: true,
      moves: [],
    })
  })

  it('retries API failures five times and pauses with a useful error', async () => {
    store = new Store(':memory:')
    let requests = 0
    let waits = 0
    const adapter = {
      async requestAction() {
        requests += 1
        throw new Error('provider temporarily unavailable')
      },
    } satisfies PlayerAdapter
    service = new GameService(
      store,
      () => adapter,
      async () => {
        waits += 1
      },
    )

    const game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'llm', name: 'Bot', profileId: 'builtin-fake-profile'},
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    })

    await waitFor(() => service.get(game.id)?.status === 'paused')
    expect(requests).toBe(5)
    expect(waits).toBe(4)
    expect(service.get(game.id)).toMatchObject({
      status: 'paused',
      autoplay: false,
      error:
        'LLM API request failed after 5 attempts. The game has been paused. Last error: provider temporarily unavailable',
    })
  })

  it('allows five invalid move attempts before stopping the game', async () => {
    store = new Store(':memory:')
    const repairMessages: string[] = []
    let requests = 0
    const adapter = {
      async requestTurn(request, signal) {
        signal.throwIfAborted()
        requests += 1
        if (request.kind === 'repair') repairMessages.push(request.content)
        return {
          text: '{"move":"A9","reason":"Try occupied point."}',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          providerKind: 'fake' as const,
        }
      },
      async requestAction() {
        throw new Error('Legacy request path should not be used')
      },
    } satisfies PlayerAdapter
    service = new GameService(store, () => adapter)

    let game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'Human'},
      white: {
        type: 'llm',
        name: 'Bot',
        profileId: 'builtin-fake-profile',
      },
      commentsVisible: true,
    })
    game = await service.command(game.id, {
      expectedVersion: game.version,
      type: 'play',
      coordinate: 'A9',
    })

    await waitFor(() => service.get(game.id)?.status === 'error')
    expect(requests).toBe(5)
    expect(repairMessages).toEqual(Array(4).fill('Intersection is occupied'))
    expect(service.get(game.id)?.rejectedModelActions).toHaveLength(5)
    expect(service.get(game.id)?.error).toBe(
      'Model failed to produce a legal action after 5 attempts: Intersection is occupied',
    )
  })

  it('reports API retry progress while the next request is pending', async () => {
    store = new Store(':memory:')
    let requests = 0
    let completeRetry!: (
      result: Awaited<ReturnType<PlayerAdapter['requestAction']>>,
    ) => void
    const retryResult = new Promise<
      Awaited<ReturnType<PlayerAdapter['requestAction']>>
    >((resolve) => {
      completeRetry = resolve
    })
    const adapter = {
      async requestAction() {
        requests += 1
        if (requests === 1) throw new Error('rate limited')
        return retryResult
      },
    } satisfies PlayerAdapter
    service = new GameService(
      store,
      () => adapter,
      async () => {},
    )

    const game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'llm', name: 'Bot', profileId: 'builtin-fake-profile'},
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    })

    await waitFor(() => service.get(game.id)?.modelTurn?.phase === 'retrying')
    expect(service.get(game.id)).toMatchObject({
      pending: true,
      modelTurn: {
        phase: 'retrying',
        attempt: 2,
        maxAttempts: 5,
        lastError: 'rate limited',
      },
    })

    completeRetry({
      action: {action: 'pass', comment: 'Recovered.'},
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: 'test-model',
      retries: 0,
    })
    await waitFor(() => service.get(game.id)?.moves.length === 1)
    expect(service.get(game.id)?.moves[0].retries).toBe(1)
    expect(service.get(game.id)?.moves[0].retryErrors).toEqual(['rate limited'])
  })

  it('keeps provider failures through resume and records them on recovery', async () => {
    store = new Store(':memory:')
    let requests = 0
    const adapter = {
      async requestAction() {
        requests += 1
        if (requests <= 5) throw new Error(`TLS failure ${requests}`)
        return {
          action: {action: 'pass' as const, comment: 'Recovered.'},
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
    } satisfies PlayerAdapter
    service = new GameService(
      store,
      () => adapter,
      async () => {},
    )

    const created = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'llm', name: 'Bot', profileId: 'builtin-fake-profile'},
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    })

    await waitFor(() => service.get(created.id)?.status === 'paused')
    const paused = service.get(created.id)!
    expect(paused.providerErrors).toHaveLength(5)
    await service.command(created.id, {
      expectedVersion: paused.version,
      type: 'resume',
    })
    await waitFor(() => service.get(created.id)?.moves.length === 1)

    const recovered = service.get(created.id)!
    expect(recovered.providerErrors).toBeUndefined()
    expect(recovered.moves[0].retryErrors).toHaveLength(5)
  })

  it('falls back to visible transcript after managed continuation returns no output', async () => {
    store = new Store(':memory:')
    const requests: Array<{
      kind: string
      previousResponseId?: string
      transcriptLength: number
      cacheKey: string
    }> = []
    let calls = 0
    let moveResponses = 0
    const adapter = {
      async requestAction() {
        throw new Error('Legacy request path should not be used')
      },
      async requestTurn(request, signal) {
        signal.throwIfAborted()
        calls += 1
        requests.push({
          kind: request.kind,
          previousResponseId: request.previousResponseId,
          transcriptLength: request.transcript.length,
          cacheKey: request.cacheKey,
        })
        if (request.kind === 'summary')
          return {
            text: 'Keep developing the open-side influence.',
            latencyMs: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            model: 'test-model',
            providerKind: 'openai' as const,
          }
        if (calls === 2)
          throw new NoOutputGeneratedError({
            message: 'No output generated. Check the stream for errors.',
          })
        moveResponses += 1
        const move = ['A9', 'C9', 'E9'][moveResponses - 1]
        return {
          text: JSON.stringify({move, reason: 'Test move.'}),
          providerContinuationId: `resp-${calls}`,
          latencyMs: 0,
          inputTokens: 0,
          cachedInputTokens: moveResponses * 128,
          outputTokens: 0,
          model: 'test-model',
          providerKind: 'openai' as const,
        }
      },
    } satisfies PlayerAdapter
    service = new GameService(store, () => adapter)
    const profile = store.getProfile('builtin-fake-profile')!
    store.saveConnection({
      id: 'managed-openai',
      name: 'Managed OpenAI',
      kind: 'openai',
      supportsStructuredOutput: false,
    })
    store.saveProfile({...profile, connectionId: 'managed-openai'})
    service.vault.set('managed-openai', 'test-key')
    let game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'llm', name: 'Bot', profileId: profile.id},
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    })
    await waitFor(() => service.get(game.id)?.moves.length === 1)

    game = await service.command(game.id, {
      expectedVersion: service.get(game.id)!.version,
      type: 'play',
      coordinate: 'B9',
    })
    await waitFor(() => service.get(game.id)?.moves.length === 3)
    expect(requests.slice(0, 4)).toEqual(
      [
        {kind: 'initial', previousResponseId: undefined, transcriptLength: 0},
        {
          kind: 'continuation',
          previousResponseId: 'resp-1',
          transcriptLength: 2,
        },
        {kind: 'summary', previousResponseId: 'resp-1', transcriptLength: 2},
        {kind: 'initial', previousResponseId: undefined, transcriptLength: 0},
      ].map((request) => ({
        ...request,
        cacheKey: `linggo:${game.id}:B`,
      })),
    )
    expect(store.getLlmGameContext(game.id, 'B')).toMatchObject({
      managedContinuation: false,
      providerContinuationId: undefined,
      gameIntention: 'Keep developing the open-side influence.',
    })
    expect(service.get(game.id)?.moves[0].cachedInputTokens).toBe(128)
    expect(service.get(game.id)?.moves[2].cachedInputTokens).toBe(256)

    await service.command(game.id, {
      expectedVersion: service.get(game.id)!.version,
      type: 'play',
      coordinate: 'D9',
    })
    await waitFor(() => service.get(game.id)?.moves.length === 5)
    expect(requests[4]).toEqual({
      kind: 'continuation',
      previousResponseId: undefined,
      transcriptLength: 2,
      cacheKey: `linggo:${game.id}:B`,
    })
  })

  it('pauses immediately for a permanent provider request error', async () => {
    store = new Store(':memory:')
    let requests = 0
    let waits = 0
    const adapter = {
      async requestAction() {
        requests += 1
        throw Object.assign(new Error('Unsupported request field'), {
          statusCode: 400,
          isRetryable: false,
        })
      },
    } satisfies PlayerAdapter
    service = new GameService(
      store,
      () => adapter,
      async () => {
        waits += 1
      },
    )

    const game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'llm', name: 'Bot', profileId: 'builtin-fake-profile'},
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    })

    await waitFor(() => service.get(game.id)?.status === 'paused')
    expect(requests).toBe(1)
    expect(waits).toBe(0)
    expect(service.get(game.id)?.error).toContain('after 1 attempt')
  })

  it('allows operator recovery actions after a model error', async () => {
    setup()
    let game = service.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
      commentsVisible: true,
    })
    const persisted = store.getGame(game.id)!
    persisted.status = 'error'
    persisted.error = 'provider unavailable'
    persisted.autoplay = false
    store.saveGame(persisted)
    game = await service.command(game.id, {
      expectedVersion: persisted.version,
      type: 'force-pass',
    })
    expect(game.moves.at(-1)?.action).toBe('pass')
    expect(game.status).toBe('active')
  })
})

function pausedModelGame(store: Store, service: GameService, both = false) {
  const game = service.create({
    size: 9,
    komi: 7.5,
    black: {type: 'human', name: 'Temporary'},
    white: {type: 'human', name: 'Human'},
    commentsVisible: true,
  })
  game.black = {
    type: 'llm',
    name: 'Bot',
    profileId: 'builtin-fake-profile',
  }
  if (both)
    game.white = {
      type: 'llm',
      name: 'Bot 2',
      profileId: 'builtin-fake-profile',
    }
  game.status = 'paused'
  game.autoplay = false
  store.saveGame(game)
  return game
}

function modelAction(action: 'pass' | 'resign') {
  return {
    action: {action, comment: 'Test action'},
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: 'test-model',
    retries: 0,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('Timed out waiting for game state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
