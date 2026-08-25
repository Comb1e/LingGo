import {describe, expect, it} from 'vitest'
import {kataGoMove, rootFromBlack, selectedMove} from './katago'

describe('KataGo protocol normalization', () => {
  const response = {
    id: 'x',
    rootInfo: {winrate: 0.7, scoreLead: 3.5, visits: 100},
    moveInfos: [{move: 'D4', visits: 50, winrate: 0.7, scoreLead: 3.5}],
  }

  it('keeps root values in the configured Black perspective', () => {
    const value = rootFromBlack(response)
    expect(value.blackWinRate).toBeCloseTo(0.7)
    expect(value.whiteWinRate).toBeCloseTo(0.3)
    expect(value.blackScoreLead).toBe(3.5)
  })

  it('converts board moves, pass, and selected candidates', () => {
    expect(kataGoMove({number: 1, color: 'B', action: 'play', point: [3, 5], captured: 0}, 9)).toBe('D4')
    expect(kataGoMove({number: 2, color: 'W', action: 'pass', captured: 0}, 9)).toBe('pass')
    expect(selectedMove(response)).toBe('D4')
    expect(selectedMove({...response, moveInfos: [{...response.moveInfos[0], move: 'pass'}]})).toBe('pass')
  })
})
