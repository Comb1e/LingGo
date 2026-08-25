import {describe, expect, it} from 'vitest'
import {normalizeReasoning} from './reasoning'

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
})
