// A disposable Gitea for tests (p4): a fresh container on a loopback port
// with a throwaway admin user and token, removed afterwards. It never talks
// to the person's Gitea. WFE_TEST_GITEA=<setting.json> uses an existing test
// instance instead. Without Docker the Gitea tests are skipped.
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Gitea, loadGiteaSetting } from '../server/gitea.ts'

const exec = promisify(execFile)
const IMAGE = 'gitea/gitea:latest'

export interface TestGitea { gitea: Gitea; settingFile: string; stop: () => Promise<void> }

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)) }).on('error', rej)
})

export async function dockerAvailable(): Promise<boolean> {
  try { await exec('docker', ['image', 'inspect', IMAGE], { timeout: 10_000 }); return true } catch { return false }
}

export async function startGitea(): Promise<TestGitea> {
  if (process.env.WFE_TEST_GITEA) {
    const settingFile = process.env.WFE_TEST_GITEA
    return { gitea: new Gitea(await loadGiteaSetting(settingFile)), settingFile, stop: async () => {} }
  }
  const port = await freePort()
  const name = `wfe-test-gitea-${process.pid}-${port}`
  const url = `http://127.0.0.1:${port}`
  await exec('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:3000`,
    '-e', 'GITEA__security__INSTALL_LOCK=true', '-e', 'GITEA__database__DB_TYPE=sqlite3',
    '-e', `GITEA__server__ROOT_URL=${url}/`, '-e', 'GITEA__repository__DEFAULT_BRANCH=main', IMAGE])
  const stop = async () => { await exec('docker', ['rm', '-f', name]).catch(() => {}) }
  try {
    for (let i = 0; ; i++) {
      const ok = await fetch(`${url}/api/v1/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)
      if (ok) break
      if (i > 60) throw new Error('the test Gitea did not start')
      await new Promise(r => setTimeout(r, 500))
    }
    const user = 'wfetest'
    await exec('docker', ['exec', '-u', 'git', name, 'gitea', 'admin', 'user', 'create', '--admin', '--username', user, '--password', `p-${port}-Xx1`, '--email', `${user}@example.invalid`, '--must-change-password=false'])
    const token = (await exec('docker', ['exec', '-u', 'git', name, 'gitea', 'admin', 'user', 'generate-access-token', '--username', user, '--token-name', 'tests', '--scopes', 'all', '--raw'])).stdout.trim()
    const dir = await mkdtemp(join(tmpdir(), 'wfe-gitea-'))
    await writeFile(join(dir, 'gitea.token'), `${token}\n`, { mode: 0o600 })
    const settingFile = join(dir, 'gitea.json')
    await writeFile(settingFile, JSON.stringify({ url, owner: user, tokenFile: 'gitea.token' }))
    return { gitea: new Gitea(await loadGiteaSetting(settingFile)), settingFile, stop }
  } catch (e) {
    await stop()
    throw e
  }
}
