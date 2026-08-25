import {afterEach, describe, expect, it, vi} from 'vitest'
import type {GameSnapshot, ProviderKind} from '../shared/types'
import {emptyBoard} from './go'
import {
  LlmPlayerAdapter,
  makePrompt,
  parseJsonAction,
  SecretVault,
} from './providers'

afterEach(() => vi.unstubAllGlobals())

describe('provider normalization', () => {
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
        captures: {B: 0, W: 0},
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
  })

  it('states when no playing style is configured', () => {
    expect(makePrompt(emptySnapshot())).toContain('2. PLAYING STYLE\n(none)')
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
      if (kind === 'openai') {
        expect(body.reasoning).toEqual({effort: 'medium', summary: 'detailed'})
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
