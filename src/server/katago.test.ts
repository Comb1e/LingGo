import {describe, expect, it} from 'vitest'
import {
  kataGoMove,
  reviewCandidates,
  rootFromBlack,
  selectedMove,
} from './katago'

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
    expect(
      kataGoMove(
        {number: 1, color: 'B', action: 'play', point: [3, 5], captured: 0},
        9,
      ),
    ).toBe('D4')
    expect(
      kataGoMove({number: 2, color: 'W', action: 'pass', captured: 0}, 9),
    ).toBe('pass')
    expect(selectedMove(response)).toBe('D4')
    expect(
      selectedMove({
        ...response,
        moveInfos: [{...response.moveInfos[0], move: 'pass'}],
      }),
    ).toBe('pass')
  })

  it('returns the first five board candidates from the player perspective', () => {
    const candidates = reviewCandidates(
      {
        ...response,
        moveInfos: [
          {move: 'pass', visits: 30, winrate: 0.7, scoreLead: 3},
          {move: 'bad', visits: 29, winrate: 0.69, scoreLead: 2},
          ...['A1', 'B2', 'C3', 'D4', 'E5', 'F6'].map((move, index) => ({
            move,
            visits: 28 - index,
            winrate: 0.7 - index / 100,
            scoreLead: 1,
          })),
        ],
      },
      9,
      'W',
    )

    expect(candidates).toHaveLength(5)
    expect(candidates.map(({move}) => move)).toEqual([
      'A1',
      'B2',
      'C3',
      'D4',
      'E5',
    ])
    expect(candidates[0]).toMatchObject({point: [0, 8], visits: 28})
    expect(candidates[0].winRate).toBeCloseTo(0.3)
  })
})
