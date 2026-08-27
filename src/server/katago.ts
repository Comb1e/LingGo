import {EventEmitter} from 'node:events'
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process'
import {createInterface} from 'node:readline'
import {coordinateToPoint, pointToCoordinate} from '../shared/coordinates'
import type {
  BoardSize,
  Color,
  Game,
  KataGoCandidate,
  KataGoHealth,
  KataGoSettings,
  Move,
} from '../shared/types'

export interface KataGoRoot {
  /** Win rate and score lead are normalized to Black's perspective. */
  winrate: number
  scoreLead: number
  visits: number
}

export interface KataGoResult {
  id: string
  turnNumber?: number
  rootInfo: KataGoRoot
  moveInfos?: Array<{
    move: string
    visits: number
    winrate: number
    scoreLead: number
  }>
}

export interface KataGoAnalyzer {
  analyze(
    input: {
      size: BoardSize
      komi: number
      moves: Move[]
      visits: number
      priority?: number
    },
    signal?: AbortSignal,
  ): Promise<KataGoResult>
  close(): Promise<void>
  healthCheck?(): Promise<KataGoHealth>
  updateSettings?(settings: KataGoSettings): Promise<void>
}

type Pending = {
  resolve: (value: KataGoResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  abort?: () => void
}

export class KataGoEngine extends EventEmitter implements KataGoAnalyzer {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, Pending>()
  private nextId = 1
  private closing = false

  constructor(
    private settings: KataGoSettings,
    private timeoutMs = 120_000,
  ) {
    super()
  }

  updateSettings(settings: KataGoSettings) {
    this.settings = settings
    return this.restart()
  }

  async analyze(
    input: {
      size: BoardSize
      komi: number
      moves: Move[]
      visits: number
      priority?: number
    },
    signal?: AbortSignal,
  ) {
    const id = `linggo-${this.nextId++}`
    const request = {
      id,
      rules: 'chinese',
      komi: input.komi,
      boardXSize: input.size,
      boardYSize: input.size,
      moves: input.moves.map((move) => [
        move.color,
        kataGoMove(move, input.size),
      ]),
      maxVisits: input.visits,
      includeOwnership: false,
      includePolicy: false,
      priority: input.priority ?? 0,
    }
    return this.send(
      request,
      signal,
      Math.max(this.timeoutMs, input.visits * 15),
    )
  }

  async healthCheck(): Promise<KataGoHealth> {
    try {
      const result = await this.analyze({
        size: 9,
        komi: 7.5,
        moves: [],
        visits: 25,
        priority: 100,
      })
      return {
        ok: true,
        message: 'KataGo analyzed a 9x9 position.',
        winRate: result.rootInfo.winrate,
        scoreLead: result.rootInfo.scoreLead,
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'KataGo failed',
      }
    }
  }

  async restart() {
    await this.close()
    this.closing = false
  }

  async close() {
    this.closing = true
    const child = this.child
    this.child = undefined
    if (!child) return
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve()
      else {
        child.once('exit', () => resolve())
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 2_000).unref()
      }
    })
    this.rejectAll(new Error('KataGo stopped'))
  }

  private ensureProcess() {
    if (this.child && this.child.exitCode === null) return this.child
    this.closing = false
    const child = spawn(
      this.settings.executablePath,
      [
        'analysis',
        '-model',
        this.settings.modelPath,
        '-config',
        this.settings.configPath,
        '-override-config',
        'reportAnalysisWinratesAs=BLACK',
      ],
      {shell: false, stdio: ['pipe', 'pipe', 'pipe']},
    )
    this.child = child
    const lines = createInterface({input: child.stdout})
    lines.on('line', (line) => this.receiveLine(line))
    child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)))
    child.once('error', (error) =>
      this.rejectAll(new Error(`Unable to launch KataGo: ${error.message}`)),
    )
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (!this.closing)
        this.rejectAll(
          new Error(
            `KataGo exited unexpectedly (${signal ?? code ?? 'unknown'})`,
          ),
        )
    })
    return child
  }

  private send(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<KataGoResult> {
    signal?.throwIfAborted()
    const child = this.ensureProcess()
    return new Promise((resolve, reject) => {
      const id = String(request.id)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.terminate(id)
        reject(new Error(`KataGo request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const abort = signal
        ? () => {
            const pending = this.pending.get(id)
            if (!pending) return
            clearTimeout(pending.timer)
            this.pending.delete(id)
            this.terminate(id)
            reject(new DOMException('KataGo analysis aborted', 'AbortError'))
          }
        : undefined
      if (abort) signal!.addEventListener('abort', abort, {once: true})
      this.pending.set(id, {resolve, reject, timer, abort})
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error)
          this.fail(
            id,
            new Error(`Unable to write to KataGo: ${error.message}`),
          )
      })
    })
  }

  private receiveLine(line: string) {
    if (!line.trim()) return
    let value: any
    try {
      value = JSON.parse(line)
    } catch {
      this.emit('warning', `Ignored non-JSON KataGo output: ${line}`)
      return
    }
    if (!value.id) return
    if (value.error) {
      this.fail(String(value.id), new Error(`KataGo: ${value.error}`))
      return
    }
    const pending = this.pending.get(String(value.id))
    if (!pending) return
    this.pending.delete(String(value.id))
    clearTimeout(pending.timer)
    pending.resolve(value as KataGoResult)
  }

  private terminate(id: string) {
    if (this.child?.exitCode === null)
      this.child.stdin.write(
        `${JSON.stringify({action: 'terminate', terminateId: id})}\n`,
      )
  }

  private fail(id: string, error: Error) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private rejectAll(error: Error) {
    for (const id of [...this.pending.keys()]) this.fail(id, error)
  }
}

export class DeterministicKataGo implements KataGoAnalyzer {
  async analyze(input: {
    size: BoardSize
    komi: number
    moves: Move[]
    visits: number
  }) {
    return {
      id: `fake-${input.moves.length}`,
      rootInfo: {winrate: 0.5, scoreLead: 0, visits: input.visits},
      moveInfos: [
        {move: 'pass', visits: input.visits, winrate: 0.5, scoreLead: 0},
      ],
    }
  }

  async healthCheck(): Promise<KataGoHealth> {
    return {
      ok: true,
      message: 'Deterministic KataGo is ready.',
      winRate: 0.5,
      scoreLead: 0,
    }
  }

  async close() {}
}

export function kataGoMove(move: Move, size: BoardSize): string {
  if (move.action === 'pass' || move.action === 'resign') return 'pass'
  if (!move.point) throw new Error(`Move ${move.number} has no point`)
  return pointToCoordinate(move.point, size)
}

export function rootFromBlack(result: KataGoResult) {
  const blackWinRate = result.rootInfo.winrate
  return {
    blackWinRate,
    whiteWinRate: 1 - blackWinRate,
    blackScoreLead: result.rootInfo.scoreLead,
    visits: result.rootInfo.visits,
  }
}

export function selectedMove(result: KataGoResult): string {
  const move = result.moveInfos?.[0]?.move
  if (!move) throw new Error('KataGo returned no candidate move')
  return move.toLowerCase() === 'pass' ? 'pass' : move
}

export function reviewCandidates(
  result: KataGoResult,
  size: BoardSize,
  toMove: Color,
): KataGoCandidate[] {
  const candidates: KataGoCandidate[] = []
  for (const candidate of result.moveInfos ?? []) {
    if (candidate.move.toLowerCase() === 'pass') continue
    try {
      candidates.push({
        move: candidate.move.toUpperCase(),
        point: coordinateToPoint(candidate.move, size),
        winRate: toMove === 'B' ? candidate.winrate : 1 - candidate.winrate,
        visits: candidate.visits,
      })
    } catch {
      continue
    }
    if (candidates.length === 5) break
  }
  return candidates
}

export function gamePosition(
  game: Pick<Game, 'size' | 'komi' | 'moves'>,
  turn = game.moves.length,
) {
  return {size: game.size, komi: game.komi, moves: game.moves.slice(0, turn)}
}
