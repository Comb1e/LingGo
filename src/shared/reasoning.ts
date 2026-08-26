import type {Move} from './types'

const sentenceSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'sentence',
})

export function normalizeReasoning(value: string): string {
  const plainText = value
    .trim()
    .replace(/\*\*([\s\S]*?)\*\*/g, (_match, content: string) => {
      return `${content.trim()}\n`
    })
    .replace(/\*\*/g, '')

  return plainText
    .split(/\n+/)
    .flatMap((paragraph) =>
      [...sentenceSegmenter.segment(paragraph)]
        .map(({segment}) => segment.trim())
        .filter(Boolean),
    )
    .join('\n\n')
}

export function isDeepSeekMove(move: Move) {
  return (
    move.providerKind === 'deepseek' ||
    (!move.providerKind && move.model?.toLowerCase().startsWith('deepseek'))
  )
}
