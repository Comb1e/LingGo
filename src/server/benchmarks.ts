import {createHash, randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {NoOutputGeneratedError} from 'ai'
import type {
  BenchmarkConfig,
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
  TechniqueNotebook,
} from '../shared/types'
import {coordinateToPoint} from '../shared/coordinates'
import {Store} from './database'
import {
  asciiBoard,
  boardHash,
  IllegalMoveError,
  makeSnapshot,
  replay,
} from './go'
import {GameService, MAX_MODEL_OUTPUT_ATTEMPTS} from './games'
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
  MAX_PROVIDER_API_ATTEMPTS,
  publicProviderError,
  shouldRetryProviderError,
  type ProviderRetryWait,
  waitForProviderRetry,
} from './network'
import {
  createPlayerAdapter,
  isProviderContextError,
  type LlmTurnResponse,
  MalformedModelOutputError,
  parseJsonActionResult,
} from './providers'

type InternalRun = BenchmarkRun & {
  pointLosses?: number[]
  winRateLosses?: number[]
  outputAttempts?: number
  outputRepairs?: number
  initializationContext?: {
    transcript: VisibleLlmMessage[]
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

  async create(input: BenchmarkConfig | LegacyBenchmarkConfig) {
    const config = normalizeConfig(input)
    if (
      this.reservedProfiles.has(config.profileId) ||
      this.list().some(
        (run) =>
          run.config.profileId === config.profileId &&
          ['queued', 'running', 'paused'].includes(run.status),
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
      const now = new Date().toISOString()
      const id = randomUUID()
      const run: InternalRun = {
        id,
        protocolVersion: 2,
        status: 'queued',
        phase: 'initializing_notebook',
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
        notebookEstimatedTokens: 0,
        pointLosses: [],
        winRateLosses: [],
        createdAt: now,
        updatedAt: now,
      }
      try {
        run.updatedAt = new Date().toISOString()
        this.store.saveBenchmarkWithSeed(run, sourceNotebook)
        this.emit(run)
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new BenchmarkConflictError()
        throw error
      }
      this.schedule(id)
      return run
    } finally {
      this.reservedProfiles.delete(config.profileId)
    }
  }

  pause(id: string) {
    const run = this.require(id)
    if (!['queued', 'running'].includes(run.status))
      throw new Error('Benchmark is not running')
    this.controllers.get(id)?.abort()
    run.status = 'paused'
    run.waitingFor = undefined
    run.pauseAfterLlmMove = false
    run.substate = {
      kind: 'paused',
      previous:
        run.substate.kind === 'paused' ? run.substate.previous : run.substate,
    }
    this.save(run)
    return run
  }

  resume(id: string) {
    const run = this.require(id)
    if (run.status !== 'paused' && run.status !== 'running')
      throw new Error('Benchmark cannot be resumed')
    run.status = 'running'
    run.error = undefined
    run.waitingFor = undefined
    run.pauseAfterLlmMove = false
    run.substate =
      run.substate.kind === 'paused' ? run.substate.previous : {kind: 'ready'}
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
    run.status = 'running'
    run.error = undefined
    run.waitingFor = undefined
    run.pauseAfterLlmMove = true
    if (run.substate.kind === 'paused') run.substate = run.substate.previous
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
    if (!['queued', 'running', 'paused'].includes(run.status))
      throw new Error('Benchmark has already ended')
    this.controllers.get(id)?.abort()
    run.status = 'cancelled'
    run.waitingFor = undefined
    run.pauseAfterLlmMove = false
    run.substate = {kind: 'ready'}
    this.save(run)
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
      run.status = 'invalid'
      run.error = 'A forced final-game move invalidated this benchmark.'
      run.metrics = undefined
      this.games.finishAutomated(game.id, 'Invalid')
      this.save(run)
      return run
    }
    run.status = 'running'
    run.error = undefined
    this.save(run)
    this.schedule(id)
    return run
  }

  async delete(id: string) {
    const run = this.require(id)
    if (['queued', 'running'].includes(run.status))
      this.controllers.get(id)?.abort()
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

  private schedule(id: string, delay = 0) {
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
    const controller = new AbortController()
    this.controllers.set(id, controller)
    let retry = false
    try {
      const run = this.require(id)
      if (!['queued', 'running'].includes(run.status)) return
      this.activeRuns.set(id, run)
      run.status = 'running'
      run.substate = {kind: 'ready'}
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
      }
      const trainingGameCount = configuredTrainingGameCount(run.config)
      while (run.currentGame <= trainingGameCount && run.status === 'running') {
        run.phase =
          run.currentGame < trainingGameCount ? 'training_game' : 'final_game'
        run.substate = {kind: 'ready'}
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
          run.phase = 'reviewing_game'
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
        run.phase = 'complete'
        run.substate = {kind: 'ready'}
        run.status = 'completed'
        run.metrics = calculateMetrics(
          this.games.get(run.gameIds[trainingGameCount])?.result ?? 'Void',
          run.config.finalColor,
          run.pointLosses ?? [],
          run.winRateLosses ?? [],
        )
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
            run.substate = {kind: 'waiting_katago'}
            retry = true
            this.save(run)
          } else {
            run.status = 'paused'
            run.pauseAfterLlmMove = false
            run.substate = {
              kind: 'paused',
              previous:
                run.substate.kind === 'paused'
                  ? run.substate.previous
                  : run.substate,
            }
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
      if (this.reschedule.delete(id)) this.schedule(id)
      else if (retry) this.schedule(id, 3_000)
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
          run.substate = {kind: 'waiting_credentials'}
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
        let prepared = this.games.prepareLlmActionTurn({
          gameId: game.id,
          color: llmColor,
          profile: run.profileSnapshot,
          connection,
          mode: {
            kind: 'benchmark',
            phase: promptPhase,
            notebook,
            trainingFeedback:
              phase === 'training_game' &&
              trainingGameHasWinRates(run.config, run.currentGame)
                ? 'structured'
                : 'none',
          },
          latestWinRate:
            phase === 'training_game' &&
            trainingGameHasWinRates(run.config, run.currentGame)
              ? this.latestMoveReview(run.id, run.currentGame)
              : undefined,
        })
        run.substate = {
          kind: 'provider_request',
          operation: 'move',
          attempt: 1,
          maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
        }
        this.save(run)
        this.games.setAutomatedTurnState(game.id, {
          phase: 'requesting',
          attempt: 1,
          maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
        })
        try {
          while (outputFailures < MAX_MODEL_OUTPUT_ATTEMPTS) {
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
              const managedContinuationFailed =
                prepared.context.managedContinuation &&
                Boolean(prepared.context.providerContinuationId) &&
                NoOutputGeneratedError.isInstance(error)
              if (
                !rebasedProviderContext &&
                prepared.context.providerContinuationId &&
                (isProviderContextError(error) || managedContinuationFailed)
              ) {
                rebasedProviderContext = true
                if (managedContinuationFailed)
                  this.games.disableManagedLlmContinuation(game.id, llmColor)
                else this.games.rebaseLlmContext(game.id, llmColor)
                prepared = this.games.prepareLlmActionTurn({
                  gameId: game.id,
                  color: llmColor,
                  profile: run.profileSnapshot,
                  connection,
                  mode: {
                    kind: 'benchmark',
                    phase: promptPhase,
                    notebook,
                    trainingFeedback:
                      phase === 'training_game' &&
                      trainingGameHasWinRates(run.config, run.currentGame)
                        ? 'structured'
                        : 'none',
                  },
                  latestWinRate:
                    phase === 'training_game' &&
                    trainingGameHasWinRates(run.config, run.currentGame)
                      ? this.latestMoveReview(run.id, run.currentGame)
                      : undefined,
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
                run.substate = {
                  kind: 'provider_retry',
                  operation: 'move',
                  attempt: apiFailures + 1,
                  maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
                  lastError: message,
                }
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
              if (isOccupiedMoveError(error)) {
                this.games.finishAutomated(game.id, 'Invalid')
                this.games.completeLlmContexts(game.id)
                run.status = 'invalid'
                run.error =
                  'The model attempted to play on an occupied intersection. The benchmark was invalidated.'
                run.waitingFor = undefined
                run.pauseAfterLlmMove = false
                run.substate = {kind: 'ready'}
                this.save(run)
                return false
              }
              if (outputFailures >= MAX_MODEL_OUTPUT_ATTEMPTS)
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
        } = lossFromPerspective(llmColor, before, after)
        if (phase === 'final_game') {
          ;(run.pointLosses ??= []).push(pointLoss)
          ;(run.winRateLosses ??= []).push(winRateLoss)
        }
        if (
          phase === 'final_game' ||
          trainingGameHasWinRates(run.config, run.currentGame)
        )
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
            topCandidate: reviewCandidate(beforeResult),
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
        run.substate = {kind: 'ready'}
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
        run.status = 'paused'
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
      run.substate = {kind: 'waiting_credentials'}
      this.save(run)
      return false
    }
    const seedSnapshot = this.store.getBenchmarkNotebookSeed(run.id)
    const seed = seedSnapshot?.content.trim()
      ? [
          '',
          'EXISTING NOTEBOOK TO REFINE',
          seedSnapshot.content,
          '',
          'Preserve correct, useful knowledge while improving clarity and actionability.',
        ]
      : []
    const prompt = [
      'Write a complete Markdown Go technique notebook from the authoritative rules below.',
      'Choose the organization, headings, level of detail, and writing style yourself.',
      'Do not invent lessons from games, positions, or analysis that were not supplied.',
      '',
      'AUTHORITATIVE GO RULES',
      ...formatCanonicalGoRules({size: 19, komi: 7.5}),
      ...seed,
      '',
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
    run.initializationContext = {
      transcript: [
        {role: 'user', content: prompt},
        {role: 'assistant', content},
      ],
    }
    run.phase = 'training_game'
    run.substate = {kind: 'ready'}
    run.updatedAt = version.createdAt
    this.store.saveBenchmarkNotebookVersion(run, version)
    await this.notebooks.writeRunSnapshot(run.id, content)
    this.emit(run)
    return true
  }

  private async reviewGame(run: InternalRun, signal: AbortSignal) {
    const adapter = this.adapter(run)
    if (!adapter) {
      run.waitingFor = 'credentials'
      run.substate = {kind: 'waiting_credentials'}
      this.save(run)
      return false
    }
    const game = this.currentGame(run)
    if (!game) throw new Error('Benchmark game not found')
    const color = run.currentGame % 2 === 0 ? 'B' : 'W'
    const priorNotebook = await this.runNotebook(run.id)
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
              `${index + 1}. Turn ${review.turn}: chose ${review.chosenMove}; KataGo ${review.topCandidate ?? 'unavailable'}; point loss ${review.pointLoss.toFixed(2)}; win-rate loss ${(review.winRateLoss * 100).toFixed(2)}%.`,
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
      'Update the technique notebook using only the explicit prior notebook and game review below.',
      'Generalize actionable lessons. Do not rely on conversation continuity.',
      '',
      'PRIOR NOTEBOOK',
      priorNotebook,
      '',
      'GAME REVIEW',
      `Outcome: ${perspectiveOutcome(game.result, color)}`,
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
    run.phase =
      run.currentGame < configuredTrainingGameCount(run.config)
        ? 'training_game'
        : 'final_game'
    run.substate = {kind: 'ready'}
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
      (await this.notebooks.readSnapshot(runId))
    )
  }

  private async requestValidNotebook(
    run: InternalRun,
    adapter: ReturnType<BenchmarkService['adapter']> & {},
    initialPrompt: string,
    sourcePhase: 'initializing_notebook' | 'reviewing_game',
    signal: AbortSignal,
  ) {
    let prompt = initialPrompt
    for (let invalidAttempt = 1; invalidAttempt <= 3; invalidAttempt++) {
      const operation =
        invalidAttempt === 1
          ? sourcePhase === 'reviewing_game'
            ? 'review'
            : 'initialize'
          : 'compress'
      if (invalidAttempt > 1) {
        run.substate = {
          kind: 'compressing',
          attempt: invalidAttempt,
          maxAttempts: 3,
        }
        this.save(run)
      }
      const response = await this.requestNotebookText(
        run,
        adapter,
        prompt,
        operation,
        signal,
      )
      addUsage(run, response, sourcePhase)
      const content = response.text.trim()
      const byteCount = Buffer.byteLength(content, 'utf8')
      const estimatedTokens = Math.ceil(byteCount / 4)
      if (content && estimatedTokens <= run.config.notebookTokenBudget)
        return content
      if (invalidAttempt === 3)
        throw new Error(
          content
            ? `Notebook exceeds the ${run.config.notebookTokenBudget.toLocaleString()} estimated-token budget after three attempts. The benchmark has been paused.`
            : 'The model returned an empty notebook after three attempts. The benchmark has been paused.',
        )
      prompt = content
        ? [
            `Compress the notebook below to at most ${run.config.notebookTokenBudget.toLocaleString()} estimated tokens, where estimated tokens are ceil(UTF-8 bytes / 4).`,
            'Preserve the most useful knowledge while writing a complete Markdown notebook in your own organization and style. Do not truncate it.',
            '',
            content,
            '',
            'Return only the complete compressed Markdown notebook.',
          ].join('\n')
        : [
            initialPrompt,
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
    operation: 'initialize' | 'compress' | 'review',
    signal: AbortSignal,
  ) {
    if (!adapter.requestText)
      throw new Error(
        'The benchmark provider does not support notebook generation',
      )
    let lastError = ''
    for (let attempt = 1; attempt <= MAX_PROVIDER_API_ATTEMPTS; attempt++) {
      run.substate =
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
            }
      this.save(run)
      try {
        return await adapter.requestText(prompt, signal)
      } catch (error) {
        if (signal.aborted) throw error
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
      `KataGo's top candidate in the position immediately before that move: ${review.topCandidate ?? 'unavailable'}.`,
      `Point loss: ${review.pointLoss.toFixed(2)}; win-rate loss: ${(review.winRateLoss * 100).toFixed(2)}%.`,
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
    this.store.setGameAnalysisState(game.id, {status: 'complete', error: null})
    return result
  }

  private currentGame(run: InternalRun) {
    const id = run.gameIds[run.currentGame]
    return id ? this.games.get(id) : undefined
  }

  private require(id: string) {
    const run = this.get(id) as InternalRun | undefined
    if (!run) throw new Error('Benchmark not found')
    return run
  }

  private save(run: InternalRun) {
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
    error instanceof NoOutputGeneratedError
  )
}

function isOccupiedMoveError(error: unknown) {
  return (
    error instanceof IllegalMoveError &&
    error.message === 'Intersection is occupied'
  )
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
) {
  const beforeScore =
    color === 'B' ? before.blackScoreLead : -before.blackScoreLead
  const afterScore =
    color === 'B' ? after.blackScoreLead : -after.blackScoreLead
  const beforeWin = color === 'B' ? before.blackWinRate : before.whiteWinRate
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
    phase === 'final_game'
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
  input: BenchmarkConfig | LegacyBenchmarkConfig,
): BenchmarkConfig {
  if ('notebookSeed' in input) return input
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
    notebookTokenBudget: 8000,
    trainingVisits: input.visits,
    evaluationVisits: input.visits,
  }
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
  sourcePhase: 'initializing_notebook' | 'reviewing_game',
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

export function reviewCandidate(result: {moveInfos?: Array<{move: string}>}) {
  const move = result.moveInfos?.[0]?.move
  return move ? (move.toLowerCase() === 'pass' ? 'pass' : move) : undefined
}

export function compareMoveReviews(
  a: Pick<BenchmarkMoveReview, 'pointLoss' | 'turn'>,
  b: Pick<BenchmarkMoveReview, 'pointLoss' | 'turn'>,
) {
  return b.pointLoss - a.pointLoss || a.turn - b.turn
}

function publicError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/(?:sk-|AIza)[A-Za-z0-9_-]+/g, '[redacted]')
    : 'Benchmark operation failed'
}
