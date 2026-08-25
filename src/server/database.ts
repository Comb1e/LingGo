import Database from 'better-sqlite3'
import {mkdirSync, readFileSync, readdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {
  BenchmarkRun,
  Game,
  GameAnalysis,
  KataGoSettings,
  PlayerProfile,
  PositionAnalysis,
  ProviderConnection,
} from '../shared/types'

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

  deleteGame(id: string) {
    return this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes > 0
  }

  deleteAllForTests() {
    this.db.exec(
      'DELETE FROM benchmark_runs; DELETE FROM games; DELETE FROM player_profiles; DELETE FROM provider_connections;',
    )
  }

  getKataGoSettings(): KataGoSettings {
    const row = this.db.prepare('SELECT * FROM katago_settings WHERE singleton = 1').get() as any
    return {
      executablePath: row.executable_path,
      modelPath: row.model_path,
      configPath: row.config_path,
      analysisVisits: row.analysis_visits,
      updatedAt: row.updated_at,
    }
  }

  saveKataGoSettings(settings: Omit<KataGoSettings, 'updatedAt'>): KataGoSettings {
    const updatedAt = new Date().toISOString()
    this.db.prepare(
      `UPDATE katago_settings SET executable_path = ?, model_path = ?, config_path = ?,
       analysis_visits = ?, updated_at = ? WHERE singleton = 1`,
    ).run(settings.executablePath, settings.modelPath, settings.configPath, settings.analysisVisits, updatedAt)
    return this.getKataGoSettings()
  }

  ensureGameAnalysis(gameId: string, enabled: boolean, shareWithLlm = false) {
    this.db.prepare(
      `INSERT INTO game_analysis_state (game_id, enabled, share_with_llm, status, updated_at)
       VALUES (?, ?, ?, 'idle', ?) ON CONFLICT(game_id) DO NOTHING`,
    ).run(
      gameId,
      enabled ? 1 : 0,
      shareWithLlm ? 1 : 0,
      new Date().toISOString(),
    )
  }

  setGameAnalysisState(gameId: string, values: {
    enabled?: boolean
    shareWithLlm?: boolean
    status?: string
    error?: string | null
  }) {
    this.ensureGameAnalysis(gameId, values.enabled ?? false)
    const current = this.db.prepare('SELECT * FROM game_analysis_state WHERE game_id = ?').get(gameId) as any
    this.db.prepare(
      `UPDATE game_analysis_state SET enabled = ?, share_with_llm = ?, status = ?,
       error = ?, updated_at = ? WHERE game_id = ?`,
    ).run(
      values.enabled === undefined ? current.enabled : values.enabled ? 1 : 0,
      values.shareWithLlm === undefined
        ? current.share_with_llm
        : values.shareWithLlm
          ? 1
          : 0,
      values.status ?? current.status,
      values.error === undefined ? current.error : values.error,
      new Date().toISOString(),
      gameId,
    )
  }

  getGameAnalysis(gameId: string): GameAnalysis {
    const state = this.db.prepare('SELECT * FROM game_analysis_state WHERE game_id = ?').get(gameId) as any
    const positions = (this.db.prepare(
      'SELECT * FROM position_analyses WHERE game_id = ? ORDER BY turn',
    ).all(gameId) as any[]).map(mapPositionAnalysis)
    return {
      enabled: Boolean(state?.enabled),
      shareWithLlm: Boolean(state?.share_with_llm),
      status: state?.status ?? 'idle',
      error: state?.error ?? undefined,
      positions,
    }
  }

  savePositionAnalysis(value: PositionAnalysis) {
    this.db.prepare(
      `INSERT INTO position_analyses
       (game_id, turn, black_win_rate, white_win_rate, black_score_lead, visits, position_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, turn) DO UPDATE SET black_win_rate = excluded.black_win_rate,
       white_win_rate = excluded.white_win_rate, black_score_lead = excluded.black_score_lead,
       visits = excluded.visits, position_hash = excluded.position_hash, created_at = excluded.created_at`,
    ).run(value.gameId, value.turn, value.blackWinRate, value.whiteWinRate, value.blackScoreLead,
      value.visits, value.positionHash, value.createdAt)
  }

  deleteAnalysisAfter(gameId: string, turn: number) {
    this.db.prepare('DELETE FROM position_analyses WHERE game_id = ? AND turn > ?').run(gameId, turn)
  }

  listBenchmarks(): BenchmarkRun[] {
    return (this.db.prepare('SELECT run_json FROM benchmark_runs ORDER BY created_at DESC').all() as Array<{run_json: string}>)
      .map(({run_json}) => JSON.parse(run_json))
  }

  getBenchmark(id: string): BenchmarkRun | undefined {
    const row = this.db.prepare('SELECT run_json FROM benchmark_runs WHERE id = ?').get(id) as {run_json: string} | undefined
    return row ? JSON.parse(row.run_json) : undefined
  }

  saveBenchmark(run: BenchmarkRun) {
    this.db.prepare(
      `INSERT INTO benchmark_runs (id, status, phase, profile_id, run_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, phase = excluded.phase,
       run_json = excluded.run_json, updated_at = excluded.updated_at`,
    ).run(run.id, run.status, run.phase, run.config.profileId, JSON.stringify(run), run.createdAt, run.updatedAt)
  }

  linkBenchmarkGame(runId: string, gameId: string, gameIndex: number) {
    this.db.prepare('INSERT INTO benchmark_games (run_id, game_id, game_index) VALUES (?, ?, ?)').run(runId, gameId, gameIndex)
  }

  deleteBenchmark(id: string) {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM games WHERE id IN (SELECT game_id FROM benchmark_games WHERE run_id = ?)').run(id)
      return this.db.prepare('DELETE FROM benchmark_runs WHERE id = ?').run(id).changes > 0
    })
    return transaction()
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

  deleteConnection(id: string) {
    return (
      this.db.prepare('DELETE FROM provider_connections WHERE id = ?').run(id)
        .changes > 0
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

  deleteProfile(id: string) {
    return (
      this.db.prepare('DELETE FROM player_profiles WHERE id = ?').run(id)
        .changes > 0
    )
  }
}

function mapPositionAnalysis(row: any): PositionAnalysis {
  return {
    gameId: row.game_id,
    turn: row.turn,
    blackWinRate: row.black_win_rate,
    whiteWinRate: row.white_win_rate,
    blackScoreLead: row.black_score_lead,
    visits: row.visits,
    positionHash: row.position_hash,
    createdAt: row.created_at,
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
