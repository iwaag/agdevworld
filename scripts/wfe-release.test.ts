// Deployment failures report the selected version; no previous-version state
// or automatic restoration is maintained. All commands use a disposable area.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readlink, rm, symlink, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('failed activation keeps the selected release and rollback is not a command', async () => {
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const script = join(repo, 'scripts', 'wfe-release.sh')
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  assert.match(sha, /^[a-f0-9]{40}$/)
  const area = await mkdtemp(join(tmpdir(), 'wfe-release-'))
  try {
    await writeFile(join(area, 'registry.json'), '{"workspaces":[]}')
    await mkdir(join(area, 'service', 'releases', sha), { recursive: true })
    await writeFile(join(area, 'service', 'releases', sha, 'RELEASE.json'), JSON.stringify({ agdevworld: sha }))
    await symlink('releases/old-version', join(area, 'service', 'current'))
    // Never touch this host's launchd, even if the test runs on macOS.
    const bin = join(area, 'fake-bin')
    await mkdir(bin)
    await writeFile(join(bin, 'launchctl'), '#!/bin/sh\nexit 1\n')
    await chmod(join(bin, 'launchctl'), 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WFE_HEALTH_SECONDS: '0' }
    const failed = spawnSync('sh', [script, 'activate', area, sha], { env, encoding: 'utf8' })
    assert.equal(failed.status, 1, failed.stdout + failed.stderr)
    assert.match(failed.stderr, /selected release remains/)
    assert.equal(await readlink(join(area, 'service', 'current')), `releases/${sha}`)
    await assert.rejects(access(join(area, 'service', 'previous')), /ENOENT/)
    const removed = spawnSync('sh', [script, 'rollback', area], { env, encoding: 'utf8' })
    assert.equal(removed.status, 2)
    assert.doesNotMatch(removed.stderr, /rollback/)
    assert.equal(await readlink(join(area, 'service', 'current')), `releases/${sha}`)
  } finally { await rm(area, { recursive: true, force: true }) }
})
