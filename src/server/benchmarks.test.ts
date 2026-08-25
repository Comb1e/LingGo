import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import type {KataGoAnalyzer} from './katago'
import {Store} from './database'
import {GameService} from './games'
import {BenchmarkService, calculateMetrics, pointLossQuality} from './benchmarks'
import {NotebookStore} from './notebooks'
import {makeBenchmarkMovePrompt, makeReflectionPrompt} from './providers'
import {makeSnapshot} from './go'

let store: Store | undefined
let directory: string | undefined
afterEach(async () => {
  store?.close()
  if (directory) await rm(directory, {recursive: true, force: true})
})

const fakeKataGo: KataGoAnalyzer = {
  async analyze(input) {
    return {
      id: 'fake',
      rootInfo: {winrate: 0.5, scoreLead: 0, visits: input.visits},
      moveInfos: [{move: 'pass', visits: input.visits, winrate: 0.5, scoreLead: 0}],
    }
  },
  async healthCheck() {
    return {ok: true, message: 'ready'}
  },
  async close() {},
}

describe('benchmark scoring and prompts', () => {
  it('applies all point-loss score bands and combines result equally', () => {
    expect([0.5, 1.5, 3, 6, 12, 13].map(pointLossQuality)).toEqual([100, 85, 65, 40, 15, 0])
    const metrics = calculateMetrics('B+2.5', 'B', [0.5, 1.5], [0.1, 0.2])
    expect(metrics).toMatchObject({
      moveQuality: 92.5,
      resultScore: 100,
      score: 96.25,
      averagePointLoss: 1,
    })
    expect(metrics.averageWinRateLoss).toBeCloseTo(0.15)
  })

  it('keeps final prompts to exactly five sections with no style or analysis data', () => {
    const prompt = makeBenchmarkMovePrompt(makeSnapshot(19, 7.5, []), '# Shape\nStay connected.', {phase: 'final'})
    expect(prompt.match(/^\d+\./gm)).toHaveLength(5)
    expect(prompt).toContain('2. SELF-WRITTEN SKILLS\n# Shape')
    expect(prompt).not.toContain('PLAYING STYLE')
    expect(prompt).not.toContain('WIN-RATE')
    expect(prompt).not.toContain('scoreLead')
    expect(prompt).not.toContain('candidate')
    expect(prompt).not.toContain('variation')
  })

  it('adds complete training feedback only to training move and reflection prompts', () => {
    const snapshot = makeSnapshot(19, 7.5, [])
    const history = 'Turn 0: 50.00%\nTurn 1: 42.00%'
    const movePrompt = makeBenchmarkMovePrompt(snapshot, '', {phase: 'training', winRateHistory: history})
    const reflection = makeReflectionPrompt({notebook: '', snapshot, result: 'W+2.5', llmColor: 'B', winRateHistory: history})
    expect(movePrompt).toContain(`6. TRAINING WIN-RATE HISTORY\n${history}`)
    expect(reflection).toContain(`TURN-ALIGNED WIN-RATE HISTORY\n${history}`)
    expect(movePrompt).not.toContain('PLAYING STYLE')
    expect(reflection).not.toContain('PLAYING STYLE')
  })

  it('runs ten alternating training games and one scored final game', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-'))
    const games = new GameService(store)
    const service = new BenchmarkService(store, games, fakeKataGo, new NotebookStore(directory))
    const run = await service.create({
      profileId: 'builtin-fake-profile',
      finalColor: 'W',
      visits: 25,
      includeTrainingWinRates: true,
      notebookMode: 'reset',
    })
    const completed = await waitFor(() => service.get(run.id)?.status === 'completed', 2_000)
    expect(completed).toBe(true)
    const saved = service.get(run.id)!
    expect(saved.gameIds).toHaveLength(11)
    expect(saved.metrics).toMatchObject({result: 'Draw', resultScore: 50, moveCount: 1})
    const records = saved.gameIds.map((id) => games.get(id)!)
    expect(records.slice(0, 10).map((game) => game.black.type)).toEqual([
      'llm', 'katago', 'llm', 'katago', 'llm', 'katago', 'llm', 'katago', 'llm', 'katago',
    ])
    expect(records[10].white.type).toBe('llm')
    expect((await service.notebooks.readSnapshot(run.id))).toContain('# Go techniques')
    await service.close()
  })
})

async function waitFor(predicate: () => boolean, timeout: number) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}
