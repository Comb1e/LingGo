import {afterEach, describe, expect, it} from 'vitest'
import {AnalysisService, formatLlmHistory} from './analysis'
import {Store} from './database'
import {GameService} from './games'
import type {BenchmarkRun} from '../shared/types'
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

  it('shares complete win-rate history from the current LLM perspective', async () => {
    store = new Store(':memory:')
    const games = new GameService(store)
    const analysis = new AnalysisService(store, games, engine)
    const game = games.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'B'},
      white: {type: 'human', name: 'W'},
      commentsVisible: true,
      analysisEnabled: true,
      shareAnalysisWithLlm: false,
    })
    const version = game.version
    const enabled = analysis.update(game.id, {shareWithLlm: true})
    expect(enabled).toMatchObject({enabled: true, shareWithLlm: true})
    const history = await analysis.contextForLlm(
      game,
      new AbortController().signal,
    )
    expect(history).toBe(
      'Turn 0: your win rate 60.00%; opponent 40.00%',
    )
    expect(games.get(game.id)!.version).toBe(version)
    expect(
      formatLlmHistory(analysis.get(game.id), 'W'),
    ).toContain('your win rate 40.00%')
    expect(analysis.update(game.id, {enabled: false})).toMatchObject({
      enabled: false,
      shareWithLlm: false,
    })
    await analysis.close()
  })

  it('reports benchmark win-rate sharing from the run configuration', async () => {
    store = new Store(':memory:')
    const games = new GameService(store)
    const analysis = new AnalysisService(store, games, engine)
    const now = new Date().toISOString()
    const profile = store.getProfile('builtin-fake-profile')!
    const run: BenchmarkRun = {
      id: 'benchmark',
      status: 'running',
      phase: 'training',
      config: {
        profileId: profile.id,
        finalColor: 'B',
        visits: 25,
        includeTrainingWinRates: true,
        notebookMode: 'reset',
      },
      profileSnapshot: profile,
      modelFingerprint: 'fingerprint',
      currentGame: 0,
      currentTurn: 0,
      gameIds: [],
      usage: {calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0},
      notebook: {profileId: profile.id},
      createdAt: now,
      updatedAt: now,
    }
    store.saveBenchmark(run)
    const training = games.createBenchmarkGame({
      runId: run.id,
      gameIndex: 0,
      llmColor: 'B',
      profileId: profile.id,
      profileName: profile.name,
    })
    const final = games.createBenchmarkGame({
      runId: run.id,
      gameIndex: 10,
      llmColor: 'B',
      profileId: profile.id,
      profileName: profile.name,
    })

    expect(analysis.open(training.id)).toMatchObject({
      enabled: true,
      shareWithLlm: true,
      managedByBenchmark: true,
    })
    expect(analysis.open(final.id)).toMatchObject({
      enabled: true,
      shareWithLlm: false,
      managedByBenchmark: true,
    })
    expect(() => analysis.update(training.id, {shareWithLlm: false})).toThrow(
      'Benchmark analysis settings are controlled by the benchmark run',
    )
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
