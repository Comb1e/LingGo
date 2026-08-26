import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import type {KataGoAnalyzer} from './katago'
import {Store} from './database'
import {GameService} from './games'
import {
  BenchmarkService,
  calculateMetrics,
  mergeInGameReflections,
  pointLossQuality,
} from './benchmarks'
import {NotebookStore} from './notebooks'
import {makeBenchmarkMovePrompt, makePrompt, makeReflectionPrompt, type PlayerAdapter} from './providers'
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
    const snapshot = makeSnapshot(19, 7.5, [])
    snapshot.captures = {B: 4, W: 2}
    const prompt = makeBenchmarkMovePrompt(snapshot, '# Shape\nStay connected.', {phase: 'final'})
    expect(prompt.match(/^\d+\./gm)).toHaveLength(5)
    expect(prompt).toContain('2. SELF-WRITTEN SKILLS\n# Shape')
    expect(prompt).not.toContain('PLAYING STYLE')
    expect(prompt).not.toContain('WIN-RATE')
    expect(prompt).not.toContain('scoreLead')
    expect(prompt).not.toContain('candidate')
    expect(prompt).not.toContain('variation')
    expect(prompt).toContain('you have captured 4 opponent stones; the opponent has captured 2 of your stones')
  })

  it('explains benchmark move legality, captures, and scoring', () => {
    const snapshot = makeSnapshot(13, 6.5, [])
    const prompt = makeBenchmarkMovePrompt(snapshot, '', {
      phase: 'training',
    })
    expect(prompt).toContain('played on a 13x13 grid. Black moves first')
    expect(prompt).toContain('Orthogonally adjacent stones of one color form a chain and share liberties')
    expect(prompt).toContain('remove every adjacent opposing chain with no liberties')
    expect(prompt).toContain('leaves its own chain with no liberties after those captures is suicide')
    expect(prompt).toContain('may not recreate any earlier complete board position')
    expect(prompt).toContain('Two consecutive passes end play for scoring')
    expect(prompt).toContain('living stones on the board plus empty intersections surrounded only by that color')
    expect(prompt).toContain('Captured stones do not add points directly; their removal can create territory')
    expect(prompt).toContain('Neutral intersections score for neither side. White adds 6.5 komi')
    expect(prompt.split('\n\n2. ')[0]).toBe(makePrompt(snapshot).split('\n\n2. ')[0])
  })

  it('adds and rewrites numbered in-game reflections', () => {
    expect(mergeInGameReflections(
      [
        {number: 1, reflection: 'The corner is settled.'},
        {number: 3, reflection: 'Keep sente.'},
      ],
      [
        {number: 2, reflection: 'Count liberties first.'},
        {number: 1, reflection: 'The corner still has a cutting point.'},
      ],
    )).toEqual([
      {number: 1, reflection: 'The corner still has a cutting point.'},
      {number: 2, reflection: 'Count liberties first.'},
      {number: 3, reflection: 'Keep sente.'},
    ])
  })

  it('keeps reflections inside the five-section final move prompt', () => {
    const prompt = makeBenchmarkMovePrompt(makeSnapshot(19, 7.5, []), '', {
      phase: 'final',
      inGameReflections: [
        {number: 1, reflection: 'Do not answer a shoulder hit too passively.'},
      ],
    })
    expect(prompt.match(/^\d+\./gm)).toHaveLength(5)
    expect(prompt).toContain('"in_game_reflections":[{"number":1,"reflection":"lesson from this game"}]')
    expect(prompt).toContain(
      '{"number":1,"reflection":"Do not answer a shoulder hit too passively."}',
    )
    expect(prompt).toContain('reuse a number to replace an incorrect earlier entry')
  })

  it('adds complete training feedback only to training move and reflection prompts', () => {
    const snapshot = makeSnapshot(19, 7.5, [])
    const history = 'Turn 0: 50.00%\nTurn 1: 42.00%'
    const movePrompt = makeBenchmarkMovePrompt(snapshot, '', {phase: 'training', winRateHistory: history})
    const reflection = makeReflectionPrompt({
      notebook: '',
      games: [{sequence: 1, snapshot, result: 'W+2.5', llmColor: 'B', winRateHistory: history}],
    })
    expect(movePrompt).toContain(`6. TRAINING WIN-RATE HISTORY\n${history}`)
    expect(reflection).toContain(`TURN-ALIGNED WIN-RATE HISTORY - GAME 1\n${history}`)
    expect(movePrompt).not.toContain('PLAYING STYLE')
    expect(reflection).not.toContain('PLAYING STYLE')
  })

  it('shows prior moves in the JSON coordinate system', () => {
    const snapshot = makeSnapshot(19, 7.5, [{
      number: 1,
      color: 'B',
      action: 'play',
      point: [0, 0],
      coordinate: 'A19',
      comment: '',
      captured: 1,
      capturedPoints: [[1, 1]],
    }])
    snapshot.moves[0].captured = 1
    snapshot.moves[0].capturedPoints = [[1, 1]]
    expect(makeBenchmarkMovePrompt(snapshot, '', {phase: 'training'}))
      .toContain('1. B A19 [0,0]; captured 1 at B18 [1,1]')
  })

  it('includes the LLM comments and reasoning in training and final move prompts', () => {
    const snapshot = makeSnapshot(19, 7.5, [
      {
        number: 1,
        color: 'B',
        action: 'play',
        point: [3, 15],
        coordinate: 'D4',
        comment: 'Take the open corner.',
        reasoning: 'This leaves flexible extensions.',
        captured: 0,
      },
      {
        number: 2,
        color: 'W',
        action: 'play',
        point: [15, 3],
        coordinate: 'Q16',
        comment: 'KataGo move.',
        captured: 0,
      },
    ])

    for (const phase of ['training', 'final'] as const) {
      const prompt = makeBenchmarkMovePrompt(snapshot, '', {phase})
      expect(prompt).toContain(
        '1. B D4 [3,15]; your comment: "Take the open corner."; your reasoning: "This leaves flexible extensions."',
      )
      expect(prompt).not.toContain('your comment: "KataGo move."')
    }
  })

  it('marks every game and move in sequence with all recorded comments and thoughts', () => {
    const first = makeSnapshot(19, 7.5, [{
      number: 1,
      color: 'B',
      action: 'play',
      point: [3, 15],
      coordinate: 'D4',
      comment: 'Build lower-side influence.\nKeep sente.',
      reasoning: 'I compared the two open corners.',
      captured: 0,
    }])
    first.moves[0].captured = 1
    first.moves[0].capturedPoints = [[4, 4]]
    first.captures.B = 1
    const second = makeSnapshot(19, 7.5, [{
      number: 1,
      color: 'B',
      action: 'pass',
      comment: 'KataGo passed.',
      captured: 0,
    }, {
      number: 2,
      color: 'W',
      action: 'resign',
      comment: 'The position is lost.',
      reasoning: 'No practical winning chances remain.',
      captured: 0,
    }])

    const prompt = makeReflectionPrompt({
      notebook: '# Existing lesson',
      games: [
        {sequence: 1, snapshot: first, result: 'B+R', llmColor: 'B'},
        {sequence: 2, snapshot: second, result: 'B+R', llmColor: 'W'},
      ],
    })

    expect(prompt.indexOf('=== GAME 1 ===')).toBeLessThan(prompt.indexOf('=== GAME 2 ==='))
    expect(prompt).toContain('--- MOVE 1/1 ---')
    expect(prompt).toContain('--- MOVE 1/2 ---')
    expect(prompt).toContain('--- MOVE 2/2 ---')
    expect(prompt).toContain('"comment":"Build lower-side influence.\\nKeep sente."')
    expect(prompt).toContain('"thought":"I compared the two open corners."')
    expect(prompt).toContain('"comment":"The position is lost."')
    expect(prompt).toContain('"thought":"No practical winning chances remain."')
    expect(prompt).toContain('"capturedStones":0')
    expect(prompt).toContain('"capturedAt":["E15 [4,4]"]')
    expect(prompt).toContain('Capture totals: LLM captured 1 opponent stones; opponent captured 0 LLM stones.')
    expect(prompt).toContain('=== END GAME 2 ===')
  })

  it('requires current-game reflections to be consolidated into broader experience', () => {
    const prompt = makeReflectionPrompt({
      notebook: '# Existing lesson',
      games: [{
        sequence: 1,
        snapshot: makeSnapshot(19, 7.5, []),
        result: 'W+2.5',
        llmColor: 'B',
        inGameReflections: [
          {number: 1, reflection: 'Review forcing moves before defending.'},
        ],
      }],
    })
    expect(prompt).toContain('must incorporate the supplied in-game reflections')
    expect(prompt).toContain('IN-GAME REFLECTIONS - GAME 1')
    expect(prompt).toContain(
      '{"number":1,"reflection":"Review forcing moves before defending."}',
    )
  })

  it('runs ten alternating training games and one scored final game', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-'))
    const games = new GameService(store)
    const reflectionPrompts: string[] = []
    const adapter = {
      async requestAction(snapshot, signal) {
        signal.throwIfAborted()
        return {
          action: {action: 'pass', comment: `Comment at turn ${snapshot.moves.length}`},
          reasoning: `Thought at turn ${snapshot.moves.length}`,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
      async requestText(prompt, signal) {
        signal.throwIfAborted()
        reflectionPrompts.push(prompt)
        return {
          text: '# Go techniques',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          model: 'test-model',
        }
      },
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      games,
      fakeKataGo,
      new NotebookStore(directory),
      () => adapter,
    )
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
    expect(reflectionPrompts).toHaveLength(10)
    expect(reflectionPrompts[0].match(/^=== GAME \d+ ===$/gm)).toHaveLength(1)
    expect(reflectionPrompts[9].match(/^=== GAME \d+ ===$/gm)).toHaveLength(10)
    expect(reflectionPrompts[9]).toContain('"comment":"Comment at turn 0"')
    expect(reflectionPrompts[9]).toContain('"comment":"Comment at turn 1"')
    expect(reflectionPrompts[9]).toContain('"thought":"Thought at turn 0"')
    expect(reflectionPrompts[9]).toContain('"thought":"Thought at turn 1"')
    expect(reflectionPrompts[9].match(/"comment":"Comment at turn/g)).toHaveLength(10)
    expect(reflectionPrompts[9].match(/"comment":"KataGo passed\."/g)).toHaveLength(10)
    expect(reflectionPrompts[9].match(/"thought":"Thought at turn/g)).toHaveLength(10)
    await service.close()
  })

  it('retries an occupied benchmark move on the unchanged position', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-retry-'))
    const games = new GameService(store)
    const prompts: string[] = []
    const adapter = {
      async requestAction(snapshot, signal, prompt) {
        signal.throwIfAborted()
        prompts.push(prompt ?? '')
        const repeatsOccupiedPoint =
          snapshot.toMove === 'B' &&
          snapshot.moves.length === 2 &&
          !snapshot.previousError
        const opensAtA19 = snapshot.toMove === 'B' && snapshot.moves.length === 0
        return {
          action: opensAtA19 || repeatsOccupiedPoint
            ? {action: 'play' as const, coordinate: 'A19', comment: 'Play the corner.'}
            : {action: 'pass' as const, comment: 'Pass after correction.'},
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
      async requestText(_prompt, signal) {
        signal.throwIfAborted()
        return {text: '# Lessons', inputTokens: 0, outputTokens: 0, latencyMs: 0, model: 'test-model'}
      },
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      games,
      fakeKataGo,
      new NotebookStore(directory),
      () => adapter,
    )
    const run = await service.create({
      profileId: 'builtin-fake-profile',
      finalColor: 'W',
      visits: 25,
      includeTrainingWinRates: true,
      notebookMode: 'reset',
    })

    expect(await waitFor(() => service.get(run.id)?.status === 'completed', 2_000)).toBe(true)
    const correction = prompts.find((prompt) => prompt.includes('Intersection is occupied'))
    expect(correction).toContain('The position is unchanged; choose a different legal move.')
    expect(correction).toContain('1. B A19 [0,0]')
    expect(service.get(run.id)?.error).toBeUndefined()
    await service.close()
  })

  it('carries reflections through one game and resets them before the next', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-in-game-reflection-'))
    const games = new GameService(store)
    const firstMovePrompts: string[] = []
    const followUpPrompts: string[] = []
    const reflectionPrompts: string[] = []
    let gameSequence = 0
    const adapter = {
      async requestAction(_snapshot, signal, prompt) {
        signal.throwIfAborted()
        const value = prompt ?? ''
        const startsGame = value.includes(
          'Current in-game reflections (this game only):\n(none yet)',
        )
        if (startsGame) {
          gameSequence += 1
          firstMovePrompts.push(value)
        } else {
          followUpPrompts.push(value)
        }
        return {
          action: startsGame
            ? {action: 'play' as const, coordinate: 'A19', comment: 'Open.'}
            : {action: 'pass' as const, comment: 'Finish.'},
          inGameReflections: startsGame
            ? [{number: 1, reflection: `Initial lesson for game ${gameSequence}.`}]
            : [
                {number: 1, reflection: `Revised lesson for game ${gameSequence}.`},
                {number: 2, reflection: `Second lesson for game ${gameSequence}.`},
              ],
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
      async requestText(prompt, signal) {
        signal.throwIfAborted()
        reflectionPrompts.push(prompt)
        return {text: '# Lessons', inputTokens: 0, outputTokens: 0, latencyMs: 0, model: 'test-model'}
      },
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      games,
      fakeKataGo,
      new NotebookStore(directory),
      () => adapter,
    )
    const run = await service.create({
      profileId: 'builtin-fake-profile',
      finalColor: 'W',
      visits: 25,
      includeTrainingWinRates: false,
      notebookMode: 'reset',
    })

    expect(await waitFor(() => service.get(run.id)?.status === 'completed', 2_000)).toBe(true)
    expect(firstMovePrompts).toHaveLength(11)
    expect(followUpPrompts).toHaveLength(11)
    expect(followUpPrompts[0]).toContain(
      '{"number":1,"reflection":"Initial lesson for game 1."}',
    )
    expect(firstMovePrompts[1]).not.toContain('lesson for game 1')
    expect(reflectionPrompts).toHaveLength(10)
    expect(reflectionPrompts[0]).toContain(
      '{"number":1,"reflection":"Revised lesson for game 1."}',
    )
    expect(reflectionPrompts[0]).toContain(
      '{"number":2,"reflection":"Second lesson for game 1."}',
    )
    expect(reflectionPrompts[0]).not.toContain('Initial lesson for game 1')
    expect(reflectionPrompts[9]).toContain('IN-GAME REFLECTIONS - GAME 10')
    expect(reflectionPrompts[9]).not.toContain('IN-GAME REFLECTIONS - GAME 9')
    expect((service.get(run.id) as {inGameReflections?: unknown[]}).inGameReflections).toEqual([])
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
