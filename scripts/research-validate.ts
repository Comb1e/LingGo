import {validateResearchDirectory} from '../src/server/researchAnalysis'
const input = process.argv[process.argv.indexOf('--input') + 1]
if (!input)
  throw new Error(
    'Usage: pnpm research:validate -- --input data/experiments/id/run',
  )
console.log(JSON.stringify(await validateResearchDirectory(input), null, 2))
