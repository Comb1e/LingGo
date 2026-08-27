import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import type {KataGoAnalyzer} from './katago'
import {Store} from './database'
import {GameService} from './games'
import {
  BenchmarkConflictError,
  BenchmarkService,
  calculateMetrics,
  pointLossQuality,
} from './benchmarks'
import {NotebookStore} from './notebooks'
import {MalformedModelOutputError, type PlayerAdapter} from './providers'
import {makeSnapshot} from './go'
import {makeInitialLlmPrompt, perspectiveOutcome} from './llmGameContext'

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
      moveInfos: [
        {move: 'pass', visits: input.visits, winrate: 0.5, scoreLead: 0},
      ],
    }
  },
  async healthCheck() {
    return {ok: true, message: 'ready'}
  },
  async close() {},
}

describe('benchmark scoring and prompts', () => {
  it('applies all point-loss score bands and combines result equally', () => {
    expect([0.5, 1.5, 3, 6, 12, 13].map(pointLossQuality)).toEqual([
      100, 85, 65, 40, 15, 0,
    ])
    const metrics = calculateMetrics('B+2.5', 'B', [0.5, 1.5], [0.1, 0.2])
    expect(metrics).toMatchObject({
      moveQuality: 92.5,
      resultScore: 100,
      score: 96.25,
      averagePointLoss: 1,
    })
    expect(metrics.averageWinRateLoss).toBeCloseTo(0.15)
  })

  it('keeps final initial prompts to exactly five sections with no analysis data', () => {
    const snapshot = makeSnapshot(19, 7.5, [])
    snapshot.captures = {B: 4, W: 2}
    const prompt = makeInitialLlmPrompt(
      snapshot,
      {
        kind: 'benchmark',
        phase: 'final',
        notebook: '# Shape\nStay connected.',
      },
      'Turn 0: 50.00%',
    )
    expect(prompt.match(/^\d+\./gm)).toHaveLength(5)
    expect(prompt).toContain('2. SELF-WRITTEN SKILLS\n# Shape')
    expect(prompt).not.toContain('PLAYING STYLE')
    expect(prompt).not.toContain('WIN-RATE')
    expect(prompt).not.toContain('scoreLead')
    expect(prompt).not.toContain('candidate')
    expect(prompt).not.toContain('variation')
    expect(prompt).toContain('BACKGROUND\nThis is the scored final game.')
    expect(prompt).toContain('maximize your score')
    expect(prompt).not.toContain('The game result does not matter')
    expect(prompt).toContain('Required fields: move')
    expect(prompt).toContain('letter-number coordinate exactly as labeled')
    expect(prompt).toContain('Columns use letters and skip I')
    expect(prompt).toContain('Use "pass" to pass and "resign" to resign')
    expect(prompt).toContain(
      'Do not include any other top-level or nested fields',
    )
    expect(prompt).toContain(
      'The correct output is pure JSON: your entire response must be exactly one valid JSON object and nothing else',
    )
    expect(prompt).toContain(
      'Do not add explanations, introductory or trailing text, comments, or Markdown fences',
    )
    const instruction = prompt.slice(
      prompt.indexOf('3. INSTRUCTION'),
      prompt.indexOf('4. JSON OUTPUT'),
    )
    expect(instruction).not.toContain('final game')
    expect(instruction).not.toContain('training game')
    expect(prompt).toContain('Captures: Black 4, White 2.')
    expect(prompt).not.toContain('From your perspective')
  })

  it('includes static training material and only the latest win-rate update', () => {
    const snapshot = makeSnapshot(13, 6.5, [])
    const prompt = makeInitialLlmPrompt(
      snapshot,
      {kind: 'benchmark', phase: 'training', notebook: ''},
      'Turn 7: 42.00%',
    )
    expect(prompt).toContain('played on a 13x13 grid. Black moves first')
    expect(prompt).toContain(
      'LEGAL MOVE: A play is legal only when it places one stone on an empty intersection',
    )
    expect(prompt).toContain(
      "leaves the played stone's chain with at least one liberty",
    )
    expect(prompt).toContain(
      'Orthogonally adjacent stones of one color form a chain and share liberties',
    )
    expect(prompt).toContain(
      'remove every adjacent opposing chain with no liberties',
    )
    expect(prompt).toContain(
      'leaves its own chain with no liberties after those captures is suicide',
    )
    expect(prompt).toContain(
      'may not recreate any earlier complete board position',
    )
    expect(prompt).toContain('Two consecutive passes end play for scoring')
    expect(prompt).toContain(
      'living stones on the board plus empty intersections surrounded only by that color',
    )
    expect(prompt).toContain(
      'Captured stones do not add points directly; their removal can create territory',
    )
    expect(prompt).toContain(
      'Neutral intersections score for neither side. White adds 6.5 komi',
    )
    expect(prompt).toContain("world's best Go player")
    expect(prompt).toContain('Your primary goal is to learn, not to win')
    expect(prompt).toContain('the result of this training game does not matter')
    expect(prompt).toContain("Study the opponent's decisions")
    expect(prompt).toContain('LATEST TRAINING WIN-RATE UPDATE')
    expect(prompt).toContain('Turn 7: 42.00%')
    expect(prompt).not.toContain('in_game_reflections')
  })

  it.each([
    ['B+7.5', 'B', 'You won by 7.5 points'],
    ['B+7.5', 'W', 'You lost by 7.5 points'],
    ['W+R', 'W', 'You won by resignation'],
    ['W+R', 'B', 'You lost by resignation'],
    ['Draw', 'B', 'Draw'],
  ] as const)(
    'normalizes reflection outcome %s for %s',
    (result, color, expected) => {
      expect(perspectiveOutcome(result, color)).toBe(expected)
    },
  )

  it('runs ten alternating training games and one scored final game', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-'))
    const games = new GameService(store)
    const reflectionPrompts: string[] = []
    const adapter = {
      async requestAction(snapshot, signal) {
        signal.throwIfAborted()
        return {
          action: {
            action: 'pass',
            comment: `Comment at turn ${snapshot.moves.length}`,
          },
          reasoning: `Thought at turn ${snapshot.moves.length}`,
          latencyMs: 0,
          inputTokens: 0,
          cachedInputTokens: 2,
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
          cachedInputTokens: 7,
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
      trainingGameCount: 10,
      notebookId: 'default',
    })
    const completed = await waitFor(
      () => service.get(run.id)?.status === 'completed',
      2_000,
    )
    expect(completed).toBe(true)
    const saved = service.get(run.id)!
    expect(saved.gameIds).toHaveLength(11)
    expect(saved.usage.cachedInputTokens).toBe(92)
    expect(saved.metrics).toMatchObject({
      result: 'Draw',
      resultScore: 50,
      moveCount: 1,
    })
    const records = saved.gameIds.map((id) => games.get(id)!)
    expect(records.slice(0, 10).map((game) => game.black.type)).toEqual([
      'llm',
      'katago',
      'llm',
      'katago',
      'llm',
      'katago',
      'llm',
      'katago',
      'llm',
      'katago',
    ])
    expect(records[10].white.type).toBe('llm')
    expect(await service.notebooks.readSnapshot(run.id)).toContain(
      '# Go techniques',
    )
    expect(reflectionPrompts).toHaveLength(10)
    expect(reflectionPrompts[0]).toContain('Outcome: Draw')
    expect(reflectionPrompts[9]).toContain(
      'Return only the complete replacement Markdown technique notebook.',
    )
    expect(reflectionPrompts[9]).not.toContain('PREVIOUS NOTEBOOK')
    expect(reflectionPrompts[9]).not.toContain('Move list')
    expect(reflectionPrompts[9]).not.toContain('Comment at turn')
    expect(reflectionPrompts[9]).not.toContain('KataGo passed.')
    expect(reflectionPrompts[9]).not.toContain('"comment":')
    expect(reflectionPrompts[9]).not.toContain('Thought at turn')
    expect(reflectionPrompts[9]).not.toContain('"thought":')
    await service.close()
  })

  it.each([1, 100])(
    'uses a configured boundary of %i training games',
    async (trainingGameCount) => {
      store = new Store(':memory:')
      directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-count-'))
      const games = new GameService(store)
      let reflections = 0
      const adapter = {
        async requestAction() {
          return {
            action: {action: 'pass' as const, comment: 'Pass.'},
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: 'test-model',
            retries: 0,
          }
        },
        async requestText() {
          reflections += 1
          return {
            text: '# Lessons',
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
      const created = await service.create({
        ...benchmarkConfig('builtin-fake-profile'),
        trainingGameCount,
        finalColor: 'W',
      })

      expect(
        await waitFor(
          () => service.get(created.id)?.status === 'completed',
          5_000,
        ),
      ).toBe(true)
      const run = service.get(created.id)!
      expect(run.gameIds).toHaveLength(trainingGameCount + 1)
      expect(reflections).toBe(trainingGameCount)
      expect(games.get(run.gameIds[trainingGameCount])?.white.type).toBe('llm')
      expect(
        run.gameIds
          .slice(0, trainingGameCount)
          .map((id) => games.get(id)?.black.type),
      ).toEqual(
        Array.from({length: trainingGameCount}, (_, index) =>
          index % 2 === 0 ? 'llm' : 'katago',
        ),
      )
      await service.close()
    },
  )

  it('pauses after the next LLM move without aborting an in-flight request', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-step-'))
    const games = new GameService(store)
    const requestEntered = deferred()
    const actionGate = deferred()
    let requestSignal: AbortSignal | undefined
    let requests = 0
    const adapter = {
      async requestAction(snapshot, signal) {
        requests += 1
        requestSignal = signal
        requestEntered.resolve()
        if (requests === 1) await actionGate.promise
        signal.throwIfAborted()
        return {
          action: {
            action: 'play' as const,
            coordinate: snapshot.moves.length === 0 ? 'A19' : 'B19',
            comment: 'Continue the benchmark.',
          },
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
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
    const created = await service.create(
      benchmarkConfig('builtin-fake-profile'),
    )
    await requestEntered.promise

    const armed = service.nextMoveAndPause(created.id)
    expect(armed.pauseAfterLlmMove).toBe(true)
    expect(requestSignal?.aborted).toBe(false)
    actionGate.resolve()

    expect(
      await waitFor(() => service.get(created.id)?.status === 'paused', 2_000),
    ).toBe(true)
    let run = service.get(created.id)!
    expect(run.pauseAfterLlmMove).toBe(false)
    expect(games.get(run.gameIds[0])?.moves).toHaveLength(1)

    service.nextMoveAndPause(created.id)
    expect(
      await waitFor(
        () =>
          service.get(created.id)?.status === 'paused' &&
          games.get(service.get(created.id)!.gameIds[0])?.moves.length === 3,
        2_000,
      ),
    ).toBe(true)
    run = service.get(created.id)!
    expect(requests).toBe(2)
    expect(games.get(run.gameIds[0])?.moves.map((move) => move.color)).toEqual([
      'B',
      'W',
      'B',
    ])
    await service.close()
  })

  it('runs different profiles concurrently and isolates their lifecycle', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-concurrent-'))
    store.saveProfile({
      id: 'second-profile',
      name: 'Second learner',
      connectionId: 'builtin-fake',
      modelId: 'deterministic-v2',
      temperature: 0,
    })
    const games = new GameService(store)
    const gates = new Map([
      ['builtin-fake-profile', deferred()],
      ['second-profile', deferred()],
    ])
    const entered = new Set<string>()
    const service = new BenchmarkService(
      store,
      games,
      fakeKataGo,
      new NotebookStore(directory),
      (_connection, profile) => ({
        async requestAction(_snapshot, signal) {
          entered.add(profile.id)
          await gates.get(profile.id)!.promise
          signal.throwIfAborted()
          return {
            action: {action: 'pass' as const, comment: 'Finish.'},
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: profile.modelId,
            retries: 0,
          }
        },
        async requestText(_prompt, signal) {
          signal.throwIfAborted()
          return {
            text: `# ${profile.name} techniques`,
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: profile.modelId,
          }
        },
      }),
    )
    const first = await service.create(benchmarkConfig('builtin-fake-profile'))
    const second = await service.create(benchmarkConfig('second-profile'))

    expect(await waitFor(() => entered.size === 2, 2_000)).toBe(true)
    expect(service.get(first.id)?.status).toBe('running')
    expect(service.get(second.id)?.status).toBe('running')

    service.pause(first.id)
    gates.get('builtin-fake-profile')!.resolve()
    service.cancel(first.id)
    expect(service.get(first.id)?.status).toBe('cancelled')
    expect(service.get(second.id)?.status).toBe('running')

    gates.get('second-profile')!.resolve()
    expect(
      await waitFor(
        () => service.get(second.id)?.status === 'completed',
        2_000,
      ),
    ).toBe(true)
    expect(service.get(first.id)?.status).toBe('cancelled')

    const replacement = await service.create(
      benchmarkConfig('builtin-fake-profile'),
    )
    expect(
      await waitFor(
        () => service.get(replacement.id)?.status === 'completed',
        2_000,
      ),
    ).toBe(true)
    await service.close()
  })

  it('reserves a profile before asynchronous benchmark setup', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-reservation-'))
    const notebooks = new NotebookStore(directory)
    await notebooks.write(
      'builtin-fake-profile',
      'seed-run',
      '# Existing techniques',
    )
    const healthGate = deferred()
    const healthEntered = deferred()
    const engine: KataGoAnalyzer = {
      ...fakeKataGo,
      async healthCheck() {
        healthEntered.resolve()
        await healthGate.promise
        return {ok: true, message: 'ready'}
      },
    }
    const service = new BenchmarkService(
      store,
      new GameService(store),
      engine,
      notebooks,
    )
    const winner = service.create({
      ...benchmarkConfig('builtin-fake-profile'),
      notebookId: 'default',
    })
    await healthEntered.promise

    await expect(
      service.create({
        ...benchmarkConfig('builtin-fake-profile'),
        trainingGameCount: 10,
        notebookId: 'default',
      }),
    ).rejects.toBeInstanceOf(BenchmarkConflictError)
    expect(await notebooks.readCurrent('builtin-fake-profile')).toBe(
      '# Existing techniques',
    )

    healthGate.resolve()
    const created = await winner
    expect(created.status).toBe('queued')
    service.cancel(created.id)
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
          prompt !== 'Intersection is occupied'
        const opensAtA19 =
          snapshot.toMove === 'B' && snapshot.moves.length === 0
        return {
          action:
            opensAtA19 || repeatsOccupiedPoint
              ? {
                  action: 'play' as const,
                  coordinate: 'A19',
                  comment: 'Play the corner.',
                }
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
        return {
          text: '# Lessons',
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
      trainingGameCount: 10,
      notebookId: 'default',
    })

    expect(
      await waitFor(() => service.get(run.id)?.status === 'completed', 2_000),
    ).toBe(true)
    const correction = prompts.find((prompt) =>
      prompt.includes('Intersection is occupied'),
    )
    expect(correction).toBe('Intersection is occupied')
    const rejection = games
      .list()
      .flatMap((game) => game.rejectedModelActions ?? [])
      .find(({reason}) => reason.includes('Intersection is occupied'))
    expect(rejection).toMatchObject({turn: 3, attempt: 1, truncated: false})
    expect(rejection?.responseContent).toContain('A19')
    expect(service.get(run.id)?.error).toBeUndefined()
    await service.close()
  })

  it('retries API failures and reports the pause on the linked game', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-api-retry-'))
    const games = new GameService(store)
    let requests = 0
    const adapter = {
      async requestAction() {
        requests += 1
        throw new Error(
          'Cannot connect to API: Client network socket disconnected before secure TLS connection was established',
        )
      },
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      games,
      fakeKataGo,
      new NotebookStore(directory),
      () => adapter,
      async () => {},
    )

    const created = await service.create({
      profileId: 'builtin-fake-profile',
      finalColor: 'B',
      visits: 25,
      includeTrainingWinRates: false,
      trainingGameCount: 10,
      notebookId: 'default',
    })

    expect(
      await waitFor(() => service.get(created.id)?.status === 'paused', 2_000),
    ).toBe(true)
    const run = service.get(created.id)!
    const game = games.get(run.gameIds[0])!
    expect(requests).toBe(5)
    expect(game.rejectedModelActions).toBeUndefined()
    expect(game).toMatchObject({
      status: 'paused',
      autoplay: false,
      benchmarkRunId: run.id,
    })
    expect(game.error).toContain('LLM API request failed after 5 attempts')
    expect(game.error).toContain('LINGGO_PROXY_URL')
    expect(game.modelTurn).toBeUndefined()
    await service.close()
  })

  it('retains and truncates malformed response content without reasoning', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-rejected-'))
    const games = new GameService(store)
    const content = 'x'.repeat(32_100)
    let failed = false
    const adapter = {
      async requestAction() {
        if (!failed) {
          failed = true
          throw new MalformedModelOutputError(
            'Invalid model move JSON',
            content,
          )
        }
        return {
          action: {action: 'pass' as const, comment: 'Corrected.'},
          reasoning: 'hidden chain of thought',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
      async requestText() {
        return {
          text: '# Lessons',
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
    const created = await service.create({
      ...benchmarkConfig('builtin-fake-profile'),
      trainingGameCount: 1,
    })
    expect(
      await waitFor(
        () => service.get(created.id)?.status === 'completed',
        2_000,
      ),
    ).toBe(true)
    const rejected = games.get(service.get(created.id)!.gameIds[0])!
      .rejectedModelActions?.[0]
    expect(rejected).toMatchObject({attempt: 1, truncated: true})
    expect(rejected?.responseContent).toHaveLength(32_000)
    expect(JSON.stringify(rejected)).not.toContain('hidden chain of thought')
    await service.close()
  })

  it('reports reflection API failures on the finished linked game', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(
      join(tmpdir(), 'linggo-benchmark-reflection-retry-'),
    )
    const games = new GameService(store)
    let reflections = 0
    const adapter = {
      async requestAction() {
        return {
          action: {action: 'pass' as const, comment: 'End training game.'},
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
      async requestText() {
        reflections += 1
        throw new Error('reflection connection reset')
      },
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      games,
      fakeKataGo,
      new NotebookStore(directory),
      () => adapter,
      async () => {},
    )

    const created = await service.create({
      profileId: 'builtin-fake-profile',
      finalColor: 'B',
      visits: 25,
      includeTrainingWinRates: false,
      trainingGameCount: 10,
      notebookId: 'default',
    })

    expect(
      await waitFor(() => service.get(created.id)?.status === 'paused', 2_000),
    ).toBe(true)
    const run = service.get(created.id)!
    const game = games.get(run.gameIds[0])!
    expect(reflections).toBe(5)
    expect(game.status).toBe('finished')
    expect(game.error).toContain('after 5 attempts during reflection')
    expect(game.modelTurn).toBeUndefined()
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

function benchmarkConfig(profileId: string) {
  return {
    profileId,
    finalColor: 'B' as const,
    visits: 25,
    includeTrainingWinRates: false,
    trainingGameCount: 10,
    notebookId: 'default',
  }
}
