import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {NoOutputGeneratedError} from 'ai'
import {coordinateToPoint, pointToCoordinate} from '../shared/coordinates'
import type {
  Color,
  Game,
  LlmActionResult,
  Move,
  NewGameInput,
  PlayerAction,
} from '../shared/types'
import {commandSchema, newGameSchema} from '../shared/types'
import {Store} from './database'
import {
  IllegalMoveError,
  makeSnapshot,
  opposite,
  playStone,
  replay,
  scoreBoard,
  toggleDeadChain,
} from './go'
import {
  createPlayerAdapter,
  MalformedModelOutputError,
  SecretVault,
} from './providers'
import type {ImportedRecord} from './sgf'

export class StaleVersionError extends Error {
  constructor() {
    super('Game changed since this view was loaded')
    this.name = 'StaleVersionError'
  }
}

export class GameService {
  readonly events = new EventEmitter()
  readonly vault = new SecretVault()
  private controllers = new Map<string, AbortController>()
  private scheduled = new Set<string>()

  constructor(readonly store: Store) {}

  list() {
    return this.store.listGames().map((game) => this.withPending(game))
  }

  get(id: string) {
    const game = this.store.getGame(id)
    return game ? this.withPending(game) : undefined
  }

  delete(id: string) {
    if (!this.store.getGame(id)) return false
    this.cancel(id)
    this.store.deleteGame(id)
    this.events.emit(id, null)
    return true
  }

  updateDetails(
    id: string,
    input: {
      expectedVersion: number
      blackName: string
      whiteName: string
      commentsVisible: boolean
      moveCap: number
    },
  ) {
    const game = this.requireGame(id)
    if (game.version !== input.expectedVersion) throw new StaleVersionError()
    if (input.moveCap < game.moves.length)
      throw new Error('Move cap cannot be lower than the current move count')
    game.black = {...game.black, name: input.blackName}
    game.white = {...game.white, name: input.whiteName}
    game.commentsVisible = input.commentsVisible
    game.moveCap = input.moveCap
    return this.commit(game)
  }

  create(input: NewGameInput): Game {
    const values = newGameSchema.parse(input)
    const now = new Date().toISOString()
    const game: Game = {
      id: randomUUID(),
      version: 0,
      size: values.size,
      komi: values.komi,
      board: replay(values.size, []).board,
      toMove: 'B',
      status: 'active',
      black: values.black,
      white: values.white,
      moves: [],
      captures: {B: 0, W: 0},
      commentsVisible: values.commentsVisible,
      autoplay: true,
      moveCap: values.moveCap ?? values.size * values.size * 2,
      dead: [],
      approvals: [],
      createdAt: now,
      updatedAt: now,
    }
    this.save(game)
    this.schedule(game.id)
    return game
  }

  importRecord(record: ImportedRecord): Game {
    const game = this.create({
      size: record.size,
      komi: record.komi,
      black: {type: 'human', name: record.blackName},
      white: {type: 'human', name: record.whiteName},
      commentsVisible: true,
    })
    game.moves = record.moves
    game.result = record.result
    game.status = record.result ? 'finished' : 'active'
    game.autoplay = false
    this.refreshPosition(game)
    return this.commit(game)
  }

  async command(id: string, rawCommand: unknown): Promise<Game> {
    const command = commandSchema.parse(rawCommand)
    const game = this.requireGame(id)
    if (game.version !== command.expectedVersion) throw new StaleVersionError()

    if (command.type === 'pause') {
      this.cancel(id)
      game.status = 'paused'
      game.autoplay = false
      return this.commit(game)
    }
    if (command.type === 'resume' || command.type === 'retry') {
      game.status = 'active'
      game.error = undefined
      game.autoplay = true
      const saved = this.commit(game)
      this.schedule(id)
      return saved
    }
    if (command.type === 'undo') {
      if (!['active', 'paused', 'error'].includes(game.status))
        throw new Error('Undo is available only during active play')
      if (!game.moves.length) throw new Error('There is no move to undo')
      this.cancel(id)
      game.moves.pop()
      game.status = 'active'
      game.error = undefined
      game.autoplay = false
      this.refreshPosition(game)
      return this.commit(game)
    }
    if (command.type === 'toggle-dead') {
      if (game.status !== 'scoring' || !command.coordinate)
        throw new Error('Dead groups can only be edited during scoring')
      game.dead = toggleDeadChain(
        game.board as any,
        game.dead,
        command.coordinate,
        game.size,
      )
      game.approvals = this.automaticApprovals(game)
      return this.commit(game)
    }
    if (command.type === 'resume-play') {
      if (game.status !== 'scoring') throw new Error('Game is not in scoring')
      game.status = 'active'
      game.dead = []
      game.approvals = []
      game.operatorConfirmationRequired = false
      game.autoplay = false
      return this.commit(game)
    }
    if (command.type === 'approve-score') {
      if (game.status !== 'scoring') throw new Error('Game is not in scoring')
      if (
        game.operatorConfirmationRequired &&
        game.approvals.includes('B') &&
        game.approvals.includes('W')
      ) {
        game.operatorConfirmationRequired = false
      } else {
        if (!command.color) throw new Error('A seat color is required')
        const seat = command.color === 'B' ? game.black : game.white
        if (seat.type !== 'human')
          throw new Error('That seat does not require human approval')
        if (!game.approvals.includes(command.color))
          game.approvals.push(command.color)
      }
      this.finishScoreIfApproved(game)
      return this.commit(game)
    }
    if (command.type === 'change-profile') {
      if (!command.color || !command.profileId)
        throw new Error('Color and profile are required')
      if (!this.store.getProfile(command.profileId))
        throw new Error('Profile not found')
      const key = command.color === 'B' ? 'black' : 'white'
      game[key] = {
        type: 'llm',
        name: this.store.getProfile(command.profileId)!.name,
        profileId: command.profileId,
      }
      game.status = 'active'
      game.error = undefined
      const saved = this.commit(game)
      this.schedule(id)
      return saved
    }
    if (command.type === 'set-comments') {
      if (command.visible === undefined)
        throw new Error('Comment visibility is required')
      game.commentsVisible = command.visible
      return this.commit(game)
    }

    if (command.type === 'force-pass') {
      game.status = 'active'
      game.error = undefined
      game.autoplay = false
      return this.accept(game, {
        action: 'pass',
        comment: 'Operator forced a pass.',
      })
    }
    if (command.type === 'resign' && game.status === 'error') {
      game.status = 'active'
      game.error = undefined
      game.autoplay = false
      return this.accept(game, {
        action: 'resign',
        comment: 'Operator resigned this seat.',
      })
    }
    this.assertHumanTurn(game)
    if (command.type === 'play') {
      if (!command.coordinate) throw new Error('Coordinate is required')
      return this.accept(game, {
        action: 'play',
        coordinate: command.coordinate,
        comment: '',
      })
    }
    if (command.type === 'pass')
      return this.accept(game, {action: 'pass', comment: ''})
    if (command.type === 'resign')
      return this.accept(game, {action: 'resign', comment: ''})
    throw new Error('Unsupported command')
  }

  restoreAutoplay() {
    for (const game of this.store.listGames()) {
      if (
        game.status === 'active' &&
        game.autoplay &&
        this.hasCredentialsForCurrentSeat(game)
      )
        this.schedule(game.id)
    }
  }

  cancel(id: string) {
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    this.scheduled.delete(id)
  }

  private accept(
    game: Game,
    action: PlayerAction,
    llm?: LlmActionResult,
  ): Game {
    if (game.status !== 'active') throw new Error('Game is not active')
    const color = game.toMove
    const state = replay(game.size, game.moves)
    let captured = 0
    let point
    if (action.action === 'play') {
      point = coordinateToPoint(action.coordinate, game.size)
      const result = playStone(state.board, color, point, state.hashes)
      captured = result.captured
    }
    const move: Move = {
      number: game.moves.length + 1,
      color,
      action: action.action,
      point,
      coordinate: point ? pointToCoordinate(point, game.size) : undefined,
      comment: action.comment,
      reasoning: llm?.reasoning,
      captured,
      latencyMs: llm?.latencyMs,
      inputTokens: llm?.inputTokens,
      outputTokens: llm?.outputTokens,
      model: llm?.model,
      retries: llm?.retries,
    }
    game.moves.push(move)
    this.refreshPosition(game)

    if (action.action === 'resign') {
      game.status = 'finished'
      game.result = `${opposite(color)}+R`
      game.autoplay = false
    } else if (replay(game.size, game.moves).consecutivePasses >= 2) {
      game.status = 'scoring'
      game.dead = []
      game.approvals = this.automaticApprovals(game)
      game.operatorConfirmationRequired =
        game.black.type === 'llm' && game.white.type === 'llm'
      game.autoplay = false
      this.finishScoreIfApproved(game)
    } else if (game.moves.length >= game.moveCap) {
      game.status = 'paused'
      game.error = `Move cap of ${game.moveCap} reached`
      game.autoplay = false
    }

    const saved = this.commit(game)
    this.schedule(game.id)
    return saved
  }

  private schedule(id: string) {
    if (this.scheduled.has(id)) return
    const game = this.store.getGame(id)
    if (
      !game ||
      game.status !== 'active' ||
      !game.autoplay ||
      this.seat(game).type !== 'llm'
    )
      return
    this.scheduled.add(id)
    queueMicrotask(() => void this.runModelTurn(id))
  }

  private async runModelTurn(id: string) {
    const controller = new AbortController()
    this.controllers.set(id, controller)
    this.emit(id)
    try {
      let feedback = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        const game = this.requireGame(id)
        if (game.status !== 'active' || !game.autoplay) return
        const seat = this.seat(game)
        if (seat.type !== 'llm') return
        const profile = this.store.getProfile(seat.profileId)
        if (!profile)
          throw new Error(`Player profile not found: ${seat.profileId}`)
        const connection = this.store.getConnection(profile.connectionId)
        if (!connection)
          throw new Error(
            `Provider connection not found: ${profile.connectionId}`,
          )
        const adapter = createPlayerAdapter(connection, profile, this.vault)
        const snapshot = makeSnapshot(game.size, game.komi, game.moves)
        if (feedback) snapshot.previousError = feedback
        try {
          const result = await adapter.requestAction(
            snapshot,
            controller.signal,
          )
          if (controller.signal.aborted) return
          result.retries = attempt
          const latest = this.requireGame(id)
          this.accept(latest, result.action, result)
          return
        } catch (error) {
          if (controller.signal.aborted) return
          const repairable =
            error instanceof IllegalMoveError ||
            error instanceof MalformedModelOutputError ||
            error instanceof NoOutputGeneratedError
          if (!repairable) throw error
          feedback = error instanceof Error ? error.message : 'Invalid action'
          if (attempt === 2) {
            game.status = 'error'
            game.error = `Model failed to produce a legal action after 3 attempts: ${feedback}`
            game.autoplay = false
            this.commit(game)
            return
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const game = this.store.getGame(id)
        if (game) {
          game.status = 'error'
          game.error = publicError(error)
          game.autoplay = false
          this.commit(game)
        }
      }
    } finally {
      this.controllers.delete(id)
      this.scheduled.delete(id)
      this.emit(id)
      this.schedule(id)
    }
  }

  private automaticApprovals(game: Game): Color[] {
    const approvals: Color[] = []
    if (game.black.type === 'llm') approvals.push('B')
    if (game.white.type === 'llm') approvals.push('W')
    return approvals
  }

  private finishScoreIfApproved(game: Game) {
    if (
      game.approvals.includes('B') &&
      game.approvals.includes('W') &&
      !game.operatorConfirmationRequired
    ) {
      game.result = scoreBoard(game.board as any, game.komi, game.dead).result
      game.status = 'finished'
    }
  }

  private seat(game: Game) {
    return game.toMove === 'B' ? game.black : game.white
  }

  private hasCredentialsForCurrentSeat(game: Game) {
    const seat = this.seat(game)
    if (seat.type !== 'llm') return true
    const profile = this.store.getProfile(seat.profileId)
    if (!profile) return true
    const connection = this.store.getConnection(profile.connectionId)
    if (!connection) return true
    return connection.kind === 'fake' || Boolean(this.vault.get(connection))
  }

  private assertHumanTurn(game: Game) {
    if (game.status !== 'active') throw new Error('Game is not active')
    if (this.seat(game).type !== 'human')
      throw new Error('The current seat is controlled by a model')
  }

  private refreshPosition(game: Game) {
    const state = replay(game.size, game.moves)
    game.board = state.board
    game.toMove = state.toMove
    game.captures = state.captures
  }

  private commit(game: Game): Game {
    game.version += 1
    game.updatedAt = new Date().toISOString()
    this.save(game)
    return this.withPending(game)
  }

  private save(game: Game) {
    this.store.saveGame(game)
    this.emit(game.id)
  }

  private emit(id: string) {
    this.events.emit(id, this.get(id) ?? null)
  }

  private requireGame(id: string): Game {
    const game = this.store.getGame(id)
    if (!game) throw new Error('Game not found')
    return game
  }

  private withPending(game: Game): Game {
    return {
      ...game,
      pending: this.controllers.has(game.id),
      score:
        game.status === 'scoring'
          ? scoreBoard(game.board as any, game.komi, game.dead)
          : undefined,
    }
  }
}

function publicError(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/(?:sk-|AIza)[A-Za-z0-9_-]+/g, '[redacted]')
  return 'Provider request failed'
}
