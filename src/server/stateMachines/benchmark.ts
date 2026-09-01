import type {
  BenchmarkPhase,
  BenchmarkRun,
  BenchmarkStatus,
  BenchmarkSubstate,
} from '../../shared/types'
import {
  defineStateMachine,
  invalidTransition,
  transition,
  type StateMachine,
} from './core'

type BenchmarkLifecycleEvent =
  | {
      type: 'update'
      status?: BenchmarkStatus
      phase?: BenchmarkPhase
      substate?: BenchmarkSubstate
    }
  | {type: 'pause'; substate: BenchmarkSubstate}
  | {type: 'resume'; substate: BenchmarkSubstate}
  | {type: 'cancel'}
  | {type: 'invalidate'}
  | {type: 'complete'}

const terminalStatuses: BenchmarkStatus[] = [
  'completed',
  'cancelled',
  'invalid',
]

export const benchmarkLifecycleMachine: StateMachine<
  BenchmarkRun,
  BenchmarkLifecycleEvent
> = defineStateMachine<BenchmarkRun, BenchmarkLifecycleEvent>({
  name: 'benchmark lifecycle',
  state: (run) => `${run.status}/${run.phase}/${run.substate.kind}`,
  transition(run, event): BenchmarkRun {
    if (event.type === 'update') {
      const status = event.status ?? run.status
      if (terminalStatuses.includes(run.status) && status !== run.status)
        return invalidTransition(benchmarkLifecycleMachine, run, event)
      return {
        ...run,
        status,
        phase: event.phase ?? run.phase,
        substate: event.substate ?? run.substate,
      }
    }
    if (event.type === 'pause') {
      if (!['queued', 'running', 'paused'].includes(run.status))
        return invalidTransition(benchmarkLifecycleMachine, run, event)
      return {...run, status: 'paused', substate: event.substate}
    }
    if (event.type === 'resume') {
      if (!['queued', 'running', 'paused'].includes(run.status))
        return invalidTransition(benchmarkLifecycleMachine, run, event)
      return {...run, status: 'running', substate: event.substate}
    }
    if (event.type === 'cancel') {
      if (!['queued', 'running', 'paused'].includes(run.status))
        return invalidTransition(benchmarkLifecycleMachine, run, event)
      return {...run, status: 'cancelled', substate: {kind: 'ready'}}
    }
    if (event.type === 'invalidate')
      return {...run, status: 'invalid', substate: {kind: 'ready'}}
    if (!['queued', 'running'].includes(run.status))
      return invalidTransition(benchmarkLifecycleMachine, run, event)
    return {
      ...run,
      status: 'completed',
      phase: 'complete',
      substate: {kind: 'ready'},
    }
  },
})

export function transitionBenchmark(
  run: BenchmarkRun,
  event: BenchmarkLifecycleEvent,
) {
  Object.assign(run, transition(benchmarkLifecycleMachine, run, event))
  return run
}
