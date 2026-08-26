import {afterEach, describe, expect, it} from 'vitest'
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
    expect(service.get(game.id)?.moves[0].retryErrors).toEqual([
      'rate limited',
    ])
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
    service = new GameService(store, () => adapter, async () => {})

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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('Timed out waiting for game state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
