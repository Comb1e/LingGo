import {afterEach, describe, expect, it} from 'vitest'
import {Store} from './database'
import {GameService, StaleVersionError} from './games'

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
    expect(updated.toMove).toBe('W')
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
