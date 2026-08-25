import {afterEach, describe, expect, it} from 'vitest'
import {AnalysisService} from './analysis'
import {Store} from './database'
import {GameService} from './games'
import type {KataGoAnalyzer} from './katago'

let store: Store | undefined
afterEach(() => store?.close())

const engine: KataGoAnalyzer = {
  async analyze(input) {
    return {id: 'a', rootInfo: {winrate: 0.6, scoreLead: 1.5, visits: input.visits}}
  },
  async close() {},
}

describe('game analysis', () => {
  it('persists positions without changing game versions and removes undone analysis', async () => {
    store = new Store(':memory:')
    const games = new GameService(store)
    const analysis = new AnalysisService(store, games, engine)
    let game = games.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
      commentsVisible: true,
      analysisEnabled: false,
    })
    game = await games.command(game.id, {expectedVersion: game.version, type: 'play', coordinate: 'D4'})
    const version = game.version
    analysis.backfill(game.id)
    await waitFor(() => analysis.get(game.id).status === 'complete')
    expect(games.get(game.id)!.version).toBe(version)
    expect(analysis.get(game.id).positions.map((value) => value.turn)).toEqual([0, 1])
    game = await games.command(game.id, {expectedVersion: version, type: 'undo'})
    expect(analysis.get(game.id).positions.map((value) => value.turn)).toEqual([0])
    await analysis.close()
  })
})

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 50; index++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out')
}
