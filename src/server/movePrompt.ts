import {pointToCoordinate} from '../shared/coordinates'
import type {
  BoardSize,
  GameSnapshot,
  InGameReflection,
} from '../shared/types'
import {asciiBoard} from './go'

export type MovePromptOptions =
  | {mode: 'ordinary'}
  | {mode: 'benchmark'; inGameReflections?: InGameReflection[]}

export interface MovePromptSections {
  goRules: string[]
  instruction: string[]
  responseSchema: string[]
  currentPosition: string[]
}

export function makeMovePromptSections(
  snapshot: GameSnapshot,
  options: MovePromptOptions,
): MovePromptSections {
  return options.mode === 'ordinary'
    ? makeOrdinarySections(snapshot)
    : makeBenchmarkSections(snapshot, options.inGameReflections)
}

function makeOrdinarySections(snapshot: GameSnapshot): MovePromptSections {
  const ownCaptures = snapshot.captures[snapshot.toMove]
  const opponentCaptures =
    snapshot.captures[snapshot.toMove === 'B' ? 'W' : 'B']
  return {
    goRules: makeGoRulesSection(snapshot),
    instruction: [
      '3. INSTRUCTION',
      `You are ${snapshot.toMove === 'B' ? 'Black' : 'White'}. Choose exactly one legal intersection for your next Go stone. ${snapshot.kataGoAnalysis ? 'You may use the supplied KataGo win-rate history.' : 'Do not use external analysis.'} Do not suggest multiple moves.`,
      ...(snapshot.previousError
        ? [
            `Your previous response was rejected: ${snapshot.previousError}. Use the unchanged position and correct the response.`,
          ]
        : []),
    ],
    responseSchema: [
      '4. RESPONSE SCHEMA',
      'Return only plain text containing one valid JSON object. Do not use Markdown or code fences.',
      '{"move":[column,row],"reason":"brief reason for this move"}',
      `move must be a two-integer array. column and row are zero-based from the top-left, each from 0 to ${snapshot.size - 1}.`,
      'Use {"move":[-1,-1],"reason":"..."} to pass or {"move":[-2,-2],"reason":"..."} to resign.',
    ],
    currentPosition: [
      '5. CURRENT POSITION',
      `To move: ${snapshot.toMove === 'B' ? 'Black (X)' : 'White (O)'}`,
      `Capture totals: Black has captured ${snapshot.captures.B} White stones; White has captured ${snapshot.captures.W} Black stones.`,
      `From your perspective: you have captured ${ownCaptures} opponent stones; the opponent has captured ${opponentCaptures} of your stones.`,
      'X = Black stone, O = White stone, . = empty intersection.',
      '',
      asciiBoard(snapshot),
      '',
      'Move list:',
      formatPromptMoves(snapshot, false),
    ],
  }
}

function makeBenchmarkSections(
  snapshot: GameSnapshot,
  inGameReflections: InGameReflection[] | undefined,
): MovePromptSections {
  const ownCaptures = snapshot.captures[snapshot.toMove]
  const opponentCaptures =
    snapshot.captures[snapshot.toMove === 'B' ? 'W' : 'B']
  return {
    goRules: makeGoRulesSection(snapshot),
    instruction: [
      '3. INSTRUCTION TO PLACE ONE STONE',
      `You are ${snapshot.toMove === 'B' ? 'Black' : 'White'}. Place exactly one legal stone on an intersection shown as ".".`,
      ...(snapshot.previousError
        ? [
            `Your previous response was rejected: ${snapshot.previousError}. The position is unchanged; choose a different legal move.`,
          ]
        : []),
    ],
    responseSchema: [
      '4. JSON OUTPUT SCHEMA',
      'Example:',
      '{"move":[3,4],"reason":"brief reason","in_game_reflections":[{"number":1,"reflection":"general lesson"}]}',
      'Required fields: move (exactly two integers in [column,row] order) and reason (a non-empty string).',
      `Coordinates are zero-based from the top-left: column first, then row, each from 0 to ${snapshot.size - 1}.`,
      'Use [-1,-1] to pass and [-2,-2] to resign.',
      'Optional field: in_game_reflections, an array of objects containing only number (a positive integer) and reflection (a non-empty string). Omit it or use an empty array when no new lesson is warranted. It is a patch: use the next unused positive number for a new lesson, or reuse a number to replace an incorrect earlier entry.',
      'Create and revise reflections carefully: base each one on concrete evidence from the current game, keep it concise and generally reusable, and correct it if later play disproves it.',
      'Still be willing to summarize a useful lesson when the evidence is strong; do not wait for perfect certainty or the end of the game.',
      'Do not include any other top-level or nested fields.',
      'Return JSON only, without Markdown fences.',
    ],
    currentPosition: [
      '5. CURRENT BOARD AND PREVIOUS MOVES',
      'Current in-game reflections (this game only):',
      formatInGameReflections(inGameReflections),
      `To move: ${snapshot.toMove}`,
      `Capture totals: you have captured ${ownCaptures} opponent stones; the opponent has captured ${opponentCaptures} of your stones.`,
      asciiBoard(snapshot),
      'Previous moves:',
      formatPromptMoves(snapshot, true),
    ],
  }
}

function makeGoRulesSection(snapshot: GameSnapshot) {
  return [
    '1. GO RULES',
    `- The game is played on a ${snapshot.size}x${snapshot.size} grid. Black moves first, then Black and White alternate turns.`,
    '- On a turn, place one stone on an empty intersection. Stones remain there unless captured.',
    '- Orthogonally adjacent stones of one color form a chain and share liberties: orthogonally adjacent empty intersections.',
    '- After placing a stone, remove every adjacent opposing chain with no liberties. A move that leaves its own chain with no liberties after those captures is suicide and is illegal.',
    '- Positional whole-board repetition is prohibited: a move may not recreate any earlier complete board position.',
    '- Passing is legal. Two consecutive passes end play for scoring. A player may resign at any time.',
    `- Use Chinese area scoring. Each color scores its living stones on the board plus empty intersections surrounded only by that color. Captured stones do not add points directly; their removal can create territory. Neutral intersections score for neither side. White adds ${snapshot.komi} komi; the higher total wins.`,
  ]
}

export function formatInGameReflections(
  reflections: InGameReflection[] | undefined,
) {
  return reflections?.length
    ? reflections.map((reflection) => JSON.stringify(reflection)).join('\n')
    : '(none yet)'
}

function formatPromptMoves(snapshot: GameSnapshot, includePoint: boolean) {
  return snapshot.moves.length
    ? snapshot.moves
        .map((move) => formatPromptMove(move, snapshot, includePoint))
        .join('\n')
    : '(none)'
}

function formatPromptMove(
  move: GameSnapshot['moves'][number],
  snapshot: GameSnapshot,
  includePoint: boolean,
) {
  const point =
    includePoint && move.point ? ` [${move.point[0]},${move.point[1]}]` : ''
  return `${move.number}. ${move.color} ${move.coordinate ?? move.action}${point}${formatCapturedLocations(move, snapshot.size)}`
}

function formatCapturedLocations(
  move: GameSnapshot['moves'][number],
  size: BoardSize,
) {
  if (!move.capturedPoints?.length) return ''
  return `; captured ${move.capturedPoints.length} at ${move.capturedPoints
    .map(
      (point) =>
        `${pointToCoordinate(point, size)} [${point[0]},${point[1]}]`,
    )
    .join(', ')}`
}
