import {afterEach, describe, expect, it, vi} from 'vitest'
import type {GameSnapshot, ProviderKind} from '../shared/types'
import {emptyBoard} from './go'
import {
  LlmPlayerAdapter,
  isOpenAiReasoningModel,
  makePrompt,
  parseJsonAction,
  parseJsonActionResult,
  SecretVault,
} from './providers'

afterEach(() => vi.unstubAllGlobals())

describe('provider normalization', () => {
  it('identifies OpenAI models that do not support temperature', () => {
    expect(isOpenAiReasoningModel('gpt-5.6-luna')).toBe(true)
    expect(isOpenAiReasoningModel('gpt-5.6-sol')).toBe(true)
    expect(isOpenAiReasoningModel('gpt-5')).toBe(true)
    expect(isOpenAiReasoningModel('o4-mini')).toBe(true)
    expect(isOpenAiReasoningModel('gpt-5-chat-latest')).toBe(false)
    expect(isOpenAiReasoningModel('gpt-4.1')).toBe(false)
    expect(isOpenAiReasoningModel('ft:gpt-5:custom')).toBe(false)
  })

  it('parses plain JSON array moves and fenced fallback output', () => {
    expect(parseJsonAction('{"move":[-1,-1],"reason":"done"}', 9)).toEqual({
      action: 'pass',
      comment: 'done',
    })
    expect(parseJsonAction('{"move":[-2,-2],"reason":"concede"}', 9)).toEqual({
      action: 'resign',
      comment: 'concede',
    })
    expect(
      parseJsonAction('```json\n{"move":[3,5],"reason":"shape"}\n```', 9),
    ).toMatchObject({
      action: 'play',
      coordinate: 'D4',
      comment: 'shape',
    })
  })

  it('rejects malformed action output', () =>
    expect(() => parseJsonAction('{"move":[1],"reason":"bad"}', 9)).toThrow(
      'Invalid',
    ))

  it('rejects array coordinates outside the board', () =>
    expect(() =>
      parseJsonAction('{"move":[9,0],"reason":"outside"}', 9),
    ).toThrow('outside the 9x9 board'))

  it('parses optional numbered in-game reflection updates', () => {
    expect(parseJsonActionResult(JSON.stringify({
      move: [3, 5],
      reason: 'shape',
      in_game_reflections: [
        {number: 1, reflection: 'Check whether the outside stones can escape.'},
        {number: 3, reflection: 'Keep forcing moves in reserve.'},
      ],
    }), 9)).toEqual({
      action: {action: 'play', coordinate: 'D4', comment: 'shape'},
      inGameReflections: [
        {number: 1, reflection: 'Check whether the outside stones can escape.'},
        {number: 3, reflection: 'Keep forcing moves in reserve.'},
      ],
    })
    expect(() => parseJsonActionResult(JSON.stringify({
      move: [-1, -1],
      reason: 'done',
      in_game_reflections: [{number: 0, reflection: 'Not positively numbered.'}],
    }), 9)).toThrow('Invalid')
  })

  it('does not expose stored secrets', () => {
    const vault = new SecretVault()
    vault.set('x', 'super-secret')
    expect(JSON.stringify(vault)).not.toContain('super-secret')
  })

  it('builds a stateless complete position prompt', () => {
    const board = emptyBoard(9)
    board[0][0] = 1
    board[1][1] = 2
    const prompt = makePrompt(
      {
        size: 9,
        komi: 7.5,
        board,
        toMove: 'B',
        moves: [],
        captures: {B: 3, W: 2},
        rules: 'Chinese area',
      },
      'Prefer influence over territory.',
    )
    expect(prompt).toContain('1. GO RULES')
    expect(prompt).toContain(
      '2. PLAYING STYLE\nPrefer influence over territory.',
    )
    expect(prompt).toContain('3. INSTRUCTION')
    expect(prompt).toContain('4. RESPONSE SCHEMA')
    expect(prompt).toContain(
      '{"move":[column,row],"reason":"brief reason for this move"}',
    )
    expect(prompt).toContain('5. CURRENT POSITION')
    expect(prompt).toContain('A B C D E F G H J')
    expect(prompt).toContain('9 X . . . . . . . .')
    expect(prompt).toContain('8 . O . . . . . . .')
    expect(prompt).toContain('To move: Black')
    expect(prompt).toContain('Black has captured 3 White stones')
    expect(prompt).toContain('you have captured 3 opponent stones; the opponent has captured 2 of your stones')
  })

  it('includes the intersections where stones were captured', () => {
    const snapshot = emptySnapshot()
    snapshot.moves = [{
      number: 1,
      color: 'B',
      action: 'play',
      point: [2, 2],
      coordinate: 'C7',
      comment: '',
      captured: 2,
      capturedPoints: [[1, 1], [1, 2]],
    }]

    expect(makePrompt(snapshot)).toContain(
      'captured 2 at B8 [1,1], B7 [1,2]',
    )
  })

  it('includes comments and reasoning for every previous move by this player', () => {
    const snapshot = emptySnapshot()
    snapshot.moves = [
      {
        number: 1,
        color: 'B',
        action: 'play',
        point: [2, 2],
        coordinate: 'C7',
        comment: 'Build outward.\nKeep sente.',
        reasoning: 'I compared both corners.',
        captured: 0,
      },
      {
        number: 2,
        color: 'W',
        action: 'play',
        point: [3, 3],
        coordinate: 'D6',
        comment: 'Opponent comment',
        reasoning: 'Opponent private reasoning',
        captured: 0,
      },
      {
        number: 3,
        color: 'B',
        action: 'pass',
        captured: 0,
      },
    ]

    const prompt = makePrompt(snapshot)
    expect(prompt).toContain(
      '1. B C7; your comment: "Build outward.\\nKeep sente."; your reasoning: "I compared both corners."',
    )
    expect(prompt).toContain(
      '3. B pass; your comment: ""; your reasoning: ""',
    )
    expect(prompt).not.toContain('Opponent comment')
    expect(prompt).not.toContain('Opponent private reasoning')
  })

  it('states when no playing style is configured', () => {
    expect(makePrompt(emptySnapshot())).toContain('2. PLAYING STYLE\n(none)')
  })

  it('includes KataGo win rates in ordinary prompts only when provided', () => {
    const snapshot = emptySnapshot()
    expect(makePrompt(snapshot)).not.toContain('KATAGO WIN-RATE HISTORY')
    snapshot.kataGoAnalysis =
      'Turn 0: your win rate 50.00%; opponent 50.00%'
    const prompt = makePrompt(snapshot)
    expect(prompt).toContain(
      '6. KATAGO WIN-RATE HISTORY\nTurn 0: your win rate 50.00%; opponent 50.00%',
    )
    expect(prompt).toContain('You may use the supplied KataGo win-rate history.')
    expect(prompt).not.toContain('Do not use external analysis.')
  })

  it.each([
    ['openai', '/proxy/openai/v1/responses'],
    ['anthropic', '/proxy/anthropic/v1/messages'],
    ['google', '/proxy/google/v1beta/models/test-model:generateContent'],
  ] satisfies Array<[ProviderKind, string]>)(
    'sends %s requests to its custom base URL',
    async (kind, expectedPath) => {
      let requestedUrl = ''
      let requestBody = ''
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          requestedUrl = String(input)
          requestBody = String(init?.body ?? '')
          return new Response('{"error":{"message":"test stop"}}', {
            status: 500,
            headers: {'content-type': 'application/json'},
          })
        }),
      )
      const adapter = new LlmPlayerAdapter(
        {
          id: `custom-${kind}`,
          name: `Custom ${kind}`,
          kind,
          baseUrl: `https://models.example.test/proxy/${kind}/v1${kind === 'google' ? 'beta' : ''}`,
          supportsStructuredOutput: true,
        },
        {
          id: `profile-${kind}`,
          name: 'Test profile',
          connectionId: `custom-${kind}`,
          modelId: kind === 'openai' ? 'gpt-5.6-sol' : 'test-model',
          temperature: 0,
          requestOptions: [
            {name: 'linggo_test', content: '{"enabled":true}'},
            ...(kind === 'openai'
              ? [{name: 'reasoning', content: '{"effort":"high"}'}]
              : []),
          ],
        },
        'test-key',
      )

      await expect(
        adapter.requestAction(emptySnapshot(), new AbortController().signal),
      ).rejects.toThrow()
      expect(new URL(requestedUrl).pathname).toBe(expectedPath)
      expect(requestBody).toContain('4. RESPONSE SCHEMA')
      expect(requestBody).not.toContain('go_action')
      expect(requestBody).not.toContain('json_schema')
      const body = JSON.parse(requestBody)
      expect(body.linggo_test).toEqual({enabled: true})
      if (kind === 'openai') {
        expect(body.reasoning).toEqual({effort: 'high', summary: 'detailed'})
        expect(body).not.toHaveProperty('temperature')
      } else if (kind === 'anthropic') {
        expect(body.thinking).toBeTruthy()
      } else {
        expect(body.generationConfig.thinkingConfig).toMatchObject({
          includeThoughts: true,
        })
      }
    },
  )
})

function emptySnapshot(): GameSnapshot {
  return {
    size: 9,
    komi: 7.5,
    board: emptyBoard(9),
    toMove: 'B',
    moves: [],
    captures: {B: 0, W: 0},
    rules: 'Chinese area',
  }
}
