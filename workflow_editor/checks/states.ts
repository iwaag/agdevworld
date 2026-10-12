// Representative states of the Workflow Editor and the Run view
// (workflow_editor p8 step 1). Builds a private project, registry, area and
// presentation host with the same server modules the CLI uses, and records
// each run's state through runOp — so the views can be reviewed and checked
// across the state matrix, not only on one completed run. Titles and
// outcomes say what each state is; nothing here is the RTS project.
//
//   npm run build && node checks/states.ts [--port 8210] [--serve] [--shots <dir>]
//
// --serve keeps the private service running (Ctrl-C stops it and removes
// the data); --shots captures every state at 1440 × 1000 into <dir>.
// checks/simplerUi.ts imports buildStates() for its own fixture.
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpInput, RunRef } from '../shared/run.ts'

// ---- workflows ---------------------------------------------------------------------------

const IMPROVE = `schema: ag.workflow.v2
id: improve
name: Improve the sample app
intent: |
  Agree the scope of the requested change with the person, implement it,
  verify it with the tests and in the browser, present it for the person's
  check, and clean up what the presentation started.
documentation:
  policy: default
repositories:
  app: {path: ., access: editable}
  docs: {path: devdocs, access: readonly}
nodes:
  implement:
    type: do
    name: Implement
    description: Change the app within the agreed scope.
    repositories: [app]
  verify:
    type: do
    name: Verify
    description: Run the tests and check the change in the browser.
    repositories: [app]
    appearance: {icon: test}
  present:
    type: do
    name: Present
    description: Freeze the result and serve its review with what changed and what to check.
    repositories: [app]
    appearance: {icon: present, color: teal}
    template: {id: present, revision: 1, expectation: A running review page the person can open with one click.}
  check:
    type: talk
    name: Human check
    confirms: result
    description: Ask the person to accept the result or say what to change.
    repositories: [app]
  cleanup:
    type: do
    name: Clean up
    description: Stop the review server and verify it is gone.
    repositories: [app]
    appearance: {icon: cleanup, color: slate}
edges:
  - {from: implement, to: verify}
  - {from: verify, to: present}
  - {from: present, to: check}
  - {from: check, to: cleanup}
`
const EXPLORE = `schema: ag.workflow.v2
id: explore
name: Explore two options
intent: |
  Survey the options, build one while asking the person about the other,
  and join both into one recommendation.
documentation:
  policy: default
repositories:
  app: {path: ., access: editable}
nodes:
  survey: {type: study, name: Survey options, description: Read what exists and list the options., repositories: [app]}
  build: {type: do, name: Build the prototype, description: Build the first option far enough to try it., repositories: [app]}
  ask: {type: talk, name: Ask about option B, description: Ask the person which constraints option B must meet., repositories: [app]}
  join: {type: do, name: Recommend, description: Combine the prototype and the answer into one recommendation., repositories: [app]}
edges:
  - {from: survey, to: build}
  - {from: survey, to: ask}
  - {from: build, to: join}
  - {from: ask, to: join}
`
const TIDY = `schema: ag.workflow.v2
id: tidy
name: Tidy the documentation
intent: |
  Find stale pages, rewrite them and check the links. No plan talk and no
  reports: the person reads the changed pages directly.
documentation:
  policy: manual
repositories:
  docs: {path: devdocs, access: editable}
nodes:
  find: {type: study, name: Find stale pages, description: List pages older than the code they describe., repositories: [docs], appearance: {icon: review, color: amber}}
  rewrite: {type: do, name: Rewrite, description: Rewrite each stale page., repositories: [docs], appearance: {icon: doc, color: blue}}
  links: {type: do, name: Check links, description: Check every link of the changed pages., repositories: [docs], appearance: {icon: flag, color: green}}
edges:
  - {from: find, to: rewrite}
  - {from: rewrite, to: links}
`
// Long and mixed-language text: names, a purpose and questions that wrap.
const LONGTEXT = `schema: ag.workflow.v2
id: longtext
name: 長いテキストの確認 — why the nightly synchronisation of very large settings files sometimes fails
intent: |
  夜間の設定同期がときどき失敗する原因を調べ、再現手順と修正案をまとめる。The intent continues in English to check that a long, mixed-language purpose is shortened in the title band without being cut from the panel.
documentation:
  policy: manual
repositories:
  docs: {path: devdocs, access: editable}
nodes:
  investigate: {type: study, name: 既存の設定ファイルの同期処理を調査して失敗する条件を特定する, description: 同期ログと設定ファイルのサイズを照らし合わせ、失敗した夜の共通点を探す。ログが欠けている夜は推測せず、欠けていると記録する。, repositories: [docs]}
  reproduce: {type: do, name: Reproduce the failure with a synthetic 80 MB settings file and a throttled network, description: A long English description that goes on for several lines to check the two-line limit on the card and the full text in the inspector and in the run view's node details., repositories: [docs]}
  ask: {type: talk, name: 修正方針を相談, description: 再現結果を見せて、修正方針を相談する。, repositories: [docs]}
edges:
  - {from: investigate, to: reproduce}
  - {from: reproduce, to: ask}
`
// A larger graph: three lanes that fork and join over eight ranks.
function pipeline(): string {
  const lanes = ['assets', 'engine', 'ui']
  const stages = ['collect', 'design', 'build', 'test']
  const nodes: string[] = [`  intake: {type: study, name: Read the request, description: Read the request and split it into three lanes.}`]
  const edges: string[] = []
  for (const lane of lanes) {
    let prev = 'intake'
    for (const s of stages) {
      const id = `${lane}-${s}`
      nodes.push(`  ${id}: {type: ${s === 'collect' ? 'study' : s === 'test' ? 'do' : 'do'}, name: ${s[0].toUpperCase()}${s.slice(1)} ${lane}, description: ${s} step of the ${lane} lane.}`)
      edges.push(`  - {from: ${prev}, to: ${id}}`)
      prev = id
    }
    edges.push(`  - {from: ${prev}, to: integrate}`)
  }
  nodes.push('  integrate: {type: do, name: Integrate, description: Put the three lanes together.}')
  nodes.push('  review: {type: talk, name: Review with the person, description: Show the integrated result.}')
  nodes.push('  release: {type: do, name: Release, description: Tag and publish.}')
  edges.push('  - {from: integrate, to: review}', '  - {from: review, to: release}')
  return `schema: ag.workflow.v2\nid: pipeline\nname: Large pipeline\nintent: |\n  A larger graph: three parallel lanes, one integration, one review.\ndocumentation:\n  policy: default\nrepositories: {}\nnodes:\n${nodes.join('\n')}\nedges:\n${edges.join('\n')}\n`
}

// ---- the states --------------------------------------------------------------------------

export interface States {
  root: string
  registry: string
  ws: InstanceType<typeof import('../server/workspace.ts').Workspace>
  dir: string
  project: string
  runs: Record<string, RunRef>
  commit: string // the root commit a historical view reads (run-working at an earlier stage)
  op(r: RunRef, i: OpInput & { attempt?: string }, by?: string): Promise<unknown>
  stop(): Promise<void> // stops live presentations
}

export const STATE_TITLES: Record<string, string> = {
  plan: 'Waiting for the plan answer',
  working: 'Work in progress (an attempt is open)',
  review: 'Waiting for the result review (live presentation)',
  answered: 'Answer recorded, not yet taken up',
  held: 'Held: stopped, resumes only when resumed',
  failed: 'Failed: Verify failed, later work is blocked',
  cancelled: 'Cancelled with a presentation still recorded as available',
  accepted: 'Result accepted, cleanup still running',
  completed: 'Completed and accepted (adjusted definition r2)',
  nodecision: 'Completed without a decision (manual policy)',
  branch: 'Branch and join: two open questions',
  large: 'Large graph, not started',
  broken: 'Malformed run.json',
  longtext: 'Long Japanese and English text, an open question',
}

export async function buildStates(root: string, opts: { answerBase: string; ports: [number, number] }): Promise<States> {
  const { createProject } = await import('../server/create.ts')
  const { loadRegistry } = await import('../server/registry.ts')
  const { adjustRun, createRun, registerPresentation, runOp } = await import('../server/runs.ts')
  const { Presenter } = await import('../server/present.ts')
  const { Workspace } = await import('../server/workspace.ts')
  const { gitOk } = await import('../server/git.ts')

  const registry = join(root, 'registry.json')
  const dir = join(root, 'pj-sample')
  const created = await createProject({ dir, id: 'sample', name: 'Sample app', intent: 'A synthetic project for reviewing the editor and run views.', goals: ['Show every state'], sourcesDir: join(root, 'sources'), registryFile: registry })
  if (!created.ok) throw new Error(created.message)
  const wfDir = join(dir, 'devdocs', 'workflows')
  await writeFile(join(wfDir, 'improve.yaml'), IMPROVE)
  await writeFile(join(wfDir, 'explore.yaml'), EXPLORE)
  await writeFile(join(wfDir, 'tidy.yaml'), TIDY)
  await writeFile(join(wfDir, 'pipeline.yaml'), pipeline())
  await writeFile(join(wfDir, 'longtext.yaml'), LONGTEXT)
  await writeFile(join(wfDir, 'broken.yaml'), 'schema: ag.workflow.v2\nid: broken\nname: [unclosed\n')
  // What the presentation serves, and its request-specific explanation.
  await mkdir(join(dir, 'app'), { recursive: true })
  await writeFile(join(dir, 'app', 'index.html'), '<!doctype html><html><head><title>Sample app</title></head><body><h1>Sample app</h1><p id="status">Night mode is on.</p></body></html>\n')
  await writeFile(join(dir, 'review.md'), '# Night mode\n\n## What changed\n\n- A night mode toggle in the settings.\n\n## Please check\n\n- The toggle survives a reload.\n')
  await writeFile(join(root, 'present.json'), JSON.stringify({ ports: opts.ports, answerBase: opts.answerBase }))

  const ws = new Workspace((await loadRegistry(registry)).workspaces[0])
  for (const f of ['improve.yaml', 'explore.yaml']) for (const kind of ['intent', 'definition'] as const) await ws.approve(f, kind, 'Sample Person')
  const executor = { name: 'Sample Agent', backend: 'check-harness' }
  const folder = (r: RunRef) => join(dir, 'devdocs', 'runs', r.workflow, r.run)
  const op = async (r: RunRef, i: OpInput & { attempt?: string }, by?: string) => (await runOp(ws, r, i, { via: 'cli', by: by ?? 'Sample Agent' })).record
  const person = (r: RunRef, i: OpInput) => op(r, i, 'Sample Person')
  const create = async (workflow: string, name: string, text: string) => (await createRun(ws, { workflow, name, input: { kind: 'braindump', text, author: 'Sample Person' }, executor, by: 'Sample Agent', via: 'cli' })).ref
  const work = async (r: RunRef, node: string, outcome: string) => { await op(r, { op: 'node.start', node }); await op(r, { op: 'node.complete', node, outcome }) }
  const doc = async (r: RunRef, step: string, file: string, text: string, outcome: string) => {
    await op(r, { op: 'node.start', node: step })
    await writeFile(join(folder(r), file), text)
    await op(r, { op: 'node.complete', node: step, outcome })
  }
  const report = (r: RunRef, node: string, outcome: string) => doc(r, `_report.${node}`, `report-${node}.md`, `# ${node}\n\n${outcome}\n`, outcome)
  const planAsked = async (r: RunRef) => {
    await op(r, { op: 'node.start', node: '_plan' })
    await writeFile(join(folder(r), 'plan.md'), '# Plan\n\nAdd a night mode toggle to the settings, keep it across reloads, and present it for a check.\n')
    await op(r, { op: 'question.ask', question: '', node: '_plan', text: 'I wrote plan.md: a night mode toggle in the settings, kept across reloads. Shall I go ahead with this plan?', to: 'Sample Person' })
  }
  const planAgreed = async (r: RunRef, q = 'q1') => {
    await planAsked(r)
    await person(r, { op: 'question.answer', question: q, text: 'Yes, go ahead.' })
    await op(r, { op: 'question.take-up', question: q })
    await op(r, { op: 'node.complete', node: '_plan', outcome: 'Plan agreed.', agreement: q })
  }
  const upToPresent = async (r: RunRef, plan = true) => {
    if (plan) await planAgreed(r)
    await work(r, 'implement', 'Added the night mode toggle and stored the choice in local storage.')
    await report(r, 'implement', 'The toggle is in the settings; the choice is stored per browser.')
    await work(r, 'verify', 'Headless tests: 31 of 31 passed. Checked the toggle in the browser.')
    await report(r, 'verify', 'All 31 tests pass; the toggle survives a reload.')
    await op(r, { op: 'node.start', node: 'present' })
    await registerPresentation(ws, r, { node: 'present', source: 'app', entry: 'index.html', review: 'review.md', title: 'Night mode for the settings page' }, { via: 'cli', by: 'Sample Agent' })
  }
  const presenter = new Presenter({ registryFile: registry, area: root })
  const runs: Record<string, RunRef> = {}

  // Waiting for the plan answer.
  runs.plan = await create('improve', 'run-plan', 'Please add a night mode to the settings page.')
  await planAsked(runs.plan)

  // Work in progress: an attempt is open and Verify runs.
  runs.working = await create('improve', 'run-working', 'Add a night mode to the settings page.')
  await planAgreed(runs.working)
  await work(runs.working, 'implement', 'Added the night mode toggle.')
  await report(runs.working, 'implement', 'The toggle is in the settings.')

  // Waiting for the result review, with a live presentation.
  runs.review = await create('improve', 'run-review', 'Night mode, ready for review.')
  await upToPresent(runs.review)
  await presenter.start(ws, runs.review, 'p1')
  await op(runs.review, { op: 'node.complete', node: 'present', outcome: 'Presented p1.' })
  await report(runs.review, 'present', 'Presentation p1 serves the app and review.md.')
  await op(runs.review, { op: 'node.start', node: 'check' })
  await op(runs.review, { op: 'question.ask', question: '', node: 'check', text: 'Please open the review and try the night mode toggle. Accept it, or tell me what to change.', to: 'Sample Person', presentation: 'p1' })

  // An answer recorded, not yet taken up.
  runs.answered = await create('improve', 'run-answered', 'Night mode, plan answered.')
  await planAsked(runs.answered)
  await person(runs.answered, { op: 'question.answer', question: 'q1', text: 'Yes, but keep the toggle near the top of the page.' })

  // Held: stopped with no attempt open.
  runs.held = await create('improve', 'run-held', 'Night mode, held.')
  await planAgreed(runs.held)
  await work(runs.held, 'implement', 'Added the night mode toggle.')
  await report(runs.held, 'implement', 'The toggle is in the settings.')
  await op(runs.held, { op: 'node.start', node: 'verify' })
  await person(runs.held, { op: 'run.stop', reason: 'The tests touch the shared database; look at it before continuing.' })

  // Failed: Verify failed; Present, Human check and Clean up are blocked. Its
  // implement report was recorded and later deleted (a missing file).
  runs.failed = await create('improve', 'run-failed', 'Night mode, failed.')
  await planAgreed(runs.failed)
  await work(runs.failed, 'implement', 'Added the night mode toggle.')
  await report(runs.failed, 'implement', 'The toggle is in the settings.')
  await op(runs.failed, { op: 'node.start', node: 'verify' })
  await op(runs.failed, { op: 'node.fail', node: 'verify', reason: '3 of 31 tests fail: the toggle resets on reload in Safari.' })
  await unlink(join(folder(runs.failed), 'report-implement.md'))

  // Cancelled, while its presentation is still recorded as available but not served.
  runs.cancelled = await create('improve', 'run-cancelled', 'Night mode, cancelled.')
  await upToPresent(runs.cancelled)
  await op(runs.cancelled, { op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-fixture', detail: 'served on this host' })
  await person(runs.cancelled, { op: 'run.cancel', reason: 'The settings page is being replaced; night mode moves to the new page.' })

  // Accepted from the confirmation answer, cleanup still running.
  runs.accepted = await create('improve', 'run-accepted', 'Night mode, accepted.')
  await upToPresent(runs.accepted)
  await op(runs.accepted, { op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-fixture', detail: 'served on this host' })
  await op(runs.accepted, { op: 'node.complete', node: 'present', outcome: 'Presented p1.' })
  await report(runs.accepted, 'present', 'Presentation p1 served the app and review.md.')
  await op(runs.accepted, { op: 'node.start', node: 'check' })
  await op(runs.accepted, { op: 'question.ask', question: '', node: 'check', text: 'Please try the toggle and accept it, or say what to change.', to: 'Sample Person', presentation: 'p1' })
  await person(runs.accepted, { op: 'question.answer', question: 'q2', text: 'Accepted. The toggle works after a reload.' })
  await op(runs.accepted, { op: 'question.take-up', question: 'q2' })
  await op(runs.accepted, { op: 'run.decide', decision: 'accepted', question: 'q2' })
  await op(runs.accepted, { op: 'node.complete', node: 'check', outcome: 'The person accepted the result (q2).' })
  await report(runs.accepted, 'check', 'Accepted in q2.')
  await op(runs.accepted, { op: 'node.start', node: 'cleanup' })

  // Completed and accepted, on an adjusted definition (r2 adds a study before Implement).
  runs.completed = await create('improve', 'run-completed', 'Night mode, completed.')
  await planAgreed(runs.completed)
  const adjusted = IMPROVE.replace('nodes:\n  implement:', 'nodes:\n  research:\n    type: study\n    name: Research contrast\n    description: Compare dark palettes for readable contrast.\n    repositories: [docs]\n  implement:')
    .replace('edges:\n', 'edges:\n  - {from: research, to: implement}\n')
  const adj = await adjustRun(ws, runs.completed, { text: adjusted, reason: 'Check the palette contrast before implementing.', source: { kind: 'person' } }, { via: 'cli', by: 'Sample Person' })
  if (!adj.ok) throw new Error(`adjust: ${JSON.stringify(adj.problems)}`)
  await work(runs.completed, 'research', 'Compared three dark palettes; chose the one with 7:1 contrast.')
  await report(runs.completed, 'research', 'Three palettes compared; 7:1 chosen.')
  await upToPresent(runs.completed, false)
  await op(runs.completed, { op: 'presentation.observe', presentation: 'p1', status: 'available', instance: 'pi-fixture', detail: 'served on this host' })
  await op(runs.completed, { op: 'node.complete', node: 'present', outcome: 'Presented p1.' })
  await report(runs.completed, 'present', 'Presentation p1 served the app and review.md.')
  await op(runs.completed, { op: 'node.start', node: 'check' })
  await op(runs.completed, { op: 'question.ask', question: '', node: 'check', text: 'Please try the toggle and accept it, or say what to change.', to: 'Sample Person', presentation: 'p1' })
  await person(runs.completed, { op: 'question.answer', question: 'q2', text: 'Accepted.' })
  await op(runs.completed, { op: 'question.take-up', question: 'q2' })
  await op(runs.completed, { op: 'run.decide', decision: 'accepted', question: 'q2' })
  await op(runs.completed, { op: 'node.complete', node: 'check', outcome: 'The person accepted the result (q2).' })
  await report(runs.completed, 'check', 'Accepted in q2.')
  await op(runs.completed, { op: 'node.start', node: 'cleanup' })
  await op(runs.completed, { op: 'presentation.observe', presentation: 'p1', status: 'stopped', detail: 'stopped by Clean up; the port is free' })
  await op(runs.completed, { op: 'node.complete', node: 'cleanup', outcome: 'Stopped the review server; nothing listens on its port.' })
  await report(runs.completed, 'cleanup', 'The review server is stopped.')
  await doc(runs.completed, '_final-report', 'report.md', '# Night mode\n\nAdded a night mode toggle to the settings page. All 31 tests pass; the person accepted it in q2.\n', 'Final report written.')

  // Completed without a decision, on a manual workflow; one recorded artifact is missing.
  runs.nodecision = await create('tidy', 'run-tidy', 'Tidy the stale pages.')
  await work(runs.nodecision, 'find', 'Found 4 stale pages.')
  await writeFile(join(dir, 'devdocs', 'stale-pages.md'), '# Stale pages\n\n- setup.md\n- deploy.md\n')
  await op(runs.nodecision, { op: 'node.start', node: 'rewrite' })
  await op(runs.nodecision, { op: 'artifact.attach', path: 'devdocs/stale-pages.md', node: 'rewrite', title: 'The list of stale pages' })
  await op(runs.nodecision, { op: 'artifact.attach', path: 'devdocs/rewrite-notes.md', node: 'rewrite', title: 'Rewrite notes (deleted since)' })
  await op(runs.nodecision, { op: 'node.complete', node: 'rewrite', outcome: 'Rewrote 4 pages.' })
  await work(runs.nodecision, 'links', 'Checked 112 links; all resolve.')

  // Branch and join: Build runs while two questions are open.
  runs.branch = await create('explore', 'run-branch', 'Find a way to sync settings across devices.')
  await planAgreed(runs.branch)
  await work(runs.branch, 'survey', 'Two options: a sync server (A) or the browser account (B).')
  await report(runs.branch, 'survey', 'Option A and option B listed.')
  await op(runs.branch, { op: 'node.start', node: 'build' })
  await op(runs.branch, { op: 'node.start', node: 'ask' })
  await op(runs.branch, { op: 'question.ask', question: '', node: 'ask', text: 'Must option B work without a signed-in browser account?', to: 'Sample Person' })
  await op(runs.branch, { op: 'question.ask', question: '', node: 'build', text: 'May the prototype store test data in the shared staging database?', to: 'Sample Person' })

  // A large graph, not started.
  runs.large = await create('pipeline', 'run-large', 'Ship the three-lane release.')

  // Long, mixed-language text and an open question in Japanese.
  runs.longtext = await create('longtext', 'run-jp', '夜間の設定同期が失敗する原因を調べてください。')
  await work(runs.longtext, 'investigate', '失敗した 6 晩のうち 5 晩で、設定ファイルが 64 MB を超えていた。残りの 1 晩はログが欠けていて判断できない。')
  await work(runs.longtext, 'reproduce', 'Reproduced with an 80 MB file on a network throttled to 2 Mbit/s: the upload times out after 120 s and the partial file is kept as if complete.')
  await op(runs.longtext, { op: 'node.start', node: 'ask' })
  await op(runs.longtext, { op: 'question.ask', question: '', node: 'ask', to: 'Sample Person', text: '再現できました。80 MB の設定ファイルを 2 Mbit/s に絞った回線で送ると、120 秒でタイムアウトし、途中までのファイルが完全なものとして残ります。\n\n修正方針を二つ考えています。(1) 分割アップロードにして、各部分のハッシュを確かめる。(2) 一時ファイルに書いてから置き換える。どちらで進めますか。両方でもかまいません。' })

  // A malformed run.json.
  runs.broken = await create('tidy', 'run-broken', 'A run whose record is damaged.')
  await writeFile(join(folder(runs.broken), 'run.json'), '{"schema": "ag.workflow-run.v2", "nodes": ')

  // Run-working as committed now (a historical view), then moved on.
  await gitOk(dir, ['add', '-A', 'devdocs'])
  await gitOk(dir, ['commit', '-q', '-m', 'states: run-working before Verify'])
  const commit = (await gitOk(dir, ['rev-parse', 'HEAD'])).trim()
  await op(runs.working, { op: 'attempt.begin', attempt: 'at-0002', reason: 'continue after the implement report', backend: 'check-harness' })
  await op(runs.working, { op: 'node.start', node: 'verify', attempt: 'at-0002' })
  await op(runs.working, { op: 'node.progress', node: 'verify', text: 'Running the headless tests (12 of 31).', attempt: 'at-0002' })

  return {
    root, registry, ws, dir, project: 'sample', runs, commit, op,
    stop: async () => { for (const r of [runs.review]) await presenter.stop(ws, r, 'all').catch(() => {}) },
  }
}

// ---- standalone: serve and capture --------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
  const PORT = Number(option('--port', '8210'))
  const shots = args.includes('--shots') ? resolve(option('--shots', '')) : null
  const root = await mkdtemp(join(tmpdir(), 'wfe-states-'))
  await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
  process.env.WFE_LOCK_DIR = join(root, 'locks')
  const { PrivateService } = await import('./bench/service.ts')
  let s: States | undefined
  const service = new PrivateService({ registry: join(root, 'registry.json'), area: root, port: PORT })
  try {
    s = await buildStates(root, { answerBase: `http://127.0.0.1:${PORT}/`, ports: [18800, 18809] })
    await service.start()
    const base = service.base
    console.log(`service ${base}`)
    for (const [k, r] of Object.entries(s.runs)) console.log(`  ${k.padEnd(10)} ${base}/#/ws/sample/run/${r.workflow}/${r.run}  — ${STATE_TITLES[k]}`)
    console.log(`  history    ${base}/#/ws/sample/run/improve/run-working/at/${s.commit}`)
    for (const f of ['improve', 'explore', 'tidy', 'pipeline', 'broken']) console.log(`  workflow   ${base}/#/ws/sample/wf/${f}.yaml`)
    if (shots) {
      const { captureStates } = await import('./statesShots.ts')
      await captureStates(base, s, STATE_TITLES, shots)
    }
    if (args.includes('--serve')) {
      console.log('serving; Ctrl-C stops and removes the data')
      await new Promise<void>(r => { process.once('SIGINT', () => r()); process.once('SIGTERM', () => r()) })
    }
  } finally {
    await s?.stop()
    await service.stop()
    await rm(root, { recursive: true, force: true })
  }
}
