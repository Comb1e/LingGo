import {
  defineStateMachine,
  invalidTransition,
  transition,
  type StateMachine,
} from './core'

export type LifeDeathProblemWorkflowPhase =
  | 'initial_problem'
  | 'root_feedback'
  | 'continuing_solution'
  | 'redo_problem'
  | 'updating_notebook'

export interface LifeDeathProblemWorkflowState {
  phase: LifeDeathProblemWorkflowPhase
  failedTries: number
}

type LifeDeathProblemWorkflowEvent =
  | {type: 'correct_action'; complete: boolean}
  | {
      type: 'failed_action'
      attemptLimit: number
      hadCorrectProgress: boolean
    }
  | {type: 'notebook_updated'}

export const lifeDeathProblemWorkflowMachine: StateMachine<
  LifeDeathProblemWorkflowState,
  LifeDeathProblemWorkflowEvent
> = defineStateMachine({
  name: 'life-and-death problem workflow',
  state: ({phase, failedTries}) => `${phase}/${failedTries}`,
  transition(state, event) {
    if (event.type === 'notebook_updated') {
      if (state.phase !== 'updating_notebook')
        return invalidTransition(lifeDeathProblemWorkflowMachine, state, event)
      return {phase: 'initial_problem', failedTries: 0}
    }
    if (state.phase === 'updating_notebook')
      return invalidTransition(lifeDeathProblemWorkflowMachine, state, event)
    if (event.type === 'correct_action')
      return {
        ...state,
        phase: event.complete ? 'updating_notebook' : 'continuing_solution',
      }
    const failedTries = state.failedTries + 1
    return {
      failedTries,
      phase:
        failedTries >= event.attemptLimit
          ? 'updating_notebook'
          : event.hadCorrectProgress
            ? 'redo_problem'
            : 'root_feedback',
    }
  },
})

export function transitionLifeDeathProblem(
  state: LifeDeathProblemWorkflowState,
  event: LifeDeathProblemWorkflowEvent,
) {
  return transition(lifeDeathProblemWorkflowMachine, state, event)
}
