import type {BenchmarkNotebookVersion} from '../shared/types'

export interface NotebookNoteChange {
  version: number
  createdAt: string
  notes: Array<{
    number: string
    before?: string
    after?: string
  }>
}

export function notebookNoteChanges(
  seed: string,
  versions: BenchmarkNotebookVersion[],
): NotebookNoteChange[] {
  let prior = seed
  const changes: NotebookNoteChange[] = []
  for (const version of versions) {
    if (version.sourcePhase === 'problem_notebook') {
      const before = numberedNotes(prior)
      const after = numberedNotes(version.content)
      const numbers = new Set([...before.keys(), ...after.keys()])
      const notes = [...numbers]
        .filter((number) => before.get(number) !== after.get(number))
        .sort((left, right) => Number(left) - Number(right))
        .map((number) => ({
          number,
          before: before.get(number),
          after: after.get(number),
        }))
      if (notes.length)
        changes.push({
          version: version.version,
          createdAt: version.createdAt,
          notes,
        })
    }
    prior = version.content
  }
  return changes
}

function numberedNotes(content: string) {
  const notes = new Map<string, string>()
  for (const line of content.replace(/\r/g, '').split('\n')) {
    const match = /^\s*([1-9]\d*)\.\s+(.+?)\s*$/.exec(line)
    if (match) notes.set(match[1], match[2])
  }
  return notes
}
