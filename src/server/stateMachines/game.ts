import type {Game, GameStatus} from '../../shared/types'
import {
  defineStateMachine,
  invalidTransition,
  transition,
  type StateMachine,
} from './core'

type GameLifecycleEvent =
  | {type: 'activate'}
  | {type: 'pause'}
  | {type: 'fail'}
  | {type: 'score'}
  | {type: 'finish'}
  | {type: 'restore'; status: GameStatus}

const allowed: Record<
  Exclude<GameLifecycleEvent['type'], 'restore'>,
  GameStatus[]
> = {
  activate: ['active', 'paused', 'error', 'scoring', 'finished'],
  pause: ['active', 'paused', 'error'],
  fail: ['active', 'paused', 'error'],
  score: ['active', 'paused', 'scoring'],
  finish: ['active', 'paused', 'scoring', 'error', 'finished'],
}

const targets: Record<
  Exclude<GameLifecycleEvent['type'], 'restore'>,
  GameStatus
> = {
  activate: 'active',
  pause: 'paused',
  fail: 'error',
  score: 'scoring',
  finish: 'finished',
}

export const gameLifecycleMachine: StateMachine<Game, GameLifecycleEvent> =
  defineStateMachine<Game, GameLifecycleEvent>({
    name: 'game lifecycle',
    state: (game) => game.status,
    transition(game, event): Game {
      if (event.type === 'restore') return {...game, status: event.status}
      if (!allowed[event.type].includes(game.status))
        return invalidTransition(gameLifecycleMachine, game, event)
      return {...game, status: targets[event.type]}
    },
  })

export function transitionGame(game: Game, event: GameLifecycleEvent) {
  Object.assign(game, transition(gameLifecycleMachine, game, event))
  return game
}
