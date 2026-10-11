// Project editor: metadata, sub-repositories, workspaces and workflows.
import type { DashboardResponse, ProjectResponse, RepositoryStatus, RunSummary, WorkflowResponse, WorkspaceSummary } from '../shared/api.ts'
import { PROJECT_SCHEMA, type Project } from '../shared/model.ts'
import { validateProject } from '../shared/validate.ts'
import { api, ApiError } from './api.ts'
import { live, serial } from './live.ts'
import { h, short } from './dom.ts'
import { diagnosticList } from './homeView.ts'
import { icon } from './icons.ts'
import type { ViewHandle } from './main.ts'
import { ago, runHash, STATE_LABEL } from './runView.ts'

const GROUPS: { key: RepositoryStatus['category'][]; title: string }[] = [
  { key: ['root', 'devdocs'], title: 'Fixed repositories' },
  { key: ['study'], title: 'Study repositories (study/)' },
  { key: ['wedo'], title: 'Wedo repositories (wedo/)' },
  { key: ['other'], title: 'Other repositories' },
]

export function statusChips(r: RepositoryStatus): HTMLElement[] {
  const chips: HTMLElement[] = []
  if (r.kind === 'directory') {
    chips.push(h('span.chip', { title: 'devdocs is a folder of the project root repository (devdocs: directory)' }, 'folder of the root'))
    if (r.dirty) chips.push(h('span.chip.warn', { title: 'Uncommitted changes under devdocs/' }, `${r.dirty} uncommitted`))
    return chips
  }
  if (!r.initialized) chips.push(h('span.chip.warn', { title: 'The submodule is recorded but not checked out in this workspace' }, 'not initialized'))
  else if (r.kind === 'submodule') chips.push(r.branch ? h('span.chip', { title: 'Checked-out branch' }, `⑂ ${r.branch}`) : h('span.chip.muted', { title: 'HEAD is detached (normal after git submodule update)' }, 'detached HEAD'))
  else chips.push(h('span.chip', `⑂ ${r.branch ?? 'detached HEAD'}`))
  if (r.recorded) chips.push(h('span.chip', { title: `Recorded in the project root: ${r.recorded}` }, `# ${short(r.recorded)}`))
  if (r.staged) chips.push(h('span.chip.warn', { title: `Staged gitlink, not committed: ${r.staged}` }, `staged ${short(r.staged)}`))
  if (r.kind === 'root' && r.head) chips.push(h('span.chip', { title: r.head }, `# ${short(r.head)}`))
  if (r.initialized && r.kind === 'submodule' && r.matchesRecorded === false) chips.push(h('span.chip.warn', { title: `Checked out ${r.head}` }, `HEAD ${short(r.head)} ≠ recorded`))
  if (r.dirty) chips.push(h('span.chip.warn', { title: 'Uncommitted changes (git status --porcelain)' }, `${r.dirty} uncommitted`))
  if (r.publication?.ahead) chips.push(h('span.chip.warn', { title: `Commits that no remote branch contains, as last fetched${r.publication.upstream ? ` (upstream ${r.publication.upstream})` : ''}` }, `${r.publication.ahead} unpublished`))
  else if (r.initialized && r.publication) chips.push(h('span.chip.muted', { title: `Every commit is on a remote branch, as last fetched${r.publication.upstream ? ` (upstream ${r.publication.upstream})` : ''}` }, 'published'))
  if (r.error) chips.push(h('span.chip.error', r.error))
  return chips
}

const repoIcon = (r: RepositoryStatus) => icon(r.category === 'study' ? 'study' : r.category === 'wedo' ? 'do' : r.category === 'devdocs' ? 'doc' : r.category === 'root' ? 'folder' : 'repo', 'icon repo-icon')

export function renderProjectView(root: HTMLElement, wsId: string): ViewHandle {
  let data: ProjectResponse | null = null
  let saved: Project | null = null
  let draft: Project | null = null
  let externalChange = false
  let saveError = ''
  let saveState = ''
  let accessWorkflow = ''
  let accessData: WorkflowResponse | null = null
  let workspaces: WorkspaceSummary[] = []
  let addResult: HTMLElement | null = null
  let sharedResult: HTMLElement | null = null
  let shared: DashboardResponse | null = null
  let sharedError = ''
  let createError = ''
  let disposed = false
  let connected = true
  let runs: RunSummary[] | null = null
  let runsError = ''

  const dirty = () => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved)
  // Kept across renders: run progress refreshes only this card.
  const runsCard = h('section.card.runs-card')

  const header = h('header.topbar')
  const main = h('main.project-grid', h('p.muted', 'Loading project…'))
  root.append(header, main)

  interface LoadOpts { workspaces?: boolean; force?: boolean; refresh?: boolean }
  // Loads run one at a time; a forced reload discards the draft, any other
  // keeps it and flags a change on disk.
  const load = serial<LoadOpts>(async opts => {
    try {
      const [p, w] = await Promise.all([api.project(wsId, opts.refresh), opts.workspaces ? api.workspaces() : Promise.resolve(null)])
      if (disposed) return
      const changedOnDisk = !!data && data.rev !== p.rev
      data = p
      if (w) workspaces = w.workspaces
      if (!dirty() || opts.force) {
        saved = p.project ? structuredClone(p.project) : null
        draft = p.project ? structuredClone(p.project) : null
        externalChange = false
      } else if (changedOnDisk) externalChange = true
      if (accessWorkflow) accessData = await api.workflow(wsId, accessWorkflow).catch(() => null)
      render()
    } catch (e) {
      main.replaceChildren(h('p.error', (e as Error).message))
    }
  }, (a, b) => ({ workspaces: a.workspaces || b.workspaces, force: a.force || b.force, refresh: a.refresh || b.refresh }))

  function renderHeader() {
    const name = data?.project?.name || data?.project?.id || 'Project'
    const select = h('select.ws-select', {
      'aria-label': 'Workspace',
      onchange: (e: Event) => { location.hash = `#/ws/${encodeURIComponent((e.target as HTMLSelectElement).value)}` },
    }, workspaces.map(w => h('option', { value: w.id, selected: w.id === wsId, disabled: !w.observed.available }, `${w.label}${w.observed.available ? '' : ' (unavailable)'}`)))
    header.replaceChildren(
      h('div.crumbs', h('a', { href: '#/' }, 'Projects'), h('span.sep', '/'), h('strong', name),
        h('span.pill.ok', icon('check', 'icon small'), `workspace ${wsId}`)),
      h('div.top-actions',
        connected ? null : h('span.pill.warn', { title: 'Changes on disk are not shown until the editor service is reachable again; the view re-reads everything then.' }, 'Not connected — not live'),
        h('button', { title: 'Re-read the project and the repositories\' Git state now', onclick: () => void load({ workspaces: true, refresh: true }) }, 'Refresh'),
        h('label.ws-label', 'Workspace ', select)),
    )
  }

  function renderProjectCard(): HTMLElement {
    const card = h('section.card.project-meta')
    card.append(h('h2', 'Project'))
    if (!data) return card
    // project.yaml problems are shown below; the rest of the structure here.
    const missing = data.structure.filter(d => !d.code.startsWith('project-'))
    if (missing.length) card.append(h('div.banner.warn', 'This project is incomplete:'), diagnosticList(missing)!)
    if (data.problem) {
      card.append(h('div.banner.error', `project.yaml cannot be edited: ${data.problem.message}${data.problem.line ? ` (line ${data.problem.line})` : ''}. Fix the file; the view reloads when it changes.`))
      if (!saved) return card
    }
    if (!draft) {
      card.append(h('p.muted', 'No project.yaml yet.'), h('button', {
        onclick: () => { draft = { schema: PROJECT_SCHEMA, id: '', name: '', devdocs: data?.repositories.some(r => r.path === 'devdocs' && r.kind === 'submodule') ? 'submodule' : 'directory', intent: '', goals: [] }; saved = { ...draft, id: '-' }; render() },
      }, 'Create project.yaml'))
      return card
    }
    const d = draft
    if (externalChange) {
      card.append(h('div.banner.warn', 'project.yaml changed on disk while you have unsaved edits. ',
        h('button', { onclick: () => void load({ force: true }) }, 'Reload from disk (discard my edits)')))
    }
    const readonly = !!data.problem
    card.append(
      h('label.field', h('span', 'Id'), h('input', { value: d.id, disabled: !!saved?.id && saved.id !== '-', title: 'Stable identifier; edit the file to change it', oninput: (e: Event) => { d.id = (e.target as HTMLInputElement).value; touch() } })),
      h('label.field', h('span', 'Name'), h('input', { value: d.name, disabled: readonly, oninput: (e: Event) => { d.name = (e.target as HTMLInputElement).value; touch() } })),
      h('label.field', h('span', 'devdocs'), h('input', { value: d.devdocs ? `${d.devdocs} — ${d.devdocs === 'submodule' ? 'a repository of its own' : 'a folder of the project root repository'}` : '(not declared)', disabled: true, title: 'The devdocs storage mode is fixed at creation; it is not converted' })),
      h('label.field', h('span', 'Intent'), h('textarea', { rows: 4, value: d.intent, disabled: readonly, oninput: (e: Event) => { d.intent = (e.target as HTMLTextAreaElement).value; touch() } })),
    )
    const goals = h('ol.goals')
    d.goals.forEach((g, i) => goals.append(h('li',
      h('input', { value: g, disabled: readonly, 'aria-label': `Goal ${i + 1}`, oninput: (e: Event) => { d.goals[i] = (e.target as HTMLInputElement).value; touch() } }),
      h('button.icon-btn', { title: 'Remove goal', disabled: readonly, onclick: () => { d.goals.splice(i, 1); touch(true) } }, '×'))))
    card.append(h('div.field', h('span', 'Goals'), goals, h('button.ghost', { disabled: readonly, onclick: () => { d.goals.push(''); touch(true) } }, '+ Add goal')))
    const issues = validateProject(d)
    card.append(
      h('ul.issues', issues.map(i => h(`li.${i.severity}`, i.message))),
      h('div.save-row',
        h('button.primary', { disabled: readonly || !dirty(), onclick: () => void save() }, 'Save project.yaml'),
        h('span.save-state', saveError ? h('span.error', saveError) : dirty() ? 'Unsaved changes' : saveState || 'Saved'),
      ),
    )
    return card
  }

  function touch(rerender = false) {
    saveState = ''
    if (rerender) render(); else updateSaveRow()
  }
  function updateSaveRow() {
    const btn = main.querySelector<HTMLButtonElement>('.project-meta .save-row button')
    const state = main.querySelector('.project-meta .save-state')
    if (btn) btn.disabled = !dirty()
    if (state && !saveError) state.textContent = dirty() ? 'Unsaved changes' : 'Saved'
    const list = main.querySelector('.project-meta ul.issues')
    if (list && draft) list.replaceChildren(...validateProject(draft).map(i => h(`li.${i.severity}`, i.message)))
  }

  async function save() {
    if (!draft) return
    saveError = ''
    try {
      await api.saveProject(wsId, draft)
      saved = structuredClone(draft)
      saveState = `Saved ${new Date().toLocaleTimeString()}`
      externalChange = false
      await load({})
    } catch (e) {
      saveError = `Save failed: ${(e as Error).message}. Your edits are kept; retry when resolved.`
      render()
    }
  }

  function renderRepos(): HTMLElement {
    const card = h('section.card.repos')
    const workflows = data?.workflows.filter(w => w.id) ?? []
    card.append(h('div.card-head', h('h2', 'Sub-repositories (Git submodules)'),
      h('label.inline', 'Access in workflow ', h('select', {
        'aria-label': 'Show access for workflow',
        onchange: async (e: Event) => {
          accessWorkflow = (e.target as HTMLSelectElement).value
          accessData = accessWorkflow ? await api.workflow(wsId, accessWorkflow).catch(() => null) : null
          render()
        },
      }, h('option', { value: '' }, '— none —'), workflows.map(w => h('option', { value: w.file, selected: w.file === accessWorkflow }, w.name || w.id))))))
    if (!data) return card
    const bindings = accessData?.workflow ? Object.entries(accessData.workflow.repositories) : []
    for (const g of GROUPS) {
      const repos = data.repositories.filter(r => g.key.includes(r.category))
      if (!repos.length && g.key[0] !== 'study' && g.key[0] !== 'wedo') continue
      const group = h('div.repo-group', h('h3', g.title))
      if (!repos.length) group.append(h('p.muted.small', 'None.'))
      for (const r of repos) {
        const access = bindings.filter(([, b]) => (b.path.replace(/^\.\//, '').replace(/\/$/, '') || '.') === r.path)
        group.append(h('div.repo-row', { dataset: { path: r.path } },
          repoIcon(r),
          h('div.repo-main', h('strong', r.name), h('span.muted.small', r.path === '.' ? '.' : r.path),
            r.url ? h('span.muted.small', { title: 'Source as written in .gitmodules / remote.origin.url' }, `source ${r.kind === 'root' ? '(origin)' : r.url}`) : null),
          h('div.chips', statusChips(r)),
          h('div.access', accessWorkflow
            ? (access.length ? access.map(([key, b]) => h(`span.access-badge.${b.access === 'editable' ? 'editable' : 'readonly'}`, { title: `binding "${key}"` }, b.access === 'editable' ? 'Editable' : 'Read-only')) : h('span.muted.small', 'not bound'))
            : null),
        ))
      }
      card.append(group)
    }
    // Bindings whose path is not a repository of this project.
    const unresolved = bindings.filter(([, b]) => !data!.repositories.some(r => r.path === (b.path.replace(/^\.\//, '').replace(/\/$/, '') || '.')))
    if (unresolved.length) card.append(h('div.banner.error', `Unresolved in ${accessData?.workflow?.name}: `, unresolved.map(([k, b]) => `${k} → ${b.path}`).join(', ')))
    card.append(renderAddShared(), renderAddRepo())
    return card
  }

  // "Add existing repository": a shared repository from the global
  // registry, added as a submodule of this project at a chosen path. Only
  // this project's .gitmodules and index change.
  const sharedQuery = h('input', { placeholder: 'search registered repositories', 'aria-label': 'Search registered repositories' })
  const sharedPath = h('input', { placeholder: 'study/rts', 'aria-label': 'Destination path' })
  let sharedPick = ''
  sharedQuery.addEventListener('input', () => render())
  function renderAddShared(): HTMLElement {
    const box = h('div.add-shared', h('h3', 'Add existing repository'),
      h('p.muted.small', 'Searches the shared repositories registered on this host (agdev dashboard) and adds the chosen one here as a submodule, with a URL relative to this project on Gitea. It is staged, not committed. Other projects keep their own pinned revisions.'))
    if (!shared && !sharedError) {
      void api.dashboard().then(d => { shared = d; render() }, e => { sharedError = (e as Error).message; render() })
      box.append(h('p.muted.small', 'Loading the registry…'))
      return box
    }
    if (sharedError) { box.append(h('div.banner.error', `The registry cannot be read: ${sharedError}`)); return box }
    const q = sharedQuery.value.trim().toLowerCase()
    const list = (shared?.repositories ?? []).filter(r => r.category !== 'devdocs' && r.category !== 'root')
      .filter(r => !q || `${r.registered.owner}/${r.registered.name} ${r.description} ${r.category}`.toLowerCase().includes(q))
    const rows = h('div.shared-list', list.length ? list.map(r => h(`label.shared-row${sharedPick === r.key ? '.picked' : ''}`,
      h('input', { type: 'radio', name: `shared-${wsId}`, checked: sharedPick === r.key, onchange: () => { sharedPick = r.key; if (!sharedPath.value) sharedPath.value = `${r.category === 'other' ? 'shared' : r.category}/${r.registered.name.replace(/^(study|wedo)-/, '')}`; render() } }),
      h('span', h('strong', r.gitea.fullName ?? `${r.registered.owner}/${r.registered.name}`), h('span.muted.small', ` · ${r.category}${r.description ? ` · ${r.description}` : ''}${r.usedBy.length ? ` · used by ${[...new Set(r.usedBy.map(u => u.project))].join(', ')}` : ' · not used yet'}`),
        r.gitea.state !== 'ok' ? h('span.chip.warn', r.gitea.state) : null))) : h('p.muted.small', shared?.repositories.length ? 'No registered repository matches.' : 'No shared repository is registered yet (agdev dashboard → Repositories).'))
    const add = h('button', {
      disabled: !sharedPick,
      onclick: async () => {
        add.disabled = true
        sharedResult = h('p.muted', 'Running git submodule add…')
        render()
        try {
          const r = await api.addShared(wsId, sharedPick, sharedPath.value)
          sharedResult = r.ok ? h('div.banner.ok', `${r.message} (URL ${r.url})`) : h('div.banner.error', h('strong', r.message), r.stderr ? h('pre', r.stderr) : null)
        } catch (e) { sharedResult = h('div.banner.error', (e as ApiError).message) }
        await load({})
      },
    }, 'Add as submodule')
    box.append(sharedQuery, rows, h('div.row', h('label.field', h('span', 'Destination path'), sharedPath), add), ...(sharedResult ? [sharedResult] : []))
    return box
  }

  function renderAddRepo(): HTMLElement {
    const path = h('input', { placeholder: 'study/evals', 'aria-label': 'Submodule path' })
    const url = h('input', { placeholder: '../study-evals.git', 'aria-label': 'Repository location' })
    const fresh = h('input', { type: 'checkbox', 'aria-label': 'Create a new local repository' })
    fresh.addEventListener('change', () => { url.disabled = fresh.checked })
    const button = h('button', {
      onclick: async () => {
        button.disabled = true
        addResult = h('p.muted', 'Running git submodule add…')
        render()
        try {
          const r = fresh.checked ? await api.addNewRepository(wsId, path.value) : await api.addSubmodule(wsId, path.value, url.value)
          addResult = r.ok
            ? h('div.banner.ok', r.message)
            : h('div.banner.error', h('strong', r.message), r.stderr ? h('pre', r.stderr) : null,
              r.partial ? h('p', `Left behind — .gitmodules entry: ${r.partial.gitmodulesEntry ? 'yes' : 'no'}; path exists: ${r.partial.pathExists ? 'yes' : 'no'}; staged: ${r.partial.staged ? 'yes' : 'no'}; module git dir: ${r.partial.gitDirExists ? 'yes' : 'no'}.`) : null)
        } catch (e) {
          addResult = h('div.banner.error', (e as ApiError).message)
        }
        await load({})
      },
    }, 'Add submodule')
    return h('div.add-repo', h('h3', 'Add a repository by location'),
      h('p.muted.small', 'Runs git submodule add in this workspace and stages the result. It does not commit. A relative location resolves against the project\'s origin (or its root when it has no remote). A new local repository is created in the authoring area\'s sources/ with an initial commit.'),
      h('div.row', h('label.field', h('span', 'Path'), path), h('label.field', h('span', 'Location'), url), button),
      h('label.small.inline', fresh, ' Create a new local repository instead of a location'),
      addResult)
  }

  function renderWorkspaces(): HTMLElement {
    const card = h('section.card.workspaces', h('h2', 'Workspaces'),
      h('p.muted.small', 'Registered in this machine\'s local registry. Availability is what this service observes now; other hosts are not contacted.'))
    for (const w of workspaces) {
      const same = w.observed.projectId && data?.project?.id && w.observed.projectId === data.project.id
      card.append(h(`div.ws-row${w.id === wsId ? '.current' : ''}`,
        h(`span.dot.${w.observed.available ? 'on' : 'off'}`),
        h('div.ws-main', h('strong', w.label), h('span.muted.small',
          `${w.host} · `, w.observed.available
            ? `available · ${w.observed.branch ?? 'detached'} @ ${short(w.observed.head)}${w.observed.projectId ? ` · project ${w.observed.projectId}${same ? '' : ' (different project)'}` : ''}${w.observed.reason ? ` · ${w.observed.reason}` : ''}`
            : `registered, not available: ${w.observed.reason}`)),
        w.id === wsId ? h('span.pill', 'selected') : h('button', { disabled: !w.observed.available, onclick: () => { location.hash = `#/ws/${encodeURIComponent(w.id)}` } }, 'Open')))
    }
    return card
  }

  function renderWorkflows(): HTMLElement {
    const card = h('section.card.workflows', h('h2', 'Workflows'), h('p.muted.small', 'devdocs/workflows/ in this workspace'))
    if (!data) return card
    if (!data.workflowsDir.exists) card.append(h('div.banner.warn', data.workflowsDir.reason ?? 'no workflow directory'))
    for (const w of data.workflows) {
      const approved = w.approvals && w.approvals.intent === 'approved' && w.approvals.definition === 'approved'
      card.append(h('div.wf-row', { dataset: { file: w.file } },
        h('div.wf-main', h('strong', w.name || w.id || w.file), h('span.muted.small', `${w.file}${w.id ? ` · id ${w.id}` : ''}`),
          h('div.chips',
            w.problem ? h('span.chip.error', `${w.problem.kind}: ${w.problem.message}`) : null,
            w.approvals ? approvalChip('intent', w.approvals.intent) : null,
            w.approvals ? approvalChip('definition', w.approvals.definition) : null,
            approved ? h('span.chip.ok', 'Author approved') : null,
            w.errors && !w.problem ? h('span.chip.error', `${w.errors} error${w.errors > 1 ? 's' : ''}`) : null,
            w.warnings ? h('span.chip.warn', `${w.warnings} warning${w.warnings > 1 ? 's' : ''}`) : null)),
        h('a.button', { href: `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(w.file)}` }, 'Open Editor')))
    }
    const id = h('input', { placeholder: 'release-check', 'aria-label': 'New workflow id' })
    const name = h('input', { placeholder: 'Release Check', 'aria-label': 'New workflow name' })
    card.append(h('div.create-wf', h('h3', 'New workflow'),
      h('div.row', h('label.field', h('span', 'Id'), id), h('label.field', h('span', 'Name'), name),
        h('button', {
          disabled: !data.workflowsDir.exists,
          onclick: async () => {
            try {
              const r = await api.createWorkflow(wsId, id.value.trim(), name.value.trim())
              location.hash = `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(r.file)}`
            } catch (e) { createError = (e as Error).message; render() }
          },
        }, 'Create')),
      createError ? h('p.error', createError) : null))
    return card
  }

  // Runs (docs/runs.md): every run of every workflow, newest first.
  const loadRuns = serial<object>(async () => {
    try {
      const r = await api.runs(wsId)
      if (disposed) return
      runs = r; runsError = ''
    } catch (e) { runsError = (e as Error).message }
    renderRuns()
  }, a => a)

  // A person's request to the executor (autolab). The receipt is kept until
  // the service confirms, so a retry after a lost response is not a second run.
  const reqText = h('textarea', { rows: 4, 'aria-label': 'Request text', placeholder: 'Your words: what you want done. They are kept as the run\'s braindump.md.' })
  const reqWorkflow = h('select', { 'aria-label': 'Request workflow' })
  const reqAuthor = h('input', { 'aria-label': 'Request author', placeholder: 'your name' })
  let reqReceipt = ''
  let reqResult: HTMLElement | null = null
  function renderRequest(): HTMLElement {
    const workflows = data?.workflows.filter(w => w.id && !w.problem) ?? []
    const current = reqWorkflow.value
    reqWorkflow.replaceChildren(...workflows.map(w => h('option', { value: w.id!, disabled: w.delegates.length > 0, selected: w.id === current }, `${w.name || w.id}${w.delegates.length ? ' — has a delegate node: not executable' : w.errors ? ' — has validation errors' : ''}`)))
    if (!reqAuthor.value) reqAuthor.value = localStorage.getItem('workflow-editor.actor') ?? ''
    const go = h('button.primary', {
      onclick: async () => {
        if (!reqText.value.trim() || !reqAuthor.value.trim() || !reqWorkflow.value) { reqResult = h('div.banner.error', 'Choose a workflow, and give your name and your words.'); renderRuns(); return }
        reqReceipt ||= `browser-${crypto.randomUUID()}`
        go.disabled = true
        try {
          const r = await api.requestRun(wsId, { workflow: reqWorkflow.value, text: reqText.value, author: reqAuthor.value.trim(), receipt: reqReceipt })
          localStorage.setItem('workflow-editor.actor', reqAuthor.value.trim())
          reqResult = h('div.banner.ok', `${r.duplicate ? 'Already requested' : 'Requested'}: `, h('a', { href: runHash(wsId, `${r.ref.workflow}/${r.ref.run}`) }, `${r.ref.workflow}/${r.ref.run}`), ` — the executor is queued (job ${r.job.id}, ${r.job.state}).`)
          reqText.value = ''; reqReceipt = ''
        } catch (e) { reqResult = h('div.banner.error', `Not requested: ${(e as Error).message}`) }
        await load({})
      },
    }, 'Request run')
    return h('div.request-run', h('h3', 'Request a run'),
      h('p.muted.small', 'autolab performs it in this workspace: study, do and talk nodes; questions come back here. Another run cannot start in this workspace until the current one completes or is cancelled.'),
      h('div.row', h('label.field', h('span', 'Workflow'), reqWorkflow), h('label.field', h('span', 'Your name'), reqAuthor)),
      reqText, h('div.save-row', go), reqResult)
  }

  function renderRuns() {
    runsCard.replaceChildren(h('div.card-head', h('h2', 'Runs')),
      h('p.muted.small', 'devdocs/runs/<workflow>/<run>/ — executions recorded by their executor (wfe run). Each follows its own fixed copy of the workflow.'),
      renderRequest())
    if (runsError) runsCard.append(h('div.banner.error', runsError))
    if (!runs) { runsCard.append(h('p.muted.small', 'Loading…')); return }
    if (!runs.length) { runsCard.append(h('p.muted.small', 'No runs yet.')); return }
    const sorted = runs.slice().sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.ref.localeCompare(b.ref))
    for (const r of sorted) {
      const state = r.execution ?? 'problem'
      runsCard.append(h('div.run-row', { dataset: { run: r.ref } },
        h('div.wf-main',
          h('strong', r.ref),
          h('span.muted.small', r.problem ? r.dir : `${r.input === 'request' ? 'request' : 'braindump'} · ${r.executor} · updated ${ago(r.updated)}`),
          h('div.chips',
            r.problem ? h('span.chip.error', `cannot be used — ${r.problem.code ?? r.problem.kind}: ${r.problem.message}`) : h(`span.state-chip.state-${state}`, STATE_LABEL[state] ?? state),
            ...Object.entries(r.counts ?? {}).filter(([, n]) => n).map(([k, n]) => h('span.chip', `${n} ${k}`)),
            r.decision ? h(`span.chip.${r.decision === 'accepted' ? 'ok' : 'error'}`, r.decision) : null),
          ...(r.waiting ?? []).map(w => h('span.small', `⏳ ${w.node} — next move: ${w.holder}`)),
          r.ready?.length ? h('span.small', `▶ ready: ${r.ready.join(', ')}`) : null,
          r.failed?.length ? h('span.small.error', `✖ failed: ${r.failed.join(', ')}`) : null),
        h('a.button', { href: runHash(wsId, r.ref) }, 'Open run')))
    }
  }

  function render() {
    renderHeader()
    main.replaceChildren(
      h('div.col', renderProjectCard(), renderRepos()),
      h('div.col', renderWorkspaces(), runsCard, renderWorkflows()),
    )
  }

  // External changes: reload what has no draft; guard the project draft.
  const stream = live(api.eventsUrl(wsId), {
    classify: ev => {
      if (ev.kind === 'project' && dirty()) {
        if (ev.rev && data?.rev === ev.rev) return null
        externalChange = true
        render()
        return null
      }
      if (ev.kind === 'run' || ev.kind === 'runs') return ['runs']
      return ev.kind === 'registry' ? ['registry'] : ['content']
    },
    flush: async (needs, all) => {
      if (all || needs.has('runs')) void loadRuns({})
      if (all || needs.has('content') || needs.has('registry')) await load({ workspaces: all || needs.has('registry') })
    },
    state: c => { connected = c; renderHeader() },
  })

  void load({ workspaces: true, force: true })
  void loadRuns({})
  renderRuns()
  return {
    dispose: () => { disposed = true; stream.close() },
    isDirty: dirty,
  }
}

export function approvalChip(kind: string, status: string): HTMLElement {
  const label = `${kind} ${status === 'approved' ? 'approved' : status === 'stale' ? 'changed since approval' : 'draft'}`
  return h(`span.chip.approval.${status}`, label)
}
