import {afterEach, describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {Store} from './database'

let store: Store | undefined
afterEach(() => store?.close())

describe('database migrations', () => {
  it('runs once and seeds a credential-free profile', () => {
    store = new Store(':memory:')
    expect(store.listConnections()).toHaveLength(1)
    expect(store.listProfiles()[0].connectionId).toBe('builtin-fake')
    const versions = store.db
      .prepare('SELECT version FROM schema_migrations')
      .all()
    expect(versions).toEqual([
      {version: 1},
      {version: 2},
      {version: 3},
      {version: 4},
      {version: 5},
      {version: 6},
      {version: 7},
    ])
    expect(store.getKataGoSettings().analysisVisits).toBe(2_000)
  })

  it('allows one live benchmark per profile', () => {
    store = new Store(':memory:')
    const insert = store.db.prepare(
      `INSERT INTO benchmark_runs
       (id, status, phase, profile_id, run_json, created_at, updated_at)
       VALUES (?, ?, 'training', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )

    insert.run('run-a', 'running', 'profile-a')
    expect(() => insert.run('run-b', 'paused', 'profile-b')).not.toThrow()
    expect(() => insert.run('run-c', 'queued', 'profile-a')).toThrow(/UNIQUE constraint failed/)

    store.db.prepare("UPDATE benchmark_runs SET status = 'completed' WHERE id = 'run-a'").run()
    expect(() => insert.run('run-d', 'queued', 'profile-a')).not.toThrow()
  })

  it('round-trips custom profile request options', () => {
    store = new Store(':memory:')
    store.saveProfile({
      id: 'custom-profile',
      name: 'Custom profile',
      connectionId: 'builtin-fake',
      modelId: 'test-model',
      temperature: 0.5,
      requestOptions: [
        {name: 'reasoning', content: '{"effort":"high"}'},
      ],
    })

    expect(store.getProfile('custom-profile')?.requestOptions).toEqual([
      {name: 'reasoning', content: '{"effort":"high"}'},
    ])
  })

  it('repairs cached White-to-play analysis from the old perspective conversion', () => {
    store = new Store(':memory:')
    store.db.prepare(
      `INSERT INTO games (id, status, game_json, created_at, updated_at)
       VALUES ('game', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run()
    store.db.prepare(
      `INSERT INTO position_analyses
       (game_id, turn, black_win_rate, white_win_rate, black_score_lead, visits, position_hash, created_at)
       VALUES ('game', 1, 0.3, 0.7, -2.5, 500, 'hash:W', CURRENT_TIMESTAMP)`,
    ).run()

    store.db.exec(
      readFileSync(new URL('./migrations/004_fix_analysis_perspective.sql', import.meta.url), 'utf8'),
    )

    const repaired = store.getGameAnalysis('game').positions[0]
    expect(repaired.blackWinRate).toBeCloseTo(0.7)
    expect(repaired.whiteWinRate).toBeCloseTo(0.3)
    expect(repaired.blackScoreLead).toBe(2.5)
  })

  it('promotes the legacy KataGo visit default', () => {
    store = new Store(':memory:')
    store.db
      .prepare('UPDATE katago_settings SET analysis_visits = 500')
      .run()

    store.db.exec(
      readFileSync(
        new URL(
          './migrations/005_raise_default_katago_visits.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )

    expect(store.getKataGoSettings().analysisVisits).toBe(2_000)
  })
})
