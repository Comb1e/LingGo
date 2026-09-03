import {createHash, randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {NoOutputGeneratedError} from 'ai'
import {z} from 'zod'
import type {
  BenchmarkConfig,
  BenchmarkConfigInput,
  BenchmarkMoveReview,
  BenchmarkMetrics,
  BenchmarkNotebookVersion,
  BenchmarkPhase,
  BenchmarkRun,
  Color,
  Game,
  LlmActionResult,
  PlayerAction,
  PositionAnalysis,
  ProviderConnection,
  TechniqueNotebook,
  BenchmarkProblemAttempt,
  BenchmarkStageKey,
  BenchmarkNotebookRole,
  LlmMessageSet,
  GameSnapshot,
} from '../shared/types'
import {coordinateToPoint} from '../shared/coordinates'
import {
  DEFAULT_NOTEBOOK_INITIALIZATION_TOKEN_LIMIT,
  DEFAULT_NOTEBOOK_TOKEN_BUDGET,
} from '../shared/constants'
import {Store} from './database'
import {
  asciiBoard,
  boardHash,
  IllegalMoveError,
  makeSnapshot,
  replay,
  scoreBoard,
} from './go'
import {
  GameService,
  MAX_MODEL_OUTPUT_ATTEMPTS,
  MAX_MODEL_OUTPUT_RETRIES,
} from './games'
import {
  gamePosition,
  rootFromBlack,
  selectedMove,
  type KataGoAnalyzer,
} from './katago'
import {NotebookStore} from './notebooks'
import {formatCanonicalGoRules} from './movePrompt'
import type {VisibleLlmMessage} from './llmGameContext'
import {perspectiveOutcome} from './llmGameContext'
import {
  listProblemSets,
  loadProblemSet,
  problemView,
  scoreProblemSequence,
  type BenchmarkProblem,
} from './benchmarkProblems'
import {
  publicProviderError,
  shouldRetryProviderError,
  type ProviderRetryWait,
  waitForProviderRetry,
} from './network'
import {
  createPlayerAdapter,
  type LlmTurnResponse,
  MalformedModelOutputError,
  parseJsonActionResult,
  requestLlm,
} from './providers'
import {MAX_PROVIDER_API_ATTEMPTS, runtimeConfig} from './config'
import {transitionBenchmark} from './stateMachines/benchmark'
import {transitionAnalysis} from './stateMachines/analysis'
import {
  transitionLifeDeathProblem,
  type LifeDeathProblemWorkflowState,
} from './stateMachines/lifeDeathProblem'

type InternalRun = BenchmarkRun & {
  pointLosses?: number[]
  winRateLosses?: number[]
  outputAttempts?: number
  outputRepairs?: number
  initializationContext?: {
    transcript: VisibleLlmMessage[]
  }
  pendingProblem?: {
    problemId: string
    cursor: number
    actualAction?: PlayerAction
    legal: boolean
    correct: boolean
    failureReason?: string
    promptDigest: string
    responseDigest?: string
    notebookVersionBefore: number
    actions?: PlayerAction[]
    step?: number
  }
  problemProgress?: {
    problemId: string
    cursor: number
    actions: PlayerAction[]
    step: number
    workflow?: LifeDeathProblemWorkflowState
    lastFailureAction?: PlayerAction
    lastFailureReason?: string
  }
}

type LegacyBenchmarkConfig = {
  profileId: string
  finalColor: Color
  visits: number
  includeTrainingWinRates: boolean
  trainingGameCount: number
  notebookId: string
}

class KataGoUnavailableError extends Error {}

const LIFE_DEATH_NOTEBOOK_INSTRUCTION =
  "Do not write the direct answer to an individual life-and-death problem in this notebook. Record only generalizable techniques and reasoning patterns; do not include the problem's answer coordinate or a step-by-step solution sequence."

const LIFE_DEATH_BOARD_SYMBOL_LEGEND =
  'Board symbols: X = Black stone, O = White stone, . = empty intersection.'

const LIFE_DEATH_NOTEBOOK_INITIALIZATION_INSTRUCTION = [
  'Create a comprehensive, self-contained Markdown technique notebook for solving Go life-and-death problems.',
  'Later problem prompts will provide only the board, the side to move, capture totals, and the notebook. They will not repeat the Go or life-and-death rules. Record all reusable knowledge needed to choose and verify each action without relying on outside context.',
  'A life-and-death problem is a local tactical position about whether an unsettled group can survive or be captured under best play.',
  '',
  'Cover at least the following subjects:',
  '- Core mechanics: orthogonal adjacency, chains, liberties, capture order, suicide, ko or whole-board repetition, and how captures can create new liberties or eye space.',
  '- Objectives and settled outcomes: attack versus defense, unconditional life through two independent real eyes, capture, escape or connection to a living group, seki, ko life, and unsettled positions.',
  '- Eye-space analysis: real and false eyes, shared liberties, cutting points, internal defects, vital points, eye-stealing moves, and common nakade principles and shapes.',
  "- A disciplined reading process: identify the critical group and each side's goal; count liberties and eye potential; generate forcing moves, vital points, and candidate defenses; answer every candidate with the opponent's strongest resistance; compare move orders; and read until the result is stable.",
  '- Tactical and shape techniques: atari and double atari, throw-ins, sacrifices, snapback, shortage of liberties, approach moves, connection and cutting tesuji, under-the-stones ideas, capturing races, and damezumari.',
  '- Local geometry: how corner and edge boundaries change liberties, eyes, placement points, and standard first-line or second-line techniques.',
  '- Verification and failure checks: legality, self-atari, hidden liberties, false-eye defects, ko recaptures, opponent counter-atari, whether two eyes are truly independent, and whether a proposed sequence assumes a cooperative reply.',
  '- Practical move selection: prefer forcing and dual-purpose moves, distinguish sente from gote, preserve flexibility, and use accurate local reading rather than vague shape memory.',
  '',
  'Make every note operational: state what cues to inspect, what candidate move or sequence to consider, how the opponent can resist, and how to confirm the resulting status. Distinguish unconditional results from ko, seki, or unresolved outcomes instead of treating them as equivalent.',
  'Organize the reusable knowledge as individually numbered points such as 1. ... and 2. ... so later lessons can replace or add a point by number. Headings may group the numbered points, but each numbered point must stand on its own as a reusable lesson.',
  LIFE_DEATH_NOTEBOOK_INSTRUCTION,
  'Do not record individual problem coordinates, positions, or solution sequences.',
  'Do not claim that one heuristic, shape, or first move is universally correct; include exceptions or verification conditions where they matter.',
  'Choose the headings and writing style yourself, eliminate redundant advice, and use the available notebook budget for concrete, technically precise guidance.',
].join('\n')

const lifeDeathNotebookPatchSchema = z
  .record(
    z.string().regex(/^[1-9]\d*$/),
    z.union([z.string().trim().min(1), z.null()]),
  )
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one numbered note edit is required',
  })

const LIFE_DEATH_NOTEBOOK_PATCH_OUTPUT_INSTRUCTION = [
  'NOTEBOOK PATCH OUTPUT FORMAT',
  'Return one JSON object and no other text.',
  'Format: {"<note number>":"<complete replacement note text>"} or {"<note number>":null}.',
  'Use an existing note number with text to improve that point. Use a new positive integer with text to add a point. Use null with an existing note number to delete that point.',
  'Write the complete new text for each changed note, without its leading number and period.',
  'Example - replace note 2: {"2":"Read the strongest forcing reply before choosing the vital point."}',
  'Example - replace note 2 and add note 5: {"2":"Read every forcing reply.","5":"Check for hidden outside liberties before starting a capturing race."}',
  'Example - delete misleading note 4: {"4":null}',
  'Change multiple notes only when the attempt provides separate useful lessons.',
  'Improve the relevant weak note; do not choose note 1 by default.',
  'Add a note only when no existing note covers the lesson.',
  'Do not include unchanged notes, the complete notebook, Markdown outside the note text, or any explanation outside the JSON object.',
].join('\n')

export class BenchmarkConflictError extends Error {
  constructor() {
    super(
      'This player profile already has a queued, running, or paused benchmark',
    )
    this.name = 'BenchmarkConflictError'
  }
}

export class BenchmarkService {
  readonly events = new EventEmitter()
  private scheduled = new Set<string>()
  private reschedule = new Set<string>()
  private controllers = new Map<string, AbortController>()
  private activeRuns = new Map<string, InternalRun>()
  private reservedProfiles = new Set<string>()
  private generations = new Map<string, number>()
  private deletedRuns = new Set<string>()

  constructor(
    readonly store: Store,
    readonly games: GameService,
    readonly engine: KataGoAnalyzer,
    readonly notebooks = new NotebookStore(store),
    private readonly adapterFactory: typeof createPlayerAdapter = createPlayerAdapter,
    private readonly retryWait: ProviderRetryWait = waitForProviderRetry,
  ) {
    for (const run of this.store.listBenchmarks())
      if (run.status === 'queued' || run.status === 'running')
        this.schedule(run.id)
  }

  list() {
    return this.store.listBenchmarks()
  }

  get(id: string) {
    return this.store.getBenchmark(id)
  }

  listProblemSets() {
    return listProblemSets()
  }

  problemAttempts(id: string) {
    return this.store.listBenchmarkProblemAttempts(id)
  }

  llmMessageSets(id: string): LlmMessageSet[] {
    const run = this.require(id)
    const connection = this.connection(run)
    return [
      {
        color: run.config.finalColor,
        status: run.status === 'completed' ? 'complete' : 'active',
        providerKind: connection.kind,
        continuationMode: 'transcript',
        messages: run.llmMessages ?? [],
      },
    ]
  }

  currentProblem(id: string) {
    const run = this.require(id)
    if (!run.config.problemSetId) return undefined
    if (run.metrics?.kataGoGateReached) return undefined
    const set = loadProblemSet(run.config.problemSetId)
    const cursor = run.problemCursor ?? 0
    return problemView(set.problems[cursor % set.problems.length])
  }

  async create(input: BenchmarkConfigInput | LegacyBenchmarkConfig) {
    const config = normalizeConfig(input)
    const problemSet = config.problemSetId
      ? loadProblemSet(config.problemSetId)
      : undefined
    if (problemSet && config.problemSetChecksum !== problemSet.checksum)
      throw new Error('Problem set checksum does not match the shipped corpus')
    if (
      this.reservedProfiles.has(config.profileId) ||
      this.list().some(
        (run) =>
          run.config.profileId === config.profileId &&
          ['queued', 'running', 'paused'].includes(run.status),
      ) ||
      this.store
        .listBenchmarkSessions()
        .some(
          (session) =>
            session.profileId === config.profileId &&
            !['completed', 'cancelled'].includes(session.status),
        )
    )
      throw new BenchmarkConflictError()
    this.reservedProfiles.add(config.profileId)
    try {
      const profile = this.store.getProfile(config.profileId)
      if (!profile) throw new Error('Player profile not found')
      const connection = this.store.getConnection(profile.connectionId)
      if (!connection) throw new Error('Provider connection not found')
      const sourceNotebook = await this.sourceNotebook(config)
      const run = this.makeRun(config, sourceNotebook)
      try {
        run.updatedAt = new Date().toISOString()
        this.store.saveBenchmarkWithSeed(run, sourceNotebook)
        this.emit(run)
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new BenchmarkConflictError()
        throw error
      }
      this.schedule(run.id)
      return run
    } finally {
      this.reservedProfiles.delete(config.profileId)
    }
  }

  prepareSessionChild(
    input: BenchmarkConfig,
    sourceNotebook: TechniqueNotebook,
    metadata: {
      sessionId: string
      stageKey: BenchmarkStageKey
      writableNotebookRole: BenchmarkNotebookRole
      readOnlyNotebooks?: InternalRun['readOnlyNotebooks']
    },
  ) {
    const config = normalizeConfig(input)
    const problemSet = config.problemSetId
      ? loadProblemSet(config.problemSetId)
      : undefined
    if (problemSet && config.problemSetChecksum !== problemSet.checksum)
      throw new Error('Problem set checksum does not match the shipped corpus')
    const profile = this.store.getProfile(config.profileId)
    if (!profile) throw new Error('Player profile not found')
    if (!this.store.getConnection(profile.connectionId))
      throw new Error('Provider connection not found')
    return this.makeRun(config, sourceNotebook, metadata)
  }

  activatePreparedSessionChild(run: BenchmarkRun) {
    this.emit(run as InternalRun)
    this.schedule(run.id)
  }

  private makeRun(
    config: BenchmarkConfig,
    sourceNotebook?: TechniqueNotebook,
    metadata?: {
      sessionId: string
      stageKey: BenchmarkStageKey
      writableNotebookRole: BenchmarkNotebookRole
      readOnlyNotebooks?: InternalRun['readOnlyNotebooks']
    },
  ): InternalRun {
    const problemSet = config.problemSetId
      ? loadProblemSet(config.problemSetId)
      : undefined
    const profile = this.store.getProfile(config.profileId)!
    const connection = this.store.getConnection(profile.connectionId)!
    const now = new Date().toISOString()
    const id = randomUUID()
    return {
      id,
      protocolVersion: metadata ? 4 : problemSet ? 3 : 2,
      status: 'queued',
      phase:
        problemSet &&
        metadata?.stageKey &&
        !isNotebookInitializationStage(metadata.stageKey)
          ? 'solving_problem'
          : 'initializing_notebook',
      substate: {kind: 'ready'},
      config,
      profileSnapshot: {...profile},
      modelFingerprint: createHash('sha256')
        .update(JSON.stringify({profile, connection}))
        .digest('hex'),
      kataGoFingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            executablePath: this.store.getKataGoSettings().executablePath,
            modelPath: this.store.getKataGoSettings().modelPath,
            configPath: this.store.getKataGoSettings().configPath,
          }),
        )
        .digest('hex'),
      currentGame: 0,
      currentTurn: 0,
      gameIds: [],
      llmMessages: [],
      usage: {
        calls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        byPhase: {},
      },
      notebook: {
        profileId: profile.id,
        notebookId: sourceNotebook?.id,
        name: sourceNotebook?.name ?? 'Benchmark notebook',
        currentUrl: sourceNotebook
          ? `/api/profiles/${profile.id}/notebooks/${sourceNotebook.id}.md`
          : undefined,
        snapshotUrl: `/api/benchmarks/${id}/notebook.md`,
      },
      notebookVersion: 0,
      notebookEstimatedTokens: metadata
        ? Math.ceil(
            Buffer.byteLength(sourceNotebook?.content ?? '', 'utf8') / 4,
          )
        : 0,
      problemCursor: 0,
      problemSuccessStreak: 0,
      problemSetChecksum: problemSet?.checksum,
      metrics: problemSet
        ? {
            ...calculateMetrics('Void', config.finalColor, [], []),
            problemCount: problemSet.problems.length,
            problemAttempts: 0,
            firstResponseSuccessRate: 0,
            problemFailures: 0,
            completedCleanCycles: 0,
            kataGoGateReached: false,
          }
        : undefined,
      pointLosses: [],
      winRateLosses: [],
      ...metadata,
      createdAt: now,
      updatedAt: now,
    }
  }

  pause(id: string) {
    const run = this.require(id)
    if (!['queued', 'running'].includes(run.status))
      throw new Error('Benchmark is not running')
    this.controllers.get(run.id)?.abort()
    transitionBenchmark(run, {
      type: 'pause',
      substate: {
        kind: 'paused',
        previous:
          run.substate.kind === 'paused' ? run.substate.previous : run.substate,
      },
    })
    run.waitingFor = undefined
    run.pauseAfterLlmMove = false
    this.save(run)
    return run
  }

  resume(id: string) {
    const run = this.require(id)
    if (run.status !== 'paused' && run.status !== 'running')
      throw new Error('Benchmark cannot be resumed')
    transitionBenchmark(run, {
      type: 'resume',
      substate:
        run.substate.kind === 'paused'
          ? run.substate.previous
          : {kind: 'ready'},
    })
    run.error = undefined
    run.waitingFor = undefined
    run.pauseAfterLlmMove = false
    const game = this.currentGame(run)
    this.store.transaction(() => {
      if (game?.error) this.games.clearAutomatedError(game.id)
      this.save(run)
    })
    this.schedule(id)
    return run
  }

  resumeWaiting() {
    for (const run of this.list())
      if (run.status === 'running' && run.waitingFor) this.schedule(run.id)
  }

  nextMoveAndPause(id: string) {
    const saved = this.require(id)
    if (!['queued', 'running', 'paused'].includes(saved.status))
      throw new Error('Benchmark cannot play another move')
    const run =
      saved.status === 'running' ? (this.activeRuns.get(id) ?? saved) : saved
    transitionBenchmark(run, {
      type: 'resume',
      substate:
        run.substate.kind === 'paused' ? run.substate.previous : run.substate,
    })
    run.error = undefined
    run.waitingFor = undefined
    run.pauseAfterLlmMove = true
    const game = this.currentGame(run)
    this.store.transaction(() => {
      if (game?.error) this.games.clearAutomatedError(game.id)
      this.save(run)
    })
    if (run !== this.activeRuns.get(id)) this.schedule(id)
    return run
  }

  cancel(id: string) {
    const run = this.require(id)
    return this.cancelRun(run, true)
  }

  cancelSessionChild(id: string) {
    return this.cancelRun(this.require(id), false)
  }

  notifySessionChild(run: BenchmarkRun) {
    this.emit(run as InternalRun)
  }

  private cancelRun(run: InternalRun, emit: boolean) {
    if (!['queued', 'running', 'paused'].includes(run.status))
      throw new Error('Benchmark has already ended')
    this.controllers.get(run.id)?.abort()
    transitionBenchmark(run, {type: 'cancel'})
    run.waitingFor = undefined
    run.pauseAfterLlmMove = false
    run.updatedAt = new Date().toISOString()
    this.store.saveBenchmark(run)
    if (emit) this.emit(run)
    return run
  }

  async force(id: string, action: PlayerAction) {
    const run = this.require(id)
    if (run.status !== 'paused')
      throw new Error('Pause the benchmark before forcing a move')
    const game = this.currentGame(run)
    if (!game) throw new Error('Benchmark game not found')
    if (game.error) this.games.clearAutomatedError(game.id)
    this.games.acceptAutomated(game.id, action, undefined, true)
    if (run.currentGame === configuredTrainingGameCount(run.config)) {
      transitionBenchmark(run, {type: 'invalidate'})
      run.error = 'A forced final-game move invalidated this benchmark.'
      run.metrics = undefined
      this.games.finishAutomated(game.id, 'Invalid')
      this.save(run)
      return run
    }
    transitionBenchmark(run, {type: 'resume', substate: {kind: 'ready'}})
    run.error = undefined
    this.save(run)
    this.schedule(id)
    return run
  }

  async delete(id: string) {
    const run = this.require(id)
    if (run.sessionId)
      throw new Error('Delete the benchmark session instead of a child run')
    this.deletedRuns.add(id)
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.controllers.get(id)?.abort()
    await this.waitForRunTermination(id)
    const deleted = this.store.deleteBenchmark(id)
    await this.notebooks.deleteSnapshot(id)
    this.events.emit(id, null)
    this.events.emit('changed', id)
    return deleted
  }

  publishNotebook(
    id: string,
    input: {mode: 'replace_source'} | {mode: 'save_new'; name: string},
  ) {
    const run = this.require(id)
    if (run.sessionId)
      throw new Error(
        'Publish session notebooks with an explicit notebook role',
      )
    if (run.status !== 'completed')
      throw new Error('The benchmark must be complete before publishing')
    const content = this.store.getNotebookSnapshot(id)?.content
    if (!content) throw new Error('The benchmark notebook is missing')
    return this.store.publishBenchmarkNotebook(run, content, input)
  }

  async close() {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  async waitForRunTermination(id: string) {
    while (this.activeRuns.has(id))
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }

  invalidateForDeletion(id: string) {
    this.deletedRuns.add(id)
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.controllers.get(id)?.abort()
  }

  private schedule(id: string, delay = 0) {
    if (this.deletedRuns.has(id)) return
    if (this.scheduled.has(id)) {
      this.reschedule.add(id)
      return
    }
    this.scheduled.add(id)
    const start = () => void this.run(id)
    if (delay) setTimeout(start, delay).unref()
    else queueMicrotask(start)
  }

  private async run(id: string) {
    if (this.deletedRuns.has(id)) return
    const generation = this.generations.get(id) ?? 0
    const controller = new AbortController()
    this.controllers.set(id, controller)
    let retry = false
    try {
      const run = this.require(id)
      if (
        this.deletedRuns.has(id) ||
        (this.generations.get(id) ?? 0) !== generation
      )
        return
      if (!['queued', 'running'].includes(run.status)) return
      this.activeRuns.set(id, run)
      transitionBenchmark(run, {
        type: 'resume',
        substate: {kind: 'ready'},
      })
      run.waitingFor = undefined
      run.error = undefined
      this.save(run)
      if (run.phase === 'initializing_notebook') {
        const initialized = await this.initializeNotebook(
          run,
          controller.signal,
        )
        if (!initialized) {
          retry = Boolean(run.waitingFor)
          return
        }
        // Session notebook stages intentionally end after initialization. The
        // following problem/game stage receives this run's notebook snapshot.
        if (run.sessionId && isNotebookInitializationStage(run.stageKey)) {
          transitionBenchmark(run, {type: 'complete'})
          this.finishMetrics(run, 0)
          this.save(run)
          return
        }
      }
      if (isLifeDeath(run)) {
        const gated = await this.runProblemGate(run, controller.signal)
        if (!gated) {
          retry = Boolean(run.waitingFor)
          return
        }
        if (run.sessionId && run.stageKey !== 'ordinary') {
          transitionBenchmark(run, {type: 'complete'})
          this.finishMetrics(run, 0)
          this.save(run)
          return
        }
        transitionBenchmark(run, {
          type: 'update',
          phase: 'final_game',
          substate: {kind: 'ready'},
        })
        this.save(run)
      }
      const trainingGameCount = isLifeDeath(run)
        ? 0
        : configuredTrainingGameCount(run.config)
      while (run.currentGame <= trainingGameCount && run.status === 'running') {
        transitionBenchmark(run, {
          type: 'update',
          phase:
            run.currentGame < trainingGameCount
              ? 'training_game'
              : 'final_game',
          substate: {kind: 'ready'},
        })
        this.save(run)
        const llmColor =
          run.currentGame < trainingGameCount
            ? run.currentGame % 2 === 0
              ? 'B'
              : 'W'
            : run.config.finalColor
        const game = this.ensureGame(run, llmColor)
        if (run.currentGame === 0 && run.initializationContext) {
          this.games.seedLlmContext({
            gameId: game.id,
            color: llmColor,
            profile: run.profileSnapshot,
            connection: this.connection(run),
            transcript: run.initializationContext.transcript,
          })
          run.initializationContext = undefined
          this.save(run)
        }
        const completed = await this.playGame(
          run,
          game,
          llmColor,
          controller.signal,
        )
        if (!completed) {
          retry = Boolean(run.waitingFor)
          return
        }
        if (run.currentGame < trainingGameCount) {
          transitionBenchmark(run, {
            type: 'update',
            phase: 'reviewing_game',
          })
          this.save(run)
          const reflected = await this.reviewGame(run, controller.signal)
          if (!reflected) {
            retry = Boolean(run.waitingFor)
            return
          }
        } else {
          this.games.completeLlmContexts(game.id)
          run.currentGame += 1
          run.currentTurn = 0
          this.save(run)
        }
      }
      if (run.status === 'running') {
        transitionBenchmark(run, {type: 'complete'})
        run.metrics = {
          ...(run.metrics ?? {}),
          ...calculateMetrics(
            this.games.get(run.gameIds[trainingGameCount])?.result ?? 'Void',
            run.config.finalColor,
            run.pointLosses ?? [],
            run.winRateLosses ?? [],
          ),
        }
        const initial = this.store.listBenchmarkNotebookVersions(run.id)[0]
        const current = this.store.listBenchmarkNotebookVersions(run.id).at(-1)
        run.metrics.outputRepairRate = run.outputAttempts
          ? (run.outputRepairs ?? 0) / run.outputAttempts
          : 0
        run.metrics.trainingReviewCount = this.store
          .listBenchmarkNotebookVersions(run.id)
          .filter(({sourcePhase}) => sourcePhase === 'reviewing_game').length
        run.metrics.notebookGrowthCharacters =
          (current?.characterCount ?? 0) - (initial?.characterCount ?? 0)
        this.save(run)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const run = this.get(id) as InternalRun | undefined
        if (run && run.status === 'running') {
          run.error = publicError(error)
          if (error instanceof KataGoUnavailableError) {
            run.waitingFor = 'katago'
            transitionBenchmark(run, {
              type: 'update',
              substate: {kind: 'waiting_katago'},
            })
            retry = true
            this.save(run)
          } else {
            transitionBenchmark(run, {
              type: 'pause',
              substate: {
                kind: 'paused',
                previous:
                  run.substate.kind === 'paused'
                    ? run.substate.previous
                    : run.substate,
              },
            })
            run.pauseAfterLlmMove = false
            const game = this.currentGame(run)
            this.store.transaction(() => {
              if (game) this.games.reportAutomatedError(game.id, run.error!)
              this.save(run)
            })
          }
        }
      }
    } finally {
      this.controllers.delete(id)
      this.activeRuns.delete(id)
      this.scheduled.delete(id)
      if (
        !this.deletedRuns.has(id) &&
        this.generations.get(id) === generation
      ) {
        if (this.reschedule.delete(id)) this.schedule(id)
        else if (retry) this.schedule(id, 3_000)
      } else {
        this.reschedule.delete(id)
      }
    }
  }

  private ensureGame(run: InternalRun, llmColor: Color) {
    const id = run.gameIds[run.currentGame]
    if (id) {
      const game = this.games.get(id)
      if (!game) throw new Error('A linked benchmark game is missing')
      return game
    }
    const game = this.games.createBenchmarkGame({
      runId: run.id,
      gameIndex: run.currentGame,
      llmColor,
      profileId: run.profileSnapshot.id,
      profileName: run.profileSnapshot.name,
    })
    run.gameIds[run.currentGame] = game.id
    this.store.transaction(() => {
      this.store.linkBenchmarkGame(run.id, game.id, run.currentGame)
      this.save(run)
    })
    return game
  }

  private async playGame(
    run: InternalRun,
    original: Game,
    llmColor: Color,
    signal: AbortSignal,
  ) {
    let game = this.games.get(original.id)!
    let illegalMoveFailures = 0
    while (run.status === 'running' && game.status !== 'finished') {
      let llmMoved = false
      signal.throwIfAborted()
      const phase =
        run.currentGame < configuredTrainingGameCount(run.config)
          ? 'training_game'
          : 'final_game'
      const visits =
        phase === 'training_game'
          ? run.config.trainingVisits
          : run.config.evaluationVisits
      const positionBefore = makeSnapshot(game.size, game.komi, game.moves)
      const beforeResult = await this.analyze(game, visits, signal)
      const before = rootFromBlack(beforeResult)
      if (game.toMove === llmColor) {
        const adapter = this.adapter(run)
        if (!adapter) {
          run.waitingFor = 'credentials'
          transitionBenchmark(run, {
            type: 'update',
            substate: {kind: 'waiting_credentials'},
          })
          this.save(run)
          return false
        }
        const connection = this.connection(run)
        const notebook = await this.runNotebook(run.id)
        let outputFailures = 0
        let apiFailures = 0
        let rebasedProviderContext = false
        const retryErrors = [...(game.providerErrors ?? [])]
        const promptPhase = phase === 'training_game' ? 'training' : 'final'
        const trainingFeedback =
          phase === 'training_game' &&
          trainingGameHasWinRates(run.config, run.currentGame)
            ? ('structured' as const)
            : ('none' as const)
        const latestWinRate =
          trainingFeedback === 'structured'
            ? this.latestMoveReview(run.id, run.currentGame)
            : undefined
        let prepared = this.prepareBenchmarkLlmTurn({
          run,
          game,
          llmColor,
          connection,
          promptPhase,
          notebook,
          trainingFeedback,
          latestWinRate,
        })
        const llmTurnCount = game.moves.filter(
          (move) => move.color === llmColor,
        ).length
        if (
          llmTurnCount > 0 &&
          llmTurnCount % 10 === 0 &&
          prepared.context.lastIntentionTurn !== llmTurnCount
        ) {
          let gameIntention: string | undefined
          try {
            gameIntention = await this.games.summarizeLlmContext(
              adapter,
              prepared,
              signal,
            )
          } catch (summaryError) {
            if (signal.aborted) throw summaryError
          }
          this.games.rebaseLlmContext(
            game.id,
            llmColor,
            gameIntention,
            llmTurnCount,
          )
          prepared = this.prepareBenchmarkLlmTurn({
            run,
            game,
            llmColor,
            connection,
            promptPhase,
            notebook,
            trainingFeedback,
            latestWinRate,
          })
        }
        transitionBenchmark(run, {
          type: 'update',
          substate: {
            kind: 'provider_request',
            operation: 'move',
            attempt: 1,
            maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
          },
        })
        this.save(run)
        this.games.setAutomatedTurnState(game.id, {
          phase: 'requesting',
          attempt: 1,
          maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
        })
        try {
          while (outputFailures <= MAX_MODEL_OUTPUT_RETRIES) {
            let responseContent = ''
            let turnResponse: LlmTurnResponse | undefined
            try {
              turnResponse = await this.games.requestPreparedLlmTurn(
                adapter,
                prepared,
                signal,
              )
              responseContent = turnResponse.text
              const parsed = parseJsonActionResult(turnResponse.text, game.size)
              const response: LlmActionResult = {
                action: parsed.action,
                responseContent: turnResponse.text,
                reasoning: turnResponse.reasoning,
                latencyMs: turnResponse.latencyMs,
                inputTokens: turnResponse.inputTokens,
                cachedInputTokens: turnResponse.cachedInputTokens,
                outputTokens: turnResponse.outputTokens,
                model: turnResponse.model,
                providerKind: turnResponse.providerKind,
                retries: 0,
              }
              addUsage(run, response)
              run.outputAttempts = (run.outputAttempts ?? 0) + 1
              response.retries = outputFailures + apiFailures
              response.retryErrors = retryErrors.length
                ? retryErrors
                : undefined
              const context = this.games.completedLlmContext(
                prepared,
                turnResponse,
                'active',
                game.moves.length + 1,
              )
              game = this.games.acceptAutomated(
                game.id,
                response.action,
                response,
                false,
                context,
              )
              run.currentTurn = game.moves.length
              this.save(run)
              llmMoved = true
              break
            } catch (error) {
              if (signal.aborted) throw error
              if (
                !rebasedProviderContext &&
                (await this.games.recoverLlmProviderContext({
                  adapter,
                  prepared,
                  signal,
                  error,
                  gameId: game.id,
                  color: llmColor,
                }))
              ) {
                rebasedProviderContext = true
                prepared = this.prepareBenchmarkLlmTurn({
                  run,
                  game,
                  llmColor,
                  connection,
                  promptPhase,
                  notebook,
                  trainingFeedback,
                  latestWinRate,
                })
                continue
              }
              if (!isRepairableMoveError(error)) {
                apiFailures += 1
                const message = publicProviderError(error)
                retryErrors.push(message)
                if (
                  !shouldRetryProviderError(error) ||
                  apiFailures >= MAX_PROVIDER_API_ATTEMPTS
                )
                  throw new Error(
                    `LLM API request failed after ${apiFailures} ${apiFailures === 1 ? 'attempt' : 'attempts'}. The benchmark has been paused. Last error: ${message}`,
                    {cause: error},
                  )
                this.games.setAutomatedTurnState(game.id, {
                  phase: 'retrying',
                  attempt: apiFailures + 1,
                  maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
                  lastError: message,
                })
                transitionBenchmark(run, {
                  type: 'update',
                  substate: {
                    kind: 'provider_retry',
                    operation: 'move',
                    attempt: apiFailures + 1,
                    maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
                    lastError: message,
                  },
                })
                this.save(run)
                await this.retryWait(apiFailures, signal, error)
                continue
              }
              const content =
                error instanceof MalformedModelOutputError
                  ? error.responseContent
                  : responseContent
              const retained = content.slice(0, 32_000)
              game = this.games.recordRejectedModelAction(game.id, {
                turn: game.moves.length + 1,
                attempt: outputFailures + 1,
                responseContent: retained,
                reason: publicProviderError(error, 'Invalid action'),
                truncated: retained.length < content.length,
              })
              outputFailures += 1
              run.outputAttempts = (run.outputAttempts ?? 0) + 1
              run.outputRepairs = (run.outputRepairs ?? 0) + 1
              const feedback = publicProviderError(error, 'Invalid action')
              this.games.setAutomatedTurnState(game.id, {
                phase: 'repairing',
                attempt: outputFailures + 1,
                maxAttempts: MAX_MODEL_OUTPUT_ATTEMPTS,
                lastError: feedback,
              })
              if (error instanceof IllegalMoveError) illegalMoveFailures += 1
              if (
                illegalMoveFailures > MAX_MODEL_OUTPUT_RETRIES &&
                error instanceof IllegalMoveError
              ) {
                const score = scoreBoard(game.board as any, game.komi, [])
                this.games.finishAutomated(game.id, score.result, {
                  kind: 'invalid_llm_actions',
                  turn: game.moves.length + 1,
                  actionCount: illegalMoveFailures,
                  reason: feedback,
                })
                transitionBenchmark(run, {
                  type: 'update',
                  substate: {kind: 'ready'},
                })
                this.save(run)
                return true
              }
              if (outputFailures > MAX_MODEL_OUTPUT_RETRIES)
                throw new Error(
                  `Model failed to produce a legal action after ${MAX_MODEL_OUTPUT_ATTEMPTS} attempts: ${feedback}`,
                  {cause: error},
                )
              prepared = this.games.repairLlmActionTurn(
                prepared,
                turnResponse ?? {
                  text: content,
                  latencyMs: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  model: run.profileSnapshot.modelId,
                  providerKind: connection.kind,
                },
                feedback,
              )
            }
          }
        } finally {
          this.games.clearAutomatedTurnState(game.id)
        }
        const afterResult = await this.analyze(game, visits, signal)
        const after = rootFromBlack(afterResult)
        const {
          beforeScore,
          afterScore,
          beforeWin,
          afterWin,
          pointLoss,
          winRateLoss,
        } = lossFromPerspective(
          llmColor,
          before,
          after,
          beforeResult.moveInfos?.[0],
        )
        if (phase === 'final_game') {
          ;(run.pointLosses ??= []).push(pointLoss)
          ;(run.winRateLosses ??= []).push(winRateLoss)
        }
        if (
          phase === 'final_game' ||
          trainingGameHasWinRates(run.config, run.currentGame)
        ) {
          const topCandidates = reviewCandidateChoices(beforeResult)
          this.store.saveBenchmarkMoveReview({
            runId: run.id,
            gameId: game.id,
            gameIndex: run.currentGame,
            turn: game.moves.length,
            color: llmColor,
            chosenMove:
              game.moves.at(-1)?.coordinate ??
              game.moves.at(-1)?.action ??
              'unknown',
            topCandidate: topCandidates[0],
            topCandidates,
            pointLoss,
            winRateLoss,
            beforeScore,
            afterScore,
            beforeWinRate: beforeWin,
            afterWinRate: afterWin,
            position: {
              size: positionBefore.size,
              komi: positionBefore.komi,
              board: positionBefore.board,
              toMove: positionBefore.toMove,
              captures: positionBefore.captures,
            },
            createdAt: new Date().toISOString(),
          })
        }
        transitionBenchmark(run, {
          type: 'update',
          substate: {kind: 'ready'},
        })
      } else {
        const move = selectedMove(beforeResult)
        const action: PlayerAction =
          move === 'pass'
            ? {action: 'pass', comment: 'KataGo passed.'}
            : {action: 'play', coordinate: move, comment: 'KataGo move.'}
        if (action.action === 'play')
          coordinateToPoint(action.coordinate, game.size)
        game = this.games.acceptAutomated(game.id, action)
      }
      run.currentTurn = game.moves.length
      this.save(run)
      const endedWithoutResignation =
        game.status === 'finished' && game.moves.at(-1)?.action !== 'resign'
      if (
        game.status === 'scoring' ||
        endedWithoutResignation ||
        (game.status === 'paused' && game.moves.length >= 722)
      ) {
        const final = await this.analyze(game, visits, signal)
        const lead = rootFromBlack(final).blackScoreLead
        game = this.games.finishAutomated(game.id, scoreLeadResult(lead))
      }
      if (llmMoved && run.pauseAfterLlmMove) {
        run.pauseAfterLlmMove = false
        transitionBenchmark(run, {
          type: 'pause',
          substate: {
            kind: 'paused',
            previous:
              run.substate.kind === 'paused'
                ? run.substate.previous
                : run.substate,
          },
        })
        run.waitingFor = undefined
        this.save(run)
      }
    }
    return game.status === 'finished'
  }

  private async initializeNotebook(run: InternalRun, signal: AbortSignal) {
    const adapter = this.adapter(run)
    if (!adapter) {
      run.waitingFor = 'credentials'
      transitionBenchmark(run, {
        type: 'update',
        substate: {kind: 'waiting_credentials'},
      })
      this.save(run)
      return false
    }
    const seedSnapshot = this.store.getBenchmarkNotebookSeed(run.id)
    const readOnlyContext = this.readOnlyNotebookContext(run)
    const seed = seedSnapshot?.content.trim()
      ? [
          run.writableNotebookRole === 'ordinary'
            ? 'WRITABLE ORDINARY-GAME NOTEBOOK TO REFINE'
            : 'WRITABLE LIFE-AND-DEATH NOTEBOOK TO REFINE',
          seedSnapshot.content,
          '',
          'Preserve correct, useful knowledge while improving clarity and actionability.',
          '',
        ]
      : []
    const initializationTokenLimit =
      run.config.notebookInitializationTokenLimit ??
      DEFAULT_NOTEBOOK_INITIALIZATION_TOKEN_LIMIT
    const notebookBudgetInstruction = [
      `The recommended notebook content budget is ${run.config.notebookTokenBudget.toLocaleString()} estimated tokens, where estimated tokens are ceil(UTF-8 bytes / 4).`,
      `The hard maximum for this entire initialization response is ${initializationTokenLimit.toLocaleString()} output tokens.`,
    ].join('\n')
    const prompt = isLifeDeath(run)
      ? [
          ...seed,
          notebookBudgetInstruction,
          LIFE_DEATH_NOTEBOOK_INITIALIZATION_INSTRUCTION,
          ...(readOnlyContext
            ? [
                '',
                'Use the following notebook only as read-only reference material. Do not return a replacement for it.',
                '',
                'READ-ONLY REFERENCE NOTEBOOKS',
                readOnlyContext,
              ]
            : []),
          '',
          'Return only the complete Markdown notebook.',
        ].join('\n')
      : [
          notebookBudgetInstruction,
          'Write a complete Markdown Go technique notebook from the authoritative rules below.',
          'Choose the organization, headings, level of detail, and writing style yourself.',
          'Do not invent lessons from games, positions, or analysis that were not supplied.',
          ...(readOnlyContext
            ? [
                'Use the following notebook only as read-only reference material. Do not return a replacement for it.',
                '',
                'READ-ONLY REFERENCE NOTEBOOKS',
                readOnlyContext,
              ]
            : []),
          '',
          'AUTHORITATIVE GO RULES',
          ...formatCanonicalGoRules({size: 19, komi: 7.5}),
          ...(seed.length ? [''] : []),
          ...seed,
          'Return only the complete Markdown notebook.',
        ].join('\n')
    const content = await this.requestValidNotebook(
      run,
      adapter,
      prompt,
      'initializing_notebook',
      signal,
    )
    const version = notebookVersion(run, 'initializing_notebook', content)
    run.notebookVersion = version.version
    run.notebookEstimatedTokens = version.estimatedTokens
    run.notebook.updatedAt = version.createdAt
    if (!isLifeDeath(run) && !isNotebookInitializationStage(run.stageKey))
      run.initializationContext = {
        transcript: [
          {role: 'user', content: prompt},
          {role: 'assistant', content},
        ],
      }
    transitionBenchmark(run, {
      type: 'update',
      phase: isLifeDeath(run) ? 'solving_problem' : 'training_game',
      substate: {kind: 'ready'},
    })
    run.updatedAt = version.createdAt
    this.store.saveBenchmarkNotebookVersion(run, version)
    await this.notebooks.writeRunSnapshot(run.id, content)
    this.emit(run)
    return true
  }

  private async runProblemGate(run: InternalRun, signal: AbortSignal) {
    const set = loadProblemSet(run.config.problemSetId!)
    if (run.problemSetChecksum !== set.checksum) {
      transitionBenchmark(run, {type: 'invalidate'})
      run.error =
        'The selected problem set changed after this benchmark was created.'
      this.save(run)
      return false
    }
    const required = set.problems.length
    const problemAttemptLimit =
      run.config.lifeDeathProblemAttemptLimit ??
      runtimeConfig.benchmarkProblemAttempts
    while (
      run.status === 'running' &&
      (run.problemSuccessStreak ?? 0) < required
    ) {
      const cursor = run.problemCursor ?? 0
      const problem = set.problems[cursor % required]
      run.currentProblemId = problem.id
      transitionBenchmark(run, {
        type: 'update',
        phase: run.pendingProblem
          ? 'updating_problem_notebook'
          : 'solving_problem',
        substate: {kind: 'ready'},
      })
      this.save(run)
      if (!run.pendingProblem) {
        const adapter = this.adapter(run)
        if (!adapter) {
          run.waitingFor = 'credentials'
          transitionBenchmark(run, {
            type: 'update',
            substate: {kind: 'waiting_credentials'},
          })
          this.save(run)
          return false
        }
        const progress =
          run.problemProgress?.problemId === problem.id &&
          run.problemProgress.cursor === cursor
            ? run.problemProgress
            : {
                problemId: problem.id,
                cursor,
                actions: [],
                step: 0,
              }
        if (!progress.workflow) {
          const failedTries = this.store
            .listBenchmarkProblemAttempts(run.id)
            .filter(
              (attempt) =>
                attempt.problemId === problem.id &&
                attempt.cursor === cursor &&
                attempt.notebookVersionBefore === run.notebookVersion &&
                !attempt.correct,
            ).length
          const hadFailedBranch = Boolean(
            progress.lastFailureReason && progress.actions.length,
          )
          if (hadFailedBranch) {
            progress.actions = []
            progress.step = 0
          }
          progress.workflow = {
            failedTries,
            phase: hadFailedBranch
              ? 'redo_problem'
              : progress.actions.length
                ? 'continuing_solution'
                : progress.lastFailureReason
                  ? 'root_feedback'
                  : 'initial_problem',
          }
        }
        run.problemProgress = progress
        while (run.status === 'running' && !run.pendingProblem) {
          const workflow = progress.workflow!
          const currentSnapshot = problemSnapshotAt(problem, progress.actions)
          const expectedAction = problem.solution[progress.step]
          if (!expectedAction) {
            run.pendingProblem = {
              problemId: problem.id,
              cursor,
              actualAction: progress.actions.at(-1),
              legal: true,
              correct: true,
              promptDigest: '',
              notebookVersionBefore: run.notebookVersion,
              actions: progress.actions,
              step: progress.step,
            }
            break
          }
          const sendsInitialProblem =
            workflow.phase === 'initial_problem' ||
            workflow.phase === 'redo_problem'
          const startsNewContext = workflow.phase === 'initial_problem'
          const prompt = sendsInitialProblem
            ? initialLifeDeathProblemPrompt(
                await this.runNotebook(run.id),
                problem.snapshot,
                workflow.phase === 'redo_problem'
                  ? progress.lastFailureReason
                  : undefined,
              )
            : workflow.phase === 'root_feedback'
              ? lifeDeathFailureFeedbackPrompt(progress.lastFailureReason)
              : continuingLifeDeathProblemPrompt(currentSnapshot)
          const digest = createHash('sha256').update(prompt).digest('hex')
          if (startsNewContext) this.clearProblemContext(run)
          let actual: PlayerAction | undefined
          let responseDigest: string | undefined
          let failureReason: string | undefined
          let legal = false
          let correct = false
          try {
            const response = await this.requestProblemAction(
              run,
              adapter,
              currentSnapshot,
              prompt,
              `linggo:benchmark:${run.id}:problem:${problem.id}`,
              signal,
              startsNewContext ? [] : undefined,
            )
            addUsage(run, response, 'solving_problem')
            actual = response.action
            responseDigest = createHash('sha256')
              .update(response.responseContent ?? JSON.stringify(actual))
              .digest('hex')
            const sequence = [...progress.actions, ...(actual ? [actual] : [])]
            const score = scoreProblemSequence(
              sequence,
              problem.solution,
              problem.snapshot,
            )
            legal = score.legal
            correct = score.correct
            failureReason = score.reason
            if (correct) {
              progress.actions.push(actual!)
              progress.step = progress.actions.length
              progress.workflow = transitionLifeDeathProblem(workflow, {
                type: 'correct_action',
                complete: progress.step >= problem.solution.length,
              })
              progress.lastFailureAction = undefined
              progress.lastFailureReason = undefined
              run.problemProgress = progress
              this.save(run)
            }
          } catch (error) {
            if (signal.aborted) throw error
            if (!isRepairableMoveError(error)) throw error
            failureReason =
              error instanceof Error ? error.message : 'Malformed action'
          }
          const attempt: BenchmarkProblemAttempt = {
            runId: run.id,
            sequence:
              this.store.listBenchmarkProblemAttempts(run.id).length + 1,
            problemId: problem.id,
            cursor,
            actualAction: actual,
            expectedAction,
            legal,
            correct,
            firstResponse: sendsInitialProblem,
            failureReason,
            notebookVersionBefore: run.notebookVersion,
            promptDigest: digest,
            responseDigest,
            createdAt: new Date().toISOString(),
          }
          this.store.saveBenchmarkProblemAttempt(attempt)
          this.emit(run)
          if (correct && progress.step >= problem.solution.length) {
            run.problemSuccessStreak = (run.problemSuccessStreak ?? 0) + 1
            run.pendingProblem = {
              problemId: problem.id,
              cursor,
              actualAction: actual,
              legal,
              correct: true,
              failureReason,
              promptDigest: digest,
              responseDigest,
              notebookVersionBefore: run.notebookVersion,
              actions: progress.actions,
              step: progress.step,
            }
            this.save(run)
            break
          }
          if (correct) continue
          run.problemSuccessStreak = 0
          const hadCorrectProgress = progress.actions.length > 0
          progress.workflow = transitionLifeDeathProblem(workflow, {
            type: 'failed_action',
            attemptLimit: problemAttemptLimit,
            hadCorrectProgress,
          })
          if (
            progress.workflow.phase === 'redo_problem' &&
            hadCorrectProgress
          ) {
            progress.actions = []
            progress.step = 0
          }
          progress.lastFailureAction = actual
          progress.lastFailureReason = failureReason
          run.problemProgress = progress
          if (progress.workflow.phase === 'updating_notebook') {
            run.pendingProblem = {
              problemId: problem.id,
              cursor,
              actualAction: actual,
              legal,
              correct: false,
              failureReason: failureReason ?? 'the action was incorrect',
              promptDigest: digest,
              responseDigest,
              notebookVersionBefore: run.notebookVersion,
              actions: progress.actions,
              step: progress.step,
            }
          }
          this.save(run)
        }
      }
      transitionBenchmark(run, {
        type: 'update',
        phase: 'updating_problem_notebook',
      })
      const pending = run.pendingProblem!
      const prior = await this.runNotebook(run.id)
      const updatePrompt = [
        'Update your self-written life-and-death technique notebook now.',
        pending.correct
          ? 'UPDATE TRIGGER: SUCCESS. The complete problem solution was correct.'
          : `UPDATE TRIGGER: FAILED_AFTER_${problemAttemptLimit}_ATTEMPTS. The problem was not solved after ${problemAttemptLimit} attempts.`,
        'UPDATE GOAL',
        'Make the notebook more effective for solving future life-and-death problems. Use what this problem conversation revealed to improve a weak or inaccurate numbered point, add a missing generalizable point, or delete a misleading or redundant point.',
        'Preserve correct and useful knowledge. Make only changes supported by this conversation, and keep every changed point operational for future reading and verification.',
        LIFE_DEATH_NOTEBOOK_INSTRUCTION,
        LIFE_DEATH_NOTEBOOK_PATCH_OUTPUT_INSTRUCTION,
      ].join('\n')
      const notebookAdapter = this.adapter(run)
      if (!notebookAdapter) {
        run.waitingFor = 'credentials'
        transitionBenchmark(run, {
          type: 'update',
          substate: {kind: 'waiting_credentials'},
        })
        this.save(run)
        return false
      }
      const content = await this.requestValidProblemNotebookPatch(
        run,
        notebookAdapter,
        updatePrompt,
        prior,
        problem.snapshot,
        signal,
      )
      const version = notebookVersion(run, 'problem_notebook', content)
      run.notebookVersion = version.version
      run.notebookEstimatedTokens = version.estimatedTokens
      run.notebook.updatedAt = version.createdAt
      const solved = pending.correct
      const completedWorkflow = run.problemProgress?.workflow
      if (completedWorkflow?.phase === 'updating_notebook')
        run.problemProgress!.workflow = transitionLifeDeathProblem(
          completedWorkflow,
          {type: 'notebook_updated'},
        )
      run.pendingProblem = undefined
      run.problemProgress = undefined
      run.problemCursor = solved ? (cursor + 1) % required : cursor
      this.store.saveBenchmarkNotebookVersion(run, version)
      await this.notebooks.writeRunSnapshot(run.id, content)
      this.clearProblemContext(run)
      const attempts = this.store.listBenchmarkProblemAttempts(run.id)
      const last = attempts.at(-1)!
      last.notebookVersionAfter = version.version
      this.store.saveBenchmarkProblemAttempt(last)
      const allAttempts = this.store.listBenchmarkProblemAttempts(run.id)
      run.metrics = {
        ...(run.metrics ?? ({} as any)),
        problemCount: required,
        problemAttempts: allAttempts.length,
        firstResponseSuccessRate: firstResponseSuccessRate(allAttempts),
        problemFailures: allAttempts.filter((attempt) => !attempt.correct)
          .length,
        completedCleanCycles: 0,
        kataGoGateReached: false,
      }
      this.emit(run)
    }
    if ((run.problemSuccessStreak ?? 0) >= required) {
      run.metrics = {
        ...(run.metrics ?? ({} as any)),
        problemCount: required,
        problemAttempts: this.store.listBenchmarkProblemAttempts(run.id).length,
        firstResponseSuccessRate: firstResponseSuccessRate(
          this.store.listBenchmarkProblemAttempts(run.id),
        ),
        problemFailures: this.store
          .listBenchmarkProblemAttempts(run.id)
          .filter((a) => !a.correct).length,
        completedCleanCycles: 1,
        kataGoGateReached: true,
      }
      this.save(run)
    }
    return true
  }

  private async requestProblemAction(
    run: InternalRun,
    adapter: ReturnType<BenchmarkService['adapter']> & {},
    snapshot: GameSnapshot,
    prompt: string,
    cacheKey: string,
    signal: AbortSignal,
    transcriptOverride?: VisibleLlmMessage[],
  ) {
    const transcript = transcriptOverride ?? completedLlmTranscript(run)
    this.recordLlmRequest(run, prompt)
    let lastError = ''
    for (let attempt = 1; attempt <= MAX_PROVIDER_API_ATTEMPTS; attempt++) {
      transitionBenchmark(run, {
        type: 'update',
        substate:
          attempt === 1
            ? {
                kind: 'provider_request',
                operation: 'problem',
                attempt,
                maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
              }
            : {
                kind: 'provider_retry',
                operation: 'problem',
                attempt,
                maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
                lastError,
              },
      })
      this.save(run)
      try {
        const turn = await requestLlm(
          adapter,
          {
            type: 'turn',
            request: {
              kind: transcript.length ? 'continuation' : 'initial',
              content: prompt,
              transcript,
              cacheKey,
              snapshot,
              output: 'action',
            },
          },
          signal,
        )
        const response = {
          ...parseJsonActionResult(turn.text, snapshot.size),
          responseContent: turn.text,
          reasoning: turn.reasoning,
          latencyMs: turn.latencyMs,
          inputTokens: turn.inputTokens,
          cachedInputTokens: turn.cachedInputTokens,
          outputTokens: turn.outputTokens,
          model: turn.model,
          providerKind: turn.providerKind,
          retries: 0,
        }
        this.recordLlmResponse(run, response.responseContent)
        return response
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof MalformedModelOutputError)
          this.recordLlmResponse(run, error.responseContent)
        else if (NoOutputGeneratedError.isInstance(error))
          this.recordLlmResponse(run, '')
        if (
          isRepairableMoveError(error) ||
          !shouldRetryProviderError(error) ||
          attempt >= MAX_PROVIDER_API_ATTEMPTS
        )
          throw error
        lastError = publicProviderError(error)
        await this.retryWait(attempt, signal, error)
      }
    }
    throw new Error('Problem request failed')
  }

  private async reviewGame(run: InternalRun, signal: AbortSignal) {
    const adapter = this.adapter(run)
    if (!adapter) {
      run.waitingFor = 'credentials'
      transitionBenchmark(run, {
        type: 'update',
        substate: {kind: 'waiting_credentials'},
      })
      this.save(run)
      return false
    }
    const game = this.currentGame(run)
    if (!game) throw new Error('Benchmark game not found')
    const color = run.currentGame % 2 === 0 ? 'B' : 'W'
    const priorNotebook = await this.runNotebook(run.id)
    const readOnlyContext = this.readOnlyNotebookContext(run)
    const reasons = game.moves
      .filter((move) => move.color === color && move.comment?.trim())
      .map(
        (move) =>
          `${move.number}. ${move.coordinate ?? move.action}: ${move.comment!.trim()}`,
      )
    const reviewLines = trainingGameHasWinRates(run.config, run.currentGame)
      ? this.store
          .listBenchmarkMoveReviews(run.id, run.currentGame)
          .sort(compareMoveReviews)
          .slice(0, 12)
          .map((review, index) =>
            [
              `${index + 1}. Turn ${review.turn}: chose ${review.chosenMove}; KataGo candidates (best first) ${formatReviewCandidates(review)}; point loss ${review.pointLoss.toFixed(2)}; win-rate loss versus candidate #1 ${(review.winRateLoss * 100).toFixed(2)}%.`,
              asciiBoard({
                size: review.position.size,
                komi: review.position.komi,
                board: review.position.board,
                toMove: review.position.toMove,
                moves: [],
                captures: review.position.captures,
                rules: 'Chinese area',
              }),
            ].join('\n'),
          )
      : []
    const prompt = [
      'Update only the writable ordinary-game notebook using the explicit context and game review below.',
      'Generalize actionable lessons. Do not rely on conversation continuity.',
      ...(readOnlyContext
        ? [
            '',
            'READ-ONLY REFERENCE NOTEBOOKS',
            readOnlyContext,
            'Do not copy or replace the read-only notebooks in your response.',
          ]
        : []),
      '',
      'WRITABLE PRIOR NOTEBOOK',
      priorNotebook,
      '',
      'GAME REVIEW',
      `Outcome: ${perspectiveOutcome(game.result, color)}`,
      ...(game.benchmarkTermination
        ? ['', formatBenchmarkTermination(game.benchmarkTermination)]
        : []),
      'Visible move reasons:',
      ...(reasons.length ? reasons : ['(none)']),
      ...(trainingGameHasWinRates(run.config, run.currentGame)
        ? [
            '',
            'Largest mistakes (stable by point loss, then turn):',
            ...reviewLines,
          ]
        : []),
      '',
      'Return only the complete replacement Markdown technique notebook.',
    ].join('\n')
    const content = await this.requestValidNotebook(
      run,
      adapter,
      prompt,
      'reviewing_game',
      signal,
    )
    const version = notebookVersion(run, 'reviewing_game', content)
    run.notebookVersion = version.version
    run.notebookEstimatedTokens = version.estimatedTokens
    run.notebook.updatedAt = version.createdAt
    run.currentGame += 1
    run.currentTurn = 0
    transitionBenchmark(run, {
      type: 'update',
      phase:
        run.currentGame < configuredTrainingGameCount(run.config)
          ? 'training_game'
          : 'final_game',
      substate: {kind: 'ready'},
    })
    run.updatedAt = version.createdAt
    this.games.completeLlmContexts(game.id)
    this.store.saveBenchmarkNotebookVersion(run, version)
    await this.notebooks.writeRunSnapshot(run.id, content)
    this.emit(run)
    return true
  }

  private async sourceNotebook(
    config: BenchmarkConfig,
  ): Promise<TechniqueNotebook | undefined> {
    if (config.notebookSeed.mode === 'rules_only') return undefined
    const notebook = this.notebooks.get(
      config.profileId,
      config.notebookSeed.notebookId,
    )
    if (notebook) return notebook
    if (!this.notebooks.store) {
      const content = await this.notebooks.readCurrent(config.profileId)
      return {
        id: config.notebookSeed.notebookId,
        profileId: config.profileId,
        name: 'Default',
        content,
        createdAt: '',
        updatedAt: '',
      }
    }
    throw new Error('Technique notebook not found for this player profile')
  }

  private async runNotebook(runId: string) {
    return (
      this.store.getNotebookSnapshot(runId)?.content ??
      this.store.getBenchmarkNotebookSeed(runId)?.content ??
      (await this.notebooks.readSnapshot(runId))
    )
  }

  private readOnlyNotebookContext(run: InternalRun) {
    return (run.readOnlyNotebooks ?? [])
      .map(
        (notebook) =>
          `${notebook.role === 'life_death' ? 'LIFE-AND-DEATH NOTEBOOK' : 'ORDINARY-GAME NOTEBOOK'} (READ ONLY)\n${notebook.content.trim() || '(none)'}`,
      )
      .join('\n\n')
  }

  private async requestValidProblemNotebookPatch(
    run: InternalRun,
    adapter: ReturnType<BenchmarkService['adapter']> & {},
    initialPrompt: string,
    prior: string,
    snapshot: GameSnapshot,
    signal: AbortSignal,
  ) {
    let prompt = initialPrompt
    for (let invalidAttempt = 1; invalidAttempt <= 3; invalidAttempt++) {
      const response = await this.requestNotebookText(
        run,
        adapter,
        prompt,
        'problem_notebook',
        signal,
        {
          snapshot,
          cacheKey: `linggo:benchmark:${run.id}:problem:${run.currentProblemId}`,
          includeTranscript: true,
        },
      )
      addUsage(run, response, 'updating_problem_notebook')
      try {
        return applyLifeDeathNotebookPatch(prior, response.text)
      } catch (error) {
        if (invalidAttempt === 3)
          throw new Error(
            `The model returned an invalid life-and-death notebook patch after three attempts. The benchmark has been paused. Last error: ${publicError(error)}`,
            {cause: error},
          )
        transitionBenchmark(run, {
          type: 'update',
          substate: {
            kind: 'compressing',
            attempt: invalidAttempt + 1,
            maxAttempts: 3,
          },
        })
        this.save(run)
        prompt = [
          `Your previous notebook patch was invalid: ${publicError(error)}.`,
          'Correct it and return only one JSON object in the required notebook patch format.',
        ].join('\n')
      }
    }
    throw new Error('Life-and-death notebook patch validation failed')
  }

  private finishMetrics(run: InternalRun, trainingGameCount: number) {
    const initial = this.store.listBenchmarkNotebookVersions(run.id)[0]
    const current = this.store.listBenchmarkNotebookVersions(run.id).at(-1)
    run.metrics = {
      ...(run.metrics ?? {}),
      ...calculateMetrics(
        this.games.get(run.gameIds[trainingGameCount])?.result ?? 'Void',
        run.config.finalColor,
        run.pointLosses ?? [],
        run.winRateLosses ?? [],
      ),
      outputRepairRate: run.outputAttempts
        ? (run.outputRepairs ?? 0) / run.outputAttempts
        : 0,
      trainingReviewCount: this.store
        .listBenchmarkNotebookVersions(run.id)
        .filter(({sourcePhase}) => sourcePhase === 'reviewing_game').length,
      notebookGrowthCharacters:
        (current?.characterCount ?? 0) - (initial?.characterCount ?? 0),
    }
  }

  private async requestValidNotebook(
    run: InternalRun,
    adapter: ReturnType<BenchmarkService['adapter']> & {},
    initialPrompt: string,
    sourcePhase:
      'initializing_notebook' | 'reviewing_game' | 'problem_notebook',
    signal: AbortSignal,
  ) {
    let prompt = initialPrompt
    let previousResponseId: string | undefined
    let lastNonEmptyContent = ''
    const initializationTokenLimit =
      run.config.notebookInitializationTokenLimit ??
      DEFAULT_NOTEBOOK_INITIALIZATION_TOKEN_LIMIT
    const notebookTokenLimit =
      sourcePhase === 'initializing_notebook' && isLifeDeath(run)
        ? initializationTokenLimit
        : run.config.notebookTokenBudget
    const tokenLimitDescription =
      sourcePhase === 'initializing_notebook' && isLifeDeath(run)
        ? 'initialization token limit'
        : 'estimated-token budget'
    const supportsInitializationContinuation =
      sourcePhase === 'initializing_notebook' &&
      Boolean(adapter.requestTextTurn)
    for (let invalidAttempt = 1; invalidAttempt <= 3; invalidAttempt++) {
      const operation =
        invalidAttempt === 1
          ? sourcePhase === 'reviewing_game'
            ? 'review'
            : sourcePhase === 'problem_notebook'
              ? 'problem_notebook'
              : 'initialize'
          : 'compress'
      if (invalidAttempt > 1) {
        transitionBenchmark(run, {
          type: 'update',
          substate: {
            kind: 'compressing',
            attempt: invalidAttempt,
            maxAttempts: 3,
          },
        })
        this.save(run)
      }
      const response = await this.requestNotebookText(
        run,
        adapter,
        prompt,
        operation,
        signal,
        supportsInitializationContinuation &&
          (invalidAttempt === 1 ||
            Boolean(previousResponseId) ||
            !adapter.requestText)
          ? {
              cacheKey: `linggo:benchmark:${run.id}:notebook:${operation}`,
              textContinuation: true,
              previousResponseId,
            }
          : undefined,
        sourcePhase === 'initializing_notebook'
          ? initializationTokenLimit
          : undefined,
      )
      const responseContinuationId =
        'providerContinuationId' in response &&
        typeof response.providerContinuationId === 'string'
          ? response.providerContinuationId
          : undefined
      addUsage(
        run,
        response,
        sourcePhase === 'problem_notebook'
          ? 'updating_problem_notebook'
          : sourcePhase,
      )
      const content = response.text.trim()
      const byteCount = Buffer.byteLength(content, 'utf8')
      const estimatedTokens = Math.ceil(byteCount / 4)
      if (content && estimatedTokens <= notebookTokenLimit) return content
      if (content) {
        lastNonEmptyContent = content
        previousResponseId = responseContinuationId
      } else {
        // An empty continuation is not a useful parent for another attempt.
        // Retain the last notebook and resend it explicitly on the next turn.
        previousResponseId = undefined
      }
      if (invalidAttempt === 3)
        throw new Error(
          content
            ? `Notebook exceeds the ${notebookTokenLimit.toLocaleString()} ${tokenLimitDescription} after three attempts. The benchmark has been paused.`
            : 'The model returned an empty notebook after three attempts. The benchmark has been paused.',
        )
      prompt = lastNonEmptyContent
        ? [
            `Compress the notebook ${previousResponseId ? 'in your previous response' : 'below'} to at most ${notebookTokenLimit.toLocaleString()} estimated tokens, where estimated tokens are ceil(UTF-8 bytes / 4).`,
            'Preserve the most useful knowledge while writing a complete Markdown notebook in your own organization and style. Do not truncate it.',
            ...(isLifeDeath(run) ? [LIFE_DEATH_NOTEBOOK_INSTRUCTION] : []),
            ...(previousResponseId ? [] : ['', lastNonEmptyContent]),
            '',
            'Return only the complete compressed Markdown notebook.',
          ].join('\n')
        : [
            initialPrompt,
            ...(isLifeDeath(run) ? [LIFE_DEATH_NOTEBOOK_INSTRUCTION] : []),
            '',
            'Your previous response was empty. Return a non-empty complete Markdown notebook.',
          ].join('\n')
    }
    throw new Error('Notebook validation failed')
  }

  private async requestNotebookText(
    run: InternalRun,
    adapter: ReturnType<BenchmarkService['adapter']> & {},
    prompt: string,
    operation:
      'initialize' | 'compress' | 'review' | 'problem' | 'problem_notebook',
    signal: AbortSignal,
    context?: {
      cacheKey: string
      includeTranscript?: boolean
      snapshot?: GameSnapshot
      textContinuation?: boolean
      previousResponseId?: string
    },
    maxOutputTokens?: number,
  ) {
    const transcript =
      context && context.includeTranscript !== false
        ? completedLlmTranscript(run)
        : []
    this.recordLlmRequest(run, prompt)
    let lastError = ''
    for (let attempt = 1; attempt <= MAX_PROVIDER_API_ATTEMPTS; attempt++) {
      transitionBenchmark(run, {
        type: 'update',
        substate:
          attempt === 1
            ? {
                kind: 'provider_request',
                operation,
                attempt,
                maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
              }
            : {
                kind: 'provider_retry',
                operation,
                attempt,
                maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
                lastError,
              },
      })
      this.save(run)
      try {
        const response = context?.textContinuation
          ? await requestLlm(
              adapter,
              {
                type: 'textTurn',
                request: {
                  content: prompt,
                  transcript,
                  previousResponseId: context.previousResponseId,
                  cacheKey: context.cacheKey,
                  maxOutputTokens,
                },
              },
              signal,
            )
          : context?.snapshot
            ? await requestLlm(
                adapter,
                {
                  type: 'turn',
                  request: {
                    kind: transcript.length ? 'continuation' : 'initial',
                    content: prompt,
                    transcript,
                    cacheKey: context.cacheKey,
                    snapshot: context.snapshot,
                    output: 'notebook',
                  },
                },
                signal,
              )
            : await requestLlm(
                adapter,
                {
                  type: 'text',
                  content: prompt,
                  cacheKey:
                    context?.cacheKey ??
                    `linggo:benchmark:${run.id}:notebook:${operation}`,
                  maxOutputTokens,
                },
                signal,
              )
        this.recordLlmResponse(run, response.text)
        return response
      } catch (error) {
        if (signal.aborted) throw error
        if (NoOutputGeneratedError.isInstance(error)) {
          this.recordLlmResponse(run, '')
          return {
            text: '',
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            model: run.profileSnapshot.modelId,
          }
        }
        lastError = publicProviderError(error)
        if (
          !shouldRetryProviderError(error) ||
          attempt >= MAX_PROVIDER_API_ATTEMPTS
        )
          throw new Error(
            `LLM API request failed after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'} during notebook ${operation}. The benchmark has been paused. Last error: ${lastError}`,
            {cause: error},
          )
        await this.retryWait(attempt, signal, error)
      }
    }
    throw new Error('Notebook request failed')
  }

  private latestMoveReview(runId: string, gameIndex: number) {
    const review = this.store.listBenchmarkMoveReviews(runId, gameIndex).at(-1)
    if (!review) return undefined
    return [
      `Previous-move review for turn ${review.turn}: you chose ${review.chosenMove}.`,
      `KataGo's top candidates in the position immediately before that move, ranked best first: ${formatReviewCandidates(review)}.`,
      `Point loss: ${review.pointLoss.toFixed(2)}; win-rate loss versus candidate #1: ${(review.winRateLoss * 100).toFixed(2)}%.`,
      `Score estimate before/after from your perspective: ${review.beforeScore.toFixed(2)} / ${review.afterScore.toFixed(2)}.`,
    ].join(' ')
  }

  private adapter(run: InternalRun) {
    const connection = this.connection(run)
    if (connection.kind !== 'fake' && !this.games.vault.get(connection))
      return undefined
    return this.adapterFactory(
      connection,
      run.profileSnapshot,
      this.games.vault,
    )
  }

  private connection(run: InternalRun) {
    const connection = this.store.getConnection(
      run.profileSnapshot.connectionId,
    )
    if (!connection)
      throw new Error('The benchmark provider connection no longer exists')
    return connection
  }

  private prepareBenchmarkLlmTurn(input: {
    run: InternalRun
    game: Game
    llmColor: Color
    connection: ProviderConnection
    promptPhase: 'training' | 'final'
    notebook: string
    trainingFeedback: BenchmarkConfig['trainingFeedback']
    latestWinRate?: string
  }) {
    return this.games.prepareLlmActionTurn({
      gameId: input.game.id,
      color: input.llmColor,
      profile: input.run.profileSnapshot,
      connection: input.connection,
      mode: {
        kind: 'benchmark',
        phase: input.promptPhase,
        notebook: input.notebook,
        trainingFeedback: input.trainingFeedback,
        stageKey: input.run.stageKey,
        writableNotebookRole: input.run.writableNotebookRole,
        readOnlyNotebooks: input.run.readOnlyNotebooks,
      },
      latestWinRate: input.latestWinRate,
    })
  }

  private async analyze(game: Game, visits: number, signal: AbortSignal) {
    let result
    try {
      result = await this.engine.analyze(
        {...gamePosition(game), visits, priority: 50},
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw error
      throw new KataGoUnavailableError(publicError(error))
    }
    const state = replay(game.size, game.moves)
    const value: PositionAnalysis = {
      gameId: game.id,
      turn: game.moves.length,
      ...rootFromBlack(result),
      positionHash: `${boardHash(state.board)}:${state.toMove}`,
      createdAt: new Date().toISOString(),
    }
    this.store.savePositionAnalysis(value)
    this.store.setGameAnalysisState(game.id, {
      status: transitionAnalysis(this.store.getGameAnalysis(game.id), {
        type: 'complete',
      }).status,
      error: null,
    })
    return result
  }

  private currentGame(run: InternalRun) {
    const id = run.gameIds[run.currentGame]
    return id ? this.games.get(id) : undefined
  }

  private recordLlmRequest(run: InternalRun, prompt: string) {
    const messages = (run.llmMessages ??= [])
    const previous = messages.at(-1)
    if (previous?.pending && previous.content === prompt) return
    messages.push({role: 'user', content: prompt, pending: true})
    this.save(run)
  }

  private clearProblemContext(run: InternalRun) {
    run.llmMessages = []
    run.updatedAt = new Date().toISOString()
    this.store.saveBenchmark(run)
    this.emit(run)
  }

  private recordLlmResponse(run: InternalRun, content?: string) {
    const messages = (run.llmMessages ??= [])
    const previous = messages.at(-1)
    if (previous?.pending) previous.pending = undefined
    if (content !== undefined) messages.push({role: 'assistant', content})
    this.save(run)
  }

  private require(id: string) {
    const run = this.get(id) as InternalRun | undefined
    if (!run) throw new Error('Benchmark not found')
    return run
  }

  private save(run: InternalRun) {
    if (this.deletedRuns.has(run.id)) return
    run.updatedAt = new Date().toISOString()
    this.store.saveBenchmark(run)
    this.emit(run)
  }

  private emit(run: InternalRun) {
    this.events.emit(run.id, run)
    this.events.emit('changed', run.id)
  }
}

function isRepairableMoveError(error: unknown) {
  return (
    error instanceof IllegalMoveError ||
    error instanceof MalformedModelOutputError ||
    NoOutputGeneratedError.isInstance(error)
  )
}

function completedLlmTranscript(run: InternalRun) {
  return (run.llmMessages ?? [])
    .filter((message) => !message.pending)
    .map(({role, content}) => ({role, content}))
}

export function applyLifeDeathNotebookPatch(prior: string, response: string) {
  let json: unknown
  try {
    json = JSON.parse(notebookPatchJson(response))
  } catch (error) {
    throw new Error('Patch is not valid JSON', {cause: error})
  }
  const parsed = lifeDeathNotebookPatchSchema.safeParse(json)
  if (!parsed.success)
    throw new Error(
      `Patch must map positive integer note numbers to non-empty strings or null: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    )
  const lines = prior.trim() ? prior.trim().split('\n') : []
  for (const [number, replacement] of Object.entries(parsed.data)) {
    const index = lines.findIndex((line) =>
      new RegExp(`^${number}\\.\\s+`).test(line.trim()),
    )
    if (replacement === null) {
      if (index < 0) throw new Error(`Cannot delete missing note ${number}`)
      lines.splice(index, 1)
    } else if (index < 0) lines.push(`${number}. ${replacement}`)
    else lines[index] = `${number}. ${replacement}`
  }
  return lines.join('\n').trim()
}

function notebookPatchJson(response: string) {
  const trimmed = response.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1] ?? trimmed
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

export function pointLossQuality(loss: number) {
  if (loss <= 0.5) return 100
  if (loss <= 1.5) return 85
  if (loss <= 3) return 65
  if (loss <= 6) return 40
  if (loss <= 12) return 15
  return 0
}

export function calculateMetrics(
  result: string,
  color: Color,
  pointLosses: number[],
  winRateLosses: number[],
): BenchmarkMetrics {
  const winner = result.startsWith('B+')
    ? 'B'
    : result.startsWith('W+')
      ? 'W'
      : undefined
  const resultScore = winner ? (winner === color ? 100 : 0) : 50
  const moveQuality = average(pointLosses.map(pointLossQuality))
  return {
    result,
    averagePointLoss: average(pointLosses),
    averageWinRateLoss: average(winRateLosses),
    moveCount: pointLosses.length,
    moveQuality,
    resultScore,
    score: (moveQuality + resultScore) / 2,
  }
}

export function lossFromPerspective(
  color: Color,
  before: Pick<
    PositionAnalysis,
    'blackScoreLead' | 'blackWinRate' | 'whiteWinRate'
  >,
  after: Pick<
    PositionAnalysis,
    'blackScoreLead' | 'blackWinRate' | 'whiteWinRate'
  >,
  topCandidate?: {winrate: number},
) {
  const beforeScore =
    color === 'B' ? before.blackScoreLead : -before.blackScoreLead
  const afterScore =
    color === 'B' ? after.blackScoreLead : -after.blackScoreLead
  const beforeWin = topCandidate
    ? color === 'B'
      ? topCandidate.winrate
      : 1 - topCandidate.winrate
    : color === 'B'
      ? before.blackWinRate
      : before.whiteWinRate
  const afterWin = color === 'B' ? after.blackWinRate : after.whiteWinRate
  return {
    beforeScore,
    afterScore,
    beforeWin,
    afterWin,
    pointLoss: Math.max(0, beforeScore - afterScore),
    winRateLoss: Math.max(0, beforeWin - afterWin),
  }
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

function firstResponseSuccessRate(attempts: BenchmarkProblemAttempt[]) {
  const firstResponses = attempts.filter((attempt) => attempt.firstResponse)
  return (
    firstResponses.filter((attempt) => attempt.correct).length /
    Math.max(1, firstResponses.length)
  )
}

function lifeDeathPositionPrompt(snapshot: GameSnapshot) {
  return [
    'CURRENT BOARD',
    LIFE_DEATH_BOARD_SYMBOL_LEGEND,
    `Player to move now: ${snapshot.toMove === 'B' ? 'Black (X)' : 'White (O)'}.`,
    `Captures: Black ${snapshot.captures.B}, White ${snapshot.captures.W}.`,
    asciiBoard(snapshot),
  ]
}

function initialLifeDeathProblemPrompt(
  notebook: string,
  snapshot: GameSnapshot,
  redoReason?: string,
) {
  return [
    'SELF-WRITTEN SKILLS',
    notebook,
    '',
    ...(redoReason
      ? [
          'The previous whole-problem attempt failed after making some correct progress.',
          'Your previous action was wrong.',
          `Reason: ${redoReason}`,
          'Redo the initial problem from the beginning.',
        ]
      : ['Solve the life-and-death Go problem. Use exactly one legal action.']),
    'OUTPUT JSON SCHEMA',
    '{"move":"<coordinate, pass, or resign>","reason":"<brief explanation>"}',
    'Return exactly one JSON action object and no other fields or prose.',
    ...lifeDeathPositionPrompt(snapshot),
  ].join('\n')
}

function lifeDeathFailureFeedbackPrompt(reason?: string) {
  return [
    'Your previous action was wrong.',
    `Reason: ${reason ?? 'The action was incorrect.'}`,
  ].join('\n')
}

function continuingLifeDeathProblemPrompt(snapshot: GameSnapshot) {
  return [
    'Your previous action was correct.',
    `You now play as ${snapshot.toMove === 'B' ? 'Black (X)' : 'White (O)'}.`,
    'Continue solving the life-and-death problem with exactly one legal action.',
    ...lifeDeathPositionPrompt(snapshot),
  ].join('\n')
}

function addUsage(
  run: InternalRun,
  value: {
    inputTokens: number
    cachedInputTokens?: number
    outputTokens: number
    latencyMs: number
  },
  phase: BenchmarkPhase = run.phase,
) {
  run.usage.calls += 1
  run.usage.inputTokens += value.inputTokens
  run.usage.cachedInputTokens =
    (run.usage.cachedInputTokens ?? 0) + (value.cachedInputTokens ?? 0)
  run.usage.outputTokens += value.outputTokens
  run.usage.latencyMs += value.latencyMs
  if (
    phase === 'initializing_notebook' ||
    phase === 'training_game' ||
    phase === 'reviewing_game' ||
    phase === 'final_game' ||
    phase === 'solving_problem' ||
    phase === 'updating_problem_notebook'
  ) {
    const bucket = (run.usage.byPhase ??= {})
    const usage = (bucket[phase] ??= {
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    })
    usage.calls += 1
    usage.inputTokens += value.inputTokens
    usage.cachedInputTokens =
      (usage.cachedInputTokens ?? 0) + (value.cachedInputTokens ?? 0)
    usage.outputTokens += value.outputTokens
    usage.latencyMs += value.latencyMs
  }
}

function normalizeConfig(
  input: BenchmarkConfigInput | LegacyBenchmarkConfig,
): BenchmarkConfig {
  if (!('visits' in input)) {
    const notebookTokenBudget =
      input.notebookTokenBudget ?? DEFAULT_NOTEBOOK_TOKEN_BUDGET
    return {
      ...input,
      notebookSeed: input.notebookSeed ?? {mode: 'rules_only'},
      trainingFeedback: input.trainingFeedback ?? 'structured',
      lifeDeathProblemAttemptLimit:
        input.lifeDeathProblemAttemptLimit ??
        runtimeConfig.benchmarkProblemAttempts,
      notebookTokenBudget,
      notebookInitializationTokenLimit:
        input.notebookInitializationTokenLimit ??
        Math.max(
          DEFAULT_NOTEBOOK_INITIALIZATION_TOKEN_LIMIT,
          notebookTokenBudget,
        ),
      trainingVisits: input.trainingVisits ?? 10_000,
      evaluationVisits: input.evaluationVisits ?? 10_000,
    }
  }
  return {
    profileId: input.profileId,
    finalColor: input.finalColor,
    trainingGameCount: input.trainingGameCount,
    notebookSeed: {mode: 'refine_existing', notebookId: input.notebookId},
    trainingFeedback: input.includeTrainingWinRates ? 'structured' : 'none',
    trainingGamesWithWinRates: input.includeTrainingWinRates
      ? input.trainingGameCount
      : 0,
    trainingGamesWithoutWinRates: input.includeTrainingWinRates
      ? 0
      : input.trainingGameCount,
    lifeDeathProblemAttemptLimit: runtimeConfig.benchmarkProblemAttempts,
    notebookTokenBudget: runtimeConfig.notebookTokenBudget,
    notebookInitializationTokenLimit:
      DEFAULT_NOTEBOOK_INITIALIZATION_TOKEN_LIMIT,
    trainingVisits: input.visits,
    evaluationVisits: input.visits,
  }
}

function isLifeDeath(run: BenchmarkRun) {
  return (
    run.protocolVersion === 3 ||
    Boolean(run.config.problemSetId) ||
    run.stageKey === 'life_death_notebook'
  )
}

function isNotebookInitializationStage(stageKey?: BenchmarkStageKey) {
  return stageKey === 'life_death_notebook' || stageKey === 'ordinary_notebook'
}

function configuredTrainingGameCount(config: BenchmarkConfig) {
  if (
    config.trainingGamesWithWinRates !== undefined &&
    config.trainingGamesWithoutWinRates !== undefined
  )
    return (
      config.trainingGamesWithWinRates + config.trainingGamesWithoutWinRates
    )
  return config.trainingGameCount
}

function trainingGameHasWinRates(config: BenchmarkConfig, gameIndex: number) {
  if (config.trainingGamesWithWinRates !== undefined)
    return gameIndex < config.trainingGamesWithWinRates
  return config.trainingFeedback === 'structured'
}

function notebookVersion(
  run: InternalRun,
  sourcePhase: 'initializing_notebook' | 'reviewing_game' | 'problem_notebook',
  content: string,
): BenchmarkNotebookVersion {
  const byteCount = Buffer.byteLength(content, 'utf8')
  return {
    runId: run.id,
    version: run.notebookVersion + 1,
    sourcePhase,
    content,
    digest: createHash('sha256').update(content).digest('hex'),
    characterCount: [...content].length,
    byteCount,
    estimatedTokens: Math.ceil(byteCount / 4),
    createdAt: new Date().toISOString(),
  }
}

function scoreLeadResult(lead: number) {
  if (Math.abs(lead) < 0.05) return 'Draw'
  return `${lead > 0 ? 'B' : 'W'}+${Math.abs(lead).toFixed(1)}`
}

function problemSnapshotAt(
  problem: BenchmarkProblem,
  actions: PlayerAction[],
): GameSnapshot {
  if (!actions.length) return problem.snapshot
  const result = scoreProblemSequence(
    actions,
    problem.solution,
    problem.snapshot,
  )
  let toMove = problem.snapshot.toMove
  for (const action of actions)
    if (action.action !== 'resign') toMove = toMove === 'B' ? 'W' : 'B'
  const initialCounts = countStones(problem.snapshot.board)
  const currentCounts = countStones(result.board ?? problem.snapshot.board)
  const played = {B: 0, W: 0}
  actions.forEach((action, index) => {
    if (action.action !== 'resign')
      played[
        index % 2 === 0
          ? problem.snapshot.toMove
          : problem.snapshot.toMove === 'B'
            ? 'W'
            : 'B'
      ] += 1
  })
  return {
    ...problem.snapshot,
    board: result.board ?? problem.snapshot.board,
    toMove,
    moves: [],
    captures: {
      B:
        problem.snapshot.captures.B +
        initialCounts.W +
        played.W -
        currentCounts.W,
      W:
        problem.snapshot.captures.W +
        initialCounts.B +
        played.B -
        currentCounts.B,
    },
  }
}

function countStones(board: number[][]) {
  return board.reduce(
    (counts, row) => {
      for (const stone of row) {
        if (stone === 1) counts.B += 1
        if (stone === 2) counts.W += 1
      }
      return counts
    },
    {B: 0, W: 0},
  )
}

export function reviewCandidate(result: {moveInfos?: Array<{move: string}>}) {
  return reviewCandidateChoices(result)[0]
}

export function reviewCandidateChoices(result: {
  moveInfos?: Array<{move: string}>
}) {
  return (result.moveInfos ?? [])
    .map(({move}) => move.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((move) =>
      move.toLowerCase() === 'pass' ? 'pass' : move.toUpperCase(),
    )
}

export function formatReviewCandidates(
  review: Pick<BenchmarkMoveReview, 'topCandidate' | 'topCandidates'>,
) {
  const availableCandidates = review.topCandidates?.length
    ? review.topCandidates
    : review.topCandidate
      ? [review.topCandidate]
      : []
  const candidates = availableCandidates.slice(0, 5)
  return candidates.length
    ? candidates.map((move, index) => `#${index + 1} ${move}`).join(', ')
    : 'unavailable'
}

export function compareMoveReviews(
  a: Pick<BenchmarkMoveReview, 'pointLoss' | 'turn'>,
  b: Pick<BenchmarkMoveReview, 'pointLoss' | 'turn'>,
) {
  return b.pointLoss - a.pointLoss || a.turn - b.turn
}

export function formatBenchmarkTermination(
  termination: NonNullable<Game['benchmarkTermination']>,
) {
  return `Termination: This game ended early because you produced ${termination.actionCount} illegal actions. The final rejected action was for turn ${termination.turn}: ${termination.reason}. The outcome above is the board score at termination, not a normally completed game.`
}

function publicError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/(?:sk-|AIza)[A-Za-z0-9_-]+/g, '[redacted]')
    : 'Benchmark operation failed'
}
