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

  constructor(private store: Store, private games: GameService, readonly engine: KataGoAnalyzer) {
    games.events.on('changed', (id: string) => this.onGameChanged(id))
  }

  get(gameId: string): GameAnalysis {
    return this.store.getGameAnalysis(gameId)
  }

  setEnabled(gameId: string, enabled: boolean) {
    if (!this.games.get(gameId)) throw new Error('Game not found')
    this.store.setGameAnalysisState(gameId, {enabled, status: enabled ? 'idle' : 'idle', error: null})
    if (enabled) this.scheduleCurrent(gameId)
    else this.cancel(gameId)
    this.emit(gameId)
    return this.get(gameId)
  }

  backfill(gameId: string) {
    const game = this.games.get(gameId)
    if (!game) throw new Error('Game not found')
    this.store.setGameAnalysisState(gameId, {enabled: true, status: 'running', error: null})
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
    const existing = this.get(gameId).positions.find((value) => value.turn === game.moves.length)
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
          const state = replay(latest.size, latest.moves.slice(0, turn))
          const result = await this.engine.analyze({...gamePosition(latest, turn), visits}, controller.signal)
          this.store.savePositionAnalysis({
            gameId: game.id,
            turn,
            ...rootFromBlack(result, state.toMove),
            positionHash: positionHash(latest, turn),
            createdAt: new Date().toISOString(),
          })
          this.emit(game.id)
        }
        this.store.setGameAnalysisState(game.id, {status: 'complete', error: null})
      } catch (error) {
        if (!controller.signal.aborted)
          this.store.setGameAnalysisState(game.id, {status: 'error', error: error instanceof Error ? error.message : 'Analysis failed'})
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

export function positionHash(game: Pick<Game, 'size' | 'moves'>, turn: number) {
  const state = replay(game.size, game.moves.slice(0, turn))
  return `${boardHash(state.board)}:${state.toMove}`
}
