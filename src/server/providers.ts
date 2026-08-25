import {createAnthropic} from '@ai-sdk/anthropic'
import {createGoogle} from '@ai-sdk/google'
import {createOpenAI} from '@ai-sdk/openai'
import {createOpenAICompatible} from '@ai-sdk/openai-compatible'
import {createProviderRegistry, generateText, type LanguageModel} from 'ai'
import {z} from 'zod'
import {coordinateToPoint, pointToCoordinate} from '../shared/coordinates'
import {normalizeReasoning} from '../shared/reasoning'
import {
  type BoardSize,
  type GameSnapshot,
  type LlmActionResult,
  type PlayerAction,
  type PlayerProfile,
  type ProviderConnection,
} from '../shared/types'
import {asciiBoard, playStone, replay} from './go'

const modelMoveSchema = z
  .object({
    move: z.tuple([z.number().int(), z.number().int()]),
    reason: z.string().trim().min(1),
  })
  .strict()

export interface PlayerAdapter {
  requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
  ): Promise<LlmActionResult>
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
  ): Promise<LlmActionResult> {
    signal.throwIfAborted()
    const started = Date.now()
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
}

export class LlmPlayerAdapter implements PlayerAdapter {
  constructor(
    private connection: ProviderConnection,
    private profile: PlayerProfile,
    private key: string,
    private timeoutMs = 90_000,
  ) {}

  async requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
  ): Promise<LlmActionResult> {
    const started = Date.now()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const prompt = makePrompt(snapshot, this.profile.stylePrompt)
    const model = this.createModel()
    const requestsReasoning = this.connection.kind !== 'compatible'
    const result = await generateText({
      model,
      prompt,
      temperature: this.profile.temperature,
      reasoning: requestsReasoning ? 'medium' : undefined,
      providerOptions:
        this.connection.kind === 'google'
          ? {google: {thinkingConfig: {includeThoughts: true}}}
          : undefined,
      maxRetries: 0,
      abortSignal: combined,
    })
    return {
      action: parseJsonAction(result.text, snapshot.size),
      reasoning: result.finalStep.reasoningText
        ? normalizeReasoning(result.finalStep.reasoningText) || undefined
        : undefined,
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      model: this.profile.modelId,
      retries: 0,
    }
  }

  private createModel(): LanguageModel {
    const id = this.profile.modelId
    if (this.connection.kind === 'openai') {
      const provider = createOpenAI({
        apiKey: this.key,
        baseURL: this.connection.baseUrl,
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
        }),
      })
      return registry.languageModel(`anthropic:${id}`)
    }
    if (this.connection.kind === 'google') {
      const registry = createProviderRegistry({
        google: createGoogle({
          apiKey: this.key,
          baseURL: this.connection.baseUrl,
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
      })
      const registry = createProviderRegistry({compatible})
      return registry.languageModel(`compatible:${id}`)
    }
    throw new Error(`Unsupported provider: ${this.connection.kind}`)
  }
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
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const response = modelMoveSchema.parse(JSON.parse(candidate))
    const [x, y] = response.move
    if (x === -1 && y === -1) return {action: 'pass', comment: response.reason}
    if (x === -2 && y === -2)
      return {action: 'resign', comment: response.reason}
    if (x < 0 || y < 0 || x >= size || y >= size)
      throw new Error(`Move [${x},${y}] is outside the ${size}x${size} board`)
    return {
      action: 'play',
      coordinate: pointToCoordinate([x, y], size),
      comment: response.reason,
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
  const moves = snapshot.moves.length
    ? snapshot.moves
        .map(
          (move) =>
            `${move.number}. ${move.color} ${move.action === 'play' ? move.coordinate : move.action}`,
        )
        .join('\n')
    : '(none)'
  return [
    '1. GO RULES',
    `- Board size: ${snapshot.size}x${snapshot.size}.`,
    '- Black and White alternate placing one stone on an empty intersection.',
    '- Connected stones share liberties. Remove an opposing chain when its last liberty is filled.',
    '- Suicide is prohibited. A move may not repeat any earlier whole-board position.',
    `- Use Chinese area scoring. White receives ${snapshot.komi} komi. Two consecutive passes end play for scoring.`,
    '- A player may resign.',
    `- Authoritative rules summary: ${snapshot.rules}`,
    '',
    '2. PLAYING STYLE',
    stylePrompt?.trim() || '(none)',
    '',
    '3. INSTRUCTION',
    `You are ${snapshot.toMove === 'B' ? 'Black' : 'White'}. Choose exactly one legal intersection for your next Go stone. Do not use external analysis or suggest multiple moves.`,
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
    `Captures: Black ${snapshot.captures.B}, White ${snapshot.captures.W}`,
    'X = Black stone, O = White stone, . = empty intersection.',
    '',
    asciiBoard(snapshot),
    '',
    'Move list:',
    moves,
  ].join('\n')
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
