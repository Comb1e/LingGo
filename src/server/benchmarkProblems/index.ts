import {createHash} from 'node:crypto'
import {readFileSync, readdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {z} from 'zod'
import {coordinateToPoint} from '../../shared/coordinates'
import {
  boardSizeSchema,
  type BoardSize,
  type Move,
  type PlayerAction,
  type GameSnapshot,
  type BenchmarkProblemView,
} from '../../shared/types'
import {boardHash, emptyBoard, makeSnapshot, playStone, replay} from '../go'

const problemActionSchema = z.union([
  z.object({action: z.literal('play'), coordinate: z.string().min(2)}),
  z.object({action: z.literal('pass')}),
  z.object({action: z.literal('resign')}),
])
const problemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  size: boardSizeSchema,
  komi: z.number().min(-100).max(100),
  moves: z.array(
    z.object({color: z.enum(['B', 'W']), move: z.string().min(1)}),
  ),
  sideToMove: z.enum(['B', 'W']),
  expected: problemActionSchema.optional(),
  expectedAction: problemActionSchema.optional(),
  solution: z.array(problemActionSchema).min(1).optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  setup: z
    .object({black: z.array(z.string()), white: z.array(z.string())})
    .optional(),
  source: z.string().url().optional(),
})
export type BenchmarkProblem = Omit<
  z.infer<typeof problemSchema>,
  'expected'
> & {
  expected: PlayerAction
  solution: PlayerAction[]
  snapshot: GameSnapshot
}
export type BenchmarkProblemSet = {
  id: string
  version: string
  checksum: string
  problems: BenchmarkProblem[]
  path: string
  source?: string
  license?: string
  attribution?: string
}

export function problemView(problem: BenchmarkProblem): BenchmarkProblemView {
  return {
    id: problem.id,
    title: problem.title,
    tags: problem.tags,
    size: problem.size,
    komi: problem.komi,
    sideToMove: problem.sideToMove,
    board: problem.snapshot.board,
    moves: problem.snapshot.moves,
    captures: problem.snapshot.captures,
  }
}

const root = dirname(fileURLToPath(import.meta.url))

export function loadProblemSet(id: string): BenchmarkProblemSet {
  const files = readdirSync(root).filter((name) => name.endsWith('.jsonl'))
  const path = join(root, `${id}.jsonl`)
  if (!files.includes(`${id}.jsonl`))
    throw new Error(`Problem set not found: ${id}`)
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) throw new Error('Problem set is empty')
  const header = JSON.parse(lines[0]) as {
    setId?: string
    version?: string
    source?: string
    license?: string
    attribution?: string
  }
  if (header.setId !== id || !header.version)
    throw new Error('Invalid problem-set header')
  const seen = new Set<string>()
  const problems = lines.slice(1).map((line) => {
    const parsed = problemSchema.parse(JSON.parse(line))
    if (parsed.size !== 19)
      throw new Error(`Problem ${parsed.id} must use a 19x19 board`)
    const expectedInput = parsed.expected ?? parsed.expectedAction
    if (!expectedInput) throw new Error('Problem expected action is missing')
    if (parsed.setup && parsed.moves.length)
      throw new Error(`Problem ${parsed.id} cannot combine setup and moves`)
    let ended = false
    let consecutivePasses = 0
    for (const move of parsed.moves) {
      if (ended)
        throw new Error(`Problem ${parsed.id} has moves after game end`)
      if (move.move === 'resign') ended = true
      consecutivePasses = move.move === 'pass' ? consecutivePasses + 1 : 0
      if (consecutivePasses >= 2) ended = true
    }
    if (seen.has(parsed.id))
      throw new Error(`Duplicate problem ID: ${parsed.id}`)
    seen.add(parsed.id)
    const moves: Move[] = parsed.moves.map((move, moveIndex) => {
      const action =
        move.move === 'pass' || move.move === 'resign' ? move.move : 'play'
      return {
        number: moveIndex + 1,
        color: move.color,
        action,
        coordinate: action === 'play' ? move.move : undefined,
        point:
          action === 'play'
            ? coordinateToPoint(move.move, parsed.size)
            : undefined,
        captured: 0,
      }
    })
    const setupBoard = parsed.setup ? emptyBoard(parsed.size) : undefined
    if (setupBoard && parsed.setup) {
      for (const [color, coordinates] of [
        ['B', parsed.setup.black],
        ['W', parsed.setup.white],
      ] as const) {
        for (const coordinate of coordinates) {
          const point = coordinateToPoint(coordinate, parsed.size)
          if (setupBoard[point[1]][point[0]] !== 0)
            throw new Error(
              `Problem ${parsed.id} setup overlaps at ${coordinate}`,
            )
          setupBoard[point[1]][point[0]] = color === 'B' ? 1 : 2
        }
      }
    }
    const state = setupBoard
      ? {
          board: setupBoard,
          toMove: parsed.sideToMove,
          captures: {B: 0, W: 0},
          passCounts: {B: 0, W: 0},
          hashes: new Set([boardHash(setupBoard)]),
          consecutivePasses: 0,
          capturedPointsByMove: [],
        }
      : replay(parsed.size, moves)
    if (state.toMove !== parsed.sideToMove)
      throw new Error(
        `Problem ${parsed.id} sideToMove does not match move history`,
      )
    if (ended)
      throw new Error(`Problem ${parsed.id} expected action follows game end`)
    const expected = normalizeAction(expectedInput, parsed.size)
    const solution = (parsed.solution ?? [expectedInput]).map((action) =>
      normalizeAction(action, parsed.size),
    )
    const firstSolution = solution[0]
    if (
      firstSolution.action !== expected.action ||
      (firstSolution.action === 'play' &&
        firstSolution.coordinate.toUpperCase() !==
          (expected.action === 'play' ? expected.coordinate.toUpperCase() : ''))
    )
      throw new Error(
        `Problem ${parsed.id} expected action does not match solution`,
      )
    try {
      validateSolution(solution, state, parsed.size, parsed.sideToMove)
    } catch (error) {
      throw new Error(
        `Problem ${parsed.id} has an invalid solution: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {cause: error},
      )
    }
    if (expected.action === 'play') {
      playStone(
        state.board as any,
        parsed.sideToMove,
        coordinateToPoint(expected.coordinate, parsed.size),
        state.hashes,
      )
    } else if (
      expected.action === 'pass' &&
      state.passCounts[parsed.sideToMove] >= 2
    ) {
      throw new Error(`Problem ${parsed.id} expected pass is illegal`)
    }
    const snapshot = setupBoard
      ? {
          size: parsed.size,
          komi: parsed.komi,
          board: setupBoard,
          toMove: parsed.sideToMove,
          moves: [],
          captures: {B: 0, W: 0},
          rules:
            'Japanese territory scoring; positional whole-board repetition; suicide prohibited; komi applies to White.',
        }
      : makeSnapshot(parsed.size, parsed.komi, moves)
    return {
      ...parsed,
      expected,
      solution,
      snapshot,
    }
  })
  return {
    id,
    version: header.version,
    checksum: createHash('sha256').update(raw).digest('hex'),
    problems,
    path,
    source: header.source,
    license: header.license,
    attribution: header.attribution,
  }
}

function validateSolution(
  solution: PlayerAction[],
  initial: {
    board: number[][]
    toMove: 'B' | 'W'
    hashes: Set<string>
    passCounts?: {B: number; W: number}
  },
  size: BoardSize,
  sideToMove: 'B' | 'W',
) {
  let board = initial.board as any
  let toMove = sideToMove
  const hashes = new Set(initial.hashes)
  const passCounts = {...(initial.passCounts ?? {B: 0, W: 0})}
  for (const action of solution) {
    if (toMove !== sideToMove && action.action === 'resign') break
    if (action.action === 'play') {
      board = playStone(
        board,
        toMove,
        coordinateToPoint(action.coordinate, size),
        hashes,
      ).board
      hashes.add(boardHash(board))
      toMove = toMove === 'B' ? 'W' : 'B'
    } else if (action.action === 'pass') {
      if (passCounts[toMove] >= 2)
        throw new Error('Solution pass limit exceeded')
      passCounts[toMove] += 1
      toMove = toMove === 'B' ? 'W' : 'B'
    } else break
  }
}

export function listProblemSets(): Array<
  Pick<
    BenchmarkProblemSet,
    'id' | 'version' | 'checksum' | 'source' | 'license' | 'attribution'
  > & {count: number}
> {
  return readdirSync(root)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const set = loadProblemSet(name.slice(0, -'.jsonl'.length))
      return {
        id: set.id,
        version: set.version,
        checksum: set.checksum,
        count: set.problems.length,
        source: set.source,
        license: set.license,
        attribution: set.attribution,
      }
    })
}

export function normalizeAction(
  action: z.infer<typeof problemActionSchema>,
  size: BoardSize,
): PlayerAction {
  if (action.action === 'play') {
    coordinateToPoint(action.coordinate, size)
    return {action: 'play', coordinate: action.coordinate, comment: ''}
  }
  return {action: action.action, comment: ''}
}

export function scoreProblemAction(
  action: PlayerAction | undefined,
  expected: PlayerAction,
  snapshot: GameSnapshot,
): {legal: boolean; correct: boolean; reason?: string; board?: number[][]} {
  if (!action) return {legal: false, correct: false, reason: 'Malformed action'}
  let resultingBoard: number[][] | undefined
  try {
    if (action.action === 'play') {
      const state = snapshot.moves.length
        ? replay(snapshot.size, snapshot.moves)
        : {
            board: snapshot.board,
            toMove: snapshot.toMove,
            hashes: new Set([boardHash(snapshot.board as any)]),
          }
      resultingBoard = playStone(
        state.board as any,
        snapshot.toMove,
        coordinateToPoint(action.coordinate, snapshot.size),
        state.hashes,
      ).board
    } else if (action.action === 'pass') {
      const state = snapshot.moves.length
        ? replay(snapshot.size, snapshot.moves)
        : {board: snapshot.board}
      const count = snapshot.moves.filter(
        (move) => move.color === snapshot.toMove && move.action === 'pass',
      ).length
      if (count >= 2)
        return {legal: false, correct: false, reason: 'Pass limit exceeded'}
      resultingBoard = state.board
    } else {
      resultingBoard = snapshot.board
    }
  } catch (error) {
    return {
      legal: false,
      correct: false,
      reason: error instanceof Error ? error.message : 'Illegal action',
    }
  }
  const same =
    action.action === expected.action &&
    (action.action !== 'play' ||
      action.coordinate.toUpperCase() ===
        (expected as any).coordinate.toUpperCase())
  return {
    legal: true,
    correct: same,
    reason: same ? undefined : 'Action did not match expected answer',
    board: resultingBoard,
  }
}

export function scoreProblemSequence(
  actions: PlayerAction[],
  expected: PlayerAction[],
  snapshot: GameSnapshot,
): {
  legal: boolean
  correct: boolean
  complete: boolean
  step: number
  reason?: string
  board?: number[][]
  nextExpectedAction?: PlayerAction
} {
  if (!actions.length)
    return {
      legal: false,
      correct: false,
      complete: false,
      step: 0,
      reason: 'Malformed action sequence',
    }
  const initial = snapshot.moves.length
    ? replay(snapshot.size, snapshot.moves)
    : {
        board: snapshot.board,
        toMove: snapshot.toMove,
        hashes: new Set([boardHash(snapshot.board as any)]),
        passCounts: {B: 0, W: 0},
      }
  let board = initial.board as any
  let toMove = initial.toMove
  const hashes = new Set(initial.hashes)
  const passCounts = {...initial.passCounts}
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]
    const expectedAction = expected[index]
    if (!expectedAction)
      return {
        legal: false,
        correct: false,
        complete: false,
        step: index,
        reason: 'Too many actions',
        board,
      }
    try {
      if (action.action === 'play') {
        board = playStone(
          board,
          toMove,
          coordinateToPoint(action.coordinate, snapshot.size),
          hashes,
        ).board
        hashes.add(boardHash(board))
      } else if (action.action === 'pass') {
        if (passCounts[toMove] >= 2) throw new Error('Pass limit exceeded')
        passCounts[toMove] += 1
      }
    } catch (error) {
      return {
        legal: false,
        correct: false,
        complete: false,
        step: index,
        reason: error instanceof Error ? error.message : 'Illegal action',
        board,
      }
    }
    const same =
      action.action === expectedAction.action &&
      (action.action !== 'play' ||
        (expectedAction.action === 'play' &&
          action.coordinate.toUpperCase() ===
            expectedAction.coordinate.toUpperCase()))
    if (!same)
      return {
        legal: true,
        correct: false,
        complete: false,
        step: index,
        reason: 'Action did not match expected answer',
        board,
      }
    if (action.action !== 'resign') toMove = toMove === 'B' ? 'W' : 'B'
  }
  const complete = actions.length === expected.length
  return {
    legal: true,
    correct: true,
    complete,
    step: actions.length,
    board,
    nextExpectedAction: complete ? undefined : expected[actions.length],
  }
}
