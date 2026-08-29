import {createHash} from 'node:crypto'
import {pointToCoordinate} from '../shared/coordinates'
import type {
  Color,
  Game,
  GameSnapshot,
  Move,
  PlayerProfile,
  ProviderConnection,
  BenchmarkNotebookRole,
  BenchmarkStageKey,
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
  gameIntention?: string
  lastIntentionTurn?: number
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
      trainingFeedback?: 'none' | 'structured'
      stageKey?: BenchmarkStageKey
      writableNotebookRole?: BenchmarkNotebookRole
      readOnlyNotebooks?: Array<{
        role: BenchmarkNotebookRole
        name: string
        content: string
      }>
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
  gameIntention?: string,
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
      ...(gameIntention?.trim()
        ? ['', 'GAME INTENTION', gameIntention.trim()]
        : []),
      '',
      ...sections.instruction,
      '',
      ...sections.responseSchema,
      '',
      '5. CURRENT POSITION',
      ...position,
      ...(latestWinRate
        ? [
            '',
            '6. LATEST KATAGO WIN-RATE UPDATE',
            'Retrospective feedback only: the KataGo candidate and metrics below describe the position immediately before your previous move. They are not a recommendation for the current position; do not play that candidate now unless it is independently the best legal move in the current position.',
            latestWinRate,
          ]
        : []),
    ].join('\n')
  }

  const notebookContext = mode.writableNotebookRole
    ? [
        ...(mode.readOnlyNotebooks ?? []).flatMap((notebook) => [
          `${notebook.role === 'life_death' ? 'LIFE-AND-DEATH NOTEBOOK' : 'ORDINARY-GAME NOTEBOOK'} (READ ONLY)`,
          notebook.content.trim() || '(none)',
          '',
        ]),
        `${mode.writableNotebookRole === 'ordinary' ? 'ORDINARY-GAME NOTEBOOK' : 'LIFE-AND-DEATH NOTEBOOK'} (WRITABLE)`,
        mode.notebook.trim() || '(none)',
      ]
    : [mode.notebook.trim() || '(none)']
  const values = [
    ...(mode.phase === 'training'
      ? [
          'BACKGROUND',
          "This is a benchmark training game. Your primary goal is to learn, not to win; the result of this training game does not matter. You are playing against the world's best Go player. Study the opponent's decisions as well as your own and develop general skills that transfer to future positions.",
          '',
        ]
      : []),
    ...sections.goRules,
    '',
    '2. SELF-WRITTEN SKILLS',
    ...notebookContext,
    ...(gameIntention?.trim()
      ? ['', 'GAME INTENTION', gameIntention.trim()]
      : []),
    '',
    ...sections.instruction,
    '',
    ...sections.responseSchema,
    '',
    '5. CURRENT BOARD',
    ...position,
  ]
  if (mode.phase === 'training' && mode.trainingFeedback === 'structured')
    values.splice(
      values.length - position.length,
      0,
      '',
      'KATAGO TRAINING FEEDBACK',
      "A retrospective update may appear after you make a move. Its top five ranked KataGo candidates are alternative moves for the position immediately before your previous move, not recommendations for the current position. Candidate #1 is KataGo's best choice and is the baseline for the reported win-rate loss. Do not play those candidates now unless you independently determine one is legal and best in the current position.",
    )
  if (mode.phase === 'training' && latestWinRate)
    values.push(
      '',
      'LATEST TRAINING WIN-RATE UPDATE (RETROSPECTIVE)',
      latestWinRate,
    )
  return values.join('\n')
}

export function makeGameIntentionPrompt() {
  return [
    'TASK SWITCH: summarize your current game intention for a context reset.',
    'This is not a turn and you must not play or recommend a move. Do not return the established move/reason JSON, a coordinate, pass, resign, or a move explanation.',
    'Using the game conversation immediately above, state only your current strategic priorities, unresolved plans, and intended approach in 1 to 3 concise plain-text sentences.',
  ].join('\n')
}

export function makeFirstGameLlmPrompt(
  snapshot: GameSnapshot,
  trainingFeedback: 'none' | 'structured' = 'none',
) {
  const sections = makeMovePromptSections(snapshot, {mode: 'benchmark'})
  const values = [
    'BEGIN FIRST BENCHMARK GAME',
    'Use the technique notebook you just wrote as your play guidance. Begin the game by choosing one legal move for the current position.',
    '',
    ...sections.instruction.map((line, index) =>
      index === 0 ? 'INSTRUCTION TO PLACE ONE STONE' : line,
    ),
    '',
    ...sections.responseSchema.map((line, index) =>
      index === 0 ? 'JSON OUTPUT SCHEMA' : line,
    ),
    '',
    ...sections.currentPosition.map((line, index) =>
      index === 0 ? 'CURRENT BOARD' : line,
    ),
  ]
  if (trainingFeedback === 'structured')
    values.splice(
      3,
      0,
      'KATAGO TRAINING FEEDBACK',
      "A retrospective update may appear after you make a move. Its top five ranked KataGo candidates are alternative moves for the position immediately before your previous move, not recommendations for the current position. Candidate #1 is KataGo's best choice and is the baseline for the reported win-rate loss. Do not play those candidates now unless you independently determine one is legal and best in the current position.",
      '',
    )
  return values.join('\n')
}

export function makeContinuationLlmPrompt(
  snapshot: GameSnapshot,
  observedMove: Move,
  latestWinRate?: string,
  trainingFeedback: 'none' | 'structured' = 'none',
) {
  const isStructuredTraining = trainingFeedback === 'structured'
  return [
    `Newly observed opponent action: ${formatMove(observedMove, snapshot)}`,
    ...formatCurrentPosition(snapshot, observedMove),
    'BOARD OCCUPANCY: Do not place a stone on an X or O intersection: X and O already contain stones. You may place a stone only on a . (dot) intersection.',
    ...(latestWinRate
      ? [
          isStructuredTraining
            ? "Latest training win-rate update (retrospective; includes KataGo's top five ranked candidates, with candidate #1 as the loss baseline):"
            : 'Latest win-rate update (retrospective; see the initial training instructions for candidate interpretation):',
          latestWinRate,
        ]
      : []),
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
