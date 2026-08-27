import {describe, expect, it} from 'vitest'
import {benchmarkConfigSchema} from './types'

const base = {
  profileId: 'profile',
  finalColor: 'B' as const,
  visits: 25,
  includeTrainingWinRates: false,
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
})
