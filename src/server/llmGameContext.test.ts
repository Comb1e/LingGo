import {afterEach, describe, expect, it} from 'vitest'
import {Store} from './database'
import {GameService} from './games'
import {
  makeContinuationLlmPrompt,
  makeGameIntentionPrompt,
  makeReflectionLlmPrompt,
  modelFingerprint,
} from './llmGameContext'
import {makeSnapshot} from './go'

let store: Store
afterEach(() => store?.close())

describe('persistent LLM game context', () => {
  it('makes an appended intention request distinct from a move turn', () => {
    const prompt = makeGameIntentionPrompt()

    expect(prompt).toContain('TASK SWITCH')
    expect(prompt).toContain('This is not a turn')
    expect(prompt).toContain('game conversation immediately above')
    expect(prompt).toContain('1 to 3 concise plain-text sentences')
    expect(prompt).not.toContain('CURRENT POSITION')
    expect(prompt).not.toContain('JSON OUTPUT SCHEMA')
  })

  it('persists a pending initial turn and reuses it after restart', () => {
    const {games, game, profile, connection} = setupGame()
    const first = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary', stylePrompt: 'Prefer influence.'},
    })

    expect(first.request.kind).toBe('initial')
    expect(first.request.content).toContain('1. GO RULES')
    expect(first.request.content).toContain('2. PLAYING STYLE')
    expect(first.request.content).toContain('Prefer influence.')
    expect(first.request.content).toContain('5. CURRENT POSITION')
    expect(first.request.content).toContain('Captures: Black 0, White 0.')
    expect(first.request.content).not.toContain('From the side to move')
    expect(first.request.content).not.toContain('Move list:')
    expect(store.getLlmGameContext(game.id, 'B')?.pendingTurn).toEqual(
      first.context.pendingTurn,
    )

    const restarted = new GameService(store)
    const restored = restarted.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary', stylePrompt: 'Prefer influence.'},
    })
    expect(restored.request).toEqual(first.request)
  })

  it('continues the notebook initialization context into the first game turn', () => {
    const {games, game, profile, connection} = setupGame()
    const transcript = [
      {role: 'user' as const, content: 'Write the technique notebook.'},
      {role: 'assistant' as const, content: '# Initialized notebook'},
    ]
    expect(
      games.seedLlmContext({
        gameId: game.id,
        color: 'B',
        profile,
        connection,
        transcript,
      }),
    ).toBe(true)

    const prepared = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {
        kind: 'benchmark',
        phase: 'training',
        notebook: '# Initialized notebook',
      },
    })

    expect(prepared.request.kind).toBe('initial')
    expect(prepared.request.transcript).toEqual(transcript)
    expect(prepared.request.content).toContain('BEGIN FIRST BENCHMARK GAME')
    expect(prepared.request.content).toContain('JSON OUTPUT SCHEMA')
    expect(prepared.request.content).toContain('CURRENT BOARD')
    expect(prepared.request.content).not.toContain('GO RULES')
    expect(prepared.request.content).not.toContain('SELF-WRITTEN SKILLS')
    expect(prepared.request.content).not.toContain('# Initialized notebook')
  })

  it('includes a saved game intention in a rebuilt initial prompt', () => {
    const {games, game, profile, connection} = setupGame()
    games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    store.markLlmGameContextsNeedsRebase(
      game.id,
      'B',
      'Build influence on the upper side while keeping the group connected.',
    )

    const prepared = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })

    expect(prepared.request.content).toContain('GAME INTENTION')
    expect(prepared.request.content).toContain(
      'Build influence on the upper side while keeping the group connected.',
    )
    expect(prepared.request.transcript).toEqual([])
  })

  it('advances atomically and sends only the newly observed opponent move', async () => {
    const {games, game, profile, connection} = setupGame()
    const prepared = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary', stylePrompt: 'Prefer influence.'},
    })
    const response = turnResponse('{"move":"A9","reason":"Open."}')
    const context = games.completedLlmContext(prepared, response, 'active', 1)
    const updated = games.acceptAutomated(
      game.id,
      {action: 'play', coordinate: 'A9', comment: 'Open.'},
      actionResult('A9'),
      false,
      context,
    )
    expect(store.getLlmGameContext(game.id, 'B')).toMatchObject({
      status: 'active',
      lastObservedMove: 1,
      pendingTurn: undefined,
    })

    await games.command(game.id, {
      expectedVersion: updated.version,
      type: 'play',
      coordinate: 'B9',
    })
    const continuation = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary', stylePrompt: 'Prefer influence.'},
      latestWinRate: 'Turn 2: your win rate 48.00%',
    })
    expect(continuation.request.kind).toBe('continuation')
    expect(continuation.request.content).toContain(
      'Newly observed opponent action: 2. W B9',
    )
    expect(continuation.request.content).toContain('Turn 2: your win rate')
    expect(continuation.request.content).toContain(
      'Latest win-rate update (retrospective; see the initial training instructions',
    )
    expect(continuation.request.content).not.toContain(
      'not a recommendation for the current position',
    )
    expect(continuation.request.content).not.toContain('GO RULES')
    expect(continuation.request.content).not.toContain('PLAYING STYLE')
    expect(continuation.request.content).not.toContain('RESPONSE SCHEMA')
    expect(continuation.request.content).not.toContain('A9')
    expect(continuation.request.transcript).toHaveLength(2)
  })

  it('labels structured training continuations as top-five candidate feedback', () => {
    const prompt = makeContinuationLlmPrompt(
      makeSnapshot(9, 7.5, []),
      {
        number: 1,
        color: 'W',
        action: 'play',
        coordinate: 'A9',
        point: [0, 8],
        captured: 0,
      },
      'KataGo candidates (best first): #1 D4, #2 Q16, #3 C3, #4 R17, #5 K10.',
      'structured',
    )
    expect(prompt).toContain('#5 K10')
    expect(prompt).toContain(
      "Latest training win-rate update (retrospective; includes KataGo's top five ranked candidates",
    )
  })

  it('puts KataGo candidate interpretation guidance in the initial training prompt', () => {
    const {games, game, profile, connection} = setupGame()
    const prepared = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {
        kind: 'benchmark',
        phase: 'training',
        notebook: '',
        trainingFeedback: 'structured',
      },
    })

    expect(prepared.request.content).toContain('KATAGO TRAINING FEEDBACK')
    expect(prepared.request.content).toContain(
      'top five ranked KataGo candidates',
    )
    expect(prepared.request.content).toContain(
      'not recommendations for the current position',
    )
    expect(prepared.request.content).toContain(
      "Candidate #1 is KataGo's best choice and is the baseline for the reported win-rate loss",
    )
  })

  it('sends only the validation reason when repairing an invalid move', () => {
    const {games, game, profile, connection} = setupGame()
    const prepared = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    const rejected = turnResponse('{"move":"A9","reason":"Occupied."}')
    const repaired = games.repairLlmActionTurn(
      prepared,
      rejected,
      'Intersection is occupied',
    )

    expect(repaired.request.content).toBe('Intersection is occupied')
    expect(repaired.request.content).not.toContain(rejected.text)
    expect(repaired.request.content).not.toContain('CURRENT POSITION')
    expect(repaired.request.content).not.toContain('Captures:')
    expect(repaired.request.transcript.at(-1)).toEqual({
      role: 'assistant',
      content: rejected.text,
    })
  })

  it('isolates seats and marks contexts for rebase after undo', async () => {
    const {games, game, profile, connection} = setupGame()
    games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'W',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    expect(store.getLlmGameContext(game.id, 'B')?.color).toBe('B')
    expect(store.getLlmGameContext(game.id, 'W')?.color).toBe('W')

    let current = await games.command(game.id, {
      expectedVersion: game.version,
      type: 'play',
      coordinate: 'A9',
    })
    current = await games.command(game.id, {
      expectedVersion: current.version,
      type: 'undo',
    })
    expect(current.moves).toHaveLength(0)
    expect(store.getLlmGameContext(game.id, 'B')?.status).toBe('needs_rebase')
    expect(store.getLlmGameContext(game.id, 'W')?.status).toBe('needs_rebase')
  })

  it('rebases when the profile fingerprint changes', () => {
    const {games, game, profile, connection} = setupGame()
    const first = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    const changed = {...profile, modelId: 'deterministic-v2'}
    const rebased = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile: changed,
      connection,
      mode: {kind: 'ordinary'},
    })
    expect(rebased.request.kind).toBe('initial')
    expect(rebased.request.transcript).toEqual([])
    expect(rebased.context.modelFingerprint).not.toBe(
      first.context.modelFingerprint,
    )
    expect(rebased.context.modelFingerprint).toBe(
      modelFingerprint(changed, connection),
    )
  })

  it('starts each new game with an empty provider context', () => {
    const {games, game, profile, connection} = setupGame()
    const managedConnection = {...connection, kind: 'openai' as const}
    const first = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection: managedConnection,
      mode: {kind: 'ordinary'},
    })
    store.saveLlmGameContext(
      games.completedLlmContext(
        first,
        {
          ...turnResponse('{"move":"A9","reason":"First game."}'),
          providerContinuationId: 'resp-first-game',
        },
        'complete',
        1,
      ),
    )
    games.disableManagedLlmContinuation(game.id, 'B')

    const nextGame = games.create({
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'Black'},
      white: {type: 'human', name: 'White'},
      commentsVisible: true,
    })
    expect(games.llmMessageSets(nextGame.id)).toEqual([])

    const next = games.prepareLlmActionTurn({
      gameId: nextGame.id,
      color: 'B',
      profile,
      connection: managedConnection,
      mode: {kind: 'ordinary'},
    })
    expect(next.request).toMatchObject({
      kind: 'initial',
      transcript: [],
      previousResponseId: undefined,
    })
    expect(next.request.cacheKey).not.toBe(first.request.cacheKey)
    expect(next.context.managedContinuation).toBe(true)
    expect(next.request.content).not.toContain('First game.')
  })

  it('rebases invalid persisted state and deletes context with its game', () => {
    const {games, game, profile, connection} = setupGame()
    games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    store.db
      .prepare(
        `UPDATE llm_game_contexts SET transcript_json = ?
         WHERE game_id = ? AND color = 'B'`,
      )
      .run('[{"role":"system","content":42}]', game.id)

    const rebased = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection,
      mode: {kind: 'ordinary'},
    })
    expect(rebased.request.kind).toBe('initial')
    expect(rebased.request.transcript).toEqual([])

    expect(games.delete(game.id)).toBe(true)
    expect(store.getLlmGameContext(game.id, 'B')).toBeUndefined()
  })

  it('uses the final authoritative delta and exact perspective outcome', () => {
    const {game} = setupGame()
    game.result = 'W+3.5'
    game.moves.push({
      number: 1,
      color: 'W',
      action: 'pass',
      captured: 0,
    })
    const prompt = makeReflectionLlmPrompt(game, 'B', game.moves)
    expect(prompt).toContain('Newly observed terminal opponent action:')
    expect(prompt).toContain('1. W pass')
    expect(prompt).toContain('Outcome: You lost by 3.5 points')
    expect(prompt).toMatch(
      /Return only the complete replacement Markdown technique notebook\.$/,
    )
    expect(prompt).not.toContain('GO RULES')
    expect(prompt).not.toContain('Move list')
  })

  it('prepares reflection in the move conversation with an unseen terminal delta', () => {
    const {games, game, profile, connection} = setupGame()
    const managedConnection = {...connection, kind: 'openai' as const}
    const persisted = store.getGame(game.id)!
    persisted.benchmarkRunId = 'test-run'
    store.saveGame(persisted)
    const moveTurn = games.prepareLlmActionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection: managedConnection,
      mode: {kind: 'benchmark', phase: 'training', notebook: '# Skills'},
    })
    const response = {
      ...turnResponse('{"move":"pass","reason":"Done."}'),
      providerContinuationId: 'resp-training-game',
    }
    const context = games.completedLlmContext(moveTurn, response, 'active', 1)
    games.acceptAutomated(
      game.id,
      {action: 'pass', comment: 'Done.'},
      {
        ...actionResult('A9'),
        action: {action: 'pass', comment: 'Done.'},
      },
      false,
      context,
    )
    games.acceptAutomated(game.id, {
      action: 'pass',
      comment: 'Opponent passed.',
    })
    games.finishAutomated(game.id, 'W+2.5')

    const reflection = games.prepareLlmReflectionTurn({
      gameId: game.id,
      color: 'B',
      profile,
      connection: managedConnection,
    })
    expect(reflection.request.cacheKey).toBe(moveTurn.request.cacheKey)
    expect(reflection.request.cacheKey).toBe(`linggo:${game.id}:B`)
    expect(reflection.request.previousResponseId).toBe('resp-training-game')
    expect(reflection.request.transcript).toEqual([
      {role: 'user', content: moveTurn.request.content},
      {role: 'assistant', content: response.text},
    ])
    expect(reflection.request.content).toContain(
      'Newly observed terminal opponent action:',
    )
    expect(reflection.request.content).toContain('2. W pass')
    expect(reflection.request.content).toContain(
      'Outcome: You lost by 2.5 points',
    )
  })
})

function setupGame() {
  store = new Store(':memory:')
  const games = new GameService(store)
  const game = games.create({
    size: 9,
    komi: 7.5,
    black: {type: 'human', name: 'Black'},
    white: {type: 'human', name: 'White'},
    commentsVisible: true,
  })
  const profile = store.getProfile('builtin-fake-profile')!
  const connection = store.getConnection(profile.connectionId)!
  return {games, game, profile, connection}
}

function turnResponse(text: string) {
  return {
    text,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: 'deterministic-v1',
    providerKind: 'fake' as const,
  }
}

function actionResult(coordinate: string) {
  return {
    action: {action: 'play' as const, coordinate, comment: 'Open.'},
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: 'deterministic-v1',
    providerKind: 'fake' as const,
    retries: 0,
  }
}
