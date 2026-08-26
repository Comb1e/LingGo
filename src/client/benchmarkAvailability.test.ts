import {describe, expect, it} from 'vitest'
import {hasLiveBenchmarkForProfile} from './benchmarkAvailability'

describe('benchmark creation availability', () => {
  it('only treats a live run for the selected profile as unavailable', () => {
    const runs = [
      {status: 'running' as const, config: {profileId: 'profile-a'}},
      {status: 'completed' as const, config: {profileId: 'profile-b'}},
      {status: 'cancelled' as const, config: {profileId: 'profile-c'}},
    ]

    expect(hasLiveBenchmarkForProfile(runs, 'profile-a')).toBe(true)
    expect(hasLiveBenchmarkForProfile(runs, 'profile-b')).toBe(false)
    expect(hasLiveBenchmarkForProfile(runs, 'profile-c')).toBe(false)
    expect(hasLiveBenchmarkForProfile(runs, 'profile-d')).toBe(false)
  })

  it.each(['queued', 'running', 'paused'] as const)(
    'reserves the selected profile while its run is %s',
    (status) => {
      expect(
        hasLiveBenchmarkForProfile(
          [{status, config: {profileId: 'selected'}}],
          'selected',
        ),
      ).toBe(true)
    },
  )
})
