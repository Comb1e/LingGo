import {afterEach, describe, expect, it} from 'vitest'
import type {
  BenchmarkMetrics,
  BenchmarkRun,
  BenchmarkSessionConfig,
  TechniqueNotebook,
} from '../shared/types'
import {BenchmarkSessionService} from './benchmarkSessions'
import {BenchmarkConflictError, BenchmarkService} from './benchmarks'
import {Store} from './database'
import {GameService} from './games'
import {DeterministicKataGo} from './katago'

let store: Store | undefined
let benchmarks: BenchmarkService | undefined
let sessions: BenchmarkSessionService | undefined

afterEach(async () => {
  sessions?.close()
  await benchmarks?.close()
  store?.close()
  sessions = undefined
  benchmarks = undefined
  store = undefined
})

describe('benchmark sessions', () => {
  it('starts only easy and gates every next stage in fixed order', () => {
    const fixture = setup()
    const session = fixture.sessions.create(fixture.config)
    const easy = session.stages[0]
    expect(session.currentStage).toBe('easy')
    expect(session.stages.map(({status}) => status)).toEqual([
      'running',
      'pending',
      'pending',
      'pending',
    ])
    expect(() => fixture.sessions.continue(session.id)).toThrow('must complete')

    complete(fixture, easy.runId!, '# Life after easy')
    expect(fixture.sessions.get(session.id)?.status).toBe('awaiting_continue')
    const mediumSession = fixture.sessions.continue(session.id)
    expect(mediumSession.currentStage).toBe('medium')
    expect(mediumSession.stages[1].status).toBe('running')
    expect(
      fixture.store.getBenchmarkNotebookSeed(mediumSession.stages[1].runId!)
        ?.content,
    ).toBe('# Life after easy')
    expect(mediumSession.stages[2].runId).toBeUndefined()
  })

  it('restarts from the stage-start snapshot and preserves earlier stages', () => {
    const fixture = setup()
    let session = fixture.sessions.create(fixture.config)
    complete(fixture, session.stages[0].runId!, '# Easy result')
    session = fixture.sessions.continue(session.id)
    const originalMediumRun = session.stages[1].runId!
    complete(fixture, originalMediumRun, '# Contaminated medium result')

    session = fixture.sessions.restartStage(session.id)
    expect(session.stages[0].status).toBe('completed')
    expect(session.stages[1].attempt).toBe(2)
    expect(session.stages[1].runId).not.toBe(originalMediumRun)
    expect(
      fixture.store.getBenchmarkNotebookSeed(session.stages[1].runId!)?.content,
    ).toBe('# Easy result')
    expect(fixture.sessions.notebook(session.id, 'life_death')).toBe(
      '# Easy result',
    )
  })

  it('carries only life learning across problem stages and gives ordinary both roles', () => {
    const fixture = setup()
    let session = fixture.sessions.create(fixture.config)
    for (const content of ['# Easy', '# Medium', '# Hard']) {
      const current = session.stages.find(
        ({stageKey}) => stageKey === session.currentStage,
      )!
      complete(fixture, current.runId!, content)
      session = fixture.sessions.continue(session.id)
    }
    expect(session.currentStage).toBe('ordinary')
    const ordinary = fixture.benchmarks.get(session.stages[3].runId!)!
    expect(fixture.store.getBenchmarkNotebookSeed(ordinary.id)?.content).toBe(
      '# Ordinary seed',
    )
    expect(ordinary.readOnlyNotebooks).toEqual([
      expect.objectContaining({role: 'life_death', content: '# Hard'}),
    ])
    expect(fixture.sessions.notebook(session.id, 'life_death')).toBe('# Hard')
    expect(fixture.sessions.notebook(session.id, 'ordinary')).toBe(
      '# Ordinary seed',
    )
    complete(fixture, ordinary.id, '# Ordinary learned')
    expect(fixture.sessions.notebook(session.id, 'life_death')).toBe('# Hard')
    expect(fixture.sessions.notebook(session.id, 'ordinary')).toBe(
      '# Ordinary learned',
    )
    expect(
      fixture.sessions
        .notebookVersions(session.id, 'ordinary')
        .map(({role}) => role),
    ).toEqual(['ordinary'])
  })

  it('allows only one active session per profile', () => {
    const fixture = setup()
    fixture.sessions.create(fixture.config)
    expect(() => fixture.sessions.create(fixture.config)).toThrow(
      BenchmarkConflictError,
    )
  })

  it('cancels atomically and deletes linked child data', () => {
    const fixture = setup()
    const session = fixture.sessions.create(fixture.config)
    const runId = session.stages[0].runId!
    const game = fixture.games.createBenchmarkGame({
      runId,
      gameIndex: 0,
      llmColor: 'B',
      profileId: fixture.config.profileId,
      profileName: 'Local learner',
    })
    fixture.store.linkBenchmarkGame(runId, game.id, 0)

    const cancelled = fixture.sessions.cancel(session.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.stages[0].status).toBe('cancelled')
    expect(fixture.benchmarks.get(runId)?.status).toBe('cancelled')

    expect(fixture.sessions.delete(session.id)).toBe(true)
    expect(fixture.sessions.get(session.id)).toBeUndefined()
    expect(fixture.benchmarks.get(runId)).toBeUndefined()
    expect(fixture.store.getGame(game.id)).toBeUndefined()
  })
})

function setup() {
  store = new Store(':memory:')
  const games = new GameService(store)
  benchmarks = new BenchmarkService(store, games, new DeterministicKataGo())
  sessions = new BenchmarkSessionService(store, benchmarks)
  const life = notebook(store, 'Life', '# Life seed')
  const ordinary = notebook(store, 'Ordinary', '# Ordinary seed')
  const config: BenchmarkSessionConfig = {
    profileId: 'builtin-fake-profile',
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
  return {store, games, benchmarks, sessions, config}
}

function notebook(store: Store, name: string, content: string) {
  const value = store.createNotebook('builtin-fake-profile', name)
  store.db
    .prepare('UPDATE technique_notebooks SET content = ? WHERE id = ?')
    .run(content, value.id)
  return store.getNotebook(
    'builtin-fake-profile',
    value.id,
  ) as TechniqueNotebook
}

function complete(
  fixture: ReturnType<typeof setup>,
  runId: string,
  content: string,
) {
  const run = fixture.benchmarks.get(runId) as BenchmarkRun
  if (run.status === 'queued') fixture.benchmarks.pause(runId)
  const now = new Date().toISOString()
  run.status = 'completed'
  run.phase = 'complete'
  run.notebookVersion += 1
  run.notebookEstimatedTokens = Math.ceil(Buffer.byteLength(content) / 4)
  run.notebook.updatedAt = now
  run.metrics = metrics()
  fixture.store.saveBenchmarkNotebookVersion(run, {
    runId,
    version: run.notebookVersion,
    sourcePhase: run.config.problemSetId
      ? 'problem_notebook'
      : 'reviewing_game',
    content,
    digest: '0'.repeat(64),
    characterCount: content.length,
    byteCount: Buffer.byteLength(content),
    estimatedTokens: run.notebookEstimatedTokens,
    createdAt: now,
  })
  fixture.benchmarks.events.emit('changed', runId)
}

function metrics(): BenchmarkMetrics {
  return {
    result: 'Void',
    averagePointLoss: 0,
    averageWinRateLoss: 0,
    moveCount: 0,
    moveQuality: 0,
    resultScore: 0,
    score: 0,
    problemCount: 1,
    problemAttempts: 1,
    firstResponseSuccessRate: 1,
    problemFailures: 0,
    completedCleanCycles: 1,
    kataGoGateReached: true,
  }
}
