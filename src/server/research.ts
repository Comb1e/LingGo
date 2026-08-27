import {createHash} from 'node:crypto'
import {appendFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {
  GameSnapshot,
  LlmActionResult,
  PlayerAction,
  ResearchCondition,
  ResearchManifest,
  ResearchMoveTrace,
  ResearchPosition,
} from '../shared/types'
import {
  researchConditionSchema,
  researchManifestSchema,
  researchPositionSchema,
} from '../shared/types'
import {makeInitialLlmPrompt} from './llmGameContext'
import {makeSnapshot, playStone, replay, boardHash} from './go'
import type {KataGoAnalyzer, KataGoResult} from './katago'
import {parseJsonActionResult, type PlayerAdapter} from './providers'
import {coordinateToPoint} from '../shared/coordinates'

export const RESEARCH_PROTOCOL_VERSION = 'research-v1'
export const MOVE_PROMPT_VERSION = 'move-v1'
export const REFLECTION_PROMPT_VERSION = 'reflection-v1'
export const NOTEBOOK_FORMAT_VERSION = 'notebook-v1'
export const METRIC_VERSION = 'metrics-v1'

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function digestNotebook(notebook: string) {
  return sha256(notebook)
}

export function historyHash(moves: GameSnapshot['moves']) {
  return sha256(JSON.stringify(moves))
}

export function validateResearchManifest(input: unknown): ResearchManifest {
  const manifest = researchManifestSchema.parse(input)
  if (manifest.liveProvider && manifest.model.provider === 'fake')
    throw new Error('liveProvider cannot be enabled for the fake provider')
  if (!manifest.liveProvider && manifest.model.provider !== 'fake')
    throw new Error('Real providers require liveProvider: true')
  if (manifest.evaluator.visits <= manifest.trainingVisits)
    throw new Error('Evaluator visits must exceed trainingVisits')
  if (
    manifest.initialNotebookDigest &&
    manifest.initialNotebookDigest !== digestNotebook(manifest.initialNotebook)
  )
    throw new Error('initialNotebookDigest does not match initialNotebook')
  return {
    ...manifest,
    createdAt: manifest.createdAt ?? new Date().toISOString(),
  }
}

export function conditionCapabilities(condition: ResearchCondition) {
  researchConditionSchema.parse(condition)
  return {
    notebook:
      condition === 'reflection_only' || condition === 'reflection_plus_katago',
    kataGo:
      condition === 'katago_feedback' || condition === 'reflection_plus_katago',
    reflection:
      condition === 'reflection_only' || condition === 'reflection_plus_katago',
  }
}

export function buildResearchPrompt(
  snapshot: GameSnapshot,
  condition: ResearchCondition,
  notebook: string,
  latestWinRate?: string,
  phase: 'training' | 'final' = 'training',
) {
  const capabilities = conditionCapabilities(condition)
  return makeInitialLlmPrompt(
    snapshot,
    {
      kind: 'benchmark',
      phase,
      notebook: capabilities.notebook ? notebook : '',
      trainingFeedback: capabilities.kataGo ? 'structured' : 'none',
    },
    phase === 'training' && capabilities.kataGo ? latestWinRate : undefined,
  )
}

export interface CachedResponse {
  rawResponse: string
  parsedAction?: PlayerAction
  reasoning?: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  providerMetadata?: Record<string, unknown>
  timestamp: string
}

export class ResponseCache {
  constructor(readonly directory: string) {}

  key(
    modelFingerprint: string,
    prompt: string,
    condition: ResearchCondition,
    protocolVersion = RESEARCH_PROTOCOL_VERSION,
  ) {
    return sha256(
      JSON.stringify({
        modelFingerprint,
        promptHash: sha256(prompt),
        condition,
        protocolVersion,
      }),
    )
  }

  private path(key: string) {
    return join(this.directory, `${key}.json`)
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    try {
      return JSON.parse(
        await readFile(this.path(key), 'utf8'),
      ) as CachedResponse
    } catch {
      return undefined
    }
  }

  async set(key: string, value: CachedResponse) {
    await mkdir(this.directory, {recursive: true})
    await writeFile(this.path(key), `${JSON.stringify(value)}\n`, 'utf8')
  }
}

export interface ResearchRunnerDependencies {
  adapterFactory: () => PlayerAdapter
  kataGo: KataGoAnalyzer
  modelFingerprint?: string
  providerFingerprint?: string
  cache?: ResponseCache
}

export interface ResearchRunResult {
  manifest: ResearchManifest
  runId: string
  summary: ResearchSummary
  directory: string
}

export interface ResearchSummary {
  experimentId: string
  runId: string
  condition: ResearchCondition
  modelFingerprint: string
  evaluatorFingerprint: string
  seed: number
  games: number
  moves: number
  legalMoveRate: number
  kataGoPointLoss: number
  kataGoWinRateLoss: number
  tokenCost: number
  latencyMs: number
  notebookSize: {characters: number; tokens: number}
  gameWinRate: number
  scoreMargin: number
}

export class ResearchRunner {
  constructor(private readonly deps: ResearchRunnerDependencies) {}

  async run(
    rawManifest: unknown,
    outputRoot = join(process.cwd(), 'data', 'experiments'),
  ): Promise<ResearchRunResult> {
    const manifest = validateResearchManifest(rawManifest)
    const runId =
      manifest.runId ?? sha256(JSON.stringify(manifest)).slice(0, 16)
    const directory = join(outputRoot, manifest.experimentId, runId)
    try {
      const existingManifest = JSON.parse(
        await readFile(join(directory, 'manifest.json'), 'utf8'),
      ) as ResearchManifest
      const existingSummary = JSON.parse(
        await readFile(join(directory, 'summary.json'), 'utf8'),
      ) as ResearchSummary
      if (
        existingManifest.experimentId === manifest.experimentId &&
        existingManifest.runId === runId
      )
        return {
          manifest: existingManifest,
          runId,
          summary: existingSummary,
          directory,
        }
    } catch {
      // A partial directory is resumed by replaying the manifest.
    }
    await mkdir(join(directory, 'notebook_versions'), {recursive: true})
    await writeFile(
      join(directory, 'manifest.json'),
      `${JSON.stringify({...manifest, runId}, null, 2)}\n`,
    )
    const modelFingerprint =
      this.deps.modelFingerprint ?? sha256(JSON.stringify(manifest.model))
    const providerFingerprint =
      this.deps.providerFingerprint ?? manifest.model.provider
    let notebook = manifest.initialNotebook
    let moves = 0
    let legal = 0
    let pointLoss = 0
    let winRateLoss = 0
    let tokens = 0
    let latency = 0
    let wins = 0
    let scoreMargin = 0
    const movePath = join(directory, 'moves.jsonl')
    const kataPath = join(directory, 'katago.jsonl')
    const errorsPath = join(directory, 'errors.jsonl')
    const promptPath = join(directory, 'prompts.jsonl')
    await writeFile(errorsPath, '')
    await writeFile(promptPath, '')
    const caps = conditionCapabilities(manifest.condition)
    const adapter = this.deps.adapterFactory()
    const totalGames = manifest.trainingGameCount + manifest.evaluationGameCount
    for (let game = 0; game < totalGames; game++) {
      const training = game < manifest.trainingGameCount
      const gameMoves: GameSnapshot['moves'] = []
      for (let turn = 0; turn < manifest.moveCap; turn++) {
        const snapshot = makeSnapshot(
          manifest.boardSize,
          manifest.komi,
          gameMoves,
        )
        if (
          snapshot.moves.length >= 2 &&
          snapshot.moves.slice(-2).every((move) => move.action === 'pass')
        )
          break
        const before = caps.kataGo
          ? await this.deps.kataGo.analyze({
              size: manifest.boardSize,
              komi: manifest.komi,
              moves: gameMoves,
              visits: manifest.trainingVisits,
            })
          : undefined
        const latest = before
          ? `Turn ${turn}: ${(before.rootInfo.winrate * 100).toFixed(2)}%`
          : undefined
        const prompt = buildResearchPrompt(
          snapshot,
          manifest.condition,
          notebook,
          training ? latest : undefined,
          training ? 'training' : 'final',
        )
        const promptHash = sha256(prompt)
        await appendFile(
          promptPath,
          `${JSON.stringify({game, turn, promptHash, ...(manifest.rawTraces ? {prompt} : {})})}\n`,
        )
        const key = this.deps.cache?.key(
          modelFingerprint,
          prompt,
          manifest.condition,
          manifest.protocol.protocolVersion,
        )
        let response: CachedResponse | undefined = key
          ? await this.deps.cache?.get(key)
          : undefined
        let action: PlayerAction
        const retries = 0
        let retryErrors: string[] = []
        if (response) {
          action =
            response.parsedAction ??
            parseJsonActionResult(response.rawResponse, manifest.boardSize)
              .action
        } else {
          try {
            const result = adapter.requestTurn
              ? await adapter.requestTurn(
                  {
                    kind: 'initial',
                    content: prompt,
                    transcript: [],
                    cacheKey: key ?? promptHash,
                    snapshot,
                    output: 'action',
                  },
                  new AbortController().signal,
                )
              : await adapter
                  .requestAction(snapshot, new AbortController().signal, prompt)
                  .then((value: LlmActionResult) => ({
                    text:
                      value.responseContent ??
                      JSON.stringify({
                        move:
                          value.action.action === 'play'
                            ? value.action.coordinate
                            : value.action.action,
                        reason: value.action.comment,
                      }),
                    reasoning: value.reasoning,
                    latencyMs: value.latencyMs,
                    inputTokens: value.inputTokens,
                    outputTokens: value.outputTokens,
                    model: value.model,
                    providerKind: value.providerKind,
                  }))
            action = parseJsonActionResult(
              result.text,
              manifest.boardSize,
            ).action
            response = {
              rawResponse: result.text,
              parsedAction: action,
              reasoning: result.reasoning,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              latencyMs: result.latencyMs,
              timestamp: manifest.createdAt!,
            }
            if (key) await this.deps.cache?.set(key, response)
          } catch (error) {
            retryErrors = [
              error instanceof Error ? error.message : String(error),
            ]
            await appendFile(
              errorsPath,
              `${JSON.stringify({game, turn, error: retryErrors[0]})}\n`,
            )
            action = {action: 'pass', comment: 'error'}
          }
        }
        const history = historyHash(gameMoves)
        let legalMove = true
        let afterMoves: GameSnapshot['moves']
        try {
          const state = replay(manifest.boardSize, gameMoves)
          if (action.action === 'play') {
            const point = coordinateToPoint(
              action.coordinate!,
              manifest.boardSize,
            )
            const played = playStone(
              state.board as any,
              state.toMove,
              point,
              state.hashes,
            )
            afterMoves = [
              ...gameMoves,
              {
                number: turn + 1,
                color: state.toMove,
                action: 'play',
                coordinate: action.coordinate,
                point,
                comment: action.comment,
                captured: played.captured,
                capturedPoints: played.capturedPoints,
              },
            ]
          } else
            afterMoves = [
              ...gameMoves,
              {
                number: turn + 1,
                color: state.toMove,
                action: action.action,
                comment: action.comment,
                captured: 0,
              },
            ]
        } catch (error) {
          legalMove = false
          retryErrors.push(
            error instanceof Error ? error.message : String(error),
          )
          afterMoves = [
            ...gameMoves,
            {
              number: turn + 1,
              color: replay(manifest.boardSize, gameMoves).toMove,
              action: 'pass',
              comment: 'illegal fallback',
              captured: 0,
            },
          ]
        }
        const after = caps.kataGo
          ? await this.deps.kataGo.analyze({
              size: manifest.boardSize,
              komi: manifest.komi,
              moves: afterMoves,
              visits: manifest.trainingVisits,
            })
          : undefined
        const perspective = snapshot.toMove === 'B' ? 1 : -1
        const pl =
          before && after
            ? Math.max(
                0,
                perspective *
                  (before.rootInfo.scoreLead - after.rootInfo.scoreLead),
              )
            : 0
        const wl =
          before && after
            ? Math.max(
                0,
                perspective *
                  (before.rootInfo.winrate - after.rootInfo.winrate),
              )
            : 0
        const trace: ResearchMoveTrace = {
          game,
          turn,
          positionHash: boardHash(snapshot.board as any),
          historyHash: history,
          color: snapshot.toMove,
          condition: manifest.condition,
          promptHash,
          notebookDigest: digestNotebook(notebook),
          ...(manifest.rawTraces
            ? {response: response?.rawResponse}
            : {cacheKey: key}),
          parsedAction: action,
          legal: legalMove,
          retries,
          retryErrors,
          kataGoBefore: before && {
            winRate: before.rootInfo.winrate,
            scoreLead: before.rootInfo.scoreLead,
            visits: before.rootInfo.visits,
          },
          kataGoAfter: after && {
            winRate: after.rootInfo.winrate,
            scoreLead: after.rootInfo.scoreLead,
            visits: after.rootInfo.visits,
          },
          pointLoss: pl,
          winRateLoss: wl,
          inputTokens: response?.inputTokens ?? 0,
          outputTokens: response?.outputTokens ?? 0,
          latencyMs: response?.latencyMs ?? 0,
          modelFingerprint,
          providerFingerprint,
          timestamp: manifest.createdAt!,
        }
        await appendFile(movePath, `${JSON.stringify(trace)}\n`)
        if (before || after)
          await appendFile(
            kataPath,
            `${JSON.stringify({game, turn, before, after})}\n`,
          )
        gameMoves.splice(0, gameMoves.length, ...afterMoves)
        moves += 1
        if (legalMove) legal += 1
        pointLoss += pl
        winRateLoss += wl
        tokens += (response?.inputTokens ?? 0) + (response?.outputTokens ?? 0)
        latency += response?.latencyMs ?? 0
      }
      if (training && caps.reflection && adapter.requestText) {
        const result = await adapter.requestText(
          `Update the technique notebook based on training game ${game}. Previous notebook:\n${notebook}`,
          new AbortController().signal,
        )
        notebook = result.text.trim()
        await writeFile(
          join(
            directory,
            'notebook_versions',
            `${String(game).padStart(4, '0')}.md`,
          ),
          notebook,
        )
      }
      if (!training) {
        wins += 0.5
        scoreMargin += 0
      }
    }
    const summary: ResearchSummary = {
      experimentId: manifest.experimentId,
      runId,
      condition: manifest.condition,
      modelFingerprint,
      evaluatorFingerprint:
        manifest.evaluator.fingerprint ??
        sha256(JSON.stringify(manifest.evaluator)),
      seed: manifest.seed,
      games: totalGames,
      moves,
      legalMoveRate: moves ? legal / moves : 0,
      kataGoPointLoss: moves ? pointLoss / moves : 0,
      kataGoWinRateLoss: moves ? winRateLoss / moves : 0,
      tokenCost: tokens,
      latencyMs: latency,
      notebookSize: {
        characters: notebook.length,
        tokens: notebook.trim() ? notebook.trim().split(/\s+/).length : 0,
      },
      gameWinRate: manifest.evaluationGameCount
        ? wins / manifest.evaluationGameCount
        : 0,
      scoreMargin: manifest.evaluationGameCount
        ? scoreMargin / manifest.evaluationGameCount
        : 0,
    }
    await writeFile(
      join(directory, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    return {manifest: {...manifest, runId}, runId, summary, directory}
  }
}

export async function listResearchRuns(input: string) {
  const experiments = await readdir(input, {withFileTypes: true})
  const result: ResearchSummary[] = []
  const readSummary = async (path: string) => {
    try {
      result.push(JSON.parse(await readFile(path, 'utf8')) as ResearchSummary)
    } catch {
      /* partial run */
    }
  }
  if (experiments.some((entry) => entry.name === 'manifest.json'))
    await readSummary(join(input, 'summary.json'))
  else
    for (const experiment of experiments)
      if (experiment.isDirectory()) {
        const children = await readdir(join(input, experiment.name), {
          withFileTypes: true,
        })
        if (children.some((entry) => entry.name === 'manifest.json'))
          await readSummary(join(input, experiment.name, 'summary.json'))
        else
          for (const run of children)
            if (run.isDirectory())
              await readSummary(
                join(input, experiment.name, run.name, 'summary.json'),
              )
      }
  return result
}

/** Evaluate a versioned JSONL position set using the same prompt/parser/legality path as runs. */
export async function evaluateResearchPositions(
  positions: ResearchPosition[],
  condition: ResearchCondition,
  adapter: PlayerAdapter,
  kataGo?: KataGoAnalyzer,
) {
  const results: Array<{
    sourceId: string
    legal: boolean
    pointLoss: number
    winRateLoss: number
  }> = []
  for (const raw of positions) {
    const position = researchPositionSchema.parse(raw)
    const moves = position.moveHistory.map((move, index) => {
      const point =
        move.move.toLowerCase() === 'pass'
          ? undefined
          : coordinateToPoint(move.move, position.boardSize)
      return {
        number: index + 1,
        color: move.color,
        action: point ? ('play' as const) : ('pass' as const),
        coordinate: move.move,
        point,
        captured: 0,
      }
    })
    const snapshot = makeSnapshot(position.boardSize, position.komi, moves)
    const prompt = buildResearchPrompt(snapshot, condition, '')
    let action: PlayerAction
    let legal = true
    try {
      const response = adapter.requestTurn
        ? await adapter.requestTurn(
            {
              kind: 'initial',
              content: prompt,
              transcript: [],
              cacheKey: sha256(prompt),
              snapshot,
              output: 'action',
            },
            new AbortController().signal,
          )
        : await adapter
            .requestAction(snapshot, new AbortController().signal, prompt)
            .then((value) => ({
              text:
                value.responseContent ??
                JSON.stringify({
                  move:
                    value.action.action === 'play'
                      ? value.action.coordinate
                      : value.action.action,
                  reason: value.action.comment,
                }),
            }))
      action = parseJsonActionResult(response.text, position.boardSize).action
      const state = replay(position.boardSize, moves)
      if (action.action === 'play')
        playStone(
          state.board as any,
          state.toMove,
          coordinateToPoint(action.coordinate!, position.boardSize),
          state.hashes,
        )
    } catch {
      legal = false
      action = {action: 'pass', comment: 'invalid'}
    }
    let pointLoss = 0
    let winRateLoss = 0
    if (kataGo) {
      const before = await kataGo.analyze({
        size: position.boardSize,
        komi: position.komi,
        moves,
        visits: 1000,
      })
      const afterMoves =
        action.action === 'play'
          ? [
              ...moves,
              {
                number: moves.length + 1,
                color: position.sideToMove,
                action: 'play' as const,
                coordinate: action.coordinate,
                point: coordinateToPoint(
                  action.coordinate!,
                  position.boardSize,
                ),
                captured: 0,
              },
            ]
          : moves
      const after = await kataGo.analyze({
        size: position.boardSize,
        komi: position.komi,
        moves: afterMoves,
        visits: 1000,
      })
      const perspective = position.sideToMove === 'B' ? 1 : -1
      pointLoss = Math.max(
        0,
        perspective * (before.rootInfo.scoreLead - after.rootInfo.scoreLead),
      )
      winRateLoss = Math.max(
        0,
        perspective * (before.rootInfo.winrate - after.rootInfo.winrate),
      )
    }
    results.push({sourceId: position.sourceId, legal, pointLoss, winRateLoss})
  }
  return {
    count: results.length,
    legalMoveRate: results.length
      ? results.filter((result) => result.legal).length / results.length
      : 0,
    pointLoss: results.length
      ? results.reduce((sum, result) => sum + result.pointLoss, 0) /
        results.length
      : 0,
    winRateLoss: results.length
      ? results.reduce((sum, result) => sum + result.winRateLoss, 0) /
        results.length
      : 0,
    results,
  }
}

export type {KataGoResult}
