// project_migration p9: Gitea as a named principal — token files in the
// forms credential notes take, `Gitea.as`, and `wfe gitea whoami|repo|git`
// against a disposable Gitea (a second user owns the repository; the
// service principal is the fixture's admin). The token never reaches the
// output, a remote or a Git config file, and force pushes are refused.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Gitea, GiteaError, loadGiteaSetting, tokenOf } from '../server/gitea.ts'
import { gitOk } from '../server/git.ts'
import { forcePush } from '../cli/wfe.ts'
import { dockerAvailable, startGitea, type TestGitea } from './giteaFixture.ts'

const pkg = resolve(import.meta.dirname, '..')

test('a token file: the bare token, or a token line among others; never echoed', () => {
  assert.equal(tokenOf('abc123\n', 'f'), 'abc123')
  assert.equal(tokenOf('user: someone\npassword: hunter2\ntoken: tok-9\n', 'f'), 'tok-9')
  assert.equal(tokenOf('GITEA_USER=someone\nexport GITEA_TOKEN="tok-8"\n', 'f'), 'tok-8')
  assert.equal(tokenOf('{"user": "someone", "token": "tok-7"}', 'f'), 'tok-7')
  assert.throws(() => tokenOf('user: someone\npassword: hunter2\n', 'f'), (e: Error) => e instanceof GiteaError && /has no token/.test(e.message) && !e.message.includes('hunter2'))
  assert.throws(() => tokenOf('  \n', 'f'), /is empty/)
})

test('principals are named in the setting; an unnamed one is refused with the names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfe-principals-'))
  try {
    await writeFile(join(dir, 'gitea.json'), JSON.stringify({ url: 'http://g.invalid:3000/', owner: 'svc', tokenFile: 'svc.token', principals: { agent: { tokenFile: '../agent.token' } } }))
    const g = new Gitea(await loadGiteaSetting(join(dir, 'gitea.json')))
    assert.equal(g.principal, '(service)')
    const a = g.as('agent')
    assert.equal(a.principal, 'agent')
    assert.equal(a.owner, 'agent')
    assert.equal(a.setting.tokenFile, resolve(dir, '..', 'agent.token'))
    assert.equal(g.setting.tokenFile, join(dir, 'svc.token'))
    assert.throws(() => g.as('other'), /names no principal "other" \(named: agent\)/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('force pushes are recognized; lease and ordinary pushes are not', () => {
  for (const a of [['push', '--force'], ['push', '-f', 'origin'], ['push', 'origin', '+main'], ['push', '--mirror'], ['-C', 'x', 'push', '-uf', 'origin', 'main']]) assert.ok(forcePush(a), a.join(' '))
  for (const a of [['push', 'origin', 'main'], ['push', '--force-with-lease', 'origin', 'main'], ['push', '-u', 'origin', 'main'], ['fetch', '+refs/heads/*:refs/remotes/o/*']]) assert.equal(forcePush(a), undefined, a.join(' '))
})

const skip = !(await dockerAvailable()) && !process.env.WFE_TEST_GITEA
let tg: TestGitea
let root = ''
const AGENT = 'wfeagent'

before(async () => {
  if (skip) return
  root = await mkdtemp(join(tmpdir(), 'wfe-principals-gitea-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.invalid\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  tg = await startGitea()
  const password = `Pw-${process.pid}-agent1`
  await tg.gitea.call('POST', '/admin/users', { username: AGENT, email: `${AGENT}@example.invalid`, password, must_change_password: false })
  const res = await fetch(`${tg.gitea.url}/api/v1/users/${AGENT}/tokens`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${AGENT}:${password}`).toString('base64')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'p9', scopes: ['all'] }),
  })
  const token = ((await res.json()) as { sha1: string }).sha1
  // A credential note, as the agent's credential file on the host is.
  await writeFile(join(root, 'agent-credential'), `user: ${AGENT}\npassword: ${password}\ntoken: ${token}\n`)
  const base = JSON.parse(await readFile(tg.settingFile, 'utf8')) as Record<string, unknown>
  base.tokenFile = resolve(join(tg.settingFile, '..'), String(base.tokenFile))
  base.principals = { [AGENT]: { tokenFile: join(root, 'agent-credential') } }
  await writeFile(join(root, 'gitea.json'), JSON.stringify(base))
  await writeFile(join(root, 'registry.json'), JSON.stringify({ schema: 'ag.registry.v1', workspaces: [], repositories: [], projects: [] }))
})
after(async () => {
  if (skip) return
  await tg.stop()
  await rm(root, { recursive: true, force: true })
})

const wfe = (args: string[], cwd = root) => new Promise<{ code: number; stdout: string; stderr: string }>(r => execFile(process.execPath, [join(pkg, 'cli', 'wfe.ts'), ...args], {
  cwd, env: { ...process.env, WFE_REGISTRY: join(root, 'registry.json'), GIT_TERMINAL_PROMPT: '0' },
}, (e, stdout, stderr) => r({ code: e ? (e.code as number) : 0, stdout, stderr })))

test('wfe gitea: whoami, access and a push as the named principal to a repository it owns', { skip }, async () => {
  const svc = (await wfe(['gitea', 'whoami'])).stdout
  assert.match(svc, new RegExp(`^${tg.gitea.owner} `))
  const me = await wfe(['gitea', 'whoami', '--as', AGENT])
  assert.equal(me.code, 0, me.stderr)
  assert.match(me.stdout, new RegExp(`^${AGENT} \\(as ${AGENT}`))

  const agentGitea = new Gitea(await loadGiteaSetting(join(root, 'gitea.json'))).as(AGENT)
  await agentGitea.createRepo('pj-onboard', 'an existing project')
  const access = await wfe(['gitea', 'repo', `${AGENT}/pj-onboard`, '--as', AGENT, '--json'])
  assert.equal(JSON.parse(access.stdout).permissions.push, true)

  const work = join(root, 'prep')
  await gitOk(root, ['init', '-q', '--initial-branch=main', work])
  await writeFile(join(work, 'project.yaml'), 'schema: ag.project.v2\nid: onboard\nname: Onboard\n')
  await gitOk(work, ['add', '-A'])
  await gitOk(work, ['-c', 'user.name=front-agent', '-c', 'user.email=front-agent@agdev.invalid', 'commit', '-q', '-m', 'Project definition'])
  await gitOk(work, ['remote', 'add', 'origin', agentGitea.cloneUrl(AGENT, 'pj-onboard')])
  // Without the principal's authentication the push fails …
  const plain = await new Promise<number>(r => execFile('git', ['-C', work, 'push', '-q', 'origin', 'main'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, e => r(e ? 1 : 0)))
  assert.equal(plain, 1)
  // … with it, it succeeds, and nothing about the token is left behind.
  const push = await wfe(['gitea', 'git', '--as', AGENT, '--', '-C', work, 'push', '-q', 'origin', 'main'])
  assert.equal(push.code, 0, push.stderr)
  assert.equal(await agentGitea.hasContent(AGENT, 'pj-onboard'), true)
  const token = tokenOf(await readFile(join(root, 'agent-credential'), 'utf8'), 'x')
  for (const text of [push.stdout, push.stderr, me.stdout, access.stdout, await readFile(join(work, '.git', 'config'), 'utf8')]) assert.ok(!text.includes(token))

  // A force push is refused before git runs; the published commit stays.
  await gitOk(work, ['commit', '-q', '--amend', '-m', 'Rewritten'])
  const forced = await wfe(['gitea', 'git', '--as', AGENT, '--', '-C', work, 'push', '--force', 'origin', 'main'])
  assert.equal(forced.code, 1)
  assert.match(forced.stderr + forced.stdout, /force push \(--force\) is refused/)
  const rejected = await wfe(['gitea', 'git', '--as', AGENT, '--', '-C', work, 'push', '-q', 'origin', 'main'])
  assert.notEqual(rejected.code, 0) // non-fast-forward: git refuses, as usual

  const unknown = await wfe(['gitea', 'whoami', '--as', 'nobody'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr + unknown.stdout, /names no principal "nobody"/)
})
