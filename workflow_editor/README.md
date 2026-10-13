# Workflow and project editor (`workflow_editor` p1, p2/pre1, p3/pre1, p4)

**A system component of agdevworld (p4/ex1).** This package is agdevworld
code: it lives in the agdevworld repository, is developed like the rest of
agdevworld, and is built and deployed by agdevworld's own scripts
(`agdevworld/scripts/wfe-release.sh`, see agdevworld's README_DEV.md). It is
not a project of the catalog it manages: it has no `project.yaml`, no
workflow, no workspace and no registration, and the operating service refuses
to register or execute anything on its source, its releases or its control
data. Its history up to p4 is `pj-agdev/experiments/workflow_editor` (frozen)
and the retired Gitea repository `developer/pj-workflow-editor`
(`9c29117`, imported here).

**The service in use is an installed release, never a source tree.** A
release is built from one agdevworld commit, checked, and only then made
current. Deployment verifies that the service and launcher report that release.

A standalone MVP that edits Git-backed project and workflow definitions from a
browser UI while the same YAML files stay editable in any text editor or agent
IDE. The file contract is in [docs/contract.md](docs/contract.md); workflow
runs (execution records) are in [docs/runs.md](docs/runs.md); where a run's
work is kept (its own working copy and branches, p9) is in
[docs/storage.md](docs/storage.md).

**Writers take turns.** UI edits and external edits are assumed not to overlap.

## Layout

| Path | Purpose |
| --- | --- |
| `shared/` | Models, validation, canonicalization and digests; `compile.ts`, the effective execution graph of a documentation policy (p5); `run.ts`, the run reducer (service, CLI and browser) |
| `server/` | Local service: YAML round-trip, Git inspection, file persistence, watching, project creation and registration; `runs.ts`, run folders and operations |
| `cli/wfe.ts`, `cli/run.ts` | `wfe`, the command-line surface over the same modules (`wfe help`, `wfe run help`) |
| `src/` | Browser UI (TypeScript, Vite, DOM cards and SVG edges) |
| `examples/` | Synthetic project and workflow files; `invalid/` for validation tests |
| `scripts/seed.ts` | Builds the local fixture repositories and workspaces |
| `test/` | `node --test` suites |
| `checks/` | Browser checks and the update measurement (`measure.ts`) |

## agdev operation (p4)

The operating instance serves the **agdev dashboard** (`#/`) and the Project
Editor for the operating area's registry (`pj-agdev/.local/agdev/`, ignored):

| File | Content |
| --- | --- |
| `registry.json` | projects (id → Gitea root repository), repositories (by Gitea id: owner/name as registered, category, description), workspaces on this host |
| `gitea.json` | `{"url", "owner", "tokenFile"}`; the token file is outside every repository |
| `system.json` | the operating boundary (below); system configuration, outside every managed project |
| `pj-<id>/` | workspaces created here or obtained from Gitea |
| `service/`, `bin/wfe` | installed releases and the launcher (agdevworld's `scripts/wfe-release.sh`) |

The registry is always given explicitly (`--registry` / `WFE_REGISTRY`; the
area's `bin/wfe` sets it). There is no default: moved code must never open a
different, empty catalog.

### The operating boundary (p4/ex1, `server/boundary.ts`)

The supported management and execution operations never register, create,
request, claim or open a workspace whose real path overlaps a protected path
(the path itself, inside it, or containing it — after resolving symbolic
links), and never take up a retired repository:

| Protected | Source |
| --- | --- |
| The package directory this process runs (a source checkout or an installed release) | implicit |
| `registry.json`, `gitea.json`, `system.json`, `service/`, `bin/`, `.local/` of the area | implicit |
| Further paths (agdevworld's source, autolab, the frozen experiment) | `system.json` → `protectedPaths` |
| Retired repositories, by Gitea id and owner/name | `system.json` → `retiredRepositories` |

`system.json` sits beside the registry, outside every managed project, so no
project file or workflow declaration can change it; a malformed one refuses
these operations rather than reading as empty. The checks are in the shared
operations, so the browser, the API and the CLI meet the same refusal (403,
or exit 1):

- registration (`wfe register`, the dashboard's register by path, a
  workspace obtained from Gitea, project creation's destination, checked
  before anything is written);
- every workspace resolution (API, CLI), a request, and the executor's claim
  — a job for a protected or retired workspace is dropped with the reason,
  so a hand-edited registry gains nothing;
- a retired repository as a registered repository, a project root, a
  workspace's `origin`, a shared repository added to a project, or a
  submodule location.

The dashboard shows a registration that is refused as unavailable, with the
refusal. These checks protect the supported operations; they are not an OS
sandbox (an agent with shell access under the same account can still reach
the files).

`wfe project unregister <id>` removes a project, its workspaces and its root
repository entry from the registry, and nothing else (folders and Gitea
stay); it is refused while a workspace of the project has a queued job or an
open attempt.

agdevworld reaches it same-origin at `http://<host>:8093/wfe/`: its nginx
listens on 8093, published on every interface, and proxies `/wfe/` to the
service with the request's own `Host` and an `x-wfe-route` header. Through that
route the service refuses every operation that takes a host path or a
repository location (path registration, submodules by URL, local projects);
those stay with `wfe` on this host. The operation room links "agdev dashboard
↗" to it.

- **Gitea.** New projects and shared repositories live on Gitea
  (`server/gitea.ts`). The token reaches Git as an HTTP header through
  `GIT_CONFIG_*` variables scoped to the Gitea URL; it is never in a URL, a
  remote, a Git config file, a project file or a run record. Submodule URLs are
  relative (`../<name>.git`). Creation, registration and workspace retrieval
  are `wfe create` (with the setting), `wfe project register|obtain`, `wfe repo
  register|create|add`, `wfe dashboard`, and the dashboard's forms. Creation
  journals each step with the Gitea ids it created, so `--resume` continues
  after a partial failure without creating anything twice; a same-named
  repository it did not create is a collision (`--reuse` adopts an empty one
  on purpose). Gitea's API lags behind pushes, so contents are read through
  `git ls-remote` / a shallow fetch into `<area>/.local/gitea-cache/`.
- **Dashboard and Project Editor.** The dashboard lists every project (purpose,
  workspaces here, ongoing runs and waits, where its definition was read) and
  every shared repository once (category, description, Gitea link, every
  project that uses it, read from that project's workspace or Gitea commit). A
  read failure is shown as such, never as an empty list. The Project Editor's
  "Add existing repository" searches the registry and adds one as a submodule
  of that project only; other projects keep their gitlinks.
- **Tests and checks.** `test/gitea.test.ts` and `checks/agdev.ts` start a
  disposable Gitea container (`test/giteaFixture.ts`, image
  `gitea/gitea:latest`; skipped without Docker; `WFE_TEST_GITEA=<setting>`
  points them at another test instance).

### Execution by autolab

`agautolab.wfexec` (in `pj-agdev/agautolab`, through the area's installed `bin/wfe`) is the executor: one slot, the
agent launched in the project's workspace in its own process group with
`WFE_ATTEMPT`, its guide `agautolab/agent/guides/wfrun/guide.md`, its role
`wfrun` in `agents.toml`. It reaches this host's execution management only
through `wfe exec` (claim, started, finished, stops, heartbeat, reconcile);
the rules are in `shared/run.ts` and `server/exec.ts` (docs/runs.md,
"Execution by autolab"). `test/exec.test.ts` and `checks/exec.ts` exercise
them synthetically; `agautolab/tests/test_wfexec.py` runs the loop with a
stub agent.

## Fixture

```sh
npm ci
npm run seed -- --reset
```

The seed creates bare source repositories, a project `pj-demo` with `devdocs`,
`study/*`, `wedo/*` and `assets/shared` submodules (relative URLs), and two
workspaces `a` and `b` cloned from it, under agdevworld's `.local/wfe-fixture/`
(ignored; outside this package, whose own directory the editor never registers). Workspace A leaves `assets/shared` uninitialized. The registry of
workspaces is `registry.json` there; it is machine-specific and never tracked.
Local file transport for submodules is enabled per command
(`-c protocol.file.allow=always`), not in any Git config file.

## Start the editor

Development (two processes):

```sh
npm run service   # local service on http://127.0.0.1:8095
npm run dev       # Vite on http://127.0.0.1:5175, proxying /api
```

Single process, serving the production build:

```sh
npm start         # builds, then serves UI and API on http://127.0.0.1:8095
```

The page opens on the projects list (`#/`). The service reads the registry it
is given (`--registry <file>` or `WFE_REGISTRY`, required; the npm scripts give
the fixture's `../.local/wfe-fixture/registry.json`; `--area`, `--port`,
`--poll-ms` (definitions, default 1000), `--git-poll-ms` (Git state, default 3000)). `wfe serve` builds the UI and starts the service for the
registry it is given.

The service binds to every interface (`--bind`, default `0.0.0.0`) and
answers to any host name, so it is reached from the LAN under any of the
host's names. Browser writes are accepted from the page's own origin (the
origin matching the request's `Host`), the Vite dev origin and `--origins`;
a page of another site cannot write. Clients without an `Origin` header
(curl, scripts) may write too.

## Projects: create and register

A project is created or registered from the browser's home page (`#/`,
"Create project" / "Register workspace") or with `wfe create` /
`wfe register`. Both run the same operations (`server/create.ts`,
`server/registry.ts`):

- **Create** makes a Git repository with `project.yaml`, `.gitignore`
  (`.local/`), an empty `.local/` and `devdocs` as a submodule, then registers
  it. devdocs comes from a new local source `sources/<id>-devdocs.git` in the
  authoring area, or from a given existing repository. The submodule URL is
  relative to the project root. Two commits are made with the person's Git
  identity (the new source's initial commit and the root's); a missing
  identity stops creation before anything is written. An occupied destination
  is refused. A creation that stops partway reports what was done and is
  continued with resume ("Continue creation" / `--resume`).
- **Register** records the Git root containing a directory. Repeating it
  changes nothing. What the project lacks is reported with its fix.

The browser creates projects only beneath the service's authoring area
(`--area`, default: the registry's directory); `wfe create` is the caller's
own process and takes any destination. A missing registry is an empty setup
state; a malformed one is shown as an error and never overwritten.

## Authoring area (person + IDE agent)

```sh
node cli/wfe.ts setup <area> --port 8097
```

creates or refreshes an ignored authoring area, separate from the p1 fixture:

| File | Content |
| --- | --- |
| `AGENTS.md` | the IDE agent's guide, from `templates/AGENTS.md` |
| `CLAUDE.md` | `@AGENTS.md`, so Claude Code reads the same guide |
| `START.md` | the person's steps, from `templates/START.md` |
| `wfe` | launcher pinning the area's registry, area and port |
| `registry.json` | the area's workspaces (created empty if missing, never rewritten) |
| `.claude/settings.json` | Claude Code permissions for `wfe`, Git and edits in the area (created once, then kept) |
| `sources/` | local repositories that projects use as submodules |

The machine-specific paths are filled in only in these generated files. A
generated Markdown file whose first-line stamp was removed counts as edited
by hand, and setup keeps it. Setup never creates a project. The person opens
the area in VS Code and starts the agent there; `START.md` gives the service
command, the URL and a first prompt.

## Command line

`wfe help` lists the commands; `wfe help <command>` says what each reads or
changes, its inputs and its result. No command needs the running service.

```sh
node cli/wfe.ts help          # from the checkout (or: npm run wfe -- help)
```

| Command | Purpose |
| --- | --- |
| `create`, `register`, `list`, `status` | projects, workspaces, Git state |
| `add-repo` | `git submodule add`, as the project view does |
| `workflow new`, `validate`, `approve`, `arrange` | workflows: template, validation, approvals, auto-arrange |
| `run create`, `list`, `show`, `check`, `access`, `start`, `complete`, `ask`, `answer`, … | workflow runs (docs/runs.md) |
| `present register|start|status|stop|reconcile` | presentations of a run's result (docs/presentations.md) |
| `runs index [--rebuild]` | runs' own working copies on this host (docs/storage.md) |
| `serve` | build the UI and start the service for this registry |

`--registry` / `WFE_REGISTRY`, `--area` / `WFE_AREA` and `--port` /
`WFE_PORT` select the registry (required), area (default: the registry's
directory) and service port.

## Runs

A run is one execution of a workflow, recorded in
`devdocs/runs/<workflow-id>/<run-id>/` (p4): the person's `braindump.md` (or an
agent's `request.md`), the executor's `plan.md` and reports, a fixed byte copy
of the workflow in `definition/`, and
`run.json`, whose current state must equal the replay of its history by
`shared/run.ts`. `wfe run create` makes one; `wfe run start/complete/wait/
ask/answer/take-up/…` append one history entry each; `wfe run show`
and the browser show it: the project view lists runs, and the run view
(`#/ws/<ws>/run/<workflow>/<run>`, or `…/at/[root:]<commit>` for history)
draws the run's fixed graph with each node's state as text and color, what
waits for whom, questions (the person can record an answer there), related
runs, reports and history. Workflows with delegate nodes can be edited and
shown, but no run of them is created (p4).
Nothing executes nodes; the executor records what it does, and the tools
enforce readiness (a join waits for every predecessor; failures never satisfy
a dependency). Files are saved, never committed. See
[docs/runs.md](docs/runs.md).

**Documentation policy (p5).** A workflow declares `documentation.policy`
(`default` or `manual`; chosen at creation, changed in Workflow settings
in the editor). Under `default` the editor previews what a run adds, from
the same compiler run creation uses (`shared/compile.ts`): a normal-sized
plan talk card before the entry cards, a small report icon inside each
card's lower-right corner (it moves with its card; it has no position of its
own) and a dashed final-report endpoint. Selecting one shows its document, what
it waits for and the instructions the agent gets. The run view draws the
run's frozen graph the same way: work and reporting are separate states, a
report being written is highlighted and labelled "Writing report", states
carry a glyph and an accessible label besides their color, and the detail
view says whether the document is missing, being written or checked (and
opens it). Work and documentation steps are counted apart. Under `manual`
nothing is added. Changing the policy changes the preview and makes the
definition approval stale; it never changes a saved run.

**The two screens (p8).** The workflow editor has a slim header (crumbs,
Refresh, save state, Save), a title band (the editable name, the intent's
first line, both approval states, a validation chip and two explicit entries:
**Intent & approvals** — the authoritative intent, the declared approver and
the two approvals — and **Workflow settings** — policy, bindings, the full
validation list), an **Add node** menu (base types and the person's
templates), and an inspector that opens only for a selection or settings and
closes with × or Escape. The run view has a header with the connection, a
title band that keeps recorded progress, the decision and executor activity
apart (**Run details** holds timestamps, backend, attempts and provenance), a
**focus card** chosen from the run's state — the person's current task, with
the canonical answer forms, the resume form while held and the decision when
a completed run has none — above the graph, and a side pane of labelled,
expandable record sections. The canvas opens whole at up to 100 % when the
graph fits at a readable scale (72 %); otherwise at that scale from the
graph's start (a run: its current position) with an in-view count and Fit.
A size change never resets the person's zoom or pan.

**Simple and Detail (p8/ex1).** Every screen's top bar ends with the same
**Simple | Detail** toggle (`src/displayMode.ts`). It is a per-browser
preference (`workflow-editor.display`), Simple by default and when storage is
unreadable, and separate from the graph's Compact/Mini (`workflow-editor.mode`,
offered in Detail only). Simple shows the purpose, the situation and the
person's next action: the Dashboard's project tiles (name, purpose, status
icons, waiting runs, Open project); the project's name and purpose, the
request form, recent runs and workflows with one state each; the
workflow's name, purpose, one approval state, Add node, Save and the graph;
the run's title, progress, focus card with its forms and the graph; User
nodes' cards. Simple cards carry an icon, a name and a state; a selection
shows its compact explanation and everyday edit. Commit ids, remotes,
branches, paths, backend identifiers, exact times, record sections and the
outcome list are Detail's. Contextual entries ("Project settings", "New
project", the approval state, "More details", "Reports & files", "All
records", "Adjust future work", "Edit template") switch to Detail and reveal
their target. Both modes are one DOM — `.d-only` and `.s-only` elements,
nothing rebuilt or cloned — so drafts, selections, open panels and sections,
scroll positions (per screen and mode) and file offsets survive a switch; a
switch asked during an IME composition waits for it to end. The top bars stay
in view, so the toggle is one click away anywhere.

**Creating a workflow (p8/ex2).** The project's workflow list has
**Create workflow** in its head in both modes; an empty list offers the same
entry (`src/createWorkflow.ts`). The form asks for a name; the id (derived
from the name until the person changes it, never an id already taken), the
starting template (`server/templates.ts`, `wfe workflow templates`) and the
documentation policy are behind **More settings**, which opens by itself when
one of them is refused. Refusals carry the field they concern
(`detail.field`) and are shown beside it. The form is built once and moved
by re-renders, so a background reload or a switch keeps the text, the open
state and the keyboard.

**freework (p8/ex2).** Every project has the basic workflow *Free work*: a
talk with the person, then the run adds the work agreed in the
conversation as it goes, and ends with a final report (docs/contract.md,
*Basic workflows*; docs/adjustments.md, *Growing a run's work*). New projects
get it at creation; existing ones with `wfe workflow basics --all --dry-run`,
then without `--dry-run` (`--commit --push` to publish the file). It is
chosen in the request form like any workflow; the Create workflow form
offers it as the template *Free work* under another id.

**Documentation settings (p8/ex2).** Besides `default` (plan talk, a report
per step, final report) and `manual` (none), a workflow can be `custom`:
the three generated documents chosen one by one (docs/contract.md,
*Documentation policy*). Workflow settings and the creation form use one
control (`src/docPolicy.ts`): the policy, and under Custom three checkboxes
that start from what the previous policy generated. The policy chip and the
canvas preview follow each change; without node reports the final report is
drawn after the last card itself. Views decide from the graph's generated
steps, never from the policy's name.

**The activity line (p8/ex2).** Under the run's progress, one line says that
the run moves without showing the log: *Working on Implement · 24 turns this
session · last activity 8 s ago*. The turns are the current session's, counted
from its own output on this host (`server/activity.ts`); the age ticks every
second without announcing anything, and a new turn makes the line pulse once
(not under reduced motion). Waiting, queued, held, stopping, a lost process,
another host, a lost connection, finished and cancelled each replace the count
with what they are (docs/runs.md, *Activity*). Detail lists the turns with
each attempt. A run whose plan has grown (adjustments) shows its done steps
without a fraction, so the bar is never read as time left.

**How the run view stays live (p7/ex2).** The view is built once and kept up
to date in place, so whatever arrives never interrupts typing or reading:

- **One refresh coordinator per view** (`src/runRefresh.ts`). The first load,
  SSE changes, reconnection, the 3 s host-facts cadence and the person's own
  operations all request a `full` or a `host` refresh. One batch runs at a
  time; requests made meanwhile merge into the next, and `full` subsumes
  `host`. A batch's reads are concurrent, and their results are published
  together, each with its own error. An operation awaits the batch that
  shows its result. Leaving the view aborts reads and ignores anything that
  still completes. File reads carry their own identity, so a late response
  never replaces another file.
- **Persistent focus card and side pane** (`src/runSide.ts`). Each section
  has one root. Display is patched (`src/patch.ts`): unchanged nodes are not
  written, and keyed items (questions, history entries, attempts, …) keep
  their elements. Controls are created once, attached when their operation
  applies, and never rebuilt. A control's home may change with the state
  (an open question is answered in the focus card, a resolved one is a
  record at the side), but only while it holds no draft and has no focus.
  Built display carries no listeners: links and buttons name a `data-action`
  that the view handles with the state of that moment; the listener on the
  shared app root is removed with the view (p8).
- **Disclosure (p8).** Side sections are closed until the person opens them
  (kept per browser); background updates never open or close one, and
  explicit navigation (a file link, "Adjust future work", a resolved
  question) opens the one it leads to. A closed section's label carries its
  counts and marks a problem or an action; the focus card lists what needs
  the person. A closed section keeps its controls attached.
- **Input ownership.** The text in a control is the draft, and no background
  update writes it. A submission clears only the exact text it sent. Typing
  while it is in flight is kept, and a second submission waits for the first.
  When an operation stops applying (question withdrawn, run cancelled or no
  longer held), submission is disabled at once. A composing control stays
  editable until the composition ends, then turns read-only with the text
  kept and the reason shown. An adjustment preview enables Apply only for the
  text, reason, revision and sequence it inspected.
- **Reading position.** The pane holds its own anchor
  (`overflow-anchor: none`): the first visible item keeps its place when
  content changes above it; a closed section is held by its label. At the top of the history, new entries show
  beneath the heading. The open file keeps its scroll offsets when its
  content changes, and starts at the top when another file is opened. The
  person's own navigation is not anchored.
- **Scoped updates.** A host refresh whose only change is the executor's
  heartbeat time renders nothing. Other host changes update only Questions,
  Presentations, Execution, Coordination and the summary. Connection changes
  update only the live pill and banners. The canvas is drawn again only when
  its graph, states or selection change.

## Checks

```sh
npm test        # contract, persistence and Git fixture tests
npm run check   # type check, tests and production build
```

Browser checks drive the real UI with `playwright-core` and its cached
Chromium. The p1 checks need a fresh seed, the service and the dev server,
and write screenshots to `../.local/wfe-fixture/screenshots/`.
`WFE_FIXTURE=<dir>` and `WFE_URL=<url>` point them at a private seed
(`npm run seed -- --root <dir>`) and service instead:

```sh
npm run seed -- --reset && node checks/step2.ts
npm run seed -- --reset && node checks/step3.ts
npm run seed -- --reset && node checks/step4.ts
node checks/e2e.ts   # the p1 acceptance scenario; reseeds by itself
```

`checks/docsteps.ts` (p5) checks the documentation steps in both views on its
own temporary project and private service (port 8197): the preview's plan
card, report icons and final report, their attachment while a card is
dragged, Fit and zoom, step selection, the policy switch and its approval
effect, an unsaved draft during run events, "Writing report", document
states (missing, unfinished, checked, opened), split counts and a manual
run. `npm run build && node checks/docsteps.ts [--keep]`.

`checks/runs.ts` (p3/pre1) checks the run views on its own temporary project
and private service (port 8196): node states as text, branches and joins,
answers and the stale-view guard, delegation links, source edits, malformed
records, outages, run switching, an open definition draft, history at a
commit, and the update latency. It writes its record and screenshots to
`../.local/wfe-checks/`:

```sh
npm run build && node checks/runs.ts [--repeat 20] [--keep]
```

`checks/runInteraction.ts` (p7/ex2) checks input and reading state in the
run view on its own temporary project and private service (port 8202).
Background updates come from real SSE progress, file changes, intercepted
heartbeats, host failures and a service restart. It checks that they keep
each control, its focus, selection, internal scroll and a synthetic IME
composition (CDP `Input.imeSetComposition`); that file and history positions
are held; that submissions, withdrawals, cancellations, conflicts and
adjustment previews are handled safely; and that slow reads never overlap or
roll back. Synthetic composition is not the macOS Japanese IME, which is
checked by hand. `npm run build && node checks/runInteraction.ts [--keep]`.

`checks/states.ts` (p8) builds a private project with representative
states — default and manual policies, appearance and provenance, branch and
join, a large graph, long Japanese and English text, a YAML error — and 14
runs (plan question, working attempt, live review, answered, held, failed,
cancelled, accepted while cleaning up, completed on an adjusted definition,
completed without a decision, two open questions, not started, malformed,
and a historical commit), recorded through the server modules. `node
checks/states.ts --serve` keeps it running for a look (port 8210);
`--shots <dir>` captures every state at 1440 × 1000 and 1280 × 800
(`checks/statesShots.ts`).

`checks/simplerUi.ts` (p8) checks the redesigned screens on those states
(port 8212): the next action per run state, the separation of progress,
decision, executor activity and connection, controls behind panels and
disclosures, drafts across closing and background updates, focus returns,
framing, and that connections stay attached to their cards.
`npm run build && node checks/simplerUi.ts [--keep]`.

`checks/displayMode.ts` (p8/ex1) checks Simple and Detail on those states
(port 8214): the preference and its toggle (fresh, reload, navigation,
malformed and blocked storage), what Simple leaves out and Detail keeps,
the contextual entries, every run state's task in Simple, missing executor
facts and a lost connection, drafts, panels, sections, scroll and file offsets
across switches, a synthetic composition deferring a switch, preview validity,
background updates, one display listener per view, and the graph across a
switch (selection, place, Compact/Mini kept, alignment, editing in Simple).
`npm run build && node checks/displayMode.ts`. `checks/displayShots.ts --out
<dir>` captures every screen in both modes at 1440 × 1000 and 1280 × 800.
Browser checks written for the full screens open in Detail (`checks/lib.ts`).

`checks/freework.ts` (p8/ex2) checks this episode on a private project, an
empty second project and a private service (port 8216): creating a workflow
from Simple (errors beside their field, input kept across a switch and a
background reload, the id moving past one that appeared); the activity line
on a real claimed attempt with a live process and a growing log (queued,
between steps, turns and age, a reload counting the same, the pulse, no live
region, Detail's attempt turns, a lost process, a stopped service, waiting on
the person, a history view); custom documentation in Workflow settings and
the creation form (the chip, the preview, the final report connected to the
last card, Save, back to default); freework added to a project without it,
chosen and requested from Simple, its talk answered in Simple, the agreed
work added and running (progress without a fraction, the activity line, the
graph); the project and a freework run at 1440 × 1000 and 1280 × 800 without
horizontal scroll and with no path, run id, attempt id or log text in
Simple. `WFE_BROWSER=webkit` runs a check in Safari's engine (after `node
node_modules/playwright-core/cli.js install webkit`).
`npm run build && node checks/freework.ts [--keep] [--shots <dir>]`.

`checks/growth.ts` (p8/ex2) rehearses a run grown from its conversation
through the command line across three attempts (no browser): a talk asks,
the session ends, the answer resumes it, the agreed work is added with the
talk's completion (`--completing`), done, shown in a new talk, and the run
ends; fencing, a refused plain adjustment, a retransmission and `wfe run
check`. `node checks/growth.ts [--out <transcript.md>]`.

`checks/appearance.ts` (p7) checks node appearance on its own temporary
project and private service (port 8198): presets, the inspector's icon and
color, saving, and that a custom color keeps the run state's words, glyph,
pill and ring. `npm run build && node checks/appearance.ts [--keep]`.

`checks/review.ts` (p7) checks the review on its own project, private
service (port 8199) and a real presentation instance: the run view's one
review link, the review screen with the running result and its
explanation, the answer link, what is not served, and the run view after
the stop. `npm run build && node checks/review.ts [--keep]`.

These start their own service on a temporary area and registry (after
`npm run build`):

```sh
node checks/setup.ts                  # home view: create, register, registry states
node checks/measure.ts --label <name> --out <file.json>   # update latency, load, probes
```

## Not in p1

Workflow execution, agent chat, Gitea, agdevworld integration, migration of
existing projects, remote workspace discovery, conditional branches, loops,
retries, author authentication, OS-level readonly enforcement and concurrent
editing. The editor never commits or pushes after a project's initial
commits; Git publishing is done by hand.
