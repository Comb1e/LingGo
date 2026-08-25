import {
  coordinateToPoint,
  pointKey,
  pointToCoordinate,
} from '../shared/coordinates'
import type {
  BoardSize,
  Color,
  GameSnapshot,
  Move,
  Point,
  Score,
} from '../shared/types'

export type Stone = 0 | 1 | 2
export type Board = Stone[][]

export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalMoveError'
  }
}

export function colorStone(color: Color): Stone {
  return color === 'B' ? 1 : 2
}

export function opposite(color: Color): Color {
  return color === 'B' ? 'W' : 'B'
}

export function emptyBoard(size: BoardSize): Board {
  return Array.from({length: size}, () => Array<Stone>(size).fill(0))
}

export function boardHash(board: Board): string {
  return board.map((row) => row.join('')).join('/')
}

function neighbors([x, y]: Point, size: number): Point[] {
  const values: Point[] = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ]
  return values.filter(
    ([nx, ny]) => nx >= 0 && ny >= 0 && nx < size && ny < size,
  )
}

export function chainAt(
  board: Board,
  start: Point,
): {stones: Point[]; liberties: Point[]} {
  const [sx, sy] = start
  const stone = board[sy]?.[sx]
  if (!stone) return {stones: [], liberties: []}
  const seen = new Set<string>()
  const libertyKeys = new Set<string>()
  const liberties: Point[] = []
  const stones: Point[] = []
  const queue: Point[] = [start]
  while (queue.length) {
    const point = queue.pop()!
    const key = pointKey(point)
    if (seen.has(key)) continue
    seen.add(key)
    stones.push(point)
    for (const next of neighbors(point, board.length)) {
      const value = board[next[1]][next[0]]
      if (value === stone && !seen.has(pointKey(next))) queue.push(next)
      if (value === 0 && !libertyKeys.has(pointKey(next))) {
        libertyKeys.add(pointKey(next))
        liberties.push(next)
      }
    }
  }
  return {stones, liberties}
}

export function playStone(
  board: Board,
  color: Color,
  point: Point,
  previousHashes: Set<string>,
): {board: Board; captured: number; capturedPoints: Point[]} {
  const [x, y] = point
  if (!board[y] || board[y][x] === undefined)
    throw new IllegalMoveError('Coordinate is outside the board')
  if (board[y][x] !== 0) throw new IllegalMoveError('Intersection is occupied')

  const next = board.map((row) => [...row]) as Board
  const own = colorStone(color)
  const enemy = colorStone(opposite(color))
  next[y][x] = own
  let captured = 0
  const capturedPoints: Point[] = []
  const visitedEnemy = new Set<string>()

  for (const adjacent of neighbors(point, next.length)) {
    if (
      next[adjacent[1]][adjacent[0]] !== enemy ||
      visitedEnemy.has(pointKey(adjacent))
    )
      continue
    const chain = chainAt(next, adjacent)
    chain.stones.forEach((stone) => visitedEnemy.add(pointKey(stone)))
    if (chain.liberties.length === 0) {
      for (const [cx, cy] of chain.stones) {
        next[cy][cx] = 0
        capturedPoints.push([cx, cy])
      }
      captured += chain.stones.length
    }
  }

  if (chainAt(next, point).liberties.length === 0)
    throw new IllegalMoveError('Suicide is not allowed')
  if (previousHashes.has(boardHash(next)))
    throw new IllegalMoveError('Move repeats an earlier whole-board position')
  return {board: next, captured, capturedPoints}
}

export interface ReplayResult {
  board: Board
  toMove: Color
  captures: {B: number; W: number}
  hashes: Set<string>
  consecutivePasses: number
  capturedPointsByMove: Point[][]
}

export function replay(size: BoardSize, moves: Move[]): ReplayResult {
  let board = emptyBoard(size)
  let toMove: Color = 'B'
  const captures = {B: 0, W: 0}
  const hashes = new Set([boardHash(board)])
  let consecutivePasses = 0
  const capturedPointsByMove: Point[][] = []
  for (const move of moves) {
    if (move.color !== toMove)
      throw new Error(`Invalid move order at move ${move.number}`)
    if (move.action === 'play') {
      if (!move.point) throw new Error(`Move ${move.number} has no point`)
      const result = playStone(board, move.color, move.point, hashes)
      board = result.board
      captures[move.color] += result.captured
      capturedPointsByMove.push(result.capturedPoints)
      hashes.add(boardHash(board))
      consecutivePasses = 0
    } else if (move.action === 'pass') {
      capturedPointsByMove.push([])
      consecutivePasses += 1
    } else {
      capturedPointsByMove.push([])
    }
    toMove = opposite(toMove)
  }
  return {board, toMove, captures, hashes, consecutivePasses, capturedPointsByMove}
}

export function makeSnapshot(
  size: BoardSize,
  komi: number,
  moves: Move[],
): GameSnapshot {
  const state = replay(size, moves)
  return {
    size,
    komi,
    board: state.board,
    toMove: state.toMove,
    moves: moves.map((move, index) => ({
      ...move,
      captured: state.capturedPointsByMove[index].length,
      capturedPoints: state.capturedPointsByMove[index],
    })),
    captures: state.captures,
    rules:
      'Chinese area scoring; positional whole-board repetition; suicide prohibited; komi applies to White.',
  }
}

export function asciiBoard(snapshot: GameSnapshot): string {
  const columns = Array.from(
    {length: snapshot.size},
    (_, x) => pointToCoordinate([x, snapshot.size - 1], snapshot.size)[0],
  )
  const rows = snapshot.board.map((row, y) => {
    const label = String(snapshot.size - y).padStart(2, ' ')
    return `${label} ${row.map((value) => (value === 1 ? 'X' : value === 2 ? 'O' : '.')).join(' ')}`
  })
  return [`   ${columns.join(' ')}`, ...rows, `   ${columns.join(' ')}`].join(
    '\n',
  )
}

export function toggleDeadChain(
  board: Board,
  dead: Point[],
  coordinate: string,
  size: BoardSize,
): Point[] {
  const point = coordinateToPoint(coordinate, size)
  if (board[point[1]][point[0]] === 0)
    throw new IllegalMoveError('Select a stone to mark its chain')
  const chain = chainAt(board, point).stones
  const current = new Set(dead.map(pointKey))
  const remove = chain.every((stone) => current.has(pointKey(stone)))
  for (const stone of chain) {
    if (remove) current.delete(pointKey(stone))
    else current.add(pointKey(stone))
  }
  return [...current].map((key) => key.split(',').map(Number) as Point)
}

export function scoreBoard(board: Board, komi: number, dead: Point[]): Score {
  const scored = board.map((row) => [...row]) as Board
  for (const [x, y] of dead) scored[y][x] = 0
  let black = 0
  let white = komi
  for (const row of scored) {
    for (const stone of row) {
      if (stone === 1) black += 1
      if (stone === 2) white += 1
    }
  }
  const territory: {B: Point[]; W: Point[]} = {B: [], W: []}
  const visited = new Set<string>()
  for (let y = 0; y < scored.length; y++) {
    for (let x = 0; x < scored.length; x++) {
      const start: Point = [x, y]
      if (scored[y][x] !== 0 || visited.has(pointKey(start))) continue
      const region: Point[] = []
      const borders = new Set<Stone>()
      const queue: Point[] = [start]
      while (queue.length) {
        const point = queue.pop()!
        if (visited.has(pointKey(point))) continue
        visited.add(pointKey(point))
        region.push(point)
        for (const adjacent of neighbors(point, scored.length)) {
          const value = scored[adjacent[1]][adjacent[0]]
          if (value === 0 && !visited.has(pointKey(adjacent)))
            queue.push(adjacent)
          if (value !== 0) borders.add(value)
        }
      }
      if (borders.size === 1 && borders.has(1)) {
        black += region.length
        territory.B.push(...region)
      }
      if (borders.size === 1 && borders.has(2)) {
        white += region.length
        territory.W.push(...region)
      }
    }
  }
  const margin = Math.abs(black - white)
  const result =
    black > white ? `B+${formatMargin(margin)}` : `W+${formatMargin(margin)}`
  return {black, white, territory, result}
}

function formatMargin(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
