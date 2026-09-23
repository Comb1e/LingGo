import {describe, expect, it} from 'vitest'
import policy from '../../config/engineering-policy.json'
import {branchNameError, commitSubjectError} from './gitPolicy'

describe('Git policy', () => {
  it.each([
    'feat(game): add scoring controls',
    'fix!: remove legacy endpoint',
    'docs: explain architecture',
  ])('accepts Conventional Commit subject %s', (subject) => {
    expect(commitSubjectError(subject)).toBeUndefined()
  })

  it.each([
    'fix benchmark move retries',
    'Fix: handle retries',
    'fix: handle retries.',
    'fix(scope) handle retries',
  ])('rejects nonconforming commit subject %s', (subject) => {
    expect(commitSubjectError(subject)).toBeDefined()
  })

  it('enforces the commit subject length boundary', () => {
    const maximum = `fix: ${'a'.repeat(policy.gitRules.commitSubjectMaxLength - 5)}`
    expect(maximum).toHaveLength(policy.gitRules.commitSubjectMaxLength)
    expect(commitSubjectError(maximum)).toBeUndefined()
    expect(commitSubjectError(`${maximum}a`)).toContain('at most')
  })

  it.each(['feature/user-login', 'fix/order-total', 'chore/align-policy'])(
    'accepts topic branch %s',
    (branch) => {
      expect(branchNameError(branch)).toBeUndefined()
    },
  )

  it.each(['main', 'feature/UserLogin', 'topic/nope', 'fix/order_total'])(
    'rejects protected or nonconforming branch %s',
    (branch) => {
      expect(branchNameError(branch)).toBeDefined()
    },
  )
})
