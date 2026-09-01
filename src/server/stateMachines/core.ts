export class InvalidTransitionError extends Error {
  constructor(machine: string, state: string, event: string) {
    super(`Invalid ${machine} transition: ${state} + ${event}`)
    this.name = 'InvalidTransitionError'
  }
}

export interface StateMachine<State, Event extends {type: string}> {
  readonly name: string
  readonly state: (value: State) => string
  readonly transition: (value: State, event: Event) => State
}

export function defineStateMachine<State, Event extends {type: string}>(
  machine: StateMachine<State, Event>,
) {
  return machine
}

export function transition<State, Event extends {type: string}>(
  machine: StateMachine<State, Event>,
  value: State,
  event: Event,
) {
  return machine.transition(value, event)
}

export function invalidTransition<State, Event extends {type: string}>(
  machine: Pick<StateMachine<State, Event>, 'name' | 'state'>,
  value: State,
  event: Event,
): never {
  throw new InvalidTransitionError(
    machine.name,
    machine.state(value),
    event.type,
  )
}
