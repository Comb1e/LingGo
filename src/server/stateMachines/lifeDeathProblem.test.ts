import {describe, expect, it} from 'vitest'
import {
  transitionLifeDeathProblem,
  type LifeDeathProblemWorkflowState,
} from './lifeDeathProblem'

describe('life-and-death problem workflow', () => {
  it('keeps opening failures in reason-only feedback until the limit', () => {
    let state: LifeDeathProblemWorkflowState = {
      phase: 'initial_problem',
      failedTries: 0,
    }
    for (let failedTry = 1; failedTry <= 9; failedTry += 1) {
      state = transitionLifeDeathProblem(state, {
        type: 'failed_action',
        attemptLimit: 10,
        hadCorrectProgress: false,
      })
      expect(state).toEqual({
        phase: 'root_feedback',
        failedTries: failedTry,
      })
    }
    expect(
      transitionLifeDeathProblem(state, {
        type: 'failed_action',
        attemptLimit: 10,
        hadCorrectProgress: false,
      }),
    ).toEqual({phase: 'updating_notebook', failedTries: 10})
  })

  it('restarts a failed partial branch and resets only after notebook update', () => {
    const partial = transitionLifeDeathProblem(
      {phase: 'initial_problem', failedTries: 3},
      {type: 'correct_action', complete: false},
    )
    const restart = transitionLifeDeathProblem(partial, {
      type: 'failed_action',
      attemptLimit: 10,
      hadCorrectProgress: true,
    })
    expect(restart).toEqual({phase: 'redo_problem', failedTries: 4})
    const updating = transitionLifeDeathProblem(
      {...restart, failedTries: 9},
      {type: 'failed_action', attemptLimit: 10, hadCorrectProgress: false},
    )
    expect(
      transitionLifeDeathProblem(updating, {type: 'notebook_updated'}),
    ).toEqual({phase: 'initial_problem', failedTries: 0})
  })
})
