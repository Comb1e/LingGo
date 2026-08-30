import {randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import type {
  BenchmarkConfig,
  BenchmarkNotebookRole,
  BenchmarkRun,
  BenchmarkSession,
  BenchmarkSessionConfig,
  BenchmarkSessionStage,
  BenchmarkStageKey,
  TechniqueNotebook,
} from '../shared/types'
import {benchmarkStageKeys} from '../shared/types'
import {BenchmarkConflictError, BenchmarkService} from './benchmarks'
import {loadProblemSet} from './benchmarkProblems'
import {Store} from './database'

const problemSets: Record<
  Extract<BenchmarkStageKey, 'easy' | 'medium' | 'hard'>,
  string
> = {
  easy: 'gogameguru-easy',
  medium: 'gogameguru-intermediate',
  hard: 'gogameguru-hard',
}

export class BenchmarkSessionService {
  readonly events = new EventEmitter()

  constructor(
    readonly store: Store,
    readonly benchmarks: BenchmarkService,
  ) {
    benchmarks.events.on('changed', this.handleBenchmarkChanged)
  }

  list() {
    return this.store.listBenchmarkSessions()
  }

  get(id: string) {
    return this.store.getBenchmarkSession(id)
  }

  create(config: BenchmarkSessionConfig) {
    this.assertProfileAvailable(config.profileId)
    const lifeNotebook = this.requireNotebook(
      config.profileId,
      config.lifeDeathNotebookId,
    )
    const ordinaryNotebook = this.requireNotebook(
      config.profileId,
      config.ordinaryNotebookId,
    )
    if (lifeNotebook.id === ordinaryNotebook.id)
      throw new Error(
        'Life-and-death and ordinary-game notebooks must be distinct',
      )

    const now = new Date().toISOString()
    const sessionId = randomUUID()
    const stages = benchmarkStageKeys.map((stageKey) =>
      this.newStage(sessionId, stageKey, now),
    )
    const initialization = stages[0]
    const run = this.prepareChild(
      config,
      sessionId,
      initialization.stageKey,
      lifeNotebook,
      undefined,
    )
    initialization.runId = run.id
    initialization.attempt = 1
    initialization.status = 'running'
    initialization.startedAt = now
    const session: BenchmarkSession = {
      id: sessionId,
      profileId: config.profileId,
      status: 'running',
      currentStage: 'life_death_notebook',
      stageIds: stages.map(({id}) => id),
      config,
      notebooks: {} as BenchmarkSession['notebooks'],
      stages,
      createdAt: now,
      updatedAt: now,
    }

    try {
      this.store.transaction(() => {
        this.store.saveBenchmarkSession(session)
        this.store.saveBenchmarkWithSeed(run, lifeNotebook)
        for (const stage of stages)
          this.store.saveBenchmarkSessionStage(
            stage,
            stage.id === initialization.id ? lifeNotebook.content : undefined,
          )
        this.saveInitialNotebook(sessionId, 'life_death', lifeNotebook, now)
        this.saveInitialNotebook(sessionId, 'ordinary', ordinaryNotebook, now)
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new BenchmarkConflictError()
      throw error
    }
    this.benchmarks.activatePreparedSessionChild(run)
    this.emit(sessionId)
    return this.get(sessionId)!
  }

  continue(id: string) {
    const session = this.require(id)
    const current = this.currentStage(session)
    if (
      session.status !== 'awaiting_continue' ||
      current.status !== 'completed'
    )
      throw new Error('The current stage must complete before continuing')
    const index = benchmarkStageKeys.indexOf(session.currentStage)
    const nextKey = benchmarkStageKeys[index + 1]
    if (!nextKey) throw new Error('The benchmark session is already complete')
    const next = session.stages.find(({stageKey}) => stageKey === nextKey)!
    if (next.status !== 'pending' || next.runId)
      throw new Error('The next benchmark stage has already started')
    const role = roleForStage(nextKey)
    const source = this.snapshotNotebook(session, role)
    const readOnly =
      nextKey === 'ordinary'
        ? [this.readOnlyNotebook(session, 'life_death')]
        : undefined
    const run = this.prepareChild(
      session.config,
      session.id,
      nextKey,
      source,
      readOnly,
    )
    const now = new Date().toISOString()
    next.runId = run.id
    next.attempt = 1
    next.status = 'running'
    next.startedAt = now
    next.updatedAt = now
    session.currentStage = nextKey
    session.status = 'running'
    session.updatedAt = now
    this.store.transaction(() => {
      this.store.saveBenchmarkSession(session)
      this.store.saveBenchmarkWithSeed(run, source)
      this.store.saveBenchmarkSessionStage(next, source.content)
    })
    this.benchmarks.activatePreparedSessionChild(run)
    this.emit(id)
    return this.get(id)!
  }

  restartStage(id: string) {
    const session = this.require(id)
    const stage = this.currentStage(session)
    if (!['completed', 'failed'].includes(stage.status))
      throw new Error('Only the current completed or failed stage can restart')
    const content = this.store.getBenchmarkStageStartContent(stage.id)
    if (content === undefined)
      throw new Error('The stage-start notebook snapshot is missing')
    const role = stage.writableNotebookRole
    const snapshot = this.snapshotNotebook(session, role)
    const source = {...snapshot, content}
    const readOnly =
      stage.stageKey === 'ordinary'
        ? [this.readOnlyNotebook(session, 'life_death')]
        : undefined
    session.status = 'restarting_stage'
    session.updatedAt = new Date().toISOString()
    const run = this.prepareChild(
      session.config,
      session.id,
      stage.stageKey,
      source,
      readOnly,
    )
    const now = new Date().toISOString()
    stage.runId = run.id
    stage.attempt += 1
    stage.status = 'running'
    stage.metrics = undefined
    stage.startedAt = now
    stage.completedAt = undefined
    stage.updatedAt = now
    session.status = 'running'
    session.completedAt = undefined
    session.error = undefined
    session.updatedAt = now
    this.store.transaction(() => {
      this.store.saveBenchmarkSession(session)
      this.store.saveBenchmarkWithSeed(run, source)
      this.store.saveBenchmarkSessionStage(stage, content)
      this.store.saveBenchmarkSessionNotebookSnapshot({
        sessionId: session.id,
        role,
        notebookId: source.id,
        notebookName: source.name,
        content,
        version: 0,
        estimatedTokens: Math.ceil(Buffer.byteLength(content, 'utf8') / 4),
        stageKey: stage.stageKey,
        updatedAt: now,
      })
    })
    this.benchmarks.activatePreparedSessionChild(run)
    this.emit(id)
    return this.get(id)!
  }

  pause(id: string) {
    return this.childCommand(id, (runId) => this.benchmarks.pause(runId))
  }

  resume(id: string) {
    return this.childCommand(id, (runId) => this.benchmarks.resume(runId))
  }

  nextMoveAndPause(id: string) {
    return this.childCommand(id, (runId) =>
      this.benchmarks.nextMoveAndPause(runId),
    )
  }

  cancel(id: string) {
    const session = this.require(id)
    if (['completed', 'cancelled'].includes(session.status))
      throw new Error('The benchmark session has already ended')
    const stage = this.currentStage(session)
    const run = stage.runId ? this.benchmarks.get(stage.runId) : undefined
    let cancelledRun: BenchmarkRun | undefined
    const now = new Date().toISOString()
    session.status = 'cancelled'
    session.updatedAt = now
    if (stage.status === 'running') {
      stage.status = 'cancelled'
      stage.completedAt = now
      stage.updatedAt = now
    }
    this.store.transaction(() => {
      if (run && ['queued', 'running', 'paused'].includes(run.status))
        cancelledRun = this.benchmarks.cancelSessionChild(run.id)
      this.store.saveBenchmarkSessionStage(stage)
      this.store.saveBenchmarkSession(session)
    })
    if (cancelledRun) this.benchmarks.notifySessionChild(cancelledRun)
    this.emit(id)
    return this.get(id)!
  }

  delete(id: string) {
    const session = this.require(id)
    const stage = this.currentStage(session)
    if (stage.runId) {
      const run = this.benchmarks.get(stage.runId)
      if (run) this.benchmarks.invalidateForDeletion(run.id)
    }
    const deleted = this.store.deleteBenchmarkSession(id)
    this.events.emit(id, null)
    this.events.emit('changed', id)
    return deleted
  }

  notebook(id: string, role: BenchmarkNotebookRole) {
    this.require(id)
    return (
      this.store.getBenchmarkSessionNotebookSnapshot(id, role)?.content ?? ''
    )
  }

  notebookVersions(id: string, stageKey: BenchmarkStageKey) {
    this.require(id)
    return this.store.listBenchmarkSessionNotebookVersions(id, stageKey)
  }

  publishNotebook(
    id: string,
    role: BenchmarkNotebookRole,
    input: {mode: 'replace_source'} | {mode: 'save_new'; name: string},
  ) {
    const session = this.require(id)
    const requiredStage = role === 'life_death' ? 'hard' : 'ordinary'
    const stage = session.stages.find(
      ({stageKey}) => stageKey === requiredStage,
    )!
    if (stage.status !== 'completed' || !stage.runId)
      throw new Error(
        `The ${requiredStage} stage must complete before publishing`,
      )
    const run = this.benchmarks.get(stage.runId)
    if (!run) throw new Error('Benchmark child run not found')
    const content = this.notebook(id, role)
    if (!content) throw new Error('The benchmark notebook is missing')
    return this.store.publishBenchmarkNotebook(run, content, input)
  }

  close() {
    this.benchmarks.events.off('changed', this.handleBenchmarkChanged)
  }

  private readonly handleBenchmarkChanged = (runId: string) => {
    const stage = this.store.findBenchmarkSessionStageByRun(runId)
    if (!stage) return
    const run = this.benchmarks.get(runId)
    const session = this.get(stage.sessionId)
    if (!run || !session) return
    const now = new Date().toISOString()
    const role = stage.writableNotebookRole
    stage.updatedAt = now
    if (['queued', 'running', 'paused'].includes(run.status)) {
      stage.status = 'running'
      if (session.status !== 'restarting_stage') session.status = 'running'
    } else if (run.status === 'completed') {
      stage.status = 'completed'
      stage.metrics = run.metrics
      stage.completedAt = now
      if (stage.stageKey === 'ordinary') {
        session.status = 'completed'
        session.completedAt = now
      } else session.status = 'awaiting_continue'
    } else if (run.status === 'cancelled') {
      stage.status = 'cancelled'
      stage.completedAt = now
      session.status = 'cancelled'
    } else if (run.status === 'invalid') {
      stage.status = 'failed'
      stage.completedAt = now
      session.status = 'error'
      session.error = run.error ?? 'The current stage failed'
    }
    session.updatedAt = now
    const content =
      this.store.getNotebookSnapshot(run.id)?.content ??
      this.store.getBenchmarkNotebookSeed(run.id)?.content ??
      ''
    this.store.transaction(() => {
      this.store.saveBenchmarkSessionStage(stage)
      this.store.saveBenchmarkSessionNotebookSnapshot({
        sessionId: session.id,
        role,
        notebookId: run.notebook.notebookId!,
        notebookName: run.notebook.name ?? 'Benchmark notebook',
        content,
        version: run.notebookVersion,
        estimatedTokens: run.notebookEstimatedTokens,
        stageKey: stage.stageKey,
        updatedAt: run.notebook.updatedAt ?? now,
      })
      this.store.syncBenchmarkSessionNotebookVersions(session.id, role, stage)
      this.store.saveBenchmarkSession(session)
    })
    this.emit(session.id)
  }

  private prepareChild(
    config: BenchmarkSessionConfig,
    sessionId: string,
    stageKey: BenchmarkStageKey,
    source: TechniqueNotebook,
    readOnlyNotebooks?: BenchmarkRun['readOnlyNotebooks'],
  ) {
    return this.benchmarks.prepareSessionChild(
      childConfig(config, stageKey, source.id),
      source,
      {
        sessionId,
        stageKey,
        writableNotebookRole: roleForStage(stageKey),
        readOnlyNotebooks,
      },
    )
  }

  private snapshotNotebook(
    session: BenchmarkSession,
    role: BenchmarkNotebookRole,
  ): TechniqueNotebook {
    const snapshot = this.store.getBenchmarkSessionNotebookSnapshot(
      session.id,
      role,
    )
    if (!snapshot) throw new Error('Benchmark session notebook is missing')
    return {
      id: snapshot.notebookId,
      profileId: session.profileId,
      name: snapshot.notebookName,
      content: snapshot.content,
      createdAt: session.createdAt,
      updatedAt: snapshot.updatedAt,
    }
  }

  private readOnlyNotebook(
    session: BenchmarkSession,
    role: BenchmarkNotebookRole,
  ) {
    const notebook = this.snapshotNotebook(session, role)
    return {
      role,
      notebookId: notebook.id,
      name: notebook.name,
      content: notebook.content,
    }
  }

  private saveInitialNotebook(
    sessionId: string,
    role: BenchmarkNotebookRole,
    notebook: TechniqueNotebook,
    now: string,
  ) {
    this.store.saveBenchmarkSessionNotebookSnapshot({
      sessionId,
      role,
      notebookId: notebook.id,
      notebookName: notebook.name,
      content: notebook.content,
      version: 0,
      estimatedTokens: Math.ceil(
        Buffer.byteLength(notebook.content, 'utf8') / 4,
      ),
      updatedAt: now,
    })
  }

  private newStage(
    sessionId: string,
    stageKey: BenchmarkStageKey,
    now: string,
  ): BenchmarkSessionStage {
    return {
      id: randomUUID(),
      sessionId,
      stageKey,
      attempt: 0,
      status: 'pending',
      writableNotebookRole: roleForStage(stageKey),
      createdAt: now,
      updatedAt: now,
    }
  }

  private assertProfileAvailable(profileId: string) {
    if (
      this.benchmarks
        .list()
        .some(
          (run) =>
            run.config.profileId === profileId &&
            ['queued', 'running', 'paused'].includes(run.status),
        ) ||
      this.list().some(
        (session) =>
          session.profileId === profileId &&
          !['completed', 'cancelled'].includes(session.status),
      )
    )
      throw new BenchmarkConflictError()
  }

  private requireNotebook(profileId: string, notebookId: string) {
    const notebook = this.benchmarks.notebooks.get(profileId, notebookId)
    if (!notebook)
      throw new Error('Technique notebook not found for this player profile')
    return notebook
  }

  private require(id: string) {
    const session = this.get(id)
    if (!session) throw new Error('Benchmark session not found')
    return session
  }

  private currentStage(session: BenchmarkSession) {
    return session.stages.find(
      ({stageKey}) => stageKey === session.currentStage,
    )!
  }

  private childCommand(id: string, command: (runId: string) => BenchmarkRun) {
    const session = this.require(id)
    const stage = this.currentStage(session)
    if (!stage.runId) throw new Error('The current stage has not started')
    command(stage.runId)
    return this.get(id)!
  }

  private emit(id: string) {
    const session = this.get(id)
    this.events.emit(id, session)
    this.events.emit('changed', id)
  }
}

function childConfig(
  config: BenchmarkSessionConfig,
  stageKey: BenchmarkStageKey,
  notebookId: string,
): BenchmarkConfig {
  if (stageKey === 'life_death_notebook') {
    return {
      profileId: config.profileId,
      finalColor: config.finalColor,
      trainingGameCount: 1,
      trainingGamesWithWinRates: 0,
      trainingGamesWithoutWinRates: 1,
      notebookSeed: {mode: 'refine_existing', notebookId},
      trainingFeedback: 'none',
      notebookTokenBudget: config.notebookTokenBudget,
      trainingVisits: config.trainingVisits,
      evaluationVisits: config.evaluationVisits,
    }
  }
  if (stageKey === 'ordinary_notebook') {
    return {
      profileId: config.profileId,
      finalColor: config.finalColor,
      trainingGameCount: 1,
      trainingGamesWithWinRates: 0,
      trainingGamesWithoutWinRates: 1,
      notebookSeed: {mode: 'refine_existing', notebookId},
      trainingFeedback: 'none',
      notebookTokenBudget: config.notebookTokenBudget,
      trainingVisits: config.trainingVisits,
      evaluationVisits: config.evaluationVisits,
    }
  }
  if (stageKey === 'easy' || stageKey === 'medium' || stageKey === 'hard') {
    const set = loadProblemSet(problemSets[stageKey])
    return {
      profileId: config.profileId,
      finalColor: config.finalColor,
      trainingGameCount: 1,
      notebookSeed: {mode: 'refine_existing', notebookId},
      trainingFeedback: 'structured',
      notebookTokenBudget: config.notebookTokenBudget,
      trainingVisits: config.trainingVisits,
      evaluationVisits: config.evaluationVisits,
      problemSetId: set.id,
      problemSetChecksum: set.checksum,
    }
  }
  return {
    profileId: config.profileId,
    finalColor: config.finalColor,
    trainingGameCount: config.trainingGameCount,
    trainingGamesWithWinRates: config.trainingGamesWithWinRates,
    trainingGamesWithoutWinRates: config.trainingGamesWithoutWinRates,
    notebookSeed: {mode: 'refine_existing', notebookId},
    trainingFeedback: config.trainingFeedback,
    notebookTokenBudget: config.notebookTokenBudget,
    trainingVisits: config.trainingVisits,
    evaluationVisits: config.evaluationVisits,
  }
}

function roleForStage(stageKey: BenchmarkStageKey): BenchmarkNotebookRole {
  return stageKey === 'ordinary' || stageKey === 'ordinary_notebook'
    ? 'ordinary'
    : 'life_death'
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}
