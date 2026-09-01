import {createAnthropic} from '@ai-sdk/anthropic'
import {createGoogle} from '@ai-sdk/google'
import {createOpenAI} from '@ai-sdk/openai'
import {createOpenAICompatible} from '@ai-sdk/openai-compatible'
import {
  createProviderRegistry,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from 'ai'
import {z} from 'zod'
import {coordinateToPoint, pointToCoordinate} from '../shared/coordinates'
import {
  normalizeReasoning,
  supportsDeepSeekReasoningControl,
} from '../shared/reasoning'
import {mergeRequestOptions} from '../shared/requestOptions'
import {
  type BoardSize,
  type GameSnapshot,
  type LlmActionResult,
  type PlayerAction,
  type PlayerProfile,
  type ProviderConnection,
} from '../shared/types'
import {playStone, replay} from './go'
import type {VisibleLlmMessage} from './llmGameContext'
import {makeMovePromptSections} from './movePrompt'
import {runtimeConfig} from './config'

const modelMoveSchema = z
  .object({
    move: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict()

const deepSeekErrorSchema = z
  .object({message: z.string().optional()})
  .passthrough()
const deepSeekStreamEventSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                reasoning_content: z.string().nullish(),
                content: z.string().nullish(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .default([]),
    usage: z
      .object({
        prompt_tokens: z.number().nullish(),
        completion_tokens: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
    error: deepSeekErrorSchema.optional(),
  })
  .passthrough()

const DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS =
  runtimeConfig.providerFirstTokenTimeoutMs
const DEFAULT_PROVIDER_TIMEOUT_MS = runtimeConfig.providerTimeoutMs

export interface PlayerAdapter {
  requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
    promptOverride?: string,
    cacheKey?: string,
  ): Promise<LlmActionResult>
  requestTurn?(
    request: LlmTurnRequest,
    signal: AbortSignal,
  ): Promise<LlmTurnResponse>
  requestText?(
    prompt: string,
    signal: AbortSignal,
    cacheKey?: string,
    maxOutputTokens?: number,
  ): Promise<LlmTextResponse>
  requestTextTurn?(
    request: TextTurnRequest,
    signal: AbortSignal,
  ): Promise<LlmTurnResponse>
}

export interface TextTurnRequest {
  content: string
  transcript: VisibleLlmMessage[]
  previousResponseId?: string
  cacheKey: string
  maxOutputTokens?: number
}

export interface LlmTurnRequest {
  kind: 'initial' | 'continuation' | 'repair' | 'reflection' | 'summary'
  content: string
  transcript: VisibleLlmMessage[]
  previousResponseId?: string
  cacheKey: string
  snapshot: GameSnapshot
  output: 'action' | 'notebook' | 'summary'
}

export interface LlmTurnResponse {
  text: string
  reasoning?: string
  providerContinuationId?: string
  latencyMs: number
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  model: string
  providerKind?: ProviderConnection['kind']
}

export interface LlmTextResponse {
  text: string
  latencyMs: number
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  model: string
}

export type LlmRequest =
  | {type: 'turn'; request: LlmTurnRequest}
  | {type: 'textTurn'; request: TextTurnRequest}
  | {
      type: 'text'
      content: string
      cacheKey?: string
      maxOutputTokens?: number
    }

export function requestLlm(
  adapter: PlayerAdapter,
  request: Extract<LlmRequest, {type: 'turn'}>,
  signal: AbortSignal,
): Promise<LlmTurnResponse>
export function requestLlm(
  adapter: PlayerAdapter,
  request: Extract<LlmRequest, {type: 'text'}>,
  signal: AbortSignal,
): Promise<LlmTextResponse>
export function requestLlm(
  adapter: PlayerAdapter,
  request: Extract<LlmRequest, {type: 'textTurn'}>,
  signal: AbortSignal,
): Promise<LlmTurnResponse | LlmTextResponse>
export async function requestLlm(
  adapter: PlayerAdapter,
  request: LlmRequest,
  signal: AbortSignal,
): Promise<LlmTurnResponse | LlmTextResponse> {
  if (request.type === 'text') {
    if (!adapter.requestText)
      throw new Error('The selected provider cannot generate text')
    return adapter.requestText(
      request.content,
      signal,
      request.cacheKey,
      request.maxOutputTokens,
    )
  }

  if (request.type === 'textTurn') {
    if (adapter.requestTextTurn)
      return adapter.requestTextTurn(request.request, signal)
    if (!adapter.requestText)
      throw new Error('The selected provider cannot generate text')
    return adapter.requestText(
      textFallbackPrompt(request.request),
      signal,
      request.request.cacheKey,
      request.request.maxOutputTokens,
    )
  }

  if (adapter.requestTurn) return adapter.requestTurn(request.request, signal)
  if (request.request.output !== 'action') {
    if (!adapter.requestText)
      throw new Error('The selected provider cannot generate text')
    const response = await adapter.requestText(
      textFallbackPrompt(request.request),
      signal,
      request.request.cacheKey,
    )
    return response
  }

  const result = await adapter.requestAction(
    request.request.snapshot,
    signal,
    textFallbackPrompt(request.request),
    request.request.cacheKey,
  )
  return {
    text:
      result.responseContent ??
      JSON.stringify({
        move:
          result.action.action === 'play'
            ? result.action.coordinate
            : result.action.action,
        reason: result.action.comment?.trim() || 'No explanation provided.',
      }),
    reasoning: result.reasoning,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    cachedInputTokens: result.cachedInputTokens,
    outputTokens: result.outputTokens,
    model: result.model,
    providerKind: result.providerKind,
  }
}

function textFallbackPrompt(
  request: Pick<TextTurnRequest, 'content' | 'transcript'>,
) {
  if (!request.transcript.length) return request.content
  return [
    ...request.transcript.map(
      (message) => `${message.role.toUpperCase()}: ${message.content}`,
    ),
    `USER: ${request.content}`,
  ].join('\n')
}

export class MalformedModelOutputError extends Error {
  constructor(
    message: string,
    readonly responseContent = '',
  ) {
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
      deepseek: 'DEEPSEEK_API_KEY',
      compatible: 'OPENAI_COMPATIBLE_API_KEY',
      fake: '',
    }[connection.kind]
    return envName ? process.env[envName] : undefined
  }
}

export class FakePlayerAdapter implements PlayerAdapter {
  async requestTurn(request: LlmTurnRequest, signal: AbortSignal) {
    signal.throwIfAborted()
    const started = Date.now()
    if (request.kind === 'summary')
      return {
        text: 'Keep groups connected while developing influence and preserving options to reduce weak opposing stones.',
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        model: 'deterministic-v1',
        providerKind: 'fake' as const,
      }
    if (
      request.output === 'notebook' &&
      request.content.includes('NOTEBOOK PATCH OUTPUT JSON SCHEMA')
    )
      return {
        text: fakeNotebookPatch(request),
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        model: 'deterministic-v1',
        providerKind: 'fake' as const,
      }
    if (request.output === 'notebook')
      return {
        text: '# Go techniques\n\n- Check liberties before every move.\n- Prefer legal, connected shapes.',
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        model: 'deterministic-v1',
        providerKind: 'fake' as const,
      }
    const benchmarkConversation = [
      ...request.transcript.map(({content}) => content),
      request.content,
    ].some(
      (content) =>
        content.includes('benchmark training game') ||
        content.includes('scored final game') ||
        content.includes('2. SELF-WRITTEN SKILLS'),
    )
    const action: PlayerAction = benchmarkConversation
      ? {action: 'pass', comment: 'Training pass.'}
      : this.fakeAction(request.snapshot)
    return {
      text: JSON.stringify({
        move: action.action === 'play' ? action.coordinate : action.action,
        reason: action.comment,
      }),
      reasoning:
        action.action === 'play'
          ? 'I scan the board in reading order and select the first legal intersection.'
          : undefined,
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      model: 'deterministic-v1',
      providerKind: 'fake' as const,
    }
  }

  async requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
    promptOverride?: string,
    _cacheKey?: string,
  ): Promise<LlmActionResult> {
    signal.throwIfAborted()
    const started = Date.now()
    void promptOverride
    void _cacheKey
    const action = this.fakeAction(snapshot)
    return {
      action,
      reasoning:
        action.action === 'play'
          ? 'I scan the board in reading order and select the first legal intersection.'
          : undefined,
      latencyMs: Date.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      model: 'deterministic-v1',
      providerKind: 'fake',
      retries: 0,
    }
  }

  private fakeAction(snapshot: GameSnapshot): PlayerAction {
    const {hashes} = replay(snapshot.size, snapshot.moves)
    for (let y = 0; y < snapshot.size; y++) {
      for (let x = 0; x < snapshot.size; x++) {
        try {
          playStone(snapshot.board as any, snapshot.toMove, [x, y], hashes)
          return {
            action: 'play',
            coordinate: pointName(x, y, snapshot.size),
            comment: 'A calm move that keeps options open.',
          }
        } catch {
          // Try the next intersection.
        }
      }
    }
    return {
      action: 'pass',
      comment: 'There are no legal intersections left.',
    }
  }

  async requestText(prompt: string, signal: AbortSignal) {
    signal.throwIfAborted()
    return {
      text: prompt.includes('NOTEBOOK PATCH OUTPUT JSON SCHEMA')
        ? '{"1":"Check liberties before choosing a vital point."}'
        : prompt.includes('Markdown life-and-death Go technique notebook')
          ? '# Go techniques\n\n1. Check liberties before every move.\n2. Prefer legal, connected shapes.'
          : '# Go techniques\n\n- Check liberties before every move.\n- Prefer legal, connected shapes.',
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: 'deterministic-v1',
    }
  }
}

function fakeNotebookPatch(request: LlmTurnRequest) {
  const notebook = request.transcript
    .map(
      ({content}) =>
        content.match(/SELF-WRITTEN SKILLS\n([\s\S]*?)\nCURRENT PROBLEM/)?.[1],
    )
    .find(Boolean)
  const noteNumbers = notebook
    ? [...notebook.matchAll(/^\s*(\d+)\.\s+/gm)].map((match) => match[1])
    : []
  const selector = [...request.content].reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  )
  const number = noteNumbers.length
    ? noteNumbers[selector % noteNumbers.length]
    : '1'
  return JSON.stringify({
    [number]: 'Review forcing replies before choosing the vital point.',
  })
}

export class LlmPlayerAdapter implements PlayerAdapter {
  constructor(
    private connection: ProviderConnection,
    private profile: PlayerProfile,
    private key: string,
    private timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
    private firstTokenTimeoutMs = DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
  ) {}

  async requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
    promptOverride?: string,
    cacheKey?: string,
  ): Promise<LlmActionResult> {
    const started = Date.now()
    const prompt =
      promptOverride ?? makePrompt(snapshot, this.profile.stylePrompt)
    const result =
      this.connection.kind === 'deepseek'
        ? await this.requestDeepSeek(prompt, signal)
        : await this.requestActionWithSdk(prompt, signal, cacheKey)
    const parsed = parseJsonActionResult(result.text, snapshot.size)
    return {
      ...parsed,
      responseContent: result.text,
      reasoning: result.reasoningText
        ? normalizeReasoning(result.reasoningText) || undefined
        : undefined,
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens ?? 0,
      cachedInputTokens: cachedInputTokens(result.usage),
      outputTokens: result.usage.outputTokens ?? 0,
      model: this.profile.modelId,
      providerKind: this.connection.kind,
      retries: 0,
    }
  }

  async requestTurn(request: LlmTurnRequest, signal: AbortSignal) {
    return this.requestConversation(request, signal)
  }

  async requestTextTurn(request: TextTurnRequest, signal: AbortSignal) {
    return this.requestConversation(request, signal)
  }

  private async requestConversation(
    request: TextTurnRequest,
    signal: AbortSignal,
  ) {
    const started = Date.now()
    const previousResponseId = supportsProviderContinuation(this.connection)
      ? request.previousResponseId
      : undefined
    const messages = providerMessages(this.connection.kind, {
      ...request,
      previousResponseId,
    })
    const result =
      this.connection.kind === 'deepseek'
        ? await this.requestDeepSeekMessages(
            messages,
            signal,
            request.maxOutputTokens,
          )
        : await this.requestWithSdk(
            messages,
            previousResponseId,
            request.cacheKey,
            signal,
            request.maxOutputTokens,
          )
    return {
      text: result.text,
      reasoning: result.reasoningText
        ? normalizeReasoning(result.reasoningText) || undefined
        : undefined,
      providerContinuationId: result.providerContinuationId,
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens ?? 0,
      cachedInputTokens: cachedInputTokens(result.usage),
      outputTokens: result.usage.outputTokens ?? 0,
      model: this.profile.modelId,
      providerKind: this.connection.kind,
    }
  }

  async requestText(
    prompt: string,
    signal: AbortSignal,
    cacheKey?: string,
    maxOutputTokens?: number,
  ) {
    const started = Date.now()
    const result =
      this.connection.kind === 'deepseek'
        ? await this.requestDeepSeek(prompt, signal, maxOutputTokens)
        : await streamedTextResult(
            {
              model: this.createModel(maxOutputTokens),
              prompt,
              temperature: this.temperature(),
              maxOutputTokens,
              providerOptions: providerTurnOptions(
                this.connection.kind,
                undefined,
                cacheKey,
              ) as any,
              maxRetries: 0,
              abortSignal: signal,
              timeout: {totalMs: this.timeoutMs},
            },
            this.firstTokenTimeoutMs,
          )
    return {
      text: result.text,
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens ?? 0,
      cachedInputTokens: cachedInputTokens(result.usage),
      outputTokens: result.usage.outputTokens ?? 0,
      model: this.profile.modelId,
    }
  }

  private requestActionWithSdk(
    prompt: string,
    signal: AbortSignal,
    cacheKey?: string,
  ) {
    return this.requestWithSdk(
      [{role: 'user', content: prompt}],
      undefined,
      cacheKey,
      signal,
    )
  }

  private requestWithSdk(
    messages: ModelMessage[],
    previousResponseId: string | undefined,
    cacheKey: string | undefined,
    signal: AbortSignal,
    maxOutputTokens?: number,
  ) {
    const request = {
      model: this.createModel(maxOutputTokens),
      messages,
      temperature: this.temperature(),
      reasoning:
        this.connection.kind !== 'compatible' ? ('medium' as const) : undefined,
      providerOptions: providerTurnOptions(
        this.connection.kind,
        previousResponseId,
        cacheKey,
      ) as any,
      maxRetries: 0,
      abortSignal: signal,
      timeout: {totalMs: this.timeoutMs},
    }
    return streamedTextResult(request, this.firstTokenTimeoutMs)
  }

  private requestDeepSeek(
    prompt: string,
    signal: AbortSignal,
    maxOutputTokens?: number,
  ) {
    return this.requestDeepSeekMessages(
      [{role: 'user', content: prompt}],
      signal,
      maxOutputTokens,
    )
  }

  private requestDeepSeekMessages(
    messages: ModelMessage[],
    signal: AbortSignal,
    maxOutputTokens?: number,
  ) {
    return deepSeekStreamedTextResult({
      baseUrl: this.connection.baseUrl,
      apiKey: this.key,
      modelId: this.profile.modelId,
      messages,
      reasoningEnabled: this.profile.reasoningEnabled !== false,
      reasoningControl: this.profile.reasoningControl,
      requestOptions: this.profile.requestOptions,
      signal,
      timeoutMs: this.timeoutMs,
      firstTokenTimeoutMs: this.firstTokenTimeoutMs,
      maxOutputTokens,
    })
  }

  private createModel(maxOutputTokens?: number): LanguageModel {
    const id = this.profile.modelId
    const customFetch = this.customRequestFetch(maxOutputTokens)
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

  private customRequestFetch(maxOutputTokens?: number) {
    const useExtraBodyControl = this.profile.reasoningControl === 'extra_body'
    if (!this.profile.requestOptions?.length && !useExtraBodyControl)
      return undefined
    const requestOptions = this.profile.requestOptions

    return async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string')
        throw new Error('Provider request body is not JSON text')
      const providerBody = JSON.parse(init.body)
      if (
        !providerBody ||
        Array.isArray(providerBody) ||
        typeof providerBody !== 'object'
      )
        throw new Error('Provider request body is not a JSON object')
      const body = mergeRequestOptions(providerBody, requestOptions)
      enforceProviderOutputLimit(body, this.connection.kind, maxOutputTokens)
      if (useExtraBodyControl)
        applyExtraBodyReasoningControl(
          body,
          this.profile.reasoningEnabled !== false,
        )
      return globalThis.fetch(input, {
        ...init,
        body: JSON.stringify(body),
      })
    }
  }
}

interface DeepSeekStreamState {
  phase: 'reasoning' | 'content' | 'done'
  reasoningText: string
  text: string
  inputTokens: number
  outputTokens: number
}

async function deepSeekStreamedTextResult(options: {
  baseUrl?: string
  apiKey: string
  modelId: string
  messages: ModelMessage[]
  reasoningEnabled: boolean
  reasoningControl?: PlayerProfile['reasoningControl']
  requestOptions?: PlayerProfile['requestOptions']
  signal: AbortSignal
  timeoutMs: number
  firstTokenTimeoutMs: number
  maxOutputTokens?: number
}) {
  const firstTokenController = new AbortController()
  const totalController = new AbortController()
  const firstTokenTimer = setTimeout(
    () =>
      firstTokenController.abort(
        timeoutError('First token', options.firstTokenTimeoutMs),
      ),
    options.firstTokenTimeoutMs,
  )
  const totalTimer = setTimeout(
    () => totalController.abort(timeoutError('Provider', options.timeoutMs)),
    options.timeoutMs,
  )
  const signal = AbortSignal.any([
    options.signal,
    firstTokenController.signal,
    totalController.signal,
  ])
  const body = mergeRequestOptions(
    {
      model: options.modelId,
      messages: options.messages,
      stream: true,
      stream_options: {include_usage: true},
    },
    options.requestOptions,
  )
  enforceProviderOutputLimit(body, 'deepseek', options.maxOutputTokens)
  if (
    supportsDeepSeekReasoningControl(options.modelId) ||
    options.reasoningControl === 'extra_body'
  )
    applyExtraBodyReasoningControl(body, options.reasoningEnabled)

  try {
    const response = await globalThis.fetch(
      deepSeekChatCompletionsUrl(options.baseUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
    )
    if (!response.ok) throw await deepSeekApiError(response)
    if (!response.body) throw new Error('DeepSeek response body is empty')

    const state: DeepSeekStreamState = {
      phase: 'reasoning',
      reasoningText: '',
      text: '',
      inputTokens: 0,
      outputTokens: 0,
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    while (true) {
      const {done, value} = await reader.read()
      pending += decoder.decode(value, {stream: !done})
      const lines = pending.split('\n')
      pending = done ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        updateDeepSeekStream(state, line, () => clearTimeout(firstTokenTimer))
      }
      if (done) break
    }
    if (pending)
      updateDeepSeekStream(state, pending, () => clearTimeout(firstTokenTimer))
    return {
      text: state.text,
      reasoningText: state.reasoningText || undefined,
      providerContinuationId: undefined,
      usage: {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      },
    }
  } finally {
    clearTimeout(firstTokenTimer)
    clearTimeout(totalTimer)
  }
}

function applyExtraBodyReasoningControl(
  body: Record<string, unknown>,
  reasoningEnabled: boolean,
) {
  body.thinking = {type: reasoningEnabled ? 'enabled' : 'disabled'}
  delete body.reasoning
  if (reasoningEnabled) body.reasoning_effort ??= 'high'
  else delete body.reasoning_effort
}

function enforceProviderOutputLimit(
  body: Record<string, unknown>,
  kind: ProviderConnection['kind'],
  limit?: number,
) {
  if (limit === undefined) return
  const capped = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(value, limit)
      : limit
  if (kind === 'openai') {
    body.max_output_tokens = capped(body.max_output_tokens)
    return
  }
  if (kind === 'google') {
    const generationConfig =
      body.generationConfig &&
      !Array.isArray(body.generationConfig) &&
      typeof body.generationConfig === 'object'
        ? (body.generationConfig as Record<string, unknown>)
        : {}
    generationConfig.maxOutputTokens = capped(generationConfig.maxOutputTokens)
    body.generationConfig = generationConfig
    return
  }
  body.max_tokens = capped(body.max_tokens)
}

function updateDeepSeekStream(
  state: DeepSeekStreamState,
  line: string,
  receivedFirstToken: () => void,
) {
  const data = /^data:\s*(.+?)\r?$/.exec(line)?.[1]
  if (!data || state.phase === 'done') return
  if (data === '[DONE]') {
    state.phase = 'done'
    return
  }
  let event: z.infer<typeof deepSeekStreamEventSchema>
  try {
    event = deepSeekStreamEventSchema.parse(JSON.parse(data))
  } catch {
    throw new Error('DeepSeek returned an invalid streaming event')
  }
  if (event.error)
    throw new Error(event.error.message ?? 'DeepSeek streaming request failed')
  if (event.usage) {
    state.inputTokens = event.usage.prompt_tokens ?? state.inputTokens
    state.outputTokens = event.usage.completion_tokens ?? state.outputTokens
  }
  for (const choice of event.choices ?? []) {
    const reasoning = choice?.delta?.reasoning_content
    const content = choice?.delta?.content
    if (typeof reasoning === 'string' && reasoning) {
      receivedFirstToken()
      state.reasoningText += reasoning
    }
    if (typeof content === 'string' && content) {
      receivedFirstToken()
      state.phase = 'content'
      state.text += content
    }
  }
}

function deepSeekChatCompletionsUrl(baseUrl?: string) {
  const value = baseUrl ?? 'https://api.deepseek.com'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Provider base URL must be a valid http or https URL')
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Provider base URL must use http or https')
  return `${url.toString().replace(/\/+$/, '')}/chat/completions`
}

async function deepSeekApiError(response: Response) {
  let message = `DeepSeek API request failed with status ${response.status}`
  try {
    const body = z
      .object({error: deepSeekErrorSchema})
      .parse(await response.json())
    if (body.error.message) message = body.error.message
  } catch {
    // Keep the HTTP status fallback.
  }
  return Object.assign(new Error(message), {
    statusCode: response.status,
    isRetryable: response.status === 429 || response.status >= 500,
    responseHeaders: Object.fromEntries(response.headers),
  })
}

function timeoutError(label: string, timeoutMs: number) {
  return new DOMException(
    `${label} timeout of ${timeoutMs}ms exceeded`,
    'TimeoutError',
  )
}

async function streamedTextResult(
  request: Parameters<typeof streamText>[0],
  firstTokenTimeoutMs: number,
) {
  const firstTokenController = new AbortController()
  const firstTokenTimer = setTimeout(
    () =>
      firstTokenController.abort(
        new DOMException(
          `First token timeout of ${firstTokenTimeoutMs}ms exceeded`,
          'TimeoutError',
        ),
      ),
    firstTokenTimeoutMs,
  )
  const abortSignal = request.abortSignal
    ? AbortSignal.any([request.abortSignal, firstTokenController.signal])
    : firstTokenController.signal
  const result = streamText({
    ...request,
    abortSignal,
    onChunk({chunk}) {
      if (isProviderContentChunk(chunk)) clearTimeout(firstTokenTimer)
    },
  })
  try {
    const [text, finalStep, usage] = await Promise.all([
      result.text,
      result.finalStep,
      result.usage,
    ])
    const openai = finalStep.providerMetadata?.openai as
      {responseId?: string | null} | undefined
    return {
      text,
      reasoningText: finalStep.reasoningText,
      usage,
      providerContinuationId: openai?.responseId ?? undefined,
    }
  } finally {
    clearTimeout(firstTokenTimer)
  }
}

function isProviderContentChunk<TOOLS extends ToolSet>(
  chunk: TextStreamPart<TOOLS>,
) {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length > 0
    case 'tool-input-delta':
      return chunk.delta.length > 0
    case 'file':
    case 'reasoning-file':
    case 'tool-call':
      return true
    default:
      return false
  }
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
  if (connection.baseUrl) validateProviderBaseUrl(connection.baseUrl)
  const key = vault.get(connection)
  if (!key) throw new Error(`No API key configured for ${connection.name}`)
  return new LlmPlayerAdapter(connection, profile, key)
}

export function supportsProviderContinuation(
  connection: Pick<ProviderConnection, 'kind' | 'baseUrl'>,
) {
  return connection.kind === 'openai' && !connection.baseUrl
}

export function validateProviderBaseUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Provider base URL must be a valid http or https URL')
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Provider base URL must use http or https')
  return url
}

export function parseJsonAction(text: string, size: BoardSize): PlayerAction {
  return parseJsonActionResult(text, size).action
}

export function parseJsonActionResult(
  text: string,
  size: BoardSize,
): {action: PlayerAction} {
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const response = modelMoveSchema.parse(JSON.parse(candidate))
    const move = response.move.toUpperCase()
    if (move === 'PASS')
      return {action: {action: 'pass', comment: response.reason}}
    if (move === 'RESIGN')
      return {action: {action: 'resign', comment: response.reason}}
    const point = coordinateToPoint(move, size)
    return {
      action: {
        action: 'play',
        coordinate: pointToCoordinate(point, size),
        comment: response.reason,
      },
    }
  } catch (error) {
    throw new MalformedModelOutputError(
      `Invalid model move JSON: ${
        error instanceof Error ? error.message : 'unknown validation error'
      }`,
      text,
    )
  }
}

function providerMessages(
  kind: ProviderConnection['kind'],
  request: Pick<
    TextTurnRequest,
    'content' | 'transcript' | 'previousResponseId'
  >,
): ModelMessage[] {
  if (kind === 'openai' && request.previousResponseId)
    return [{role: 'user', content: request.content}]
  return [
    ...request.transcript.map((message): ModelMessage => ({
      role: message.role,
      content: message.content,
    })),
    {role: 'user', content: request.content},
  ]
}

function providerTurnOptions(
  kind: ProviderConnection['kind'],
  previousResponseId?: string,
  cacheKey?: string,
) {
  if (kind === 'openai')
    return {
      openai: {
        store: true,
        previousResponseId,
        promptCacheKey: cacheKey,
      },
    }
  if (kind === 'anthropic')
    return {anthropic: {cacheControl: {type: 'ephemeral' as const}}}
  if (kind === 'google')
    return {google: {thinkingConfig: {includeThoughts: true}}}
  return undefined
}

function cachedInputTokens(usage: unknown) {
  return (
    (usage as {inputTokenDetails?: {cacheReadTokens?: number}})
      .inputTokenDetails?.cacheReadTokens ?? 0
  )
}

export function isProviderContextError(error: unknown) {
  const value = error as {
    statusCode?: number
    message?: string
    responseBody?: string
  }
  const text = `${value?.message ?? ''} ${value?.responseBody ?? ''}`
  return (
    (value?.statusCode === 400 || value?.statusCode === 404) &&
    /previous[_ ]response|response.*(?:expired|not found|missing)|context.*(?:expired|not found)/i.test(
      text,
    )
  )
}

export function makePrompt(
  snapshot: GameSnapshot,
  stylePrompt?: string,
): string {
  const sections = makeMovePromptSections(snapshot, {mode: 'ordinary'})
  return [
    ...sections.goRules,
    '',
    '2. PLAYING STYLE',
    stylePrompt?.trim() || '(none)',
    '',
    ...sections.instruction,
    '',
    ...sections.responseSchema,
    '',
    ...sections.currentPosition,
    ...(snapshot.kataGoAnalysis
      ? ['', '6. KATAGO WIN-RATE HISTORY', snapshot.kataGoAnalysis]
      : []),
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
