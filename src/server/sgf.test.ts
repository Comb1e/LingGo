import {describe, expect, it} from 'vitest'
import {exportSgf, importSgf} from './sgf'

describe('SGF records', () => {
  it('imports the first main line with warnings and round trips comments', () => {
    const source =
      '(;FF[4]SZ[9]KM[7.5]PB[A]PW[B];B[dd]C[hello](;W[ee])(;W[ff]))(;FF[4]SZ[19])'
    const record = importSgf(source)
    expect(record.size).toBe(9)
    expect(record.moves).toHaveLength(2)
    expect(record.warnings.join(' ')).toContain('additional')
    expect(record.warnings.join(' ')).toContain('variation')
    const again = importSgf(
      exportSgf({
        ...record,
        black: {name: record.blackName},
        white: {name: record.whiteName},
      }),
    )
    expect(again.moves[0].comment).toBe('hello')
    expect(again.moves[0].coordinate).toBe('D6')
  })

  it('retains result and escaping', () => {
    const record = importSgf(
      '( ;FF[4]SZ[19]KM[7.5]PB[A]PW[B]RE[B+R];B[pd]C[a\\]b])',
    )
    expect(record.result).toBe('B+R')
    expect(record.moves[0].comment).toBe('a]b')
  })
})
