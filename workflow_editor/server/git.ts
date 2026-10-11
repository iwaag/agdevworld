// Git is always invoked with an argument array, never through a shell.
import { execFile } from 'node:child_process'

export interface GitResult { code: number; stdout: string; stderr: string }

export interface GitOptions {
  env?: Record<string, string>
  // Per-command configuration, e.g. protocol.file.allow=always for local
  // fixture transports. Never written to any Git config file.
  config?: Record<string, string>
  timeoutMs?: number
}

export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const config = Object.entries(opts.config ?? {}).flatMap(([k, v]) => ['-c', `${k}=${v}`])
  return new Promise(resolve => {
    execFile('git', [...config, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function gitOk(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const r = await git(cwd, args, opts)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout
}

// Local file transport is disabled for submodules by default since Git 2.38.
// Fixture operations enable it per command only.
export const LOCAL_TRANSPORT: Record<string, string> = { 'protocol.file.allow': 'always' }
