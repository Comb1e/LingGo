import {z} from 'zod'

export const boardSizeSchema = z.union([
  z.literal(9),
  z.literal(13),
  z.literal(19),
])
export type BoardSize = z.infer<typeof boardSizeSchema>
export type Color = 'B' | 'W'
export type KataGoSeat = Color | 'kata'
export type Point = [number, number]

export const playerActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('play'),
    coordinate: z.string().min(2),
    comment: z.string().default(''),
  }),
  z.object({action: z.literal('pass'), comment: z.string().default('')}),
  z.object({action: z.literal('resign'), comment: z.string().default('')}),
])
export type PlayerAction = z.infer<typeof playerActionSchema>

export const providerKindSchema = z.enum([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'compatible',
  'fake',
])
export type ProviderKind = z.infer<typeof providerKindSchema>

export interface ProviderConnection {
  id: string
  name: string
  kind: ProviderKind
  baseUrl?: string
  supportsStructuredOutput: boolean
  hasSessionKey?: boolean
}

export interface RequestOption {
  name: string
  content: string
}

export interface PlayerProfile {
  id: string
  name: string
  connectionId: string
  modelId: string
  temperature: number
  reasoningEnabled?: boolean
  /** Optional extra-body control for APIs that implement DeepSeek-style thinking. */
  reasoningControl?: 'automatic' | 'extra_body'
  requestOptions?: RequestOption[]
  stylePrompt?: string
}

export type Seat =
  | {type: 'human'; name: string}
  | {type: 'llm'; name: string; profileId: string}
  | {type: 'katago'; name: string}

export interface Move {
  number: number
  color: Color
  action: 'play' | 'pass' | 'resign'
  point?: Point
  coordinate?: string
  comment?: string
  reasoning?: string
  captured: number
  capturedPoints?: Point[]
  latencyMs?: number
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  model?: string
  providerKind?: ProviderKind
  retries?: number
  retryErrors?: string[]
  forced?: boolean
}

export type GameStatus = 'active' | 'paused' | 'scoring' | 'finished' | 'error'

export type ModelTurnState =
  | {phase: 'requesting'; attempt: number; maxAttempts: number}
  | {
      phase: 'retrying'
      attempt: number
      maxAttempts: number
      lastError: string
    }

export interface LlmVisibleMessage {
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

export interface LlmMessageSet {
  color: Color
  status:
    | 'uninitialized'
    | 'active'
    | 'repairing'
    | 'reflecting'
    | 'needs_rebase'
    | 'complete'
  providerKind: ProviderKind
  continuationMode: 'provider' | 'transcript'
  messages: LlmVisibleMessage[]
}

export interface Game {
  id: string
  version: number
  size: BoardSize
  komi: number
  board: number[][]
  toMove: Color
  status: GameStatus
  black: Seat
  white: Seat
  moves: Move[]
  captures: {B: number; W: number}
  commentsVisible: boolean
  autoplay: boolean
  pauseAfterMove?: boolean
  moveCap: number
  dead: Point[]
  approvals: Color[]
  operatorConfirmationRequired?: boolean
  result?: string
  error?: string
  providerErrors?: string[]
  pending?: boolean
  modelTurn?: ModelTurnState
  score?: Score
  analysisEnabled?: boolean
  shareAnalysisWithLlm?: boolean
  benchmarkRunId?: string
  benchmarkGameIndex?: number
  benchmarkTermination?: BenchmarkGameTermination
  rejectedModelActions?: RejectedModelAction[]
  createdAt: string
  updatedAt: string
}

export type BenchmarkGameTermination = {
  kind: 'invalid_llm_actions'
  turn: number
  actionCount: number
  reason: string
}

export interface RejectedModelAction {
  turn: number
  attempt: number
  responseContent: string
  reason: string
  timestamp: string
  truncated: boolean
}

export const seatSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('human'),
    name: z.string().min(1).default('Human'),
  }),
  z.object({
    type: z.literal('llm'),
    name: z.string().min(1),
    profileId: z.string().min(1),
  }),
])

export const newGameSchema = z.object({
  size: boardSizeSchema.default(19),
  komi: z.number().min(-100).max(100).default(7.5),
  black: seatSchema,
  white: seatSchema,
  commentsVisible: z.boolean().default(true),
  moveCap: z.number().int().positive().optional(),
  analysisEnabled: z.boolean().default(true),
  shareAnalysisWithLlm: z.boolean().default(false),
})
export type NewGameInput = z.input<typeof newGameSchema>

export const commandSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  type: z.enum([
    'play',
    'pass',
    'resign',
    'undo',
    'pause',
    'step',
    'resume',
    'retry',
    'force-pass',
    'toggle-dead',
    'approve-score',
    'resume-play',
    'change-profile',
    'set-comments',
  ]),
  coordinate: z.string().optional(),
  color: z.enum(['B', 'W']).optional(),
  profileId: z.string().optional(),
  visible: z.boolean().optional(),
})

export interface GamePosition {
  gameId: string
  turn: number
  board: number[][]
  toMove: Color
  captures: {B: number; W: number}
}

export interface Score {
  black: number
  white: number
  territory: {B: Point[]; W: Point[]}
  result: string
}

export interface GameSnapshot {
  size: BoardSize
  board: number[][]
  toMove: Color
  moves: Move[]
  captures: {B: number; W: number}
  komi: number
  rules: string
  previousError?: string
  kataGoAnalysis?: string
}

export interface LlmActionResult {
  action: PlayerAction
  responseContent?: string
  reasoning?: string
  latencyMs: number
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  model: string
  providerKind?: ProviderKind
  retries: number
  retryErrors?: string[]
}

export interface KataGoSettings {
  executablePath: string
  modelPath: string
  configPath: string
  analysisVisits: number
  updatedAt: string
}

export interface KataGoHealth {
  ok: boolean
  message: string
  winRate?: number
  scoreLead?: number
}

export interface KataGoCandidate {
  move: string
  point: Point
  winRate: number
  visits: number
}

export interface KataGoPositionReview {
  gameId: string
  turn: number
  toMove: Color
  visits: number
  candidates: KataGoCandidate[]
}

export interface PositionAnalysis {
  gameId: string
  turn: number
  blackWinRate: number
  whiteWinRate: number
  blackScoreLead: number
  visits: number
  positionHash: string
  createdAt: string
}

export type AnalysisStatus = 'idle' | 'running' | 'complete' | 'error'
export interface GameAnalysis {
  enabled: boolean
  shareWithLlm: boolean
  managedByBenchmark?: boolean
  status: AnalysisStatus
  positions: PositionAnalysis[]
  error?: string
}

export type BenchmarkStatus =
  'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'invalid'
export type BenchmarkPhase =
  | 'initializing_notebook'
  | 'solving_problem'
  | 'updating_problem_notebook'
  | 'training_game'
  | 'reviewing_game'
  | 'final_game'
  | 'complete'
  // Retained so invalidated V1 runs remain readable as historical records.
  | 'training'
  | 'reflection'
  | 'final'

export type ActiveBenchmarkSubstate =
  | {kind: 'ready'}
  | {
      kind: 'provider_request'
      operation:
        | 'initialize'
        | 'compress'
        | 'move'
        | 'review'
        | 'problem'
        | 'problem_notebook'
      attempt: number
      maxAttempts: number
    }
  | {
      kind: 'provider_retry'
      operation:
        | 'initialize'
        | 'compress'
        | 'move'
        | 'review'
        | 'problem'
        | 'problem_notebook'
      attempt: number
      maxAttempts: number
      lastError: string
    }
  | {kind: 'compressing'; attempt: number; maxAttempts: number}
  | {kind: 'waiting_credentials'}
  | {kind: 'waiting_katago'}
export type BenchmarkSubstate =
  ActiveBenchmarkSubstate | {kind: 'paused'; previous: ActiveBenchmarkSubstate}

export const notebookSeedSchema = z.discriminatedUnion('mode', [
  z.object({mode: z.literal('rules_only')}),
  z.object({mode: z.literal('refine_existing'), notebookId: z.string().min(1)}),
])
export type NotebookSeed = z.infer<typeof notebookSeedSchema>

export const benchmarkConfigSchema = z
  .object({
    profileId: z.string().min(1),
    finalColor: z.enum(['B', 'W']),
    trainingGameCount: z.number().int().min(1).max(1000),
    trainingGamesWithWinRates: z.number().int().min(0).max(1000).optional(),
    trainingGamesWithoutWinRates: z.number().int().min(0).max(1000).optional(),
    notebookSeed: notebookSeedSchema.default({mode: 'rules_only'}),
    trainingFeedback: z.enum(['none', 'structured']).default('structured'),
    notebookTokenBudget: z.number().int().min(256).max(100_000).default(10_000),
    trainingVisits: z.number().int().min(25).max(100_000).default(10_000),
    evaluationVisits: z.number().int().min(25).max(100_000).default(10_000),
    problemSetId: z.string().min(1).optional(),
    problemSetChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.problemSetId === undefined) !==
      (value.problemSetChecksum === undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['problemSetChecksum'],
        message: 'Problem set ID and checksum must be provided together',
      })
    const withWinRates = value.trainingGamesWithWinRates
    const withoutWinRates = value.trainingGamesWithoutWinRates
    if ((withWinRates === undefined) !== (withoutWinRates === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['trainingGamesWithWinRates'],
        message: 'Both training game feedback counts must be provided together',
      })
      return
    }
    if (
      withWinRates !== undefined &&
      withoutWinRates !== undefined &&
      withWinRates + withoutWinRates !== value.trainingGameCount
    ) {
      context.addIssue({
        code: 'custom',
        path: ['trainingGameCount'],
        message:
          'Training game count must equal the with-win-rates and without-win-rates counts combined',
      })
    }
  })
  .refine((value) => value.evaluationVisits >= value.trainingVisits, {
    message: 'Evaluation visits must be at least training visits',
    path: ['evaluationVisits'],
  })
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>

export interface BenchmarkUsage {
  calls: number
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  latencyMs: number
  byPhase?: Partial<
    Record<
      | 'initializing_notebook'
      | 'training_game'
      | 'reviewing_game'
      | 'final_game'
      | 'solving_problem'
      | 'updating_problem_notebook',
      Omit<BenchmarkUsage, 'byPhase'>
    >
  >
}

export interface BenchmarkMetrics {
  result: string
  averagePointLoss: number
  averageWinRateLoss: number
  moveCount: number
  moveQuality: number
  resultScore: number
  score: number
  outputRepairRate?: number
  trainingReviewCount?: number
  notebookGrowthCharacters?: number
  problemCount?: number
  problemAttempts?: number
  firstResponseSuccessRate?: number
  problemFailures?: number
  completedCleanCycles?: number
  kataGoGateReached?: boolean
}

export interface NotebookMetadata {
  profileId: string
  notebookId?: string
  name?: string
  currentUrl?: string
  snapshotUrl?: string
  updatedAt?: string
}

export interface TechniqueNotebookSummary {
  id: string
  profileId: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface TechniqueNotebook extends TechniqueNotebookSummary {
  content: string
}

export interface BenchmarkRun {
  id: string
  protocolVersion: 1 | 2 | 3
  status: BenchmarkStatus
  phase: BenchmarkPhase
  substate: BenchmarkSubstate
  config: BenchmarkConfig
  profileSnapshot: PlayerProfile
  modelFingerprint: string
  currentGame: number
  currentTurn: number
  gameIds: string[]
  usage: BenchmarkUsage
  notebook: NotebookMetadata
  notebookVersion: number
  notebookEstimatedTokens: number
  problemCursor?: number
  currentProblemId?: string
  problemSuccessStreak?: number
  problemSetChecksum?: string
  kataGoFingerprint: string
  sourceRunId?: string
  successorRunId?: string
  metrics?: BenchmarkMetrics
  error?: string
  waitingFor?: 'credentials' | 'katago'
  pauseAfterLlmMove?: boolean
  createdAt: string
  updatedAt: string
}

export type BenchmarkNotebookSourcePhase =
  'initializing_notebook' | 'reviewing_game' | 'problem_notebook'

export interface BenchmarkProblemAttempt {
  runId: string
  sequence: number
  problemId: string
  cursor: number
  actualAction?: PlayerAction
  expectedAction: PlayerAction
  legal: boolean
  correct: boolean
  firstResponse: boolean
  failureReason?: string
  notebookVersionBefore: number
  notebookVersionAfter?: number
  promptDigest: string
  responseDigest?: string
  createdAt: string
}

export interface BenchmarkProblemView {
  id: string
  title?: string
  tags?: string[]
  size: BoardSize
  komi: number
  sideToMove: Color
  board: number[][]
  moves: Move[]
  captures: {B: number; W: number}
}

export interface BenchmarkNotebookVersion {
  runId: string
  version: number
  sourcePhase: BenchmarkNotebookSourcePhase
  content: string
  digest: string
  characterCount: number
  byteCount: number
  estimatedTokens: number
  createdAt: string
}

export interface BenchmarkMoveReview {
  runId: string
  gameId: string
  gameIndex: number
  turn: number
  color: Color
  chosenMove: string
  topCandidate?: string
  topCandidates?: string[]
  pointLoss: number
  winRateLoss: number
  beforeScore: number
  afterScore: number
  beforeWinRate: number
  afterWinRate: number
  position: {
    size: BoardSize
    komi: number
    board: number[][]
    toMove: Color
    captures: {B: number; W: number}
  }
  createdAt: string
}

/** Inference-time adaptation conditions used by the research protocol. */
export const researchConditionSchema = z.enum([
  'no_adaptation',
  'reflection_only',
  'katago_feedback',
  'reflection_plus_katago',
])
export type ResearchCondition = z.infer<typeof researchConditionSchema>

export const researchProtocolSchema = z.object({
  protocolVersion: z.string().min(1),
  movePromptVersion: z.string().min(1),
  reflectionPromptVersion: z.string().min(1),
  notebookFormatVersion: z.string().min(1),
  metricVersion: z.string().min(1),
})
export type ResearchProtocol = z.infer<typeof researchProtocolSchema>

export const researchManifestSchema = z.object({
  experimentId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  runId: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  model: z.object({
    provider: providerKindSchema,
    modelId: z.string().min(1),
    fingerprint: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
  }),
  boardSize: boardSizeSchema.default(9),
  komi: z.number().min(-100).max(100).default(7.5),
  rules: z.string().default('chinese'),
  moveCap: z.number().int().positive().max(10_000).default(722),
  trainingGameCount: z.number().int().min(0).max(1000).default(1),
  evaluationGameCount: z.number().int().min(0).max(1000).default(1),
  evaluationPositionCount: z.number().int().min(0).max(100_000).default(0),
  evaluator: z
    .object({
      executable: z.string().default('deterministic'),
      network: z.string().default('deterministic'),
      config: z.string().default('deterministic'),
      visits: z.number().int().min(1).max(1_000_000).default(1000),
      fingerprint: z.string().min(1).optional(),
    })
    .default({
      executable: 'deterministic',
      network: 'deterministic',
      config: 'deterministic',
      visits: 1000,
    }),
  trainingVisits: z.number().int().min(1).max(1_000_000).default(100),
  seed: z.number().int().default(1),
  condition: researchConditionSchema,
  notebookId: z.string().min(1).optional(),
  initialNotebook: z.string().default(''),
  initialNotebookDigest: z.string().min(1).optional(),
  liveProvider: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(64).default(1),
  rawTraces: z.boolean().default(false),
  positionSet: z.string().optional(),
  protocol: researchProtocolSchema.default({
    protocolVersion: 'research-v1',
    movePromptVersion: 'move-v1',
    reflectionPromptVersion: 'reflection-v1',
    notebookFormatVersion: 'notebook-v1',
    metricVersion: 'metrics-v1',
  }),
  softwareVersion: z.string().default('unknown'),
  createdAt: z.string().datetime().optional(),
})
export type ResearchManifest = z.infer<typeof researchManifestSchema>

export interface ResearchMoveTrace {
  game: number
  turn: number
  positionHash: string
  historyHash: string
  color: Color
  condition: ResearchCondition
  promptHash: string
  notebookDigest: string
  response?: string
  cacheKey?: string
  parsedAction?: PlayerAction
  legal: boolean
  retries: number
  retryErrors?: string[]
  kataGoBefore?: {winRate: number; scoreLead: number; visits: number}
  kataGoAfter?: {winRate: number; scoreLead: number; visits: number}
  pointLoss?: number
  winRateLoss?: number
  inputTokens: number
  outputTokens: number
  latencyMs: number
  modelFingerprint: string
  providerFingerprint: string
  timestamp: string
}

export const researchPositionSchema = z.object({
  sourceId: z.string().min(1),
  sourceChecksum: z.string().min(1),
  boardSize: boardSizeSchema,
  komi: z.number(),
  moveHistory: z.array(
    z.object({color: z.enum(['B', 'W']), move: z.string().min(1)}),
  ),
  sideToMove: z.enum(['B', 'W']),
  split: z.enum(['train', 'evaluation']),
  opening: z.string().optional(),
  gameId: z.string().optional(),
})
export type ResearchPosition = z.infer<typeof researchPositionSchema>
