import {describe, expect, it} from 'vitest'
import type {
  BenchmarkRun,
  BenchmarkSession,
  BenchmarkSessionStage,
  Game,
  GameAnalysis,
} from '../../shared/types'
import type {LlmGameContext} from '../llmGameContext'
import {InvalidTransitionError} from './core'
import {transitionGame} from './game'
import {transitionBenchmark} from './benchmark'
import {
  transitionBenchmarkSession,
  transitionBenchmarkStage,
} from './benchmarkSession'
import {transitionAnalysis} from './analysis'
import {transitionLlmContext} from './llmContext'

describe('workflow state machines', () => {
  it('moves a game through pause, resume, scoring, and completion', () => {
    const game = {status: 'active'} as Game
    transitionGame(game, {type: 'pause'})
    transitionGame(game, {type: 'activate'})
    transitionGame(game, {type: 'score'})
    transitionGame(game, {type: 'finish'})
    expect(game.status).toBe('finished')
    expect(() => transitionGame(game, {type: 'score'})).toThrow(
      InvalidTransitionError,
    )
  })

  it('preserves the benchmark substate across pause and resume', () => {
    const run = {
      status: 'running',
      phase: 'training_game',
      substate: {kind: 'waiting_katago'},
    } as BenchmarkRun
    const pausedPrevious =
      run.substate.kind === 'paused' ? run.substate.previous : run.substate
    transitionBenchmark(run, {
      type: 'pause',
      substate: {kind: 'paused', previous: pausedPrevious},
    })
    expect(run.status).toBe('paused')
    expect(run.substate.kind).toBe('paused')
    const previous =
      run.substate.kind === 'paused' ? run.substate.previous : run.substate
    transitionBenchmark(run, {type: 'resume', substate: previous})
    expect(run).toMatchObject({
      status: 'running',
      substate: {kind: 'waiting_katago'},
    })
  })

  it('keeps terminal benchmarks terminal', () => {
    const run = {
      status: 'running',
      phase: 'final_game',
      substate: {kind: 'ready'},
    } as BenchmarkRun
    transitionBenchmark(run, {type: 'complete'})
    expect(run).toMatchObject({
      status: 'completed',
      phase: 'complete',
      substate: {kind: 'ready'},
    })
    expect(() =>
      transitionBenchmark(run, {
        type: 'update',
        status: 'running',
      }),
    ).toThrow(InvalidTransitionError)
  })

  it('allows completed stages to restart but keeps cancellation terminal', () => {
    const session = {status: 'completed'} as BenchmarkSession
    const stage = {status: 'completed'} as BenchmarkSessionStage
    transitionBenchmarkSession(session, 'restarting_stage')
    transitionBenchmarkStage(stage, 'running')
    expect(session.status).toBe('restarting_stage')
    expect(stage.status).toBe('running')
    transitionBenchmarkSession(session, 'cancelled')
    expect(() => transitionBenchmarkSession(session, 'running')).toThrow(
      InvalidTransitionError,
    )
  })

  it('models persisted analysis and LLM context lifecycles', () => {
    const analysis = {status: 'idle'} as GameAnalysis
    expect(transitionAnalysis(analysis, {type: 'start'}).status).toBe('running')
    expect(transitionAnalysis(analysis, {type: 'fail'}).status).toBe('error')

    const context = {status: 'active'} as LlmGameContext
    transitionLlmContext(context, {type: 'complete'})
    expect(context.status).toBe('complete')
    expect(() => transitionLlmContext(context, {type: 'activate'})).toThrow(
      InvalidTransitionError,
    )
    transitionLlmContext(context, {type: 'rebase'})
    expect(context.status).toBe('needs_rebase')
  })
})
