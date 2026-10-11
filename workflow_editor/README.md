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
current; the previous release stays for rollback.

A standalone MVP that edits Git-backed project and workflow definitions from a
browser UI while the same YAML files stay editable in any text editor or agent
IDE. The file contract is in [docs/contract.md](docs/contract.md); workflow
runs (execution records) are in [docs/runs.md](docs/runs.md).

**Writers take turns.** UI edits and external edits are assumed not to overlap.

## Layout

| Path | Purpose |
| --- | --- |
| `shared/` | Models, validation, canonicalization and digests; `run.ts`, the run reducer (service, CLI and browser) |
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

agdevworld reaches it same-origin at `http://localhost:8093/wfe/`: its nginx
listens on 8093, published on 127.0.0.1 only, and proxies `/wfe/` to the
service on the host's loopback with an `x-wfe-route` header. Through that
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
workspaces `a` and `b` cloned from it, under `.local/fixture/` in this package
(ignored). Workspace A leaves `assets/shared` uninitialized. The registry of
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
the fixture's `.local/fixture/registry.json`; `--area`, `--port`,
`--poll-ms` (definitions, default 1000), `--git-poll-ms` (Git state, default 3000)). `wfe serve` builds the UI and starts the service for the
registry it is given.

The service binds to 127.0.0.1 only and answers only to `127.0.0.1` /
`localhost` host names. Browser writes are accepted from its own origin and
the Vite dev origin; clients without an `Origin` header (curl, scripts) are
local processes and may write too.

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

## Checks

```sh
npm test        # contract, persistence and Git fixture tests
npm run check   # type check, tests and production build
```

Browser checks drive the real UI with `playwright-core` and its cached
Chromium. The p1 checks need a fresh seed, the service and the dev server,
and write screenshots to `.local/fixture/screenshots/`.
`WFE_FIXTURE=<dir>` and `WFE_URL=<url>` point them at a private seed
(`npm run seed -- --root <dir>`) and service instead:

```sh
npm run seed -- --reset && node checks/step2.ts
npm run seed -- --reset && node checks/step3.ts
npm run seed -- --reset && node checks/step4.ts
node checks/e2e.ts   # the p1 acceptance scenario; reseeds by itself
```

`checks/runs.ts` (p3/pre1) checks the run views on its own temporary project
and private service (port 8196): node states as text, branches and joins,
answers and the stale-view guard, delegation links, source edits, malformed
records, outages, run switching, an open definition draft, history at a
commit, and the update latency. It writes its record and screenshots to
`.local/p4/`:

```sh
npm run build && node checks/runs.ts [--repeat 20] [--keep]
```

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
