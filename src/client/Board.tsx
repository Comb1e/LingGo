import {useEffect, useRef, useState} from 'react'
import {createElement, render} from 'preact'
import {BoundedGoban} from '@sabaki/shudan'
import type {Color, Game, KataGoCandidate, Move, Point} from '../shared/types'

export function Board({
  game,
  onPoint,
  board = game.board,
  lastMove = game.moves.at(-1),
  dead = game.dead,
  busy = game.pending,
  disabled = false,
  recommendations = [],
  recommendationColor = game.toMove,
}: {
  game: Game
  onPoint: (point: Point) => void
  board?: number[][]
  lastMove?: Move
  dead?: Point[]
  busy?: boolean
  disabled?: boolean
  recommendations?: KataGoCandidate[]
  recommendationColor?: Color
}) {
  const host = useRef<HTMLDivElement>(null)
  const [dimension, setDimension] = useState(0)

  useEffect(() => {
    const container = host.current
    if (!container) return
    const measure = () =>
      setDimension(
        Math.floor(Math.min(container.clientWidth, container.clientHeight)),
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!host.current || !dimension) return
    const container = host.current
    const signMap = board.map((row) =>
      row.map((stone) => (stone === 1 ? 1 : stone === 2 ? -1 : 0)),
    )
    const markerMap = board.map((row) => row.map(() => null as any))
    if (lastMove?.point && lastMove.action === 'play')
      markerMap[lastMove.point[1]][lastMove.point[0]] = {type: 'circle'}
    for (const [x, y] of dead) markerMap[y][x] = {type: 'cross'}
    recommendations.forEach((candidate, index) => {
      const [x, y] = candidate.point
      if (board[y]?.[x] !== 0) return
      signMap[y][x] = recommendationColor === 'B' ? 1 : -1
      markerMap[y][x] = {
        type: 'label',
        label: `${Math.round(candidate.winRate * 100)}%`,
        tooltip: `#${index + 1} ${candidate.move}: ${(candidate.winRate * 100).toFixed(1)}% win rate`,
      }
    })
    render(
      createElement(BoundedGoban, {
        maxWidth: dimension,
        maxHeight: dimension,
        maxVertexSize: game.size === 19 ? 42 : 58,
        signMap,
        markerMap,
        showCoordinates: true,
        coordX: (x: number) => 'ABCDEFGHJKLMNOPQRST'[x],
        coordY: (y: number) => game.size - y,
        animateStonePlacement: true,
        busy,
        onVertexClick: disabled
          ? undefined
          : (_event: MouseEvent, point: Point) => onPoint(point),
      }),
      container,
    )
    return () => render(null, container)
  }, [
    board,
    busy,
    dead,
    dimension,
    disabled,
    game.size,
    lastMove,
    onPoint,
    recommendationColor,
    recommendations,
  ])
  return (
    <div
      className={`board-host${recommendations.length ? ' has-katago-recommendations' : ''}`}
      ref={host}
      aria-label={`${game.size} by ${game.size} Go board`}
    />
  )
}
