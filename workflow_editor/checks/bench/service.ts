// Starts a private editor service (production build) for a browser check, on
// its own registry and authoring area, and stops it. With `counters`, the
// service is preloaded with bench/counters.ts and answers stats() over IPC.
import { fork, type ChildProcess } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..', '..')

export interface Stats { counts: Record<string, number>; gitByCommand: Record<string, number>; cpu: { user: number; system: number }; rss: number }

export class PrivateService {
  readonly base: string
  private child?: ChildProcess
  private opts: { registry: string; area?: string; port: number; counters?: boolean; extraArgs?: string[] }
  constructor(opts: { registry: string; area?: string; port: number; counters?: boolean; extraArgs?: string[] }) {
    this.opts = opts
    this.base = `http://127.0.0.1:${opts.port}`
  }

  async start() {
    const args = ['--serve-dist', '--port', String(this.opts.port), '--registry', this.opts.registry, ...(this.opts.area ? ['--area', this.opts.area] : []), ...(this.opts.extraArgs ?? [])]
    this.child = fork(join(pkg, 'server/main.ts'), args, {
      cwd: pkg, execArgv: this.opts.counters ? ['--import', join(here, 'counters.ts')] : [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child.stderr?.on('data', d => process.stderr.write(`[service] ${d}`))
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${this.base}/api/workspaces`).then(() => true, () => false)) return
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error(`service on ${this.base} did not start`)
  }

  async stop() {
    const c = this.child
    if (!c) return
    this.child = undefined
    await new Promise<void>(r => { c.once('exit', () => r()); c.kill() })
  }

  stats(): Promise<Stats> {
    const c = this.child!
    return new Promise(r => { c.once('message', m => r(m as Stats)); c.send('stats') })
  }
}
