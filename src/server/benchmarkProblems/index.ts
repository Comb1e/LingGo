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
import {makeSnapshot, playStone, replay} from '../go'

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
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
})
export type BenchmarkProblem = z.infer<typeof problemSchema> & {
  snapshot: GameSnapshot
}
export type BenchmarkProblemSet = {
  id: string
  version: string
  checksum: string
  problems: BenchmarkProblem[]
  path: string
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
  const header = JSON.parse(lines[0]) as {setId?: string; version?: string}
  if (header.setId !== id || !header.version)
    throw new Error('Invalid problem-set header')
  const seen = new Set<string>()
  const problems = lines.slice(1).map((line) => {
    const parsed = problemSchema.parse(JSON.parse(line))
    if (parsed.size !== 19)
      throw new Error(`Problem ${parsed.id} must use a 19x19 board`)
    const expectedInput = parsed.expected ?? parsed.expectedAction
    if (!expectedInput) throw new Error('Problem expected action is missing')
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
    const state = replay(parsed.size, moves)
    if (state.toMove !== parsed.sideToMove)
      throw new Error(
        `Problem ${parsed.id} sideToMove does not match move history`,
      )
    if (ended)
      throw new Error(`Problem ${parsed.id} expected action follows game end`)
    const expected = normalizeAction(expectedInput, parsed.size)
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
    return {
      ...parsed,
      expected,
      snapshot: makeSnapshot(parsed.size, parsed.komi, moves),
    }
  })
  return {
    id,
    version: header.version,
    checksum: createHash('sha256').update(raw).digest('hex'),
    problems,
    path,
  }
}

export function listProblemSets(): Array<
  Pick<BenchmarkProblemSet, 'id' | 'version' | 'checksum'> & {count: number}
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
): {legal: boolean; correct: boolean; reason?: string} {
  if (!action) return {legal: false, correct: false, reason: 'Malformed action'}
  try {
    if (action.action === 'play') {
      const state = replay(snapshot.size, snapshot.moves)
      playStone(
        state.board as any,
        snapshot.toMove,
        coordinateToPoint(action.coordinate, snapshot.size),
        state.hashes,
      )
    } else if (action.action === 'pass') {
      const count = snapshot.moves.filter(
        (move) => move.color === snapshot.toMove && move.action === 'pass',
      ).length
      if (count >= 2)
        return {legal: false, correct: false, reason: 'Pass limit exceeded'}
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
  }
}
