import {pointToCoordinate} from '../shared/coordinates'
import type {BoardSize, GameSnapshot} from '../shared/types'
import {asciiBoard} from './go'

export type MovePromptOptions = {mode: 'ordinary'} | {mode: 'benchmark'}

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
    : makeBenchmarkSections(snapshot)
}

function makeOrdinarySections(snapshot: GameSnapshot): MovePromptSections {
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
      '{"move":"D4","reason":"brief reason for this move"}',
      'move must be one letter-number coordinate exactly as labeled on the board. Columns use letters and skip I; rows use numbers counted from the bottom.',
      'Use {"move":"pass","reason":"..."} to pass or {"move":"resign","reason":"..."} to resign.',
    ],
    currentPosition: [
      '5. CURRENT POSITION',
      `To move: ${snapshot.toMove === 'B' ? 'Black (X)' : 'White (O)'}`,
      `Captures: Black ${snapshot.captures.B}, White ${snapshot.captures.W}.`,
      formatPassCounts(snapshot),
      'X = Black stone, O = White stone, . = empty intersection.',
      '',
      asciiBoard(snapshot),
      '',
      'Move list:',
      formatPromptMoves(snapshot),
    ],
  }
}

function makeBenchmarkSections(snapshot: GameSnapshot): MovePromptSections {
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
      '{"move":"D4","reason":"brief reason"}',
      'Required fields: move (one letter-number coordinate exactly as labeled on the board) and reason (a non-empty string).',
      'Columns use letters and skip I; rows use numbers counted from the bottom.',
      'Use "pass" to pass and "resign" to resign.',
      'Do not include any other top-level or nested fields.',
      'IMPORTANT: The correct output is pure JSON: your entire response must be exactly one valid JSON object and nothing else. Do not add explanations, introductory or trailing text, comments, or Markdown fences.',
    ],
    currentPosition: [
      '5. CURRENT BOARD',
      `To move: ${snapshot.toMove}`,
      `Captures: Black ${snapshot.captures.B}, White ${snapshot.captures.W}.`,
      formatPassCounts(snapshot),
      asciiBoard(snapshot),
    ],
  }
}

export function formatCanonicalGoRules(
  settings: Pick<GameSnapshot, 'size' | 'komi'>,
) {
  return [
    "- LEGAL MOVE: A play is legal only when it places one stone on an empty intersection, removes adjacent opposing chains with no liberties, leaves the played stone's chain with at least one liberty, and does not recreate any earlier complete board position.",
    `- The game is played on a ${settings.size}x${settings.size} grid. Black moves first, then Black and White alternate turns.`,
    '- On your turn, place one stone of your color on an empty intersection. Once placed, a stone does not move; it stays on the board until it is captured and removed.',
    '- Orthogonally adjacent stones of one color form a chain and share liberties: orthogonally adjacent empty intersections.',
    '- After placing a stone, remove every adjacent opposing chain with no liberties. A move that leaves its own chain with no liberties after those captures is suicide and is illegal.',
    '- Positional whole-board repetition is prohibited: a move may not recreate any earlier complete board position.',
    '- Passing is legal, but each player may pass at most twice in one game. Two consecutive passes end play for scoring. A player may resign at any time.',
    `- Use Chinese area scoring. Each color scores its living stones on the board plus empty intersections surrounded only by that color. Captured stones do not add points directly; their removal can create territory. Neutral intersections score for neither side. White adds ${settings.komi} komi; the higher total wins.`,
    '- Coordinates use column letters from left to right, skipping I, and row numbers from bottom to top.',
  ]
}

function makeGoRulesSection(snapshot: GameSnapshot) {
  return ['1. GO RULES', ...formatCanonicalGoRules(snapshot)]
}

function formatPassCounts(snapshot: GameSnapshot) {
  const passCounts = snapshot.moves.reduce(
    (counts, move) => {
      if (move.action === 'pass') counts[move.color] += 1
      return counts
    },
    {B: 0, W: 0},
  )
  return `Passes: Black ${passCounts.B}/2, White ${passCounts.W}/2.`
}

function formatPromptMoves(snapshot: GameSnapshot) {
  return snapshot.moves.length
    ? snapshot.moves.map((move) => formatPromptMove(move, snapshot)).join('\n')
    : '(none)'
}

function formatPromptMove(
  move: GameSnapshot['moves'][number],
  snapshot: GameSnapshot,
) {
  return `${move.number}. ${move.color} ${move.coordinate ?? move.action}${formatCapturedLocations(move, snapshot.size)}`
}

function formatCapturedLocations(
  move: GameSnapshot['moves'][number],
  size: BoardSize,
) {
  if (!move.capturedPoints?.length) return ''
  return `; captured ${move.capturedPoints.length} at ${move.capturedPoints
    .map((point) => pointToCoordinate(point, size))
    .join(', ')}`
}
