import {EventEmitter} from 'node:events'
import type {Game, GameAnalysis} from '../shared/types'
import {boardHash, replay} from './go'
import type {GameService} from './games'
import {gamePosition, type KataGoAnalyzer, rootFromBlack} from './katago'
import {Store} from './database'

export class AnalysisService {
  readonly events = new EventEmitter()
  private jobs = new Map<string, AbortController>()
  private queued = new Set<string>()

  constructor(
    private store: Store,
    private games: GameService,
    readonly engine: KataGoAnalyzer,
  ) {
    games.events.on('changed', (id: string) => this.onGameChanged(id))
    for (const game of games.list()) {
      if (!game.benchmarkRunId)
        store.ensureGameAnalysis(
          game.id,
          game.analysisEnabled ?? true,
          game.shareAnalysisWithLlm ?? false,
        )
    }
  }

  get(gameId: string): GameAnalysis {
    const analysis = this.store.getGameAnalysis(gameId)
    const game = this.games.get(gameId)
    if (!game?.benchmarkRunId) return analysis

    const run = this.store.getBenchmark(game.benchmarkRunId)
    const gameIndex = game.benchmarkGameIndex ?? run?.gameIds.indexOf(gameId)
    return {
      ...analysis,
      enabled: true,
      shareWithLlm: Boolean(
        run?.config.includeTrainingWinRates &&
        gameIndex !== undefined &&
        gameIndex >= 0 &&
        gameIndex < (run?.config.trainingGameCount ?? 10),
      ),
      managedByBenchmark: true,
    }
  }

  open(gameId: string) {
    const game = this.games.get(gameId)
    if (!game) throw new Error('Game not found')
    this.store.ensureGameAnalysis(
      gameId,
      game.benchmarkRunId ? false : (game.analysisEnabled ?? true),
      game.shareAnalysisWithLlm ?? false,
    )
    const analysis = this.get(gameId)
    if (!game.benchmarkRunId && analysis.enabled) this.scheduleCurrent(gameId)
    return this.get(gameId)
  }

  update(gameId: string, values: {enabled?: boolean; shareWithLlm?: boolean}) {
    const game = this.games.get(gameId)
    if (!game) throw new Error('Game not found')
    if (game.benchmarkRunId)
      throw new Error(
        'Benchmark analysis settings are controlled by the benchmark run',
      )
    const current = this.get(gameId)
    const shareWithLlm =
      values.enabled === false
        ? false
        : (values.shareWithLlm ?? current.shareWithLlm)
    const enabled = shareWithLlm ? true : (values.enabled ?? current.enabled)
    this.store.setGameAnalysisState(gameId, {
      enabled,
      shareWithLlm,
      status: 'idle',
      error: null,
    })
    if (enabled) this.scheduleCurrent(gameId)
    else this.cancel(gameId)
    this.emit(gameId)
    return this.get(gameId)
  }

  async contextForLlm(game: Game, signal: AbortSignal) {
    const analysis = this.get(game.id)
    if (!analysis.shareWithLlm) return undefined
    this.scheduleCurrent(game.id)
    const expectedHash = positionHash(game, game.moves.length)
    while (true) {
      signal.throwIfAborted()
      const latest = this.get(game.id)
      const current = latest.positions.find(
        (value) =>
          value.turn === game.moves.length &&
          value.positionHash === expectedHash,
      )
      if (current) return formatLlmHistory(latest, game.toMove)
      if (latest.status === 'error') return undefined
      await waitForEvent(this.events, game.id, signal)
    }
  }

  backfill(gameId: string) {
    const game = this.games.get(gameId)
    if (!game) throw new Error('Game not found')
    this.store.setGameAnalysisState(gameId, {
      enabled: true,
      status: 'running',
      error: null,
    })
    this.run(game, [...Array(game.moves.length + 1).keys()])
    return this.get(gameId)
  }

  cancel(gameId: string) {
    this.jobs.get(gameId)?.abort()
    this.jobs.delete(gameId)
    this.queued.delete(gameId)
  }

  async close() {
    for (const id of [...this.jobs.keys()]) this.cancel(id)
    await this.engine.close()
  }

  private onGameChanged(id: string) {
    const game = this.games.get(id)
    if (!game) return
    this.store.deleteAnalysisAfter(id, game.moves.length)
    if (game.benchmarkRunId) {
      this.emit(id)
      return
    }
    const analysis = this.get(id)
    if (analysis.enabled) this.scheduleCurrent(id)
    this.emit(id)
  }

  private scheduleCurrent(gameId: string) {
    if (this.jobs.has(gameId)) {
      this.queued.add(gameId)
      return
    }
    const game = this.games.get(gameId)
    if (!game) return
    const existing = this.get(gameId).positions.find(
      (value) => value.turn === game.moves.length,
    )
    const expectedHash = positionHash(game, game.moves.length)
    if (existing?.positionHash === expectedHash) return
    this.run(game, [game.moves.length])
  }

  private run(game: Game, turns: number[]) {
    if (this.jobs.has(game.id)) return
    const controller = new AbortController()
    this.jobs.set(game.id, controller)
    this.store.setGameAnalysisState(game.id, {status: 'running', error: null})
    this.emit(game.id)
    void (async () => {
      try {
        const visits = this.store.getKataGoSettings().analysisVisits
        for (const turn of turns) {
          if (controller.signal.aborted) return
          const latest = this.games.get(game.id)
          if (!latest || turn > latest.moves.length) continue
          const result = await this.engine.analyze(
            {...gamePosition(latest, turn), visits},
            controller.signal,
          )
          this.store.savePositionAnalysis({
            gameId: game.id,
            turn,
            ...rootFromBlack(result),
            positionHash: positionHash(latest, turn),
            createdAt: new Date().toISOString(),
          })
          this.emit(game.id)
        }
        this.store.setGameAnalysisState(game.id, {
          status: 'complete',
          error: null,
        })
      } catch (error) {
        if (!controller.signal.aborted)
          this.store.setGameAnalysisState(game.id, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Analysis failed',
          })
      } finally {
        this.jobs.delete(game.id)
        this.emit(game.id)
        if (this.queued.delete(game.id)) this.scheduleCurrent(game.id)
      }
    })()
  }

  private emit(gameId: string) {
    this.events.emit(gameId, this.get(gameId))
  }
}

export function formatLlmHistory(analysis: GameAnalysis, color: 'B' | 'W') {
  return analysis.positions
    .map((value) => {
      const own = color === 'B' ? value.blackWinRate : value.whiteWinRate
      const opponent = color === 'B' ? value.whiteWinRate : value.blackWinRate
      return `Turn ${value.turn}: your win rate ${(own * 100).toFixed(2)}%; opponent ${(opponent * 100).toFixed(2)}%`
    })
    .join('\n')
}

function waitForEvent(
  events: EventEmitter,
  gameId: string,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      events.off(gameId, update)
      signal.removeEventListener('abort', abort)
    }
    const update = () => {
      cleanup()
      resolve()
    }
    const abort = () => {
      cleanup()
      reject(new DOMException('Analysis wait aborted', 'AbortError'))
    }
    events.once(gameId, update)
    signal.addEventListener('abort', abort, {once: true})
    if (signal.aborted) abort()
  })
}

export function positionHash(game: Pick<Game, 'size' | 'moves'>, turn: number) {
  const state = replay(game.size, game.moves.slice(0, turn))
  return `${boardHash(state.board)}:${state.toMove}`
}
