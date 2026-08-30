import {describe, expect, it} from 'vitest'
import type {BenchmarkNotebookVersion} from '../shared/types'
import {notebookNoteChanges} from './notebookChanges'

describe('notebookNoteChanges', () => {
  it('reports only numbered notes changed by problem notebook updates', () => {
    const seed = '# Notes\n\n1. Read liberties.\n2. Preserve shape.'
    const versions = [
      version(
        1,
        'problem_notebook',
        '# Notes\n\n1. Read replies.\n2. Preserve shape.',
      ),
      version(
        2,
        'problem_notebook',
        '# Notes\n\n1. Read replies.\n2. Take the vital point.',
      ),
    ]

    expect(notebookNoteChanges(seed, versions)).toEqual([
      {
        version: 1,
        createdAt: '2026-08-30T12:00:01.000Z',
        notes: [
          {number: '1', before: 'Read liberties.', after: 'Read replies.'},
        ],
      },
      {
        version: 2,
        createdAt: '2026-08-30T12:00:02.000Z',
        notes: [
          {
            number: '2',
            before: 'Preserve shape.',
            after: 'Take the vital point.',
          },
        ],
      },
    ])
  })

  it('uses non-problem versions as the baseline without displaying them', () => {
    const versions = [
      version(1, 'initializing_notebook', '1. Initial lesson.'),
      version(2, 'problem_notebook', '1. Refined lesson.'),
    ]

    expect(notebookNoteChanges('', versions)[0].notes).toEqual([
      {number: '1', before: 'Initial lesson.', after: 'Refined lesson.'},
    ])
  })
})

function version(
  versionNumber: number,
  sourcePhase: BenchmarkNotebookVersion['sourcePhase'],
  content: string,
): BenchmarkNotebookVersion {
  return {
    runId: 'run',
    version: versionNumber,
    sourcePhase,
    content,
    digest: '',
    characterCount: content.length,
    byteCount: content.length,
    estimatedTokens: 1,
    createdAt: `2026-08-30T12:00:0${versionNumber}.000Z`,
  }
}
