import { defineConfig } from 'vite'

// The dev server proxies /api to the local service (server/main.ts). The
// Origin header is passed through unchanged so the service can check it.
// `base: './'` keeps asset URLs relative, so the built UI also works under
// agdevworld's same-origin prefix (/wfe/).
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8095', changeOrigin: false } },
  },
})
