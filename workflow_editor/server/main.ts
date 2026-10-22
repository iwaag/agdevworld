// Starts the local editor service.
//
//   node server/main.ts [--registry <file>] [--area <dir>] [--port 8095]
//     [--poll-ms 1000] [--git-poll-ms 3000] [--serve-dist]
//     [--gitea <setting.json>] [--origins <url,url>] [--bind 0.0.0.0]
//
// The registry is required (--registry or WFE_REGISTRY): a default relative to
// the code would serve a different, empty catalog whenever the code moves.
// `wfe serve` starts it for an authoring area's registry.
// The area (default: the registry's directory) is where browser-created
// projects go.
//
// It binds to every interface (--bind / WFE_BIND, default 0.0.0.0) and
// answers to any host name, so the LAN reaches it. Browser writes are
// accepted from the page's own origin, the Vite dev origin and the origins
// given with --origins / WFE_ORIGINS.
// The Gitea setting defaults to gitea.json beside the registry, when present.
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { createHandler } from './api.ts'
import { Gitea, loadGiteaSetting } from './gitea.ts'
import { ConversationStore } from './conversations.ts'
import { ExecStore } from './exec.ts'
import { UsageReader } from './usage.ts'
import { Watcher } from './watch.ts'
import { DialogueStore, DialogueWorker } from './dialogue.ts'
import { ConversationService } from './conversationService.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : process.env[`WFE_${name.slice(2).toUpperCase()}`] ?? fallback }

export const DEFAULT_PORT = 8095
export const DEV_PORT = 5175
const port = Number(option('--port', String(DEFAULT_PORT)))
const bind = option('--bind', '0.0.0.0')
const registryOption = option('--registry', '')
if (!registryOption) { console.error('No registry chosen: pass --registry <file> (or WFE_REGISTRY). The fixture: npm run service.'); process.exit(2) }
const registryFile = resolve(registryOption)
const area = resolve(option('--area', dirname(registryFile)))
const serveDist = args.includes('--serve-dist')
const pollMs = Number(option('--poll-ms', '1000'))
const gitPollMs = Number(option('--git-poll-ms', '3000'))

const extraOrigins = option('--origins', '').split(',').map(o => o.trim()).filter(Boolean)
const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${DEV_PORT}`, `http://localhost:${DEV_PORT}`, ...extraOrigins]
// The agentroom relay on this host: subscription windows and pre-WFE records for Usage.
const relayUrl = option('--relay', 'http://127.0.0.1:8094')
const giteaFile = option('--gitea', join(dirname(registryFile), 'gitea.json'))
let gitea: Gitea | undefined, giteaProblem: string | undefined
if (existsSync(giteaFile)) {
  try { gitea = new Gitea(await loadGiteaSetting(giteaFile)) } catch (e) { giteaProblem = (e as Error).message }
} else giteaProblem = `no Gitea setting at ${giteaFile}`
const exec = new ExecStore({ registryFile, area, gitea })
const conversations = new ConversationStore({ area, exec })
// Character dialogue (argue p5): its store and the worker that renders lines,
// in this process, beside (never inside) the executor's slots.
const dialogue = new DialogueStore(new ConversationService(conversations))
const handler = createHandler({
  registryFile,
  area,
  allowedOrigins: origins,
  distDir: serveDist ? join(pkg, 'dist') : undefined,
  watcher: new Watcher(pollMs, { gitIntervalMs: gitPollMs, registryFile }),
  gitea, giteaProblem,
  exec, conversations,
  usage: new UsageReader(exec, relayUrl),
  dialogue,
})

const server = createServer((req, res) => void handler(req, res))
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use on ${bind} — another editor service is probably running. Stop it, or pass --port.`)
  else console.error(e)
  process.exit(1)
})
server.listen(port, bind, () => {
  console.log(`workflow editor service on http://${bind}:${port}${serveDist ? ' (serving dist/)' : ''}`)
  console.log(`registry: ${registryFile}`)
  console.log(`authoring area: ${area}`)
  console.log(gitea ? `gitea: ${gitea.url} (owner ${gitea.owner})` : `gitea: none — ${giteaProblem}`)
  if (extraOrigins.length) console.log(`extra origins: ${extraOrigins.join(', ')}`)
  if (!process.env.WFE_NO_DIALOGUE) new DialogueWorker(dialogue).start()
})
