import {describe, expect, it} from 'vitest'
import {
  isDeepSeekMove,
  normalizeReasoning,
  supportsDeepSeekReasoningControl,
} from './reasoning'

describe('reasoning formatting', () => {
  it('separates adjacent OpenAI bold reasoning summaries', () => {
    expect(
      normalizeReasoning(
        '**Analyzing lower-left liberties****Evaluating the joseki****Planning a 3-3 invasion**',
      ),
    ).toBe(
      'Analyzing lower-left liberties\n\nEvaluating the joseki\n\nPlanning a 3-3 invasion',
    )
  })

  it('places ordinary sentences in separate paragraphs', () => {
    expect(
      normalizeReasoning('First inspect the corner. Then defend the cut.'),
    ).toBe('First inspect the corner.\n\nThen defend the cut.')
  })

  it('identifies DeepSeek moves for provider-specific formatting', () => {
    expect(
      isDeepSeekMove({
        number: 1,
        color: 'B',
        action: 'play',
        coordinate: 'D4',
        captured: 0,
        model: 'deepseek-v4-pro',
        providerKind: 'deepseek',
      }),
    ).toBe(true)
  })

  it('identifies DeepSeek models with a reasoning toggle', () => {
    expect(supportsDeepSeekReasoningControl('deepseek-v4-flash')).toBe(true)
    expect(supportsDeepSeekReasoningControl(' DEEPSEEK-V4-PRO ')).toBe(true)
    expect(supportsDeepSeekReasoningControl('deepseek-chat')).toBe(false)
    expect(supportsDeepSeekReasoningControl('deepseek-reasoner')).toBe(false)
    expect(supportsDeepSeekReasoningControl('custom-model')).toBe(false)
  })
})
