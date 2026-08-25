import Database from 'better-sqlite3'
import {mkdirSync, readFileSync, readdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {Game, PlayerProfile, ProviderConnection} from '../shared/types'

const here = dirname(fileURLToPath(import.meta.url))

export class Store {
  readonly db: Database.Database

  constructor(
    filename = process.env.LINGGO_DB_PATH ??
      join(process.cwd(), 'data', 'linggo.db'),
  ) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive: true})
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
    this.seedFakeProvider()
  }

  private migrate() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    )
    const migrationDir = join(here, 'migrations')
    const files = readdirSync(migrationDir)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort()
    const applied = new Set(
      (
        this.db
          .prepare('SELECT version FROM schema_migrations')
          .all() as Array<{version: number}>
      ).map((row) => row.version),
    )
    const apply = this.db.transaction((version: number, sql: string) => {
      this.db.exec(sql)
      this.db
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(version, new Date().toISOString())
    })
    for (const file of files) {
      const version = Number(file.split('_')[0])
      if (!applied.has(version))
        apply(version, readFileSync(join(migrationDir, file), 'utf8'))
    }
  }

  private seedFakeProvider() {
    if (this.getConnection('builtin-fake')) return
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO provider_connections
         (id, name, kind, supports_structured_output, created_at, updated_at)
         VALUES ('builtin-fake', 'Deterministic local model', 'fake', 1, ?, ?)`,
      )
      .run(now, now)
    this.db
      .prepare(
        `INSERT INTO player_profiles
         (id, name, connection_id, model_id, temperature, style_prompt, created_at, updated_at)
         VALUES ('builtin-fake-profile', 'Local learner', 'builtin-fake', 'deterministic-v1', 0, 'Play simple legal moves.', ?, ?)`,
      )
      .run(now, now)
  }

  close() {
    this.db.close()
  }

  listGames(): Game[] {
    return (
      this.db
        .prepare('SELECT game_json FROM games ORDER BY updated_at DESC')
        .all() as Array<{game_json: string}>
    ).map((row) => JSON.parse(row.game_json))
  }

  getGame(id: string): Game | undefined {
    const row = this.db
      .prepare('SELECT game_json FROM games WHERE id = ?')
      .get(id) as {game_json: string} | undefined
    return row ? JSON.parse(row.game_json) : undefined
  }

  saveGame(game: Game) {
    this.db
      .prepare(
        `INSERT INTO games (id, status, game_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, game_json = excluded.game_json, updated_at = excluded.updated_at`,
      )
      .run(
        game.id,
        game.status,
        JSON.stringify(game),
        game.createdAt,
        game.updatedAt,
      )
  }

  deleteAllForTests() {
    this.db.exec(
      'DELETE FROM games; DELETE FROM player_profiles; DELETE FROM provider_connections;',
    )
  }

  listConnections(): ProviderConnection[] {
    return (
      this.db
        .prepare(
          'SELECT id, name, kind, base_url, supports_structured_output FROM provider_connections ORDER BY created_at',
        )
        .all() as Array<any>
    ).map(mapConnection)
  }

  getConnection(id: string): ProviderConnection | undefined {
    const row = this.db
      .prepare(
        'SELECT id, name, kind, base_url, supports_structured_output FROM provider_connections WHERE id = ?',
      )
      .get(id) as any
    return row ? mapConnection(row) : undefined
  }

  saveConnection(connection: ProviderConnection) {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO provider_connections (id, name, kind, base_url, supports_structured_output, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, base_url = excluded.base_url,
         supports_structured_output = excluded.supports_structured_output, updated_at = excluded.updated_at`,
      )
      .run(
        connection.id,
        connection.name,
        connection.kind,
        connection.baseUrl ?? null,
        connection.supportsStructuredOutput ? 1 : 0,
        now,
        now,
      )
  }

  listProfiles(): PlayerProfile[] {
    return (
      this.db
        .prepare(
          'SELECT id, name, connection_id, model_id, temperature, style_prompt FROM player_profiles ORDER BY created_at',
        )
        .all() as Array<any>
    ).map(mapProfile)
  }

  getProfile(id: string): PlayerProfile | undefined {
    const row = this.db
      .prepare(
        'SELECT id, name, connection_id, model_id, temperature, style_prompt FROM player_profiles WHERE id = ?',
      )
      .get(id) as any
    return row ? mapProfile(row) : undefined
  }

  saveProfile(profile: PlayerProfile) {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO player_profiles (id, name, connection_id, model_id, temperature, style_prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, connection_id = excluded.connection_id,
         model_id = excluded.model_id, temperature = excluded.temperature, style_prompt = excluded.style_prompt, updated_at = excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.name,
        profile.connectionId,
        profile.modelId,
        profile.temperature,
        profile.stylePrompt ?? null,
        now,
        now,
      )
  }
}

function mapConnection(row: any): ProviderConnection {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url ?? undefined,
    supportsStructuredOutput: Boolean(row.supports_structured_output),
  }
}

function mapProfile(row: any): PlayerProfile {
  return {
    id: row.id,
    name: row.name,
    connectionId: row.connection_id,
    modelId: row.model_id,
    temperature: row.temperature,
    stylePrompt: row.style_prompt ?? undefined,
  }
}
