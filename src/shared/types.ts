import {z} from 'zod'

export const boardSizeSchema = z.union([
  z.literal(9),
  z.literal(13),
  z.literal(19),
])
export type BoardSize = z.infer<typeof boardSizeSchema>
export type Color = 'B' | 'W'
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

export interface PlayerProfile {
  id: string
  name: string
  connectionId: string
  modelId: string
  temperature: number
  stylePrompt?: string
}

export type Seat =
  {type: 'human'; name: string} | {type: 'llm'; name: string; profileId: string}

export interface Move {
  number: number
  color: Color
  action: 'play' | 'pass' | 'resign'
  point?: Point
  coordinate?: string
  comment?: string
  reasoning?: string
  captured: number
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  model?: string
  retries?: number
}

export type GameStatus = 'active' | 'paused' | 'scoring' | 'finished' | 'error'

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
  moveCap: number
  dead: Point[]
  approvals: Color[]
  operatorConfirmationRequired?: boolean
  result?: string
  error?: string
  pending?: boolean
  score?: Score
  createdAt: string
  updatedAt: string
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
})
export type NewGameInput = z.infer<typeof newGameSchema>

export const commandSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  type: z.enum([
    'play',
    'pass',
    'resign',
    'undo',
    'pause',
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
}

export interface LlmActionResult {
  action: PlayerAction
  reasoning?: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  model: string
  retries: number
}
