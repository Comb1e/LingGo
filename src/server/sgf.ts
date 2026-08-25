import * as sgf from '@sabaki/sgf'
import {pointToCoordinate, pointToSgf, sgfToPoint} from '../shared/coordinates'
import type {BoardSize, Move} from '../shared/types'

export interface ImportedRecord {
  size: BoardSize
  komi: number
  blackName: string
  whiteName: string
  moves: Move[]
  result?: string
  warnings: string[]
}

export function importSgf(contents: string): ImportedRecord {
  const roots = sgf.parse(contents)
  if (!roots.length) throw new Error('SGF contains no game')
  const warnings: string[] = []
  if (roots.length > 1)
    warnings.push(
      `Imported the first game; omitted ${roots.length - 1} additional game(s).`,
    )
  const root = roots[0]
  const size = Number(root.data.SZ?.[0] ?? 19)
  if (![9, 13, 19].includes(size))
    throw new Error(`Unsupported board size: ${size}`)
  const boardSize = size as BoardSize
  if (hasSetup(root)) warnings.push('Unsupported setup markup was omitted.')

  const nodes = [] as sgf.SgfNode[]
  let current: sgf.SgfNode | undefined = root
  let variations = 0
  while (current) {
    nodes.push(current)
    if (current.children.length > 1) variations += current.children.length - 1
    current = current.children[0]
  }
  if (variations)
    warnings.push(
      `Imported the main line; omitted ${variations} variation branch(es).`,
    )
  if (nodes.slice(1).some(hasSetup))
    warnings.push('Unsupported setup markup was omitted.')

  const moves: Move[] = []
  for (const node of nodes) {
    const color = node.data.B ? 'B' : node.data.W ? 'W' : undefined
    if (!color) continue
    const raw = (node.data[color] ?? [''])[0]
    const point = raw ? sgfToPoint(raw, boardSize) : undefined
    moves.push({
      number: moves.length + 1,
      color,
      action: point ? 'play' : 'pass',
      point,
      coordinate: point ? pointToCoordinate(point, boardSize) : undefined,
      comment: node.data.C?.[0] ?? '',
      captured: 0,
    })
  }
  return {
    size: boardSize,
    komi: Number(root.data.KM?.[0] ?? 7.5),
    blackName: root.data.PB?.[0] ?? 'Black',
    whiteName: root.data.PW?.[0] ?? 'White',
    moves,
    result: root.data.RE?.[0] || undefined,
    warnings: [...new Set(warnings)],
  }
}

export function exportSgf(game: {
  size: BoardSize
  komi: number
  black: {name: string}
  white: {name: string}
  moves: Move[]
  result?: string
}): string {
  const root = [
    '(;FF[4]',
    'GM[1]',
    'CA[UTF-8]',
    `SZ[${game.size}]`,
    `KM[${game.komi}]`,
    `RU[Chinese]`,
    `PB[${escapeSgf(game.black.name)}]`,
    `PW[${escapeSgf(game.white.name)}]`,
    game.result ? `RE[${escapeSgf(game.result)}]` : '',
  ].join('')
  const moves = game.moves
    .map((move) => {
      const value =
        move.action === 'play' && move.point ? pointToSgf(move.point) : ''
      const comment = move.comment ? `C[${escapeSgf(move.comment)}]` : ''
      return `;${move.color}[${value}]${comment}`
    })
    .join('')
  return `${root}${moves})`
}

function hasSetup(node: sgf.SgfNode) {
  return Boolean(
    node.data.AB ||
    node.data.AW ||
    node.data.AE ||
    node.data.PL ||
    node.data.HA,
  )
}

function escapeSgf(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\]/g, '\\]')
    .replace(/\r?\n/g, '\n')
}
