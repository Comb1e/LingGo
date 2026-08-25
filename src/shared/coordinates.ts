import type {BoardSize, Point} from './types'

const COLUMNS = 'ABCDEFGHJKLMNOPQRST'

export function pointToCoordinate([x, y]: Point, size: BoardSize): string {
  if (x < 0 || y < 0 || x >= size || y >= size)
    throw new Error('Point outside board')
  return `${COLUMNS[x]}${size - y}`
}

export function coordinateToPoint(value: string, size: BoardSize): Point {
  const normalized = value.trim().toUpperCase()
  const match = /^([A-HJ-T])(\d{1,2})$/.exec(normalized)
  if (!match) throw new Error(`Invalid coordinate: ${value}`)
  const x = COLUMNS.indexOf(match[1])
  const row = Number(match[2])
  const y = size - row
  if (x < 0 || x >= size || y < 0 || y >= size)
    throw new Error(`Coordinate outside ${size}x${size} board`)
  return [x, y]
}

export function pointKey([x, y]: Point): string {
  return `${x},${y}`
}

export function sgfToPoint(value: string, size: BoardSize): Point {
  if (!/^[a-s]{2}$/.test(value)) throw new Error(`Invalid SGF point: ${value}`)
  const point: Point = [value.charCodeAt(0) - 97, value.charCodeAt(1) - 97]
  if (point[0] >= size || point[1] >= size)
    throw new Error('SGF point outside board')
  return point
}

export function pointToSgf([x, y]: Point): string {
  return String.fromCharCode(97 + x, 97 + y)
}
