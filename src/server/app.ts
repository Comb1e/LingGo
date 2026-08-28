import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {z, ZodError} from 'zod'
import {requestOptionsBody} from '../shared/requestOptions'
import {
  benchmarkConfigSchema,
  newGameSchema,
  playerActionSchema,
  providerKindSchema,
} from '../shared/types'
import {Store} from './database'
import {GameService, StaleVersionError} from './games'
import {AnalysisService} from './analysis'
import {
  DeterministicKataGo,
  gamePosition,
  KataGoEngine,
  reviewCandidates,
  type KataGoAnalyzer,
} from './katago'
import {BenchmarkConflictError, BenchmarkService} from './benchmarks'
import {NotebookStore} from './notebooks'
import {exportSgf, importSgf} from './sgf'
import {createPlayerAdapter} from './providers'
import {
  listProblemSets,
  loadProblemSet,
  problemView,
  scoreProblemAction,
  scoreProblemSequence,
} from './benchmarkProblems'

const connectionSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    kind: providerKindSchema.exclude(['fake']),
    baseUrl: z.string().url().optional(),
    supportsStructuredOutput: z.boolean().default(false),
    apiKey: z.string().optional(),
  })
  .superRefine((connection, context) => {
    if (connection.kind === 'compatible' && !connection.baseUrl) {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Base URL is required for OpenAI-compatible connections',
      })
    }
  })

const profileSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    connectionId: z.string().min(1),
    modelId: z.string().min(1),
    temperature: z.number().min(0).max(2).default(0.7),
    reasoningEnabled: z.boolean().default(true),
    reasoningControl: z.enum(['automatic', 'extra_body']).default('automatic'),
    requestOptions: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(100),
          content: z.string().max(20_000),
        }),
      )
      .max(20)
      .optional(),
    stylePrompt: z.string().max(4000).optional(),
  })
  .superRefine((profile, context) => {
    try {
      requestOptionsBody(profile.requestOptions)
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['requestOptions'],
        message:
          error instanceof Error ? error.message : 'Invalid request options',
      })
    }
  })

const gameEditSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  blackName: z.string().trim().min(1).max(120),
  whiteName: z.string().trim().min(1).max(120),
  commentsVisible: z.boolean(),
  moveCap: z.number().int().positive(),
})

const kataGoSettingsSchema = z.object({
  executablePath: z.string().min(1),
  modelPath: z.string().min(1),
  configPath: z.string().min(1),
  analysisVisits: z.number().int().min(25).max(100_000),
})

const benchmarkSchema = benchmarkConfigSchema

const notebookSchema = z.object({
  name: z.string().trim().min(1).max(120),
})

const publishBenchmarkNotebookSchema = z.discriminatedUnion('mode', [
  z.object({mode: z.literal('replace_source')}),
  z.object({
    mode: z.literal('save_new'),
    name: z.string().trim().min(1).max(120),
  }),
])

export function createApp(
  options: {
    store?: Store
    kataGo?: KataGoAnalyzer
    notebookStore?: NotebookStore
    clientDir?: string
  } = {},
) {
  const app = Fastify({logger: process.env.NODE_ENV !== 'test'})
  const store = options.store ?? new Store()
  const games = new GameService(store)
  const kataGo: KataGoAnalyzer =
    options.kataGo ??
    (process.env.LINGGO_FAKE_KATAGO === '1'
      ? new DeterministicKataGo()
      : new KataGoEngine(store.getKataGoSettings()))
  const analysis = new AnalysisService(store, games, kataGo)
  games.setLlmAnalysisProvider((game, signal) =>
    analysis.contextForLlm(game, signal),
  )
  const benchmarks = new BenchmarkService(
    store,
    games,
    kataGo,
    options.notebookStore,
  )

  app.get('/api/health', async () => ({ok: true}))
  app.get('/api/life-death/problem-sets', async () => listProblemSets())
  app.get('/api/life-death/problem-sets/:setId', async (request, reply) => {
    const {setId} = request.params as {setId: string}
    const set = loadProblemSet(setId)
    return reply.send({
      id: set.id,
      version: set.version,
      checksum: set.checksum,
      count: set.problems.length,
      source: set.source,
      license: set.license,
      attribution: set.attribution,
      problems: set.problems.map(problemView),
    })
  })
  app.post(
    '/api/life-death/problem-sets/:setId/problems/:problemId/answers',
    async (request, reply) => {
      const {setId, problemId} = request.params as {
        setId: string
        problemId: string
      }
      const body = request.body as Record<string, unknown>
      const action = playerActionSchema.parse(body)
      const sequence = Array.isArray(body.sequence)
        ? body.sequence.map((item) => playerActionSchema.parse(item))
        : [action]
      const problem = loadProblemSet(setId).problems.find(
        (candidate) => candidate.id === problemId,
      )
      if (!problem)
        return reply.code(404).send({error: 'Life-and-death problem not found'})
      const result =
        problem.solution.length > 1
          ? scoreProblemSequence(sequence, problem.solution, problem.snapshot)
          : scoreProblemAction(action, problem.expected, problem.snapshot)
      const expectedAction =
        problem.solution[
          Math.min(
            Math.max(sequence.length - 1, 0),
            problem.solution.length - 1,
          )
        ]
      return {
        problemId,
        action,
        expectedAction,
        legal: result.legal,
        correct: result.correct,
        complete: 'complete' in result ? result.complete : result.correct,
        step: 'step' in result ? result.step : 1,
        nextExpectedAction:
          'nextExpectedAction' in result
            ? result.nextExpectedAction
            : undefined,
        failureReason: result.reason,
        board: result.board,
      }
    },
  )
  app.get('/api/games', async () => games.list())
  app.post('/api/games', async (request, reply) =>
    reply.code(201).send(games.create(newGameSchema.parse(request.body))),
  )
  app.get(
    '/api/games/:id',
    async (request) =>
      games.get((request.params as {id: string}).id) ?? notFound(),
  )
  app.get('/api/games/:id/llm-messages', async (request) =>
    games.llmMessageSets((request.params as {id: string}).id),
  )
  app.get('/api/games/:id/positions/:turn', async (request) => {
    const {id, turn} = request.params as {id: string; turn: string}
    return games.position(id, Number(turn))
  })
  app.post('/api/games/:id/positions/:turn/katago', async (request) => {
    const {id, turn: rawTurn} = request.params as {id: string; turn: string}
    const turn = Number(rawTurn)
    const position = games.position(id, turn)
    const game = games.get(id)!
    const result = await kataGo.analyze({
      ...gamePosition(game, turn),
      visits: store.getKataGoSettings().analysisVisits,
      priority: 75,
    })
    return {
      gameId: id,
      turn,
      toMove: position.toMove,
      visits: result.rootInfo.visits,
      candidates: reviewCandidates(result, game.size, position.toMove),
    }
  })
  app.delete('/api/games/:id', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!games.delete(id))
      return reply.code(404).send({error: 'Game not found'})
    return {ok: true}
  })
  app.patch('/api/games/:id', async (request) =>
    games.updateDetails(
      (request.params as {id: string}).id,
      gameEditSchema.parse(request.body),
    ),
  )
  app.post('/api/games/:id/commands', async (request) =>
    games.command((request.params as {id: string}).id, request.body),
  )

  app.get('/api/katago/settings', async () => store.getKataGoSettings())
  app.put('/api/katago/settings', async (request) => {
    const settings = store.saveKataGoSettings(
      kataGoSettingsSchema.parse(request.body),
    )
    await kataGo.updateSettings?.(settings)
    return settings
  })
  app.post('/api/katago/test', async () => {
    if (kataGo.healthCheck) return kataGo.healthCheck()
    try {
      const result = await kataGo.analyze({
        size: 9,
        komi: 7.5,
        moves: [],
        visits: 25,
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
  })
  app.get('/api/games/:id/analysis', async (request) => {
    const {id} = request.params as {id: string}
    if (!games.get(id)) return notFound()
    return analysis.open(id)
  })
  app.put('/api/games/:id/analysis', async (request) => {
    const {id} = request.params as {id: string}
    const values = z
      .object({
        enabled: z.boolean().optional(),
        shareWithLlm: z.boolean().optional(),
      })
      .refine(
        (input) =>
          input.enabled !== undefined || input.shareWithLlm !== undefined,
        'At least one analysis setting is required',
      )
      .parse(request.body)
    return analysis.update(id, values)
  })
  app.post('/api/games/:id/analysis/backfill', async (request) =>
    analysis.backfill((request.params as {id: string}).id),
  )
  app.get('/api/games/:id/analysis/events', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!games.get(id)) return notFound()
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    const send = (value: unknown) =>
      response.write(`data: ${JSON.stringify(value)}\n\n`)
    send(analysis.open(id))
    const keepAlive = setInterval(
      () => response.write(': keep-alive\n\n'),
      15_000,
    )
    analysis.events.on(id, send)
    request.raw.on('close', () => {
      clearInterval(keepAlive)
      analysis.events.off(id, send)
    })
  })

  app.get('/api/games/:id/events', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!games.get(id)) return notFound()
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    const send = (game: unknown) =>
      response.write(`data: ${JSON.stringify(game)}\n\n`)
    send(games.get(id))
    const keepAlive = setInterval(
      () => response.write(': keep-alive\n\n'),
      15_000,
    )
    games.events.on(id, send)
    request.raw.on('close', () => {
      clearInterval(keepAlive)
      games.events.off(id, send)
    })
  })

  app.post('/api/import', async (request, reply) => {
    const {sgf: contents} = z
      .object({sgf: z.string().min(1)})
      .parse(request.body)
    const record = importSgf(contents)
    const game = games.importRecord(record)
    return reply.code(201).send({game, warnings: record.warnings})
  })
  app.get('/api/games/:id/export.sgf', async (request, reply) => {
    const game = games.get((request.params as {id: string}).id)
    if (!game) return notFound()
    reply.type('application/x-go-sgf; charset=utf-8')
    reply.header(
      'Content-Disposition',
      `attachment; filename="linggo-${game.id}.sgf"`,
    )
    return exportSgf(game)
  })

  app.get('/api/connections', async () =>
    store.listConnections().map((connection) => ({
      ...connection,
      hasSessionKey:
        games.vault.has(connection.id) || Boolean(games.vault.get(connection)),
    })),
  )
  app.post('/api/connections', async (request, reply) => {
    const input = connectionSchema.parse(request.body)
    const id = input.id ?? crypto.randomUUID()
    store.saveConnection({...input, id})
    if (input.apiKey !== undefined) {
      games.vault.set(id, input.apiKey)
      games.restoreAutoplay()
      benchmarks.resumeWaiting()
    }
    return reply
      .code(201)
      .send({...store.getConnection(id), hasSessionKey: games.vault.has(id)})
  })
  app.put('/api/connections/:id', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!store.getConnection(id))
      return reply.code(404).send({error: 'Provider connection not found'})
    if (id === 'builtin-fake')
      return reply
        .code(400)
        .send({error: 'The built-in connection cannot be edited'})
    const input = connectionSchema.parse(request.body)
    store.saveConnection({...input, id})
    if (input.apiKey !== undefined) {
      games.vault.set(id, input.apiKey)
      games.restoreAutoplay()
      benchmarks.resumeWaiting()
    }
    return {
      ...store.getConnection(id),
      hasSessionKey:
        games.vault.has(id) ||
        Boolean(games.vault.get(store.getConnection(id)!)),
    }
  })
  app.put('/api/connections/:id/key', async (request) => {
    const {id} = request.params as {id: string}
    if (!store.getConnection(id)) return notFound()
    const {apiKey} = z.object({apiKey: z.string()}).parse(request.body)
    games.vault.set(id, apiKey)
    if (apiKey.trim()) {
      games.restoreAutoplay()
      benchmarks.resumeWaiting()
    }
    return {ok: true, hasSessionKey: games.vault.has(id)}
  })
  app.delete('/api/connections/:id', async (request, reply) => {
    const {id} = request.params as {id: string}
    const connection = store.getConnection(id)
    if (!connection)
      return reply.code(404).send({error: 'Provider connection not found'})
    if (id === 'builtin-fake')
      return reply
        .code(400)
        .send({error: 'The built-in connection cannot be deleted'})
    const profileIds = new Set(
      store
        .listProfiles()
        .filter((profile) => profile.connectionId === id)
        .map((profile) => profile.id),
    )
    if (unfinishedGameUsesProfile(store, profileIds))
      return reply.code(409).send({
        error:
          'This connection has a player profile used by an unfinished game',
      })
    store.deleteConnection(id)
    games.vault.delete(id)
    return {ok: true}
  })

  app.get('/api/profiles', async () => store.listProfiles())
  app.post('/api/profiles/test', async (request) => {
    const input = profileSchema.parse(request.body)
    const connection = store.getConnection(input.connectionId)
    if (!connection) throw new Error('Provider connection not found')
    const adapter = createPlayerAdapter(
      connection,
      {...input, id: 'profile-test'},
      games.vault,
    )
    if (!adapter.requestText)
      throw new Error('This provider does not support profile tests')
    const result = await adapter.requestText(
      'Reply with exactly: OK',
      AbortSignal.timeout(30_000),
    )
    return {ok: true, ...result}
  })
  app.get('/api/profiles/:id/notebooks', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!store.getProfile(id))
      return reply.code(404).send({error: 'Player profile not found'})
    return benchmarks.notebooks.list(id)
  })
  app.post('/api/profiles/:id/notebooks', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!store.getProfile(id))
      return reply.code(404).send({error: 'Player profile not found'})
    return reply
      .code(201)
      .send(
        benchmarks.notebooks.create(
          id,
          notebookSchema.parse(request.body).name,
        ),
      )
  })
  app.patch(
    '/api/profiles/:id/notebooks/:notebookId',
    async (request, reply) => {
      const {id, notebookId} = request.params as {
        id: string
        notebookId: string
      }
      const notebook = benchmarks.notebooks.rename(
        id,
        notebookId,
        notebookSchema.parse(request.body).name,
      )
      return (
        notebook ??
        reply.code(404).send({error: 'Technique notebook not found'})
      )
    },
  )
  app.delete(
    '/api/profiles/:id/notebooks/:notebookId',
    async (request, reply) => {
      const {id, notebookId} = request.params as {
        id: string
        notebookId: string
      }
      if (
        store
          .listBenchmarks()
          .some(
            (run) =>
              run.config.notebookSeed.mode === 'refine_existing' &&
              run.config.notebookSeed.notebookId === notebookId &&
              ['queued', 'running', 'paused'].includes(run.status),
          )
      )
        return reply
          .code(409)
          .send({error: 'This notebook is used by an active benchmark'})
      return benchmarks.notebooks.delete(id, notebookId)
        ? {ok: true}
        : reply.code(404).send({error: 'Technique notebook not found'})
    },
  )
  app.get(
    '/api/profiles/:id/notebooks/:notebookId.md',
    async (request, reply) => {
      const {id, notebookId} = request.params as {
        id: string
        notebookId: string
      }
      const notebook = benchmarks.notebooks.get(id, notebookId)
      if (!notebook)
        return reply.code(404).send({error: 'Technique notebook not found'})
      reply.type('text/markdown; charset=utf-8')
      reply.header(
        'Content-Disposition',
        `attachment; filename="${downloadName(notebook.name)}.md"`,
      )
      return notebook.content
    },
  )
  app.post('/api/profiles', async (request, reply) => {
    const input = profileSchema.parse(request.body)
    if (!store.getConnection(input.connectionId))
      throw new Error('Provider connection not found')
    const id = input.id ?? crypto.randomUUID()
    store.saveProfile({...input, id})
    return reply.code(201).send(store.getProfile(id))
  })
  app.put('/api/profiles/:id', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!store.getProfile(id))
      return reply.code(404).send({error: 'Player profile not found'})
    if (id === 'builtin-fake-profile')
      return reply
        .code(400)
        .send({error: 'The built-in player profile cannot be edited'})
    const input = profileSchema.parse(request.body)
    if (!store.getConnection(input.connectionId))
      return reply.code(400).send({error: 'Provider connection not found'})
    store.saveProfile({...input, id})
    return store.getProfile(id)
  })
  app.delete('/api/profiles/:id', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!store.getProfile(id))
      return reply.code(404).send({error: 'Player profile not found'})
    if (id === 'builtin-fake-profile')
      return reply
        .code(400)
        .send({error: 'The built-in player profile cannot be deleted'})
    if (unfinishedGameUsesProfile(store, new Set([id])))
      return reply
        .code(409)
        .send({error: 'This player profile is used by an unfinished game'})
    if (
      store
        .listBenchmarks()
        .some(
          (run) =>
            run.config.profileId === id &&
            ['queued', 'running', 'paused'].includes(run.status),
        )
    )
      return reply
        .code(409)
        .send({error: 'This player profile is used by an active benchmark'})
    store.deleteProfile(id)
    return {ok: true}
  })

  app.get('/api/benchmarks', async () => benchmarks.list())
  app.get('/api/benchmark-problem-sets', async () =>
    benchmarks.listProblemSets(),
  )
  app.get('/api/benchmarks/:id/current-problem', async (request, reply) => {
    const value = benchmarks.currentProblem((request.params as {id: string}).id)
    return (
      value ?? reply.code(404).send({error: 'Current problem not available'})
    )
  })
  app.get('/api/benchmarks/events', async (request, reply) => {
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    const send = () =>
      response.write(`data: ${JSON.stringify(benchmarks.list())}\n\n`)
    send()
    const keepAlive = setInterval(
      () => response.write(': keep-alive\n\n'),
      15_000,
    )
    benchmarks.events.on('changed', send)
    request.raw.on('close', () => {
      clearInterval(keepAlive)
      benchmarks.events.off('changed', send)
    })
  })
  app.post('/api/benchmarks', async (request, reply) =>
    reply
      .code(201)
      .send(await benchmarks.create(benchmarkSchema.parse(request.body))),
  )
  app.get(
    '/api/benchmarks/:id',
    async (request, reply) =>
      benchmarks.get((request.params as {id: string}).id) ??
      reply.code(404).send({error: 'Benchmark not found'}),
  )
  app.post('/api/benchmarks/:id/commands', async (request) => {
    const {id} = request.params as {id: string}
    const command = z
      .object({
        type: z.enum([
          'pause',
          'resume',
          'nextMoveAndPause',
          'cancel',
          'force',
        ]),
        action: playerActionSchema.optional(),
      })
      .parse(request.body)
    if (command.type === 'pause') return benchmarks.pause(id)
    if (command.type === 'resume') return benchmarks.resume(id)
    if (command.type === 'nextMoveAndPause')
      return benchmarks.nextMoveAndPause(id)
    if (command.type === 'cancel') return benchmarks.cancel(id)
    if (!command.action) throw new Error('A forced action is required')
    return benchmarks.force(id, command.action)
  })
  app.delete('/api/benchmarks/:id', async (request, reply) => {
    const deleted = await benchmarks.delete((request.params as {id: string}).id)
    return deleted
      ? {ok: true}
      : reply.code(404).send({error: 'Benchmark not found'})
  })
  app.get('/api/benchmarks/:id/notebook.md', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!benchmarks.get(id))
      return reply.code(404).send({error: 'Benchmark not found'})
    const markdown = await benchmarks.notebooks.readSnapshot(id)
    reply.type('text/markdown; charset=utf-8')
    reply.header(
      'Content-Disposition',
      `inline; filename="linggo-benchmark-${id}.md"`,
    )
    return markdown
  })
  app.get('/api/benchmarks/:id/notebook-versions', async (request, reply) => {
    const id = (request.params as {id: string}).id
    if (!benchmarks.get(id))
      return reply.code(404).send({error: 'Benchmark not found'})
    return store.listBenchmarkNotebookVersions(id)
  })
  app.get('/api/benchmarks/:id/move-reviews', async (request, reply) => {
    const id = (request.params as {id: string}).id
    if (!benchmarks.get(id))
      return reply.code(404).send({error: 'Benchmark not found'})
    return store.listBenchmarkMoveReviews(id)
  })
  app.get('/api/benchmarks/:id/problem-attempts', async (request, reply) => {
    const id = (request.params as {id: string}).id
    if (!benchmarks.get(id))
      return reply.code(404).send({error: 'Benchmark not found'})
    return benchmarks.problemAttempts(id)
  })
  app.post('/api/benchmarks/:id/publish', async (request, reply) => {
    const id = (request.params as {id: string}).id
    try {
      return benchmarks.publishNotebook(
        id,
        publishBenchmarkNotebookSchema.parse(request.body),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Publish failed'
      return reply
        .code(message.includes('not found') ? 404 : 409)
        .send({error: message})
    }
  })
  app.get('/api/benchmarks/:id/events', async (request, reply) => {
    const {id} = request.params as {id: string}
    if (!benchmarks.get(id))
      return reply.code(404).send({error: 'Benchmark not found'})
    reply.hijack()
    const response = reply.raw
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    const send = (value: unknown) =>
      response.write(`data: ${JSON.stringify(value)}\n\n`)
    send(benchmarks.get(id))
    const keepAlive = setInterval(
      () => response.write(': keep-alive\n\n'),
      15_000,
    )
    benchmarks.events.on(id, send)
    request.raw.on('close', () => {
      clearInterval(keepAlive)
      benchmarks.events.off(id, send)
    })
  })

  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof StaleVersionError ||
      error instanceof BenchmarkConflictError
    )
      return reply.code(409).send({error: error.message})
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({error: error.issues.map((issue) => issue.message).join('; ')})
    const message =
      error instanceof Error ? error.message : 'Unexpected server error'
    const status = message === 'Game not found' ? 404 : 400
    return reply.code(status).send({error: message})
  })

  const clientDir = options.clientDir ?? join(process.cwd(), 'dist', 'client')
  if (
    (process.env.NODE_ENV === 'production' || options.clientDir) &&
    existsSync(clientDir)
  ) {
    void app.register(fastifyStatic, {root: clientDir})
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/'))
        return reply.code(404).send({error: 'Not found'})
      return reply.sendFile('index.html')
    })
  }

  app.addHook('onClose', async () => {
    for (const game of games.list()) games.cancel(game.id)
    await benchmarks.close()
    await analysis.close()
    store.close()
  })
  return {app, games, store, analysis, kataGo, benchmarks}
}

function notFound(): never {
  throw new Error('Game not found')
}

function unfinishedGameUsesProfile(store: Store, profileIds: Set<string>) {
  if (!profileIds.size) return false
  return store
    .listGames()
    .some(
      (game) =>
        game.status !== 'finished' &&
        [game.black, game.white].some(
          (seat) => seat.type === 'llm' && profileIds.has(seat.profileId),
        ),
    )
}

function downloadName(name: string) {
  return (
    name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'notebook'
  )
}
