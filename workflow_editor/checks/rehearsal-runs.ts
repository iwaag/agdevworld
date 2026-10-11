// The person's side of the p3/pre1 readiness rehearsal, in a real browser
// against a running rehearsal area (`<area>/wfe serve`). It only does what
// the person does in the browser: find the run from the project view, follow
// it, answer a question, read reports, decide on the result. The IDE agent
// does the work.
//
//   node checks/rehearsal-runs.ts <mode> --port <port> --ws <id> [options]
//
//   follow   open the project view, open the newest run (or --run), wait until
//            --until question|completed|change (default change; --minutes 20)
//   answer   --run <wf/run> --question q1 --text <answer> [--name <person>]
//   inspect  --run <wf/run>: summary, nodes, questions, reports (each opened)
//   decide   --run <wf/run> --decision accepted|rejected --evidence <text>
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { check, done, open, shot } from './lib.ts'

const args = process.argv.slice(2)
const option = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const mode = args[0]
const port = option('--port', '8099')!, ws = option('--ws')!
const BASE = `http://127.0.0.1:${port}`
const NAME = option('--name', 'Rehearsal Person')!
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const seq = (p: Page) => p.evaluate(() => Number((document.querySelector('.run-summary') as HTMLElement | null)?.dataset.seq ?? -1))
const runUrl = (r: string) => `${BASE}/#/ws/${encodeURIComponent(ws)}/run/${r}`

const { browser, page, errors } = await open(1440, 1000)
async function openRun(r: string) {
  await page.goto(runUrl(r))
  await page.waitForSelector('.run-summary[data-seq]')
  await sleep(500)
}
async function describe() {
  const title = await page.locator('.run-title').innerText()
  const facts = (await page.locator('.run-facts').innerText()).replace(/\n/g, ' | ')
  const now = (await page.locator('.run-now').innerText()).replace(/\n/g, ' | ')
  const cards = await page.locator('.node.in-run').evaluateAll(els => els.map(e => `${(e as HTMLElement).dataset.id}: ${e.querySelector('.run-status')?.textContent}`))
  console.log(`  ${title.replace(/\n/g, ' ')}\n  ${facts}\n  ${now}\n  nodes: ${cards.join('; ')}`)
}

try {
  if (mode === 'follow') {
    await page.goto(`${BASE}/#/ws/${encodeURIComponent(ws)}`)
    await page.waitForSelector('.runs-card')
    const minutes = Number(option('--minutes', '20'))
    let r = option('--run')
    if (!r) {
      // The person waits on the project view until the agent's run appears.
      const t = Date.now()
      while (!(await page.locator('.run-row').count()) && Date.now() - t < minutes * 60_000) await sleep(1000)
      r = await page.locator('.run-row').first().getAttribute('data-run') ?? undefined
      if (!r) throw new Error('no run appeared')
      await page.locator('.run-row').first().getByRole('link', { name: 'Open run' }).click()
    } else await openRun(r)
    await page.waitForSelector('.run-summary[data-seq]')
    console.log(`following ${r}`)
    const until = option('--until', 'change')
    const start = await seq(page)
    const t0 = Date.now()
    for (;;) {
      const text = await page.locator('.run-side').innerText()
      const state = await page.evaluate(() => (document.querySelector('.run-summary') as HTMLElement | null)?.dataset.state)
      if (until === 'question' && /Record answer/.test(text)) break
      if (until === 'completed' && state === 'completed') break
      if (until === 'change' && (await seq(page)) > start) break
      if (Date.now() - t0 > minutes * 60_000) { console.log('  (stopped waiting)'); break }
      await sleep(1000)
    }
    await describe()
    await shot(page, `rehearsal-follow-${until}`, false)
    check(true, `followed ${r} until ${until} (${Math.round((Date.now() - t0) / 1000)} s, seq ${start} → ${await seq(page)})`)
  } else if (mode === 'answer') {
    const r = option('--run')!, q = option('--question')!, text = option('--text')!
    await openRun(r)
    const before = await seq(page)
    console.log(`  question: ${(await page.locator(`.question[data-question="${q}"] .q-text`).first().innerText())}`)
    await page.getByLabel('Your name').fill(NAME)
    await page.getByLabel(`Answer to ${q}`).first().fill(text)
    await page.locator(`.question[data-question="${q}"] button.primary`).first().click()
    await page.waitForFunction(n => Number((document.querySelector('.run-summary') as HTMLElement).dataset.seq) > n, before, { timeout: 8000 })
    await sleep(300)
    await describe()
    console.log(`  banner: ${(await page.locator('.banners').innerText()).trim()}`)
    await shot(page, `rehearsal-answered-${q}`, false)
    check(/recorded in run\.json/.test(await page.locator('.banners').innerText()), `answer to ${q} recorded from the browser as ${NAME}`)
  } else if (mode === 'inspect') {
    const r = option('--run')!
    await openRun(r)
    await describe()
    const side = await page.locator('.run-side').innerText()
    console.log(`  questions: ${(side.split('Questions')[1] ?? '').split('Related runs')[0].replace(/\n+/g, ' | ').slice(0, 600)}`)
    const files = await page.locator('.run-side ul.files .file-link').allInnerTexts()
    console.log(`  reports and files: ${files.join(', ')}`)
    for (const f of files.filter(f => /\.md$/.test(f))) {
      await page.locator('.run-side .file-link', { hasText: f }).first().click()
      await page.waitForSelector('.file-view pre')
      console.log(`  --- ${f}: ${(await page.locator('.file-view pre').innerText()).split('\n').slice(0, 3).join(' / ').slice(0, 200)}`)
    }
    await shot(page, `rehearsal-inspect-${r.replace('/', '-')}`, false)
    check(files.length > 0, `${r}: reports readable from the run view`)
  } else if (mode === 'decide') {
    const r = option('--run')!
    await openRun(r)
    const before = await seq(page)
    await page.getByLabel('Your name').fill(NAME)
    await page.getByLabel('Decision evidence').fill(option('--evidence')!)
    await page.getByRole('button', { name: option('--decision') === 'rejected' ? 'Reject result' : 'Accept result' }).click()
    await page.waitForFunction(n => Number((document.querySelector('.run-summary') as HTMLElement).dataset.seq) > n, before, { timeout: 8000 })
    await describe()
    await shot(page, 'rehearsal-decided', false)
    const area = option('--area')
    if (area) {
      const reg = JSON.parse(await readFile(join(area, 'registry.json'), 'utf8')) as { workspaces: { id: string; path: string }[] }
      const root = reg.workspaces.find(w => w.id === ws)!.path
      const [wf, run] = r.split('/')
      const rec = JSON.parse(await readFile(join(root, 'devdocs', wf, 'runs', run, 'run.json'), 'utf8'))
      check(rec.decisions.at(-1)?.by === NAME, `decision recorded by ${NAME}: ${JSON.stringify(rec.decisions.at(-1))}`)
    }
  } else throw new Error(`unknown mode ${mode}`)
  const pageErrors = errors.filter(e => !/^Failed to load resource/.test(e))
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`)
} finally {
  await browser.close()
  done()
}
