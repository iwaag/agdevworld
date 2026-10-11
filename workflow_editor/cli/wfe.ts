#!/usr/bin/env node
// wfe — the workflow editor's command-line surface. A thin client of the same
// modules the service uses (server/*, shared/*); it never goes through the
// service, so no command needs it running. `wfe help` is the index.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Diagnostic, RepositoryStatus, WorkflowSummary } from '../shared/api.ts'
import { autoArrange } from '../shared/layout.ts'
import { APPROVAL_KINDS, type ApprovalKind, type Issue } from '../shared/model.ts'
import { addNewRepository, createProject } from '../server/create.ts'
import { addSharedRepository, createSharedRepository, dashboard, obtainWorkspace, registerGiteaProject, registerSharedRepository, type AgdevContext } from '../server/agdev.ts'
import { Gitea, GiteaError, loadGiteaSetting } from '../server/gitea.ts'
import { REPO_CATEGORIES, type RepoCategory } from '../server/registry.ts'
import { existsSync, readFileSync } from 'node:fs'
import { ExecStore } from '../server/exec.ts'
import { loadRegistry, observe, registerWorkspace, RegistryError, unregisterProject, workspaceAt, type Registration } from '../server/registry.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { listRuns } from '../server/runs.ts'
import { setupArea } from './setup.ts'
import { runCommand, runIndex } from './run.ts'
import { codeVersion } from '../server/version.ts'
import { assertNotRetired, assertWorkspaceAllowed, loadBoundary, retiredByUrl } from '../server/boundary.ts'

const here = dirname(fileURLToPath(import.meta.url))
// The editor package (agdevworld/workflow_editor, or an installed release of it).
export const PACKAGE = resolve(here, '..')
export const CONTRACT = join(PACKAGE, 'docs', 'contract.md')
export const RUN_CONTRACT = join(PACKAGE, 'docs', 'runs.md')

class UsageError extends Error {}
class Refused extends Error { detail?: unknown; constructor(m: string, detail?: unknown) { super(m); this.detail = detail } }

// ---- arguments ---------------------------------------------------------------

interface Parsed { positional: string[]; opts: Map<string, string[]>; flags: Set<string> }
const FLAGS = new Set(['json', 'help', 'resume', 'h', 'new', 'history', 'no-gitea', 'reuse', 'lost', 'uncertain', 'found', 'complete', 'not-posted'])
function parse(argv: string[]): Parsed {
  const p: Parsed = { positional: [], opts: new Map(), flags: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { p.positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--') || a === '-h' || a === '-w') {
      const [k, inline] = a === '-h' ? ['help'] : a === '-w' ? ['workspace'] : a.slice(2).split(/=(.*)/s, 2)
      if (FLAGS.has(k)) { p.flags.add(k); continue }
      const v = inline ?? argv[++i]
      if (v === undefined) throw new UsageError(`--${k} needs a value`)
      p.opts.set(k, [...(p.opts.get(k) ?? []), v])
    } else p.positional.push(a)
  }
  return p
}
const opt = (p: Parsed, k: string) => p.opts.get(k)?.at(-1)

// ---- context -----------------------------------------------------------------

const devdocsMode = (p: Parsed) => {
  const m = opt(p, 'devdocs') ?? 'directory'
  if (m !== 'directory' && m !== 'submodule') throw new UsageError('--devdocs is directory or submodule')
  return m
}
// The registry is always chosen explicitly (an area's launcher sets
// WFE_REGISTRY): a default relative to the code would open a different, empty
// catalog whenever the code moves.
const registryFile = (p: Parsed) => {
  const file = opt(p, 'registry') ?? process.env.WFE_REGISTRY
  if (!file) throw new UsageError('no registry chosen: pass --registry <file> or set WFE_REGISTRY (an area\'s wfe launcher sets it)')
  return resolve(file)
}
const areaDir = (p: Parsed) => resolve(opt(p, 'area') ?? process.env.WFE_AREA ?? dirname(registryFile(p)))
const giteaFile = (p: Parsed) => resolve(opt(p, 'gitea') ?? process.env.WFE_GITEA ?? join(dirname(registryFile(p)), 'gitea.json'))
// The Gitea of this registry: its setting beside the registry (or --gitea /
// WFE_GITEA). Absent means local-only operation.
async function giteaOf(p: Parsed): Promise<Gitea | undefined> {
  const file = giteaFile(p)
  if (!existsSync(file)) return undefined
  try { return new Gitea(await loadGiteaSetting(file)) } catch (e) { throw new Refused((e as Error).message) }
}
async function agdevCtx(p: Parsed): Promise<AgdevContext> {
  const gitea = await giteaOf(p)
  // The execution host's state from this area's store, as the service reads
  // it, so `wfe dashboard` and the browser say the same; no store, no executor.
  const store = join(areaDir(p), '.local', 'exec', 'exec.sqlite')
  const executor = existsSync(store) ? async () => { const x = new ExecStore({ registryFile: registryFile(p), area: areaDir(p) }); try { return x.executorState() } finally { x.close() } } : undefined
  return { registryFile: registryFile(p), area: areaDir(p), gitea, giteaProblem: gitea ? undefined : `no Gitea setting at ${giteaFile(p)}`, executor }
}
const ownerName = (text: string | undefined, what: string) => {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(text ?? '')
  if (!m) throw new UsageError(`${what} must be <owner>/<name>`)
  return { owner: m[1], name: m[2].replace(/\.git$/, '') }
}
const port = (p: Parsed) => Number(opt(p, 'port') ?? process.env.WFE_PORT ?? 8095)

async function workspace(p: Parsed): Promise<Workspace> {
  const reg = await loadRegistry(registryFile(p))
  const id = opt(p, 'workspace')
  let w: Registration | undefined
  if (id) {
    w = reg.workspaces.find(x => x.id === id)
    if (!w) throw new Refused(`workspace "${id}" is not registered in ${registryFile(p)} (see: wfe list)`)
  } else {
    w = await workspaceAt(reg, process.cwd())
    if (!w) throw new Refused(`the current directory is not inside a registered workspace; pass --workspace <id> (see: wfe list), or register it (wfe register)`)
  }
  await assertWorkspaceAllowed(await loadBoundary(registryFile(p), areaDir(p)), w, 'Opening')
  const o = await observe(w)
  if (!o.available) throw new Refused(`workspace "${w.id}" is registered but not available: ${o.reason}`)
  return new Workspace(w)
}

async function workflowFile(ws: Workspace, name: string): Promise<string> {
  const { list } = await ws.workflowSummaries()
  const hit = list.find(s => s.file === name) ?? list.find(s => s.file === `${name}.yaml` || s.file === `${name}.yml`) ?? list.find(s => s.id === name)
  if (!hit) throw new Refused(`no workflow "${name}" in ${ws.root}/devdocs/workflows (by file name or id); see: wfe status`)
  return hit.file
}

async function serviceState(p: Parsed): Promise<{ url: string; running: boolean; sameRegistry?: boolean; registry?: string }> {
  const url = `http://127.0.0.1:${port(p)}`
  try {
    const r = await fetch(`${url}/api/workspaces`, { signal: AbortSignal.timeout(800) })
    const body = await r.json() as { registry?: { path?: string } }
    return { url, running: true, sameRegistry: body.registry?.path === registryFile(p), registry: body.registry?.path }
  } catch { return { url, running: false } }
}

// ---- output ------------------------------------------------------------------

let json = false
const out = (human: string, data: unknown) => { console.log(json ? JSON.stringify(data, null, 2) : human) }
const short = (h?: string | null) => (h ? h.slice(0, 7) : '—')
const diag = (d: Diagnostic) => `  ${d.severity === 'error' ? 'error  ' : 'warning'} ${d.message}${d.fix ? `\n           fix: ${d.fix}` : ''}`
const issueLine = (i: Issue) => `  ${i.severity === 'error' ? 'error  ' : 'warning'} ${i.code.padEnd(26)} ${i.message}`
function repoLine(r: RepositoryStatus) {
  const parts = [r.path.padEnd(22), r.category.padEnd(8)]
  if (r.kind === 'directory') return `  ${[...parts, 'folder of the project root', ...(r.dirty ? [`${r.dirty} uncommitted`] : [])].join('  ')}`
  if (!r.initialized) parts.push('not initialized')
  else parts.push(`${r.branch ?? 'detached'} @ ${short(r.head)}`)
  if (r.kind === 'submodule' && r.recorded) parts.push(`recorded ${short(r.recorded)}${r.staged ? `, staged ${short(r.staged)}` : ''}${r.matchesRecorded === false ? ' (HEAD differs)' : ''}`)
  if (r.dirty) parts.push(`${r.dirty} uncommitted`)
  if (r.publication?.ahead) parts.push(`${r.publication.ahead} unpublished`)
  if (r.error) parts.push(`error: ${r.error}`)
  return `  ${parts.join('  ')}`
}
function workflowLine(w: WorkflowSummary) {
  if (w.problem) return `  ${w.file.padEnd(24)} cannot be read: ${w.problem.kind}: ${w.problem.message}`
  const ap = w.approvals ? `intent ${w.approvals.intent}, definition ${w.approvals.definition}` : ''
  return `  ${w.file.padEnd(24)} id ${w.id}  "${w.name}"  ${w.errors} error${w.errors === 1 ? '' : 's'}, ${w.warnings} warning${w.warnings === 1 ? '' : 's'}  ${ap}`
}

// ---- help --------------------------------------------------------------------

const HELP: Record<string, string> = {
  create: `wfe create <dir> --name <name> [--id <id>] [--intent <text>] [--goal <text>]... [--devdocs directory|submodule] [--devdocs-source <path|url>] [--resume]

Creates a new project and registers it as a workspace. With a Gitea setting
(gitea.json beside the registry, --gitea or WFE_GITEA) the repositories are
created on Gitea, the initial commits are pushed (devdocs first), and the
project and its repositories are registered too; --no-gitea, or no setting,
makes a local project that is pushed nowhere.
  Writes  <dir>/ as a new Git repository with project.yaml (ag.project.v2),
          .gitignore (.local/), an empty .local/, and devdocs/: a directory of
          the root repository (--devdocs directory, the default) or a
          submodule (--devdocs submodule). The mode is fixed for the project.
  Source  devdocs comes from a new local repository <area>/sources/<id>-devdocs.git
          (or --sources <dir>), or from --devdocs-source. A local source is
          recorded as a URL relative to <dir>, so the area can move as a whole.
  Commits two commits with your Git identity (user.name/user.email): the new
          devdocs source's initial commit (README.md, workflows/) and the
          project root's initial commit. Nothing is pushed. If the identity is
          missing, nothing is created.
  Refuses a <dir> that exists and is not empty; it never overwrites.
  --id    stable project id (default: <dir>'s name without "pj-")
  --resume continues a creation that stopped partway (it left
          <dir>/.local/wfe-create.json); finished steps are kept, nothing is deleted.
Result: the steps done or kept, the commits, the workspace id, and any
structure diagnostics. Exit 0 created; 1 refused or stopped (the message says
what exists and how to continue).`,
  register: `wfe register [<dir>] [--id <id>] [--label <text>]

Records the Git root containing <dir> (default: the current directory) in the
registry, so the editor and the other commands can use it.
  Changes only the registry file; other entries are kept. Registering the same
          root again changes nothing and reports the existing id.
  --id    workspace id (default: the project id from project.yaml)
Result: registered / already-registered / refused, plus diagnostics for what
the project structure lacks (project.yaml, devdocs submodule, .gitignore …),
each with its fix. Exit 0 registered or already registered; 1 refused.`,
  list: `wfe list

Lists the registered workspaces and what is observed now: available or not
(and why), project id and name, branch and HEAD. Reads only.`,
  status: `wfe status [--workspace <id>]

Shows one workspace: project id, name, intent and goals; structure diagnostics;
every repository with Git state (branch or detached HEAD, recorded/staged
gitlink, uncommitted entries, not initialized); every workflow with its id,
validation counts and approval states; every run with its execution state and
what waits for whom; and whether the editor service is running. Reads only. The workspace is the one containing the current
directory unless --workspace is given.`,
  validate: `wfe validate [<workflow>] [--workspace <id>]

Validates one workflow (file name or id) or all of them with the same rules as
the editor (docs/contract.md, "Validation"). Reads only.
Result: each issue as severity, code and message. Exit 0 when there are no
errors (warnings allowed); 1 when a workflow has errors or cannot be read.
Validation checks structure and references; it is not an approval.`,
  approve: `wfe approve <workflow> <intent|definition> --approver <name>

Records an approval of the saved file, exactly as the editor's Approve buttons
do: the digest of the current intent (or definition), the declared approver
and the time are written into the workflow's approvals.
  Refuses a definition with validation errors, an empty intent, or a file that
          cannot be read.
  --approver is required: the name of the person who approves. The approver
          is declared, not authenticated; passing validation is not an approval.
Exit 0 recorded; 1 refused.`,
  arrange: `wfe arrange <workflow>

Auto-arrange: replaces layout.nodes with positions computed by rank, the same
algorithm as the editor's Auto-arrange button, and saves the file. Every
stored position is replaced, including cards someone placed by hand; to place
one new card only, write its layout.nodes entry (or leave it out: nodes
without a position are laid out automatically). Only layout changes;
approvals are unaffected. Refuses a file that cannot be read.`,
  'add-repo': `wfe add-repo <path> <location> [--workspace <id>]
wfe add-repo <path> --new [--workspace <id>]

Adds a Git submodule at <path> (for example study/evals or wedo/runtime), the
same operation as the project view's "Add submodule": git submodule add.
  <location>  an existing repository. A relative location resolves against the
          project's origin, or against the project root when it has no remote.
  --new   creates a new local repository first:
          <area>/sources/<project id>-<path with / as ->.git with a README and
          an initial commit (your Git identity), recorded as a URL relative to
          the project root.
Local file transport is enabled for this command only. The submodule is
staged in the project root, not committed.
Exit 0 added; 1 failed (what Git left behind is reported; nothing is reset).`,
  workflow: `wfe workflow new <id> [--name <name>] [--policy default|manual] [--workspace <id>]

Creates devdocs/workflows/<id>.yaml with the editor's template (schema, id,
name, empty intent, no nodes, documentation policy --policy, default
"default"), as the project view's "New workflow" does. Under the default
policy a run plans, reports each node and reports the whole (docs/contract.md,
"Documentation policy"); manual leaves documents to explicit instructions.
Refuses an id already used by another workflow file. Writing the file by hand
is equally valid; see docs/contract.md.`,
  request: `wfe request <workflow> --braindump <file|-> --author <person> [--receipt <id>] [--workspace <id>]

A person's request to the executor (autolab): creates the run with their
words as braindump.md and queues its start. The same receipt twice queues
once. Refused while another run of the executor holds the workspace (it has
begun and has not completed or been cancelled); use another workspace.`,
  exec: `wfe exec <subcommand> …   (the executor's interface; JSON output)

claim [--backend <text>]          take the next queued job if the slot is free:
                                  records attempt.begin; prints the attempt,
                                  workspace, run and a brief for its prompt
started <attempt> --pid <pid>     the attempt's process is running
finished <attempt> --exit-code <n> [--signal <name>] [--lost]
                                  how it ended; records attempt.end, publishes
                                  the checkpoint, queues a resume if an answer
                                  already waits
stops                             attempts to terminate (stop or cancel requested)
heartbeat --pid <pid> [--name …] [--detail …]
reconcile                         after a restart: gone processes become
                                  "unknown"; requests and answers that were not
                                  queued are queued again under their receipts
publish <checkpoint id>           retry a publication; finished steps are kept
status [<run>]                    the executor, or one run's attempts, jobs and
                                  checkpoints
State is <area>/.local/exec/exec.sqlite (this host only).`,
  notify: `wfe notify <subcommand> …   (Zulip coordination; the transport's interface, protocol 2)

status [<run>]                    targets (folders, channels), runs, the sender,
                                  and delivery state, or one run's binding
outbox [<project>/<workflow>/<run>]  events and the delivery each belongs to
deliveries [<project>/<workflow>/<run>]  frozen messages: state, claim, attempts,
                                  where they were sent, what established absence
due                               scan the records, then what to provision (JSON)
claim --sender <owner> --pid <n>  take the sender role (refused while another
                                  sender's process lives) and hand out at most one
                                  delivery per run (JSON). A delivery is frozen
                                  when first handed out: its events, text, marker
                                  and destination never change; new events wait
begin <delivery> --claim <c> --stream <n> --channel <name> --topic <name>
      [--checked-absent <evidence>]  recorded before the POST; a delivery that
                                  may have been posted needs the evidence that it
                                  was not
sent <delivery> --claim <c> --message <n> --stream <n> --channel <name> --topic <name> [--found]
                                  posted (or found by its marker): the delivery and
                                  its events are sent; repeating it is harmless
failed <delivery> --claim <c> --error <text> [--uncertain]
                                  retried later with the same payload; --uncertain:
                                  the answer was lost or the search was incomplete
legacy <delivery> --claim <c> --found-json <[{event, message, stream, channel, topic}]>
      [--complete] [--error <text>]  result of reconciling pre-p5/ex1 uncertain events
resolve <delivery> --message <n> | --not-posted  --by <name>
                                  a person's reconciliation when the transport
                                  cannot establish whether it was posted
import-inflight --id <event id>… [--marker <text>]
                                  the old transport's inflight.json: its events
                                  are reconciled before anything else of the run
sender [--release <owner>]        who delivers; release a sender whose process is
                                  gone or on another host
protocol                          the transport protocol this release speaks
target <key> --zulip-id <n> | --problem <text>
moved <project>/<workflow>/<run> --stream <n> --channel <name> --topic <name>
run-problem <project>/<workflow>/<run> --problem <text>
reset <key>                       the repair path: forget a binding (a deleted
                                  channel, a taken name, a duplicate run) so it
                                  is provisioned again; deliveries that may have
                                  been posted are still looked for where they went
Keys: folder:<project>, channel:<project>/<workflow>, <project>/<workflow>/<run>.
Every --event <id> given to begin/sent/failed must equal the delivery's events.
Configuration: <area>/zulip.json {enabled, zulipUrl, viewBase, since[, person]};
state: <area>/.local/notify/notify.sqlite. Nothing here posts: autolab's
agautolab.wfnotify does, with its own credentials.`,
  project: `wfe project register <owner>/<name>
wfe project obtain <project id>
wfe project unregister <project id>

register  records a project root that exists on Gitea (its project.yaml must be
          ag.project.v2), its devdocs repository in submodule mode, and the
          project, in the registry. Only the registry changes.
obtain    clones a registered project with its submodules from Gitea into the
          area (pj-<id>, or pj-<id>-2 … when taken) and registers that
          workspace. An existing folder is never reused or overwritten.
unregister removes the project, its workspaces and its root repository entry
          from the registry, and nothing else: folders and Gitea stay. Refused
          while a workspace of it has a queued job or an open attempt.
Needs the Gitea setting (gitea.json beside the registry, --gitea or WFE_GITEA).`,
  repo: `wfe repo register <owner>/<name> --category study|wedo|other|devdocs
wfe repo create <name> --category study|wedo|other [--description <text>]
wfe repo add <owner>/<name>|gitea:<id> <path> [--workspace <id>]

register  records a Gitea repository by its Gitea id; it needs no project.
create    creates a repository under the configured owner with a README and
          registers it. A same-named repository with content is refused.
add       adds a registered repository to this workspace's project as a
          submodule at <path>, with a URL relative to the project on Gitea.
          Staged, not committed. Other projects keep their pinned revisions.`,
  dashboard: `wfe dashboard

The agdev dashboard as text: every registered project (where its definition
was read, its workspaces here, ongoing runs and waits) and every shared
repository (Gitea state, the projects that use it). Facts that could not be
read are said so, never listed as empty. Reads only.`,
  version: `wfe version

The code this command runs: the package directory (symbolic links resolved)
and, for an installed release, RELEASE.json: the agdevworld commit it was
built from. The service reports the same at GET api/version. Reads only; no
registry is needed.`,
  serve: `wfe serve [--port <port>]

Starts the editor service for this registry in the foreground: it builds the
UI, then serves the UI and API on http://127.0.0.1:<port>/ (default 8095, or
WFE_PORT). Stop it with Ctrl-C. Browser-created projects go beneath the
authoring area. Open views follow file changes without a reload.`,
  setup: `wfe setup <area> [--port <port>]

Creates or refreshes an authoring area: <area>/AGENTS.md (from the tracked
template), START.md, <area>/wfe (a launcher that pins this area's registry and
port), an empty registry if none exists, and sources/. It never creates or
changes a project or a run, keeps an existing registry, the projects and
everything else in the area, and keeps a generated file whose first-line stamp
was removed. Prints the directory, the tool, the service command, the URL, a
first authoring prompt and the prompt for executing a workflow.`,
}

function index(p: Parsed): string {
  return `wfe — create and register Git-backed projects; inspect, validate, approve and arrange their workflows.

Usage: wfe <command> [options]        wfe help <command>   (or <command> --help)

Projects and workspaces
  create <dir> --name …     create a project (on Gitea when configured) and register it
  register [<dir>]          register an existing project's Git root
  list                      registered workspaces and what is observed
  status                    project, repositories (Git state), workflows, editor service
  add-repo <path> <loc>     add a Git submodule (git submodule add); --new creates a local repository
  project register|obtain   a project on Gitea: register it here, or clone a workspace of it
  repo register|create|add  shared repositories on Gitea, and adding one to this project
  dashboard                 every project and shared repository, with where each fact was read
  request <workflow> …      a person's request to the executor (autolab): a run, queued
  exec <subcommand>         the executor's interface: claim, started, finished, stops, reconcile …
  notify <subcommand>       Zulip coordination: status, deliveries, claim, resolve … (autolab delivers)

Workflows (by file name or id)
  workflow new <id>         create devdocs/workflows/<id>.yaml from the template
  validate [<workflow>]     validation issues
  approve <wf> <kind>       record an intent or definition approval by a named approver
  arrange <workflow>        auto-arrange the layout

Runs (docs/runs.md; wfe run help)
  run create <workflow> …   create a run: the input, a fixed copy of the definition, run.json
  run list | show | check   runs, one run in full, record checks
  run start | complete | …  record node starts, waits, questions, answers, outcomes

Editor
  serve                     start the editor (UI and API) for this registry
  setup <area>              create or refresh an authoring area and its AGENTS.md
  version                   the code this command runs (an installed release names its agdevworld commit)

Options: --workspace <id> (default: the workspace containing the current directory),
         --json (structured output), --registry <file>, --area <dir>
Registry: ${registryFile(p)}
File contract (project.yaml, workflow YAML, validation, approvals): ${CONTRACT}
Run contract (run folders, run.json, states, questions): ${RUN_CONTRACT}
No command needs the editor service. Definition files may also be edited directly;
an open editor view follows the change. Exit codes: 0 ok, 1 refused or errors, 2 usage.`
}

// ---- commands ----------------------------------------------------------------

async function cmdCreate(p: Parsed): Promise<number> {
  const gitea = p.flags.has('no-gitea') ? undefined : await giteaOf(p)
  const [dirArg] = p.positional
  if (!dirArg) throw new UsageError('create needs a destination directory')
  const name = opt(p, 'name')
  if (!name) throw new UsageError('create needs --name')
  const dir = resolve(dirArg)
  const id = opt(p, 'id') ?? dir.split('/').pop()!.replace(/^pj-/, '')
  const r = await createProject({
    dir, id, name, intent: opt(p, 'intent') ?? '', goals: p.opts.get('goal') ?? [],
    sourcesDir: resolve(opt(p, 'sources') ?? join(areaDir(p), 'sources')),
    devdocs: devdocsMode(p), devdocsSource: opt(p, 'devdocs-source'), registryFile: registryFile(p), resume: p.flags.has('resume'),
    gitea, reuse: p.flags.has('reuse'),
  })
  const lines = [r.message, ...r.steps.map(s => `  ${s.status.padEnd(6)} ${s.name}: ${s.detail}`)]
  if (r.commits.length) lines.push('Commits:', ...r.commits.map(c => `  ${short(c.commit)} ${c.message} (${c.repository})`))
  if (r.diagnostics?.length) lines.push('Structure:', ...r.diagnostics.map(diag))
  if (r.ok) lines.push(`Next: cd ${r.root}; write workflows in devdocs/workflows/ (wfe workflow new <id>); wfe status`)
  out(lines.join('\n'), r)
  return r.ok ? 0 : 1
}

async function cmdRegister(p: Parsed): Promise<number> {
  const r = await registerWorkspace(registryFile(p), resolve(p.positional[0] ?? '.'), { id: opt(p, 'id'), label: opt(p, 'label'), area: areaDir(p) })
  out([r.message, ...(r.diagnostics.length ? ['Structure:', ...r.diagnostics.map(diag)] : [])].join('\n'), r)
  return r.ok ? 0 : 1
}

async function cmdList(p: Parsed): Promise<number> {
  const reg = await loadRegistry(registryFile(p))
  const rows = await Promise.all(reg.workspaces.map(async w => ({ ...w, observed: await observe(w) })))
  const human = !reg.exists ? `No registry yet at ${registryFile(p)}; create or register a project.`
    : rows.length === 0 ? 'No workspaces registered.'
      : rows.map(w => `${w.id.padEnd(16)} ${w.observed.available ? 'available' : 'unavailable'}  ${w.observed.available
        ? `project ${w.observed.projectId ?? '?'} "${w.observed.projectName ?? ''}"  ${w.observed.branch ?? 'detached'} @ ${short(w.observed.head)}${w.observed.reason ? `  (${w.observed.reason})` : ''}`
        : w.observed.reason}\n${' '.repeat(17)}${w.path}`).join('\n')
  out(human, { registry: registryFile(p), exists: reg.exists, workspaces: rows })
  return 0
}

async function cmdStatus(p: Parsed): Promise<number> {
  const ws = await workspace(p)
  const r = await ws.projectResponse()
  const svc = await serviceState(p)
  const runs = await listRuns(ws)
  const pr = r.project
  const lines = [
    `Workspace ${ws.reg.id}: ${ws.root}`,
    pr ? `Project ${pr.id} "${pr.name}"` : `project.yaml: ${r.problem?.message}`,
    ...(pr ? [`Intent: ${pr.intent.trim() || '(empty)'}`, 'Goals:', ...(pr.goals.length ? pr.goals.map(g => `  - ${g}`) : ['  (none)'])] : []),
    r.structure.length ? 'Structure:' : 'Structure: complete', ...r.structure.map(diag),
    'Repositories:', ...r.repositories.map(repoLine),
    `Workflows (devdocs/workflows):${r.workflowsDir.exists ? '' : ` ${r.workflowsDir.reason}`}`,
    ...(r.workflows.length ? r.workflows.map(w => workflowLine(w) + (svc.running && svc.sameRegistry ? `\n${' '.repeat(27)}${svc.url}/#/ws/${encodeURIComponent(ws.reg.id)}/wf/${encodeURIComponent(w.file)}` : '')) : ['  (none)']),
    `Runs (devdocs/runs/<workflow>/<run>/; wfe run show <run>):`,
    ...(runs.length ? runs.map(s => `  ${s.ref.padEnd(30)} ${s.problem ? `cannot be used: ${s.problem.message}` : `${s.execution}${s.waiting?.length ? `; waiting: ${s.waiting.map(w => `${w.node} (next move: ${w.holder})`).join(', ')}` : ''}${s.ready?.length ? `; ready: ${s.ready.join(', ')}` : ''}`}${svc.running && svc.sameRegistry ? `\n${' '.repeat(33)}${svc.url}/#/ws/${encodeURIComponent(ws.reg.id)}/run/${s.workflow}/${s.run}` : ''}`) : ['  (none)']),
    svc.running ? `Editor: running at ${svc.url}/${svc.sameRegistry ? `#/ws/${encodeURIComponent(ws.reg.id)}` : ` — but it serves ${svc.registry ? `another registry (${svc.registry})` : 'another registry or an older version'}; start this one with: wfe serve --port <free port>`}`
      : `Editor: not running at ${svc.url} (start it with: wfe serve)`,
  ]
  out(lines.join("\n"), { ...r, workspace: ws.reg.id, root: ws.root, runs, editor: svc })
  return 0
}

async function cmdValidate(p: Parsed): Promise<number> {
  const ws = await workspace(p)
  const files = p.positional[0] ? [await workflowFile(ws, p.positional[0])] : await ws.workflowFiles()
  const results = []
  for (const f of files) {
    const r = await ws.workflowResponse(f)
    results.push({ file: f, id: r.workflow?.id, problem: r.problem, issues: r.issues })
  }
  const bad = results.filter(r => r.problem || r.issues.some(i => i.severity === 'error')).length
  const human = results.length === 0 ? 'No workflows in devdocs/workflows.' : results.map(r =>
    `${r.file}${r.id ? ` (id ${r.id})` : ''}: ${r.problem ? `cannot be read — ${r.problem.kind}: ${r.problem.message}${r.problem.line ? ` (line ${r.problem.line})` : ''}`
      : r.issues.length ? `${r.issues.filter(i => i.severity === 'error').length} errors, ${r.issues.filter(i => i.severity === 'warning').length} warnings\n${r.issues.map(issueLine).join('\n')}` : 'valid'}`).join('\n')
  out(human, { workspace: ws.reg.id, ok: bad === 0, workflows: results })
  return bad ? 1 : 0
}

async function cmdApprove(p: Parsed): Promise<number> {
  const [name, kind] = p.positional
  if (!name || !kind) throw new UsageError('approve needs <workflow> and <intent|definition>')
  if (!(APPROVAL_KINDS as readonly string[]).includes(kind)) throw new UsageError('the kind is intent or definition')
  const approver = opt(p, 'approver')
  if (!approver?.trim()) throw new UsageError('approve needs --approver <name>: the person who approves')
  const ws = await workspace(p)
  const file = await workflowFile(ws, name)
  try {
    const r = await ws.approve(file, kind as ApprovalKind, approver)
    out(`Recorded ${kind} approval of ${file} by ${approver.trim()}: ${r.state.status} (${r.state.digest})`, { ok: true, file, kind, approver: approver.trim(), state: r.state })
    return 0
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(`approval refused: ${e.message}`, e.detail)
    throw e
  }
}

async function cmdArrange(p: Parsed): Promise<number> {
  const [name] = p.positional
  if (!name) throw new UsageError('arrange needs <workflow>')
  const ws = await workspace(p)
  const file = await workflowFile(ws, name)
  const read = await ws.readWorkflowFile(file)
  if (!read.workflow || read.text === null) throw new Refused(`${file} cannot be arranged: ${read.problem?.message ?? 'unreadable'}`)
  const next = structuredClone(read.workflow)
  autoArrange(next)
  try {
    const saved = await ws.saveWorkflow(file, next)
    const changed = saved.text !== read.text
    out(`${changed ? 'Arranged' : 'Already arranged'}: ${file} (${Object.keys(next.layout.nodes).length} positions)`, { ok: true, file, changed, layout: next.layout })
    return 0
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    throw e
  }
}

async function cmdAddRepo(p: Parsed): Promise<number> {
  const [path, location] = p.positional
  const fresh = p.flags.has('new')
  if (!path || (!location && !fresh) || (location && fresh)) throw new UsageError('add-repo needs <path> and either <location> or --new')
  const ws = await workspace(p)
  try {
    if (location) assertNotRetired(retiredByUrl(await loadBoundary(registryFile(p), areaDir(p)), location), `Adding ${location} as a submodule`)
    const r = fresh ? await addNewRepository(ws, path, join(areaDir(p), 'sources')) : await ws.addSubmodule(path, location)
    const lines = [r.message, ...(r.stderr ? [r.stderr] : [])]
    if (r.partial) lines.push(`Left behind — .gitmodules entry: ${r.partial.gitmodulesEntry}; path exists: ${r.partial.pathExists}; staged: ${r.partial.staged}; module git dir: ${r.partial.gitDirExists}`)
    out(lines.join('\n'), r)
    return r.ok ? 0 : 1
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message)
    throw e
  }
}

async function cmdWorkflow(p: Parsed): Promise<number> {
  const [sub, id] = p.positional
  if (sub !== 'new' || !id) throw new UsageError('usage: wfe workflow new <id> [--name <name>] [--policy default|manual]')
  const ws = await workspace(p)
  try {
    const r = await ws.createWorkflow(id, opt(p, 'name') ?? '', opt(p, 'policy') ?? 'default')
    const path = join(ws.root, 'devdocs', 'workflows', r.file)
    out(`Created ${path}. Fill in intent, repositories, nodes and edges (docs/contract.md).`, { ok: true, file: r.file, path })
    return 0
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message)
    throw e
  }
}

async function cmdSetup(p: Parsed): Promise<number> {
  const [dir] = p.positional
  if (!dir) throw new UsageError('setup needs the area directory')
  const r = await setupArea(resolve(dir), { port: port(p) })
  out(r.summary, r)
  return r.files.some(f => f.status === 'error') ? 1 : 0
}

async function cmdServe(p: Parsed): Promise<number> {
  const build = spawn(process.execPath, [join(PACKAGE, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: PACKAGE, stdio: 'inherit' })
  const built = await new Promise<number>(r => build.on('exit', c => r(c ?? 1)))
  if (built !== 0) { console.error('wfe serve: building the UI failed; run npm ci in the editor package first'); return 1 }
  const child = spawn(process.execPath, [join(PACKAGE, 'server', 'main.ts'), '--serve-dist', '--port', String(port(p)), '--registry', registryFile(p), '--area', areaDir(p)], { stdio: 'inherit' })
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => child.kill(s))
  return new Promise<number>(r => child.on('exit', c => r(c ?? 0)))
}

async function cmdRun(p: Parsed): Promise<number> {
  await openExec(p)
  return runCommand({
    positional: p.positional,
    opt: k => opt(p, k),
    opts: k => p.opts.get(k) ?? [],
    flag: k => p.flags.has(k),
    workspace: () => workspace(p),
    out,
    usage: m => new UsageError(m),
    refused: (m, detail) => new Refused(m, detail),
    serviceUrl: async () => { const s = await serviceState(p); return s.running && s.sameRegistry ? s.url : null },
    exec: () => execStore!,
  }).finally(() => { execStore?.close(); execStore = undefined })
}

let execStore: ExecStore | undefined
async function openExec(p: Parsed): Promise<ExecStore> {
  execStore ??= new ExecStore({ registryFile: registryFile(p), area: areaDir(p), gitea: await giteaOf(p) })
  return execStore
}

// The executor's interface to this host's execution management. Every
// subcommand prints JSON; the rules are in server/exec.ts and shared/run.ts.
async function cmdExec(p: Parsed): Promise<number> {
  const [sub, arg] = p.positional
  const x = await openExec(p)
  json = true
  const num = (k: string) => { const v = opt(p, k); if (v === undefined || !/^-?\d+$/.test(v)) throw new UsageError(`--${k} <integer> is required`); return Number(v) }
  try {
    switch (sub) {
      case 'claim': out('', await x.claim(opt(p, 'backend') ?? null)); return 0
      case 'started': if (!arg) throw new UsageError('started <attempt> --pid <pid>'); x.started(arg, num('pid')); out('', { ok: true }); return 0
      case 'finished': {
        if (!arg) throw new UsageError('finished <attempt> --exit-code <n> [--signal <name>]')
        const code = opt(p, 'exit-code') !== undefined ? num('exit-code') : null
        const r = await x.finished(arg, { code, signal: opt(p, 'signal') ?? null, lost: p.flags.has('lost') })
        out('', { ok: true, ...r }); return 0
      }
      case 'stops': out('', x.stopsDue().map(a => ({ id: a.id, pid: a.pid, run: `${a.workflow}/${a.run}`, workspace: a.workspace, requested: a.stop_requested }))); return 0
      case 'heartbeat': x.heartbeat(opt(p, 'name') ?? 'autolab', num('pid'), opt(p, 'detail') ?? ''); out('', { ok: true }); return 0
      case 'reconcile': out('', { ok: true, notes: await x.reconcile() }); return 0
      case 'publish': { if (!arg) throw new UsageError('publish <checkpoint id>'); out('', await x.publishCheckpoint(Number(arg))); return 0 }
      case 'status': {
        const ws = await workspace(p)
        if (!arg) { out('', { executor: x.executorState() }); return 0 }
        const ref = await import('../server/runs.ts').then(m => m.resolveRef(ws, arg))
        out('', x.runView(ws.reg.id, ref)); return 0
      }
    }
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    throw e
  } finally { x.close(); execStore = undefined }
  throw new UsageError('wfe exec claim|started|finished|stops|heartbeat|reconcile|publish|status')
}

// Zulip coordination: the outbox and bindings of this host, for the
// transport (autolab) and for people. Rules are in server/notify.ts.
async function cmdNotify(p: Parsed): Promise<number> {
  const [sub, arg] = p.positional
  const { NotifyStore, NOTIFY_PROTOCOL } = await import('../server/notify.ts')
  const x = await openExec(p)
  const n = new NotifyStore({ area: areaDir(p), registryFile: registryFile(p), exec: x })
  const num = (k: string) => { const v = opt(p, k); if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`--${k} <integer> is required`); return Number(v) }
  const need = (k: string) => { const v = opt(p, k); if (!v?.trim()) throw new UsageError(`--${k} is required`); return v }
  const ids = () => { const v = p.opts.get('id') ?? []; if (!v.length) throw new UsageError('--id <event id> is required (repeatable)'); return v }
  const delivery = () => { if (!arg || !/^\d+$/.test(arg)) throw new UsageError(`${sub} <delivery id> --claim <claim> …`); return Number(arg) }
  const events = () => p.opts.get('event')
  const dest = () => ({ streamId: num('stream'), channel: need('channel'), topic: need('topic') })
  try {
    switch (sub) {
      case 'protocol': json = true; out('', { protocol: NOTIFY_PROTOCOL }); return 0
      case 'due': json = true; out('', await n.due()); return 0
      case 'claim': json = true; out('', await n.claim({ owner: need('sender'), pid: num('pid') })); return 0
      case 'target': {
        if (!arg) throw new UsageError('target <key> --zulip-id <n> | --problem <text>')
        n.recordTarget(arg, opt(p, 'zulip-id') !== undefined ? { zulipId: num('zulip-id') } : { problem: need('problem') })
        out(`Recorded ${arg}.`, { ok: true }); return 0
      }
      case 'begin': n.begin(delivery(), need('claim'), { destination: dest(), checkedAbsent: opt(p, 'checked-absent'), events: events() }); out('Begun: from now on it may have been posted.', { ok: true }); return 0
      case 'sent': {
        if (p.opts.has('id')) throw new UsageError('sent takes a delivery id and its claim (protocol 2); --id is the old protocol: update agautolab.wfnotify')
        const r = n.acknowledge(delivery(), need('claim'), { messageId: num('message'), destination: dest(), found: p.flags.has('found'), events: events() })
        out(r === 'recorded' ? 'Recorded as sent.' : 'Already recorded as this message.', { ok: true, result: r }); return 0
      }
      case 'failed': {
        if (p.opts.has('id')) throw new UsageError('failed takes a delivery id and its claim (protocol 2); --id is the old protocol: update agautolab.wfnotify')
        n.fail(delivery(), need('claim'), need('error'), p.flags.has('uncertain'), { events: events() }); out('Recorded the failure; the same delivery is retried later.', { ok: true }); return 0
      }
      case 'legacy': {
        let found: { event: string; message: number; stream: number; channel: string; topic: string }[]
        try { found = JSON.parse(opt(p, 'found-json') ?? '[]') } catch { throw new UsageError('--found-json must be a JSON list') }
        n.legacy(delivery(), need('claim'), { found: found.map(f => ({ event: f.event, messageId: f.message, destination: { streamId: f.stream, channel: f.channel, topic: f.topic } })), complete: p.flags.has('complete'), error: opt(p, 'error') })
        out('Recorded.', { ok: true }); return 0
      }
      case 'resolve': {
        const how = p.flags.has('not-posted') ? { notPosted: true as const } : { messageId: num('message') }
        const note = n.resolve(delivery(), how, need('by')); out(note, { ok: true, note }); return 0
      }
      case 'import-inflight': { const notes = n.importInflight({ ids: ids(), marker: opt(p, 'marker') }); out(notes.join('\n') || 'Nothing to import.', { ok: true, notes }); return 0 }
      case 'sender': {
        const release = opt(p, 'release')
        if (release) { const note = n.releaseSender(release); out(note, { ok: true, note }); return 0 }
        const s = n.sender() ?? null
        out(s ? `Sender: ${s.owner} (pid ${s.pid} on ${s.host}, since ${s.since}, last claim ${s.seen})` : 'No sender has claimed yet.', s); return 0
      }
      case 'deliveries': {
        const rows = n.deliveries(arg)
        out(rows.length ? rows.map(d => `${String(d.id).padStart(4)} ${d.state.padEnd(10)} ${d.run_key} ${d.kind === 'legacy' ? '(legacy) ' : ''}${(JSON.parse(d.events) as string[]).map(e => e.slice(e.indexOf('#'))).join(' ')}${d.message_id ? ` → message ${d.message_id}` : ''}${d.attempts ? `  ${d.attempts} send(s)` : ''}${d.uncertain || d.state === 'sending' ? '  MAY HAVE BEEN POSTED' : ''}${d.last_error ? `  last error: ${d.last_error}` : ''}${d.problem ? `  ${d.problem}` : ''}`).join('\n') : 'No deliveries.', rows)
        return 0
      }
      case 'moved': if (!arg) throw new UsageError('moved <run key> …'); n.recordMoved(arg, { streamId: num('stream'), channel: need('channel'), topic: need('topic') }); out('Recorded where the topic is now.', { ok: true }); return 0
      case 'run-problem': if (!arg) throw new UsageError('run-problem <run key> --problem <text>'); n.recordRunProblem(arg, need('problem')); out('Recorded.', { ok: true }); return 0
      case 'reset': if (!arg) throw new UsageError('reset <key>'); { const notes = n.reset(arg); out(notes.join('\n'), { ok: true, notes }) } return 0
      case 'outbox': {
        const rows = n.outbox(arg)
        out(rows.length ? rows.map(r => `${r.state.padEnd(7)} ${r.id}${r.delivery ? `  (delivery ${r.delivery})` : ''}${r.message_id ? ` → message ${r.message_id}` : ''}${r.last_error ? `  (before p5/ex1: ${r.attempts} attempt(s); ${r.last_error}${r.uncertain ? '; may have been posted' : ''})` : ''}`).join('\n') : 'The outbox is empty.', rows)
        return 0
      }
      case 'status': {
        const cfg = n.config()
        if (arg) {
          const ws = await workspace(p)
          const ref = await import('../server/runs.ts').then(m => m.resolveRef(ws, arg))
          const project = (await ws.readProject()).project?.id ?? ''
          const st = n.runStatus(project, ref)
          out(!st.configured ? `Zulip coordination is not configured${st.problem ? `: ${st.problem}` : ''}.` : [
            `Topic: ${st.topic ? `${st.topic.channel} › ${st.topic.topic}${st.topic.url ? ` (${st.topic.url})` : ''}` : 'none yet'}`,
            `Delivery: ${st.pending} pending, ${st.failed} failed${st.uncertain ? ' (may have been posted; looked for before any retry)' : ''}${st.lastSent ? `; last sent ${st.lastSent}` : ''}${st.lastError ? `; last error: ${st.lastError}` : ''}`,
            ...(st.provisioning ? [`Provisioning: ${st.provisioning}`] : []), ...(st.problem ? [`Problem: ${st.problem}`] : []), ...(st.skipped ? [`Not announced: ${st.skipped}`] : []),
            `Answer link: ${st.viewBase ?? 'none configured — messages say to answer on the execution host'}`,
          ].join('\n'), st)
          return 0
        }
        await n.scan()
        const o = n.overview(), problems = n.problems(), notes = n.notes()
        out([
          `Configuration: ${!cfg ? 'none (no zulip.json)' : 'problem' in cfg ? cfg.problem : `${cfg.enabled ? 'enabled' : 'disabled'}, ${cfg.zulipUrl}, answer link ${cfg.viewBase ?? 'none (remote readers are told to answer on the execution host)'}, announcing runs created since ${cfg.since}`}`,
          'Targets:', ...o.targets.map(t => `  ${t.key.padEnd(44)} ${t.state.padEnd(11)} ${t.name}${t.zulip_id ? ` (#${t.zulip_id})` : ''}${t.problem ? ` — ${t.problem}` : ''}`),
          'Runs:', ...o.runs.map(r => `  ${r.key.padEnd(44)} ${r.skipped ? 'not announced' : r.problem ? 'PROBLEM' : `${r.pending} pending, ${r.failed} failed${r.uncertain ? ', 1 may have been posted' : ''}`}${r.topic ? `  topic ${r.channel} › ${r.topic}` : ''}${r.problem ? ` — ${r.problem}` : ''}`),
          `Sender: ${o.sender ? `${o.sender.owner} (pid ${o.sender.pid} on ${o.sender.host}, last claim ${o.sender.seen})` : 'none yet'}`,
          ...(problems.length ? ['Problems:', ...problems.map(x => `  ${x}`)] : []),
          ...(notes.length ? ['Notes:', ...notes.map(x => `  ${x.at} ${x.note}`)] : []),
        ].join('\n'), { config: cfg, ...o, problems, notes })
        return 0
      }
    }
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    if (e instanceof UsageError) throw e
    throw new Refused((e as Error).message)
  } finally { n.close(); x.close(); execStore = undefined }
  throw new UsageError('wfe notify status|outbox|deliveries|due|claim|begin|sent|failed|legacy|resolve|import-inflight|sender|protocol|target|moved|run-problem|reset')
}

// A person's request: their words become the run's braindump.md, and the
// executor is queued.
async function cmdRequest(p: Parsed): Promise<number> {
  const [workflow] = p.positional
  if (!workflow) throw new UsageError('request needs a workflow')
  const file = opt(p, 'braindump'); if (!file) throw new UsageError('--braindump <file|-> is required: the person\'s words')
  const author = opt(p, 'author'); if (!author) throw new UsageError('--author <person> is required')
  const receipt = opt(p, 'receipt') ?? `cli-${Date.now()}-${process.pid}`
  const ws = await workspace(p)
  const x = await openExec(p)
  try {
    const text = readFileSync(file === '-' ? 0 : resolve(file), 'utf8')
    const r = await x.request({ workspace: ws.reg.id, workflow, text, author, receipt, by: opt(p, 'by'), via: 'cli' })
    out(`${r.duplicate ? 'Already requested (same receipt)' : 'Requested'}: run ${r.ref.workflow}/${r.ref.run} in ${ws.reg.id}; job ${r.job.id} is ${r.job.state}.`, r)
    return 0
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    throw e
  } finally { x.close(); execStore = undefined }
}

async function agdevRun(f: () => Promise<{ ok: boolean; message: string } & Record<string, unknown>>): Promise<number> {
  try {
    const r = await f()
    const steps = (r.steps as { name: string; status: string; detail: string }[] | undefined) ?? []
    out([r.message, ...steps.map(s => `  ${s.status.padEnd(6)} ${s.name}: ${s.detail}`)].join('\n'), r)
    return r.ok ? 0 : 1
  } catch (e) {
    if (e instanceof RequestError || e instanceof GiteaError) throw new Refused(e.message)
    throw e
  }
}

async function cmdProject(p: Parsed): Promise<number> {
  const [sub, arg] = p.positional
  const ctx = await agdevCtx(p)
  if (sub === 'register') return agdevRun(() => { const o = ownerName(arg, '<repository>'); return registerGiteaProject(ctx, o.owner, o.name) })
  if (sub === 'obtain') { if (!arg) throw new UsageError('obtain needs a project id'); return agdevRun(() => obtainWorkspace(ctx, arg)) }
  if (sub === 'unregister') {
    if (!arg) throw new UsageError('unregister needs a project id')
    const reg = await loadRegistry(registryFile(p))
    const ids = reg.workspaces.filter(w => w.project === arg).map(w => w.id)
    const x = await openExec(p)
    try {
      const pending = x.pendingFor(ids)
      if (pending.jobs.length || pending.attempts.length) throw new Refused(`project "${arg}" has unfinished execution here (${pending.attempts.map(a => `attempt ${a.id} ${a.state}`).concat(pending.jobs.map(j => `job ${j.id} ${j.state}`)).join(', ')}); stop or cancel it first (wfe run stop/cancel), then unregister`, pending)
    } finally { x.close(); execStore = undefined }
    const r = await unregisterProject(registryFile(p), arg)
    out([`Unregistered project ${r.project.id}.`, ...r.workspaces.map(w => `  workspace ${w.id} (${w.path}; the folder is kept)`), ...r.repositories.map(e => `  repository ${e.key} ${e.gitea.owner}/${e.gitea.name} (on Gitea it is kept)`)].join('\n'), { ok: true, ...r })
    return 0
  }
  throw new UsageError('wfe project register <owner>/<name> | obtain <project id> | unregister <project id>')
}

async function cmdRepo(p: Parsed): Promise<number> {
  const [sub, arg, path] = p.positional
  const ctx = await agdevCtx(p)
  const cat = () => { const c = opt(p, 'category'); if (!REPO_CATEGORIES.includes(c as RepoCategory)) throw new UsageError(`--category is one of ${REPO_CATEGORIES.filter(x => x !== 'root').join(', ')}`); return c as RepoCategory }
  if (sub === 'register') return agdevRun(() => { const o = ownerName(arg, '<repository>'); return registerSharedRepository(ctx, o.owner, o.name, cat()) })
  if (sub === 'create') { if (!arg) throw new UsageError('create needs a name'); return agdevRun(() => createSharedRepository(ctx, arg, cat(), opt(p, 'description') ?? '')) }
  if (sub === 'add') {
    if (!arg || !path) throw new UsageError('add needs <repository> <path>')
    const ws = await workspace(p)
    const reg = await loadRegistry(registryFile(p))
    const key = arg.startsWith('gitea:') ? arg : reg.repositories.find(r => `${r.gitea.owner}/${r.gitea.name}` === arg)?.key
    if (!key) throw new Refused(`${arg} is not a registered repository (see: wfe dashboard)`)
    return agdevRun(async () => { const r = await addSharedRepository(ctx, ws, key, path); return { ...r, message: r.ok ? `${r.message} (URL ${r.url})` : r.message } })
  }
  throw new UsageError('wfe repo register <owner>/<name> --category … | create <name> --category … [--description …] | add <repository> <path>')
}

async function cmdDashboard(p: Parsed): Promise<number> {
  const d = await dashboard(await agdevCtx(p))
  const lines = [`Gitea: ${d.gitea.state}${d.gitea.url ? ` ${d.gitea.url} (owner ${d.gitea.owner})` : ''}${d.gitea.error ? ` — ${d.gitea.error}` : ''}`, `Execution host: ${d.executor.state}${d.executor.detail ? ` — ${d.executor.detail}` : ''}`, '', 'Projects:']
  if (!d.projects.length) lines.push('  (none registered)')
  for (const pr of d.projects) {
    lines.push(`  ${pr.id.padEnd(20)} ${pr.name ?? '?'}  root ${pr.root.fullName ?? pr.root.key}${pr.root.error ? ` (${pr.root.error})` : ''}  devdocs ${pr.devdocs ?? '?'}`)
    lines.push(`  ${' '.repeat(20)} definition ${pr.definition.error ? `NOT READ (${pr.definition.source}): ${pr.definition.error}` : `read from ${pr.definition.source}`}`)
    if (!pr.workspaces.length) lines.push(`  ${' '.repeat(20)} no workspace on this host (wfe project obtain ${pr.id})`)
    for (const w of pr.workspaces) lines.push(`  ${' '.repeat(20)} workspace ${w.id}: ${w.available ? (w.runs ? `${w.runs.ongoing} ongoing, ${w.runs.waitingOnPerson} waiting` : `runs not read: ${w.runsError}`) : `unavailable: ${w.reason}`}`)
  }
  lines.push('', 'Repositories:')
  if (!d.repositories.length) lines.push('  (none registered)')
  for (const r of d.repositories) {
    lines.push(`  ${(r.gitea.fullName ?? `${r.registered.owner}/${r.registered.name}`).padEnd(36)} ${r.category.padEnd(8)} ${r.key}${r.gitea.state !== 'ok' ? `  [${r.gitea.state}${r.gitea.error ? `: ${r.gitea.error}` : ''}]` : ''}`)
    lines.push(`  ${' '.repeat(36)} used by: ${r.usedBy.length ? r.usedBy.map(u => `${u.project} (${u.path})`).join(', ') : 'none'}${r.usageUnknown.length ? `; unknown for ${r.usageUnknown.map(u => u.project).join(', ')}` : ''}`)
  }
  if (d.unlinkedWorkspaces.length) lines.push('', 'Workspaces without a registered project:', ...d.unlinkedWorkspaces.map(w => `  ${w.id}`))
  out(lines.join('\n'), d)
  return 0
}

const COMMANDS: Record<string, (p: Parsed) => Promise<number>> = {
  run: cmdRun, project: cmdProject, repo: cmdRepo, dashboard: cmdDashboard, exec: cmdExec, request: cmdRequest, notify: cmdNotify,
  create: cmdCreate, register: cmdRegister, list: cmdList, status: cmdStatus, validate: cmdValidate,
  approve: cmdApprove, arrange: cmdArrange, 'add-repo': cmdAddRepo, workflow: cmdWorkflow, serve: cmdServe, setup: cmdSetup,
  version: cmdVersion,
}

async function cmdVersion(): Promise<number> {
  const v = codeVersion()
  out(v.release ? `release of agdevworld ${v.release.agdevworld} (built ${v.release.built})\n${v.package}` : `source checkout (no RELEASE.json)\n${v.package}`, v)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  let p: Parsed
  try { p = parse(argv) } catch (e) { console.error(`wfe: ${(e as Error).message}`); return 2 }
  json = p.flags.has('json')
  const [cmd, ...rest] = p.positional
  if (!cmd || cmd === 'help' || (!cmd && p.flags.has('help'))) {
    const topic = cmd === 'help' ? rest[0] : undefined
    if (topic === 'run') console.log(runIndex())
    else if (topic && HELP[topic]) console.log(HELP[topic])
    else if (topic) { console.error(`wfe: no command "${topic}"\n`); console.log(index(p)); return 2 }
    else console.log(index(p))
    return 0
  }
  if (!COMMANDS[cmd]) { console.error(`wfe: no command "${cmd}" (see: wfe help)`); return 2 }
  if (p.flags.has('help') && cmd !== 'run') { console.log(HELP[cmd]); return 0 }
  p.positional = rest
  try {
    return await COMMANDS[cmd](p)
  } catch (e) {
    if (e instanceof UsageError) { console.error(`wfe ${cmd}: ${e.message}\n\n${cmd === 'run' ? 'See: wfe run help <subcommand>' : HELP[cmd]}`); return 2 }
    if (e instanceof RequestError && !(e instanceof Refused)) e = new Refused(e.message, e.detail)
    if (e instanceof Refused || e instanceof RegistryError) {
      const detail = (e as Refused).detail
      if (json) console.log(JSON.stringify({ ok: false, error: e.message, detail }, null, 2))
      else {
        console.error(`wfe ${cmd}: ${e.message}`)
        if (Array.isArray(detail)) for (const i of detail as Issue[]) console.error(issueLine(i))
      }
      return 1
    }
    throw e
  }
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url) } catch { return false } })()
if (invoked) process.exitCode = await main(process.argv.slice(2))
