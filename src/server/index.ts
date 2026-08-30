import {createApp} from './app'
import {loadRuntimeConfig} from './config'
import {configureNetworkProxy, verifyDedicatedProxy} from './network'

const port = loadRuntimeConfig().port

try {
  configureNetworkProxy()
  await verifyDedicatedProxy()
  const {app, games} = createApp()
  await app.listen({host: '127.0.0.1', port})
  games.restoreAutoplay()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
