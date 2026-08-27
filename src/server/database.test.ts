import {afterEach, describe, expect, it} from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Database from 'better-sqlite3'
import type {BenchmarkRun} from '../shared/types'
import {Store} from './database'

let store: Store | undefined
let temporaryDirectory: string | undefined
afterEach(() => {
  store?.close()
  store = undefined
  if (temporaryDirectory) rmSync(temporaryDirectory, {recursive: true})
  temporaryDirectory = undefined
})

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
      {version: 8},
      {version: 9},
      {version: 10},
      {version: 11},
      {version: 12},
      {version: 13},
    ])
    expect(store.getKataGoSettings().analysisVisits).toBe(5_000)
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
    expect(() => insert.run('run-c', 'queued', 'profile-a')).toThrow(
      /UNIQUE constraint failed/,
    )

    store.db
      .prepare(
        "UPDATE benchmark_runs SET status = 'completed' WHERE id = 'run-a'",
      )
      .run()
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
      requestOptions: [{name: 'reasoning', content: '{"effort":"high"}'}],
    })

    expect(store.getProfile('custom-profile')?.requestOptions).toEqual([
      {name: 'reasoning', content: '{"effort":"high"}'},
    ])
  })

  it('round-trips disabled profile reasoning', () => {
    store = new Store(':memory:')
    store.saveProfile({
      id: 'non-reasoning-profile',
      name: 'Non-reasoning profile',
      connectionId: 'builtin-fake',
      modelId: 'test-model',
      temperature: 0.5,
      reasoningEnabled: false,
    })

    expect(store.getProfile('non-reasoning-profile')?.reasoningEnabled).toBe(
      false,
    )
  })

  it('migrates databases that already used historical migration 8', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'linggo-migration-'))
    const filename = join(temporaryDirectory, 'linggo.db')
    const legacy = new Database(filename)
    legacy.exec(
      readFileSync(
        new URL('./migrations/001_initial.sql', import.meta.url),
        'utf8',
      ),
    )
    legacy.exec(
      readFileSync(
        new URL(
          './migrations/008_add_reasoning_response_field.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    legacy.exec(
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       );
       INSERT INTO schema_migrations (version, applied_at)
       VALUES (1, CURRENT_TIMESTAMP), (8, CURRENT_TIMESTAMP);`,
    )
    legacy.close()

    store = new Store(filename)

    const columns = store.db
      .prepare('PRAGMA table_info(player_profiles)')
      .all() as Array<{name: string}>
    expect(columns.map(({name}) => name)).toContain('reasoning_enabled')
    expect(
      store.db
        .prepare('SELECT version FROM schema_migrations WHERE version = 9')
        .get(),
    ).toEqual({version: 9})
  })

  it('lists player profiles alphabetically regardless of creation order or case', () => {
    store = new Store(':memory:')
    for (const [id, name] of [
      ['zulu-profile', 'Zulu'],
      ['alpha-profile', 'alpha'],
    ]) {
      store.saveProfile({
        id,
        name,
        connectionId: 'builtin-fake',
        modelId: 'test-model',
        temperature: 0.5,
      })
    }

    expect(store.listProfiles().map(({name}) => name)).toEqual([
      'alpha',
      'Local learner',
      'Zulu',
    ])
  })

  it('repairs cached White-to-play analysis from the old perspective conversion', () => {
    store = new Store(':memory:')
    store.db
      .prepare(
        `INSERT INTO games (id, status, game_json, created_at, updated_at)
       VALUES ('game', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .run()
    store.db
      .prepare(
        `INSERT INTO position_analyses
       (game_id, turn, black_win_rate, white_win_rate, black_score_lead, visits, position_hash, created_at)
       VALUES ('game', 1, 0.3, 0.7, -2.5, 500, 'hash:W', CURRENT_TIMESTAMP)`,
      )
      .run()

    store.db.exec(
      readFileSync(
        new URL(
          './migrations/004_fix_analysis_perspective.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )

    const repaired = store.getGameAnalysis('game').positions[0]
    expect(repaired.blackWinRate).toBeCloseTo(0.7)
    expect(repaired.whiteWinRate).toBeCloseTo(0.3)
    expect(repaired.blackScoreLead).toBe(2.5)
  })

  it('promotes the legacy KataGo visit default', () => {
    store = new Store(':memory:')
    store.db.prepare('UPDATE katago_settings SET analysis_visits = 500').run()

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

  it('raises the previous KataGo visit default', () => {
    store = new Store(':memory:')
    store.db.prepare('UPDATE katago_settings SET analysis_visits = 2000').run()

    store.db.exec(
      readFileSync(
        new URL(
          './migrations/011_raise_katago_visit_default.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )

    expect(store.getKataGoSettings().analysisVisits).toBe(5_000)
  })

  it('owns named notebooks by profile and preserves benchmark snapshots', () => {
    store = new Store(':memory:')
    const first = store.createNotebook('builtin-fake-profile', '  Study  ')
    const second = store.createNotebook('builtin-fake-profile', 'Endgame')
    expect(first.name).toBe('Study')
    expect(
      store.listNotebooks('builtin-fake-profile').map(({name}) => name),
    ).toEqual(expect.arrayContaining(['Endgame', 'Study']))
    expect(() =>
      store!.createNotebook('builtin-fake-profile', 'study'),
    ).toThrow('already exists')

    store.saveProfile({
      id: 'other-profile',
      name: 'Other',
      connectionId: 'builtin-fake',
      modelId: 'test',
      temperature: 0,
    })
    expect(store.getNotebook('other-profile', first.id)).toBeUndefined()
    expect(store.createNotebook('other-profile', 'Study').name).toBe('Study')

    const run = benchmarkRun(first.id)
    store.saveBenchmarkWithSnapshot(run, first)
    run.usage.calls = 2
    run.notebook.updatedAt = new Date().toISOString()
    store.saveReflection(first, run, '# Consolidated')
    expect(store.getNotebook('builtin-fake-profile', first.id)?.content).toBe(
      '# Consolidated',
    )
    expect(store.getBenchmark(run.id)?.usage.calls).toBe(2)
    expect(store.getNotebookSnapshot(run.id)?.content).toBe('# Consolidated')

    store.renameNotebook('builtin-fake-profile', first.id, 'Renamed')
    store.deleteNotebook('builtin-fake-profile', first.id)
    expect(store.getNotebookSnapshot(run.id)?.content).toBe('# Consolidated')
    expect(second.profileId).toBe('builtin-fake-profile')
  })

  it('imports each legacy notebook only once', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'linggo-notebook-import-'))
    const notebookDirectory = join(temporaryDirectory, 'techniques')
    const filename = join(temporaryDirectory, 'linggo.db')
    mkdirSync(notebookDirectory)
    writeFileSync(
      join(notebookDirectory, 'builtin-fake-profile.md'),
      '# Legacy lessons',
    )
    const previous = process.env.LINGGO_TECHNIQUES_DIR
    process.env.LINGGO_TECHNIQUES_DIR = notebookDirectory
    try {
      store = new Store(filename)
      const imported = store.listNotebooks('builtin-fake-profile')
      expect(imported.map(({name}) => name)).toEqual(['Default'])
      expect(
        store.getNotebook('builtin-fake-profile', imported[0].id)?.content,
      ).toBe('# Legacy lessons')
      store.deleteNotebook('builtin-fake-profile', imported[0].id)
      store.close()
      store = new Store(filename)
      expect(store.listNotebooks('builtin-fake-profile')).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.LINGGO_TECHNIQUES_DIR
      else process.env.LINGGO_TECHNIQUES_DIR = previous
    }
  })

  it('upgrades active legacy benchmarks and imports their snapshots', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'linggo-run-upgrade-'))
    const notebookDirectory = join(temporaryDirectory, 'techniques')
    const filename = join(temporaryDirectory, 'linggo.db')
    mkdirSync(join(notebookDirectory, 'runs'), {recursive: true})
    const previous = process.env.LINGGO_TECHNIQUES_DIR
    process.env.LINGGO_TECHNIQUES_DIR = notebookDirectory
    try {
      store = new Store(filename)
      const legacy = benchmarkRun('') as BenchmarkRun & {
        config: BenchmarkRun['config'] & {notebookMode?: string}
      }
      legacy.id = 'legacy-active-run'
      legacy.status = 'paused'
      legacy.phase = 'reflection'
      delete (legacy.config as Partial<BenchmarkRun['config']>)
        .trainingGameCount
      delete (legacy.config as Partial<BenchmarkRun['config']>).notebookId
      legacy.config.notebookMode = 'continue'
      store.saveBenchmark(legacy)
      store.db
        .prepare(
          `DELETE FROM app_metadata
           WHERE key = 'named_notebooks_legacy_imported'`,
        )
        .run()
      writeFileSync(
        join(notebookDirectory, 'runs', `${legacy.id}.md`),
        '# Legacy snapshot',
      )
      store.close()

      store = new Store(filename)
      const upgraded = store.getBenchmark(legacy.id)!
      expect(upgraded.config.trainingGameCount).toBe(10)
      expect(upgraded.config.notebookId).not.toBe('')
      expect(
        store.listNotebooks('builtin-fake-profile').map(({name}) => name),
      ).toEqual(['Default'])
      expect(store.getNotebookSnapshot(legacy.id)?.content).toBe(
        '# Legacy snapshot',
      )
    } finally {
      if (previous === undefined) delete process.env.LINGGO_TECHNIQUES_DIR
      else process.env.LINGGO_TECHNIQUES_DIR = previous
    }
  })
})

function benchmarkRun(notebookId: string): BenchmarkRun {
  const now = new Date().toISOString()
  return {
    id: 'notebook-run',
    status: 'completed',
    phase: 'complete',
    config: {
      profileId: 'builtin-fake-profile',
      finalColor: 'B',
      visits: 25,
      includeTrainingWinRates: false,
      trainingGameCount: 1,
      notebookId,
    },
    profileSnapshot: {
      id: 'builtin-fake-profile',
      name: 'Local learner',
      connectionId: 'builtin-fake',
      modelId: 'deterministic-v1',
      temperature: 0,
    },
    modelFingerprint: 'test',
    currentGame: 2,
    currentTurn: 0,
    gameIds: [],
    usage: {calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0},
    notebook: {profileId: 'builtin-fake-profile', notebookId},
    createdAt: now,
    updatedAt: now,
  }
}
