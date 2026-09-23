import {readFileSync} from 'node:fs'
import {commitSubjectError} from '../src/shared/gitPolicy'

const subject = readFileSync(process.argv[2], 'utf8').split('\n')[0].trim()
const error = commitSubjectError(subject)

if (error) {
  console.error(error)
  process.exitCode = 1
}
