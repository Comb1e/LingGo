import {readFileSync} from 'node:fs'

const eventPath = process.env.GITHUB_EVENT_PATH
if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required')
const event = JSON.parse(readFileSync(eventPath, 'utf8')) as {
  pull_request?: {body?: string | null}
}
const body = event.pull_request?.body ?? ''
const requiredSections = [
  '## Behavior',
  '## Engineering Policy',
  '## Compatibility',
  '## Verification',
]
const missingSections = requiredSections.filter(
  (heading) => !body.includes(heading),
)
const unchecked = body
  .split('\n')
  .filter((line) => /^- \[ \]/.test(line.trim()))

if (missingSections.length || unchecked.length) {
  if (missingSections.length)
    console.error(`Missing PR sections: ${missingSections.join(', ')}`)
  if (unchecked.length)
    console.error(
      `Complete every PR policy checkbox (${unchecked.length} left).`,
    )
  process.exitCode = 1
}
