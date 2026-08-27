import {createHash, randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {NoOutputGeneratedError} from 'ai'
import type {
  BenchmarkConfig,
  BenchmarkMetrics,
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
import {boardHash, IllegalMoveError, replay} from './go'
import {GameService} from './games'
import {
  gamePosition,
  rootFromBlack,
  selectedMove,
  type KataGoAnalyzer,
} from './katago'
import {NotebookStore} from './notebooks'
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

  async create(config: BenchmarkConfig) {
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
      const notebook = await this.selectedNotebook(config)
      const health = this.engine.healthCheck
        ? await this.engine.healthCheck()
        : await healthFromAnalysis(this.engine)
      if (!health.ok)
        throw new Error(`KataGo is unavailable: ${health.message}`)
      const now = new Date().toISOString()
      const id = randomUUID()
      const run: InternalRun = {
        id,
        status: 'queued',
        phase: 'training',
        config,
        profileSnapshot: {...profile},
        modelFingerprint: createHash('sha256')
          .update(JSON.stringify({profile, connection}))
          .digest('hex'),
        currentGame: 0,
        currentTurn: 0,
        gameIds: [],
        usage: {calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0},
        notebook: {
          profileId: profile.id,
          notebookId: notebook.id,
          name: notebook.name,
          currentUrl: `/api/profiles/${profile.id}/notebooks/${notebook.id}.md`,
          snapshotUrl: `/api/benchmarks/${id}/notebook.md`,
        },
        pointLosses: [],
        winRateLosses: [],
        createdAt: now,
        updatedAt: now,
      }
      try {
        if (this.notebooks.store) {
          run.updatedAt = new Date().toISOString()
          this.store.saveBenchmarkWithSnapshot(run, notebook)
          this.events.emit(run.id, run)
          this.events.emit('changed', run.id)
        } else this.save(run)
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
    if (run.currentGame === run.config.trainingGameCount) {
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
      run.waitingFor = undefined
      run.error = undefined
      this.save(run)
      const trainingGameCount = run.config.trainingGameCount
      while (run.currentGame <= trainingGameCount && run.status === 'running') {
        run.phase = run.currentGame < trainingGameCount ? 'training' : 'final'
        const llmColor =
          run.currentGame < trainingGameCount
            ? run.currentGame % 2 === 0
              ? 'B'
              : 'W'
            : run.config.finalColor
        const game = this.ensureGame(run, llmColor)
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
          run.phase = 'reflection'
          this.save(run)
          const reflected = await this.reflect(run, controller.signal)
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
        run.status = 'completed'
        run.metrics = calculateMetrics(
          this.games.get(run.gameIds[trainingGameCount])?.result ?? 'Void',
          run.config.finalColor,
          run.pointLosses ?? [],
          run.winRateLosses ?? [],
        )
        this.save(run)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const run = this.get(id) as InternalRun | undefined
        if (run && run.status === 'running') {
          run.error = publicError(error)
          if (error instanceof KataGoUnavailableError) {
            run.waitingFor = 'katago'
            retry = true
            this.save(run)
          } else {
            run.status = 'paused'
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
    this.store.linkBenchmarkGame(run.id, game.id, run.currentGame)
    this.save(run)
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
      const beforeResult = await this.analyze(game, run.config.visits, signal)
      const before = rootFromBlack(beforeResult)
      if (game.toMove === llmColor) {
        const adapter = this.adapter(run)
        if (!adapter) {
          run.waitingFor = 'credentials'
          this.save(run)
          return false
        }
        const connection = this.connection(run)
        const notebook = (await this.selectedNotebook(run.config)).content
        let outputFailures = 0
        let apiFailures = 0
        let rebasedProviderContext = false
        const retryErrors = [...(game.providerErrors ?? [])]
        const phase =
          run.currentGame < run.config.trainingGameCount ? 'training' : 'final'
        let prepared = this.games.prepareLlmActionTurn({
          gameId: game.id,
          color: llmColor,
          profile: run.profileSnapshot,
          connection,
          mode: {kind: 'benchmark', phase, notebook},
          latestWinRate:
            phase === 'training' && run.config.includeTrainingWinRates
              ? this.winRateUpdate(game.id, llmColor)
              : undefined,
        })
        this.games.setAutomatedTurnState(game.id, {
          phase: 'requesting',
          attempt: 1,
          maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
        })
        try {
          while (outputFailures < 3) {
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
                outputTokens: turnResponse.outputTokens,
                model: turnResponse.model,
                providerKind: turnResponse.providerKind,
                retries: 0,
              }
              addUsage(run, response)
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
                  mode: {kind: 'benchmark', phase, notebook},
                  latestWinRate:
                    phase === 'training' && run.config.includeTrainingWinRates
                      ? this.winRateUpdate(game.id, llmColor)
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
              const feedback = publicProviderError(error, 'Invalid action')
              if (outputFailures >= 3)
                throw new Error(
                  `Model failed to produce a legal action after 3 attempts: ${feedback}`,
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
        const afterResult = await this.analyze(game, run.config.visits, signal)
        if (run.currentGame === run.config.trainingGameCount) {
          const after = rootFromBlack(afterResult)
          const beforeScore =
            llmColor === 'B' ? before.blackScoreLead : -before.blackScoreLead
          const afterScore =
            llmColor === 'B' ? after.blackScoreLead : -after.blackScoreLead
          const beforeWin =
            llmColor === 'B' ? before.blackWinRate : before.whiteWinRate
          const afterWin =
            llmColor === 'B' ? after.blackWinRate : after.whiteWinRate
          ;(run.pointLosses ??= []).push(Math.max(0, beforeScore - afterScore))
          ;(run.winRateLosses ??= []).push(Math.max(0, beforeWin - afterWin))
        }
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
        const final = await this.analyze(game, run.config.visits, signal)
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

  private async reflect(run: InternalRun, signal: AbortSignal) {
    const adapter = this.adapter(run)
    if (!adapter) {
      run.waitingFor = 'credentials'
      this.save(run)
      return false
    }
    const notebook = await this.selectedNotebook(run.config)
    const game = this.currentGame(run)
    if (!game) throw new Error('Benchmark game not found')
    const color = run.currentGame % 2 === 0 ? 'B' : 'W'
    const connection = this.connection(run)
    let prepared = this.games.prepareLlmReflectionTurn({
      gameId: game.id,
      color,
      profile: run.profileSnapshot,
      connection,
    })
    const response = await this.requestReflection(
      game.id,
      () => this.games.requestPreparedLlmTurn(adapter, prepared, signal),
      (error) =>
        isProviderContextError(error) ||
        (prepared.context.managedContinuation &&
          Boolean(prepared.context.providerContinuationId) &&
          NoOutputGeneratedError.isInstance(error)),
      (error) => {
        if (NoOutputGeneratedError.isInstance(error))
          this.games.disableManagedLlmContinuation(game.id, color)
        else this.games.rebaseLlmContext(game.id, color)
        prepared = this.games.prepareLlmReflectionTurn({
          gameId: game.id,
          color,
          profile: run.profileSnapshot,
          connection,
        })
      },
      signal,
    )
    addUsage(run, response)
    run.notebook.updatedAt = new Date().toISOString()
    run.currentGame += 1
    run.currentTurn = 0
    run.phase =
      run.currentGame < run.config.trainingGameCount ? 'training' : 'final'
    run.updatedAt = run.notebook.updatedAt
    const completedContext = this.games.completedLlmContext(
      prepared,
      response,
      'complete',
      game.moves.length,
    )
    if (this.notebooks.store)
      this.store.saveReflectionWithContext(
        notebook,
        run,
        response.text.trim(),
        completedContext,
      )
    else {
      await this.notebooks.saveReflection(notebook, run, response.text.trim())
      this.store.transaction(() => {
        this.store.saveBenchmark(run)
        this.store.saveLlmGameContext(completedContext)
      })
    }
    this.events.emit(run.id, run)
    this.events.emit('changed', run.id)
    return true
  }

  private async selectedNotebook(
    config: BenchmarkConfig,
  ): Promise<TechniqueNotebook> {
    const notebook = this.notebooks.get(config.profileId, config.notebookId)
    if (notebook) return notebook
    if (!this.notebooks.store) {
      const content = await this.notebooks.readCurrent(config.profileId)
      return {
        id: config.notebookId,
        profileId: config.profileId,
        name: 'Default',
        content,
        createdAt: '',
        updatedAt: '',
      }
    }
    throw new Error('Technique notebook not found for this player profile')
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

  private async requestReflection(
    gameId: string,
    request: () => Promise<LlmTurnResponse>,
    shouldRebase: (error: unknown) => boolean,
    rebase: (error: unknown) => void,
    signal: AbortSignal,
  ) {
    let lastError = ''
    let rebasedProviderContext = false
    try {
      for (let attempt = 1; attempt <= MAX_PROVIDER_API_ATTEMPTS; attempt++) {
        this.games.setAutomatedTurnState(
          gameId,
          attempt === 1
            ? {
                phase: 'requesting',
                attempt,
                maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
              }
            : {
                phase: 'retrying',
                attempt,
                maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
                lastError,
              },
        )
        try {
          return await request()
        } catch (error) {
          if (signal.aborted) throw error
          if (!rebasedProviderContext && shouldRebase(error)) {
            rebasedProviderContext = true
            rebase(error)
            attempt -= 1
            continue
          }
          lastError = publicProviderError(error)
          if (
            !shouldRetryProviderError(error) ||
            attempt >= MAX_PROVIDER_API_ATTEMPTS
          )
            throw new Error(
              `LLM API request failed after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'} during reflection. The benchmark has been paused. Last error: ${lastError}`,
              {cause: error},
            )
          await this.retryWait(attempt, signal, error)
        }
      }
      throw new Error('Reflection request failed')
    } finally {
      this.games.clearAutomatedTurnState(gameId)
    }
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

  private winRateUpdate(gameId: string, color: Color) {
    const value = this.store.getGameAnalysis(gameId).positions.at(-1)
    if (!value) return ''
    const rate = color === 'B' ? value.blackWinRate : value.whiteWinRate
    return `Turn ${value.turn}: ${(rate * 100).toFixed(2)}%`
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

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

function addUsage(
  run: InternalRun,
  value: {inputTokens: number; outputTokens: number; latencyMs: number},
) {
  run.usage.calls += 1
  run.usage.inputTokens += value.inputTokens
  run.usage.outputTokens += value.outputTokens
  run.usage.latencyMs += value.latencyMs
}

function scoreLeadResult(lead: number) {
  if (Math.abs(lead) < 0.05) return 'Draw'
  return `${lead > 0 ? 'B' : 'W'}+${Math.abs(lead).toFixed(1)}`
}

async function healthFromAnalysis(engine: KataGoAnalyzer) {
  try {
    const result = await engine.analyze({
      size: 9,
      komi: 7.5,
      moves: [],
      visits: 25,
    })
    return {
      ok: true,
      message: 'KataGo is ready',
      winRate: result.rootInfo.winrate,
      scoreLead: result.rootInfo.scoreLead,
    }
  } catch (error) {
    return {ok: false, message: publicError(error)}
  }
}

function publicError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/(?:sk-|AIza)[A-Za-z0-9_-]+/g, '[redacted]')
    : 'Benchmark operation failed'
}
