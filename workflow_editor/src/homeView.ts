// Home: the agdev dashboard (p4). Every project and every shared repository
// registered on this host, with where each fact was read and when, and the
// entrances for creating and registering them. The Project Editor (#/ws/…)
// is one project's resources; this page is the global view, and the two are
// kept apart. A read failure is shown as such, never as an empty listing.
import type { AgdevResult, CreateProjectResult, DashboardProject, DashboardRepository, DashboardResponse, DashboardWorkspace, Diagnostic, RegisterResponse } from '../shared/api.ts'
import { api } from './api.ts'
import { live } from './live.ts'
import { append, h, when } from './dom.ts'
import { displayToggle, showDetail } from './displayMode.ts'
import { icon } from './icons.ts'
import type { ViewHandle } from './main.ts'
import { ContextSection } from './contextParts.ts'

export function diagnosticList(diags: Diagnostic[]): HTMLElement | null {
  if (!diags.length) return null
  return h('ul.diagnostics', diags.map(d => h(`li.${d.severity}`, h('span', d.message), d.fix ? h('span.fix', ` — ${d.fix}`) : null)))
}

const CATEGORY_LABEL: Record<string, string> = { devdocs: 'devdocs', study: 'study', wedo: 'wedo', other: 'other' }

export function renderHomeView(root: HTMLElement, opts: { context?: boolean } = {}): ViewHandle {
  let data: DashboardResponse | null = null
  let loadError = ''
  let busy = ''
  let disposed = false
  const results: Record<string, HTMLElement | null> = {}

  // The editor is part of agdevworld: through its /wfe/ route the operation
  // room is this origin's root; elsewhere (dev server, direct port) it is the
  // loopback agdev origin.
  const agdevworld = location.pathname.startsWith('/wfe/') ? '/' : 'http://localhost:8093/'
  const header = h('header.topbar', h('div.crumbs', h('a.back-to-world', { href: agdevworld, title: 'agdevworld operation room' }, '← agdevworld'), h('span.sep', '|'), h('strong', 'agdev'), h('span.sep', '/'), h('span.muted', 'Dashboard')),
    h('div.top-actions', h('a.button', { href: '#/nodes', title: 'The activities you expect as distinct workflow nodes (your node catalog)' }, 'User nodes'), h('a.button.d-only', { href: '#/context', title: 'Compare the instructions of every scope side by side' }, 'Context overview'), h('span.live-state.muted.small.d-only'), h('button.d-only', { onclick: () => void load() }, 'Refresh'), displayToggle()))
  // Instructions for all projects (p13 ex1): in both modes, above the
  // projects; kept outside what re-renders so its draft is never replaced.
  const context = new ContextSection({ scope: 'system' })
  const content = h('div.dash-content')
  const main = h('main.dashboard', context.el, content)
  root.append(header, main)

  // Inputs outlive re-renders so nothing typed is lost.
  const f = {
    id: h('input', { placeholder: 'release-notes', 'aria-label': 'Project id' }),
    name: h('input', { placeholder: 'Release Notes', 'aria-label': 'Project name' }),
    intent: h('textarea', { rows: 3, 'aria-label': 'Project intent', placeholder: 'Why the project exists.' }),
    goals: h('textarea', { rows: 2, 'aria-label': 'Project goals', placeholder: 'One goal per line.' }),
    devdocs: h('select', { 'aria-label': 'devdocs storage' }, h('option', { value: 'directory', selected: true }, 'directory — a folder of the project root (default)'), h('option', { value: 'submodule' }, 'submodule — a repository of its own')),
    regOwner: h('input', { 'aria-label': 'Project owner on Gitea', placeholder: 'owner' }),
    regName: h('input', { 'aria-label': 'Project repository on Gitea', placeholder: 'pj-existing' }),
    repoOwner: h('input', { 'aria-label': 'Repository owner on Gitea', placeholder: 'owner' }),
    repoName: h('input', { 'aria-label': 'Repository name', placeholder: 'study-rts' }),
    repoCategory: h('select', { 'aria-label': 'Repository category' }, ['study', 'wedo', 'other'].map(c => h('option', { value: c }, c))),
    repoDescription: h('input', { 'aria-label': 'Repository description', placeholder: 'What it accumulates (for a new repository)' }),
    wsPath: h('input', { 'aria-label': 'Workspace path', placeholder: 'an existing project root on this host' }),
  }

  async function load() {
    void context.reload()
    try { data = await api.dashboard(); loadError = '' } catch (e) { loadError = (e as Error).message }
    if (!disposed) render()
  }

  async function act(key: string, f: () => Promise<{ ok: boolean; message: string } & Record<string, unknown>>, after?: (r: Record<string, unknown>) => void) {
    busy = key; results[key] = h('p.muted', 'Working…'); render()
    try {
      const r = await f()
      const steps = (r.steps as { name: string; status: string; detail: string }[] | undefined) ?? []
      results[key] = h('div', h(`div.banner.${r.ok ? 'ok' : 'error'}`, r.message),
        steps.length ? h('ul.steps', steps.map(s => h(`li.${s.status}`, `${s.status} · ${s.name}: ${s.detail}`))) : null,
        (r as Partial<CreateProjectResult>).resumable ? h('button', { onclick: () => void createProject(true) }, 'Continue creation') : null)
      if (r.ok) after?.(r)
    } catch (e) {
      results[key] = h('div.banner.error', (e as Error).message)
    }
    busy = ''
    await load()
  }

  const createProject = (resume = false) => act('create', () => api.createGiteaProject({
    id: f.id.value.trim(), name: f.name.value.trim(), intent: f.intent.value, goals: f.goals.value.split('\n').map(g => g.trim()).filter(Boolean),
    devdocs: f.devdocs.value as 'directory' | 'submodule', resume,
  }) as unknown as Promise<AgdevResult>)

  // ---- projects ------------------------------------------------------------------

  function workspaceLine(w: DashboardWorkspace): HTMLElement {
    const runs = w.runs
    return h('div.ws-row', { dataset: { id: w.id } },
      h(`span.dot.${w.available ? 'on' : 'off'}`),
      h('div.ws-main', h('strong', w.label), h('span.muted.small', `workspace ${w.id} · ${w.host} · `,
        w.available ? (runs ? `${runs.ongoing} ongoing run${runs.ongoing === 1 ? '' : 's'}, ${runs.waitingOnPerson} waiting${runs.problems ? `, ${runs.problems} unreadable` : ''}` : `runs not read: ${w.runsError}`) : `not available: ${w.reason}`),
      ...(runs?.list ?? []).map(r => h('div.small', h('a', { href: `#/ws/${encodeURIComponent(w.id)}/run/${r.ref.split('/').map(encodeURIComponent).join('/')}` }, r.ref), ` ${r.execution}`,
        r.waiting.length ? ` — waiting: ${r.waiting.map(x => `${x.node} → ${x.holder}`).join(', ')}` : ''))),
      w.available ? h('a.button', { href: `#/ws/${encodeURIComponent(w.id)}` }, 'Project editor') : null)
  }

  function projectCard(p: DashboardProject): HTMLElement {
    return h('div.project-entry', { dataset: { project: p.id } },
      h('div.entry-head', h('strong', p.name ?? p.id), h('code', p.id),
        p.devdocs ? h('span.chip', `devdocs: ${p.devdocs}`) : null,
        p.root.htmlUrl ? h('a.small', { href: p.root.htmlUrl, target: '_blank', rel: 'noopener' }, p.root.fullName) : h('span.muted.small', p.root.fullName ?? p.root.key),
        p.root.error ? h('span.chip.error', `root: ${p.root.error}`) : null),
      p.intent ? h('p.small.intent', p.intent.trim()) : null,
      h('p.muted.small.source', p.definition.error ? h('span.error', `definition not read (${p.definition.source}): ${p.definition.error}`) : `read from ${p.definition.source} at ${when(p.definition.at)}`),
      p.workspaces.length ? h('div.ws-list', p.workspaces.map(workspaceLine)) : h('p.muted.small', 'No workspace on this host.'),
      h('div.row', h('button', { disabled: !!busy || data?.gitea.state !== 'ok', onclick: () => void act(`obtain-${p.id}`, () => api.obtainWorkspace(p.id)) }, p.workspaces.length ? 'Obtain another workspace from Gitea' : 'Obtain a workspace from Gitea')),
      results[`obtain-${p.id}`])
  }

  function renderProjects(): HTMLElement {
    const card = h('section.card.dash-projects', h('h2', 'Projects'))
    if (!data) return card
    if (!data.projects.length) card.append(h('p.muted', data.registry.exists ? 'No project is registered yet.' : 'The registry does not exist yet; create or register a project.'))
    for (const p of data.projects) card.append(projectCard(p))
    if (data.unlinkedWorkspaces.length) {
      card.append(h('h3', 'Workspaces without a registered project'),
        h('p.muted.small', 'Local projects registered by path (wfe register), not known on Gitea.'), ...data.unlinkedWorkspaces.map(workspaceLine))
    }
    return card
  }

  // ---- repositories ----------------------------------------------------------------

  function repoRow(r: DashboardRepository): HTMLElement {
    const name = r.gitea.fullName ?? `${r.registered.owner}/${r.registered.name}`
    return h('div.repo-entry', { dataset: { repo: r.key } },
      h('div.entry-head', h('span.chip', CATEGORY_LABEL[r.category] ?? r.category),
        r.gitea.htmlUrl ? h('a', { href: r.gitea.htmlUrl, target: '_blank', rel: 'noopener' }, name) : h('strong', name),
        r.gitea.state === 'ok' ? null : h(`span.chip.${r.gitea.state === 'missing' ? 'error' : 'warn'}`, r.gitea.state === 'renamed' ? `renamed (registered as ${r.registered.owner}/${r.registered.name})` : r.gitea.state === 'missing' ? 'missing on Gitea' : `not read: ${r.gitea.error ?? ''}`)),
      r.description ? h('p.small', r.description) : null,
      h('div.small', 'Used by: ', r.usedBy.length
        ? r.usedBy.map((u, i) => [i ? ', ' : '', h('span', { title: `read from ${u.source} at ${when(u.at)}` }, `${u.project} (${u.path})`)])
        : r.usageUnknown.length ? h('span.muted', 'no project known to use it') : h('span.muted', 'no project uses it yet')),
      r.usageUnknown.length ? h('div.small.error', `Unknown for ${r.usageUnknown.map(u => `${u.project} (${u.error})`).join(', ')}`) : null)
  }

  function renderRepositories(): HTMLElement {
    const card = h('section.card.dash-repos', h('h2', 'Shared repositories'),
      h('p.muted.small', 'Repositories on Gitea that projects share (study, wedo, other) and devdocs repositories of submodule-mode projects. Listed once, with every project that uses one. A project in directory mode keeps devdocs as a folder of its root; that is a project resource, not a repository here.'))
    if (!data) return card
    if (!data.repositories.length) card.append(h('p.muted', 'No shared repository is registered yet.'))
    for (const r of data.repositories) card.append(repoRow(r))
    return card
  }

  // ---- entrances ---------------------------------------------------------------------

  function renderEntrances(): HTMLElement {
    const gitea = data?.gitea.state === 'ok'
    const create = h('section.card.create-project', h('h2', 'Create project'),
      h('p.muted.small', `Creates the project's repository${f.devdocs.value === 'submodule' ? ' and its devdocs repository' : ''} on Gitea${data?.gitea.owner ? ` under ${data.gitea.owner}` : ''}, a workspace on this host with project.yaml, .gitignore and devdocs, the initial commit with your Git identity, pushes it, and registers the project, its repositories and the workspace. A creation that stops partway continues where it stopped.`),
      h('div.row', h('label.field', h('span', 'Id'), f.id), h('label.field', h('span', 'Name'), f.name)),
      h('label.field', h('span', 'Intent'), f.intent),
      h('label.field', h('span', 'Goals'), f.goals),
      h('label.field', h('span', 'devdocs storage (fixed at creation)'), f.devdocs),
      h('div.save-row', h('button.primary', { disabled: !!busy || !gitea, onclick: () => void createProject() }, busy === 'create' ? 'Working…' : 'Create project')),
      results.create)
    const register = h('section.card.register-project', h('h2', 'Register an existing project'),
      h('p.muted.small', 'A project root that already exists on Gitea (project.yaml, ag.project.v2). Only the registry changes; obtain a workspace afterwards.'),
      h('div.row', h('label.field', h('span', 'Owner'), f.regOwner), h('label.field', h('span', 'Repository'), f.regName),
        h('button', { disabled: !!busy || !gitea, onclick: () => void act('register', () => api.registerGiteaProject(f.regOwner.value.trim(), f.regName.value.trim())) }, 'Register')),
      results.register)
    const repo = h('section.card.register-repo', h('h2', 'Shared repository'),
      h('p.muted.small', 'Register a repository that exists on Gitea, or create a new one (with a README) under the configured owner. Registration needs no project; a project adds it from its Project Editor ("Add existing repository").'),
      h('div.row', h('label.field', h('span', 'Owner (to register)'), f.repoOwner), h('label.field', h('span', 'Name'), f.repoName), h('label.field', h('span', 'Category'), f.repoCategory)),
      h('label.field', h('span', 'Description (new repository)'), f.repoDescription),
      h('div.row',
        h('button', { disabled: !!busy || !gitea, onclick: () => void act('repo', () => api.registerRepository(f.repoOwner.value.trim(), f.repoName.value.trim(), f.repoCategory.value)) }, 'Register existing'),
        h('button', { disabled: !!busy || !gitea, onclick: () => void act('repo', () => api.createRepository(f.repoName.value.trim(), f.repoCategory.value, f.repoDescription.value.trim())) }, 'Create new')),
      results.repo)
    const local = h('details.card.register-local', h('summary', 'Register a local workspace by path'),
      h('p.muted.small', 'For a project root already on this host. Only offered to local clients: through agdevworld the service refuses host paths.'),
      h('div.row', h('label.field', h('span', 'Path'), f.wsPath),
        h('button', { disabled: !!busy, onclick: () => void act('local', async () => { const r: RegisterResponse = await api.register(f.wsPath.value.trim()); return { ...r, steps: r.diagnostics.map(d => ({ name: d.code, status: d.severity === 'error' ? 'failed' : 'kept', detail: `${d.message}${d.fix ? ` — ${d.fix}` : ''}` })) } }) }, 'Register')),
      results.local)
    return h('div.col', create, register, repo, local)
  }

  function renderStatus(): HTMLElement {
    const bar = h('section.dash-status')
    if (loadError) { bar.append(h('div.banner.error', h('strong', 'The dashboard cannot be read: '), loadError, ' — nothing below is current.')); return bar }
    if (!data) { bar.append(h('p.muted', 'Loading…')); return bar }
    const g = data.gitea
    const ex = data.executor
    append(bar, [
      h(`span.chip.${g.state === 'ok' ? 'ok' : 'error'}`, { title: g.error ?? '' }, g.state === 'ok' ? `Gitea ${g.url} (owner ${g.owner})` : g.state === 'unconfigured' ? `Gitea not configured: ${g.error ?? ''}` : `Gitea unreachable: ${g.error ?? ''}`),
      h(`span.chip.${ex.state === 'available' ? 'ok' : ex.state === 'not-configured' ? 'muted' : 'warn'}`, { title: ex.detail ?? '' }, `execution host: ${ex.state}${ex.detail ? ` — ${ex.detail}` : ''}`),
      h('span.muted.small', `registry ${data.registry.path}${data.registry.exists ? '' : ' (not created yet)'} · read ${when(data.at)}`),
    ])
    return bar
  }

  // ---- Simple (p8/ex1): each project's name, purpose, status and opening ----------------

  const runHref = (ws: string, ref: string) => `#/ws/${encodeURIComponent(ws)}/run/${ref.split('/').map(encodeURIComponent).join('/')}`
  function tile(name: string, purpose: string | undefined, workspaces: DashboardWorkspace[], problem: string | null, key: string): HTMLElement {
    const open = workspaces.find(w => w.available)
    const sum = (k: 'ongoing' | 'waitingOnPerson' | 'problems') => workspaces.reduce((n, w) => n + (w.runs?.[k] ?? 0), 0)
    const waiting = workspaces.flatMap(w => (w.runs?.list ?? []).filter(r => r.waiting.length).map(r => ({ ws: w.id, r })))
    const status: HTMLElement[] = []
    if (problem) status.push(h('span.tile-state.error', icon('alert', 'icon'), problem))
    if (!workspaces.length) status.push(h('span.tile-state.warn', icon('alert', 'icon'), 'No workspace on this host'))
    else if (!open) status.push(h('span.tile-state.warn', icon('alert', 'icon'), 'Its workspace is not available'))
    if (workspaces.some(w => w.available && !w.runs)) status.push(h('span.tile-state.warn', icon('alert', 'icon'), 'Runs could not be read'))
    const ongoing = sum('ongoing'), broken = sum('problems')
    // Runs that wait on someone (the list says who holds the next move).
    if (waiting.length) status.push(h('span.tile-state.attention', icon('question', 'icon'), `${waiting.length} run${waiting.length === 1 ? '' : 's'} waiting`))
    if (ongoing) status.push(h('span.tile-state.active', icon('play', 'icon'), `${ongoing} run${ongoing === 1 ? '' : 's'} in progress`))
    if (broken) status.push(h('span.tile-state.error', icon('alert', 'icon'), `${broken} run${broken === 1 ? '' : 's'} cannot be read`))
    if (!status.length) status.push(h('span.tile-state.calm', icon('check', 'icon'), 'Nothing running'))
    return h('article.project-tile', { dataset: { tile: key } },
      h('div.tile-head', icon('folder', 'icon tile-icon'), h('h2', name)),
      purpose ? h('p.tile-purpose', purpose) : null,
      h('div.tile-states', ...status),
      waiting.length ? h('ul.tile-waits', ...waiting.slice(0, 4).map(({ ws, r }) => h('li', h('a', { href: runHref(ws, r.ref) }, icon('question', 'icon small'), r.ref.split('/').join(' · ')), h('span.muted', ` — next move: ${[...new Set(r.waiting.map(x => x.holder.replace(/\s*\(.*$/, '')))].join(', ')}`)))) : null,
      waiting.length > 4 ? h('p.small.muted', `and ${waiting.length - 4} more in the project`) : null,
      h('div.tile-actions', open ? h('a.button.primary', { href: `#/ws/${encodeURIComponent(open.id)}` }, 'Open project', icon('chevron', 'icon small'))
        : h('button', { onclick: () => showDetail(() => main.querySelector<HTMLElement>(`.project-entry[data-project="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' })) }, 'Workspace options')))
  }

  function renderSimple(): HTMLElement {
    const box = h('section.dash-simple.s-only')
    const createEntry = h('button.primary', { onclick: () => showDetail(() => { const c = main.querySelector<HTMLElement>('.create-project'); c?.scrollIntoView({ block: 'start' }); f.id.focus({ preventScroll: true }) }) }, icon('plus', 'icon small'), 'New project')
    box.append(h('div.simple-head', h('h1', 'Projects'), createEntry))
    if (loadError) { box.append(h('div.banner.error', icon('alert', 'icon small'), 'The dashboard cannot be read now. ', h('span.small', loadError))); return box }
    if (!data) { box.append(h('p.muted', 'Loading…')); return box }
    if (data.gitea.state !== 'ok') box.append(h('div.banner.warn', icon('alert', 'icon small'), data.gitea.state === 'unconfigured' ? 'Gitea is not configured: projects cannot be created or obtained here.' : 'Gitea cannot be reached: projects cannot be created or obtained now.'))
    const tiles = [
      ...data.projects.map(p => tile(p.name ?? p.id, p.intent?.split('\n').map(x => x.trim()).find(Boolean), p.workspaces, p.definition.error ? 'Its definition could not be read' : p.root.error ? 'Its repository could not be read' : null, p.id)),
      ...data.unlinkedWorkspaces.map(w => tile(w.label, undefined, [w], null, `ws:${w.id}`)),
    ]
    box.append(tiles.length ? h('div.project-tiles', ...tiles) : h('p.empty-note', data.registry.exists ? 'No project is registered yet.' : 'No project yet. Create one, or register an existing one in Detail.'))
    return box
  }

  // A render re-attaches the forms' inputs (they outlive renders); the one
  // being typed in gets the keyboard back with its selection, so the 20 s
  // refresh never takes it away (found in p8/ex1).
  function render() {
    const active = document.activeElement
    const typing = Object.values(f).find(el => el === active) as HTMLInputElement | HTMLTextAreaElement | undefined
    const sel = typing && 'selectionStart' in typing ? [typing.selectionStart, typing.selectionEnd] as const : null
    renderInto()
    if (typing && document.activeElement !== typing) {
      typing.focus({ preventScroll: true })
      if (sel && sel[0] !== null) try { typing.setSelectionRange(sel[0], sel[1]) } catch { /* not a text control */ }
    }
  }
  function renderInto() {
    content.replaceChildren(renderSimple(), h('div.dash-detail.d-only', renderStatus(), h('div.dash-grid', h('div.col', renderProjects(), renderRepositories()), renderEntrances())))
  }

  // The registry may change from the CLI or another view; the page follows
  // it, and re-reads Gitea and the workspaces every 20 s.
  const stream = live(api.eventsUrl(), {
    classify: ev => (ev.kind === 'registry' ? ['registry'] : null), flush: () => load(),
    state: s => { const el = header.querySelector('.live-state'); if (el) el.textContent = s ? 'live' : 'not live' },
  })
  const timer = setInterval(() => { if (!busy) void load() }, 20_000)

  render()
  void load()
  if (opts.context) requestAnimationFrame(() => context.reveal(true))
  return { dispose: () => { disposed = true; context.dispose(); stream.close(); clearInterval(timer) }, isDirty: () => context.isDirty() }
}
