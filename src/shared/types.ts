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
  rejectedModelActions?: RejectedModelAction[]
  createdAt: string
  updatedAt: string
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
export type BenchmarkPhase = 'training' | 'reflection' | 'final' | 'complete'

export const benchmarkConfigSchema = z.object({
  profileId: z.string().min(1),
  finalColor: z.enum(['B', 'W']),
  visits: z.number().int().min(25).max(100_000),
  includeTrainingWinRates: z.boolean(),
  trainingGameCount: z.number().int().min(1).max(1000),
  notebookId: z.string().min(1),
})
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>

export interface BenchmarkUsage {
  calls: number
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  latencyMs: number
}

export interface BenchmarkMetrics {
  result: string
  averagePointLoss: number
  averageWinRateLoss: number
  moveCount: number
  moveQuality: number
  resultScore: number
  score: number
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
  status: BenchmarkStatus
  phase: BenchmarkPhase
  config: BenchmarkConfig
  profileSnapshot: PlayerProfile
  modelFingerprint: string
  currentGame: number
  currentTurn: number
  gameIds: string[]
  usage: BenchmarkUsage
  notebook: NotebookMetadata
  metrics?: BenchmarkMetrics
  error?: string
  waitingFor?: 'credentials' | 'katago'
  pauseAfterLlmMove?: boolean
  createdAt: string
  updatedAt: string
}
