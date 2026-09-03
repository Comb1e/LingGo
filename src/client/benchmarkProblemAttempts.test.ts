import {describe, expect, it} from 'vitest'
import type {BenchmarkProblemAttempt} from '../shared/types'
import {groupBenchmarkProblemAttempts} from './benchmarkProblemAttempts'

function action(sequence: number, correct: boolean) {
  return {sequence, correct} as BenchmarkProblemAttempt
}

describe('benchmark problem attempt grouping', () => {
  it('starts a new displayed attempt only after a failed action', () => {
    const grouped = groupBenchmarkProblemAttempts([
      action(1, false),
      action(2, true),
      action(3, false),
      action(4, true),
    ])

    expect(
      grouped.map((attempt) => attempt.map(({sequence}) => sequence)),
    ).toEqual([[1], [2, 3], [4]])
  })

  it('keeps a fully correct solution in one displayed attempt', () => {
    const grouped = groupBenchmarkProblemAttempts([
      action(1, true),
      action(2, true),
    ])

    expect(grouped).toHaveLength(1)
  })
})
