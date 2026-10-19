// Project editor: metadata, sub-repositories, workspaces and workflows.
import type { DashboardResponse, ProjectResponse, RepositoryStatus, RunSummary, WorkflowResponse, WorkspaceSummary } from '../shared/api.ts'
import { PROJECT_SCHEMA, type Project } from '../shared/model.ts'
import { validateProject } from '../shared/validate.ts'
import { api, ApiError } from './api.ts'
import { live, serial } from './live.ts'
import { h, short } from './dom.ts'
import { diagnosticList } from './homeView.ts'
import { keepingFocus, workflowCreator } from './createWorkflow.ts'
import { displayToggle, onDisplay, showDetail } from './displayMode.ts'
import { icon } from './icons.ts'
import type { ViewHandle } from './main.ts'
import { ago, runHash, STATE_LABEL } from './runCommon.ts'
import { boastPanel } from './boastPanel.ts'
import { ContextSection, fitRows, ListEditor } from './contextParts.ts'

const GROUPS: { key: RepositoryStatus['category'][]; title: string }[] = [
  { key: ['root', 'devdocs'], title: 'Fixed repositories' },
  { key: ['study'], title: 'Study (study/)' },
  { key: ['wedo'], title: 'Wedo (wedo/)' },
  { key: ['other'], title: 'Other' },
]

export function statusChips(r: RepositoryStatus): HTMLElement[] {
  const chips: HTMLElement[] = []
  if (r.kind === 'directory') {
    if (r.path === 'devdocs') chips.push(h('span.chip', { title: 'devdocs is a folder of the project root repository (devdocs: directory)' }, 'folder of the root'))
    else chips.push(h('span.chip', { title: 'A local area: a folder of the project root repository, declared in project.yaml (areas). It is published with the root and is not shared with other projects.' }, 'local area'))
    if (r.path !== 'devdocs' && !r.initialized && !r.error) chips.push(h('span.chip.warn', { title: 'Declared in project.yaml, but the folder is not in this workspace' }, 'folder missing'))
    if (r.dirty) chips.push(h('span.chip.warn', { title: `Uncommitted changes under ${r.path}/` }, `${r.dirty} uncommitted`))
    if (r.error) chips.push(h('span.chip.error', r.error))
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

export function renderProjectView(root: HTMLElement, wsId: string, opts: { context?: boolean } = {}): ViewHandle {
  let data: ProjectResponse | null = null
  // The revision the draft was made from: a save names it, so a file changed
  // on disk meanwhile is not overwritten (project_migration p8).
  let draftRev: string | null = null
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
  let disposed = false
  let connected = true
  let runs: RunSummary[] | null = null
  let runsError = ''

  const dirty = () => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved)

  // Context (p13 ex1): the project's purpose, goals and guides (project.yaml,
  // this view's one draft and save) and its local instructions, in a section
  // shown in both modes. The controls are built once and fed from the draft.
  const intentInput = h('textarea', { rows: 4, 'aria-label': 'Project purpose', placeholder: 'Why the project exists. Every workflow and run of the project is given this.', disabled: true, oninput: () => { if (draft) { draft.intent = intentInput.value; fitRows(intentInput, 3, 12); touch() } } }) as HTMLTextAreaElement
  const goalsEditor = new ListEditor({ label: 'Goals', item: 'Goal', placeholder: 'A goal of the project', addLabel: 'Add goal', onInput: (v, structural) => { if (draft) { draft.goals = v; touch(structural) } } })
  const guidesEditor = new ListEditor({ label: 'Guides', item: 'Guide', placeholder: 'agent/guide.md, or <project>:<path>', addLabel: 'Add guide', onInput: (v, structural) => { if (draft) { draft.guides = v.length ? v : undefined; touch(structural) } } })
  const sharedSave = h('button.primary', { onclick: () => void save() }, 'Save project.yaml')
  const sharedState = h('span.ctx-save-state')
  const sharedIssues = h('ul.issues')
  const sharedControls = h('div.ctx-project-shared',
    h('label.field', h('span', 'Purpose'), intentInput),
    goalsEditor.el,
    guidesEditor.el,
    h('p.small.muted', 'Guides are files every workflow of the project is given (a project-relative path, or <project>:<path> for another managed project).'),
    sharedIssues,
    h('div.save-row', sharedSave, sharedState, h('span.small.muted', 'Writes project.yaml in this workspace.')))
  const context = new ContextSection({
    scope: 'project', wsId, shared: sharedControls,
    sharedSummary: () => { const p = draft ?? saved; return !p ? 'project.yaml not read' : [p.intent.trim() ? 'purpose set' : 'no purpose', `${p.goals.length} goal${p.goals.length === 1 ? '' : 's'}`, `${p.guides?.length ?? 0} guide${p.guides?.length === 1 ? '' : 's'}`].join(' · ') },
    sharedDirty: () => dirty(),
    onDirty: () => renderHeroState(),
  })
  function syncShared(fromDisk: boolean) {
    const d = draft
    const readonly = !d || !!data?.problem
    intentInput.disabled = readonly
    if (d && (fromDisk || document.activeElement !== intentInput) && intentInput.value !== d.intent) { intentInput.value = d.intent; fitRows(intentInput, 3, 12) }
    goalsEditor.set(d?.goals ?? [], readonly)
    guidesEditor.set(d?.guides ?? [], readonly)
    sharedSave.disabled = readonly || !dirty()
    sharedState.replaceChildren(saveError ? h('span.error', saveError) : dirty() ? 'Unsaved changes' : saveState || (d ? 'Saved' : ''))
    sharedIssues.replaceChildren(...(d ? validateProject(d).filter(i => ['intent', 'goals', 'guides'].includes(i.field ?? '')).map(i => h(`li.${i.severity}`, i.message)) : []))
    context.updateSummary()
  }
  // Kept across renders: run progress refreshes only this card.
  const runsCard = h('section.card.runs-card')

  const header = h('header.topbar')
  // Boast (p12) sits below the heading in both modes and is never detached:
  // re-renders replace only the slots around it.
  const boast = boastPanel()
  const heroSlot = h('div.slot')
  const bodySlot = h('div.slot', h('p.muted', 'Loading project…'))
  const main = h('main.project-grid', heroSlot, context.el, boast.el, bodySlot)
  root.append(header, main)

  let contextRead = false
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
      let replaced = false
      if (!dirty() || opts.force) {
        saved = p.project ? structuredClone(p.project) : null
        draft = p.project ? structuredClone(p.project) : null
        draftRev = p.rev
        externalChange = false
        replaced = true
      } else if (changedOnDisk) externalChange = true
      syncShared(replaced)
      if (changedOnDisk || !contextRead || opts.refresh) { contextRead = true; void context.reload() }
      if (accessWorkflow) accessData = await api.workflow(wsId, accessWorkflow).catch(() => null)
      render()
    } catch (e) {
      bodySlot.replaceChildren(h('p.error', (e as Error).message))
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
        h('span.pill.ok.d-only', icon('check', 'icon small'), `workspace ${wsId}`)),
      h('div.top-actions',
        connected ? null : h('span.pill.warn', { title: 'Changes on disk are not shown until the editor service is reachable again; the view re-reads everything then.' }, 'Not connected — not live'),
        h('a.button.d-only', { href: `#/context/${encodeURIComponent(wsId)}`, title: 'Compare this project\'s instructions with all projects\' and its workflows\', side by side' }, 'Context overview'),
        h('button.d-only', { title: 'Re-read the project and the repositories\' Git state now', onclick: () => void load({ workspaces: true, refresh: true }) }, 'Refresh'),
        h('label.ws-label.d-only', 'Workspace ', select),
        displayToggle()),
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
      h('div.field', h('span', 'Purpose, goals and guides'), h('button.link-btn', { onclick: () => context.editShared() }, 'Edit them in Context')),
    )
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
    syncShared(false)
    renderHeroState()
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
      await api.saveProject(wsId, draft, draftRev)
      saved = structuredClone(draft)
      saveState = `Saved ${new Date().toLocaleTimeString()}`
      externalChange = false
      await load({})
      void context.reload()
    } catch (e) {
      saveError = `Save failed: ${(e as Error).message}. Your edits are kept; retry when resolved.`
      render()
      syncShared(false)
    }
  }

  function renderRepos(): HTMLElement {
    const card = h('section.card.repos')
    const workflows = data?.workflows.filter(w => w.id) ?? []
    card.append(h('div.card-head', h('h2', 'Repositories and local areas'),
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
            r.url ? h('span.muted.small', { title: 'Source as written in .gitmodules / remote.origin.url' }, `source ${r.kind === 'root' ? '(origin)' : r.url}`) : null,
            r.description ? h('span.muted.small', r.description) : null),
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
    const card = h('section.card.workspaces.d-only', h('h2', 'Workspaces'),
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
    const card = h('section.card.workflows', h('div.card-head', h('h2', 'Workflows'), creator.button), h('p.muted.small.d-only', 'devdocs/workflows/ in this workspace'))
    if (!data) return card
    if (!data.workflowsDir.exists) card.append(h('div.banner.warn', data.workflowsDir.reason ?? 'no workflow directory'))
    if (!data.workflows.length) card.append(h('p.muted.empty-workflows', 'No workflow yet. ', data.workflowsDir.exists ? h('button.link-btn', { type: 'button', onclick: () => creator.open() }, 'Create the first one') : null))
    for (const w of data.workflows) {
      const approved = w.approvals && w.approvals.intent === 'approved' && w.approvals.definition === 'approved'
      const simpleState = w.problem ? h('span.tile-state.error', icon('alert', 'icon'), 'Cannot be read')
        : w.errors ? h('span.tile-state.error', icon('alert', 'icon'), `${w.errors} error${w.errors > 1 ? 's' : ''}`)
          : approved ? h('span.tile-state.calm', icon('check', 'icon'), 'Approved')
            : w.approvals && (w.approvals.intent === 'stale' || w.approvals.definition === 'stale') ? h('span.tile-state.warn', icon('alert', 'icon'), 'Changed since approval')
              : h('span.tile-state.muted', icon('doc', 'icon'), 'Draft')
      card.append(h('div.wf-row', { dataset: { file: w.file } },
        h('span.s-only.wf-icon', icon('flag', 'icon')),
        h('div.wf-main', h('strong', w.name || w.id || w.file), h('span.muted.small.d-only', `${w.file}${w.id ? ` · id ${w.id}` : ''}`),
          h('div.s-only', simpleState),
          h('div.chips.d-only',
            w.problem ? h('span.chip.error', `${w.problem.kind}: ${w.problem.message}`) : null,
            w.approvals ? approvalChip('intent', w.approvals.intent) : null,
            w.approvals ? approvalChip('definition', w.approvals.definition) : null,
            approved ? h('span.chip.ok', 'Author approved') : null,
            w.errors && !w.problem ? h('span.chip.error', `${w.errors} error${w.errors > 1 ? 's' : ''}`) : null,
            w.warnings ? h('span.chip.warn', `${w.warnings} warning${w.warnings > 1 ? 's' : ''}`) : null)),
        h('a.button', { href: `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(w.file)}` }, 'Open', h('span.d-only', ' Editor'))))
    }
    creator.update({ existing: data.workflows.map(w => w.id).filter((x): x is string => !!x), enabled: data.workflowsDir.exists, reason: data.workflowsDir.reason })
    card.append(creator.form)
    return card
  }

  // Creating a workflow (createWorkflow.ts): one entry in both modes; the
  // form outlives renders, so text typed while the view reloads is kept.
  const creator = workflowCreator(wsId, file => { location.hash = `#/ws/${encodeURIComponent(wsId)}/wf/${encodeURIComponent(file)}` })

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
    // The person's choice stays; before one, the first workflow a run can be made of.
    const current = reqWorkflow.value || workflows.find(w => !w.errors)?.id
    reqWorkflow.replaceChildren(...workflows.map(w => h('option', { value: w.id!, selected: w.id === current }, `${w.name || w.id}${w.errors ? ' — has validation errors' : w.delegates.length ? ` — delegates to ${w.delegates.join(', ')}` : ''}`)))
    // A per-viewer convenience: storage that is unavailable leaves it empty.
    if (!reqAuthor.value) { try { reqAuthor.value = localStorage.getItem('workflow-editor.actor') ?? '' } catch { /* not remembered */ } }
    const go = h('button.primary', {
      onclick: async () => {
        if (!reqText.value.trim() || !reqAuthor.value.trim() || !reqWorkflow.value) { reqResult = h('div.banner.error', 'Choose a workflow, and give your name and your words.'); renderRuns(); return }
        reqReceipt ||= `browser-${crypto.randomUUID()}`
        go.disabled = true
        try {
          const r = await api.requestRun(wsId, { workflow: reqWorkflow.value, text: reqText.value, author: reqAuthor.value.trim(), receipt: reqReceipt })
          try { localStorage.setItem('workflow-editor.actor', reqAuthor.value.trim()) } catch { /* not remembered */ }
          reqResult = h('div.banner.ok', `${r.duplicate ? 'Already requested' : 'Requested'}: `, h('a', { href: runHash(wsId, `${r.ref.workflow}/${r.ref.run}`) }, `${r.ref.workflow}/${r.ref.run}`), ` — the executor is queued (job ${r.job.id}, ${r.job.state}).`)
          reqText.value = ''; reqReceipt = ''
        } catch (e) { reqResult = h('div.banner.error', `Not requested: ${(e as Error).message}`) }
        await load({})
      },
    }, 'Request run')
    return h('div.request-run', h('h3', 'Request a run'),
      h('p.muted.small.d-only', 'autolab performs it in this workspace: study, do and talk nodes; questions come back here. Another run cannot start in this workspace until the current one completes or is cancelled.'),
      h('div.row', h('label.field', h('span', 'Workflow'), reqWorkflow), h('label.field', h('span', 'Your name'), reqAuthor)),
      reqText, h('div.save-row', go), reqResult)
  }

  // A run's state as one recognizable icon and word (Simple; Detail keeps the chips).
  function runState(r: RunSummary): HTMLElement {
    if (r.problem) return h('span.run-badge.error', icon('alert', 'icon'), 'Cannot be read')
    if (r.waiting?.length) return h('span.run-badge.attention', icon('question', 'icon'), 'Waits for you')
    if (r.failed?.length) return h('span.run-badge.error', icon('alert', 'icon'), 'Failed')
    const s = r.execution ?? 'problem'
    if (s === 'completed') return h(`span.run-badge.${r.decision === 'rejected' ? 'error' : 'ok'}`, icon('check', 'icon'), r.decision === 'accepted' ? 'Accepted' : r.decision === 'rejected' ? 'Rejected' : 'Completed')
    if (s === 'cancelled') return h('span.run-badge.muted', icon('stop', 'icon'), 'Cancelled')
    if (s === 'stopped') return h('span.run-badge.warn', icon('stop', 'icon'), 'Held')
    if (s === 'not-started') return h('span.run-badge.muted', icon('play', 'icon'), 'Not started')
    return h('span.run-badge.active', icon('play', 'icon'), 'In progress')
  }

  const RECENT = 5
  function renderRuns() {
    runsCard.replaceChildren(h('div.card-head', h('h2', 'Runs')),
      h('p.muted.small.d-only', 'devdocs/runs/<workflow>/<run>/ — executions recorded by their executor (wfe run). Each follows its own fixed copy of the workflow.'),
      renderRequest())
    if (runsError) runsCard.append(h('div.banner.error', runsError))
    if (!runs) { runsCard.append(h('p.muted.small', 'Loading…')); return }
    if (!runs.length) { runsCard.append(h('p.muted.small', 'No runs yet.')); return }
    const sorted = runs.slice().sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.ref.localeCompare(b.ref))
    const wfName = (id: string) => data?.workflows.find(w => w.id === id)?.name || id
    runsCard.append(h('h3.s-only.recent-head', 'Recent runs'))
    sorted.forEach((r, i) => {
      const state = r.execution ?? 'problem'
      runsCard.append(h(`div.run-row${i >= RECENT ? '.d-only' : ''}`, { dataset: { run: r.ref } },
        h('span.s-only', runState(r)),
        h('div.wf-main',
          h('strong.run-list-title', r.title || wfName(r.workflow)),
          h('span.run-list-workflow', r.workflowName || wfName(r.workflow)),
          h('span.muted.small.d-only', r.ref),
          h('span.muted.small.s-only', `updated ${ago(r.updated)}`),
          h('span.muted.small.d-only', r.problem ? r.dir : `${r.input === 'request' ? 'request' : 'braindump'} · ${r.executor} · updated ${ago(r.updated)}`),
          h('div.chips.d-only',
            r.problem ? h('span.chip.error', `cannot be used — ${r.problem.code ?? r.problem.kind}: ${r.problem.message}`) : h(`span.state-chip.state-${state}`, STATE_LABEL[state] ?? state),
            ...Object.entries(r.counts ?? {}).filter(([, n]) => n).map(([k, n]) => h('span.chip', `${n} ${k}`)),
            r.decision ? h(`span.chip.${r.decision === 'accepted' ? 'ok' : 'error'}`, r.decision) : null),
          ...(r.waiting ?? []).map(w => h('span.small.d-only', `⏳ ${w.node} — next move: ${w.holder}`)),
          r.ready?.length ? h('span.small.d-only', `▶ ready: ${r.ready.join(', ')}`) : null,
          r.failed?.length ? h('span.small.error.d-only', `✖ failed: ${r.failed.join(', ')}`) : null),
        h('a.button', { href: runHash(wsId, r.ref) }, 'Open', h('span.d-only', ' run'))))
    })
    if (sorted.length > RECENT) runsCard.append(h('button.link-btn.s-only', { onclick: () => showDetail(() => runsCard.querySelectorAll<HTMLElement>('.run-row')[RECENT]?.scrollIntoView({ block: 'center' })) }, `All runs (${sorted.length})`))
  }

  // Simple (p8/ex1): the project's name and purpose, large, with one entry to
  // its settings; the rest of the project card is Detail's.
  function openSettings() {
    showDetail(() => {
      const card = main.querySelector<HTMLElement>('.project-meta')
      card?.scrollIntoView({ block: 'start' })
      card?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])')?.focus({ preventScroll: true })
    })
  }
  function renderHero(): HTMLElement {
    const p = draft ?? saved
    const intent = (saved?.intent ?? '').trim()
    const first = intent.split(/\n\s*\n/)[0]
    const issues = (data?.structure ?? []).filter(d => !d.code.startsWith('project-')).length
    return h('section.project-hero.s-only',
      h('div.hero-main',
        h('h1', p?.name || p?.id || data?.project?.id || 'Project'),
        intent ? h('p.hero-purpose', { title: intent }, first) : h('p.hero-purpose.muted', data?.problem ? 'project.yaml cannot be read.' : 'No purpose written yet.'),
        data?.problem ? h('p.tile-state.error', icon('alert', 'icon'), 'project.yaml cannot be used — see Project settings') : issues ? h('p.tile-state.warn', icon('alert', 'icon'), 'This project is incomplete — see Project settings') : null,
        heroState),
      h('div.hero-actions', h('button', { onclick: () => context.reveal(true) }, icon('intent', 'icon small'), 'Purpose & instructions'), h('button', { onclick: openSettings }, icon('settings', 'icon small'), 'Project settings')))
  }
  const heroState = h('div.hero-state')
  function renderHeroState() {
    heroState.replaceChildren(...(dirty() || context.isDirty() ? [h('p.tile-state.warn', icon('alert', 'icon'), dirty() && context.isDirty() ? 'Unsaved changes in project.yaml and in local instructions' : dirty() ? 'Unsaved changes in project.yaml' : 'Unsaved local instructions')] : []))
    context.updateSummary()
  }

  // The hero follows the settings draft when Simple is shown again; nothing
  // else is rebuilt by a switch.
  let hero: HTMLElement | null = null
  const offDisplay = onDisplay(d => { if (d === 'simple' && hero?.isConnected) { const next = renderHero(); hero.replaceWith(next); hero = next } })

  function render() {
    renderHeader()
    // Project reads supply the workflow choices independently of run reads.
    // Refresh the retained card too, even when the runs response arrived first.
    renderRuns()
    keepingFocus(main, () => {
      heroSlot.replaceChildren(hero = renderHero())
      renderHeroState()
      bodySlot.replaceChildren(
        h('div.col.d-only', renderProjectCard(), renderRepos()),
        h('div.col.project-work', renderWorkspaces(), runsCard, renderWorkflows()))
    })
    boast.show(data?.project?.id ?? workspaces.find(w => w.id === wsId)?.observed.projectId ?? null, wsId)
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
      if (ev.kind === 'git') return ['content', 'git']
      return ev.kind === 'registry' ? ['registry'] : ['content']
    },
    flush: async (needs, all) => {
      if (all || needs.has('runs')) void loadRuns({})
      if (all || needs.has('git')) boast.check()
      if (all || needs.has('content') || needs.has('registry')) await load({ workspaces: all || needs.has('registry') })
    },
    state: c => { connected = c; renderHeader() },
  })

  void load({ workspaces: true, force: true })
  if (opts.context) requestAnimationFrame(() => context.reveal(false))
  void loadRuns({})
  renderRuns()
  return {
    dispose: () => { disposed = true; offDisplay(); stream.close(); boast.dispose(); context.dispose() },
    isDirty: () => dirty() || context.isDirty(),
  }
}

export function approvalChip(kind: string, status: string): HTMLElement {
  const label = `${kind} ${status === 'approved' ? 'approved' : status === 'stale' ? 'changed since approval' : 'draft'}`
  return h(`span.chip.approval.${status}`, label)
}
