// workflow_editor p8/ex2 step 4: a run grown from its conversation, driven
// through the command line as an executing agent sees it, across two
// attempts (the session ends while the person thinks, a new one resumes).
// The workflow is a talk alone with no generated documents, so the work the
// conversation adds is recorded with the talk's completion (--completing).
// A private area, registry and project; prints a transcript.
//
//   node checks/growth.ts [--keep] [--out <transcript.md>]
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const args = process.argv.slice(2)
const OUT = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : null
const root = await mkdtemp(join(tmpdir(), 'wfe-growth-check-'))
await writeFile(join(root, 'gitconfig'), '[user]\n\tname = Sample Person\n\temail = sample@example.invalid\n[commit]\n\tgpgsign = false\n')
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
process.env.WFE_LOCK_DIR = join(root, 'locks')
const { check, done } = await import('./lib.ts')
const { createProject } = await import('../server/create.ts')

const transcript: string[] = []
const registry = join(root, 'registry.json')
const env = (attempt?: string) => ({ ...process.env, WFE_REGISTRY: registry, WFE_AREA: root, NO_COLOR: '1', ...(attempt ? { WFE_ATTEMPT: attempt } : { WFE_ATTEMPT: '' }) })
// One wfe command, as the person or the executor's session would type it.
function wfe(who: string, argv: string[], attempt?: string, input?: string): { code: number; out: string; json?: unknown } {
  const r = spawnSync(process.execPath, [join(pkg, 'cli', 'wfe.ts'), ...argv], { cwd: join(root, 'pj-demo'), env: env(attempt), encoding: 'utf8', input })
  // The private area's absolute path is printed as <area>.
  const out = `${r.stdout}${r.stderr}`.trim().split(root).join('<area>')
  const shown = argv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ').split(root).join('<area>')
  transcript.push(`**${who}**${attempt ? ` (WFE_ATTEMPT=${attempt})` : ''}: \`wfe ${shown}\``, '', '```text', out.length > 1600 ? `${out.slice(0, 1600)}\n…` : out, '```', '')
  let json: unknown
  try { json = JSON.parse(r.stdout) } catch { /* human output */ }
  return { code: r.status ?? -1, out, json }
}

try {
  const made = await createProject({ dir: join(root, 'pj-demo'), id: 'demo', name: 'Demo', intent: 'A rehearsal project.', goals: [], sourcesDir: join(root, 'sources'), registryFile: registry })
  if (!made.ok) throw new Error(made.message)
  await writeFile(join(root, 'pj-demo', 'devdocs', 'workflows', 'adhoc.yaml'), `schema: ag.workflow.v2
id: adhoc
name: Ad hoc
intent: Start from the braindump and grow the work in conversation.
documentation:
  policy: custom
  plan: false
  reports: false
  final: false
nodes:
  talk:
    type: talk
    name: Talk
    description: Understand the request, hold the consultation it needs, and make the next work concrete.
`)
  await writeFile(join(root, 'braindump.md'), 'I need a tiny script that counts words in a file. Ask me what you need.\n')

  const req = wfe('Person', ['request', 'adhoc', '--braindump', join(root, 'braindump.md'), '--author', 'Sample Person', '--workspace', 'demo', '--json'])
  const run = ((req.json as { ref?: { workflow: string; run: string } })?.ref)
  check(req.code === 0 && run, `the request creates the run and queues it: ${req.out.split('\n')[0]}`)
  const R = `${run!.workflow}/${run!.run}`

  // ---- attempt A: the talk asks; the session ends while the person thinks
  const a = (wfe('executor', ['exec', 'claim']).json as { attempt?: { id: string } }).attempt!.id
  wfe('executor', ['exec', 'started', a, '--pid', String(process.pid)])
  check(wfe('session A', ['run', 'start', R, 'talk'], a).code === 0, 'session A starts the talk')
  check(wfe('session A', ['run', 'ask', R, 'talk', '--question', 'Which file types, and should it count lines too?', '--to', 'Sample Person'], a).code === 0, 'session A asks; the talk waits on the person')
  wfe('executor', ['exec', 'finished', a, '--exit-code', '0'])

  // ---- the person answers; the run resumes in a new session
  const ans = wfe('Person', ['run', 'answer', R, 'q1', '--answer', 'Plain text only. Yes, lines too — then show me the counts for README.md.'])
  check(ans.code === 0 && /resumes the run/.test(ans.out), 'the answer queues the resumption')
  const b = (wfe('executor', ['exec', 'claim']).json as { attempt?: { id: string } }).attempt!.id
  wfe('executor', ['exec', 'started', b, '--pid', String(process.pid)])
  check(wfe('session A', ['run', 'progress', R, 'talk', '--note', 'late'], a).code !== 0, 'the ended session A records nothing more (fenced)')
  check(wfe('session B', ['run', 'take-up', R, 'q1'], b).code === 0, 'session B takes the answer up; the talk runs again')

  // The work the conversation agreed, as a draft of the definition in force.
  const shown = wfe('session B', ['run', 'revisions', R, '--show', 'r1'], b)
  const draft = `${shown.out.trim()}\n  count:\n    type: do\n    name: Count words and lines\n    description: Write count.py (words and lines of a plain-text file) and run it on README.md.\n  show:\n    type: talk\n    name: Show the counts\n    description: Show the counts for README.md and ask whether anything else is wanted.\nedges:\n  - {from: talk, to: count}\n  - {from: count, to: show}\n`
  await writeFile(join(root, 'r2.yaml'), draft)
  const plain = wfe('session B', ['run', 'adjust', R, '--definition', join(root, 'r2.yaml'), '--reason', 'q1 agreed the script and a showing', '--source', 'answer:q1', '--dry-run'], b)
  check(plain.code !== 0 && /mid-node/.test(plain.out), 'a plain adjustment while the talk runs is refused (mid-node)')
  const dry = wfe('session B', ['run', 'adjust', R, '--definition', join(root, 'r2.yaml'), '--reason', 'q1 agreed the script and a showing', '--source', 'answer:q1', '--completing', 'talk', '--outcome', 'Agreed: words and lines, plain text; show README.md counts.', '--dry-run'], b)
  check(dry.code === 0 && /Applicable/.test(dry.out), 'the same with --completing is applicable (dry run)')
  const applied = wfe('session B', ['run', 'adjust', R, '--definition', join(root, 'r2.yaml'), '--reason', 'q1 agreed the script and a showing', '--source', 'answer:q1', '--completing', 'talk', '--outcome', 'Agreed: words and lines, plain text; show README.md counts.', '--receipt', 'session-b-adjust-1'], b)
  check(applied.code === 0 && /talk completed with it/.test(applied.out) && /ready: count/.test(applied.out), 'applied: r2 in force, the talk completed with it, count ready')
  const retry = wfe('session B', ['run', 'adjust', R, '--definition', join(root, 'r2.yaml'), '--reason', 'q1 agreed the script and a showing', '--source', 'answer:q1', '--completing', 'talk', '--outcome', 'Agreed: words and lines, plain text; show README.md counts.', '--receipt', 'session-b-adjust-1'], b)
  check(retry.code === 0 && /Already recorded/.test(retry.out), 'a retransmission (same receipt) records nothing again')
  wfe('session B', ['run', 'start', R, 'count'], b)
  wfe('session B', ['run', 'complete', R, 'count', '--outcome', 'count.py written; README.md: 12 words, 3 lines.'], b)
  wfe('session B', ['run', 'start', R, 'show'], b)
  wfe('session B', ['run', 'ask', R, 'show', '--question', 'README.md has 12 words and 3 lines. Anything else?', '--to', 'Sample Person'], b)
  wfe('executor', ['exec', 'finished', b, '--exit-code', '0'])
  wfe('Person', ['run', 'answer', R, 'q2', '--answer', 'That is all, thanks.'])
  const c = (wfe('executor', ['exec', 'claim']).json as { attempt?: { id: string } }).attempt!.id
  wfe('executor', ['exec', 'started', c, '--pid', String(process.pid)])
  wfe('session C', ['run', 'take-up', R, 'q2'], c)
  // Nothing more to add: the last completion ends the run as before.
  const last = wfe('session C', ['run', 'complete', R, 'show', '--outcome', 'Counts shown; nothing else wanted.'], c)
  check(last.code === 0, 'the last talk completes with nothing added')
  wfe('executor', ['exec', 'finished', c, '--exit-code', '0'])
  const fin = wfe('Person', ['run', 'show', R, '--history'])
  check(/completed/i.test(fin.out.split('\n').slice(0, 6).join(' ')), 'the run is completed')
  const rec = JSON.parse(await readFile(join(root, 'pj-demo', 'devdocs', 'runs', run!.workflow, run!.run, 'run.json'), 'utf8'))
  check(rec.execution.state === 'completed' && rec.definition.active === 'r2', 'run.json: completed, r2 in force')
  check(JSON.stringify(rec.history.map((h: { op: string }) => h.op).slice(-12)).includes('"run.adjust","node.complete"'), 'the history has the adjustment directly followed by the talk\'s completion')
  check(wfe('Person', ['run', 'check', R]).out.includes('usable'), 'wfe run check: usable')
  if (OUT) await writeFile(OUT, `# Rehearsal transcript (checks/growth.ts)\n\nA synthetic project; "session A/B/C" are attempts claimed from the exec store, driven by this script as the executing agent would.\n\n${transcript.join('\n')}`)
} catch (e) {
  if (OUT) await writeFile(OUT, transcript.join('\n'))
  throw e
} finally {
  if (!args.includes('--keep')) await rm(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
done()
