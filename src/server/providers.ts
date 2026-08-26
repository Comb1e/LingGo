import {createAnthropic} from '@ai-sdk/anthropic'
import {createGoogle} from '@ai-sdk/google'
import {createOpenAI} from '@ai-sdk/openai'
import {createOpenAICompatible} from '@ai-sdk/openai-compatible'
import {
  createProviderRegistry,
  generateText,
  streamText,
  type LanguageModel,
} from 'ai'
import {z} from 'zod'
import {coordinateToPoint, pointToCoordinate} from '../shared/coordinates'
import {normalizeReasoning} from '../shared/reasoning'
import {mergeRequestOptions} from '../shared/requestOptions'
import {
  type BoardSize,
  type Color,
  type GameSnapshot,
  type InGameReflection,
  type LlmActionResult,
  type PlayerAction,
  type PlayerProfile,
  type ProviderConnection,
} from '../shared/types'
import {asciiBoard, playStone, replay} from './go'

const inGameReflectionSchema = z
  .object({
    number: z.number().int().positive(),
    reflection: z.string().trim().min(1),
  })
  .strict()

const modelMoveSchema = z
  .object({
    move: z.tuple([z.number().int(), z.number().int()]),
    reason: z.string().trim().min(1),
    in_game_reflections: z.array(inGameReflectionSchema).optional(),
  })
  .strict()

const DEFAULT_PROVIDER_TIMEOUT_MS = 5 * 60_000

export interface PlayerAdapter {
  requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
    promptOverride?: string,
  ): Promise<LlmActionResult>
  requestText?(prompt: string, signal: AbortSignal): Promise<{
    text: string
    latencyMs: number
    inputTokens: number
    outputTokens: number
    model: string
  }>
}

export class MalformedModelOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedModelOutputError'
  }
}

export class SecretVault {
  private keys = new Map<string, string>()

  set(connectionId: string, key: string) {
    if (key.trim()) this.keys.set(connectionId, key.trim())
    else this.keys.delete(connectionId)
  }

  has(connectionId: string) {
    return this.keys.has(connectionId)
  }

  delete(connectionId: string) {
    this.keys.delete(connectionId)
  }

  get(connection: ProviderConnection): string | undefined {
    if (this.keys.has(connection.id)) return this.keys.get(connection.id)
    const envName = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      google: 'GOOGLE_GENERATIVE_AI_API_KEY',
      compatible: 'OPENAI_COMPATIBLE_API_KEY',
      fake: '',
    }[connection.kind]
    return envName ? process.env[envName] : undefined
  }
}

export class FakePlayerAdapter implements PlayerAdapter {
  async requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
    promptOverride?: string,
  ): Promise<LlmActionResult> {
    signal.throwIfAborted()
    const started = Date.now()
    if (promptOverride) {
      return {
        action: {action: 'pass', comment: 'Training pass.'},
        inGameReflections: [
          {
            number: 1,
            reflection: 'Check liberties and forcing moves before choosing a passive continuation.',
          },
        ],
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        model: 'deterministic-v1',
        retries: 0,
      }
    }
    const {hashes} = replay(snapshot.size, snapshot.moves)
    for (let y = 0; y < snapshot.size; y++) {
      for (let x = 0; x < snapshot.size; x++) {
        try {
          playStone(snapshot.board as any, snapshot.toMove, [x, y], hashes)
          return {
            action: {
              action: 'play',
              coordinate: pointName(x, y, snapshot.size),
              comment: 'A calm move that keeps options open.',
            },
            reasoning:
              'I scan the board in reading order and select the first legal intersection.',
            latencyMs: Date.now() - started,
            inputTokens: 0,
            outputTokens: 0,
            model: 'deterministic-v1',
            retries: 0,
          }
        } catch {
          // Try the next intersection.
        }
      }
    }
    return {
      action: {
        action: 'pass',
        comment: 'There are no legal intersections left.',
      },
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      model: 'deterministic-v1',
      retries: 0,
    }
  }

  async requestText(_prompt: string, signal: AbortSignal) {
    signal.throwIfAborted()
    return {
      text: '# Go techniques\n\n- Check liberties before every move.\n- Prefer legal, connected shapes.',
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: 'deterministic-v1',
    }
  }
}

export class LlmPlayerAdapter implements PlayerAdapter {
  constructor(
    private connection: ProviderConnection,
    private profile: PlayerProfile,
    private key: string,
    private timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  async requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
    promptOverride?: string,
  ): Promise<LlmActionResult> {
    const started = Date.now()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const prompt = promptOverride ?? makePrompt(snapshot, this.profile.stylePrompt)
    const model = this.createModel()
    const requestsReasoning = this.connection.kind !== 'compatible'
    const request = {
      model,
      prompt,
      temperature: this.temperature(),
      reasoning: requestsReasoning ? ('medium' as const) : undefined,
      providerOptions:
        this.connection.kind === 'google'
          ? {google: {thinkingConfig: {includeThoughts: true}}}
          : undefined,
      maxRetries: 0,
      abortSignal: combined,
    }
    const result =
      this.connection.kind === 'openai'
        ? await streamedTextResult(request)
        : await generatedTextResult(request)
    const parsed = parseJsonActionResult(result.text, snapshot.size)
    return {
      ...parsed,
      reasoning: result.reasoningText
        ? normalizeReasoning(result.reasoningText) || undefined
        : undefined,
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      model: this.profile.modelId,
      retries: 0,
    }
  }

  async requestText(prompt: string, signal: AbortSignal) {
    const started = Date.now()
    const request = {
      model: this.createModel(),
      prompt,
      temperature: this.temperature(),
      maxRetries: 0,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    }
    const result =
      this.connection.kind === 'openai'
        ? await streamedTextResult(request)
        : await generatedTextResult(request)
    return {
      text: result.text,
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      model: this.profile.modelId,
    }
  }

  private createModel(): LanguageModel {
    const id = this.profile.modelId
    const customFetch = this.customRequestFetch()
    if (this.connection.kind === 'openai') {
      const provider = createOpenAI({
        apiKey: this.key,
        baseURL: this.connection.baseUrl,
        fetch: customFetch,
      })
      // OpenAIProvider.languageModel maps to the Responses API in the current provider.
      const registry = createProviderRegistry({openai: provider})
      return registry.languageModel(`openai:${id}`)
    }
    if (this.connection.kind === 'anthropic') {
      const registry = createProviderRegistry({
        anthropic: createAnthropic({
          apiKey: this.key,
          baseURL: this.connection.baseUrl,
          fetch: customFetch,
        }),
      })
      return registry.languageModel(`anthropic:${id}`)
    }
    if (this.connection.kind === 'google') {
      const registry = createProviderRegistry({
        google: createGoogle({
          apiKey: this.key,
          baseURL: this.connection.baseUrl,
          fetch: customFetch,
        }),
      })
      return registry.languageModel(`google:${id}`)
    }
    if (this.connection.kind === 'compatible') {
      if (!this.connection.baseUrl)
        throw new Error('Compatible provider URL is required')
      const compatible = createOpenAICompatible({
        name: this.connection.id,
        apiKey: this.key,
        baseURL: this.connection.baseUrl,
        fetch: customFetch,
      })
      const registry = createProviderRegistry({compatible})
      return registry.languageModel(`compatible:${id}`)
    }
    throw new Error(`Unsupported provider: ${this.connection.kind}`)
  }

  private temperature() {
    return this.connection.kind === 'openai' &&
      isOpenAiReasoningModel(this.profile.modelId)
      ? undefined
      : this.profile.temperature
  }

  private customRequestFetch() {
    if (!this.profile.requestOptions?.length) return undefined
    const requestOptions = this.profile.requestOptions

    return async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string')
        throw new Error('Provider request body is not JSON text')
      const providerBody = JSON.parse(init.body)
      if (!providerBody || Array.isArray(providerBody) || typeof providerBody !== 'object')
        throw new Error('Provider request body is not a JSON object')
      return globalThis.fetch(input, {
        ...init,
        body: JSON.stringify(mergeRequestOptions(providerBody, requestOptions)),
      })
    }
  }
}

async function generatedTextResult(
  request: Parameters<typeof generateText>[0],
) {
  const result = await generateText(request)
  return {
    text: result.text,
    reasoningText: result.finalStep.reasoningText,
    usage: result.usage,
  }
}

async function streamedTextResult(request: Parameters<typeof streamText>[0]) {
  const result = streamText(request)
  const [text, finalStep, usage] = await Promise.all([
    result.text,
    result.finalStep,
    result.usage,
  ])
  return {text, reasoningText: finalStep.reasoningText, usage}
}

export function isOpenAiReasoningModel(modelId: string) {
  if (/^o\d+(?:-|$)/.test(modelId)) return true
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(modelId)
  if (!match) return false
  const major = Number(match[1])
  const minor = match[2]
  const variant = match[3]
  const isChatModel = minor === undefined && variant?.startsWith('chat')
  return major >= 5 && !isChatModel
}

export function createPlayerAdapter(
  connection: ProviderConnection,
  profile: PlayerProfile,
  vault: SecretVault,
): PlayerAdapter {
  if (connection.kind === 'fake') return new FakePlayerAdapter()
  const key = vault.get(connection)
  if (!key) throw new Error(`No API key configured for ${connection.name}`)
  return new LlmPlayerAdapter(connection, profile, key)
}

export function parseJsonAction(text: string, size: BoardSize): PlayerAction {
  return parseJsonActionResult(text, size).action
}

export function parseJsonActionResult(
  text: string,
  size: BoardSize,
): {action: PlayerAction; inGameReflections?: InGameReflection[]} {
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const response = modelMoveSchema.parse(JSON.parse(candidate))
    const [x, y] = response.move
    const inGameReflections = response.in_game_reflections
    if (x === -1 && y === -1)
      return {
        action: {action: 'pass', comment: response.reason},
        inGameReflections,
      }
    if (x === -2 && y === -2)
      return {
        action: {action: 'resign', comment: response.reason},
        inGameReflections,
      }
    if (x < 0 || y < 0 || x >= size || y >= size)
      throw new Error(`Move [${x},${y}] is outside the ${size}x${size} board`)
    return {
      action: {
        action: 'play',
        coordinate: pointToCoordinate([x, y], size),
        comment: response.reason,
      },
      inGameReflections,
    }
  } catch (error) {
    throw new MalformedModelOutputError(
      `Invalid model move JSON: ${
        error instanceof Error ? error.message : 'unknown validation error'
      }`,
    )
  }
}

export function makePrompt(
  snapshot: GameSnapshot,
  stylePrompt?: string,
): string {
  const ownCaptures = snapshot.captures[snapshot.toMove]
  const opponentCaptures = snapshot.captures[snapshot.toMove === 'B' ? 'W' : 'B']
  const moves = snapshot.moves.length
    ? snapshot.moves
        .map((move) => formatPromptMove(move, snapshot, false))
        .join('\n')
    : '(none)'
  return [
    ...formatGoRules(snapshot),
    '',
    '2. PLAYING STYLE',
    stylePrompt?.trim() || '(none)',
    '',
    '3. INSTRUCTION',
    `You are ${snapshot.toMove === 'B' ? 'Black' : 'White'}. Choose exactly one legal intersection for your next Go stone. ${snapshot.kataGoAnalysis ? 'You may use the supplied KataGo win-rate history.' : 'Do not use external analysis.'} Do not suggest multiple moves.`,
    ...(snapshot.previousError
      ? [
          `Your previous response was rejected: ${snapshot.previousError}. Use the unchanged position and correct the response.`,
        ]
      : []),
    '',
    '4. RESPONSE SCHEMA',
    'Return only plain text containing one valid JSON object. Do not use Markdown or code fences.',
    '{"move":[column,row],"reason":"brief reason for this move"}',
    `move must be a two-integer array. column and row are zero-based from the top-left, each from 0 to ${snapshot.size - 1}.`,
    'Use {"move":[-1,-1],"reason":"..."} to pass or {"move":[-2,-2],"reason":"..."} to resign.',
    '',
    '5. CURRENT POSITION',
    `To move: ${snapshot.toMove === 'B' ? 'Black (X)' : 'White (O)'}`,
    `Capture totals: Black has captured ${snapshot.captures.B} White stones; White has captured ${snapshot.captures.W} Black stones.`,
    `From your perspective: you have captured ${ownCaptures} opponent stones; the opponent has captured ${opponentCaptures} of your stones.`,
    'X = Black stone, O = White stone, . = empty intersection.',
    '',
    asciiBoard(snapshot),
    '',
    'Move list:',
    moves,
    ...(snapshot.kataGoAnalysis
      ? [
          '',
          '6. KATAGO WIN-RATE HISTORY',
          snapshot.kataGoAnalysis,
        ]
      : []),
  ].join('\n')
}

export function makeBenchmarkMovePrompt(
  snapshot: GameSnapshot,
  notebook: string,
  options: {
    phase: 'training' | 'final'
    winRateHistory?: string
    inGameReflections?: InGameReflection[]
  },
): string {
  const ownCaptures = snapshot.captures[snapshot.toMove]
  const opponentCaptures = snapshot.captures[snapshot.toMove === 'B' ? 'W' : 'B']
  const moves = snapshot.moves.length
    ? snapshot.moves
        .map((move) => formatPromptMove(move, snapshot, true))
        .join('\n')
    : '(none)'
  const sections = [
    ...formatGoRules(snapshot),
    '',
    '2. SELF-WRITTEN SKILLS',
    notebook.trim() || '(none)',
    '',
    '3. INSTRUCTION TO PLACE ONE STONE',
    `You are ${snapshot.toMove === 'B' ? 'Black' : 'White'}. Place exactly one legal stone on an intersection shown as ".".`,
    ...(snapshot.previousError
      ? [`Your previous response was rejected: ${snapshot.previousError}. The position is unchanged; choose a different legal move.`]
      : []),
    '',
    '4. JSON OUTPUT SCHEMA',
    'Return only {"move":[column,row],"reason":"brief reason","in_game_reflections":[{"number":1,"reflection":"lesson from this game"}]}. Coordinates are zero-based from the top-left. Use [-1,-1] to pass or [-2,-2] to resign.',
    'in_game_reflections is optional. Omit it or return an empty array when no new lesson is warranted. It is a patch: use the next unused positive number for a new lesson, or reuse a number to replace an incorrect earlier entry.',
    '',
    '5. CURRENT BOARD AND PREVIOUS MOVES',
    'Current in-game reflections (this game only):',
    formatInGameReflections(options.inGameReflections),
    `To move: ${snapshot.toMove}`,
    `Capture totals: you have captured ${ownCaptures} opponent stones; the opponent has captured ${opponentCaptures} of your stones.`,
    asciiBoard(snapshot),
    'Previous moves:',
    moves,
  ]
  if (options.phase === 'training' && options.winRateHistory !== undefined)
    sections.push('', '6. TRAINING WIN-RATE HISTORY', options.winRateHistory || '(none)')
  return sections.join('\n')
}

function formatGoRules(snapshot: GameSnapshot) {
  return [
    '1. GO RULES',
    `- The game is played on a ${snapshot.size}x${snapshot.size} grid. Black moves first, then Black and White alternate turns.`,
    '- On a turn, place one stone on an empty intersection. Stones remain there unless captured.',
    '- Orthogonally adjacent stones of one color form a chain and share liberties: orthogonally adjacent empty intersections.',
    '- After placing a stone, remove every adjacent opposing chain with no liberties. A move that leaves its own chain with no liberties after those captures is suicide and is illegal.',
    '- Positional whole-board repetition is prohibited: a move may not recreate any earlier complete board position.',
    '- Passing is legal. Two consecutive passes end play for scoring. A player may resign at any time.',
    `- Use Chinese area scoring. Each color scores its living stones on the board plus empty intersections surrounded only by that color. Captured stones do not add points directly; their removal can create territory. Neutral intersections score for neither side. White adds ${snapshot.komi} komi; the higher total wins.`,
  ]
}

export function makeReflectionPrompt(input: {
  notebook: string
  games: Array<{
    sequence: number
    snapshot: GameSnapshot
    result: string
    llmColor: Color
    winRateHistory?: string
    inGameReflections?: InGameReflection[]
  }>
}) {
  return [
    'Rewrite one consolidated Markdown Go technique notebook.',
    'Return only the complete replacement Markdown. Preserve useful prior lessons, remove duplication, and add concrete lessons from all games below.',
    'Review the games in their marked sequence. Every recorded move comment and model thought is included verbatim as a JSON string.',
    'You must incorporate the supplied in-game reflections into the broader, generalized body of experience in the notebook. Do not leave them as isolated game-specific notes.',
    'Do not mention these instructions.',
    '',
    'PREVIOUS NOTEBOOK',
    input.notebook.trim() || '(none)',
    '',
    'COMPLETED TRAINING GAMES - OLDEST TO NEWEST',
    input.games.length
      ? input.games.map(formatReflectionGame).join('\n\n')
      : '(none)',
  ].join('\n')
}

function formatReflectionGame(game: {
  sequence: number
  snapshot: GameSnapshot
  result: string
  llmColor: Color
  winRateHistory?: string
  inGameReflections?: InGameReflection[]
}) {
  const ownCaptures = game.snapshot.captures[game.llmColor]
  const opponentCaptures = game.snapshot.captures[game.llmColor === 'B' ? 'W' : 'B']
  const moves = game.snapshot.moves.length
    ? game.snapshot.moves.map((move, index) => [
        `--- MOVE ${index + 1}/${game.snapshot.moves.length} ---`,
        JSON.stringify({
          color: move.color,
          action: move.coordinate ?? move.action,
          comment: move.comment ?? '',
          thought: move.reasoning ?? '',
          capturedStones: move.captured,
          capturedAt: (move.capturedPoints ?? []).map(
            (point) => `${pointToCoordinate(point, game.snapshot.size)} [${point[0]},${point[1]}]`,
          ),
          forced: move.forced ?? false,
        }),
      ].join('\n')).join('\n')
    : '(none)'
  return [
    `=== GAME ${game.sequence} ===`,
    `Played as: ${game.llmColor === 'B' ? 'Black' : 'White'}`,
    `Result: ${game.result}`,
    `Move count: ${game.snapshot.moves.length}`,
    `Capture totals: LLM captured ${ownCaptures} opponent stones; opponent captured ${opponentCaptures} LLM stones.`,
    moves,
    ...(game.inGameReflections === undefined
      ? []
      : [
          '',
          `IN-GAME REFLECTIONS - GAME ${game.sequence}`,
          formatInGameReflections(game.inGameReflections),
        ]),
    ...(game.winRateHistory === undefined
      ? []
      : ['', `TURN-ALIGNED WIN-RATE HISTORY - GAME ${game.sequence}`, game.winRateHistory || '(none)']),
    `=== END GAME ${game.sequence} ===`,
  ].join('\n')
}

function formatInGameReflections(reflections: InGameReflection[] | undefined) {
  return reflections?.length
    ? reflections.map((reflection) => JSON.stringify(reflection)).join('\n')
    : '(none yet)'
}

function formatCapturedLocations(move: GameSnapshot['moves'][number], size: BoardSize) {
  if (!move.capturedPoints?.length) return ''
  return `; captured ${move.capturedPoints.length} at ${move.capturedPoints
    .map((point) => `${pointToCoordinate(point, size)} [${point[0]},${point[1]}]`)
    .join(', ')}`
}

function formatPromptMove(
  move: GameSnapshot['moves'][number],
  snapshot: GameSnapshot,
  includePoint: boolean,
) {
  const point =
    includePoint && move.point ? ` [${move.point[0]},${move.point[1]}]` : ''
  const ownMove =
    move.color === snapshot.toMove
      ? `; your comment: ${JSON.stringify(move.comment ?? '')}; your reasoning: ${JSON.stringify(move.reasoning ?? '')}`
      : ''
  return `${move.number}. ${move.color} ${move.coordinate ?? move.action}${point}${formatCapturedLocations(move, snapshot.size)}${ownMove}`
}

function pointName(x: number, y: number, size: number): string {
  const columns = 'ABCDEFGHJKLMNOPQRST'
  return `${columns[x]}${size - y}`
}

export function validateActionCoordinate(
  action: PlayerAction,
  snapshot: GameSnapshot,
) {
  if (action.action === 'play')
    coordinateToPoint(action.coordinate, snapshot.size)
}
