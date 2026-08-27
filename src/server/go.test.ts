import {describe, expect, it} from 'vitest'
import {coordinateToPoint, pointToCoordinate} from '../shared/coordinates'
import type {BoardSize, Move} from '../shared/types'
import {
  asciiBoard,
  boardHash,
  emptyBoard,
  IllegalMoveError,
  makeSnapshot,
  playStone,
  replay,
  scoreBoard,
  toggleDeadChain,
} from './go'

describe('coordinates', () => {
  it.each([9, 13, 19] as BoardSize[])('round trips on %ix%i', (size) => {
    expect(coordinateToPoint('A1', size)).toEqual([0, size - 1])
    expect(pointToCoordinate([size - 1, 0], size)).toBe(
      `${size === 9 ? 'J' : size === 13 ? 'N' : 'T'}${size}`,
    )
  })
  it('skips the letter I', () =>
    expect(coordinateToPoint('J9', 9)).toEqual([8, 0]))
})

describe('ASCII board', () => {
  it('labels columns above the board only', () => {
    const lines = asciiBoard(makeSnapshot(9, 7.5, [])).split('\n')

    expect(lines[0]).toBe('   A B C D E F G H J')
    expect(lines.at(-1)).toBe(' 1 . . . . . . . . .')
    expect(lines.filter((line) => line === lines[0])).toHaveLength(1)
  })
})

describe('rules', () => {
  it('captures a surrounded chain', () => {
    const board = emptyBoard(9)
    board[1][1] = 2
    board[0][1] = board[1][0] = board[2][1] = 1
    const result = playStone(board, 'B', [2, 1], new Set([boardHash(board)]))
    expect(result.captured).toBe(1)
    expect(result.capturedPoints).toEqual([[1, 1]])
    expect(result.board[1][1]).toBe(0)
  })

  it('reconstructs capture locations in snapshots from older move records', () => {
    const moves: Move[] = [
      {number: 1, color: 'B', action: 'play', point: [1, 0], captured: 0},
      {number: 2, color: 'W', action: 'play', point: [1, 1], captured: 0},
      {number: 3, color: 'B', action: 'play', point: [0, 1], captured: 0},
      {number: 4, color: 'W', action: 'pass', captured: 0},
      {number: 5, color: 'B', action: 'play', point: [1, 2], captured: 0},
      {number: 6, color: 'W', action: 'pass', captured: 0},
      {number: 7, color: 'B', action: 'play', point: [2, 1], captured: 0},
    ]
    const snapshot = makeSnapshot(9, 7.5, moves)

    expect(snapshot.captures).toEqual({B: 1, W: 0})
    expect(snapshot.moves[6]).toMatchObject({captured: 1, capturedPoints: [[1, 1]]})
  })

  it('rejects suicide', () => {
    const board = emptyBoard(9)
    board[0][1] = board[1][0] = board[1][2] = board[2][1] = 2
    expect(() => playStone(board, 'B', [1, 1], new Set())).toThrow(
      IllegalMoveError,
    )
  })

  it('rejects positional repetition', () => {
    const board = emptyBoard(9)
    const proposed = playStone(board, 'B', [0, 0], new Set()).board
    expect(() =>
      playStone(board, 'B', [0, 0], new Set([boardHash(proposed)])),
    ).toThrow('repeats')
  })

  it('tracks passes and turn order', () => {
    const moves: Move[] = [
      {number: 1, color: 'B', action: 'pass', captured: 0},
      {number: 2, color: 'W', action: 'pass', captured: 0},
    ]
    expect(replay(9, moves).consecutivePasses).toBe(2)
    expect(replay(9, moves).toMove).toBe('B')
  })

  it('toggles whole dead chains', () => {
    const board = emptyBoard(9)
    board[0][0] = board[0][1] = 1
    const dead = toggleDeadChain(board, [], 'A9', 9)
    expect(dead).toHaveLength(2)
    expect(toggleDeadChain(board, dead, 'B9', 9)).toHaveLength(0)
  })

  it.each([9, 13, 19] as BoardSize[])(
    'scores Chinese area on %ix%i',
    (size) => {
      const board = emptyBoard(size)
      board[0][0] = 1
      board[size - 1][size - 1] = 2
      const score = scoreBoard(board, 7.5, [])
      expect(score.white).toBeGreaterThan(score.black)
      expect(score.result).toMatch(/^W\+/)
    },
  )
})
