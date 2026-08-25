import {createHash, randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import type {
  BenchmarkConfig,
  BenchmarkMetrics,
  BenchmarkRun,
  Color,
  Game,
  PlayerAction,
  PositionAnalysis,
} from '../shared/types'
import {coordinateToPoint} from '../shared/coordinates'
import {Store} from './database'
import {boardHash, makeSnapshot, replay} from './go'
import {GameService} from './games'
import {gamePosition, rootFromBlack, selectedMove, type KataGoAnalyzer} from './katago'
import {NotebookStore} from './notebooks'
import {createPlayerAdapter, makeBenchmarkMovePrompt, makeReflectionPrompt} from './providers'

type InternalRun = BenchmarkRun & {pointLosses?: number[]; winRateLosses?: number[]}

class KataGoUnavailableError extends Error {}

export class BenchmarkService {
  readonly events = new EventEmitter()
  private scheduled = new Set<string>()
  private controllers = new Map<string, AbortController>()

  constructor(
    readonly store: Store,
    readonly games: GameService,
    readonly engine: KataGoAnalyzer,
    readonly notebooks = new NotebookStore(),
    private readonly adapterFactory: typeof createPlayerAdapter = createPlayerAdapter,
  ) {
    for (const run of this.store.listBenchmarks())
      if (run.status === 'queued' || run.status === 'running') this.schedule(run.id)
  }

  list() {
    return this.store.listBenchmarks()
  }

  get(id: string) {
    return this.store.getBenchmark(id)
  }

  async create(config: BenchmarkConfig) {
    if (this.list().some((run) => ['queued', 'running', 'paused'].includes(run.status)))
      throw new Error('Only one active or paused benchmark is allowed')
    const profile = this.store.getProfile(config.profileId)
    if (!profile) throw new Error('Player profile not found')
    const connection = this.store.getConnection(profile.connectionId)
    if (!connection) throw new Error('Provider connection not found')
    const health = this.engine.healthCheck
      ? await this.engine.healthCheck()
      : await healthFromAnalysis(this.engine)
    if (!health.ok) throw new Error(`KataGo is unavailable: ${health.message}`)
    const now = new Date().toISOString()
    const id = randomUUID()
    if (config.notebookMode === 'reset') await this.notebooks.deleteCurrent(profile.id)
    const run: InternalRun = {
      id,
      status: 'queued',
      phase: 'training',
      config,
      profileSnapshot: {...profile},
      modelFingerprint: createHash('sha256').update(JSON.stringify({profile, connection})).digest('hex'),
      currentGame: 0,
      currentTurn: 0,
      gameIds: [],
      usage: {calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0},
      notebook: {profileId: profile.id, currentUrl: `/api/profiles/${profile.id}/notebook.md`, snapshotUrl: `/api/benchmarks/${id}/notebook.md`},
      pointLosses: [],
      winRateLosses: [],
      createdAt: now,
      updatedAt: now,
    }
    this.save(run)
    this.schedule(id)
    return run
  }

  pause(id: string) {
    const run = this.require(id)
    if (!['queued', 'running'].includes(run.status)) throw new Error('Benchmark is not running')
    this.controllers.get(id)?.abort()
    run.status = 'paused'
    run.waitingFor = undefined
    this.save(run)
    return run
  }

  resume(id: string) {
    const run = this.require(id)
    if (run.status !== 'paused' && run.status !== 'running') throw new Error('Benchmark cannot be resumed')
    run.status = 'running'
    run.error = undefined
    run.waitingFor = undefined
    this.save(run)
    this.schedule(id)
    return run
  }

  resumeWaiting() {
    for (const run of this.list()) if (run.status === 'running' && run.waitingFor) this.schedule(run.id)
  }

  cancel(id: string) {
    const run = this.require(id)
    if (!['queued', 'running', 'paused'].includes(run.status)) throw new Error('Benchmark has already ended')
    this.controllers.get(id)?.abort()
    run.status = 'cancelled'
    run.waitingFor = undefined
    this.save(run)
    return run
  }

  async force(id: string, action: PlayerAction) {
    const run = this.require(id)
    if (run.status !== 'paused') throw new Error('Pause the benchmark before forcing a move')
    const game = this.currentGame(run)
    if (!game) throw new Error('Benchmark game not found')
    this.games.acceptAutomated(game.id, action, undefined, true)
    if (run.currentGame === 10) {
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
    if (['queued', 'running'].includes(run.status)) this.controllers.get(id)?.abort()
    const deleted = this.store.deleteBenchmark(id)
    await this.notebooks.deleteSnapshot(id)
    this.events.emit(id, null)
    return deleted
  }

  async close() {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  private schedule(id: string, delay = 0) {
    if (this.scheduled.has(id)) return
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
      run.status = 'running'
      run.waitingFor = undefined
      run.error = undefined
      this.save(run)
      while (run.currentGame < 11 && run.status === 'running') {
        run.phase = run.currentGame < 10 ? 'training' : 'final'
        const llmColor = run.currentGame < 10
          ? (run.currentGame % 2 === 0 ? 'B' : 'W')
          : run.config.finalColor
        const game = this.ensureGame(run, llmColor)
        const completed = await this.playGame(run, game, llmColor, controller.signal)
        if (!completed) {
          retry = Boolean(run.waitingFor)
          return
        }
        if (run.currentGame < 10) {
          run.phase = 'reflection'
          this.save(run)
          const reflected = await this.reflect(run, controller.signal)
          if (!reflected) {
            retry = Boolean(run.waitingFor)
            return
          }
        }
        run.currentGame += 1
        run.currentTurn = 0
        this.save(run)
      }
      if (run.status === 'running') {
        run.phase = 'complete'
        run.status = 'completed'
        run.metrics = calculateMetrics(
          this.games.get(run.gameIds[10])?.result ?? 'Void',
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
          } else {
            run.status = 'paused'
          }
          this.save(run)
        }
      }
    } finally {
      this.controllers.delete(id)
      this.scheduled.delete(id)
      if (retry) this.schedule(id, 3_000)
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

  private async playGame(run: InternalRun, original: Game, llmColor: Color, signal: AbortSignal) {
    let game = this.games.get(original.id)!
    while (run.status === 'running' && game.status !== 'finished') {
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
        const notebook = await this.notebooks.readCurrent(run.config.profileId)
        const snapshot = makeSnapshot(game.size, game.komi, game.moves)
        const prompt = makeBenchmarkMovePrompt(snapshot, notebook, {
          phase: run.currentGame < 10 ? 'training' : 'final',
          winRateHistory: run.currentGame < 10 && run.config.includeTrainingWinRates
            ? this.winRateHistory(game.id, llmColor)
            : undefined,
        })
        const response = await adapter.requestAction(snapshot, signal, prompt)
        addUsage(run, response)
        game = this.games.acceptAutomated(game.id, response.action, response)
        const afterResult = await this.analyze(game, run.config.visits, signal)
        if (run.currentGame === 10) {
          const after = rootFromBlack(afterResult)
          const beforeScore = llmColor === 'B' ? before.blackScoreLead : -before.blackScoreLead
          const afterScore = llmColor === 'B' ? after.blackScoreLead : -after.blackScoreLead
          const beforeWin = llmColor === 'B' ? before.blackWinRate : before.whiteWinRate
          const afterWin = llmColor === 'B' ? after.blackWinRate : after.whiteWinRate
          ;(run.pointLosses ??= []).push(Math.max(0, beforeScore - afterScore))
          ;(run.winRateLosses ??= []).push(Math.max(0, beforeWin - afterWin))
        }
      } else {
        const move = selectedMove(beforeResult)
        const action: PlayerAction = move === 'pass'
          ? {action: 'pass', comment: 'KataGo passed.'}
          : {action: 'play', coordinate: move, comment: 'KataGo move.'}
        if (action.action === 'play') coordinateToPoint(action.coordinate, game.size)
        game = this.games.acceptAutomated(game.id, action)
      }
      run.currentTurn = game.moves.length
      this.save(run)
      const endedWithoutResignation =
        game.status === 'finished' && game.moves.at(-1)?.action !== 'resign'
      if (game.status === 'scoring' || endedWithoutResignation || (game.status === 'paused' && game.moves.length >= 722)) {
        const final = await this.analyze(game, run.config.visits, signal)
        const lead = rootFromBlack(final).blackScoreLead
        game = this.games.finishAutomated(game.id, scoreLeadResult(lead))
      }
    }
    return game.status === 'finished'
  }

  private async reflect(run: InternalRun, signal: AbortSignal) {
    const adapter = this.adapter(run)
    if (!adapter?.requestText) {
      run.waitingFor = 'credentials'
      this.save(run)
      return false
    }
    const notebook = await this.notebooks.readCurrent(run.config.profileId)
    const response = await adapter.requestText(makeReflectionPrompt({
      notebook,
      games: run.gameIds.slice(0, run.currentGame + 1).map((gameId, index) => {
        const game = this.games.get(gameId)
        if (!game) throw new Error(`Training game ${index + 1} is missing`)
        const llmColor: Color = index % 2 === 0 ? 'B' : 'W'
        return {
          sequence: index + 1,
          snapshot: makeSnapshot(game.size, game.komi, game.moves),
          result: game.result ?? 'Unknown',
          llmColor,
          winRateHistory: run.config.includeTrainingWinRates
            ? this.winRateHistory(game.id, llmColor)
            : undefined,
        }
      }),
    }), signal)
    addUsage(run, response)
    await this.notebooks.write(run.config.profileId, run.id, response.text.trim())
    run.notebook.updatedAt = new Date().toISOString()
    this.save(run)
    return true
  }

  private adapter(run: InternalRun) {
    const connection = this.store.getConnection(run.profileSnapshot.connectionId)
    if (!connection) throw new Error('The benchmark provider connection no longer exists')
    if (connection.kind !== 'fake' && !this.games.vault.get(connection)) return undefined
    return this.adapterFactory(connection, run.profileSnapshot, this.games.vault)
  }

  private async analyze(game: Game, visits: number, signal: AbortSignal) {
    let result
    try {
      result = await this.engine.analyze({...gamePosition(game), visits, priority: 50}, signal)
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

  private winRateHistory(gameId: string, color: Color) {
    return this.store.getGameAnalysis(gameId).positions.map((value) => {
      const rate = color === 'B' ? value.blackWinRate : value.whiteWinRate
      return `Turn ${value.turn}: ${(rate * 100).toFixed(2)}%`
    }).join('\n')
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

export function pointLossQuality(loss: number) {
  if (loss <= 0.5) return 100
  if (loss <= 1.5) return 85
  if (loss <= 3) return 65
  if (loss <= 6) return 40
  if (loss <= 12) return 15
  return 0
}

export function calculateMetrics(result: string, color: Color, pointLosses: number[], winRateLosses: number[]): BenchmarkMetrics {
  const winner = result.startsWith('B+') ? 'B' : result.startsWith('W+') ? 'W' : undefined
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
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function addUsage(run: InternalRun, value: {inputTokens: number; outputTokens: number; latencyMs: number}) {
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
    const result = await engine.analyze({size: 9, komi: 7.5, moves: [], visits: 25})
    return {ok: true, message: 'KataGo is ready', winRate: result.rootInfo.winrate, scoreLead: result.rootInfo.scoreLead}
  } catch (error) {
    return {ok: false, message: publicError(error)}
  }
}

function publicError(error: unknown) {
  return error instanceof Error ? error.message.replace(/(?:sk-|AIza)[A-Za-z0-9_-]+/g, '[redacted]') : 'Benchmark operation failed'
}
