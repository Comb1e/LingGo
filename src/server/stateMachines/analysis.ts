import type {AnalysisStatus, GameAnalysis} from '../../shared/types'
import {defineStateMachine, transition} from './core'

type AnalysisEvent =
  {type: 'reset'} | {type: 'start'} | {type: 'complete'} | {type: 'fail'}

const target: Record<AnalysisEvent['type'], AnalysisStatus> = {
  reset: 'idle',
  start: 'running',
  complete: 'complete',
  fail: 'error',
}

export const analysisLifecycleMachine = defineStateMachine<
  GameAnalysis,
  AnalysisEvent
>({
  name: 'game analysis',
  state: (analysis) => analysis.status,
  transition(analysis, event) {
    return {...analysis, status: target[event.type]}
  },
})

export function transitionAnalysis(
  analysis: GameAnalysis,
  event: AnalysisEvent,
) {
  return transition(analysisLifecycleMachine, analysis, event)
}
