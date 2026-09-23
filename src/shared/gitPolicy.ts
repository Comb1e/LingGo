import policy from '../../config/engineering-policy.json'

export interface GitRules {
  commitSubjectPattern: string
  commitSubjectMaxLength: number
  branchPattern: string
  protectedBranches: string[]
}

const configuredRules = policy.gitRules as GitRules

export function commitSubjectError(
  subject: string,
  rules: GitRules = configuredRules,
) {
  if (subject.length > rules.commitSubjectMaxLength)
    return `Commit subject must be at most ${rules.commitSubjectMaxLength} characters.`
  if (!new RegExp(rules.commitSubjectPattern).test(subject))
    return 'Commit subject must use Conventional Commits: <type>(<scope>): <lowercase imperative subject>.'
  return undefined
}

export function branchNameError(
  branch: string,
  rules: GitRules = configuredRules,
) {
  if (rules.protectedBranches.includes(branch))
    return `Commit work on a topic branch; ${branch} is protected.`
  if (!new RegExp(rules.branchPattern).test(branch))
    return 'Branch name must use <type>/<short-description>, for example feature/user-login.'
  return undefined
}
