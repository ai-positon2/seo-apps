import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        // MUST exceed server.timeout (server/server.js), or the browser gives
        // up before the server does and the abort surfaces as a bare "Failed
        // to fetch" with no message -- the server meanwhile finishes the work
        // and has nobody to hand it to. It was 120s against a 180s server,
        // which is exactly how a 2-minute page generation failed silently.
        //
        // `timeout` is the outgoing socket; `proxyTimeout` is how long to wait
        // for the response. Both have to be raised.
        timeout: 660000,
        proxyTimeout: 660000
      }
    }
  }
})
