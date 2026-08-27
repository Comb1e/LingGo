import {createHash} from 'node:crypto'
import {pointToCoordinate} from '../shared/coordinates'
import type {
  Color,
  Game,
  GameSnapshot,
  Move,
  PlayerProfile,
  ProviderConnection,
} from '../shared/types'
import {asciiBoard} from './go'
import {makeMovePromptSections} from './movePrompt'

export type LlmGameContextStatus =
  | 'uninitialized'
  | 'active'
  | 'repairing'
  | 'reflecting'
  | 'needs_rebase'
  | 'complete'

export interface VisibleLlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PendingLlmTurn {
  kind: 'initial' | 'continuation' | 'repair' | 'reflection'
  content: string
  observedMoveCount: number
}

export interface LlmGameContext {
  gameId: string
  color: Color
  status: LlmGameContextStatus
  profileId: string
  providerKind: ProviderConnection['kind']
  modelFingerprint: string
  lastObservedMove: number
  transcript: VisibleLlmMessage[]
  pendingTurn?: PendingLlmTurn
  providerContinuationId?: string
  managedContinuation: boolean
  createdAt: string
  updatedAt: string
}

export type LlmPromptMode =
  | {kind: 'ordinary'; stylePrompt?: string}
  | {
      kind: 'benchmark'
      phase: 'training' | 'final'
      notebook: string
    }

export function modelFingerprint(
  profile: PlayerProfile,
  connection: ProviderConnection,
) {
  return createHash('sha256')
    .update(JSON.stringify({profile, connection}))
    .digest('hex')
}

export function makeInitialLlmPrompt(
  snapshot: GameSnapshot,
  mode: LlmPromptMode,
  latestWinRate?: string,
) {
  const sections = makeMovePromptSections(snapshot, {
    mode: mode.kind === 'ordinary' ? 'ordinary' : 'benchmark',
  })
  const position = formatCurrentPosition(snapshot, snapshot.moves.at(-1))
  if (mode.kind === 'ordinary') {
    return [
      ...sections.goRules,
      '',
      '2. PLAYING STYLE',
      mode.stylePrompt?.trim() || '(none)',
      '',
      ...sections.instruction,
      '',
      ...sections.responseSchema,
      '',
      '5. CURRENT POSITION',
      ...position,
      ...(latestWinRate
        ? ['', '6. LATEST KATAGO WIN-RATE UPDATE', latestWinRate]
        : []),
    ].join('\n')
  }

  const values = [
    'BACKGROUND',
    mode.phase === 'training'
      ? "This is a benchmark training game. Your primary goal is to learn, not to win; the result of this training game does not matter. You are playing against the world's best Go player. Study the opponent's decisions as well as your own and develop general skills that transfer to future positions."
      : 'This is the scored final game. Play to the best of your ability and maximize your score.',
    '',
    ...sections.goRules,
    '',
    '2. SELF-WRITTEN SKILLS',
    mode.notebook.trim() || '(none)',
    '',
    ...sections.instruction,
    '',
    ...sections.responseSchema,
    '',
    '5. CURRENT BOARD',
    ...position,
  ]
  if (mode.phase === 'training' && latestWinRate)
    values.push('', 'LATEST TRAINING WIN-RATE UPDATE', latestWinRate)
  return values.join('\n')
}

export function makeContinuationLlmPrompt(
  snapshot: GameSnapshot,
  observedMove: Move,
  latestWinRate?: string,
) {
  return [
    `Newly observed opponent action: ${formatMove(observedMove, snapshot)}`,
    ...formatCurrentPosition(snapshot, observedMove),
    ...(latestWinRate ? ['Latest win-rate update:', latestWinRate] : []),
    'Return only the next move JSON object using the established schema.',
  ].join('\n')
}

export function makeRepairLlmPrompt(error: string) {
  return error
}

export function makeReflectionLlmPrompt(
  game: Game,
  color: Color,
  unseenMoves: Move[],
) {
  const snapshot: GameSnapshot = {
    size: game.size,
    komi: game.komi,
    board: game.board,
    toMove: game.toMove,
    moves: game.moves,
    captures: game.captures,
    rules: 'Chinese area',
  }
  return [
    ...(unseenMoves.length
      ? [
          'Newly observed terminal opponent action:',
          ...unseenMoves.map((move) => formatMove(move, snapshot)),
        ]
      : []),
    'Final authoritative position:',
    ...formatCurrentPosition(snapshot, game.moves.at(-1)),
    `Outcome: ${perspectiveOutcome(game.result, color)}`,
    'Return only the complete replacement Markdown technique notebook.',
  ].join('\n')
}

export function perspectiveOutcome(result: string | undefined, color: Color) {
  if (!result || result === 'Draw') return 'Draw'
  const match = /^([BW])\+(.+)$/.exec(result)
  if (!match) return result
  const won = match[1] === color
  if (match[2].toUpperCase() === 'R')
    return `You ${won ? 'won' : 'lost'} by resignation`
  return `You ${won ? 'won' : 'lost'} by ${match[2]} points`
}

function formatCurrentPosition(snapshot: GameSnapshot, latestMove?: Move) {
  return [
    `To move: ${snapshot.toMove === 'B' ? 'Black (X)' : 'White (O)'}`,
    `Captures: Black ${snapshot.captures.B}, White ${snapshot.captures.W}.`,
    `Latest capture locations: ${formatCaptured(latestMove, snapshot)}`,
    'X = Black stone, O = White stone, . = empty intersection.',
    '',
    asciiBoard(snapshot),
  ]
}

function formatMove(move: Move, snapshot: Pick<GameSnapshot, 'size'>) {
  return `${move.number}. ${move.color} ${move.coordinate ?? move.action}; captured ${move.captured} at ${formatCaptured(move, snapshot)}`
}

function formatCaptured(
  move: Move | undefined,
  snapshot: Pick<GameSnapshot, 'size'>,
) {
  return move?.capturedPoints?.length
    ? move.capturedPoints
        .map((point) => pointToCoordinate(point, snapshot.size))
        .join(', ')
    : '(none)'
}
