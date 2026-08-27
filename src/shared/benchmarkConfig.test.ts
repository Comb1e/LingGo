import {describe, expect, it} from 'vitest'
import {benchmarkConfigSchema} from './types'

const base = {
  profileId: 'profile',
  finalColor: 'B' as const,
  trainingGameCount: 1,
  notebookSeed: {mode: 'rules_only' as const},
  trainingFeedback: 'none' as const,
  notebookTokenBudget: 10_000,
  trainingVisits: 10_000,
  evaluationVisits: 10_000,
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

  it('accepts up to 100,000 KataGo visits and orders evaluation above training', () => {
    expect(
      benchmarkConfigSchema.parse({...base, evaluationVisits: 100_000})
        .evaluationVisits,
    ).toBe(100_000)
    expect(() =>
      benchmarkConfigSchema.parse({...base, evaluationVisits: 100_001}),
    ).toThrow()
    expect(() =>
      benchmarkConfigSchema.parse({
        ...base,
        trainingVisits: 10_000,
        evaluationVisits: 5_000,
      }),
    ).toThrow('Evaluation visits must be at least training visits')
  })

  it('defaults the V2 protocol settings and rejects V1 flags', () => {
    expect(
      benchmarkConfigSchema.parse({
        profileId: 'profile',
        finalColor: 'B',
        trainingGameCount: 1,
      }),
    ).toMatchObject({
      notebookSeed: {mode: 'rules_only'},
      trainingFeedback: 'structured',
      notebookTokenBudget: 10_000,
      trainingVisits: 10_000,
      evaluationVisits: 10_000,
    })
    expect(() =>
      benchmarkConfigSchema.parse({...base, includeTrainingWinRates: true}),
    ).toThrow()
    expect(() =>
      benchmarkConfigSchema.parse({...base, visits: 100_000}),
    ).toThrow()
  })
})
