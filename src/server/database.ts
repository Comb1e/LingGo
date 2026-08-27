import Database from 'better-sqlite3'
import {existsSync, mkdirSync, readFileSync, readdirSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
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
  TechniqueNotebook,
  TechniqueNotebookSummary,
} from '../shared/types'
import type {LlmGameContext} from './llmGameContext'

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
    this.importLegacyNotebooks()
    this.upgradeActiveLegacyBenchmarks()
  }

  private importLegacyNotebooks() {
    const key = 'named_notebooks_legacy_imported'
    if (this.db.prepare('SELECT 1 FROM app_metadata WHERE key = ?').get(key))
      return
    const root =
      process.env.LINGGO_TECHNIQUES_DIR ??
      join(process.cwd(), 'data', 'techniques')
    const importNotebook = this.db.transaction(() => {
      for (const profile of this.listProfiles()) {
        const path = join(root, `${profile.id}.md`)
        if (!existsSync(path)) continue
        const now = new Date().toISOString()
        this.db
          .prepare(
            `INSERT OR IGNORE INTO technique_notebooks
             (id, profile_id, name, name_key, content, created_at, updated_at)
             VALUES (?, ?, 'Default', 'default', ?, ?, ?)`,
          )
          .run(randomUUID(), profile.id, readFileSync(path, 'utf8'), now, now)
      }
      for (const run of this.listBenchmarks()) {
        const path = join(root, 'runs', `${run.id}.md`)
        if (!existsSync(path)) continue
        const notebook = this.listNotebooks(run.config.profileId).find(
          ({name}) => name.toLocaleLowerCase() === 'default',
        )
        const now = new Date().toISOString()
        this.db
          .prepare(
            `INSERT OR IGNORE INTO benchmark_notebook_snapshots
             (run_id, notebook_id, notebook_name, content, updated_at)
             VALUES (?, ?, 'Default', ?, ?)`,
          )
          .run(run.id, notebook?.id ?? null, readFileSync(path, 'utf8'), now)
      }
      this.db
        .prepare('INSERT INTO app_metadata (key, value) VALUES (?, ?)')
        .run(key, new Date().toISOString())
    })
    importNotebook()
  }

  private upgradeActiveLegacyBenchmarks() {
    const rows = this.db
      .prepare(
        `SELECT run_json FROM benchmark_runs
         WHERE status IN ('queued', 'running', 'paused')`,
      )
      .all() as Array<{run_json: string}>
    for (const row of rows) {
      const run = JSON.parse(row.run_json) as BenchmarkRun
      if (run.config.trainingGameCount && run.config.notebookId) continue
      let notebook = this.listNotebooks(run.config.profileId).find(
        ({name}) => name.toLocaleLowerCase() === 'default',
      )
      notebook ??= this.createNotebook(run.config.profileId, 'Default')
      run.config = {
        ...run.config,
        trainingGameCount: 10,
        notebookId: notebook.id,
      }
      delete (run.config as BenchmarkRun['config'] & {notebookMode?: string})
        .notebookMode
      run.notebook = {
        ...run.notebook,
        notebookId: notebook.id,
        name: notebook.name,
        currentUrl: `/api/profiles/${run.config.profileId}/notebooks/${notebook.id}.md`,
      }
      this.saveBenchmark(run)
    }
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

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)()
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

  saveGameWithLlmContext(game: Game, context: LlmGameContext) {
    this.db.transaction(() => {
      this.saveGame(game)
      this.saveLlmGameContext(context)
    })()
  }

  getLlmGameContext(
    gameId: string,
    color: 'B' | 'W',
  ): LlmGameContext | undefined {
    const row = this.db
      .prepare(
        `SELECT game_id, color, status, profile_id, provider_kind,
         model_fingerprint, last_observed_move, transcript_json,
         pending_turn_json, provider_continuation_id, managed_continuation,
         created_at, updated_at
         FROM llm_game_contexts WHERE game_id = ? AND color = ?`,
      )
      .get(gameId, color) as any
    if (!row) return undefined
    try {
      const transcript = JSON.parse(row.transcript_json)
      const pendingTurn = row.pending_turn_json
        ? JSON.parse(row.pending_turn_json)
        : undefined
      if (
        !Array.isArray(transcript) ||
        !transcript.every(
          (message) =>
            message &&
            (message.role === 'user' || message.role === 'assistant') &&
            typeof message.content === 'string',
        ) ||
        (pendingTurn !== undefined &&
          (!pendingTurn ||
            !['initial', 'continuation', 'repair', 'reflection'].includes(
              pendingTurn.kind,
            ) ||
            typeof pendingTurn.content !== 'string' ||
            !Number.isInteger(pendingTurn.observedMoveCount) ||
            pendingTurn.observedMoveCount < 0)) ||
        !Number.isInteger(row.last_observed_move) ||
        row.last_observed_move < 0
      )
        throw new Error('Invalid persisted LLM context')
      return {
        gameId: row.game_id,
        color: row.color,
        status: row.status,
        profileId: row.profile_id,
        providerKind: row.provider_kind,
        modelFingerprint: row.model_fingerprint,
        lastObservedMove: row.last_observed_move,
        transcript,
        pendingTurn,
        providerContinuationId: row.provider_continuation_id ?? undefined,
        managedContinuation: Boolean(row.managed_continuation),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    } catch {
      return {
        gameId: row.game_id,
        color: row.color,
        status: 'needs_rebase',
        profileId: row.profile_id,
        providerKind: row.provider_kind,
        modelFingerprint: row.model_fingerprint,
        lastObservedMove: 0,
        transcript: [],
        managedContinuation: Boolean(row.managed_continuation),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    }
  }

  listLlmGameContexts(gameId: string) {
    return (['B', 'W'] as const)
      .map((color) => this.getLlmGameContext(gameId, color))
      .filter((context): context is LlmGameContext => Boolean(context))
  }

  saveLlmGameContext(context: LlmGameContext) {
    this.db
      .prepare(
        `INSERT INTO llm_game_contexts
         (game_id, color, status, profile_id, provider_kind,
          model_fingerprint, last_observed_move, transcript_json,
          pending_turn_json, provider_continuation_id, managed_continuation,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, color) DO UPDATE SET
         status = excluded.status, profile_id = excluded.profile_id,
         provider_kind = excluded.provider_kind,
         model_fingerprint = excluded.model_fingerprint,
         last_observed_move = excluded.last_observed_move,
         transcript_json = excluded.transcript_json,
         pending_turn_json = excluded.pending_turn_json,
         provider_continuation_id = excluded.provider_continuation_id,
         managed_continuation = excluded.managed_continuation,
         updated_at = excluded.updated_at`,
      )
      .run(
        context.gameId,
        context.color,
        context.status,
        context.profileId,
        context.providerKind,
        context.modelFingerprint,
        context.lastObservedMove,
        JSON.stringify(context.transcript),
        context.pendingTurn ? JSON.stringify(context.pendingTurn) : null,
        context.providerContinuationId ?? null,
        context.managedContinuation ? 1 : 0,
        context.createdAt,
        context.updatedAt,
      )
  }

  markLlmGameContextsNeedsRebase(gameId: string, color?: 'B' | 'W') {
    const where = color ? 'game_id = ? AND color = ?' : 'game_id = ?'
    this.db
      .prepare(
        `UPDATE llm_game_contexts SET status = 'needs_rebase',
         pending_turn_json = NULL, provider_continuation_id = NULL,
         updated_at = ? WHERE ${where}`,
      )
      .run(new Date().toISOString(), gameId, ...(color ? [color] : []))
  }

  disableManagedLlmContinuation(gameId: string, color: 'B' | 'W') {
    this.db
      .prepare(
        `UPDATE llm_game_contexts SET status = 'needs_rebase',
         pending_turn_json = NULL, provider_continuation_id = NULL,
         managed_continuation = 0, updated_at = ?
         WHERE game_id = ? AND color = ?`,
      )
      .run(new Date().toISOString(), gameId, color)
  }

  completeLlmGameContexts(gameId: string) {
    this.db
      .prepare(
        `UPDATE llm_game_contexts SET status = 'complete',
         pending_turn_json = NULL, updated_at = ? WHERE game_id = ?`,
      )
      .run(new Date().toISOString(), gameId)
  }

  deleteGame(id: string) {
    return this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes > 0
  }

  deleteAllForTests() {
    this.db.exec(
      'DELETE FROM benchmark_runs; DELETE FROM games; DELETE FROM technique_notebooks; DELETE FROM player_profiles; DELETE FROM provider_connections;',
    )
  }

  getKataGoSettings(): KataGoSettings {
    const row = this.db
      .prepare('SELECT * FROM katago_settings WHERE singleton = 1')
      .get() as any
    return {
      executablePath: row.executable_path,
      modelPath: row.model_path,
      configPath: row.config_path,
      analysisVisits: row.analysis_visits,
      updatedAt: row.updated_at,
    }
  }

  saveKataGoSettings(
    settings: Omit<KataGoSettings, 'updatedAt'>,
  ): KataGoSettings {
    const updatedAt = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE katago_settings SET executable_path = ?, model_path = ?, config_path = ?,
       analysis_visits = ?, updated_at = ? WHERE singleton = 1`,
      )
      .run(
        settings.executablePath,
        settings.modelPath,
        settings.configPath,
        settings.analysisVisits,
        updatedAt,
      )
    return this.getKataGoSettings()
  }

  ensureGameAnalysis(gameId: string, enabled: boolean, shareWithLlm = false) {
    this.db
      .prepare(
        `INSERT INTO game_analysis_state (game_id, enabled, share_with_llm, status, updated_at)
       VALUES (?, ?, ?, 'idle', ?) ON CONFLICT(game_id) DO NOTHING`,
      )
      .run(
        gameId,
        enabled ? 1 : 0,
        shareWithLlm ? 1 : 0,
        new Date().toISOString(),
      )
  }

  setGameAnalysisState(
    gameId: string,
    values: {
      enabled?: boolean
      shareWithLlm?: boolean
      status?: string
      error?: string | null
    },
  ) {
    this.ensureGameAnalysis(gameId, values.enabled ?? false)
    const current = this.db
      .prepare('SELECT * FROM game_analysis_state WHERE game_id = ?')
      .get(gameId) as any
    this.db
      .prepare(
        `UPDATE game_analysis_state SET enabled = ?, share_with_llm = ?, status = ?,
       error = ?, updated_at = ? WHERE game_id = ?`,
      )
      .run(
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
    const state = this.db
      .prepare('SELECT * FROM game_analysis_state WHERE game_id = ?')
      .get(gameId) as any
    const positions = (
      this.db
        .prepare(
          'SELECT * FROM position_analyses WHERE game_id = ? ORDER BY turn',
        )
        .all(gameId) as any[]
    ).map(mapPositionAnalysis)
    return {
      enabled: Boolean(state?.enabled),
      shareWithLlm: Boolean(state?.share_with_llm),
      status: state?.status ?? 'idle',
      error: state?.error ?? undefined,
      positions,
    }
  }

  savePositionAnalysis(value: PositionAnalysis) {
    this.db
      .prepare(
        `INSERT INTO position_analyses
       (game_id, turn, black_win_rate, white_win_rate, black_score_lead, visits, position_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, turn) DO UPDATE SET black_win_rate = excluded.black_win_rate,
       white_win_rate = excluded.white_win_rate, black_score_lead = excluded.black_score_lead,
       visits = excluded.visits, position_hash = excluded.position_hash, created_at = excluded.created_at`,
      )
      .run(
        value.gameId,
        value.turn,
        value.blackWinRate,
        value.whiteWinRate,
        value.blackScoreLead,
        value.visits,
        value.positionHash,
        value.createdAt,
      )
  }

  deleteAnalysisAfter(gameId: string, turn: number) {
    this.db
      .prepare('DELETE FROM position_analyses WHERE game_id = ? AND turn > ?')
      .run(gameId, turn)
  }

  listBenchmarks(): BenchmarkRun[] {
    return (
      this.db
        .prepare('SELECT run_json FROM benchmark_runs ORDER BY created_at DESC')
        .all() as Array<{run_json: string}>
    ).map(({run_json}) => normalizeBenchmark(JSON.parse(run_json)))
  }

  getBenchmark(id: string): BenchmarkRun | undefined {
    const row = this.db
      .prepare('SELECT run_json FROM benchmark_runs WHERE id = ?')
      .get(id) as {run_json: string} | undefined
    return row ? normalizeBenchmark(JSON.parse(row.run_json)) : undefined
  }

  saveBenchmark(run: BenchmarkRun) {
    this.db
      .prepare(
        `INSERT INTO benchmark_runs (id, status, phase, profile_id, run_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, phase = excluded.phase,
       run_json = excluded.run_json, updated_at = excluded.updated_at`,
      )
      .run(
        run.id,
        run.status,
        run.phase,
        run.config.profileId,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
      )
  }

  saveBenchmarkWithSnapshot(run: BenchmarkRun, notebook: TechniqueNotebook) {
    this.db.transaction(() => {
      this.saveBenchmark(run)
      this.db
        .prepare(
          `INSERT INTO benchmark_notebook_snapshots
           (run_id, notebook_id, notebook_name, content, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          notebook.id,
          notebook.name,
          notebook.content,
          run.updatedAt,
        )
    })()
  }

  linkBenchmarkGame(runId: string, gameId: string, gameIndex: number) {
    this.db
      .prepare(
        'INSERT INTO benchmark_games (run_id, game_id, game_index) VALUES (?, ?, ?)',
      )
      .run(runId, gameId, gameIndex)
  }

  deleteBenchmark(id: string) {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM games WHERE id IN (SELECT game_id FROM benchmark_games WHERE run_id = ?)',
        )
        .run(id)
      return (
        this.db.prepare('DELETE FROM benchmark_runs WHERE id = ?').run(id)
          .changes > 0
      )
    })
    return transaction()
  }

  listNotebooks(profileId: string): TechniqueNotebookSummary[] {
    return (
      this.db
        .prepare(
          `SELECT id, profile_id, name, created_at, updated_at
           FROM technique_notebooks WHERE profile_id = ? ORDER BY name COLLATE NOCASE, created_at`,
        )
        .all(profileId) as Array<any>
    ).map(mapNotebookSummary)
  }

  getNotebook(profileId: string, id: string): TechniqueNotebook | undefined {
    const row = this.db
      .prepare(
        `SELECT id, profile_id, name, content, created_at, updated_at
         FROM technique_notebooks WHERE profile_id = ? AND id = ?`,
      )
      .get(profileId, id) as any
    return row ? {...mapNotebookSummary(row), content: row.content} : undefined
  }

  createNotebook(profileId: string, name: string): TechniqueNotebook {
    const normalized = normalizeNotebookName(name)
    const value: TechniqueNotebook = {
      id: randomUUID(),
      profileId,
      name: normalized,
      content: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    try {
      this.db
        .prepare(
          `INSERT INTO technique_notebooks
           (id, profile_id, name, name_key, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.profileId,
          value.name,
          value.name.toLocaleLowerCase(),
          value.content,
          value.createdAt,
          value.updatedAt,
        )
    } catch (error) {
      throw notebookConstraintError(error)
    }
    return value
  }

  renameNotebook(profileId: string, id: string, name: string) {
    const normalized = normalizeNotebookName(name)
    const updatedAt = new Date().toISOString()
    let result
    try {
      result = this.db
        .prepare(
          `UPDATE technique_notebooks SET name = ?, name_key = ?, updated_at = ?
           WHERE profile_id = ? AND id = ?`,
        )
        .run(
          normalized,
          normalized.toLocaleLowerCase(),
          updatedAt,
          profileId,
          id,
        )
    } catch (error) {
      throw notebookConstraintError(error)
    }
    if (!result.changes) return undefined
    return this.getNotebook(profileId, id)
  }

  deleteNotebook(profileId: string, id: string) {
    return (
      this.db
        .prepare(
          'DELETE FROM technique_notebooks WHERE profile_id = ? AND id = ?',
        )
        .run(profileId, id).changes > 0
    )
  }

  getNotebookSnapshot(runId: string) {
    return this.db
      .prepare(
        'SELECT content FROM benchmark_notebook_snapshots WHERE run_id = ?',
      )
      .get(runId) as {content: string} | undefined
  }

  saveReflection(
    notebook: TechniqueNotebook,
    run: BenchmarkRun,
    content: string,
  ) {
    const updatedAt = run.notebook.updatedAt ?? new Date().toISOString()
    this.db.transaction(() => {
      const notebookResult = this.db
        .prepare(
          `UPDATE technique_notebooks SET content = ?, updated_at = ?
           WHERE profile_id = ? AND id = ?`,
        )
        .run(content, updatedAt, notebook.profileId, notebook.id)
      if (!notebookResult.changes)
        throw new Error('The selected technique notebook no longer exists')
      this.db
        .prepare(
          `INSERT INTO benchmark_notebook_snapshots
           (run_id, notebook_id, notebook_name, content, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET content = excluded.content,
           updated_at = excluded.updated_at`,
        )
        .run(run.id, notebook.id, notebook.name, content, updatedAt)
      this.saveBenchmark(run)
    })()
  }

  saveReflectionWithContext(
    notebook: TechniqueNotebook,
    run: BenchmarkRun,
    content: string,
    context: LlmGameContext,
  ) {
    this.db.transaction(() => {
      const updatedAt = run.notebook.updatedAt ?? new Date().toISOString()
      const notebookResult = this.db
        .prepare(
          `UPDATE technique_notebooks SET content = ?, updated_at = ?
           WHERE profile_id = ? AND id = ?`,
        )
        .run(content, updatedAt, notebook.profileId, notebook.id)
      if (!notebookResult.changes)
        throw new Error('The selected technique notebook no longer exists')
      this.db
        .prepare(
          `INSERT INTO benchmark_notebook_snapshots
           (run_id, notebook_id, notebook_name, content, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET content = excluded.content,
           updated_at = excluded.updated_at`,
        )
        .run(run.id, notebook.id, notebook.name, content, updatedAt)
      this.saveBenchmark(run)
      this.saveLlmGameContext(context)
    })()
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
          `SELECT id, name, connection_id, model_id, temperature, reasoning_enabled, request_options_json, style_prompt
           FROM player_profiles ORDER BY name COLLATE NOCASE, name, id`,
        )
        .all() as Array<any>
    ).map(mapProfile)
  }

  getProfile(id: string): PlayerProfile | undefined {
    const row = this.db
      .prepare(
        'SELECT id, name, connection_id, model_id, temperature, reasoning_enabled, request_options_json, style_prompt FROM player_profiles WHERE id = ?',
      )
      .get(id) as any
    return row ? mapProfile(row) : undefined
  }

  saveProfile(profile: PlayerProfile) {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO player_profiles (id, name, connection_id, model_id, temperature, reasoning_enabled, request_options_json, style_prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, connection_id = excluded.connection_id,
         model_id = excluded.model_id, temperature = excluded.temperature, reasoning_enabled = excluded.reasoning_enabled,
         request_options_json = excluded.request_options_json,
         style_prompt = excluded.style_prompt, updated_at = excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.name,
        profile.connectionId,
        profile.modelId,
        profile.temperature,
        profile.reasoningEnabled === false ? 0 : 1,
        profile.requestOptions?.length
          ? JSON.stringify(profile.requestOptions)
          : null,
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
    reasoningEnabled: Boolean(row.reasoning_enabled),
    requestOptions: row.request_options_json
      ? JSON.parse(row.request_options_json)
      : undefined,
    stylePrompt: row.style_prompt ?? undefined,
  }
}

function mapNotebookSummary(row: any): TechniqueNotebookSummary {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeNotebookName(name: string) {
  const normalized = name.trim()
  if (!normalized || normalized.length > 120)
    throw new Error('Notebook name must contain 1 to 120 characters')
  return normalized
}

function normalizeBenchmark(run: BenchmarkRun): BenchmarkRun {
  return {
    ...run,
    config: {
      ...run.config,
      trainingGameCount: run.config.trainingGameCount ?? 10,
      notebookId: run.config.notebookId ?? run.notebook?.notebookId ?? '',
    },
  }
}

function notebookConstraintError(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
    return new Error(
      'A notebook with this name already exists for this profile',
    )
  return error
}
