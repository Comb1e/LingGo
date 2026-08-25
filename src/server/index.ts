import {createApp} from './app'

const port = Number(process.env.PORT ?? 4173)
const {app, games} = createApp()

try {
  await app.listen({host: '127.0.0.1', port})
  games.restoreAutoplay()
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
