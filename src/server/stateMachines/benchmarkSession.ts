import type {
  BenchmarkSession,
  BenchmarkSessionStage,
  BenchmarkSessionStageStatus,
  BenchmarkSessionStatus,
} from '../../shared/types'
import {
  defineStateMachine,
  invalidTransition,
  transition,
  type StateMachine,
} from './core'

type SessionEvent = {type: 'set'; status: BenchmarkSessionStatus}
type StageEvent = {type: 'set'; status: BenchmarkSessionStageStatus}

const terminalSessions: BenchmarkSessionStatus[] = ['cancelled']
const terminalStages: BenchmarkSessionStageStatus[] = [
  'completed',
  'cancelled',
  'failed',
]

export const benchmarkSessionMachine: StateMachine<
  BenchmarkSession,
  SessionEvent
> = defineStateMachine<BenchmarkSession, SessionEvent>({
  name: 'benchmark session',
  state: (session) => session.status,
  transition(session, event): BenchmarkSession {
    if (
      terminalSessions.includes(session.status) &&
      event.status !== session.status
    )
      return invalidTransition(benchmarkSessionMachine, session, event)
    return {...session, status: event.status}
  },
})

export const benchmarkStageMachine: StateMachine<
  BenchmarkSessionStage,
  StageEvent
> = defineStateMachine<BenchmarkSessionStage, StageEvent>({
  name: 'benchmark session stage',
  state: (stage) => stage.status,
  transition(stage, event): BenchmarkSessionStage {
    if (
      terminalStages.includes(stage.status) &&
      event.status !== stage.status &&
      event.status !== 'running'
    )
      return invalidTransition(benchmarkStageMachine, stage, event)
    return {...stage, status: event.status}
  },
})

export function transitionBenchmarkSession(
  session: BenchmarkSession,
  status: BenchmarkSessionStatus,
) {
  Object.assign(
    session,
    transition(benchmarkSessionMachine, session, {type: 'set', status}),
  )
  return session
}

export function transitionBenchmarkStage(
  stage: BenchmarkSessionStage,
  status: BenchmarkSessionStageStatus,
) {
  Object.assign(
    stage,
    transition(benchmarkStageMachine, stage, {type: 'set', status}),
  )
  return stage
}
