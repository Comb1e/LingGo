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
  it('parses strict JSON and fenced fallback output', () => {
    expect(parseJsonAction('{"action":"pass","comment":"done"}').action).toBe(
      'pass',
    )
    expect(
      parseJsonAction(
        '```json\n{"action":"play","coordinate":"D4","comment":"shape"}\n```',
      ),
    ).toMatchObject({
      action: 'play',
      coordinate: 'D4',
    })
  })

  it('rejects malformed action output', () =>
    expect(() => parseJsonAction('{"action":"dance"}')).toThrow('Invalid'))

  it('does not expose stored secrets', () => {
    const vault = new SecretVault()
    vault.set('x', 'super-secret')
    expect(JSON.stringify(vault)).not.toContain('super-secret')
  })

  it('builds a stateless complete position prompt', () => {
    const prompt = makePrompt({
      size: 9,
      komi: 7.5,
      board: emptyBoard(9),
      toMove: 'B',
      moves: [],
      captures: {B: 0, W: 0},
      rules: 'Chinese area',
    })
    expect(prompt).toContain('A B C D E F G H J')
    expect(prompt).toContain('To move: Black')
  })

  it.each([
    ['openai', '/proxy/openai/v1/responses'],
    ['anthropic', '/proxy/anthropic/v1/messages'],
    ['google', '/proxy/google/v1beta/models/test-model:generateContent'],
  ] satisfies Array<[ProviderKind, string]>)(
    'sends %s requests to its custom base URL',
    async (kind, expectedPath) => {
      let requestedUrl = ''
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          requestedUrl = String(input)
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
          supportsStructuredOutput: false,
        },
        {
          id: `profile-${kind}`,
          name: 'Test profile',
          connectionId: `custom-${kind}`,
          modelId: 'test-model',
          temperature: 0,
        },
        'test-key',
      )

      await expect(
        adapter.requestAction(emptySnapshot(), new AbortController().signal),
      ).rejects.toThrow()
      expect(new URL(requestedUrl).pathname).toBe(expectedPath)
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
