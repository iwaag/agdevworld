import { defineConfig } from 'vite'

// Dev-only: forward chat requests to the assistant service (compose service
// `assistant`, published on localhost:8091). Production uses nginx instead.
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: process.env.ASSISTANT_URL ?? 'http://localhost:8091',
        changeOrigin: true,
      },
    },
  },
})
