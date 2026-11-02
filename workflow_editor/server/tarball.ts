// tar's own list, one path per entry: no folder recursion, symbolic links as
// links, modes kept. The same flags in BSD and GNU tar; no AppleDouble entries.
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

function run(args: string[], cwd: string, input: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args, { cwd, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', d => { stderr += d })
    p.on('error', reject)
    p.on('close', code => resolve({ code: code ?? 1, stderr }))
    p.stdin.end(input)
  })
}
export async function tarCreate(archive: string, cwd: string, paths: string[]) {
  const t = await run(['-czf', archive, '--no-recursion', '--null', '-T', '-'], cwd, paths.map(p => `./${p}\0`).join(''))
  if (t.code !== 0) throw new Error(`tar failed: ${t.stderr.trim().split('\n').slice(0, 3).join('; ')}`)
}
export async function tarExtract(archive: string, cwd: string) {
  await mkdir(cwd, { recursive: true })
  const t = await run(['-xzpf', archive], cwd, '')
  if (t.code !== 0) throw new Error(`tar failed: ${t.stderr.trim().split('\n').slice(0, 3).join('; ')}`)
}
