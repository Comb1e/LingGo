import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {NoOutputGeneratedError} from 'ai'
import {coordinateToPoint, pointToCoordinate} from '../shared/coordinates'
import type {
  Color,
  Game,
  GamePosition,
  LlmMessageSet,
  LlmActionResult,
  Move,
  NewGameInput,
  PlayerAction,
  Point,
  PlayerProfile,
  ProviderConnection,
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
  isProviderContextError,
  type LlmTurnRequest,
  type LlmTurnResponse,
  MalformedModelOutputError,
  parseJsonActionResult,
  type PlayerAdapter,
  requestLlm,
  SecretVault,
  supportsProviderContinuation,
} from './providers'
import {
  type LlmGameContext,
  type LlmPromptMode,
  makeContinuationLlmPrompt,
  makeFirstGameLlmPrompt,
  makeGameIntentionPrompt,
  makeInitialLlmPrompt,
  makeReflectionLlmPrompt,
  makeRepairLlmPrompt,
  modelFingerprint,
} from './llmGameContext'
import {
  MAX_PROVIDER_API_ATTEMPTS,
  publicProviderError,
  shouldRetryProviderError,
  type ProviderRetryWait,
  waitForProviderRetry,
} from './network'
import type {ImportedRecord} from './sgf'

/** Maximum number of repair retries after the initial provider response. */
export const MAX_MODEL_OUTPUT_RETRIES = 3
/** Total model responses allowed for one unchanged position. */
export const MAX_MODEL_OUTPUT_ATTEMPTS = MAX_MODEL_OUTPUT_RETRIES + 1

type PlayerAdapterFactory = (
  ...args: Parameters<typeof createPlayerAdapter>
) => PlayerAdapter

export interface PreparedLlmTurn {
  context: LlmGameContext
  request: LlmTurnRequest
  snapshot: ReturnType<typeof makeSnapshot>
}

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
  private modelTurns = new Map<string, NonNullable<Game['modelTurn']>>()
  private llmAnalysisProvider?: (
    game: Game,
    signal: AbortSignal,
  ) => Promise<string | undefined>

  constructor(
    readonly store: Store,
    private readonly playerAdapterFactory: PlayerAdapterFactory = createPlayerAdapter,
    private readonly retryWait: ProviderRetryWait = waitForProviderRetry,
  ) {}

  setLlmAnalysisProvider(
    provider: (game: Game, signal: AbortSignal) => Promise<string | undefined>,
  ) {
    this.llmAnalysisProvider = provider
  }

  list() {
    return this.store.listGames().map((game) => this.withPending(game))
  }

  get(id: string) {
    const game = this.store.getGame(id)
    return game ? this.withPending(game) : undefined
  }

  position(id: string, turn: number): GamePosition {
    const game = this.requireGame(id)
    if (!Number.isInteger(turn) || turn < 0 || turn > game.moves.length)
      throw new Error(`Turn must be between 0 and ${game.moves.length}`)
    const state = replay(game.size, game.moves.slice(0, turn))
    return {
      gameId: id,
      turn,
      board: state.board,
      toMove: state.toMove,
      captures: state.captures,
    }
  }

  llmMessageSets(id: string): LlmMessageSet[] {
    this.requireGame(id)
    return this.store.listLlmGameContexts(id).map((context) => ({
      color: context.color,
      status: context.status,
      providerKind: context.providerKind,
      continuationMode:
        context.managedContinuation && context.providerContinuationId
          ? 'provider'
          : 'transcript',
      messages: [
        ...context.transcript,
        ...(context.pendingTurn
          ? [
              {
                role: 'user' as const,
                content: context.pendingTurn.content,
                pending: true,
              },
            ]
          : []),
      ],
    }))
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
      analysisEnabled: values.shareAnalysisWithLlm || values.analysisEnabled,
      shareAnalysisWithLlm: values.shareAnalysisWithLlm,
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
      analysisEnabled: true,
      shareAnalysisWithLlm: false,
    })
    game.moves = record.moves
    game.result = record.result
    game.status = record.result ? 'finished' : 'active'
    game.autoplay = false
    this.refreshPosition(game)
    return this.commit(game)
  }

  createBenchmarkGame(input: {
    runId: string
    gameIndex: number
    llmColor: Color
    profileId: string
    profileName: string
  }) {
    const game = this.create({
      size: 19,
      komi: 7.5,
      black: {type: 'human', name: 'Black'},
      white: {type: 'human', name: 'White'},
      commentsVisible: true,
      moveCap: 722,
      analysisEnabled: false,
    })
    const llm = {
      type: 'llm' as const,
      name: input.profileName,
      profileId: input.profileId,
    }
    const kata = {type: 'katago' as const, name: 'KataGo'}
    game.black = input.llmColor === 'B' ? llm : kata
    game.white = input.llmColor === 'W' ? llm : kata
    game.autoplay = false
    game.benchmarkRunId = input.runId
    game.benchmarkGameIndex = input.gameIndex
    return this.commit(game)
  }

  acceptAutomated(
    id: string,
    action: PlayerAction,
    llm?: LlmActionResult,
    forced = false,
    context?: LlmGameContext,
  ) {
    const saved = this.accept(this.requireGame(id), action, llm, context)
    if (forced) {
      const game = this.requireGame(id)
      game.moves.at(-1)!.forced = true
      this.store.markLlmGameContextsNeedsRebase(id)
      return this.commit(game)
    }
    return saved
  }

  prepareLlmActionTurn(input: {
    gameId: string
    color: Color
    profile: PlayerProfile
    connection: ProviderConnection
    mode: LlmPromptMode
    latestWinRate?: string
    fingerprint?: string
  }): PreparedLlmTurn {
    const game = this.requireGame(input.gameId)
    const snapshot = makeSnapshot(game.size, game.komi, game.moves)
    const fingerprint =
      input.fingerprint ?? modelFingerprint(input.profile, input.connection)
    let context = this.store.getLlmGameContext(game.id, input.color)
    const identityChanged =
      context &&
      (context.profileId !== input.profile.id ||
        context.providerKind !== input.connection.kind ||
        context.modelFingerprint !== fingerprint)
    const pendingValid =
      context?.pendingTurn &&
      !identityChanged &&
      context.pendingTurn.observedMoveCount === game.moves.length &&
      ['active', 'repairing'].includes(context.status)
    if (pendingValid)
      return this.preparedTurn(context!, snapshot, context!.pendingTurn!)

    const unseen = context
      ? game.moves.slice(context.lastObservedMove)
      : game.moves
    const continuationValid =
      context?.status === 'active' &&
      !identityChanged &&
      context.lastObservedMove >= 0 &&
      context.lastObservedMove < game.moves.length &&
      unseen.length === 1 &&
      unseen[0].color !== input.color
    // A benchmark can seed game 0 with the notebook-initialization transcript
    // before any moves exist. Keep that transcript for the first move prompt.
    const seededInitialContext =
      context?.status === 'active' &&
      !identityChanged &&
      game.moves.length === 0 &&
      context.lastObservedMove === 0 &&
      context.transcript.length > 0
    const rebase = !continuationValid && !seededInitialContext
    const now = new Date().toISOString()
    const content = continuationValid
      ? makeContinuationLlmPrompt(
          snapshot,
          unseen[0],
          input.latestWinRate,
          input.mode.kind === 'benchmark' && input.mode.phase === 'training'
            ? input.mode.trainingFeedback
            : 'none',
        )
      : seededInitialContext && input.mode.kind === 'benchmark'
        ? makeFirstGameLlmPrompt(snapshot, input.mode.trainingFeedback)
        : makeInitialLlmPrompt(
            snapshot,
            input.mode,
            input.latestWinRate,
            context?.gameIntention,
          )
    context = {
      gameId: game.id,
      color: input.color,
      status: 'active',
      profileId: input.profile.id,
      providerKind: input.connection.kind,
      modelFingerprint: fingerprint,
      lastObservedMove: game.moves.length,
      transcript: rebase ? [] : context!.transcript,
      gameIntention: context?.gameIntention,
      lastIntentionTurn: context?.lastIntentionTurn,
      pendingTurn: {
        kind: continuationValid ? 'continuation' : 'initial',
        content,
        observedMoveCount: game.moves.length,
      },
      providerContinuationId: rebase
        ? undefined
        : context!.providerContinuationId,
      managedContinuation:
        !context || identityChanged
          ? supportsProviderContinuation(input.connection)
          : context.managedContinuation,
      createdAt: context?.createdAt ?? now,
      updatedAt: now,
    }
    this.store.saveLlmGameContext(context)
    return this.preparedTurn(context, snapshot, context.pendingTurn!)
  }

  seedLlmContext(input: {
    gameId: string
    color: Color
    profile: PlayerProfile
    connection: ProviderConnection
    transcript: LlmGameContext['transcript']
    providerContinuationId?: string
  }) {
    if (this.store.getLlmGameContext(input.gameId, input.color)) return false
    const now = new Date().toISOString()
    this.store.saveLlmGameContext({
      gameId: input.gameId,
      color: input.color,
      status: 'active',
      profileId: input.profile.id,
      providerKind: input.connection.kind,
      modelFingerprint: modelFingerprint(input.profile, input.connection),
      lastObservedMove: 0,
      transcript: input.transcript,
      providerContinuationId: input.providerContinuationId,
      managedContinuation:
        supportsProviderContinuation(input.connection) &&
        Boolean(input.providerContinuationId),
      createdAt: now,
      updatedAt: now,
    })
    return true
  }

  repairLlmActionTurn(
    prepared: PreparedLlmTurn,
    response: LlmTurnResponse,
    error: string,
  ): PreparedLlmTurn {
    const game = this.requireGame(prepared.context.gameId)
    const snapshot = makeSnapshot(game.size, game.komi, game.moves)
    const content = makeRepairLlmPrompt(error)
    const context: LlmGameContext = {
      ...prepared.context,
      status: 'repairing',
      transcript: appendVisibleTurn(prepared.context, response.text),
      pendingTurn: {
        kind: 'repair',
        content,
        observedMoveCount: game.moves.length,
      },
      providerContinuationId: prepared.context.managedContinuation
        ? (response.providerContinuationId ??
          prepared.context.providerContinuationId)
        : undefined,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveLlmGameContext(context)
    return this.preparedTurn(context, snapshot, context.pendingTurn!)
  }

  prepareLlmReflectionTurn(input: {
    gameId: string
    color: Color
    profile: PlayerProfile
    connection: ProviderConnection
    fingerprint?: string
  }): PreparedLlmTurn {
    const game = this.requireGame(input.gameId)
    const snapshot = makeSnapshot(game.size, game.komi, game.moves)
    const fingerprint =
      input.fingerprint ?? modelFingerprint(input.profile, input.connection)
    let context = this.store.getLlmGameContext(game.id, input.color)
    const identityMatches = Boolean(
      context &&
      context.profileId === input.profile.id &&
      context.providerKind === input.connection.kind &&
      context.modelFingerprint === fingerprint,
    )
    const valid =
      identityMatches &&
      context!.status !== 'needs_rebase' &&
      context!.lastObservedMove <= game.moves.length
    if (
      valid &&
      context!.status === 'reflecting' &&
      context!.pendingTurn?.observedMoveCount === game.moves.length
    )
      return this.preparedTurn(context!, snapshot, context!.pendingTurn!)
    const unseen = valid ? game.moves.slice(context!.lastObservedMove) : []
    const now = new Date().toISOString()
    const content = makeReflectionLlmPrompt(game, input.color, unseen)
    context = {
      gameId: game.id,
      color: input.color,
      status: 'reflecting',
      profileId: input.profile.id,
      providerKind: input.connection.kind,
      modelFingerprint: fingerprint,
      lastObservedMove: game.moves.length,
      transcript: valid ? context!.transcript : [],
      pendingTurn: {
        kind: 'reflection',
        content,
        observedMoveCount: game.moves.length,
      },
      providerContinuationId: valid
        ? context!.providerContinuationId
        : undefined,
      managedContinuation:
        !context || !identityMatches
          ? supportsProviderContinuation(input.connection)
          : context.managedContinuation,
      createdAt: context?.createdAt ?? now,
      updatedAt: now,
    }
    this.store.saveLlmGameContext(context)
    return this.preparedTurn(context, snapshot, context.pendingTurn!)
  }

  completedLlmContext(
    prepared: PreparedLlmTurn,
    response: LlmTurnResponse,
    status: 'active' | 'complete',
    lastObservedMove: number,
  ): LlmGameContext {
    return {
      ...prepared.context,
      status,
      lastObservedMove,
      transcript: appendVisibleTurn(prepared.context, response.text),
      pendingTurn: undefined,
      providerContinuationId: prepared.context.managedContinuation
        ? (response.providerContinuationId ??
          prepared.context.providerContinuationId)
        : undefined,
      updatedAt: new Date().toISOString(),
    }
  }

  async summarizeLlmContext(
    adapter: PlayerAdapter,
    prepared: PreparedLlmTurn,
    signal: AbortSignal,
  ) {
    const prompt = makeGameIntentionPrompt()
    const response = await requestLlm(
      adapter,
      {
        type: 'turn',
        request: {
          kind: 'summary',
          content: prompt,
          transcript: prepared.context.transcript,
          previousResponseId: prepared.context.managedContinuation
            ? prepared.context.providerContinuationId
            : undefined,
          cacheKey: `linggo:${prepared.context.gameId}:${prepared.context.color}`,
          snapshot: prepared.snapshot,
          output: 'summary',
        },
      },
      signal,
    )
    return response.text.trim() || undefined
  }

  rebaseLlmContext(
    gameId: string,
    color: Color,
    gameIntention?: string,
    intentionTurn?: number,
  ) {
    this.store.markLlmGameContextsNeedsRebase(
      gameId,
      color,
      gameIntention,
      intentionTurn,
    )
  }

  disableManagedLlmContinuation(
    gameId: string,
    color: Color,
    gameIntention?: string,
    intentionTurn?: number,
  ) {
    this.store.disableManagedLlmContinuation(
      gameId,
      color,
      gameIntention,
      intentionTurn,
    )
  }

  finishAutomated(
    id: string,
    result: string,
    benchmarkTermination?: Game['benchmarkTermination'],
  ) {
    const game = this.requireGame(id)
    game.result = result
    game.benchmarkTermination = benchmarkTermination
    game.status = 'finished'
    game.autoplay = false
    game.pauseAfterMove = false
    game.error = undefined
    return this.commit(game)
  }

  setAutomatedTurnState(id: string, state: NonNullable<Game['modelTurn']>) {
    this.modelTurns.set(id, state)
    this.emit(id)
  }

  clearAutomatedTurnState(id: string) {
    if (!this.modelTurns.delete(id)) return
    this.emit(id)
  }

  completeLlmContexts(id: string) {
    this.store.completeLlmGameContexts(id)
  }

  recordRejectedModelAction(
    id: string,
    value: Omit<NonNullable<Game['rejectedModelActions']>[number], 'timestamp'>,
  ) {
    const game = this.requireGame(id)
    ;(game.rejectedModelActions ??= []).push({
      ...value,
      timestamp: new Date().toISOString(),
    })
    return this.commit(game)
  }

  reportAutomatedError(id: string, error: string) {
    const game = this.requireGame(id)
    this.modelTurns.delete(id)
    if (game.status === 'active') game.status = 'paused'
    game.error = error
    game.providerErrors = [error]
    game.autoplay = false
    game.pauseAfterMove = false
    return this.commit(game)
  }

  clearAutomatedError(id: string) {
    const game = this.requireGame(id)
    if (!game.error) return this.withPending(game)
    game.error = undefined
    game.pauseAfterMove = false
    if (game.status === 'paused') game.status = 'active'
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
      game.pauseAfterMove = false
      return this.commit(game)
    }
    if (command.type === 'step') {
      if (game.benchmarkRunId)
        throw new Error('Benchmark games are controlled by their benchmark run')
      if (!['active', 'paused'].includes(game.status) || game.error)
        throw new Error(
          'Next move is available only during active play without an error',
        )
      if (this.seat(game).type !== 'llm')
        throw new Error('The current seat is not controlled by a model')
      game.status = 'active'
      game.autoplay = true
      game.pauseAfterMove = true
      const saved = this.commit(game)
      this.schedule(id)
      return saved
    }
    if (command.type === 'resume' || command.type === 'retry') {
      game.status = 'active'
      game.error = undefined
      game.autoplay = true
      game.pauseAfterMove = false
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
      game.pauseAfterMove = false
      this.refreshPosition(game)
      this.store.markLlmGameContextsNeedsRebase(id)
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
      game.pauseAfterMove = false
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
      if (game.benchmarkRunId)
        throw new Error('Benchmark games are controlled by their benchmark run')
      if (['scoring', 'finished'].includes(game.status))
        throw new Error('Profile changes are unavailable after scoring begins')
      if (!this.store.getProfile(command.profileId))
        throw new Error('Profile not found')
      // Abort before changing the seat so an in-flight response cannot be
      // committed using the previous profile identity.
      this.cancel(id)
      const key = command.color === 'B' ? 'black' : 'white'
      game[key] = {
        type: 'llm',
        name: this.store.getProfile(command.profileId)!.name,
        profileId: command.profileId,
      }
      game.status = 'active'
      game.error = undefined
      game.pauseAfterMove = false
      this.store.markLlmGameContextsNeedsRebase(id, command.color)
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
      if (game.benchmarkRunId)
        throw new Error('Benchmark games are controlled by their benchmark run')
      this.cancel(id)
      game.status = 'active'
      game.error = undefined
      game.autoplay = false
      game.pauseAfterMove = false
      const saved = this.accept(game, {
        action: 'pass',
        comment: 'Operator forced a pass.',
      })
      this.store.markLlmGameContextsNeedsRebase(id)
      return saved
    }
    if (
      command.type === 'resign' &&
      ['paused', 'error'].includes(game.status) &&
      Boolean(game.error)
    ) {
      game.status = 'active'
      game.error = undefined
      game.autoplay = false
      game.pauseAfterMove = false
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
    this.modelTurns.delete(id)
    this.emit(id)
  }

  private accept(
    game: Game,
    action: PlayerAction,
    llm?: LlmActionResult,
    context?: LlmGameContext,
  ): Game {
    if (game.status !== 'active') throw new Error('Game is not active')
    const color = game.toMove
    const state = replay(game.size, game.moves)
    let captured = 0
    let capturedPoints = [] as Point[]
    let point
    if (action.action === 'pass' && state.passCounts[color] >= 2)
      throw new IllegalMoveError(
        `${color === 'B' ? 'Black' : 'White'} may pass at most twice per game`,
      )
    if (action.action === 'play') {
      point = coordinateToPoint(action.coordinate, game.size)
      const result = playStone(state.board, color, point, state.hashes)
      captured = result.captured
      capturedPoints = result.capturedPoints
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
      capturedPoints,
      latencyMs: llm?.latencyMs,
      inputTokens: llm?.inputTokens,
      cachedInputTokens: llm?.cachedInputTokens,
      outputTokens: llm?.outputTokens,
      model: llm?.model,
      providerKind: llm?.providerKind,
      retries: llm?.retries,
      retryErrors: llm?.retryErrors,
    }
    game.moves.push(move)
    if (llm) game.providerErrors = undefined
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

    if (game.pauseAfterMove) {
      game.pauseAfterMove = false
      game.autoplay = false
      if (game.status === 'active') game.status = 'paused'
    }

    const saved = this.commit(game, context)
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
    this.modelTurns.set(id, {
      phase: 'requesting',
      attempt: 1,
      maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
    })
    this.emit(id)
    try {
      let outputFailures = 0
      let apiFailures = 0
      let rebasedProviderContext = false
      const retryErrors = [...(this.requireGame(id).providerErrors ?? [])]
      let prepared: PreparedLlmTurn | undefined
      while (outputFailures <= MAX_MODEL_OUTPUT_RETRIES) {
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
        const adapter = this.playerAdapterFactory(
          connection,
          profile,
          this.vault,
        )
        const snapshot = makeSnapshot(game.size, game.komi, game.moves)
        const latestWinRate = await this.llmAnalysisProvider?.(
          game,
          controller.signal,
        )
        if (controller.signal.aborted) return
        const llmTurnCount = game.moves.filter(
          (move) => move.color === game.toMove,
        ).length
        if (!prepared && llmTurnCount > 0 && llmTurnCount % 10 === 0) {
          const currentContext = this.store.getLlmGameContext(
            game.id,
            game.toMove,
          )
          if (
            currentContext &&
            currentContext.lastIntentionTurn !== llmTurnCount
          ) {
            const boundaryPrepared = this.prepareLlmActionTurn({
              gameId: id,
              color: game.toMove,
              profile,
              connection,
              mode: {
                kind: 'ordinary',
                stylePrompt: profile.stylePrompt,
              },
              latestWinRate,
            })
            let gameIntention: string | undefined
            try {
              gameIntention = await this.summarizeLlmContext(
                adapter,
                boundaryPrepared,
                controller.signal,
              )
            } catch (summaryError) {
              if (controller.signal.aborted) throw summaryError
            }
            this.rebaseLlmContext(id, game.toMove, gameIntention, llmTurnCount)
            continue
          }
        }
        prepared ??= this.prepareLlmActionTurn({
          gameId: id,
          color: game.toMove,
          profile,
          connection,
          mode: {kind: 'ordinary', stylePrompt: profile.stylePrompt},
          latestWinRate,
        })
        let response: LlmTurnResponse | undefined
        try {
          response = await this.requestPreparedLlmTurn(
            adapter,
            prepared,
            controller.signal,
          )
          if (
            controller.signal.aborted ||
            this.controllers.get(id) !== controller
          )
            return
          const parsed = parseJsonActionResult(response.text, snapshot.size)
          const result: LlmActionResult = {
            action: parsed.action,
            responseContent: response.text,
            reasoning: response.reasoning,
            latencyMs: response.latencyMs,
            inputTokens: response.inputTokens,
            cachedInputTokens: response.cachedInputTokens,
            outputTokens: response.outputTokens,
            model: response.model,
            providerKind: response.providerKind,
            retries: 0,
          }
          result.retries = outputFailures + apiFailures
          result.retryErrors = retryErrors.length ? retryErrors : undefined
          const latest = this.requireGame(id)
          const completed = this.completedLlmContext(
            prepared,
            response,
            'active',
            latest.moves.length + 1,
          )
          this.accept(latest, result.action, result, completed)
          return
        } catch (error) {
          if (controller.signal.aborted) return
          const repairable =
            error instanceof IllegalMoveError ||
            error instanceof MalformedModelOutputError ||
            error instanceof NoOutputGeneratedError
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
            let gameIntention: string | undefined
            try {
              gameIntention = await this.summarizeLlmContext(
                adapter,
                prepared,
                controller.signal,
              )
            } catch (summaryError) {
              if (controller.signal.aborted) throw summaryError
            }
            if (managedContinuationFailed)
              this.disableManagedLlmContinuation(id, game.toMove, gameIntention)
            else this.rebaseLlmContext(id, game.toMove, gameIntention)
            prepared = undefined
            continue
          }
          if (!repairable) {
            apiFailures += 1
            const message = publicProviderError(error)
            retryErrors.push(message)
            if (
              !shouldRetryProviderError(error) ||
              apiFailures >= MAX_PROVIDER_API_ATTEMPTS
            ) {
              const latest = this.requireGame(id)
              latest.status = 'paused'
              latest.error = `LLM API request failed after ${apiFailures} ${apiFailures === 1 ? 'attempt' : 'attempts'}. The game has been paused. Last error: ${message}`
              latest.providerErrors = retryErrors
              latest.autoplay = false
              latest.pauseAfterMove = false
              this.commit(latest)
              return
            }
            this.modelTurns.set(id, {
              phase: 'retrying',
              attempt: apiFailures + 1,
              maxAttempts: MAX_PROVIDER_API_ATTEMPTS,
              lastError: message,
            })
            this.emit(id)
            await this.retryWait(apiFailures, controller.signal, error)
            continue
          }
          outputFailures += 1
          const feedback =
            error instanceof Error ? error.message : 'Invalid action'
          const rejected =
            response ??
            emptyTurnResponse(error, connection.kind, profile.modelId)
          const content = rejected.text
          const retained = content.slice(0, 32_000)
          this.recordRejectedModelAction(id, {
            turn: game.moves.length + 1,
            attempt: outputFailures,
            responseContent: retained,
            reason: feedback,
            truncated: retained.length < content.length,
          })
          this.modelTurns.set(id, {
            phase: 'repairing',
            attempt: outputFailures + 1,
            maxAttempts: MAX_MODEL_OUTPUT_ATTEMPTS,
            lastError: feedback,
          })
          this.emit(id)
          if (outputFailures > MAX_MODEL_OUTPUT_RETRIES) {
            const latest = this.requireGame(id)
            latest.status = 'error'
            latest.error = `Model failed to produce a legal action after ${MAX_MODEL_OUTPUT_ATTEMPTS} attempts: ${feedback}`
            latest.autoplay = false
            latest.pauseAfterMove = false
            this.commit(latest)
            return
          }
          prepared = this.repairLlmActionTurn(prepared, rejected, feedback)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const game = this.store.getGame(id)
        if (game) {
          game.status = 'error'
          game.error = publicProviderError(error)
          game.autoplay = false
          game.pauseAfterMove = false
          this.commit(game)
        }
      }
    } finally {
      const current = this.controllers.get(id) === controller
      if (current) {
        this.controllers.delete(id)
        this.scheduled.delete(id)
        this.modelTurns.delete(id)
        this.emit(id)
        this.schedule(id)
      }
    }
  }

  private automaticApprovals(game: Game): Color[] {
    const approvals: Color[] = []
    if (game.black.type !== 'human') approvals.push('B')
    if (game.white.type !== 'human') approvals.push('W')
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

  private commit(game: Game, context?: LlmGameContext): Game {
    game.version += 1
    game.updatedAt = new Date().toISOString()
    if (game.status === 'finished' && !game.benchmarkRunId && context)
      context.status = 'complete'
    if (context) {
      this.store.saveGameWithLlmContext(game, context)
      this.store.ensureGameAnalysis(
        game.id,
        game.analysisEnabled ?? true,
        game.shareAnalysisWithLlm ?? false,
      )
      this.emit(game.id)
    } else this.save(game)
    if (game.status === 'finished' && !game.benchmarkRunId)
      this.store.completeLlmGameContexts(game.id)
    return this.withPending(game)
  }

  private save(game: Game) {
    this.store.saveGame(game)
    this.store.ensureGameAnalysis(
      game.id,
      game.analysisEnabled ?? true,
      game.shareAnalysisWithLlm ?? false,
    )
    this.emit(game.id)
  }

  private emit(id: string) {
    this.events.emit(id, this.get(id) ?? null)
    this.events.emit('changed', id)
  }

  private requireGame(id: string): Game {
    const game = this.store.getGame(id)
    if (!game) throw new Error('Game not found')
    return game
  }

  private withPending(game: Game): Game {
    return {
      ...game,
      pending: this.controllers.has(game.id) || this.modelTurns.has(game.id),
      modelTurn: this.modelTurns.get(game.id),
      score:
        game.status === 'scoring'
          ? scoreBoard(game.board as any, game.komi, game.dead)
          : undefined,
    }
  }

  private preparedTurn(
    context: LlmGameContext,
    snapshot: ReturnType<typeof makeSnapshot>,
    pendingTurn: NonNullable<LlmGameContext['pendingTurn']>,
  ): PreparedLlmTurn {
    return {
      context,
      snapshot,
      request: {
        kind: pendingTurn.kind,
        content: pendingTurn.content,
        transcript: context.transcript,
        previousResponseId: context.managedContinuation
          ? context.providerContinuationId
          : undefined,
        cacheKey: `linggo:${context.gameId}:${context.color}`,
        snapshot,
        output: pendingTurn.kind === 'reflection' ? 'notebook' : 'action',
      },
    }
  }

  async requestPreparedLlmTurn(
    adapter: PlayerAdapter,
    prepared: PreparedLlmTurn,
    signal: AbortSignal,
  ): Promise<LlmTurnResponse> {
    const response = await requestLlm(
      adapter,
      {type: 'turn', request: prepared.request},
      signal,
    )
    return {
      ...response,
      providerKind: response.providerKind ?? prepared.context.providerKind,
    }
  }
}

function appendVisibleTurn(context: LlmGameContext, assistant: string) {
  if (!context.pendingTurn) return context.transcript
  return [
    ...context.transcript,
    {role: 'user' as const, content: context.pendingTurn.content},
    {role: 'assistant' as const, content: assistant},
  ]
}

function emptyTurnResponse(
  error: unknown,
  providerKind: ProviderConnection['kind'],
  model: string,
): LlmTurnResponse {
  return {
    text:
      error instanceof MalformedModelOutputError ? error.responseContent : '',
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    model,
    providerKind,
  }
}
