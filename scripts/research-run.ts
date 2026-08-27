import {readFile} from 'node:fs/promises'
import {DeterministicKataGo} from '../src/server/katago'
import {
  FakePlayerAdapter,
  SecretVault,
  createPlayerAdapter,
} from '../src/server/providers'
import {ResponseCache, ResearchRunner} from '../src/server/research'
import {Store} from '../src/server/database'

const manifestPath = process.argv[process.argv.indexOf('--manifest') + 1]
if (!manifestPath)
  throw new Error('Usage: pnpm research:run -- --manifest path.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const fake =
  manifest.model?.provider === 'fake' || process.env.LINGGO_FAKE_KATAGO === '1'
const store = new Store(':memory:')
const profile = manifest.model?.profileId
  ? store.getProfile(manifest.model.profileId)
  : undefined
const connection = profile
  ? store.getConnection(profile.connectionId)
  : undefined
const vault = new SecretVault()
const runner = new ResearchRunner({
  adapterFactory: () =>
    fake
      ? new FakePlayerAdapter()
      : createPlayerAdapter(connection!, profile!, vault),
  kataGo: new DeterministicKataGo(),
  cache: new ResponseCache('data/experiments/.cache'),
})
const result = await runner.run(manifest)
console.log(JSON.stringify(result.summary, null, 2))
store.close()
