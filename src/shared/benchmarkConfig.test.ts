import {describe, expect, it} from 'vitest'
import {
  benchmarkConfigSchema,
  benchmarkSessionConfigSchema,
  benchmarkStageKeys,
} from './types'

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
      notebookTokenBudget: 3_000,
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

  it('accepts an explicit ordered split of training feedback games', () => {
    expect(
      benchmarkConfigSchema.parse({
        ...base,
        trainingGameCount: 7,
        trainingGamesWithWinRates: 3,
        trainingGamesWithoutWinRates: 4,
      }),
    ).toMatchObject({
      trainingGamesWithWinRates: 3,
      trainingGamesWithoutWinRates: 4,
    })
    expect(() =>
      benchmarkConfigSchema.parse({
        ...base,
        trainingGamesWithWinRates: 3,
        trainingGamesWithoutWinRates: 4,
      }),
    ).toThrow('combined')
    expect(() =>
      benchmarkConfigSchema.parse({
        ...base,
        trainingGamesWithWinRates: 3,
      }),
    ).toThrow('provided together')
  })
})

describe('benchmark session configuration', () => {
  const session = {
    profileId: 'profile',
    lifeDeathNotebookId: 'life',
    ordinaryNotebookId: 'ordinary',
    finalColor: 'B' as const,
    trainingGameCount: 4,
    trainingGamesWithWinRates: 2,
    trainingGamesWithoutWinRates: 2,
    trainingFeedback: 'structured' as const,
    notebookTokenBudget: 10_000,
    trainingVisits: 5_000,
    evaluationVisits: 10_000,
  }

  it('uses the fixed four-stage order', () => {
    expect(benchmarkStageKeys).toEqual(['easy', 'medium', 'hard', 'ordinary'])
  })

  it('accepts two role notebooks and rejects duplicate notebook IDs', () => {
    expect(benchmarkSessionConfigSchema.parse(session)).toMatchObject(session)
    expect(() =>
      benchmarkSessionConfigSchema.parse({
        ...session,
        ordinaryNotebookId: session.lifeDeathNotebookId,
      }),
    ).toThrow('must be distinct')
  })

  it('validates the ordinary-game count split and visit ordering', () => {
    expect(() =>
      benchmarkSessionConfigSchema.parse({
        ...session,
        trainingGamesWithoutWinRates: 1,
      }),
    ).toThrow('add up')
    expect(() =>
      benchmarkSessionConfigSchema.parse({
        ...session,
        evaluationVisits: 1_000,
      }),
    ).toThrow('at least training visits')
  })
})
