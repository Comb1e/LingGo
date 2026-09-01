import {describe, expect, it} from 'vitest'
import policy from '../../config/engineering-policy.json'
import {checkSource, type EngineeringPolicy} from './engineeringPolicy'

const configuredPolicy = policy as EngineeringPolicy

describe('engineering policy', () => {
  it('rejects direct lifecycle mutation', () => {
    const violations = checkSource(
      'src/server/games.ts',
      `function pause(game: {status: string}) { game.status = 'paused' }`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('state-machine')
  })

  it('accepts a lifecycle transition call', () => {
    expect(
      checkSource(
        'src/server/games.ts',
        `transitionGame(game, {type: 'pause'})`,
        configuredPolicy,
      ),
    ).toEqual([])
  })

  it('rejects Object.assign lifecycle mutation', () => {
    const violations = checkSource(
      'src/server/benchmarks.ts',
      `Object.assign(run, {status: 'paused'})`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('state-machine')
  })

  it('rejects environment access outside configuration', () => {
    const violations = checkSource(
      'src/server/database.ts',
      `const path = process.env.LINGGO_DB_PATH`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('configuration')
  })

  it('rejects bypassing the provider facade', () => {
    const violations = checkSource(
      'src/server/games.ts',
      `await adapter.requestTurn(request, signal)`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('generic-interface')
  })
})
