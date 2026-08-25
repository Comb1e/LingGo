import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = Number(process.env.LINGGO_API_PORT ?? 4173)
const clientPort = Number(process.env.LINGGO_CLIENT_PORT ?? 5173)

export default defineConfig({
  plugins: [react()],
  build: {outDir: 'dist/client'},
  server: {
    host: '127.0.0.1',
    port: clientPort,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
})
