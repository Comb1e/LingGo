import {createAnthropic} from '@ai-sdk/anthropic'
import {createGoogle} from '@ai-sdk/google'
import {createOpenAI} from '@ai-sdk/openai'
import {createOpenAICompatible} from '@ai-sdk/openai-compatible'
import {
  createProviderRegistry,
  generateText,
  Output,
  type LanguageModel,
} from 'ai'
import {coordinateToPoint} from '../shared/coordinates'
import {
  playerActionSchema,
  type GameSnapshot,
  type LlmActionResult,
  type PlayerAction,
  type PlayerProfile,
  type ProviderConnection,
} from '../shared/types'
import {asciiBoard, playStone, replay} from './go'

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

    if (this.connection.supportsStructuredOutput) {
      const result = await generateText({
        model,
        prompt,
        temperature: this.profile.temperature,
        maxRetries: 0,
        abortSignal: combined,
        output: Output.object({schema: playerActionSchema, name: 'go_action'}),
      })
      return {
        action: result.output,
        latencyMs: Date.now() - started,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        model: this.profile.modelId,
        retries: 0,
      }
    }

    const result = await generateText({
      model,
      prompt: `${prompt}\nReturn only a JSON object matching the specified schema.`,
      temperature: this.profile.temperature,
      maxRetries: 0,
      abortSignal: combined,
    })
    return {
      action: parseJsonAction(result.text),
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
        supportsStructuredOutputs: this.connection.supportsStructuredOutput,
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

export function parseJsonAction(text: string): PlayerAction {
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return playerActionSchema.parse(JSON.parse(candidate))
  } catch (error) {
    throw new MalformedModelOutputError(
      error instanceof Error ? error.message : 'Invalid JSON action',
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
    'You are playing a game of Go. Choose exactly one legal action without external analysis.',
    stylePrompt ? `Style: ${stylePrompt}` : '',
    `Board: ${snapshot.size}x${snapshot.size}`,
    `Rules: ${snapshot.rules}`,
    `Komi: ${snapshot.komi}`,
    `To move: ${snapshot.toMove === 'B' ? 'Black' : 'White'}`,
    `Captures: Black ${snapshot.captures.B}, White ${snapshot.captures.W}`,
    '',
    asciiBoard(snapshot),
    '',
    'Move list:',
    moves,
    '',
    'Coordinates skip I. Return action play with a coordinate, pass, or resign, plus a brief public comment.',
  ]
    .filter(Boolean)
    .join('\n')
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
