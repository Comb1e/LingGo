import {execFileSync} from 'node:child_process'
import {branchNameError} from '../src/shared/gitPolicy'

const branch =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.GITHUB_HEAD_REF ??
  execFileSync('git', ['branch', '--show-current'], {encoding: 'utf8'}).trim()
const error = branchNameError(branch)

if (error) {
  console.error(error)
  process.exitCode = 1
}
