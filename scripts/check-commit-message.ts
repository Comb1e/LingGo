import {readFileSync} from 'node:fs'

const subject = readFileSync(process.argv[2], 'utf8').split('\n')[0].trim()
const merge = /^(Merge|Revert) /.test(subject)
const valid =
  merge ||
  (subject.length >= 3 &&
    subject.length <= 72 &&
    /^[a-z][a-z0-9]*(?:[ :/-][a-z0-9][a-z0-9 :/.-]*)?$/.test(subject) &&
    !subject.endsWith('.') &&
    !/^(wip|fixup!|squash!)/i.test(subject))

if (!valid) {
  console.error(
    'Commit subject must be 3-72 characters, lowercase, imperative, and without a trailing period.',
  )
  process.exitCode = 1
}
