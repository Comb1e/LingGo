import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import type {KataGoAnalyzer} from './katago'
import type {GameSnapshot} from '../shared/types'
import {coordinateToPoint} from '../shared/coordinates'
import {Store} from './database'
import {GameService} from './games'
import {
  BenchmarkConflictError,
  BenchmarkService,
  applyLifeDeathNotebookPatch,
  calculateMetrics,
  compareMoveReviews,
  formatReviewCandidates,
  lossFromPerspective,
  pointLossQuality,
  reviewCandidate,
  reviewCandidateChoices,
} from './benchmarks'
import {NotebookStore} from './notebooks'
import {
  MalformedModelOutputError,
  type LlmTurnRequest,
  type PlayerAdapter,
} from './providers'
import {makeSnapshot} from './go'
import {makeInitialLlmPrompt, perspectiveOutcome} from './llmGameContext'
import {formatCanonicalGoRules} from './movePrompt'
import {loadProblemSet} from './benchmarkProblems'

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
  it('applies partial JSON-addressed life-and-death notebook edits', () => {
    const prior = '# Life notes\n\n1. Read liberties.\n2. Keep shape.'
    expect(
      applyLifeDeathNotebookPatch(
        prior,
        '{"1":"Read forcing replies before choosing the vital point."}',
      ),
    ).toBe(
      '# Life notes\n\n1. Read forcing replies before choosing the vital point.\n2. Keep shape.',
    )
    expect(() =>
      applyLifeDeathNotebookPatch(prior, '# Rewritten notebook'),
    ).toThrow('Patch is not valid JSON')
    expect(applyLifeDeathNotebookPatch(prior, '{"3":"New note."}')).toBe(
      '# Life notes\n\n1. Read liberties.\n2. Keep shape.\n3. New note.',
    )
    expect(
      applyLifeDeathNotebookPatch(
        prior,
        '{"1":"Read forcing replies.","2":"Preserve eye shape."}',
      ),
    ).toBe('# Life notes\n\n1. Read forcing replies.\n2. Preserve eye shape.')
  })

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
    expect(prompt).not.toContain('BACKGROUND')
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
      {
        kind: 'benchmark',
        phase: 'training',
        notebook: '',
        trainingFeedback: 'structured',
      },
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
    expect(prompt).toContain('KATAGO TRAINING FEEDBACK')
    expect(prompt).toContain('top five ranked KataGo candidates')
    expect(prompt).toContain('not recommendations for the current position')
    expect(prompt).toContain(
      "Candidate #1 is KataGo's best choice and is the baseline for the reported win-rate loss",
    )
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
    expect(saved.usage.cachedInputTokens).toBe(99)
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
    expect(saved.llmMessages?.[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining(
        'Write a complete Markdown Go technique notebook',
      ),
    })
    expect(saved.llmMessages?.[1]).toMatchObject({
      role: 'assistant',
      content: '# Go techniques',
    })
    expect(reflectionPrompts).toHaveLength(11)
    expect(reflectionPrompts[0]).toContain('AUTHORITATIVE GO RULES')
    expect(reflectionPrompts[1]).toContain('Outcome: Draw')
    expect(reflectionPrompts[10]).toContain(
      'Return only the complete replacement Markdown technique notebook.',
    )
    expect(reflectionPrompts[10]).toContain('PRIOR NOTEBOOK')
    expect(reflectionPrompts[10]).toContain('Comment at turn')
    expect(reflectionPrompts[10]).not.toContain('Thought at turn')
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
      expect(reflections).toBe(trainingGameCount + 1)
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

  it('runs with-win-rate training games before games without them', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(
      join(tmpdir(), 'linggo-benchmark-feedback-split-'),
    )
    const games = new GameService(store)
    const reviewPrompts: string[] = []
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
      async requestText(prompt: string) {
        reviewPrompts.push(prompt)
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
      ...v2Config('builtin-fake-profile'),
      trainingGameCount: 5,
      trainingGamesWithWinRates: 2,
      trainingGamesWithoutWinRates: 3,
    })

    expect(
      await waitFor(
        () => service.get(created.id)?.status === 'completed',
        5_000,
      ),
    ).toBe(true)
    const run = service.get(created.id)!
    expect(run.config).toMatchObject({
      trainingGameCount: 5,
      trainingGamesWithWinRates: 2,
      trainingGamesWithoutWinRates: 3,
    })
    expect(
      store.listBenchmarkMoveReviews(run.id).map(({gameIndex}) => gameIndex),
    ).toEqual([0, 1, 5])
    expect(reviewPrompts).toHaveLength(6)
    expect(reviewPrompts[1]).toContain('Largest mistakes')
    expect(reviewPrompts[2]).toContain('Largest mistakes')
    expect(reviewPrompts[3]).not.toContain('Largest mistakes')
    expect(reviewPrompts[4]).not.toContain('Largest mistakes')
    expect(reviewPrompts[5]).not.toContain('Largest mistakes')
    await service.close()
  })

  it('pauses after the next LLM move without aborting an in-flight request', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-step-'))
    const games = new GameService(store)
    const requestEntered = deferred()
    const actionGate = deferred()
    let requestSignal: AbortSignal | undefined
    let requests = 0
    const adapter = {
      async requestText() {
        return {
          text: '# Technique Notebook',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
        }
      },
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
    const service = new BenchmarkService(
      store,
      new GameService(store),
      fakeKataGo,
      notebooks,
    )
    const winner = service.create({
      ...benchmarkConfig('builtin-fake-profile'),
      notebookId: 'default',
    })
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

    const created = await winner
    expect(created.status).toBe('queued')
    service.cancel(created.id)
    await service.close()
  })

  it('settles after five illegal benchmark moves', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-retry-'))
    const games = new GameService(store)
    const prompts: string[] = []
    const reflectionPrompts: string[] = []
    const adapter = {
      async requestAction(snapshot, signal, prompt) {
        signal.throwIfAborted()
        prompts.push(prompt ?? '')
        return {
          action:
            snapshot.toMove === 'B' && snapshot.moves.length <= 2
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
      async requestText(prompt, signal) {
        signal.throwIfAborted()
        if (prompt.includes('GAME REVIEW')) reflectionPrompts.push(prompt)
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
    expect(
      prompts.filter((prompt) => prompt === 'Intersection is occupied'),
    ).toHaveLength(20)
    const rejection = games
      .list()
      .flatMap((game) => game.rejectedModelActions ?? [])
      .filter(({reason}) => reason.includes('Intersection is occupied'))
      .at(-1)
    expect(rejection).toMatchObject({turn: 3, attempt: 5, truncated: false})
    expect(rejection?.responseContent).toContain('A19')
    const endedEarly = games
      .list()
      .find(
        (game) => game.benchmarkRunId === run.id && game.benchmarkTermination,
      )
    expect(endedEarly).toMatchObject({
      status: 'finished',
      benchmarkTermination: {
        kind: 'invalid_llm_actions',
        turn: 3,
        actionCount: 5,
        reason: 'Intersection is occupied',
      },
    })
    expect(
      reflectionPrompts.some(
        (prompt) =>
          prompt.includes(
            'Termination: This game ended early because you produced 5 illegal actions.',
          ) &&
          prompt.includes(
            'The final rejected action was for turn 3: Intersection is occupied.',
          ) &&
          prompt.includes(
            'The outcome above is the board score at termination, not a normally completed game.',
          ),
      ),
    ).toBe(true)
    expect(service.get(run.id)?.status).toBe('completed')
    expect(service.get(run.id)?.error).toBeUndefined()
    await service.close()
  })

  it('combines pass-limit and occupied violations across turns', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-pass-limit-'))
    const games = new GameService(store)
    const attemptsByPosition = new Map<number, number>()
    const adapter = {
      async requestAction(snapshot, signal) {
        signal.throwIfAborted()
        const passCount = snapshot.moves.filter(
          (move) => move.color === snapshot.toMove && move.action === 'pass',
        ).length
        if (snapshot.moves.length === 0) attemptsByPosition.clear()
        if (passCount < 2)
          return {
            action: {action: 'pass' as const, comment: 'Pass.'},
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: 'test-model',
            retries: 0,
          }
        const attempts =
          (attemptsByPosition.get(snapshot.moves.length) ?? 0) + 1
        attemptsByPosition.set(snapshot.moves.length, attempts)
        return {
          action:
            attempts <= 3
              ? {
                  action: 'play' as const,
                  coordinate: 'A19',
                  comment: 'Try the occupied corner.',
                }
              : {action: 'pass' as const, comment: 'Pass again.'},
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
    const kataMoves = [
      'A19',
      'B19',
      'C19',
      'D19',
      'E19',
      'F19',
      'G19',
      'H19',
      'J19',
      'K19',
    ]
    const kataGo: KataGoAnalyzer = {
      async analyze(input) {
        const used = new Set(
          input.moves
            .filter((move) => move.action === 'play')
            .map((move) => move.coordinate),
        )
        const move = kataMoves.find((coordinate) => !used.has(coordinate))
        return {
          id: 'pass-limit-test',
          rootInfo: {winrate: 0.5, scoreLead: 0, visits: input.visits},
          moveInfos: [
            {
              move: move ?? 'pass',
              visits: input.visits,
              winrate: 0.5,
              scoreLead: 0,
            },
          ],
        }
      },
      async healthCheck() {
        return {ok: true, message: 'ready'}
      },
      async close() {},
    }
    const service = new BenchmarkService(
      store,
      games,
      kataGo,
      new NotebookStore(directory),
      () => adapter,
    )
    const run = await service.create({
      ...v2Config('builtin-fake-profile'),
      finalColor: 'B',
      trainingGamesWithWinRates: 0,
      trainingGamesWithoutWinRates: 1,
    })

    expect(
      await waitFor(() => service.get(run.id)?.status === 'completed', 2_000),
    ).toBe(true)
    const runGames = games
      .list()
      .filter((game) => game.benchmarkRunId === run.id)
    expect(runGames).toHaveLength(2)
    expect(runGames.every((game) => game.status === 'finished')).toBe(true)
    const rejections = runGames.flatMap(
      (game) => game.rejectedModelActions ?? [],
    )
    expect(
      rejections.filter(({reason}) =>
        reason.includes('may pass at most twice'),
      ),
    ).toHaveLength(4)
    expect(
      rejections.filter(({reason}) =>
        reason.includes('Intersection is occupied'),
      ),
    ).toHaveLength(6)
    await service.close()
  })

  it('allows five invalid benchmark outputs and records their actual attempts', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-output-retry-'))
    const games = new GameService(store)
    let requests = 0
    const adapter = {
      async requestTurn(request, signal) {
        signal.throwIfAborted()
        requests += 1
        return {
          text: '{"move":"A19"}',
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
      await waitFor(() => service.get(run.id)?.status === 'paused', 2_000),
    ).toBe(true)
    expect(requests).toBe(5)
    const rejected = games
      .list()
      .flatMap((game) => game.rejectedModelActions ?? [])
      .filter(({reason}) => reason.includes('Invalid model move JSON'))
    expect(rejected.map(({attempt}) => attempt)).toEqual([1, 2, 3, 4, 5])
    await service.close()
  })

  it('retries API failures and reports the pause on the linked game', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-benchmark-api-retry-'))
    const games = new GameService(store)
    let requests = 0
    const adapter = {
      async requestText() {
        return {
          text: '# Technique Notebook',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
        }
      },
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
      async requestText(prompt) {
        if (!prompt.includes('GAME REVIEW'))
          return {
            text: '# Technique Notebook',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            model: 'test-model',
          }
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
    expect(game.error).toContain('after 5 attempts during notebook review')
    expect(game.modelTurn).toBeUndefined()
    await service.close()
  })

  it('initializes before creating a game and owns every notebook version', async () => {
    store = new Store(':memory:')
    const games = new GameService(store)
    const source = store.createNotebook('builtin-fake-profile', 'Source')
    store.db
      .prepare('UPDATE technique_notebooks SET content = ? WHERE id = ?')
      .run('# Original source', source.id)
    const initializationEntered = deferred()
    const initializationGate = deferred()
    const prompts: string[] = []
    const adapter = {
      async requestText(prompt: string, signal: AbortSignal) {
        signal.throwIfAborted()
        prompts.push(prompt)
        if (prompt.includes('AUTHORITATIVE GO RULES')) {
          initializationEntered.resolve()
          await initializationGate.promise
        }
        return {
          text: prompt.includes('GAME REVIEW')
            ? '# Learned notebook'
            : '# Initialized notebook',
          inputTokens: 3,
          outputTokens: 2,
          latencyMs: 1,
          model: 'test-model',
        }
      },
      async requestAction() {
        return {
          action: {action: 'pass' as const, comment: 'Visible reason.'},
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
      new NotebookStore(store),
      () => adapter,
    )
    const created = await service.create({
      profileId: 'builtin-fake-profile',
      finalColor: 'B',
      trainingGameCount: 1,
      notebookSeed: {mode: 'refine_existing', notebookId: source.id},
      trainingFeedback: 'structured',
      notebookTokenBudget: 8000,
      trainingVisits: 25,
      evaluationVisits: 50,
    })
    await initializationEntered.promise
    expect(service.get(created.id)).toMatchObject({
      phase: 'initializing_notebook',
      gameIds: [],
    })
    expect(service.llmMessageSets(created.id)[0].messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining(
          'Write a complete Markdown Go technique notebook',
        ),
        pending: true,
      }),
    ])
    const moveRules = makeInitialLlmPrompt(makeSnapshot(19, 7.5, []), {
      kind: 'benchmark',
      phase: 'training',
      notebook: '',
    })
    for (const rule of formatCanonicalGoRules({size: 19, komi: 7.5})) {
      expect(prompts[0]).toContain(rule)
      expect(moveRules).toContain(rule)
    }
    expect(prompts[0]).toContain('# Original source')
    expect(prompts[0].split('\n', 1)[0]).toBe(
      'Keep the complete Markdown notebook to at most 8,000 estimated tokens, where estimated tokens are ceil(UTF-8 bytes / 4).',
    )
    expect(prompts[0].indexOf('at most 8,000 estimated tokens')).toBeLessThan(
      prompts[0].indexOf('Write a complete Markdown Go technique notebook'),
    )
    expect(prompts[0]).not.toContain('Use exactly this Markdown structure')
    expect(prompts[0]).not.toContain('## Opening')
    expect(prompts[0]).not.toContain('## Fighting')
    expect(prompts[0]).not.toContain('## Shape and Life')
    expect(prompts[0]).not.toContain('## Endgame')
    expect(prompts[0]).not.toContain('## Move Checklist')
    initializationGate.resolve()
    expect(
      await waitFor(
        () => service.get(created.id)?.status === 'completed',
        2000,
      ),
    ).toBe(true)

    const versions = store.listBenchmarkNotebookVersions(created.id)
    expect(versions).toHaveLength(2)
    expect(versions.map(({version}) => version)).toEqual([1, 2])
    for (const version of versions) {
      expect(version.digest).toHaveLength(64)
      expect(version.characterCount).toBe([...version.content].length)
      expect(version.byteCount).toBe(Buffer.byteLength(version.content, 'utf8'))
      expect(version.estimatedTokens).toBe(Math.ceil(version.byteCount / 4))
    }
    expect(store.getNotebook('builtin-fake-profile', source.id)?.content).toBe(
      '# Original source',
    )
    const run = service.get(created.id)!
    expect(service.llmMessageSets(created.id)[0].messages.at(-1)).toMatchObject(
      {
        role: 'assistant',
        content: '# Learned notebook',
      },
    )
    expect(run.usage.byPhase?.initializing_notebook?.calls).toBe(1)
    expect(run.usage.byPhase?.reviewing_game?.calls).toBe(1)
    expect(store.listBenchmarkMoveReviews(created.id)).toHaveLength(2)

    const published = service.publishNotebook(created.id, {
      mode: 'save_new',
      name: 'Learned copy',
    })
    expect(published.content).toBe('# Learned notebook')
    service.publishNotebook(created.id, {mode: 'replace_source'})
    expect(store.getNotebook('builtin-fake-profile', source.id)?.content).toBe(
      '# Learned notebook',
    )
    await service.close()
  })

  it('forbids direct answers in life-and-death notebook updates', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-life-notebook-prompt-'))
    const games = new GameService(store)
    const set = loadProblemSet('gogameguru-easy')
    const promptReady = deferred()
    const responseGate = deferred()
    const prompts: string[] = []
    const actionPrompts: string[] = []
    let actionCalls = 0
    const adapter = {
      async requestAction(
        _snapshot: unknown,
        _signal: AbortSignal,
        promptOverride?: string,
      ) {
        actionCalls += 1
        if (promptOverride) actionPrompts.push(promptOverride)
        const action =
          actionCalls === 1
            ? ({action: 'pass', comment: 'Pass.'} as const)
            : set.problems[0].solution[actionCalls - 2]
        return {
          action,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
      async requestText(prompt: string, signal: AbortSignal) {
        prompts.push(prompt)
        if (prompt.includes('Update the technique notebook')) {
          promptReady.resolve()
          await responseGate.promise
        }
        signal.throwIfAborted()
        return {
          text: '# Life techniques',
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
      ...v2Config('builtin-fake-profile'),
      problemSetId: set.id,
      problemSetChecksum: set.checksum,
    })

    await promptReady.promise
    const visibleMessages = service.llmMessageSets(created.id)
    expect(visibleMessages).toHaveLength(1)
    expect(visibleMessages[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Update the technique notebook'),
          pending: true,
        }),
      ]),
    )
    expect(prompts[0]).toContain(
      'A life-and-death problem is a local tactical position',
    )
    expect(prompts[0].split('\n', 1)[0]).toBe(
      'Keep the complete Markdown notebook to at most 8,000 estimated tokens, where estimated tokens are ceil(UTF-8 bytes / 4).',
    )
    expect(prompts[0]).toContain('A defender aims for unconditional life')
    expect(prompts[0]).toContain(
      'Record reusable reading techniques, shapes, vital points, liberties, eye-space concepts, and move-order principles.',
    )
    expect(prompts[0]).not.toContain('AUTHORITATIVE GO RULES')
    expect(prompts[0]).not.toContain('komi')
    expect(prompts[0]).not.toContain('passing')
    expect(prompts[0]).not.toContain('resignation')
    expect(actionPrompts).toHaveLength(4)
    const solvingPrompt = actionPrompts[0]
    expect(solvingPrompt).not.toContain('AUTHORITATIVE GO RULES')
    expect(solvingPrompt).not.toContain('GO RULES')
    expect(solvingPrompt).toContain(
      'Board symbols: X = Black stone, O = White stone, . = empty intersection.',
    )
    expect(actionPrompts[1]).toContain('The previous attempt failed.')
    expect(actionPrompts[1]).toContain('Reason:')
    expect(actionPrompts[1]).toContain(
      'Redo the problem from this current position.',
    )
    expect(actionPrompts[1]).toContain('OUTPUT JSON SCHEMA')
    expect(actionPrompts[1]).toContain(
      'Board symbols: X = Black stone, O = White stone, . = empty intersection.',
    )
    expect(actionPrompts[1]).toContain(
      '{"move":"<coordinate, pass, or resign>","reason":"<brief explanation>"}',
    )
    expect(actionPrompts[1]).not.toContain('Your previous action was')
    expect(actionPrompts[1]).not.toContain('Move list:')
    expect(actionPrompts[0].indexOf('SELF-WRITTEN SKILLS')).toBeLessThan(
      actionPrompts[0].indexOf('CURRENT BOARD'),
    )
    expect(actionPrompts.slice(1)).toEqual(
      expect.not.arrayContaining([
        expect.stringContaining('SELF-WRITTEN SKILLS'),
      ]),
    )
    expect(prompts.at(-1)).toContain(
      'Do not write the direct answer to an individual life-and-death problem in this notebook.',
    )
    expect(prompts.at(-1)).toContain(
      "do not include the problem's answer coordinate or a step-by-step solution sequence.",
    )
    service.pause(created.id)
    responseGate.resolve()
    expect(
      await waitFor(() => service.get(created.id)?.status === 'paused', 2000),
    ).toBe(true)
    await service.close()
  })

  it('updates one notebook note after five failures and retries with a new context', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-life-context-reset-'))
    const set = loadProblemSet('gogameguru-easy')
    const problem = set.problems[0]
    const redoReady = deferred()
    const redoGate = deferred()
    let actionCalls = 0
    let patchRequest: LlmTurnRequest | undefined
    let redoRequest: LlmTurnRequest | undefined
    const adapter = {
      async requestAction() {
        throw new Error('Transcript turn path should be used')
      },
      async requestTurn(request: LlmTurnRequest, signal: AbortSignal) {
        signal.throwIfAborted()
        if (request.output === 'notebook') {
          patchRequest = request
          return {
            text: '{"1":"Read every forcing reply before choosing the vital point."}',
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: 'test-model',
            providerKind: 'fake' as const,
          }
        }
        actionCalls += 1
        if (actionCalls === 6) {
          redoRequest = request
          redoReady.resolve()
          await redoGate.promise
          signal.throwIfAborted()
        }
        const action =
          actionCalls <= 5
            ? ({action: 'play', coordinate: 'O4', comment: 'Try O4.'} as const)
            : problem.solution[0]
        return {
          text: JSON.stringify({
            move: action.action === 'play' ? action.coordinate : action.action,
            reason: action.comment ?? 'Continue reading.',
          }),
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          providerKind: 'fake' as const,
        }
      },
      async requestText(_prompt: string, signal: AbortSignal) {
        signal.throwIfAborted()
        return {
          text: '# Life techniques\n\n1. Read liberties.\n2. Preserve shape.',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          model: 'test-model',
        }
      },
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      new GameService(store),
      fakeKataGo,
      new NotebookStore(directory),
      () => adapter,
    )
    const created = await service.create({
      ...v2Config('builtin-fake-profile'),
      problemSetId: set.id,
      problemSetChecksum: set.checksum,
    })

    await redoReady.promise
    expect(actionCalls).toBe(6)
    expect(service.problemAttempts(created.id)).toHaveLength(5)
    expect(patchRequest?.transcript).toEqual([])
    expect(patchRequest?.content).toContain('FAILED ATTEMPTS')
    expect(patchRequest?.content.match(/Feedback:/g)).toHaveLength(5)
    expect(patchRequest?.content.match(/Action: O4\./g)).toHaveLength(5)
    expect(patchRequest?.content).toContain(
      'Board symbols: X = Black stone, O = White stone, . = empty intersection.',
    )
    expect(patchRequest?.content).toContain(
      'UPDATE TRIGGER: FAILED_AFTER_5_ATTEMPTS',
    )
    expect(patchRequest?.content).toContain('NOTEBOOK PATCH OUTPUT JSON SCHEMA')
    expect(patchRequest?.content).toContain(
      'You may edit multiple notes in one response',
    )
    expect(patchRequest?.content).toContain('"minProperties": 1')
    expect(patchRequest?.content).toContain(
      'or a new positive integer note number to add.',
    )
    expect(patchRequest?.content).toContain(
      'least perfect or is flawed according to the attempt',
    )
    expect(patchRequest?.content).toContain('do not default to note 1')
    expect(patchRequest?.content).not.toContain(
      '{"1":"Read every forcing reply before choosing the vital point."}',
    )
    expect(patchRequest?.content).toContain(
      'Add a new numbered note only when no existing note captures the lesson.',
    )
    expect(patchRequest?.content).not.toContain('PRIOR NOTEBOOK')
    expect(patchRequest?.content).not.toContain('1. Read liberties.')
    expect(patchRequest?.content).not.toContain('MODEL ANSWER')
    expect(redoRequest?.transcript).toEqual([])
    expect(await service.notebooks.readSnapshot(created.id)).toBe(
      '# Life techniques\n\n1. Read every forcing reply before choosing the vital point.\n2. Preserve shape.',
    )

    service.pause(created.id)
    redoGate.resolve()
    expect(
      await waitFor(() => service.get(created.id)?.status === 'paused', 2000),
    ).toBe(true)
    await service.close()
  })

  it('caches problem turns and advances the board after each correct step', async () => {
    store = new Store(':memory:')
    directory = await mkdtemp(join(tmpdir(), 'linggo-life-progression-'))
    const set = loadProblemSet('gogameguru-easy')
    const problem = set.problems[0]
    const updateReady = deferred()
    const updateGate = deferred()
    const prompts: string[] = []
    const snapshots: GameSnapshot[] = []
    const cacheKeys: Array<string | undefined> = []
    let notebookUpdatePrompt = ''
    let actionIndex = 0
    const adapter = {
      async requestAction(
        snapshot: GameSnapshot,
        signal: AbortSignal,
        prompt?: string,
        cacheKey?: string,
      ) {
        signal.throwIfAborted()
        snapshots.push(snapshot)
        prompts.push(prompt ?? '')
        cacheKeys.push(cacheKey)
        return {
          action: problem.solution[actionIndex++],
          latencyMs: 0,
          inputTokens: 10,
          cachedInputTokens: actionIndex > 1 ? 8 : 0,
          outputTokens: 1,
          model: 'test-model',
          retries: 0,
        }
      },
      async requestText(prompt: string, signal: AbortSignal) {
        if (prompt.includes('Update the technique notebook')) {
          notebookUpdatePrompt = prompt
          updateReady.resolve()
          await updateGate.promise
        }
        signal.throwIfAborted()
        return {
          text: '# Life techniques',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          model: 'test-model',
        }
      },
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      new GameService(store),
      fakeKataGo,
      new NotebookStore(directory),
      () => adapter,
    )
    const created = await service.create({
      ...v2Config('builtin-fake-profile'),
      problemSetId: set.id,
      problemSetChecksum: set.checksum,
    })

    await updateReady.promise
    expect(prompts).toHaveLength(problem.solution.length)
    expect(prompts[0]).toContain('SELF-WRITTEN SKILLS')
    expect(prompts[0].indexOf('SELF-WRITTEN SKILLS')).toBeLessThan(
      prompts[0].indexOf('CURRENT BOARD'),
    )
    expect(
      prompts
        .slice(1)
        .every((prompt) => !prompt.includes('SELF-WRITTEN SKILLS')),
    ).toBe(true)
    expect(prompts[1]).toContain('Continue solving')
    expect(prompts[1]).toContain('Expected side to move: W')
    expect(prompts[2]).toContain('Expected side to move: B')
    expect(new Set(cacheKeys)).toEqual(
      new Set([`linggo:benchmark:${created.id}:problem:${problem.id}`]),
    )
    const [firstPoint, secondPoint] = problem.solution
      .slice(0, 2)
      .map((action) =>
        action.action === 'play'
          ? coordinateToPoint(action.coordinate, problem.size)
          : undefined,
      )
    expect(firstPoint).toBeDefined()
    expect(secondPoint).toBeDefined()
    expect(snapshots[1].board[firstPoint![1]][firstPoint![0]]).toBe(1)
    expect(snapshots[2].board[secondPoint![1]][secondPoint![0]]).toBe(2)
    expect(service.get(created.id)?.usage.cachedInputTokens).toBe(16)
    expect(notebookUpdatePrompt).toContain('UPDATE TRIGGER: SUCCESS')
    expect(notebookUpdatePrompt).toContain('NOTEBOOK PATCH OUTPUT JSON SCHEMA')
    expect(notebookUpdatePrompt).toContain(
      'Include only notes that need improvement or are genuinely new.',
    )

    service.pause(created.id)
    updateGate.resolve()
    await service.close()
  })

  it('compresses oversized notebooks and pauses after three invalid outputs', async () => {
    store = new Store(':memory:')
    let calls = 0
    const prompts: string[] = []
    const adapter = {
      async requestText(prompt: string) {
        prompts.push(prompt)
        calls += 1
        return {
          text: calls === 1 ? 'x'.repeat(100) : '# Fine',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
          model: 'test-model',
        }
      },
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
    } satisfies PlayerAdapter
    const service = new BenchmarkService(
      store,
      new GameService(store),
      fakeKataGo,
      new NotebookStore(store),
      () => adapter,
    )
    const compressed = await service.create({
      ...v2Config('builtin-fake-profile'),
      notebookTokenBudget: 8,
    })
    expect(
      await waitFor(
        () => service.get(compressed.id)?.status === 'completed',
        2000,
      ),
    ).toBe(true)
    expect(prompts[1]).toContain('Compress the notebook')
    expect(prompts[1]).not.toContain('Preserve the Markdown structure')
    expect(
      service.get(compressed.id)?.notebookEstimatedTokens,
    ).toBeLessThanOrEqual(8)
    await service.close()

    const invalidStore = new Store(':memory:')
    store.close()
    store = invalidStore
    let invalidCalls = 0
    const invalidService = new BenchmarkService(
      invalidStore,
      new GameService(invalidStore),
      fakeKataGo,
      new NotebookStore(invalidStore),
      () => ({
        async requestText() {
          invalidCalls += 1
          return {
            text: '',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            model: 'test-model',
          }
        },
        async requestAction() {
          throw new Error('A game must not be created')
        },
      }),
    )
    const invalid = await invalidService.create(
      v2Config('builtin-fake-profile'),
    )
    expect(
      await waitFor(
        () => invalidService.get(invalid.id)?.status === 'paused',
        2000,
      ),
    ).toBe(true)
    expect(invalidCalls).toBe(3)
    expect(invalidService.get(invalid.id)?.gameIds).toEqual([])
    expect(invalidService.get(invalid.id)?.error).toContain('three attempts')
    await invalidService.close()
  })

  it('calculates loss from either model color without rewarding improvements', () => {
    const before = {
      blackScoreLead: 4,
      blackWinRate: 0.6,
      whiteWinRate: 0.4,
    }
    const after = {
      blackScoreLead: 1,
      blackWinRate: 0.52,
      whiteWinRate: 0.48,
    }
    const blackLoss = lossFromPerspective('B', before, after)
    expect(blackLoss.pointLoss).toBe(3)
    expect(blackLoss.winRateLoss).toBeCloseTo(0.08)
    expect(lossFromPerspective('W', before, after)).toMatchObject({
      pointLoss: 0,
      winRateLoss: 0,
    })
    const whiteLoss = lossFromPerspective('W', after, before)
    expect(whiteLoss.pointLoss).toBe(3)
    expect(whiteLoss.winRateLoss).toBeCloseTo(0.08)
    expect(reviewCandidate({})).toBeUndefined()
    expect(
      reviewCandidateChoices({
        moveInfos: ['d4', 'Q16', 'pass', 'c3', 'R17', 'A1'].map((move) => ({
          move,
        })),
      }),
    ).toEqual(['D4', 'Q16', 'pass', 'C3', 'R17'])
    expect(
      formatReviewCandidates({
        topCandidate: 'D4',
        topCandidates: ['D4', 'Q16', 'pass', 'C3', 'R17', 'A1'],
      }),
    ).toBe('#1 D4, #2 Q16, #3 pass, #4 C3, #5 R17')
    expect(formatReviewCandidates({topCandidate: 'D4'})).toBe('#1 D4')

    const candidateBasedLoss = lossFromPerspective('B', before, after, {
      winrate: 0.65,
    })
    expect(candidateBasedLoss.beforeWin).toBe(0.65)
    expect(candidateBasedLoss.winRateLoss).toBeCloseTo(0.13)
    expect(
      [
        {pointLoss: 2, turn: 8},
        {pointLoss: 3, turn: 9},
        {pointLoss: 3, turn: 4},
      ].sort(compareMoveReviews),
    ).toEqual([
      {pointLoss: 3, turn: 4},
      {pointLoss: 3, turn: 9},
      {pointLoss: 2, turn: 8},
    ])
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

function v2Config(profileId: string) {
  return {
    profileId,
    finalColor: 'B' as const,
    trainingGameCount: 1,
    notebookSeed: {mode: 'rules_only' as const},
    trainingFeedback: 'structured' as const,
    notebookTokenBudget: 8000,
    trainingVisits: 25,
    evaluationVisits: 50,
  }
}
