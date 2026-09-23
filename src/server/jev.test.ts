import {describe, expect, it} from 'vitest'
import type {
  Questions,
  SystemOneRequest,
  SystemOneResult,
} from '@typesafe-ai/sdk'
import {APIError, APITimeoutError} from '@typesafe-ai/sdk'
import {makeSnapshot} from './go'
import {balancedJevGroups, JevPlayerAdapter, type JevClient} from './jev'

describe('Jev move selection', () => {
  it.each([
    [254, [254]],
    [255, [255]],
    [256, [128, 128]],
  ])('groups %i options without dropping any', (count, expectedSizes) => {
    const values = Array.from({length: count}, (_, index) => index)
    const groups = balancedJevGroups(values)

    expect(groups.map(({length}) => length)).toEqual(expectedSizes)
    expect(groups.flat().sort((a, b) => a - b)).toEqual(values)
  })

  it('selects one legal 9x9 action and records factual confidence', async () => {
    const requests: SystemOneRequest[] = []
    const client = fakeClient((request) => {
      requests.push(request)
      return resultFor(request, () => 'D4', 0.62, 7, 3)
    })
    const adapter = jevAdapter(client)

    const result = await adapter.requestAction(
      makeSnapshot(9, 7.5, []),
      new AbortController().signal,
    )

    expect(requests).toHaveLength(1)
    expect(Object.keys(choiceCriteria(requests[0], 'move'))).toHaveLength(83)
    expect(requests[0].state).toMatchObject({
      board_size: 9,
      player_to_move: 'Black',
      playing_style: 'Prefer influence.',
    })
    expect(result).toMatchObject({
      action: {
        action: 'play',
        coordinate: 'D4',
        comment: 'Jev selected D4 with 62% confidence.',
      },
      inputTokens: 7,
      outputTokens: 3,
      model: 'jev-1.13.0',
      providerKind: 'typesafe',
    })
    expect(result).not.toHaveProperty('reasoning')
  })

  it('uses group winners in a final round on an empty 19x19 board', async () => {
    const requests: SystemOneRequest[] = []
    const client = fakeClient((request) => {
      requests.push(request)
      if ('final_move' in request.questions)
        return resultFor(request, () => 'PASS', 0.8, 5, 2)
      return resultFor(
        request,
        (_id, question) =>
          'PASS' in question.criteria
            ? 'PASS'
            : Object.keys(question.criteria)[0],
        0.4,
        11,
        4,
      )
    })
    const adapter = jevAdapter(client)

    const result = await adapter.requestAction(
      makeSnapshot(19, 7.5, []),
      new AbortController().signal,
    )

    expect(requests).toHaveLength(2)
    const firstQuestions = Object.values(requests[0].questions)
    expect(firstQuestions).toHaveLength(2)
    expect(
      firstQuestions.map((question) => {
        if (question.type !== 'choice') throw new Error('Expected Choice')
        return Object.keys(question.criteria).length
      }),
    ).toEqual([182, 181])
    expect(Object.keys(choiceCriteria(requests[1], 'final_move'))).toHaveLength(
      2,
    )
    expect(result.action).toEqual({
      action: 'pass',
      comment: 'Jev selected PASS with 80% confidence.',
    })
    expect(result.inputTokens).toBe(16)
    expect(result.outputTokens).toBe(6)
  })

  it('rejects a selected label that was not offered', async () => {
    const adapter = jevAdapter(
      fakeClient((request) => resultFor(request, () => 'Z99', 1, 1, 1)),
    )

    await expect(
      adapter.requestAction(
        makeSnapshot(9, 7.5, []),
        new AbortController().signal,
      ),
    ).rejects.toThrow('unknown action Z99')
  })

  it('selects the sole legal action without an invalid one-option request', async () => {
    let calls = 0
    const adapter = jevAdapter(
      fakeClient(() => {
        calls += 1
        throw new Error('client should not be called')
      }),
    )
    const snapshot = makeSnapshot(9, 7.5, [
      {number: 1, color: 'B', action: 'pass', captured: 0},
      {number: 2, color: 'W', action: 'play', point: [0, 0], captured: 0},
      {number: 3, color: 'B', action: 'pass', captured: 0},
      {number: 4, color: 'W', action: 'play', point: [1, 0], captured: 0},
    ])
    snapshot.board = Array.from({length: 9}, () => Array(9).fill(1))

    const result = await adapter.requestAction(
      snapshot,
      new AbortController().signal,
    )

    expect(calls).toBe(0)
    expect(result.action).toEqual({
      action: 'resign',
      comment: 'Jev selected RESIGN with 100% confidence.',
    })
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
  })

  it('forwards cancellation to the TypeSafe request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('test abort'))
    const client = fakeClient(() => {
      throw new Error('client should not be called')
    })

    await expect(
      jevAdapter(client).requestAction(
        makeSnapshot(9, 7.5, []),
        controller.signal,
      ),
    ).rejects.toThrow('test abort')
  })

  it.each([429, 500])(
    'normalizes retryable TypeSafe HTTP %i errors',
    async (status) => {
      const error = new APIError(
        status,
        {error: 'temporary'},
        new Headers({'retry-after': '1'}),
      )
      const adapter = jevAdapter(
        fakeClient(() => {
          throw error
        }),
      )

      await expect(
        adapter.requestAction(
          makeSnapshot(9, 7.5, []),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        statusCode: status,
        isRetryable: true,
        responseHeaders: {'retry-after': '1'},
      })
    },
  )

  it('preserves TypeSafe timeout failures for LingGo retry classification', async () => {
    const adapter = jevAdapter(
      fakeClient(() => {
        throw new APITimeoutError(50)
      }),
    )

    await expect(
      adapter.requestAction(
        makeSnapshot(9, 7.5, []),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(APITimeoutError)
  })
})

function jevAdapter(client: JevClient) {
  return new JevPlayerAdapter(
    {
      id: 'typesafe',
      name: 'TypeSafe AI',
      kind: 'typesafe',
      supportsStructuredOutput: false,
    },
    {
      id: 'jev-profile',
      name: 'Jev',
      connectionId: 'typesafe',
      modelId: 'jev-latest',
      temperature: 0.7,
      stylePrompt: 'Prefer influence.',
    },
    'test-key',
    30_000,
    client,
  )
}

function fakeClient(
  respond: (request: SystemOneRequest) => SystemOneResult<Questions>,
): JevClient {
  return {
    systemOne(request) {
      return Promise.resolve(respond(request))
    },
  }
}

function choiceCriteria(request: SystemOneRequest, id: string) {
  const question = request.questions[id]
  if (question?.type !== 'choice') throw new Error(`Expected Choice ${id}`)
  return question.criteria
}

function resultFor(
  request: SystemOneRequest,
  selected: (
    id: string,
    question: Extract<Questions[string], {type: 'choice'}>,
  ) => string,
  confidence: number,
  inputTokens: number,
  outputTokens: number,
): SystemOneResult<Questions> {
  return {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, rawQuestion]) => {
        if (rawQuestion.type !== 'choice') throw new Error('Expected Choice')
        const choice = selected(id, rawQuestion)
        return [
          id,
          {
            type: 'choice',
            choice,
            confidence,
            probabilities: Object.fromEntries(
              Object.keys(rawQuestion.criteria).map((label) => [
                label,
                label === choice ? 1 : 0,
              ]),
            ),
          },
        ]
      }),
    ),
    usage: {input_tokens: inputTokens, output_tokens: outputTokens},
  }
}
