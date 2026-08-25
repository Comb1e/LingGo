import {describe, expect, it} from 'vitest'
import {kataGoMove, rootFromBlack, selectedMove} from './katago'

describe('KataGo protocol normalization', () => {
  const response = {
    id: 'x',
    rootInfo: {winrate: 0.7, scoreLead: 3.5, visits: 100},
    moveInfos: [{move: 'D4', visits: 50, winrate: 0.7, scoreLead: 3.5}],
  }

  it('converts root values from the side to move into Black and White perspectives', () => {
    const black = rootFromBlack(response, 'B')
    const white = rootFromBlack(response, 'W')
    expect(black.blackWinRate).toBeCloseTo(0.7)
    expect(black.whiteWinRate).toBeCloseTo(0.3)
    expect(black.blackScoreLead).toBe(3.5)
    expect(white.blackWinRate).toBeCloseTo(0.3)
    expect(white.whiteWinRate).toBeCloseTo(0.7)
    expect(white.blackScoreLead).toBe(-3.5)
  })

  it('converts board moves, pass, and selected candidates', () => {
    expect(kataGoMove({number: 1, color: 'B', action: 'play', point: [3, 5], captured: 0}, 9)).toBe('D4')
    expect(kataGoMove({number: 2, color: 'W', action: 'pass', captured: 0}, 9)).toBe('pass')
    expect(selectedMove(response)).toBe('D4')
    expect(selectedMove({...response, moveInfos: [{...response.moveInfos[0], move: 'pass'}]})).toBe('pass')
  })
})
