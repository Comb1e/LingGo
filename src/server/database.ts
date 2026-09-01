import Database from 'better-sqlite3'
import {existsSync, mkdirSync, readFileSync, readdirSync} from 'node:fs'
import {createHash, randomUUID} from 'node:crypto'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {
  BenchmarkRun,
  BenchmarkSession,
  BenchmarkSessionNotebookVersion,
  BenchmarkSessionStage,
  BenchmarkMoveReview,
  BenchmarkProblemAttempt,
  BenchmarkNotebookVersion,
  Game,
  GameAnalysis,
  KataGoSettings,
  PlayerProfile,
  PositionAnalysis,
  ProviderConnection,
  TechniqueNotebook,
  TechniqueNotebookSummary,
} from '../shared/types'
import {DEFAULT_KATAGO_VISITS} from '../shared/constants'
import type {LlmGameContext} from './llmGameContext'
import {transitionLlmContext} from './stateMachines/llmContext'
import {
  KATAGO_LEGACY_DEFAULTS,
  KATAGO_PORTABLE_DEFAULTS,
  loadStorageConfig,
  resolveKataGoDefaults,
} from './config'

const here = dirname(fileURLToPath(import.meta.url))

export class Store {
  readonly db: Database.Database
  private deletedBenchmarkIds = new Set<string>()

  constructor(filename = loadStorageConfig().databasePath) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive: true})
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
    this.reconcileLegacyKataGoSettings()
    this.seedFakeProvider()
    this.importLegacyNotebooks()
    this.migrateActiveV1Benchmarks()
  }

  private reconcileLegacyKataGoSettings() {
    const defaults = resolveKataGoDefaults()
    const row = this.db
      .prepare('SELECT * FROM katago_settings WHERE singleton = 1')
      .get() as
      | {
          executable_path: string
          model_path: string
          config_path: string
        }
      | undefined
    if (!row) return
    const next = {
      executablePath:
        row.executable_path === KATAGO_LEGACY_DEFAULTS.executablePath ||
        row.executable_path === KATAGO_PORTABLE_DEFAULTS.executablePath
          ? defaults.executablePath
          : row.executable_path,
      modelPath:
        row.model_path === KATAGO_LEGACY_DEFAULTS.modelPath ||
        row.model_path === KATAGO_PORTABLE_DEFAULTS.modelPath
          ? defaults.modelPath
          : row.model_path,
      configPath:
        row.config_path === KATAGO_LEGACY_DEFAULTS.configPath ||
        row.config_path === KATAGO_PORTABLE_DEFAULTS.configPath
          ? defaults.configPath
          : row.config_path,
    }
    if (
      next.executablePath === row.executable_path &&
      next.modelPath === row.model_path &&
      next.configPath === row.config_path
    )
      return
    this.db
      .prepare(
        `UPDATE katago_settings SET executable_path = ?, model_path = ?,
         config_path = ?, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`,
      )
      .run(next.executablePath, next.modelPath, next.configPath)
  }

  private importLegacyNotebooks() {
    const key = 'named_notebooks_legacy_imported'
    if (this.db.prepare('SELECT 1 FROM app_metadata WHERE key = ?').get(key))
      return
    const root = loadStorageConfig().techniquesDir
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

  private migrateActiveV1Benchmarks() {
    const rows = this.db
      .prepare(
        `SELECT run_json FROM benchmark_runs
         WHERE status IN ('queued', 'running', 'paused')`,
      )
      .all() as Array<{run_json: string}>
    for (const row of rows) {
      const legacy = JSON.parse(row.run_json) as any
      if (legacy.protocolVersion === 2) continue
      const now = new Date().toISOString()
      const successorId = randomUUID()
      const visits = legacy.config.visits ?? DEFAULT_KATAGO_VISITS
      const successor: BenchmarkRun = {
        id: successorId,
        protocolVersion: 2,
        status: legacy.status === 'paused' ? 'paused' : 'queued',
        phase: 'initializing_notebook',
        substate:
          legacy.status === 'paused'
            ? {kind: 'paused', previous: {kind: 'ready'}}
            : {kind: 'ready'},
        config: {
          profileId: legacy.config.profileId,
          finalColor: legacy.config.finalColor,
          trainingGameCount: legacy.config.trainingGameCount ?? 10,
          trainingGamesWithWinRates: legacy.config.includeTrainingWinRates
            ? (legacy.config.trainingGameCount ?? 10)
            : 0,
          trainingGamesWithoutWinRates: legacy.config.includeTrainingWinRates
            ? 0
            : (legacy.config.trainingGameCount ?? 10),
          notebookSeed: {mode: 'rules_only'},
          trainingFeedback: legacy.config.includeTrainingWinRates
            ? 'structured'
            : 'none',
          notebookTokenBudget: 8000,
          notebookInitializationTokenLimit: 8000,
          trainingVisits: visits,
          evaluationVisits: visits,
        },
        profileSnapshot: legacy.profileSnapshot,
        modelFingerprint: legacy.modelFingerprint,
        kataGoFingerprint: kataGoFingerprint(this.getKataGoSettings()),
        currentGame: 0,
        currentTurn: 0,
        gameIds: [],
        usage: emptyBenchmarkUsage(),
        notebook: {
          profileId: legacy.config.profileId,
          snapshotUrl: `/api/benchmarks/${successorId}/notebook.md`,
        },
        notebookVersion: 0,
        notebookEstimatedTokens: 0,
        sourceRunId: legacy.id,
        createdAt: now,
        updatedAt: now,
      }
      legacy.protocolVersion = 1
      legacy.status = 'invalid'
      legacy.successorRunId = successorId
      legacy.error =
        'Invalidated by Benchmark Protocol V2; continue with the linked successor run.'
      legacy.updatedAt = now
      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE benchmark_runs SET status = 'invalid', run_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(JSON.stringify(legacy), now, legacy.id)
        this.saveBenchmark(successor)
      })
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
         (id, name, connection_id, model_id, temperature, style_prompt, reasoning_control, created_at, updated_at)
         VALUES ('builtin-fake-profile', 'Local learner', 'builtin-fake', 'deterministic-v1', 0, 'Play simple legal moves.', 'automatic', ?, ?)`,
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
         game_intention,
         intention_turn,
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
        gameIntention: row.game_intention ?? undefined,
        lastIntentionTurn: row.intention_turn ?? undefined,
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
          game_intention, intention_turn, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, color) DO UPDATE SET
         status = excluded.status, profile_id = excluded.profile_id,
         provider_kind = excluded.provider_kind,
         model_fingerprint = excluded.model_fingerprint,
         last_observed_move = excluded.last_observed_move,
         transcript_json = excluded.transcript_json,
         pending_turn_json = excluded.pending_turn_json,
         provider_continuation_id = excluded.provider_continuation_id,
         managed_continuation = excluded.managed_continuation,
         game_intention = excluded.game_intention,
         intention_turn = excluded.intention_turn,
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
        context.gameIntention ?? null,
        context.lastIntentionTurn ?? null,
        context.createdAt,
        context.updatedAt,
      )
  }

  markLlmGameContextsNeedsRebase(
    gameId: string,
    color?: 'B' | 'W',
    gameIntention?: string,
    intentionTurn?: number,
  ) {
    const contexts = this.listLlmGameContexts(gameId).filter(
      (context) => !color || context.color === color,
    )
    this.transaction(() => {
      for (const context of contexts) {
        transitionLlmContext(context, {type: 'rebase'})
        context.pendingTurn = undefined
        context.providerContinuationId = undefined
        context.gameIntention = gameIntention ?? context.gameIntention
        context.lastIntentionTurn = intentionTurn ?? context.lastIntentionTurn
        context.updatedAt = new Date().toISOString()
        this.saveLlmGameContext(context)
      }
    })
  }

  disableManagedLlmContinuation(
    gameId: string,
    color: 'B' | 'W',
    gameIntention?: string,
    intentionTurn?: number,
  ) {
    const context = this.getLlmGameContext(gameId, color)
    if (!context) return
    transitionLlmContext(context, {type: 'rebase'})
    context.pendingTurn = undefined
    context.providerContinuationId = undefined
    context.managedContinuation = false
    context.gameIntention = gameIntention ?? context.gameIntention
    context.lastIntentionTurn = intentionTurn ?? context.lastIntentionTurn
    context.updatedAt = new Date().toISOString()
    this.saveLlmGameContext(context)
  }

  completeLlmGameContexts(gameId: string) {
    const contexts = this.listLlmGameContexts(gameId)
    this.transaction(() => {
      for (const context of contexts) {
        transitionLlmContext(context, {type: 'complete'})
        context.pendingTurn = undefined
        context.updatedAt = new Date().toISOString()
        this.saveLlmGameContext(context)
      }
    })
  }

  deleteGame(id: string) {
    return this.db.prepare('DELETE FROM games WHERE id = ?').run(id).changes > 0
  }

  deleteAllForTests() {
    this.deletedBenchmarkIds.clear()
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
    if (this.deletedBenchmarkIds.has(run.id)) return
    this.db
      .prepare(
        `INSERT INTO benchmark_runs (id, status, phase, profile_id, run_json, created_at, updated_at, session_id, stage_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, phase = excluded.phase,
       run_json = excluded.run_json, updated_at = excluded.updated_at,
       session_id = excluded.session_id, stage_key = excluded.stage_key`,
      )
      .run(
        run.id,
        run.status,
        run.phase,
        run.config.profileId,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
        run.sessionId ?? null,
        run.stageKey ?? null,
      )
  }

  listBenchmarkSessions(): BenchmarkSession[] {
    return (
      this.db
        .prepare('SELECT id FROM benchmark_sessions ORDER BY created_at DESC')
        .all() as Array<{id: string}>
    ).map(({id}) => this.getBenchmarkSession(id)!)
  }

  getBenchmarkSession(id: string): BenchmarkSession | undefined {
    const row = this.db
      .prepare('SELECT * FROM benchmark_sessions WHERE id = ?')
      .get(id) as any
    if (!row) return undefined
    const stages = this.listBenchmarkSessionStages(id)
    const snapshots = this.db
      .prepare(
        `SELECT role, notebook_id, notebook_name, version, estimated_tokens,
                stage_key, updated_at
         FROM benchmark_session_notebook_snapshots WHERE session_id = ?`,
      )
      .all(id) as any[]
    const notebooks = Object.fromEntries(
      snapshots.map((snapshot) => [
        snapshot.role,
        {
          role: snapshot.role,
          profileId: row.profile_id,
          notebookId: snapshot.notebook_id,
          name: snapshot.notebook_name,
          currentUrl: `/api/profiles/${row.profile_id}/notebooks/${snapshot.notebook_id}.md`,
          snapshotUrl: `/api/benchmark-sessions/${id}/notebooks/${snapshot.role === 'life_death' ? 'life-death' : 'ordinary'}.md`,
          version: snapshot.version,
          estimatedTokens: snapshot.estimated_tokens,
          stageKey: snapshot.stage_key ?? undefined,
          updatedAt: snapshot.updated_at,
        },
      ]),
    ) as BenchmarkSession['notebooks']
    return {
      id: row.id,
      profileId: row.profile_id,
      status: row.status,
      currentStage: row.current_stage,
      stageIds: JSON.parse(row.stage_ids_json),
      config: JSON.parse(row.config_json),
      notebooks,
      stages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    }
  }

  listBenchmarkSessionStages(sessionId: string): BenchmarkSessionStage[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM benchmark_session_stages WHERE session_id = ?
           ORDER BY CASE stage_key WHEN 'life_death_notebook' THEN 0
                    WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 WHEN 'hard' THEN 3
                    WHEN 'ordinary_notebook' THEN 4 ELSE 5 END`,
        )
        .all(sessionId) as any[]
    ).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      stageKey: row.stage_key,
      runId: row.run_id ?? undefined,
      attempt: row.attempt,
      status: row.status,
      writableNotebookRole: row.writable_notebook_role,
      metrics: row.metrics_json ? JSON.parse(row.metrics_json) : undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      updatedAt: row.updated_at,
    }))
  }

  findBenchmarkSessionStageByRun(runId: string) {
    const row = this.db
      .prepare(
        'SELECT session_id FROM benchmark_session_stages WHERE run_id = ?',
      )
      .get(runId) as {session_id: string} | undefined
    return row
      ? this.listBenchmarkSessionStages(row.session_id).find(
          (stage) => stage.runId === runId,
        )
      : undefined
  }

  saveBenchmarkSession(session: BenchmarkSession) {
    this.db
      .prepare(
        `INSERT INTO benchmark_sessions
         (id, profile_id, status, current_stage, stage_ids_json, config_json,
          error, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
          current_stage = excluded.current_stage, stage_ids_json = excluded.stage_ids_json,
          config_json = excluded.config_json, error = excluded.error,
          updated_at = excluded.updated_at, completed_at = excluded.completed_at`,
      )
      .run(
        session.id,
        session.profileId,
        session.status,
        session.currentStage,
        JSON.stringify(session.stageIds),
        JSON.stringify(session.config),
        session.error ?? null,
        session.createdAt,
        session.updatedAt,
        session.completedAt ?? null,
      )
  }

  saveBenchmarkSessionStage(
    stage: BenchmarkSessionStage,
    startNotebookContent?: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO benchmark_session_stages
         (id, session_id, stage_key, run_id, attempt, status,
          writable_notebook_role, start_notebook_content, metrics_json,
          created_at, started_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id,
          attempt = excluded.attempt, status = excluded.status,
          start_notebook_content = COALESCE(excluded.start_notebook_content, start_notebook_content),
          metrics_json = excluded.metrics_json, started_at = excluded.started_at,
          completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      )
      .run(
        stage.id,
        stage.sessionId,
        stage.stageKey,
        stage.runId ?? null,
        stage.attempt,
        stage.status,
        stage.writableNotebookRole,
        startNotebookContent ?? null,
        stage.metrics ? JSON.stringify(stage.metrics) : null,
        stage.createdAt,
        stage.startedAt ?? null,
        stage.completedAt ?? null,
        stage.updatedAt,
      )
  }

  getBenchmarkStageStartContent(stageId: string) {
    return (
      this.db
        .prepare(
          'SELECT start_notebook_content AS content FROM benchmark_session_stages WHERE id = ?',
        )
        .get(stageId) as {content?: string} | undefined
    )?.content
  }

  saveBenchmarkSessionNotebookSnapshot(input: {
    sessionId: string
    role: 'life_death' | 'ordinary'
    notebookId: string
    notebookName: string
    content: string
    version: number
    estimatedTokens: number
    stageKey?: string
    updatedAt: string
  }) {
    this.db
      .prepare(
        `INSERT INTO benchmark_session_notebook_snapshots
         (session_id, role, notebook_id, notebook_name, content, version,
          estimated_tokens, stage_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, role) DO UPDATE SET content = excluded.content,
          version = excluded.version, estimated_tokens = excluded.estimated_tokens,
          stage_key = excluded.stage_key, updated_at = excluded.updated_at`,
      )
      .run(
        input.sessionId,
        input.role,
        input.notebookId,
        input.notebookName,
        input.content,
        input.version,
        input.estimatedTokens,
        input.stageKey ?? null,
        input.updatedAt,
      )
  }

  getBenchmarkSessionNotebookSnapshot(sessionId: string, role: string) {
    return this.db
      .prepare(
        `SELECT notebook_id AS notebookId, notebook_name AS notebookName,
                content, version, estimated_tokens AS estimatedTokens,
                stage_key AS stageKey, updated_at AS updatedAt
         FROM benchmark_session_notebook_snapshots
         WHERE session_id = ? AND role = ?`,
      )
      .get(sessionId, role) as any
  }

  syncBenchmarkSessionNotebookVersions(
    sessionId: string,
    role: 'life_death' | 'ordinary',
    stage: BenchmarkSessionStage,
  ) {
    if (!stage.runId) return
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO benchmark_session_notebook_versions
       (session_id, role, stage_key, attempt, run_id, version, source_phase,
        content, digest, character_count, byte_count, estimated_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const version of this.listBenchmarkNotebookVersions(stage.runId))
      insert.run(
        sessionId,
        role,
        stage.stageKey,
        stage.attempt,
        stage.runId,
        version.version,
        version.sourcePhase,
        version.content,
        version.digest,
        version.characterCount,
        version.byteCount,
        version.estimatedTokens,
        version.createdAt,
      )
  }

  listBenchmarkSessionNotebookVersions(
    sessionId: string,
    stageKey: string,
  ): BenchmarkSessionNotebookVersion[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM benchmark_session_notebook_versions
           WHERE session_id = ? AND stage_key = ? ORDER BY attempt, version`,
        )
        .all(sessionId, stageKey) as any[]
    ).map((row) => ({
      sessionId: row.session_id,
      role: row.role,
      stageKey: row.stage_key,
      attempt: row.attempt,
      runId: row.run_id,
      version: row.version,
      sourcePhase: row.source_phase,
      content: row.content,
      digest: row.digest,
      characterCount: row.character_count,
      byteCount: row.byte_count,
      estimatedTokens: row.estimated_tokens,
      createdAt: row.created_at,
    }))
  }

  deleteBenchmarkSession(id: string) {
    return this.transaction(() => {
      const runIds = (
        this.db
          .prepare('SELECT id FROM benchmark_runs WHERE session_id = ?')
          .all(id) as Array<{id: string}>
      ).map(({id: runId}) => runId)
      for (const runId of runIds) this.deleteBenchmark(runId)
      return (
        this.db.prepare('DELETE FROM benchmark_sessions WHERE id = ?').run(id)
          .changes > 0
      )
    })
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

  saveBenchmarkWithSeed(run: BenchmarkRun, notebook?: TechniqueNotebook) {
    this.transaction(() => {
      this.saveBenchmark(run)
      const content = notebook?.content ?? ''
      this.db
        .prepare(
          `INSERT INTO benchmark_notebook_seeds
           (run_id, notebook_id, content, digest, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          notebook?.id ?? null,
          content,
          createHash('sha256').update(content).digest('hex'),
          run.createdAt,
        )
    })
  }

  getBenchmarkNotebookSeed(runId: string) {
    return this.db
      .prepare(
        `SELECT notebook_id AS notebookId, content, digest, created_at AS createdAt
         FROM benchmark_notebook_seeds WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          notebookId?: string
          content: string
          digest: string
          createdAt: string
        }
      | undefined
  }

  saveBenchmarkNotebookVersion(
    run: BenchmarkRun,
    version: BenchmarkNotebookVersion,
  ) {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO benchmark_notebook_versions
           (run_id, version, source_phase, content, digest, character_count,
            byte_count, estimated_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.runId,
          version.version,
          version.sourcePhase,
          version.content,
          version.digest,
          version.characterCount,
          version.byteCount,
          version.estimatedTokens,
          version.createdAt,
        )
      this.db
        .prepare(
          `INSERT INTO benchmark_notebook_snapshots
           (run_id, notebook_id, notebook_name, content, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET content = excluded.content,
           updated_at = excluded.updated_at`,
        )
        .run(
          run.id,
          run.notebook.notebookId ?? null,
          run.notebook.name ?? 'Benchmark notebook',
          version.content,
          version.createdAt,
        )
      this.saveBenchmark(run)
    })
  }

  listBenchmarkNotebookVersions(runId: string): BenchmarkNotebookVersion[] {
    return (
      this.db
        .prepare(
          `SELECT run_id, version, source_phase, content, digest, character_count,
                  byte_count, estimated_tokens, created_at
           FROM benchmark_notebook_versions WHERE run_id = ? ORDER BY version`,
        )
        .all(runId) as Array<any>
    ).map((row) => ({
      runId: row.run_id,
      version: row.version,
      sourcePhase: row.source_phase,
      content: row.content,
      digest: row.digest,
      characterCount: row.character_count,
      byteCount: row.byte_count,
      estimatedTokens: row.estimated_tokens,
      createdAt: row.created_at,
    }))
  }

  saveBenchmarkMoveReview(review: BenchmarkMoveReview) {
    this.db
      .prepare(
        `INSERT INTO benchmark_move_reviews
         (run_id, game_id, game_index, turn, review_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, game_id, turn) DO UPDATE SET
         review_json = excluded.review_json, created_at = excluded.created_at`,
      )
      .run(
        review.runId,
        review.gameId,
        review.gameIndex,
        review.turn,
        JSON.stringify(review),
        review.createdAt,
      )
  }

  listBenchmarkMoveReviews(runId: string, gameIndex?: number) {
    const rows = (
      gameIndex === undefined
        ? this.db
            .prepare(
              `SELECT review_json FROM benchmark_move_reviews
             WHERE run_id = ? ORDER BY game_index, turn`,
            )
            .all(runId)
        : this.db
            .prepare(
              `SELECT review_json FROM benchmark_move_reviews
             WHERE run_id = ? AND game_index = ? ORDER BY turn`,
            )
            .all(runId, gameIndex)
    ) as Array<{review_json: string}>
    return rows.map(
      ({review_json}) => JSON.parse(review_json) as BenchmarkMoveReview,
    )
  }

  saveBenchmarkProblemAttempt(attempt: BenchmarkProblemAttempt) {
    this.db
      .prepare(
        `INSERT INTO benchmark_problem_attempts
      (run_id, sequence, problem_id, cursor, actual_action_json, expected_action_json,
       legal, correct, first_response, failure_reason, notebook_version_before,
       notebook_version_after, prompt_digest, response_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, sequence) DO UPDATE SET notebook_version_after = excluded.notebook_version_after,
       failure_reason = excluded.failure_reason`,
      )
      .run(
        attempt.runId,
        attempt.sequence,
        attempt.problemId,
        attempt.cursor,
        attempt.actualAction ? JSON.stringify(attempt.actualAction) : null,
        JSON.stringify(attempt.expectedAction),
        attempt.legal ? 1 : 0,
        attempt.correct ? 1 : 0,
        attempt.firstResponse ? 1 : 0,
        attempt.failureReason ?? null,
        attempt.notebookVersionBefore,
        attempt.notebookVersionAfter ?? null,
        attempt.promptDigest,
        attempt.responseDigest ?? null,
        attempt.createdAt,
      )
  }

  listBenchmarkProblemAttempts(runId: string): BenchmarkProblemAttempt[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM benchmark_problem_attempts WHERE run_id = ? ORDER BY sequence`,
        )
        .all(runId) as any[]
    ).map((row) => ({
      runId: row.run_id,
      sequence: row.sequence,
      problemId: row.problem_id,
      cursor: row.cursor,
      actualAction: row.actual_action_json
        ? JSON.parse(row.actual_action_json)
        : undefined,
      expectedAction: JSON.parse(row.expected_action_json),
      legal: Boolean(row.legal),
      correct: Boolean(row.correct),
      firstResponse: Boolean(row.first_response),
      failureReason: row.failure_reason ?? undefined,
      notebookVersionBefore: row.notebook_version_before,
      notebookVersionAfter: row.notebook_version_after ?? undefined,
      promptDigest: row.prompt_digest,
      responseDigest: row.response_digest ?? undefined,
      createdAt: row.created_at,
    }))
  }

  publishBenchmarkNotebook(
    run: BenchmarkRun,
    content: string,
    input: {mode: 'replace_source'} | {mode: 'save_new'; name: string},
  ) {
    return this.transaction(() => {
      if (input.mode === 'replace_source') {
        const seed = run.config.notebookSeed
        if (seed.mode !== 'refine_existing')
          throw new Error('This run does not have a source notebook to replace')
        const updatedAt = new Date().toISOString()
        const result = this.db
          .prepare(
            `UPDATE technique_notebooks SET content = ?, updated_at = ?
             WHERE profile_id = ? AND id = ?`,
          )
          .run(content, updatedAt, run.config.profileId, seed.notebookId)
        if (!result.changes)
          throw new Error('The source notebook no longer exists')
        return this.getNotebook(run.config.profileId, seed.notebookId)!
      }
      const notebook = this.createNotebook(run.config.profileId, input.name)
      const updatedAt = new Date().toISOString()
      this.db
        .prepare(
          'UPDATE technique_notebooks SET content = ?, updated_at = ? WHERE id = ?',
        )
        .run(content, updatedAt, notebook.id)
      return this.getNotebook(run.config.profileId, notebook.id)!
    })
  }

  linkBenchmarkGame(runId: string, gameId: string, gameIndex: number) {
    this.db
      .prepare(
        'INSERT INTO benchmark_games (run_id, game_id, game_index) VALUES (?, ?, ?)',
      )
      .run(runId, gameId, gameIndex)
  }

  deleteBenchmark(id: string) {
    this.deletedBenchmarkIds.add(id)
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
    this.db.transaction(() => {
      this.saveReflectionRecords(notebook, run, content)
    })()
  }

  saveReflectionWithContext(
    notebook: TechniqueNotebook,
    run: BenchmarkRun,
    content: string,
    context: LlmGameContext,
  ) {
    this.db.transaction(() => {
      this.saveReflectionRecords(notebook, run, content)
      this.saveLlmGameContext(context)
    })()
  }

  private saveReflectionRecords(
    notebook: TechniqueNotebook,
    run: BenchmarkRun,
    content: string,
  ) {
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
          `SELECT id, name, connection_id, model_id, temperature, reasoning_enabled, reasoning_control, request_options_json, style_prompt
           FROM player_profiles ORDER BY name COLLATE NOCASE, name, id`,
        )
        .all() as Array<any>
    ).map(mapProfile)
  }

  getProfile(id: string): PlayerProfile | undefined {
    const row = this.db
      .prepare(
        'SELECT id, name, connection_id, model_id, temperature, reasoning_enabled, reasoning_control, request_options_json, style_prompt FROM player_profiles WHERE id = ?',
      )
      .get(id) as any
    return row ? mapProfile(row) : undefined
  }

  saveProfile(profile: PlayerProfile) {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO player_profiles (id, name, connection_id, model_id, temperature, reasoning_enabled, reasoning_control, request_options_json, style_prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, connection_id = excluded.connection_id,
         model_id = excluded.model_id, temperature = excluded.temperature, reasoning_enabled = excluded.reasoning_enabled,
         reasoning_control = excluded.reasoning_control,
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
        profile.reasoningControl ?? 'automatic',
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
    reasoningControl:
      row.reasoning_control === 'extra_body' ? 'extra_body' : 'automatic',
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

function normalizeBenchmark(value: BenchmarkRun): BenchmarkRun {
  const run = value as any
  if (run.protocolVersion !== 2) return run as BenchmarkRun
  return {
    ...run,
    substate: run.substate ?? {kind: 'ready'},
    notebookVersion: run.notebookVersion ?? 0,
    notebookEstimatedTokens: run.notebookEstimatedTokens ?? 0,
    kataGoFingerprint:
      run.kataGoFingerprint ??
      createHash('sha256').update('unknown').digest('hex'),
  }
}

function emptyBenchmarkUsage() {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    byPhase: {},
  }
}

function kataGoFingerprint(settings: KataGoSettings) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        executablePath: settings.executablePath,
        modelPath: settings.modelPath,
        configPath: settings.configPath,
      }),
    )
    .digest('hex')
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
