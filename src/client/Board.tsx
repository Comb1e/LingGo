import {useEffect, useRef, useState} from 'react'
import {createElement, render} from 'preact'
import {BoundedGoban} from '@sabaki/shudan'
import type {Game, Point} from '../shared/types'

export function Board({
  game,
  onPoint,
}: {
  game: Game
  onPoint: (point: Point) => void
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
    const signMap = game.board.map((row) =>
      row.map((stone) => (stone === 1 ? 1 : stone === 2 ? -1 : 0)),
    )
    const markerMap = game.board.map((row) => row.map(() => null as any))
    const last = game.moves.at(-1)
    if (last?.point && last.action === 'play')
      markerMap[last.point[1]][last.point[0]] = {type: 'circle'}
    for (const [x, y] of game.dead) markerMap[y][x] = {type: 'cross'}
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
        busy: game.pending,
        onVertexClick: (_event: MouseEvent, point: Point) => onPoint(point),
      }),
      container,
    )
    return () => render(null, container)
  }, [dimension, game, onPoint])
  return (
    <div
      className="board-host"
      ref={host}
      aria-label={`${game.size} by ${game.size} Go board`}
    />
  )
}
