import {describe, expect, it} from 'vitest'
import type {BenchmarkProblemView} from '../shared/types'
import {shuffledProblemIds} from './lifeDeath'

describe('life-and-death problem order', () => {
  it('uses Fisher-Yates to randomize a run without losing problems', () => {
    const problems = ['one', 'two', 'three', 'four'].map(
      (id) => ({id}) as BenchmarkProblemView,
    )

    const order = shuffledProblemIds(problems, () => 0)

    expect(order).toEqual(['two', 'three', 'four', 'one'])
    expect(order.toSorted()).toEqual(problems.map(({id}) => id).toSorted())
  })
})
