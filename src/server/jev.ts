import {
  APIError,
  choice,
  TypeSafeClient,
  type ChoiceCriteria,
  type ChoiceResponse,
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
  type SystemOneResult,
} from '@typesafe-ai/sdk'
import {
  HTTP_RATE_LIMIT_STATUS,
  HTTP_SERVER_ERROR_MIN,
  TYPESAFE_CHOICE_LIMIT,
  TYPESAFE_RECENT_MOVE_LIMIT,
} from '../shared/constants'
import type {
  GameSnapshot,
  LlmActionResult,
  PlayerAction,
  PlayerProfile,
  ProviderConnection,
} from '../shared/types'
import {
  asciiBoard,
  legalActionCandidates,
  type LegalActionCandidate,
} from './go'
import type {PlayerAdapter} from './providers'
import {MalformedModelOutputError} from './providerErrors'

export interface JevClient {
  systemOne(
    request: SystemOneRequest,
    options?: RequestOptions,
  ): Promise<SystemOneResult<Questions>>
}

type JevSelectionState =
  | {phase: 'enumerate'}
  | {phase: 'single_request'; candidates: LegalActionCandidate[]}
  | {phase: 'group_round'; groups: LegalActionCandidate[][]}
  | {
      phase: 'final_round'
      candidates: LegalActionCandidate[]
      usage: JevUsage
    }
  | {
      phase: 'complete'
      candidate: LegalActionCandidate
      confidence: number
      model: string
      usage: JevUsage
    }

interface JevUsage {
  inputTokens: number
  outputTokens: number
}

interface JevAnswer {
  candidate: LegalActionCandidate
  confidence: number
}

export class JevPlayerAdapter implements PlayerAdapter {
  private readonly client: JevClient

  constructor(
    private readonly connection: ProviderConnection,
    private readonly profile: PlayerProfile,
    key: string,
    private readonly timeoutMs: number,
    client?: JevClient,
    baseUrl?: string,
  ) {
    const sdkClient = new TypeSafeClient({
      apiKey: key,
      baseURL: baseUrl,
      defaultModel: profile.modelId,
      retry: {maxRetries: 0},
      timeout: timeoutMs,
    })
    this.client = client ?? {
      systemOne: (request, options) => sdkClient.systemOne(request, options),
    }
  }

  async requestAction(
    snapshot: GameSnapshot,
    signal: AbortSignal,
  ): Promise<LlmActionResult> {
    const started = Date.now()
    let state: JevSelectionState = {phase: 'enumerate'}
    if (state.phase === 'enumerate')
      state = planSelection(
        legalActionCandidates(snapshot),
        this.profile.modelId,
      )
    const jevState = makeJevState(snapshot, this.profile.stylePrompt)

    if (state.phase === 'single_request') {
      const result = await this.choose(
        jevState,
        {move: state.candidates},
        signal,
      )
      const answer = answerFor(result, 'move', state.candidates)
      state = {
        phase: 'complete',
        ...answer,
        model: result.model,
        usage: usageFrom(result),
      }
    } else if (state.phase === 'group_round') {
      const questions = Object.fromEntries(
        state.groups.map((group, index) => [`group_${index}`, group]),
      )
      const grouped = await this.choose(jevState, questions, signal)
      const winners = state.groups.map(
        (group, index) => answerFor(grouped, `group_${index}`, group).candidate,
      )
      state = {
        phase: 'final_round',
        candidates: winners,
        usage: usageFrom(grouped),
      }
      const final = await this.choose(
        jevState,
        {final_move: state.candidates},
        signal,
      )
      const answer = answerFor(final, 'final_move', state.candidates)
      state = {
        phase: 'complete',
        ...answer,
        model: final.model,
        usage: addUsage(state.usage, usageFrom(final)),
      }
    }

    if (state.phase !== 'complete')
      throw new Error(`Invalid Jev selection phase: ${state.phase}`)
    const label = actionLabel(state.candidate.action)
    const confidence = Math.round(state.confidence * 100)
    const comment = `Jev selected ${label} with ${confidence}% confidence.`
    const action = {...state.candidate.action, comment}
    return {
      action,
      responseContent: JSON.stringify({move: label, reason: comment}),
      latencyMs: Date.now() - started,
      inputTokens: state.usage.inputTokens,
      outputTokens: state.usage.outputTokens,
      model: state.model,
      providerKind: this.connection.kind,
      retries: 0,
    }
  }

  private async choose(
    state: ReturnType<typeof makeJevState>,
    groups: Record<string, LegalActionCandidate[]>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    const questions = Object.fromEntries(
      Object.entries(groups).map(([id, candidates]) => [
        id,
        choice(
          'Choose the strongest legal action for the current player. Prefer useful play over passing, and resign only when the position is clearly hopeless.',
          criteriaFor(candidates),
        ),
      ]),
    ) as Questions
    try {
      return (await this.client.systemOne(
        {state, questions, model: this.profile.modelId} as SystemOneRequest,
        {
          signal,
          timeout: this.timeoutMs,
          retry: {maxRetries: 0},
        } satisfies RequestOptions,
      )) as SystemOneResult<Questions>
    } catch (error) {
      throw normalizeTypeSafeError(error)
    }
  }
}

export function balancedJevGroups<T>(
  candidates: T[],
  limit = TYPESAFE_CHOICE_LIMIT,
) {
  if (limit < 2)
    throw new Error('Jev Choice groups require at least two options')
  if (candidates.length <= limit) return [candidates]
  const groupCount = Math.ceil(candidates.length / limit)
  const groups = Array.from({length: groupCount}, () => [] as T[])
  candidates.forEach((candidate, index) =>
    groups[index % groupCount].push(candidate),
  )
  return groups
}

function planSelection(
  candidates: LegalActionCandidate[],
  model: string,
): JevSelectionState {
  if (candidates.length === 1)
    return {
      phase: 'complete',
      candidate: candidates[0],
      confidence: 1,
      model,
      usage: {inputTokens: 0, outputTokens: 0},
    }
  if (!candidates.length) throw new Error('No legal Go actions are available')
  const groups = balancedJevGroups(candidates)
  return groups.length === 1
    ? {phase: 'single_request', candidates}
    : {phase: 'group_round', groups}
}

function makeJevState(snapshot: GameSnapshot, stylePrompt?: string) {
  return {
    game: 'Go',
    board_size: snapshot.size,
    player_to_move: snapshot.toMove === 'B' ? 'Black' : 'White',
    komi: snapshot.komi,
    captures: snapshot.captures,
    rules: snapshot.rules,
    board: asciiBoard(snapshot),
    recent_moves: snapshot.moves
      .slice(-TYPESAFE_RECENT_MOVE_LIMIT)
      .map((move) => ({
        number: move.number,
        color: move.color,
        action: move.coordinate ?? move.action,
        captured: move.captured,
      })),
    ...(stylePrompt?.trim() ? {playing_style: stylePrompt.trim()} : {}),
    ...(snapshot.kataGoAnalysis
      ? {shared_katago_analysis: snapshot.kataGoAnalysis}
      : {}),
  }
}

function criteriaFor(candidates: LegalActionCandidate[]): ChoiceCriteria {
  return Object.fromEntries(
    candidates.map((candidate) => [
      actionLabel(candidate.action),
      candidate.action.action === 'play'
        ? {
            action: 'play',
            coordinate: candidate.action.coordinate,
            captured_stones: candidate.captured,
            resulting_chain_liberties: candidate.liberties ?? 0,
          }
        : candidate.action.action === 'pass'
          ? 'Pass without placing a stone. Choose only when continued play is not useful.'
          : 'Resign and accept a loss. Choose only when the position is clearly hopeless.',
    ]),
  )
}

function answerFor(
  result: SystemOneResult<Questions>,
  questionId: string,
  candidates: LegalActionCandidate[],
): JevAnswer {
  const answer = result.answers[questionId] as ChoiceResponse | undefined
  if (!answer || answer.type !== 'choice')
    throw new MalformedModelOutputError(
      `TypeSafe response is missing Choice answer ${questionId}`,
    )
  const candidate = candidates.find(
    ({action}) => actionLabel(action) === answer.choice,
  )
  if (!candidate)
    throw new MalformedModelOutputError(
      `TypeSafe selected unknown action ${answer.choice}`,
    )
  return {candidate, confidence: answer.confidence}
}

function actionLabel(action: PlayerAction) {
  return action.action === 'play'
    ? action.coordinate
    : action.action.toUpperCase()
}

function usageFrom(result: SystemOneResult<Questions>): JevUsage {
  return {
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
  }
}

function addUsage(left: JevUsage, right: JevUsage): JevUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

function normalizeTypeSafeError(error: unknown) {
  if (!(error instanceof APIError)) return error
  const normalized = new Error(error.message, {cause: error}) as Error & {
    statusCode: number
    isRetryable: boolean
    responseHeaders: Record<string, string>
  }
  normalized.statusCode = error.status
  normalized.isRetryable =
    error.status === 408 ||
    error.status === HTTP_RATE_LIMIT_STATUS ||
    error.status >= HTTP_SERVER_ERROR_MIN
  normalized.responseHeaders = Object.fromEntries(error.headers.entries())
  return normalized
}
