import {describe, expect, it} from 'vitest'
import {benchmarkConfigSchema} from './types'

const base = {
  profileId: 'profile',
  finalColor: 'B' as const,
  visits: 25,
  includeTrainingWinRates: false,
  trainingGameCount: 1,
  notebookId: 'notebook',
}

describe('benchmark configuration', () => {
  it.each([1, 10, 100, 1000])(
    'accepts %i training games',
    (trainingGameCount) => {
      expect(
        benchmarkConfigSchema.parse({...base, trainingGameCount})
          .trainingGameCount,
      ).toBe(trainingGameCount)
    },
  )

  it.each([0, 1001])('rejects %i training games', (trainingGameCount) => {
    expect(() =>
      benchmarkConfigSchema.parse({...base, trainingGameCount}),
    ).toThrow()
  })

  it('accepts up to 100,000 KataGo visits', () => {
    expect(benchmarkConfigSchema.parse({...base, visits: 100_000}).visits).toBe(
      100_000,
    )
    expect(() =>
      benchmarkConfigSchema.parse({...base, visits: 100_001}),
    ).toThrow()
  })
})
