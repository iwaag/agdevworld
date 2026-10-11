// The person's side of the pre1 readiness rehearsal, driven in a real
// browser against a running rehearsal area (`<area>/wfe serve`). It never
// creates the project; the IDE agent does that.
//
//   node checks/rehearsal.ts <mode> --area <dir> --port <port> --ws <id> --file <workflow.yaml>
//
//   adjust    edit a node description, add an edge, move a node; Save
//   watch     keep the workflow open and wait (--minutes, default 15) for the
//             next external change to appear without a reload
//   parity    approvals in the browser vs `wfe status`; validation counts in
//             the browser vs `wfe validate`; Auto-arrange vs `wfe arrange`
//   recovery  service restart with an edit in between, malformed then valid
//             content, workflow create/rename/delete, Git state refresh —
//             on a scratch copy of the workflow, removed afterwards
import { execFile, spawn } from 'node:child_process'
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { parseWorkflow } from '../server/yamlDoc.ts'
import { check, done, open, shot } from './lib.ts'

const args = process.argv.slice(2)
const option = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const mode = args[0]
const area = option('--area')!, port = option('--port', '8098')!, ws = option('--ws')!, file = option('--file')!
const BASE = `http://127.0.0.1:${port}`
const root = JSON.parse(await readFile(join(area, 'registry.json'), 'utf8')).workspaces.find((w: { id: string }) => w.id === ws).path as string
const wfDir = join(root, 'devdocs', 'workflows')
const path = join(wfDir, file)
const wfe = (a: string[], cwd = root) => new Promise<{ code: number; stdout: string; stderr: string }>(r =>
  execFile(join(area, 'wfe'), a, { cwd }, (e, stdout, stderr) => r({ code: e ? (e.code as number) : 0, stdout, stderr })))
const parsed = async (p = path) => { const r = parseWorkflow(await readFile(p, 'utf8')); if (!r.ok) throw new Error(`${p}: ${r.problem.message}`); return r.model }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(page: Page, fn: (a: string) => unknown, arg: string, ms = 8000): Promise<number | null> {
  const t = Date.now()
  try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 50 }); return Date.now() - t } catch { return null }
}

const { browser, page, errors } = await open(1440, 960)
let navigations = 0
page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++ })
const openWorkflow = async (f = file) => {
  await page.goto(`${BASE}/#/ws/${encodeURIComponent(ws)}/wf/${encodeURIComponent(f)}`)
  await page.waitForSelector('.node')
  await sleep(1200)
}

try {
  if (mode === 'adjust') {
    await openWorkflow()
    const before = await parsed()
    const ids = Object.keys(before.nodes)
    // A description.
    const target = ids[0]
    const description = `Adjusted in the browser by the person (${new Date().toISOString().slice(11, 19)}).`
    await page.locator(`.node[data-id="${target}"]`).click()
    await page.getByLabel('Node description').fill(description)
    // An edge from the first node to a later node it does not yet reach directly.
    const to = ids.find(id => id !== target && !before.edges.some(e => e.from === target && e.to === id) && !before.edges.some(e => e.from === id))
      ?? ids.find(id => id !== target && !before.edges.some(e => e.from === target && e.to === id))
    if (to) {
      await page.locator(`.node[data-id="${target}"]`).click()
      await page.getByLabel('Connect to node').selectOption(to)
      await page.locator('.inspector button', { hasText: 'Connect' }).click()
    }
    // Layout: drag the last node down by one row.
    const moved = ids[ids.length - 1]
    await page.getByRole('button', { name: 'Fit' }).click()
    const box = (await page.locator(`.node[data-id="${moved}"] .node-title`).boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 5)
    await page.mouse.down()
    await page.mouse.move(box.x + 10, box.y + 130, { steps: 10 })
    await page.mouse.up()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.save-state')?.textContent ?? ''))
    await shot(page, 'rehearsal-adjusted', false)
    const after = await parsed()
    check(after.nodes[target].description === description, `description of ${target} saved`)
    check(!to || after.edges.some(e => e.from === target && e.to === to), `edge ${target} → ${to} saved`)
    check(JSON.stringify(after.layout.nodes[moved]) !== JSON.stringify(before.layout.nodes[moved]), `position of ${moved} saved (${JSON.stringify(before.layout.nodes[moved] ?? null)} → ${JSON.stringify(after.layout.nodes[moved])})`)
    console.log(JSON.stringify({ described: target, description, edge: to ? [target, to] : null, moved, position: after.layout.nodes[moved] }))
  }

  if (mode === 'watch') {
    await openWorkflow()
    const minutes = Number(option('--minutes', '15'))
    const state = () => page.evaluate(() => JSON.stringify({
      intent: (document.querySelector('#intent') as HTMLTextAreaElement | null)?.value,
      nodes: [...document.querySelectorAll('.node')].map(n => [n.getAttribute('data-id'), n.querySelector('.node-title')?.textContent, n.querySelector('.node-desc')?.textContent]),
      edges: document.querySelectorAll('.edge').length,
    }))
    const initial = await state()
    const fileBefore = await readFile(path, 'utf8')
    console.log(`watching ${file}; waiting up to ${minutes} min for an external change`)
    const t0 = Date.now()
    let fileChangedAt = 0
    while (Date.now() - t0 < minutes * 60_000) {
      if (!fileChangedAt && await readFile(path, 'utf8').catch(() => fileBefore) !== fileBefore) fileChangedAt = Date.now()
      if (await state() !== initial) break
      await sleep(100)
    }
    const shownAt = Date.now()
    const changed = await state() !== initial
    check(changed, 'the external change appeared in the open view')
    check(navigations === 1, `without a page reload (${navigations} navigation)`)
    if (fileChangedAt) console.log(`file change noticed by the script → visible: ${shownAt - fileChangedAt} ms (script polls the file every 100 ms)`)
    await shot(page, 'rehearsal-after-agent', false)
    console.log(JSON.stringify(JSON.parse(await state()), null, 1))
  }

  if (mode === 'parity') {
    // Validation: browser status line vs CLI.
    await openWorkflow()
    const line = await page.locator('.v-summary').innerText()
    const v = JSON.parse((await wfe(['validate', file, '--json'])).stdout)
    const cliIssues = v.workflows[0].issues as { severity: string }[]
    const e = cliIssues.filter(i => i.severity === 'error').length, w = cliIssues.length - e
    const expected = e || w ? `${e} error${e === 1 ? '' : 's'}, ${w} warning${w === 1 ? '' : 's'}` : 'Structure and references valid'
    check(line.trim() === expected, `validation: browser "${line.trim()}" = CLI "${expected}"`)
    // Approvals in the browser, read back by the CLI.
    await page.getByLabel('Approver').fill('Rehearsal Person')
    await page.getByRole('button', { name: 'Approve intent' }).click()
    await page.waitForSelector('.approval-pill[data-kind="intent"][data-status="approved"]')
    const canDefine = await page.getByRole('button', { name: 'Approve definition' }).isEnabled()
    if (canDefine) {
      await page.getByRole('button', { name: 'Approve definition' }).click()
      await page.waitForSelector('.approval-pill[data-kind="definition"][data-status="approved"]')
    }
    const st = JSON.parse((await wfe(['status', '--json'])).stdout)
    const row = st.workflows.find((w: { file: string }) => w.file === file)
    check(row.approvals.intent === 'approved' && (!canDefine || row.approvals.definition === 'approved'), `CLI status reads the browser's approvals (${JSON.stringify(row.approvals)})`)
    const model = await parsed()
    check(model.approvals.intent?.approver === 'Rehearsal Person', 'the declared approver is recorded')
    // Auto-arrange: browser vs CLI, from the same saved file.
    const saved = await readFile(path, 'utf8')
    await page.getByRole('button', { name: 'Auto-arrange' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.save-state')?.textContent ?? ''))
    const byBrowser = (await parsed()).layout
    await writeFile(path, saved)
    await sleep(1500)
    const ar = await wfe(['arrange', file])
    const byCli = (await parsed()).layout
    check(ar.code === 0 && JSON.stringify(byBrowser) === JSON.stringify(byCli), 'Auto-arrange and wfe arrange give the same positions')
    const after = JSON.parse((await wfe(['status', '--json'])).stdout).workflows.find((w: { file: string }) => w.file === file)
    check(JSON.stringify(after.approvals) === JSON.stringify(row.approvals), 'arranging leaves approvals as they were')
    await sleep(1500)
    check(await page.locator('.banner.warn:has-text("changed on disk")').count() === 0, 'the open view followed the CLI arrange without a draft conflict')
  }

  if (mode === 'recovery') {
    const scratch = join(wfDir, 'zz-rehearsal-probe.yaml')
    const base = (await readFile(path, 'utf8')).replace(/^id: .*$/m, 'id: zz-rehearsal-probe')
    const withIntent = (m: string) => base.replace(/^intent:.*(\n {2}.*)*/m, `intent: |\n  ${m}`)
    // Created externally while the project view is open.
    await page.goto(`${BASE}/#/ws/${encodeURIComponent(ws)}`)
    await page.waitForSelector('.project-meta')
    await sleep(1200)
    await writeFile(scratch, withIntent('probe 1'))
    check(await waitFor(page, f => !!document.querySelector(`.wf-row[data-file="${f}"]`), 'zz-rehearsal-probe.yaml') !== null, 'created workflow file appears in the project view')
    await openWorkflow('zz-rehearsal-probe.yaml')
    const intentHas = (m: string) => (document.querySelector<HTMLTextAreaElement>('#intent')?.value ?? '').includes(m)
    // Malformed, then valid.
    await writeFile(scratch, `${withIntent('probe 1')}\n  : : [broken\n`)
    check(await waitFor(page, () => /cannot be used/.test(document.querySelector('.banners')?.textContent ?? ''), '') !== null, 'malformed content: error shown, last version kept')
    await writeFile(scratch, withIntent('probe 2'))
    check(await waitFor(page, intentHas, 'probe 2') !== null, 'valid content again: editing recovers')
    // Service restart with an edit while it is down.
    execFile('pkill', ['-f', `server/main.ts --serve-dist --port ${port}`])
    check(await waitFor(page, () => /Not connected/.test(document.querySelector('.banners')?.textContent ?? ''), '', 6000) !== null, 'outage is shown')
    await writeFile(scratch, withIntent('probe 3, written while the service was down'))
    const svc = spawn(join(area, 'wfe'), ['serve'], { detached: true, stdio: 'ignore', cwd: area })
    svc.unref()
    check(await waitFor(page, intentHas, 'probe 3', 20_000) !== null, 'after restart the edit made meanwhile is shown, without a reload')
    // Rename and delete.
    await rename(scratch, join(wfDir, 'zz-rehearsal-probe-2.yaml'))
    check(await waitFor(page, () => /no longer exists/.test(document.querySelector('.banners')?.textContent ?? '') && /Open zz-rehearsal-probe-2\.yaml/.test(document.querySelector('.banners')?.textContent ?? ''), '') !== null, 'rename: shown, with a link to the new file')
    await unlink(join(wfDir, 'zz-rehearsal-probe-2.yaml'))
    await sleep(2500)
    check(!(await readFile(scratch, 'utf8').then(() => true, () => false)), 'deletion: nothing is recreated')
    // Git state, separately: a commit in the root.
    await page.goto(`${BASE}/#/ws/${encodeURIComponent(ws)}`)
    await page.waitForSelector('.repo-row[data-path="."]')
    await sleep(1500)
    const rowBefore = await page.locator('.repo-row[data-path="."]').textContent()
    await writeFile(join(root, '.local', 'rehearsal-note.txt'), 'ignored\n')
    const gitTouch = join(root, 'REHEARSAL.md')
    await writeFile(gitTouch, 'Git-state probe; removed by the rehearsal.\n')
    check(await waitFor(page, b => document.querySelector('.repo-row[data-path="."]')?.textContent !== b, rowBefore ?? '', 6000) !== null, 'Git state (an untracked file in the root) refreshes without a reload')
    await rm(gitTouch)
    await rm(join(root, '.local', 'rehearsal-note.txt'))
  }
  check(errors.filter(e => !/Failed to load resource|ERR_CONNECTION_REFUSED|EventSource/.test(e)).length === 0, `no page errors (${errors.join('; ').slice(0, 300)})`)
} finally {
  await browser.close()
}
done()
