import {afterEach, describe, expect, it, vi} from 'vitest'
import type {GameSnapshot, ProviderKind} from '../shared/types'
import {emptyBoard} from './go'
import {
  FakePlayerAdapter,
  LlmPlayerAdapter,
  type LlmTurnRequest,
  MalformedModelOutputError,
  isOpenAiReasoningModel,
  makePrompt,
  parseJsonAction,
  parseJsonActionResult,
  type PlayerAdapter,
  requestLlm,
  SecretVault,
  supportsProviderContinuation,
} from './providers'

afterEach(() => vi.unstubAllGlobals())

describe('provider normalization', () => {
  it('preserves conversation context through the text fallback', async () => {
    let received = ''
    const adapter = {
      async requestAction() {
        throw new Error('Action fallback should not be used')
      },
      async requestText(prompt: string) {
        received = prompt
        return {
          text: '# Updated notebook',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
        }
      },
    } satisfies PlayerAdapter
    const snapshot = {
      size: 9 as const,
      board: emptyBoard(9),
      toMove: 'B' as const,
      moves: [],
      captures: {B: 0, W: 0},
      komi: 7.5,
      rules: 'Chinese',
    }

    await requestLlm(
      adapter,
      {
        type: 'turn',
        request: {
          kind: 'reflection',
          content: 'Update the notebook.',
          transcript: [
            {role: 'user', content: 'Initial board and notebook'},
            {role: 'assistant', content: '{"move":"A9","reason":"Test"}'},
          ],
          cacheKey: 'test-context',
          snapshot,
          output: 'notebook',
        },
      },
      new AbortController().signal,
    )

    expect(received).toContain('USER: Initial board and notebook')
    expect(received).toContain('ASSISTANT: {"move":"A9","reason":"Test"}')
    expect(received).toContain('USER: Update the notebook.')
  })

  it('preserves conversation context through the action fallback', async () => {
    let received = ''
    const adapter = {
      async requestAction(
        _snapshot: GameSnapshot,
        _signal: AbortSignal,
        prompt?: string,
      ) {
        received = prompt ?? ''
        return {
          action: {action: 'pass' as const, comment: 'Done.'},
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: 'test-model',
          retries: 0,
        }
      },
    } satisfies PlayerAdapter
    const snapshot = {
      size: 9 as const,
      board: emptyBoard(9),
      toMove: 'B' as const,
      moves: [],
      captures: {B: 0, W: 0},
      komi: 7.5,
      rules: 'Chinese',
    }

    await requestLlm(
      adapter,
      {
        type: 'turn',
        request: {
          kind: 'continuation',
          content: 'Choose the next move.',
          transcript: [
            {role: 'user', content: 'Initial board'},
            {role: 'assistant', content: '{"move":"A9","reason":"Test"}'},
          ],
          cacheKey: 'test-action-context',
          snapshot,
          output: 'action',
        },
      },
      new AbortController().signal,
    )

    expect(received).toContain('USER: Initial board')
    expect(received).toContain('ASSISTANT: {"move":"A9","reason":"Test"}')
    expect(received).toContain('USER: Choose the next move.')
  })

  it('varies fake life-and-death notebook patch notes by problem context', async () => {
    const adapter = new FakePlayerAdapter()
    const snapshot = {
      size: 9 as const,
      board: emptyBoard(9),
      toMove: 'B' as const,
      moves: [],
      captures: {B: 0, W: 0},
      komi: 7.5,
      rules: 'Chinese',
    }
    const transcript = [
      {
        role: 'user' as const,
        content:
          'SELF-WRITTEN SKILLS\n1. First lesson.\n2. Second lesson.\nCURRENT PROBLEM',
      },
    ]
    const request = (content: string): LlmTurnRequest => ({
      kind: 'continuation',
      content: `NOTEBOOK PATCH OUTPUT FORMAT\n${content}`,
      transcript,
      cacheKey: 'test',
      snapshot,
      output: 'notebook',
    })
    const first = await adapter.requestTurn(
      request('Problem A'),
      new AbortController().signal,
    )
    const second = await adapter.requestTurn(
      request('Problem B'),
      new AbortController().signal,
    )

    expect(first.text).not.toBe(second.text)
    const firstNumber = Object.keys(JSON.parse(first.text))[0]
    const secondNumber = Object.keys(JSON.parse(second.text))[0]
    expect(['1', '2']).toContain(firstNumber)
    expect(['1', '2']).toContain(secondNumber)
    expect(firstNumber).not.toBe(secondNumber)
  })

  it('identifies OpenAI models that do not support temperature', () => {
    expect(isOpenAiReasoningModel('gpt-5.6-luna')).toBe(true)
    expect(isOpenAiReasoningModel('gpt-5.6-sol')).toBe(true)
    expect(isOpenAiReasoningModel('gpt-5')).toBe(true)
    expect(isOpenAiReasoningModel('o4-mini')).toBe(true)
    expect(isOpenAiReasoningModel('gpt-5-chat-latest')).toBe(false)
    expect(isOpenAiReasoningModel('gpt-4.1')).toBe(false)
    expect(isOpenAiReasoningModel('ft:gpt-5:custom')).toBe(false)
  })

  it('uses managed continuation only for the native OpenAI endpoint', () => {
    expect(supportsProviderContinuation({kind: 'openai'})).toBe(true)
    expect(
      supportsProviderContinuation({
        kind: 'openai',
        baseUrl: 'https://proxy.example.test/v1',
      }),
    ).toBe(false)
    expect(supportsProviderContinuation({kind: 'compatible'})).toBe(false)
  })

  it('parses board coordinates, pass, resign, and fenced fallback output', () => {
    expect(parseJsonAction('{"move":"pass","reason":"done"}', 9)).toEqual({
      action: 'pass',
      comment: 'done',
    })
    expect(parseJsonAction('{"move":"RESIGN","reason":"concede"}', 9)).toEqual({
      action: 'resign',
      comment: 'concede',
    })
    expect(
      parseJsonAction('```json\n{"move":"d4","reason":"shape"}\n```', 9),
    ).toMatchObject({
      action: 'play',
      coordinate: 'D4',
      comment: 'shape',
    })
  })

  it('rejects malformed action output', () =>
    expect(() => parseJsonAction('{"move":1,"reason":"bad"}', 9)).toThrow(
      'Invalid',
    ))

  it('rejects labeled coordinates outside the board', () =>
    expect(() =>
      parseJsonAction('{"move":"T1","reason":"outside"}', 9),
    ).toThrow('outside 9x9 board'))

  it.each(['', '{bad', '{"move":"T1","reason":"outside"}'])(
    'retains rejected response content for %j',
    (content) => {
      try {
        parseJsonAction(content, 9)
        throw new Error('Expected parsing to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(MalformedModelOutputError)
        expect((error as MalformedModelOutputError).responseContent).toBe(
          content,
        )
      }
    },
  )

  it('rejects the removed in-game reflection response field', () => {
    expect(() =>
      parseJsonActionResult(
        JSON.stringify({
          move: 'pass',
          reason: 'done',
          in_game_reflections: [],
        }),
        9,
      ),
    ).toThrow('Invalid')
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
      'LEGAL MOVE: A play is legal only when it places one stone on an empty intersection',
    )
    expect(prompt).toContain(
      '2. PLAYING STYLE\nPrefer influence over territory.',
    )
    expect(prompt).toContain('3. INSTRUCTION')
    expect(prompt).toContain('4. RESPONSE SCHEMA')
    expect(prompt).toContain(
      '{"move":"D4","reason":"brief reason for this move"}',
    )
    expect(prompt).toContain('Columns use letters and skip I')
    expect(prompt).toContain('{"move":"pass","reason":"..."}')
    expect(prompt).toContain('{"move":"resign","reason":"..."}')
    expect(prompt).toContain('each player may pass at most twice in one game')
    expect(prompt).toContain('5. CURRENT POSITION')
    expect(prompt).toContain('A B C D E F G H J')
    expect(prompt).toContain('9 X . . . . . . . .')
    expect(prompt).toContain('8 . O . . . . . . .')
    expect(prompt).toContain('To move: Black')
    expect(prompt).toContain('Captures: Black 3, White 2.')
    expect(prompt).toContain('Passes: Black 0/2, White 0/2.')
    expect(prompt).not.toContain('From your perspective')
  })

  it('includes the intersections where stones were captured', () => {
    const snapshot = emptySnapshot()
    snapshot.moves = [
      {
        number: 1,
        color: 'B',
        action: 'play',
        point: [2, 2],
        coordinate: 'C7',
        comment: '',
        captured: 2,
        capturedPoints: [
          [1, 1],
          [1, 2],
        ],
      },
    ]

    expect(makePrompt(snapshot)).toContain('captured 2 at B8, B7')
  })

  it('omits stored comments and reasoning from ordinary move history', () => {
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
    expect(prompt).toContain('1. B C7')
    expect(prompt).toContain('2. W D6')
    expect(prompt).toContain('3. B pass')
    expect(prompt).not.toContain('Build outward.')
    expect(prompt).not.toContain('Opponent comment')
    expect(prompt).not.toContain('I compared both corners.')
    expect(prompt).not.toContain('your reasoning:')
    expect(prompt).not.toContain('Opponent private reasoning')
    expect(prompt).toContain(
      '{"move":"D4","reason":"brief reason for this move"}',
    )
  })

  it('states when no playing style is configured', () => {
    expect(makePrompt(emptySnapshot())).toContain('2. PLAYING STYLE\n(none)')
  })

  it('includes KataGo win rates in ordinary prompts only when provided', () => {
    const snapshot = emptySnapshot()
    expect(makePrompt(snapshot)).not.toContain('KATAGO WIN-RATE HISTORY')
    snapshot.kataGoAnalysis = 'Turn 0: your win rate 50.00%; opponent 50.00%'
    const prompt = makePrompt(snapshot)
    expect(prompt).toContain(
      '6. KATAGO WIN-RATE HISTORY\nTurn 0: your win rate 50.00%; opponent 50.00%',
    )
    expect(prompt).toContain(
      'You may use the supplied KataGo win-rate history.',
    )
    expect(prompt).not.toContain('Do not use external analysis.')
  })

  it.each([
    ['openai', '/proxy/openai/v1/responses'],
    ['anthropic', '/proxy/anthropic/v1/messages'],
    ['google', '/proxy/google/v1beta/models/test-model:streamGenerateContent'],
    ['deepseek', '/proxy/deepseek/v1/chat/completions'],
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
          modelId:
            kind === 'openai'
              ? 'gpt-5.6-sol'
              : kind === 'deepseek'
                ? 'deepseek-v4-pro'
                : 'test-model',
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
        expect(body.stream).toBe(true)
        expect(body.reasoning).toEqual({effort: 'high', summary: 'detailed'})
        expect(body).not.toHaveProperty('temperature')
      } else if (kind === 'anthropic') {
        expect(body.stream).toBe(true)
        expect(body.thinking).toBeTruthy()
      } else if (kind === 'google') {
        expect(body.generationConfig.thinkingConfig).toMatchObject({
          includeThoughts: true,
        })
      } else {
        expect(body).not.toHaveProperty('temperature')
        expect(body.thinking).toEqual({type: 'enabled'})
        expect(body.reasoning_effort).toBe('high')
        expect(body.stream).toBe(true)
        expect(body.stream_options).toEqual({include_usage: true})
      }
    },
  )

  it.each([
    ['openai', 'max_output_tokens'],
    ['anthropic', 'max_tokens'],
    ['google', 'generationConfig'],
    ['deepseek', 'max_tokens'],
    ['compatible', 'max_tokens'],
  ] satisfies Array<[ProviderKind, string]>)(
    'limits %s text generation output tokens',
    async (kind, outputField) => {
      let requestBody = ''
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          requestBody = String(init?.body ?? '')
          return new Response('{"error":{"message":"test stop"}}', {
            status: 500,
            headers: {'content-type': 'application/json'},
          })
        }),
      )
      const adapter = new LlmPlayerAdapter(
        {
          id: `limited-${kind}`,
          name: `Limited ${kind}`,
          kind,
          baseUrl: `https://models.example.test/${kind}/v1`,
          supportsStructuredOutput: true,
        },
        {
          id: `limited-profile-${kind}`,
          name: 'Limited profile',
          connectionId: `limited-${kind}`,
          modelId: 'test-model',
          temperature: 0,
        },
        'test-key',
      )

      await expect(
        adapter.requestText!(
          'Initialize a notebook.',
          new AbortController().signal,
          'linggo:test-notebook',
          1_234,
        ),
      ).rejects.toThrow()
      const body = JSON.parse(requestBody)
      expect(
        outputField === 'generationConfig'
          ? body.generationConfig.maxOutputTokens
          : body[outputField],
      ).toBe(1_234)
    },
  )

  it('chains stored OpenAI text responses without resending the notebook', async () => {
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body ?? '')
        return new Response('{"error":{"message":"test stop"}}', {
          status: 500,
          headers: {'content-type': 'application/json'},
        })
      }),
    )
    const adapter = openAiAdapter()
    await expect(
      adapter.requestTextTurn!(
        {
          content: 'Compress the notebook in your previous response.',
          transcript: [
            {role: 'user', content: 'STATIC INITIAL RULES'},
            {role: 'assistant', content: 'OVERSIZED NOTEBOOK'},
          ],
          previousResponseId: 'resp_previous',
          cacheKey: 'linggo:test-notebook:compress',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow()

    const body = JSON.parse(requestBody)
    expect(body.store).toBe(true)
    expect(body.previous_response_id).toBe('resp_previous')
    expect(body.prompt_cache_key).toBe('linggo:test-notebook:compress')
    expect(requestBody).toContain('Compress the notebook')
    expect(requestBody).not.toContain('STATIC INITIAL RULES')
    expect(requestBody).not.toContain('OVERSIZED NOTEBOOK')
  })

  it('resends visible context to custom OpenAI endpoints', async () => {
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body ?? '')
        return new Response('{"error":{"message":"test stop"}}', {
          status: 500,
          headers: {'content-type': 'application/json'},
        })
      }),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'custom-openai-context',
        name: 'Custom OpenAI context',
        kind: 'openai',
        baseUrl: 'https://proxy.example.test/v1',
        supportsStructuredOutput: false,
      },
      {
        id: 'custom-openai-profile',
        name: 'Custom OpenAI profile',
        connectionId: 'custom-openai-context',
        modelId: 'gpt-5.6-sol',
        temperature: 0,
      },
      'test-key',
    )

    await expect(
      adapter.requestTextTurn!(
        {
          content: 'Compress the notebook.',
          transcript: [
            {role: 'user', content: 'STATIC INITIAL RULES'},
            {role: 'assistant', content: 'OVERSIZED NOTEBOOK'},
          ],
          previousResponseId: 'resp_previous',
          cacheKey: 'linggo:test-custom-notebook:compress',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow()

    const body = JSON.parse(requestBody)
    expect(body.previous_response_id).toBeUndefined()
    expect(requestBody).toContain('STATIC INITIAL RULES')
    expect(requestBody).toContain('OVERSIZED NOTEBOOK')
    expect(requestBody).toContain('Compress the notebook')
  })

  it('orders visible transcript messages and applies Anthropic cache hints', async () => {
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body ?? '')
        return new Response('{"error":{"message":"test stop"}}', {
          status: 500,
          headers: {'content-type': 'application/json'},
        })
      }),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'anthropic-context',
        name: 'Anthropic context',
        kind: 'anthropic',
        baseUrl: 'https://models.example.test/v1',
        supportsStructuredOutput: false,
      },
      {
        id: 'anthropic-profile',
        name: 'Anthropic profile',
        connectionId: 'anthropic-context',
        modelId: 'test-model',
        temperature: 0,
      },
      'test-key',
    )
    await expect(
      adapter.requestTurn!(
        {
          kind: 'continuation',
          content: 'DELTA TURN',
          transcript: [
            {role: 'user', content: 'INITIAL TURN'},
            {role: 'assistant', content: 'VISIBLE RESPONSE'},
          ],
          cacheKey: 'linggo:test-game:B',
          snapshot: emptySnapshot(),
          output: 'action',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    const body = JSON.parse(requestBody)
    expect(
      body.messages.map((message: {role: string}) => message.role),
    ).toEqual(['user', 'assistant', 'user'])
    expect(requestBody.indexOf('INITIAL TURN')).toBeLessThan(
      requestBody.indexOf('VISIBLE RESPONSE'),
    )
    expect(requestBody.indexOf('VISIBLE RESPONSE')).toBeLessThan(
      requestBody.indexOf('DELTA TURN'),
    )
    expect(body.cache_control).toEqual({type: 'ephemeral'})
  })

  it('receives DeepSeek reasoning separately from response content', async () => {
    let requestedUrl = ''
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = String(input)
        requestBody = String(init?.body ?? '')
        const events = [
          'data: {"id":"chatcmpl-test","created":1,"model":"deepseek","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Compare the open corners."},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-test","created":1,"model":"deepseek","choices":[{"index":0,"delta":{"content":"{\\"move\\":\\"A9\\",\\"reason\\":\\"Take the corner.\\"}"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-test","created":1,"model":"deepseek","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n',
          'data: [DONE]\n\n',
        ].join('')
        const encoder = new TextEncoder()
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(events.slice(0, 73)))
            controller.enqueue(encoder.encode(events.slice(73, 251)))
            controller.enqueue(encoder.encode(events.slice(251)))
            controller.close()
          },
        })
        return new Response(body, {
          headers: {'content-type': 'text/event-stream'},
        })
      }),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'deepseek',
        supportsStructuredOutput: false,
      },
      {
        id: 'deepseek-profile',
        name: 'DeepSeek player',
        connectionId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        temperature: 0,
      },
      'test-key',
    )

    const result = await adapter.requestAction(
      emptySnapshot(),
      new AbortController().signal,
    )

    expect(result.action).toMatchObject({
      action: 'play',
      coordinate: 'A9',
      comment: 'Take the corner.',
    })
    expect(result.reasoning).toBe('Compare the open corners.')
    expect(result.providerKind).toBe('deepseek')
    expect(result.inputTokens).toBe(12)
    expect(result.outputTokens).toBe(8)
    expect(requestedUrl).toBe('https://api.deepseek.com/chat/completions')
    expect(JSON.parse(requestBody)).toMatchObject({
      model: 'deepseek-v4-pro',
      thinking: {type: 'enabled'},
      reasoning_effort: 'high',
      stream: true,
      stream_options: {include_usage: true},
    })
  })

  it('disables DeepSeek reasoning in the provider request body', async () => {
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body ?? '')
        return new Response('{"error":{"message":"test stop"}}', {status: 500})
      }),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'deepseek',
        supportsStructuredOutput: false,
      },
      {
        id: 'deepseek-profile',
        name: 'DeepSeek player',
        connectionId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        temperature: 0,
        reasoningEnabled: false,
        requestOptions: [
          {name: 'thinking', content: '{"type":"enabled"}'},
          {name: 'reasoning_effort', content: 'medium'},
        ],
      },
      'test-key',
    )

    await expect(
      adapter.requestAction(emptySnapshot(), new AbortController().signal),
    ).rejects.toThrow()

    const body = JSON.parse(requestBody)
    expect(body.thinking).toEqual({type: 'disabled'})
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('omits reasoning controls for unsupported DeepSeek models', async () => {
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body ?? '')
        return new Response('{"error":{"message":"test stop"}}', {status: 500})
      }),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'deepseek',
        supportsStructuredOutput: false,
      },
      {
        id: 'legacy-deepseek-profile',
        name: 'Legacy DeepSeek player',
        connectionId: 'deepseek',
        modelId: 'deepseek-chat',
        temperature: 0,
        reasoningEnabled: false,
      },
      'test-key',
    )

    await expect(
      adapter.requestAction(emptySnapshot(), new AbortController().signal),
    ).rejects.toThrow()

    const body = JSON.parse(requestBody)
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('applies opt-in DeepSeek-style reasoning control to compatible models', async () => {
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body ?? '')
        return new Response('{"error":{"message":"test stop"}}', {status: 500})
      }),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'compatible',
        name: 'Compatible',
        kind: 'compatible',
        baseUrl: 'https://models.example.test/v1',
        supportsStructuredOutput: false,
      },
      {
        id: 'compatible-profile',
        name: 'Compatible player',
        connectionId: 'compatible',
        modelId: 'qwen3',
        temperature: 0,
        reasoningEnabled: false,
        reasoningControl: 'extra_body',
      },
      'test-key',
    )

    await expect(
      adapter.requestAction(emptySnapshot(), new AbortController().signal),
    ).rejects.toThrow()

    const body = JSON.parse(requestBody)
    expect(body.thinking).toEqual({type: 'disabled'})
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('does not add extra-body reasoning controls in automatic mode', async () => {
    let requestBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = String(init?.body ?? '')
        return new Response('{"error":{"message":"test stop"}}', {status: 500})
      }),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'compatible-auto',
        name: 'Compatible',
        kind: 'compatible',
        baseUrl: 'https://models.example.test/v1',
        supportsStructuredOutput: false,
      },
      {
        id: 'compatible-auto-profile',
        name: 'Compatible player',
        connectionId: 'compatible-auto',
        modelId: 'qwen3',
        temperature: 0,
      },
      'test-key',
    )

    await expect(
      adapter.requestAction(emptySnapshot(), new AbortController().signal),
    ).rejects.toThrow()

    const body = JSON.parse(requestBody)
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('aborts a DeepSeek request that does not produce a first token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            const rejectWithAbort = () => reject(signal?.reason)
            if (signal?.aborted) rejectWithAbort()
            else
              signal?.addEventListener('abort', rejectWithAbort, {once: true})
          }),
      ),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'timeout-deepseek',
        name: 'DeepSeek',
        kind: 'deepseek',
        supportsStructuredOutput: false,
      },
      {
        id: 'timeout-deepseek-profile',
        name: 'DeepSeek timeout profile',
        connectionId: 'timeout-deepseek',
        modelId: 'deepseek-v4-pro',
        temperature: 0,
      },
      'test-key',
      1_000,
      25,
    )

    await expect(
      adapter.requestAction(emptySnapshot(), new AbortController().signal),
    ).rejects.toThrow('First token timeout of 25ms exceeded')
  })

  it('aborts a provider request that does not produce a first token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            const rejectWithAbort = () => reject(signal?.reason)
            if (signal?.aborted) rejectWithAbort()
            else
              signal?.addEventListener('abort', rejectWithAbort, {once: true})
          }),
      ),
    )
    const adapter = new LlmPlayerAdapter(
      {
        id: 'timeout-openai',
        name: 'Timeout OpenAI',
        kind: 'openai',
        supportsStructuredOutput: true,
      },
      {
        id: 'timeout-profile',
        name: 'Timeout profile',
        connectionId: 'timeout-openai',
        modelId: 'gpt-5.6-sol',
        temperature: 0,
      },
      'test-key',
      1_000,
      25,
    )

    await expect(
      adapter.requestAction(emptySnapshot(), new AbortController().signal),
    ).rejects.toThrow(/first token timeout/i)
  })
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

function openAiAdapter() {
  return new LlmPlayerAdapter(
    {
      id: 'openai-context',
      name: 'OpenAI context',
      kind: 'openai',
      supportsStructuredOutput: false,
    },
    {
      id: 'openai-profile',
      name: 'OpenAI profile',
      connectionId: 'openai-context',
      modelId: 'gpt-5.6-sol',
      temperature: 0,
    },
    'test-key',
  )
}
