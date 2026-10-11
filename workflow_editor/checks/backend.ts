// p5/ex1 step 5: the run header's backend, from attempt evidence, in the
// browser against a private service: a completed run (three attempts, one
// backend), an active attempt after another backend, a latest attempt that
// recorded none, and a run with no attempt.
//
//   npm run build && node checks/backend.ts [--port 8199]
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
process.env.WFE_FIXTURE = resolve(here, '..', '..', '.local', 'wfe-checks')
const args = process.argv.slice(2)
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8199)
const root = await mkdtemp(join(tmpdir(), 'wfe-backend-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Check Person\n\temail = check@example.invalid\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')

const { check, done, open, shot } = await import('./lib.ts')
const { PrivateService } = await import('./bench/service.ts')
const { createProject } = await import('../server/create.ts')
const { loadRegistry } = await import('../server/registry.ts')
const { ExecStore } = await import('../server/exec.ts')
const { createRun } = await import('../server/runs.ts')
const { Workspace } = await import('../server/workspace.ts')

const area = join(root, 'area')
const registry = join(area, 'registry.json')
const dir = join(area, 'pj-chk')
const made = await createProject({ dir, id: 'chk', name: 'Backend check', intent: 'Checks.', goals: [], devdocs: 'directory', registryFile: registry })
if (!made.ok) throw new Error(made.message)
await writeFile(join(dir, 'devdocs', 'workflows', 'ship.yaml'), `schema: ag.workflow.v2
documentation: {policy: manual}
id: ship
name: Ship
intent: |
  Build it.
repositories:
  root: {path: ., access: editable}
nodes:
  build: {type: do, name: Build, description: Build it.}
`)
const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
const x = new ExecStore({ registryFile: registry, area })
const SONNET = 'claude_code / anthropic/claude-sonnet-5'
const cases: { run: string; attempts: [string, string | null][]; want: RegExp; label: string }[] = [
  { run: 'run-001', attempts: [['ended', SONNET], ['ended', SONNET], ['ended', SONNET]], want: new RegExp(`^autolab · backend ${SONNET.replace(/[/.]/g, '\\$&')} \\(latest attempt\\)$`), label: 'completed: the latest attempt\'s backend' },
  { run: 'run-002', attempts: [['ended', 'codex / gpt-x'], ['running', SONNET]], want: /backend claude_code \/ anthropic\/claude-sonnet-5 \(attempt in progress\) · 2 backends across 2 attempts$/, label: 'active: the attempt in progress, and that backends differ' },
  { run: 'run-003', attempts: [['ended', SONNET], ['ended', null]], want: /backend unknown \(latest attempt recorded none\) · 2 backends across 2 attempts$/, label: 'missing: unknown, not borrowed from the earlier attempt' },
  { run: 'run-004', attempts: [], want: /^autolab · no attempt yet$/, label: 'no attempt: says so' },
]
for (const c of cases) {
  await createRun(ws, { workflow: 'ship', input: { kind: 'braindump', text: 'x', author: 'Check Person' }, executor: { name: 'autolab', backend: null }, by: 'Check Person', via: 'cli' })
  c.attempts.forEach(([state, backend], i) => x.db.prepare('INSERT INTO attempts (id, job, workspace, workflow, run, host, state, began, ended, backend) VALUES (?, 0, ?, \'ship\', ?, \'h\', ?, ?, ?, ?)')
    .run(`${c.run}-a${i}`, ws.reg.id, c.run, state, `2026-10-11T0${i + 1}:00:00.000Z`, state === 'ended' ? `2026-10-11T0${i + 1}:30:00.000Z` : null, backend))
}
x.close()

const service = new PrivateService({ registry, area, port: PORT })
await service.start()
const { browser, page, errors } = await open(1440, 900)
try {
  for (const c of cases) {
    await page.goto(`${service.base}/#/ws/chk/run/ship/${c.run}`)
    await page.waitForSelector('.run-summary[data-seq]')
    const ok = await page.waitForFunction(src => new RegExp(src).test(document.querySelector('.fact.executor .v')?.textContent ?? ''), c.want.source, { timeout: 8000 }).then(() => true, () => false)
    const text = await page.locator('.fact.executor .v').textContent()
    check(ok, `${c.label}: "${text}"`)
    await shot(page, `backend-${c.run}`, false)
  }
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`)
} finally {
  await browser.close()
  await service.stop()
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
}
done()
