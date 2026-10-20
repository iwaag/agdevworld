#!/usr/bin/env node
// wfe — the workflow editor's command-line surface. A thin client of the same
// modules the service uses (server/*, shared/*); it never goes through the
// service, so no command needs it running. `wfe help` is the index.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Diagnostic, RepositoryStatus, WorkflowSummary } from '../shared/api.ts'
import { autoArrange } from '../shared/layout.ts'
import { APPROVAL_KINDS, DOC_STEPS, type ApprovalKind, type Documentation, type Issue } from '../shared/model.ts'
import { addNewRepository, createProject } from '../server/create.ts'
import { addSharedRepository, createSharedRepository, dashboard, obtainWorkspace, registerGiteaProject, registerSharedRepository, type AgdevContext } from '../server/agdev.ts'
import { Gitea, GiteaError, loadGiteaSetting } from '../server/gitea.ts'
import { REPO_CATEGORIES, type RepoCategory } from '../server/registry.ts'
import { existsSync, readFileSync } from 'node:fs'
import { ExecStore } from '../server/exec.ts'
import { StoreError } from '../server/sqlite.ts'
import { loadRegistry, observe, registerWorkspace, RegistryError, unregisterProject, workspaceAt, type Registration } from '../server/registry.ts'
import { RequestError, Workspace } from '../server/workspace.ts'
import { listRuns } from '../server/runs.ts'
import { setupArea } from './setup.ts'
import { runCommand, runIndex } from './run.ts'
import { NODES_HELP, nodesCommand } from './nodes.ts'
import { PROJECTS_HELP, projectsCommand } from './projects.ts'
import { CONTEXT_HELP, contextCommand } from './context.ts'
import { CONVERSATION_HELP, conversationCommand } from './conversation.ts'
import { codeVersion } from '../server/version.ts'
import { assertNotRetired, assertWorkspaceAllowed, loadBoundary, retiredByUrl } from '../server/boundary.ts'

const here = dirname(fileURLToPath(import.meta.url))
// The editor package (agdevworld/workflow_editor, or an installed release of it).
export const PACKAGE = resolve(here, '..')
export const CONTRACT = join(PACKAGE, 'docs', 'contract.md')
export const RUN_CONTRACT = join(PACKAGE, 'docs', 'runs.md')

let remoteLocal = false
class UsageError extends Error {}
class Refused extends Error { detail?: unknown; constructor(m: string, detail?: unknown) { super(m); this.detail = detail } }

// ---- arguments ---------------------------------------------------------------

interface Parsed { positional: string[]; opts: Map<string, string[]>; flags: Set<string> }
const FLAGS = new Set(['json', 'help', 'resume', 'h', 'new', 'history', 'no-gitea', 'reuse', 'lost', 'uncertain', 'found', 'complete', 'not-posted', 'ok', 'about-plan', 'all', 'dry-run', 'commit', 'push', 'status', 'rebuild', 'allow-live-executor', 'terminal', 'missing', 'retire', 'upstream', 'published', 'regex', 'ignore-case', 'refresh', 'quick', 'verify-all', 'rendered', 'delivered', 'undelivered', 'partial']) // p7: present stop --all, run adjust --dry-run
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
  const ws = new Workspace(w)
  // Delegate targets in the other registered projects (p10).
  ws.peers = async () => (await import('../server/peers.ts')).registryPeers(registryFile(p), areaDir(p), w!.project)
  return ws
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
  if (r.kind === 'directory') return `  ${[...parts, r.path === 'devdocs' ? 'folder of the project root' : 'local area (folder of the project root)', ...(r.path !== 'devdocs' && !r.initialized && !r.error ? ['folder missing'] : []), ...(r.dirty ? [`${r.dirty} uncommitted`] : []), ...(r.error ? [`error: ${r.error}`] : [])].join('  ')}`
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
  boast: `wfe boast [status] <project> [--source worktree] [--workspace <id>] [--refresh]
wfe boast reference

boast/index.html is the page displayed in the Project Editor's Boast area.
It can freely introduce the project's capabilities and outputs using HTML,
CSS and JavaScript. Related files can live in the same directory.

status     whether the page is published on the project's main (or, with
           --source worktree, in a workspace's working tree), the commit,
           and the addresses where the Project Editor and the page open
reference  the optional technical reference (docs/boast.md): paths,
           publication sources, media, browser capabilities, messages`,
  nodes: NODES_HELP,
  context: CONTEXT_HELP,
  conversation: CONVERSATION_HELP,
  projects: PROJECTS_HELP,
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
  observe: `wfe observe [--json] [--workspace <id>] [--run [<workspace>:]<workflow>/<run>]... [--terminal]

A read-only snapshot of every run this host knows (observer p3,
docs/observation.md, schema ag.wfe-observation.v1): each run's identity
(uid = <project>/<workflow>/<run>#<creation>), where its live record is and
whether it read consistently, its situation, hold (human or not), attempts,
the attempt's process (alive, process group CPU, log: last write, turns,
session, an open tool call with its declared timeout, background tasks the
harness stopped), its queue position and the work ahead of it, open questions
and answers not taken up, what it waits for and whose move it is, the agent's
last report, recoveries, and publication or integration problems; and the
executor (heartbeat age, the slot, queued jobs).
  Reads   the registry, each run through its own copy, the executor store
          (one read transaction per run), attempt logs and one ps call.
  Changes nothing: no reconcile, no queueing, no copy, no record, no post.
  --run         only these runs (repeatable); listed even when settled
  --terminal    also completed or cancelled runs with nothing outstanding
                (by default they are left out; absence never means finished)
Exit 0 with the document; 1 when the registry cannot be read.`,
  runs: `wfe runs index [--rebuild] [--workspace <id>]
wfe runs migrate [--dry-run] [--workspace <id>] --by <name> [--allow-live-executor]

migrate (p9): moves runs recorded in a project workspace before p9 into
working copies of their own, without changing what they mean. --dry-run
prints the inventory and changes nothing: each run's state, hold, open
attempt, queued jobs, unpublished checkpoints and open presentations, the
action, each repository's head and the uncommitted files. Otherwise the
recovery copies are taken first (<area>/.local/backups/p9-migrate-…), then
each non-terminal run the execution host performs gets its copy under its own
id, its folder as it is now, and run.relocate. Nothing is queued, resumed or
announced; checkpoints keep their mode; completed, cancelled and IDE runs
stay where they are; uncommitted files outside run folders are reported, not
moved. Refused while the executor reports (stop it first). Running it again
continues an interrupted migration (journal <area>/.local/migrations/p9.json)
and changes nothing that is done.

index:

The runs of this workspace that have their own working copy (p9): each one's
state (ready, creating, damaged, rebuilt) and branch. Reads only, unless
--rebuild: a copy whose manifest (copy.json) is missing is given one
reconstructed from the copy itself — the run branch it has checked out and
the storage its run.json records. Nothing is cloned, checked out, restarted or
deleted; a copy whose repository is gone stays reported (its saved work is on
its branch). Exit 0 when every copy is usable; 1 when one is damaged.`,
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
  workflow: `wfe workflow new <id> [--name <name>] [--policy default|manual|custom [--steps plan,reports,final]] [--template <id>] [--workspace <id>]
wfe workflow show <workflow> [--workspace <id>]
wfe workflow save <workflow> --file <yaml|-> --base <rev> [--workspace <id>]

show prints the definition file as it is on disk and its revision (the
content hash the editor shows). save writes a changed definition the way the
editor's Save does — the file only, never a commit — after checking that the
file is still at --base: a file someone changed since (in the editor or on
disk) is not overwritten; the refusal names its current revision (exit 1,
code definition-conflict), so read it again and reapply the change. The new
text must parse as a workflow (ag.workflow.v2); the file's own comments and
key order are kept where the model did not change. Validation issues are
reported, never a reason to refuse (wfe validate); approvals are records
(wfe approve).

wfe workflow basics [--dry-run] [--commit [--push]] [--workspace <id> | --all]

Adds the basic workflows (today: freework — one talk; the run adds the work
agreed in the conversation) to a project that lacks them. Its bindings and
execution are resolved from the project's valid workflows (the most
permissive access one of them already grants each path; the agent, profile
and guides all of them agree on); a project without any gets its root
editable and the rest readonly. A workflow with the id, or a file with the
name, is never replaced: present, conflict (exit 1), unplaceable. --all
goes through every registered workspace, once per project (and per shared
devdocs repository): the others are reported as covered. --dry-run lists
what would be added with the resolved settings. --commit commits only the
added file (and the root's gitlink in submodule mode); --push pushes it when
the branch has an upstream.

Creates devdocs/workflows/<id>.yaml from a template (--template, default
"empty": schema, id, name, empty intent, no nodes; documentation policy
--policy, default the template's), as the project view's "Create workflow"
does. --policy custom takes --steps: the generated documents to keep, any of
plan, reports, final, comma-separated ("none" for none).
\`wfe workflow templates\` lists the templates. Under the default
policy a run plans, reports each node and reports the whole (docs/contract.md,
"Documentation policy"); manual leaves documents to explicit instructions.
Refuses an id already used by another workflow file. Writing the file by hand
is equally valid; see docs/contract.md.`,
  request: `wfe request <workflow> --braindump <file|-> --author <person> [--predecessor <run>] [--node <worker>] [--receipt <id>] [--workspace <id>]
wfe request <workflow> --request <file|-> [--requester <agent>] [--entrusted-by <ref>] [--on-behalf-of <person>] [--original <file>] [--predecessor <run>] [--node <worker>] [--receipt <id>] [--workspace <id>]

--request is an agent's request (the run's request.md): what the agent wrote,
not a person's words. From an executing attempt the requester is that run's
agent, it is entrusted by that run, and the receipt is derived from the
attempt and the text, so the same command retried finds the same run instead
of creating a second. --on-behalf-of names the person served; --original
keeps the words the request was derived from (the run's original-input.md),
so a rewritten request never replaces what was actually said. Use a
delegate node instead (wfe run adjust, docs/delegation.md) when your own work
waits for the result and judges it.

A person's request to the executor (autolab): creates the run, in its own
working copy, with their words as braindump.md and queues its start. The same
receipt twice queues once. Other runs of the project — held, waiting or
working — never refuse it (p9). --predecessor names an earlier run this one
follows (reusing its plan, repairing or reversing it): the record keeps the
link and the agent is told where that run's records and saved branch are.
--node chooses the execution node (worker) that performs the run, over the
workflow's execution.node, the project's and the area's default
(<area>/workers.json; docs/workers.md). The run keeps it for every attempt.`,
  share: `wfe share <subcommand> …   (shared areas on this host; docs/shares.md)

list                       the shares this host has configured (<area>/shares.json) and
                           whether each is mounted here (its marker file answers)
resolve <ref>              where shared://<share>/<path> is on this host, its state
                           (ok, unknown-share, unmounted, absent, outside …) and its
                           LAN download address. Paths printed here are this host's:
                           never write them into a tracked record, name the reference
ls <ref> [--max <n>]       the files a reference holds (path and size; nothing is hashed)
verify <manifest.json> [--quick]
                           check an input-set or output manifest (devdocs/runs/…/inputs/
                           i<n>.json, outputs/o<n>.json, or a copy of one) against this
                           host's share: verified, changed or missing. Needs no run and
                           no workspace — how another PC checks a delivery it received
                           by reference. Exit 1 unless verified`,
  present: `wfe present <subcommand> …   (presentations of a run's result; docs/presentations.md)

register <run> <node> --source <dir> --entry <file> --review <file.md> --title <text>
                                  freeze the files of <dir> (project-relative) as the
                                  run's next presentation (p1, p2 …): they are copied into
                                  devdocs/runs/<wf>/<run>/presentations/<p>/ with the
                                  review text and a manifest of hashes; the revision is
                                  the manifest's digest. From a running node, by the
                                  executing attempt (WFE_ATTEMPT). Later edits of <dir>
                                  never change a registered presentation
start <run> <p>                   serve it on this host, in a session of its own (it
                                  outlives the attempt, a human wait, a stopped run and
                                  a service restart). Records it available only after
                                  its identity, review screen and entry answered. A
                                  second start returns the instance that serves it
stop <run> <p> | stop <run> --all stop the run's own instances and verify they are gone
                                  (process ended, port no longer answers); records
                                  stopped, or stop-failed (retry). Repeating is harmless
status [<run>]                    what each presentation's record says and what this host
                                  observes now; the review link only when it is live
reconcile                         after a restart: mark instances whose process is gone
Ask about a presentation: wfe run ask <run> <node> --presentation <p> … (the
result-confirmation question; the answer binds that revision). Host settings:
<area>/present.json {bind, publicBase, ports, answerBase}.`,
  exec: `wfe exec <subcommand> …   (the executor's interface; JSON output)

Every subcommand acts for one execution node: --worker <id>, or the local
worker of <area>/workers.json (docs/workers.md). A worker claims only jobs of
runs assigned to it, has one slot of its own, and only it reports, stops or
publishes its attempts.

claim [--backend <text>] [--profiles-json <{name: backend}>] [--contract <name>=<sha256>]
      [--sessions-json <{profile: "explicit"}>] [--lane <name>]
                                  take the next queued job if the slot is free:
                                  records attempt.begin with the settings it is
                                  launched with (agent, profile → backend, the
                                  contract and the project guides by hash, and
                                  the session: new or resumed, by id);
                                  prints the attempt, workspace, run, a brief
                                  and the guides for its prompt. A profile the
                                  host does not offer, a missing guide, or the
                                  "run" session policy on a profile not in
                                  --sessions-json ('' = the host default)
                                  leaves the job waiting with the reason in its
                                  note (it is the worker's to serve). --receipt:
                                  the worker's id for this claim; the same
                                  receipt again gets the same answer. --lane:
                                  claim in that lane of the worker (default:
                                  "default"; docs/workers.md, "Lanes")
started <attempt> --pid <pid>     the attempt's process is running
session <attempt> --attached <id> the harness reported this session id
session <attempt> --missing [--detail <text>]
                                  the session to resume is not on this host and
                                  nothing was launched in it: records the
                                  replacement and prints the new session id
finished <attempt> --exit-code <n> [--signal <name>] [--lost]
         [--interrupted <reason>] [--attached <id>]
                                  how it ended; records attempt.end, publishes
                                  the checkpoint, queues a resume if an answer
                                  already waits. --interrupted: the host ended
                                  it (a failed launch, a session mismatch),
                                  which holds the run; --attached: a session id
                                  the harness reported and not yet recorded
stops                             this worker's attempts to terminate (stop or cancel requested)
heartbeat --pid <pid> [--detail …]
reconcile [--holding <attempt>]   after a restart: gone processes become
                                  "unknown"; requests and answers that were not
                                  queued are queued again under their receipts.
                                  --holding: an attempt whose process the caller
                                  still owns keeps the slot (a launch it could
                                  not register or confirm stopped)
publish <checkpoint id>           retry a publication; finished steps are kept
status [<run>]                    the executor and the workers, or one run's
                                  attempts, jobs and checkpoints
workers                           every worker: last contact, slot, queue, offer
adopt                             this worker's running attempts whose process
                                  still lives (a restarted executor takes them back)
State is <area>/.local/exec/exec.sqlite (this host only).`,
  intake: `wfe intake <subcommand> …   (requests from Zulip; the transport's interface, protocol 1)

status                            configuration, channel cursors, the transport's
                                  last pass, posts by stage, requests, problems
messages [--request <key>] [--limit <n>]
                                  posts as received and what became of each
due                               the routed workflow channels and their cursors (JSON)
receive --stream <id> --through <id> --messages-json <file|->
                                  store posts of one channel and move its cursor
                                  past --through in one transaction; a post
                                  already stored is not stored again
process                           settle what can be settled, in message order:
                                  classify, apply through the run operations
                                  (by the post's receipt), queue what follows
transport --ok | --error <text> [--detail <text>]
                                  the transport's last pass, shown to people
retry [<message id>]              try failed posts again now, from the stage
                                  that failed
State is <area>/.local/intake/intake.sqlite; the rules are docs/intake.md.`,
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
wfe project show [--workspace <id>]
wfe project save --file <yaml|-> --base <rev> [--workspace <id>]

show      prints project.yaml (intent, goals, guides, areas, execution) and its
          revision. save writes a changed project.yaml like the project
          editor's Save (the file only, no commit), refused with code
          definition-conflict when the file is no longer at --base.

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
  gitea: `wfe gitea whoami [--as <principal>]
wfe gitea repo <owner>/<name> [--as <principal>]
wfe gitea git [--as <principal>] -- <git arguments…>

Gitea as a chosen principal (project_migration p9). Without --as, the
service's own principal (gitea.json: url, owner, tokenFile); --as names
another one listed in gitea.json "principals". The token is never printed,
never written to a remote, a URL or a Git config file.

whoami    the login the principal authenticates as
repo      whether it sees the repository and may pull, push, administer
git       runs git in the current directory (or git's own -C <dir>) with
          the principal's authentication for this Gitea's URL only; the
          output is git's. Push to a remote of this Gitea (origin or a URL).
          A force push (--force, -f, +<refspec>, --mirror) is refused: it
          could overwrite others' work; --force-with-lease is allowed.
          Author your commits yourself (git -c user.name=… -c user.email=…
          commit …): the principal is who pushes, not who wrote.
Typical: a preparation checkout of an existing repository, published as
the principal before \`wfe project register\`.`,
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
first authoring prompt and the prompt for executing a workflow.

--installed-url <url> (workflow_editor p13): the operating area's authoring
entry instead, written by the release script: <area>/authoring/AGENTS.md and
CLAUDE.md, using <area>/bin/wfe, the installed docs and the published editor
URL. It sits beside the workspaces, never above them, so executing agents'
harnesses do not load it.`,
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
  gitea whoami|repo|git     Gitea as a chosen principal (--as): who, its access, git with its auth
  dashboard               every project and shared repository, with where each fact was read
  projects <subcommand>     read any managed project: list, show, tree, read, search, runs, run
                            (committed by default, at a revision, with provenance; docs/access.md)
  request <workflow> …      a person's request to the executor (autolab): a run, queued
  intake <subcommand>       requests from Zulip: status, messages, receive, process … (autolab fetches)
  exec <subcommand>         the executor's interface: claim, started, finished, stops, reconcile …
  runs index [--rebuild]    runs' own working copies on this host (p9)
  observe                   a read-only snapshot of every run for monitors (observer p3)
  notify <subcommand>       Zulip coordination: status, deliveries, claim, resolve … (autolab delivers)
  present <subcommand>      presentations of a run's result: register, start, status, stop, reconcile
  share <subcommand>        shared areas on this host: list, resolve, ls, verify (docs/shares.md)
  boast [status] <project>  a project's Boast page (boast/index.html): published or previewed; reference
  conversation <subcommand> the entrance's conversations: list, show, reply, link, post (p8;
                            docs/conversations.md)
  context <subcommand>      scoped context: show (sources for authoring or a run, and where each comes
                            from), get|set|clear|history (the local overrides), run (used vs next)

Workflows (by file name or id)
  workflow new <id>         create devdocs/workflows/<id>.yaml from the template
  nodes <subcommand>        the person's node catalog: list, show, create, update, delete,
                            example, instantiate (a template into a workflow or a run draft)
  validate [<workflow>]     validation issues
  approve <wf> <kind>       record an intent or definition approval by a named approver
  arrange <workflow>        auto-arrange the layout

Runs (docs/runs.md; wfe run help)
  run create <workflow> …   create a run: the input, a fixed copy of the definition, run.json
  run list | show | check   runs, one run in full, record checks
  run start | complete | …  record node starts, waits, questions, answers, outcomes
  delegate request | …      entrust a delegate node's work to another workflow (docs/delegation.md; wfe delegate help)

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

// Reading and writing a definition as the editor does (project_migration p8):
// the file's text and revision, and a save checked against the revision the
// writer read, so an agent's edit never replaces an edit it did not see.
async function definitionCommand(p: Parsed, kind: 'workflow' | 'project', sub: 'show' | 'save', name?: string): Promise<number> {
  const ws = await workspace(p)
  const { parseProject, parseWorkflow } = await import('../server/yamlDoc.ts')
  const { textHash } = await import('../server/files.ts')
  let file = 'project.yaml', text: string | null
  if (kind === 'workflow') {
    if (!name) throw new UsageError(`workflow ${sub} needs <workflow>`)
    file = await workflowFile(ws, name)
    text = (await ws.readWorkflowFile(file)).text
  } else text = (await ws.readProject()).text
  if (sub === 'show') {
    if (text === null) throw new Refused(`${file} does not exist in ${ws.reg.id}`)
    const rev = textHash(text)
    out(`# ${ws.reg.id} ${kind === 'workflow' ? `devdocs/workflows/${file}` : file} — revision ${rev}\n${text}`, { ok: true, workspace: ws.reg.id, file, rev, text })
    return 0
  }
  const source = opt(p, 'file'), base = opt(p, 'base')
  if (!source) throw new UsageError(`${kind} save needs --file <yaml|->: the whole new definition`)
  if (!base) throw new UsageError(`${kind} save needs --base <rev>: the revision you read (wfe ${kind} show)`)
  const next = readFileSync(source === '-' ? 0 : resolve(source), 'utf8')
  try {
    if (kind === 'workflow') {
      const parsed = parseWorkflow(next)
      if (!parsed.ok) throw new Refused(`the new definition does not parse: ${parsed.problem.message}`, parsed.problem)
      const saved = await ws.saveWorkflow(file, parsed.model, base)
      const issues = validateWorkflowIssues(await ws.workflowResponse(file))
      out([`${saved.rev === base ? 'Unchanged' : 'Saved'}: devdocs/workflows/${file} (revision ${saved.rev}); not committed.`, ...issues.map(issueLine)].join('\n'), { ok: true, workspace: ws.reg.id, file, rev: saved.rev, changed: saved.rev !== base, issues })
    } else {
      const parsed = parseProject(next)
      if (!parsed.ok) throw new Refused(`the new project.yaml does not parse: ${parsed.problem.message}`, parsed.problem)
      const saved = await ws.saveProject(parsed.model, base)
      out(`${saved.rev === base ? 'Unchanged' : 'Saved'}: project.yaml (revision ${saved.rev}); not committed.`, { ok: true, workspace: ws.reg.id, file, rev: saved.rev, changed: saved.rev !== base })
    }
    return 0
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    throw e
  }
}
const validateWorkflowIssues = (r: { issues?: Issue[] }): Issue[] => r.issues ?? []

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
  if (sub === 'basics') {
    // The basic workflows (p8/ex2, server/basics.ts): added where they are
    // missing, never over a file or an id that is there.
    const { placeBasics, placeBasicsEverywhere } = await import('../server/basics.ts')
    const o: { dryRun: boolean; commit: boolean; push: boolean; gitEnv?: Record<string, string> } = { dryRun: p.flags.has('dry-run'), commit: p.flags.has('commit'), push: p.flags.has('push') }
    if (o.push && !o.commit) throw new UsageError('--push goes with --commit')
    // Pushed with the host's Gitea credentials, as run publication is.
    if (o.push) { const g = await giteaOf(p); if (g) o.gitEnv = await g.gitEnv() }
    let results
    if (p.flags.has('all')) {
      const reg = await loadRegistry(registryFile(p))
      const boundary = await loadBoundary(registryFile(p), areaDir(p))
      const list: Workspace[] = []
      const skipped: Awaited<ReturnType<typeof placeBasics>> = []
      for (const w of reg.workspaces) {
        const why = await assertWorkspaceAllowed(boundary, w, 'Adding basic workflows to').then(() => observe(w)).then(x => (x.available ? null : `not available: ${x.reason}`), (e: Error) => e.message)
        if (why) skipped.push({ workspace: w.id, project: w.project ?? w.id, workflow: 'freework', status: 'unplaceable', reason: why })
        else list.push(new Workspace(w))
      }
      results = [...await placeBasicsEverywhere(list, o), ...skipped]
    } else results = await placeBasics(await workspace(p), o)
    const lines = results.map(r => `${r.workspace.padEnd(14)} ${r.workflow.padEnd(10)} ${r.status.padEnd(11)} ${r.file ?? ''}${r.file ? ' — ' : ''}${r.reason}${r.commit ? `; committed ${r.commit}${r.pushed ? ', pushed' : ''}` : ''}${r.publishError ? `; NOT PUBLISHED: ${r.publishError}` : ''}${(r.notes ?? []).map(n => `\n${' '.repeat(16)}${n}`).join('')}`)
    out([o.dryRun ? 'Dry run: nothing written.' : '', ...lines].filter(Boolean).join('\n'), results)
    return results.some(r => r.status === 'conflict' || r.publishError) ? 1 : 0
  }
  if (sub === 'show' || sub === 'save') return definitionCommand(p, 'workflow', sub, id)
  if (sub === 'templates') {
    const { WORKFLOW_TEMPLATES } = await import('../server/templates.ts')
    out(WORKFLOW_TEMPLATES.map(t => `${t.id.padEnd(12)} ${t.name} — ${t.description}`).join('\n'), WORKFLOW_TEMPLATES)
    return 0
  }
  if (sub !== 'new' || !id) throw new UsageError('usage: wfe workflow new <id> [--name <name>] [--policy default|manual|custom [--steps plan,reports,final]] [--template <id>] | wfe workflow templates | wfe workflow basics [--dry-run] [--commit [--push]] [--workspace <id> | --all]')
  const ws = await workspace(p)
  const policy = opt(p, 'policy'), stepsOpt = opt(p, 'steps')
  if (stepsOpt !== undefined && policy !== 'custom') throw new UsageError('--steps goes with --policy custom')
  let documentation: string | Documentation | undefined = policy
  if (policy === 'custom') {
    if (stepsOpt === undefined) throw new UsageError('--policy custom needs --steps (any of plan, reports, final, comma-separated; or none)')
    const chosen = stepsOpt === 'none' ? [] : stepsOpt.split(',').map(x => x.trim()).filter(Boolean)
    const bad = chosen.filter(x => !(DOC_STEPS as readonly string[]).includes(x))
    if (bad.length) throw new UsageError(`--steps takes plan, reports, final (not ${bad.join(', ')})`)
    documentation = { policy: 'custom', plan: chosen.includes('plan'), reports: chosen.includes('reports'), final: chosen.includes('final') }
  }
  try {
    const r = await ws.createWorkflow(id, opt(p, 'name') ?? '', documentation, opt(p, 'template') ?? 'empty')
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
  const installed = opt(p, 'installed-url')
  const r = await setupArea(resolve(dir), { port: port(p), ...(installed ? { installed: { url: installed } } : {}) })
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
    area: () => areaDir(p),
  }).finally(() => { execStore?.close(); execStore = undefined })
}

// Delegation (p10): a run's agent entrusting a delegate node's work.
async function cmdDelegate(p: Parsed): Promise<number> {
  const { delegateCommand } = await import('./delegate.ts')
  await openExec(p)
  return delegateCommand({
    positional: p.positional, opt: k => opt(p, k), opts: k => p.opts.get(k) ?? [], flag: k => p.flags.has(k),
    workspace: () => workspace(p), out, usage: m => new UsageError(m), refused: (m, detail) => new Refused(m, detail),
    serviceUrl: async () => { const s = await serviceState(p); return s.running && s.sameRegistry ? s.url : null },
    exec: () => execStore!, area: () => areaDir(p),
  }).finally(() => { execStore?.close(); execStore = undefined })
}

let execStore: ExecStore | undefined
async function openExec(p: Parsed): Promise<ExecStore> {
  execStore ??= new ExecStore({ registryFile: registryFile(p), area: areaDir(p), gitea: await giteaOf(p) })
  return execStore
}

// Presentations of a run's result (p7): frozen bundles in the run folder,
// served on this host by instances that outlive the attempt.
async function cmdShare(p: Parsed): Promise<number> {
  const [sub, arg] = p.positional
  const m = await import('../server/shares.ts')
  const { humanBytes } = await import('../shared/shares.ts')
  m.setShareArea(areaDir(p))
  switch (sub) {
    case 'list': {
      const cfg = m.loadShareConfig()
      const rows = await Promise.all(Object.entries(cfg.shares).map(async ([id, s]) => ({ share: id, root: s.root, ...(await m.shareRoot(id, cfg)), download: m.downloadBase(id, cfg) })))
      out(rows.length ? rows.map(r => `${r.share.padEnd(16)} ${r.state.padEnd(12)} ${r.root}${r.detail ? `  (${r.detail})` : ''}${r.download ? `\n${' '.repeat(17)}download: ${r.download}` : ''}`).join('\n') : `No shares configured on this host (${join(areaDir(p), m.SHARES_FILE)}).`, { ok: true, file: cfg.file, shares: rows })
      return 0
    }
    case 'resolve':
    case 'ls': {
      if (!arg) throw new UsageError(`${sub} <shared://share/path>`)
      const r = await m.resolveRef(arg)
      const parsed = (await import('../shared/shares.ts')).parseRef(arg)!
      if (sub === 'resolve') {
        const url = r.state === 'ok' ? m.downloadUrl(parsed) : null
        out(`${r.ref}: ${r.state}${r.abs ? `\n  here: ${r.abs}` : ''}${r.detail ? `\n  ${r.detail}` : ''}${url ? `\n  download: ${url}` : ''}`, { ok: r.state === 'ok', ...r, url })
        return r.state === 'ok' ? 0 : 1
      }
      if (r.state !== 'ok') throw new Refused(`${r.ref}: ${r.detail}`)
      const max = Number(opt(p, 'max') ?? 500)
      const files = await m.listFiles(r.abs!, { max: 100000 })
      out([...files.slice(0, max).map(f => `${String(f.bytes).padStart(12)}  ${f.path}`), `${files.length} files, ${humanBytes(files.reduce((n, f) => n + f.bytes, 0))}${files.length > max ? ` (first ${max} shown)` : ''}`].join('\n'), { ok: true, ref: r.ref, files })
      return 0
    }
    case 'verify': {
      if (!arg) throw new UsageError('verify <manifest.json>')
      const { readFileSync } = await import('node:fs')
      const r = await m.verifyManifest(readFileSync(resolve(arg), 'utf8'), { quick: p.flags.has('quick') })
      out(`${r.ref} (${r.digest.slice(0, 19)}…): ${r.status} — ${r.detail}`, { ok: r.status === 'verified', ...r })
      return r.status === 'verified' ? 0 : 1
    }
    default: throw new UsageError('share list | resolve <ref> | ls <ref> | verify <manifest.json>')
  }
}

async function cmdPresent(p: Parsed): Promise<number> {
  const [sub, runArg, third] = p.positional
  const { Presenter } = await import('../server/present.ts')
  const { registerPresentation, resolveRef } = await import('../server/runs.ts')
  const pr = new Presenter({ registryFile: registryFile(p), area: areaDir(p), by: opt(p, 'by') })
  const need = (k: string) => { const v = opt(p, k); if (!v?.trim()) throw new UsageError(`--${k} is required`); return v }
  try {
    if (sub === 'reconcile') { const notes = await pr.reconcile(); out(notes.join('\n') || 'Every recorded instance is serving or stopped as recorded.', { ok: true, notes }); return 0 }
    const ws = await workspace(p)
    const ref = async () => { if (!runArg) throw new UsageError(`${sub} <run> …`); return resolveRef(ws, runArg) }
    switch (sub) {
      case 'register': {
        const r = await ref()
        if (!third) throw new UsageError('register <run> <node> --source <dir> --entry <file> --review <file.md> --title <text>')
        const attempt = opt(p, 'attempt') ?? process.env.WFE_ATTEMPT ?? undefined
        const { runSpace } = await import('../server/runspace.ts')
        const root = (await runSpace(ws, r)).root // the run's own copy (p9)
        const rel = (x: string) => { const a = resolve(x); const r2 = relative(root, a); return !r2.startsWith('..') && !isAbsolute(r2) && (isAbsolute(x) || relative(root, process.cwd()) !== '') ? (r2.split(sep).join('/') || '.') : x }
        const res = await registerPresentation(ws, r, { node: third, source: rel(need('source')), entry: need('entry'), review: rel(need('review')), title: need('title') }, { by: opt(p, 'by'), via: 'cli', attempt, receipt: opt(p, 'receipt') })
        const pz = res.presentation
        out(`${res.duplicate ? 'Already registered (same receipt): ' : 'Registered '}presentation ${pz.id} of ${r.workflow}/${r.run}: ${pz.files.length} files frozen in ${pz.folder}/ (revision ${pz.revision.slice(7, 19)}…).\nNext: wfe present start ${r.workflow}/${r.run} ${pz.id}`, { ok: true, presentation: pz, duplicate: !!res.duplicate })
        return 0
      }
      case 'start': {
        const r = await ref()
        if (!third) throw new UsageError('start <run> <presentation>')
        const res = await pr.start(ws, r, third, { by: opt(p, 'by') })
        out(res.state === 'starting' ? `Presentation ${third} is being started by another request (instance ${res.instance.id}); ask again in a few seconds.`
          : `${res.reused ? 'Already served' : 'Serving'} presentation ${third}: ${res.url}${res.local ? ' (opens on this host only)' : ''}\nInstance ${res.instance.id}, pid ${res.instance.pid}; it keeps serving after this attempt ends. Stop: wfe present stop ${r.workflow}/${r.run} ${third}`, { ok: true, ...res })
        return 0
      }
      case 'stop': {
        const r = await ref()
        const which = p.flags.has('all') ? 'all' : third
        if (!which) throw new UsageError('stop <run> <presentation> | stop <run> --all')
        const res = await pr.stop(ws, r, which, { by: opt(p, 'by') })
        const bad = res.filter(x => !x.ok)
        out(res.length ? res.map(x => `${x.presentation}: ${x.ok ? 'stopped' : 'NOT VERIFIED'} — ${x.detail}`).join('\n') : 'Nothing of this run is served or open.', { ok: !bad.length, results: res })
        return bad.length ? 1 : 0
      }
      case 'status': {
        const refs = runArg ? [await ref()] : (await import('../server/runs.ts').then(m => m.listRuns(ws))).map(x => ({ workflow: x.workflow, run: x.run }))
        const views = []
        for (const r of refs) {
          const rec = (await import('../server/runs.ts').then(m => m.readRun(ws, r))).record
          if (!rec?.presentations) continue
          views.push({ ref: `${r.workflow}/${r.run}`, presentations: await pr.view(ws, rec) })
        }
        out(views.length ? views.flatMap(v => [v.ref, ...v.presentations.map(x => `  ${x.id} ${x.state.padEnd(11)} ${x.title} — ${x.live ? `LIVE ${x.url}${x.local ? ' (this host)' : ''}` : x.observed ? `not live: ${x.observed.detail}${['available', 'stop-failed'].includes(x.state) ? ' (recover: wfe present start or stop)' : ''}` : 'never served'}  revision ${x.revision.slice(7, 19)}…`)]).join('\n') : 'No presentations.', { ok: true, runs: views })
        return 0
      }
    }
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    throw e
  } finally { pr.close() }
  throw new UsageError('wfe present register|start|stop|status|reconcile')
}

// The executor's interface to this host's execution management. Every
// subcommand prints JSON; the rules are in server/exec.ts and shared/run.ts.
async function cmdExec(p: Parsed): Promise<number> {
  const [sub, arg] = p.positional
  const x = await openExec(p)
  json = true
  const num = (k: string) => { const v = opt(p, k); if (v === undefined || !/^-?\d+$/.test(v)) throw new UsageError(`--${k} <integer> is required`); return Number(v) }
  // The worker this executor is (project_migration p7); the local one when not given.
  const worker = () => opt(p, 'worker') ?? x.localWorker
  try {
    switch (sub) {
      case 'claim': {
        const profiles = opt(p, 'profiles-json')
        const sessions = opt(p, 'sessions-json')
        const contract = opt(p, 'contract')
        const m = contract ? /^([^=]+)=([0-9a-f]{64})$/.exec(contract) : null
        if (contract && !m) throw new UsageError('--contract <name>=<sha256 of the contract text>')
        out('', await x.claim(opt(p, 'backend') ?? null, { ...(profiles ? { profiles: JSON.parse(profiles) as Record<string, string> } : {}), ...(sessions ? { sessions: JSON.parse(sessions) as Record<string, 'explicit'> } : {}), ...(m ? { contract: { name: m[1], sha256: m[2] } } : {}) }, { worker: worker(), receipt: opt(p, 'receipt'), lane: opt(p, 'lane') })); return 0
      }
      case 'started': if (!arg) throw new UsageError('started <attempt> --pid <pid>'); x.started(arg, num('pid'), worker()); out('', { ok: true }); return 0
      case 'finished': {
        if (!arg) throw new UsageError('finished <attempt> --exit-code <n> [--signal <name>]')
        const code = opt(p, 'exit-code') !== undefined ? num('exit-code') : null
        const r = await x.finished(arg, { code, signal: opt(p, 'signal') ?? null, lost: p.flags.has('lost'), interrupted: opt(p, 'interrupted'), attached: opt(p, 'attached') }, worker())
        out('', { ok: true, ...r }); return 0
      }
      case 'session': {
        if (!arg || (!opt(p, 'attached') && !p.flags.has('missing'))) throw new UsageError('session <attempt> --attached <id> | --missing [--detail <text>]')
        out('', { ok: true, ...await x.session(arg, opt(p, 'attached') ? { attached: opt(p, 'attached') } : { missing: opt(p, 'detail') ?? '' }, worker()) }); return 0
      }
      case 'context': {
        if (!arg || (!p.flags.has('delivered') && !p.flags.has('undelivered'))) throw new UsageError('context <attempt> --delivered | --undelivered [--detail <text>]')
        out('', { ok: true, ...await x.contextDelivery(arg, { delivered: p.flags.has('delivered'), detail: opt(p, 'detail') }, worker()) }); return 0
      }
      case 'stops': out('', x.stopsDue(worker()).map(a => ({ id: a.id, pid: a.pid, run: `${a.workflow}/${a.run}`, workspace: a.workspace, requested: a.stop_requested }))); return 0
      case 'heartbeat': x.heartbeat(worker(), num('pid'), opt(p, 'detail') ?? ''); out('', { ok: true }); return 0
      case 'reconcile': {
        if (x.isRemote(worker())) throw new UsageError(`reconcile runs on the coordinator for its local worker; ${worker()} reconciles its own attempts through its wfe`)
        const notes = await x.reconcile(p.opts.get('holding') ?? [])
        // Conversation messages whose turn could not be started yet (p8).
        const { ConversationStore } = await import('../server/conversations.ts')
        const cs = new ConversationStore({ area: areaDir(p), exec: x })
        try { notes.push(...(await cs.dispatchDue()).filter(n => !n.includes(': not started — no '))) } finally { cs.close() }
        out('', { ok: true, notes }); return 0
      }
      // Execution nodes (p7): every worker's state, what it holds and what waits for it.
      case 'workers': out('', { workers: x.workersState() }); return 0
      // A restarted executor takes back the processes it left running (p7).
      case 'adopt': {
        const live = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
        out('', x.workerDue(worker()).attempts.filter(a => a.state === 'running' && live(a.pid)).map(a => ({ id: a.id, pid: a.pid, log: a.log, lane: a.lane ?? 'default' }))); return 0
      }
      case 'publish': { if (!arg) throw new UsageError('publish <checkpoint id>'); out('', await x.publishCheckpoint(Number(arg))); return 0 }
      case 'status': {
        const ws = await workspace(p)
        if (!arg) { out('', { executor: x.executorState(), workers: x.workersState() }); return 0 }
        const ref = await import('../server/runs.ts').then(m => m.resolveRef(ws, arg))
        out('', await x.runView(ws.reg.id, ref)); return 0
      }
    }
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    throw e
  } finally { x.close(); execStore = undefined }
  throw new UsageError('wfe exec claim|started|session|context|finished|stops|heartbeat|reconcile|publish|status|workers|adopt')
}

// Zulip coordination: the outbox and bindings of this host, for the
// transport (autolab) and for people. Rules are in server/notify.ts.
async function cmdNotify(p: Parsed): Promise<number> {
  const [sub, arg] = p.positional
  const { NotifyStore, NOTIFY_PROTOCOL } = await import('../server/notify.ts')
  const x = await openExec(p)
  const n = new NotifyStore({ area: areaDir(p), registryFile: registryFile(p), exec: x })
  const { IntakeStore } = await import('../server/intake.ts')
  n.intake = new IntakeStore({ area: areaDir(p), registryFile: registryFile(p), exec: x, notify: n, posted: n.postedLookup() })
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
  } finally { n.intake?.close(); n.close(); x.close(); execStore = undefined }
  throw new UsageError('wfe notify status|outbox|deliveries|due|claim|begin|sent|failed|legacy|resolve|import-inflight|sender|protocol|target|moved|run-problem|reset')
}

// Requests from Zulip: the inbox of this host, for the transport (autolab)
// and for people. Rules are in shared/intake.ts and server/intake.ts.
async function cmdIntake(p: Parsed): Promise<number> {
  const [sub, arg] = p.positional
  const { IntakeStore, INTAKE_PROTOCOL, loadIntakeConfig } = await import('../server/intake.ts')
  const { NotifyStore } = await import('../server/notify.ts')
  const x = await openExec(p)
  const n = new NotifyStore({ area: areaDir(p), registryFile: registryFile(p), exec: x })
  const i = new IntakeStore({ area: areaDir(p), registryFile: registryFile(p), exec: x, notify: n, posted: n.postedLookup() })
  n.intake = i
  const num = (k: string) => { const v = opt(p, k); if (v === undefined || !/^\d+$/.test(v)) throw new UsageError(`--${k} <integer> is required`); return Number(v) }
  try {
    switch (sub) {
      case 'protocol': json = true; out('', { protocol: INTAKE_PROTOCOL }); return 0
      case 'due': json = true; out('', await i.due()); return 0
      case 'receive': {
        json = true
        const cfg = loadIntakeConfig(areaDir(p))
        if ('disabled' in cfg) throw new Refused(cfg.disabled)
        const file = opt(p, 'messages-json'); if (!file) throw new UsageError('--messages-json <file|-> is required')
        let messages: unknown
        try { messages = JSON.parse(readFileSync(file === '-' ? 0 : resolve(file), 'utf8')) } catch (e) { throw new UsageError(`--messages-json: ${(e as Error).message}`) }
        if (!Array.isArray(messages)) throw new UsageError('--messages-json must hold a JSON list')
        out('', { ok: true, ...i.receive({ realm: cfg.realm, streamId: num('stream'), through: num('through'), messages }) }); return 0
      }
      case 'process': { const notes = await i.process(); out(notes.join('\n') || 'Nothing to settle.', { ok: true, notes }); return 0 }
      case 'transport': {
        const error = opt(p, 'error')
        if (!p.flags.has('ok') && !error) throw new UsageError('transport --ok | --error <text>')
        i.transportResult({ ok: !error, error, detail: opt(p, 'detail') }); out('Recorded.', { ok: true }); return 0
      }
      case 'retry': {
        const cfg = loadIntakeConfig(areaDir(p))
        if ('disabled' in cfg) throw new Refused(cfg.disabled)
        const k = i.retry(cfg.realm, arg ? Number(arg) : undefined); out(`${k} failed post(s) will be tried at the next pass.`, { ok: true, count: k }); return 0
      }
      case 'messages': {
        const rows = i.messages({ request: opt(p, 'request'), limit: opt(p, 'limit') ? num('limit') : undefined })
        out(rows.length ? rows.map(m => `${String(m.id).padStart(7)} ${m.state.padEnd(10)} ${m.topic} — ${m.sender_name}${m.sender_bot ? ' (bot)' : ''}: ${m.content.replace(/\s+/g, ' ').slice(0, 60)}${m.classification ? `\n          ${m.classification}` : m.route ? `\n          ${m.route}` : ''}${m.applied ? ` → ${m.applied}` : ''}${m.notice ? ` reply: ${m.notice}` : ''}${m.error ? `\n          error: ${m.error}` : ''}`).join('\n') : 'No posts.', rows)
        return 0
      }
      case 'status': {
        const cfg = loadIntakeConfig(areaDir(p))
        const due = await i.due(), st = i.status()
        out([
          `Configuration: ${'disabled' in cfg ? `off — ${cfg.disabled}` : `on, realm ${cfg.realm}, posts since ${cfg.intake.since}, projects all registered, workspace overrides ${Object.keys(cfg.intake.projects).join(', ') || 'none'}, requesters ${cfg.intake.requesters.map(r => `${r.name} (${r.id})`).join(', ')}`}`,
          'Channels:', ...due.channels.map(c => `  #${c.streamId} ${c.project}/${c.workflow}  cursor ${c.cursor}`),
          `Transport: ${st.transport ? `${st.transport.ok ? 'ok' : 'FAILED'} at ${st.transport.at}${st.transport.error ? ` — ${st.transport.error}` : ''}` : 'no pass recorded yet'}`,
          `Posts: ${Object.entries(st.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`,
          'Requests:', ...st.requests.map(r => `  ${r.key.padEnd(10)} ${r.state.padEnd(8)} ${r.project}/${r.workflow} "${r.topic}"${r.run ? ` → ${r.run_workflow}/${r.run}` : ''}${r.refused ? ` — ${r.refused}` : ''}`),
          ...(due.problems.length ? ['Problems:', ...due.problems.map(x => `  ${x}`)] : []),
        ].join('\n'), { config: cfg, ...due, ...st })
        return 0
      }
    }
  } catch (e) {
    if (e instanceof RequestError) throw new Refused(e.message, e.detail)
    if (e instanceof UsageError || e instanceof Refused) throw e
    throw new Refused((e as Error).message)
  } finally { i.close(); n.close(); x.close(); execStore = undefined }
  throw new UsageError('wfe intake status|messages|due|receive|process|transport|retry|protocol')
}

// The run of an executing attempt: its project and the agent it records as.
async function readRunRecord(x: ExecStore, row: { workspace: string; workflow: string; run: string }): Promise<{ project: string; agent: string } | null> {
  try {
    const ws = await x.workspace(row.workspace)
    const rec = (await (await import('../server/runs.ts')).readRun(ws, { workflow: row.workflow, run: row.run })).record
    return rec ? { project: rec.project, agent: rec.executor.name } : null
  } catch { return null }
}
function entrustRef(text: string): import('../shared/run.ts').EntrustRef {
  if (text.startsWith('file:')) return { kind: 'file', path: text.slice(5) }
  if (text.startsWith('note:')) return { kind: 'note', text: text.slice(5) }
  const m = /^(?:([a-z0-9][a-z0-9_.-]*)\/)?([a-z0-9][a-z0-9_.-]*)\/(run-[a-z0-9][a-z0-9_.-]*)$/.exec(text)
  if (m) return { kind: 'run', workflow: m[2], run: m[3], ...(m[1] ? { project: m[1] } : {}) }
  throw new UsageError(`--entrusted-by "${text}" must be [<project>/]<workflow>/<run>, file:<path> or note:<text>`)
}

// A person's request: their words become the run's braindump.md, and the
// executor is queued. An agent's request: its request.md (p8).
async function cmdRequest(p: Parsed): Promise<number> {
  const [workflow] = p.positional
  if (!workflow) throw new UsageError('request needs a workflow')
  const file = opt(p, 'braindump'), requestFile = opt(p, 'request')
  if (!!file === !!requestFile) throw new UsageError('give exactly one of --braindump <file|-> (a person\'s words) or --request <file|-> (an agent\'s request)')
  const author = opt(p, 'author'); if (file && !author) throw new UsageError('--author <person> is required: whose words the braindump holds')
  const ws = await workspace(p)
  const x = await openExec(p)
  try {
    const text = readFileSync((file ?? requestFile) === '-' ? 0 : resolve((file ?? requestFile)!), 'utf8')
    // An executing attempt requesting work (project_migration p8): its run's
    // agent is the requester and its run what entrusted the request, and the
    // same command retried by that attempt is the same request.
    const attempt = process.env.WFE_ATTEMPT
    const row = attempt ? x.attemptRow(attempt) : undefined
    const own = row && row.state !== 'ended' ? (await readRunRecord(x, row)) : null
    const { createHash } = await import('node:crypto')
    const receipt = opt(p, 'receipt') ?? (own ? `attempt:${attempt}:${createHash('sha256').update(`${ws.reg.id}\n${workflow}\n${text}`).digest('hex').slice(0, 24)}` : `cli-${Date.now()}-${process.pid}`)
    let input: Parameters<ExecStore['request']>[0]['input']
    if (requestFile) {
      const requester = opt(p, 'requester') ?? own?.agent
      if (!requester) throw new UsageError('--requester <agent> is required outside an executing attempt: the agent that wrote the request')
      const by = opt(p, 'entrusted-by')
      const entrustedBy = by ? entrustRef(by) : own ? { kind: 'run' as const, project: own.project, workflow: row!.workflow, run: row!.run } : undefined
      if (!entrustedBy) throw new UsageError('--entrusted-by is required outside an executing attempt: <project>/<workflow>/<run>, note:<text> or file:<path>')
      const original = opt(p, 'original')
      input = { kind: 'request', text, requester, entrustedBy, ...(opt(p, 'on-behalf-of') ? { onBehalfOf: opt(p, 'on-behalf-of') } : {}), ...(original ? { original: readFileSync(original === '-' ? 0 : resolve(original), 'utf8') } : {}) }
    }
    const pred = opt(p, 'predecessor')
    const predecessor = pred ? await (await import('../server/runs.ts')).resolveRef(ws, pred) : undefined
    const r = await x.request({ workspace: ws.reg.id, workflow, text, author: author ?? input?.requester ?? '', receipt, by: opt(p, 'by') ?? own?.agent, via: 'cli', predecessor, node: opt(p, 'node'), ...(input ? { input } : {}) })
    out(`${r.duplicate ? 'Already requested (same receipt)' : 'Requested'}: run ${r.ref.workflow}/${r.ref.run} in ${ws.reg.id}; job ${r.job.id} is ${r.job.state}${r.job.worker ? ` for execution node ${r.job.worker}` : ''}.`, r)
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
  if (sub === 'show' || sub === 'save') return definitionCommand(p, 'project', sub)
  throw new UsageError('wfe project register <owner>/<name> | obtain <project id> | unregister <project id> | show | save --file <yaml> --base <rev>')
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

// A push that could overwrite others' work (p9: preparation pushes).
export function forcePush(args: string[]): string | undefined {
  const i = args.indexOf('push')
  if (i < 0) return undefined
  return args.slice(i + 1).find(a => a === '--force' || a === '-f' || a === '--mirror' || /^-[a-zA-Z]*f/.test(a) && !a.startsWith('--') || a.startsWith('+'))
}

async function cmdGitea(p: Parsed): Promise<number> {
  const [sub, ...rest] = p.positional
  const base = await giteaOf(p)
  if (!base) throw new Refused(`no Gitea setting at ${giteaFile(p)}`)
  const as = opt(p, 'as')
  let g: Gitea
  try { g = as ? base.as(as) : base } catch (e) { throw new Refused((e as Error).message) }
  const who = as ?? `${base.owner}'s setting (service)`
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f() } catch (e) { if (e instanceof GiteaError) throw new Refused(e.message); throw e } }
  if (sub === 'whoami') { const login = await wrap(() => g.login()); out(`${login} (as ${who}, ${g.url})`, { login, principal: as ?? null, url: g.url }); return 0 }
  if (sub === 'repo') {
    const o = ownerName(rest[0], '<repository>')
    const a = await wrap(() => g.access(o.owner, o.name))
    if (!a) { out(`${o.owner}/${o.name}: not visible to ${who} (absent or private)`, { visible: false }); return 1 }
    const perm = Object.entries(a.permissions).filter(([, v]) => v).map(([k]) => k)
    out(`${a.repo.fullName} (id ${a.repo.id}, ${a.repo.empty ? 'empty' : `default ${a.repo.defaultBranch}`}${a.repo.archived ? ', archived' : ''}): ${who} may ${perm.length ? perm.join(', ') : 'nothing'}`, { visible: true, repository: a.repo, permissions: a.permissions, principal: as ?? null })
    return 0
  }
  if (sub === 'git') {
    if (!rest.length) throw new UsageError('wfe gitea git [--as <principal>] -- <git arguments…>')
    const f = forcePush(rest)
    if (f) throw new Refused(`a force push (${f}) is refused: it could overwrite work others published; fetch and integrate, or use --force-with-lease`)
    const env = { ...process.env, ...(await wrap(() => g.gitEnv())) }
    return await new Promise<number>(res => {
      const c = spawn('git', rest, { stdio: 'inherit', env })
      c.on('error', e => { console.error(`wfe gitea git: ${e.message}`); res(1) })
      c.on('exit', code => res(code ?? 1))
    })
  }
  throw new UsageError('wfe gitea whoami | repo <owner>/<name> | git -- <git arguments…>  [--as <principal>]')
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

// Runs' own working copies (p9, docs/storage.md): the host-local index.
// The workflow observation (observer p3, server/observe.ts): read-only.
async function cmdObserve(p: Parsed): Promise<number> {
  const { Observer } = await import('../server/observe.ts')
  const x = await openExec(p)
  try {
    const o = await new Observer(x, registryFile(p)).observe({ workspace: opt(p, 'workspace'), runs: p.opts.get('run') ?? [], terminal: p.flags.has('terminal') })
    const lines = [`Observed ${o.observedAt} on ${o.host}: executor ${o.executor.state}${o.executor.ageSeconds !== null ? ` (heartbeat ${o.executor.ageSeconds} s ago)` : ''}${o.executor.slot ? `, executing ${o.executor.slot.workspace} ${o.executor.slot.run}` : ''}${o.executor.queued ? `, ${o.executor.queued} queued` : ''}`,
      ...o.runs.map(r => `  ${`${r.identity.workspace} ${r.identity.workflow}/${r.identity.run}`.padEnd(36)} ${(r.situation ?? r.source.state).padEnd(16)} ${r.waiting ? `${r.waiting.responsible}: ${r.waiting.reason}` : ''}${r.problems.length ? `\n    ${r.problems.map(x => x.message).join('\n    ')}` : ''}`),
      ...o.problems.map(x => `  problem: ${x.message}`)]
    out(lines.join('\n'), o)
    return 0
  } finally { x.close(); execStore = undefined }
}

async function cmdRuns(p: Parsed): Promise<number> {
  const [sub] = p.positional
  if (sub === 'migrate') return cmdMigrate(p)
  // project_migration p7: record the execution node of every unfinished run.
  if (sub === 'assign-nodes') {
    const by = opt(p, 'by'); if (!by) throw new UsageError('--by <name> is required')
    const x = await openExec(p)
    try {
      const notes = await x.migrateNodes({ dryRun: p.flags.has('dry-run'), by })
      out(notes.join('\n') || 'Every unfinished run has its execution node recorded.', { ok: true, notes })
      return 0
    } finally { x.close(); execStore = undefined }
  }
  if (sub !== 'index') throw new UsageError('usage: wfe runs index [--rebuild] [--workspace <id>] | wfe runs migrate [--dry-run] [--workspace <id>] --by <name> | wfe runs assign-nodes [--dry-run] --by <name>')
  const { inspectIndex } = await import('../server/runspace.ts')
  const ws = await workspace(p)
  const entries = await inspectIndex(ws, { rebuild: p.flags.has('rebuild') })
  const lines = entries.length ? entries.map(e => `  ${e.ref.padEnd(28)} ${e.state.padEnd(9)} ${e.branch ?? ''}${e.problem ? `\n    ${e.problem}` : ''}`) : ['  (no run has a working copy in this workspace)']
  out([`Run copies of workspace ${ws.reg.id}:`, ...lines].join('\n'), { workspace: ws.reg.id, entries })
  return entries.some(e => e.state === 'damaged') ? 1 : 0
}

// The p9 migration (docs/storage.md *Migration*): an inventory first
// (--dry-run changes nothing), then the move of non-terminal runs into
// working copies of their own; resumable from its journal.
async function cmdMigrate(p: Parsed): Promise<number> {
  const { inventory, migrate } = await import('../server/migrate.ts')
  const x = await openExec(p)
  try {
    const only = opt(p, 'workspace')
    if (p.flags.has('dry-run')) {
      const inv = await inventory(x, only)
      const lines = ['Inventory (nothing was changed):', `Executor: ${inv.executor}`, ...inv.runs.map(r => `  ${`${r.workspace}/${r.ref}`.padEnd(36)} ${r.action.padEnd(13)} ${r.why}${r.jobs ? `; ${r.jobs} queued job(s)` : ''}${r.checkpoints.length ? `; checkpoints ${r.checkpoints.map(c => `${c.id} ${c.state}`).join(', ')} keep their mode` : ''}${r.presentations.length ? `; open presentations ${r.presentations.join(', ')}` : ''}`),
        'Repositories:', ...inv.repositories.map(r => `  ${r.workspace} ${r.path.padEnd(20)} ${r.branch ?? '(detached)'} ${r.head?.slice(0, 10) ?? '?'}${r.dirty.length ? ` — ${r.dirty.length} uncommitted` : ''}`),
        ...inv.unattributed.map(u => `Uncommitted in ${u.workspace}, outside run folders (not moved): ${u.paths.join(', ')}`)]
      out(lines.join('\n'), inv)
      return 0
    }
    const by = opt(p, 'by')
    if (!by?.trim()) throw new UsageError('--by <name> is required: who migrates')
    const env = (await giteaOf(p)) ? await (await giteaOf(p))!.gitEnv() : {}
    const r = await migrate(x, { workspace: only, by: by.trim(), env, allowLive: p.flags.has('allow-live-executor') })
    out([`Recovery copies: ${r.backup}`, `Migrated: ${r.migrated.join(', ') || '—'}`, `Already migrated: ${r.already.join(', ') || '—'}`, `Kept where they are:`, ...r.kept.map(k => `  ${k}`), ...(r.blocked.length ? ['Blocked:', ...r.blocked.map(b => `  ${b}`)] : []), ...(r.problems.length ? ['Problems:', ...r.problems.map(b => `  ${b}`)] : [])].join('\n'), { ...r, inventory: undefined })
    return r.problems.some(x => !/uncommitted files outside run folders/.test(x)) || r.blocked.length ? 1 : 0
  } catch (e) {
    if (e instanceof Error && !(e instanceof UsageError) && !(e instanceof RequestError)) throw new Refused(e.message)
    throw e
  } finally { x.close(); execStore = undefined }
}

const COMMANDS: Record<string, (p: Parsed) => Promise<number>> = {
  runs: cmdRuns, observe: cmdObserve, projects: cmdProjects, run: cmdRun, delegate: cmdDelegate, present: cmdPresent, share: cmdShare, project: cmdProject, repo: cmdRepo, gitea: cmdGitea, dashboard: cmdDashboard, exec: cmdExec, request: cmdRequest, notify: cmdNotify, intake: cmdIntake,
  create: cmdCreate, register: cmdRegister, list: cmdList, status: cmdStatus, validate: cmdValidate,
  approve: cmdApprove, arrange: cmdArrange, 'add-repo': cmdAddRepo, workflow: cmdWorkflow, serve: cmdServe, setup: cmdSetup,
  version: cmdVersion, nodes: cmdNodes, boast: cmdBoast, context: cmdContext, conversation: cmdConversation,
}

// The entrance's conversations (project_migration p8, docs/conversations.md).
async function cmdConversation(p: Parsed): Promise<number> {
  return conversationCommand({
    positional: p.positional, opt: k => opt(p, k), opts: k => p.opts.get(k) ?? [], out,
    usage: m => new UsageError(m), refused: (m, d) => new Refused(m, d),
    exec: () => openExec(p), area: () => areaDir(p),
  })
}

// Scoped context (workflow_editor p13, docs/context.md).
async function cmdContext(p: Parsed): Promise<number> {
  return contextCommand({
    positional: p.positional, opt: k => opt(p, k), opts: k => p.opts.get(k) ?? [], flag: k => p.flags.has(k), out,
    usage: m => new UsageError(m), refused: (m, d) => new Refused(m, d),
    area: () => areaDir(p),
    access: async () => { const g = await giteaOf(p); return { registryFile: registryFile(p), area: areaDir(p), gitea: g, giteaProblem: g ? undefined : `no Gitea setting at ${giteaFile(p)}` } },
    workspace: () => workspace(p), exec: () => openExec(p),
    resolveRun: async (ws, text) => (await import('../server/runs.ts')).resolveRef(ws, text),
  })
}

// Project access (project_migration p4): reads of any managed project.
async function cmdProjects(p: Parsed): Promise<number> {
  return projectsCommand({
    positional: p.positional, opt: k => opt(p, k), flag: k => p.flags.has(k), out, json: () => json,
    usage: m => new UsageError(m),
    ctx: async () => { const g = await giteaOf(p); return { registryFile: registryFile(p), area: areaDir(p), gitea: g, giteaProblem: g ? undefined : `no Gitea setting at ${giteaFile(p)}`, refresh: p.flags.has('refresh') } },
  })
}

// The person's node catalog (p7/ex1): templates, examples, instantiation.
async function cmdNodes(p: Parsed): Promise<number> {
  const reg = await loadRegistry(registryFile(p)).catch(() => null)
  return nodesCommand({
    positional: p.positional, opt: k => opt(p, k), opts: k => p.opts.get(k) ?? [],
    area: () => areaDir(p), by: () => reg?.approver || undefined,
    workspace: () => workspace(p), workflowFile, out,
    usage: m => new UsageError(m), refused: (m, d) => new Refused(m, d),
  })
}

// Boast (p12, docs/boast.md): a project's showcase page, read-only.
async function cmdBoast(p: Parsed): Promise<number> {
  const [first, ...rest] = p.positional
  if (first === 'reference') { console.log(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'boast.md'), 'utf8')); return 0 }
  const project = first === 'status' ? rest[0] : first
  if (!project) throw new UsageError('boast needs a project id')
  const source = opt(p, 'source') ?? 'committed'
  if (source !== 'committed' && source !== 'worktree') throw new UsageError('--source is committed or worktree')
  const g = await giteaOf(p)
  const { boastState } = await import('../server/boast.ts')
  const { loadPresentConfig } = await import('../server/present.ts')
  const s = await boastState({ registryFile: registryFile(p), area: areaDir(p), gitea: g, giteaProblem: g ? undefined : `no Gitea setting at ${giteaFile(p)}`, refresh: p.flags.has('refresh') }, project, { source, workspace: opt(p, 'workspace') })
  const base = (() => { try { return loadPresentConfig(areaDir(p)).answerBase } catch { return null } })()
  const reg = await loadRegistry(registryFile(p)).catch(() => null)
  const ws = s.workspace?.id ?? reg?.workspaces.find(w => w.project === project)?.id
  const editor = base && ws ? `${base}#/ws/${encodeURIComponent(ws)}` : null
  const page = base && s.entry ? new URL(s.entry, base).href : null
  const fetch = s.provenance.fetch
  out([
    `${project}: ${s.state === 'present' ? 'boast/index.html is' : 'no boast/index.html'} ${s.source === 'committed' ? `on ${s.provenance.revision.ref ?? 'main'} at ${s.commit}` : `in workspace ${s.workspace?.id}'s working tree (HEAD ${short(s.commit)}${s.workspace?.dirty ? ', boast/ has uncommitted changes' : ''})`}`,
    ...(fetch?.state === 'stale' ? [`  fetched ${fetch.at}; Gitea could not be read now: ${fetch.error}`] : []),
    ...(page ? [`  page:           ${page}`] : []),
    ...(editor ? [`  Project Editor: ${editor}`] : base ? [] : ['  (present.json has no answerBase: no LAN address to name)']),
  ].join('\n'), { ...s, urls: { page, editor } })
  return 0
}

async function cmdVersion(): Promise<number> {
  const v = codeVersion()
  out(v.release ? `release of agdevworld ${v.release.agdevworld} (built ${v.release.built})\n${v.package}` : `source checkout (no RELEASE.json)\n${v.package}`, v)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  // On a remote worker (project_migration p7, docs/workers.md) wfe is the
  // coordinator's client; only its shared areas are read here.
  if (process.env.WFE_WORKER_AREA && !process.env.WFE_REGISTRY && !remoteLocal) {
    const { remoteMain } = await import('./remote.ts')
    return remoteMain(argv, a => { remoteLocal = true; return main(a) })
  }
  let p: Parsed
  try { p = parse(argv) } catch (e) { console.error(`wfe: ${(e as Error).message}`); return 2 }
  json = p.flags.has('json')
  const [cmd, ...rest] = p.positional
  if (!cmd || cmd === 'help' || (!cmd && p.flags.has('help'))) {
    const topic = cmd === 'help' ? rest[0] : undefined
    if (topic === 'run') console.log(runIndex())
    else if (topic === 'delegate') console.log((await import('./delegate.ts')).DELEGATE_INDEX)
    else if (topic && HELP[topic]) console.log(HELP[topic])
    else if (topic) { console.error(`wfe: no command "${topic}"\n`); console.log(index(p)); return 2 }
    else console.log(index(p))
    return 0
  }
  if (!COMMANDS[cmd]) { console.error(`wfe: no command "${cmd}" (see: wfe help)`); return 2 }
  if (p.flags.has('help') && cmd !== 'run' && cmd !== 'delegate') { console.log(HELP[cmd]); return 0 }
  p.positional = rest
  // Shared-area references resolve against this area's shares.json
  // (docs/shares.md); a command without a registry (setup) has no area yet.
  try { (await import('../server/shares.ts')).setShareArea(areaDir(p)) } catch (e) { if (!(e instanceof UsageError)) throw e }
  try {
    return await COMMANDS[cmd](p)
  } catch (e) {
    if (e instanceof UsageError) { console.error(`wfe ${cmd}: ${e.message}\n\n${cmd === 'run' ? 'See: wfe run help <subcommand>' : cmd === 'delegate' ? 'See: wfe delegate help <subcommand>' : HELP[cmd]}`); return 2 }
    if (e instanceof RequestError && !(e instanceof Refused)) e = new Refused(e.message, e.detail)
    // A store that could not be opened or written: store, operation, SQLite code.
    if (e instanceof StoreError) e = new Refused(e.message)
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
