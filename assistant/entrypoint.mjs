import { mkdir, writeFile } from 'node:fs/promises'

import { renderOverlay } from './overlay-generator.mjs'

await mkdir('/app/.local', { recursive: true })
await writeFile('/app/.local/agents.local.toml', renderOverlay(), { mode: 0o600 })
await import('./server.mjs')
