// Context repositories (`give_context_easier` p1): what the room's context
// panel reads and writes.
//
// A context is a git repository the Developer publishes for every agent to
// read; which ones exist is the shared catalog (pyagag `agrefs`), and the
// relay serves the same read model the agents use. A reference is
// `<id>@<full commit>[:<path>]`: the panel resolves the version at the moment
// of selection and inserts the full commit, so a later publication never
// changes what an already-written reference names.
//
// `relayContexts` talks to the relay; `demoContexts` is an in-memory fixture
// for `&demo=1`, so the panel can be exercised with no relay and no agent run
// (`&ctxfail=1` makes every call fail, `&ctxstale=1` shows a last-known
// catalog).

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export interface ContextHead {
  state: 'current' | 'last-known' | 'empty' | 'unavailable'
  revision: string | null
  short: string | null
  date?: string
  author?: string
  subject?: string
  error?: string
  checked_at?: number
}

export interface ContextRow {
  id: string
  name: string
  description: string
  status: 'active' | 'archived'
  branch: string | null
  origin: 'catalog' | 'local'
  web: string | null
  head: ContextHead
}

export interface CatalogState {
  url: string | null
  state: 'current' | 'last-known' | 'unavailable' | 'unconfigured'
  revision: string | null
  fetched_at: number | null
  error: string | null
  issues: string[]
}

export interface ContextBoard {
  catalog: CatalogState
  sources: ContextRow[]
  archived_hidden: number
  write: { configured: boolean; reason: string | null; owner?: string }
}

export interface Resolved {
  id: string
  ref: string
  revision: string
  short: string
  date?: string
  subject?: string
}

export interface TreeFile { path: string; size: number; text: boolean }

export interface ContextTree extends Resolved {
  name: string
  description: string
  files: TreeFile[]
  readme: { path: string; text: string; truncated: boolean } | null
}

export interface PublishFile { path: string; text?: string; base64?: string; delete?: boolean }

export interface Conflict {
  conflict: true
  head: string
  short: string
  base: string
  changed: string[]
  touched: string[]
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; status: number; conflict?: Conflict }

export interface ContextSource {
  board: (options?: { all?: boolean; refresh?: boolean }) => Promise<Outcome<ContextBoard>>
  resolve: (id: string, revision?: string) => Promise<Outcome<Resolved>>
  tree: (id: string, revision: string) => Promise<Outcome<ContextTree>>
  fileUrl: (id: string, revision: string, path: string) => string
  fileText: (id: string, revision: string, path: string) => Promise<Outcome<string>>
  create: (body: { id: string; name: string; description: string; readme: string }) => Promise<Outcome<Resolved & { steps: string[] }>>
  register: (body: { id: string; repository?: string; url?: string; name: string; description: string; branch?: string }) => Promise<Outcome<Resolved>>
  update: (id: string, body: { name?: string; description?: string; status?: 'active' | 'archived' }) => Promise<Outcome<{ changed: boolean }>>
  publish: (id: string, body: { base: string; message: string; files: PublishFile[] }) => Promise<Outcome<Resolved & { files: string[] }>>
}

export const REF_PATTERN = /(^|[\s(`"'「『])([a-z0-9][a-z0-9._-]{0,63})@([0-9a-f]{7,40})(?::([^\s`"')」』]+))?/g

export interface DraftRef { text: string; id: string; revision: string; path: string }

// The references a draft already carries, for the "newer version" offer.
export function refsIn(draft: string, known: Set<string>): DraftRef[] {
  const found: DraftRef[] = []
  for (const match of draft.matchAll(REF_PATTERN)) {
    const [, , id, revision, path] = match
    if (!known.has(id)) continue
    const text = `${id}@${revision}${path ? `:${path}` : ''}`
    if (!found.some((one) => one.text === text)) found.push({ text, id, revision, path: path ?? '' })
  }
  return found
}

export function referenceOf(id: string, revision: string, path = ''): string {
  return `${id}@${revision}${path ? `:${path}` : ''}`
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Outcome<T>> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    if (!response.ok) {
      const conflict = payload?.conflict === true ? payload as Conflict : undefined
      return { ok: false, status: response.status, error: String(payload?.error ?? `HTTP ${response.status}`), conflict }
    }
    return { ok: true, value: payload as T }
  } catch (error) {
    return { ok: false, status: 0, error: `the agentroom relay is not answering on ${BASE} (${String(error)})` }
  }
}

const enc = encodeURIComponent

export const relayContexts: ContextSource = {
  board: (options = {}) => call('GET', `/contexts?all=${options.all ? 1 : 0}&refresh=${options.refresh ? 1 : 0}`),
  resolve: (id, revision = 'latest') => call('GET', `/contexts/${enc(id)}/resolve?rev=${enc(revision)}`),
  tree: (id, revision) => call('GET', `/contexts/${enc(id)}/tree?rev=${enc(revision)}`),
  fileUrl: (id, revision, path) => `${BASE}/contexts/${enc(id)}/file?rev=${enc(revision)}&path=${enc(path)}`,
  fileText: async (id, revision, path) => {
    try {
      const response = await fetch(`${BASE}/contexts/${enc(id)}/file?rev=${enc(revision)}&path=${enc(path)}`)
      if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
      return { ok: true, value: await response.text() }
    } catch (error) {
      return { ok: false, status: 0, error: String(error) }
    }
  },
  create: (body) => call('POST', '/contexts', body),
  register: (body) => call('POST', '/contexts/register', body),
  update: (id, body) => call('POST', `/contexts/${enc(id)}`, body),
  publish: (id, body) => call('POST', `/contexts/${enc(id)}/publish`, body),
}

// --- the demo fixture ---------------------------------------------------------------

interface DemoRepo {
  row: Omit<ContextRow, 'head'>
  commits: { sha: string; files: Map<string, string>; subject: string; date: string }[]
}

function fakeSha(seed: string): string {
  let h1 = 0x811c9dc5
  let out = ''
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0
    out += h1.toString(16).padStart(8, '0')
  }
  return out.slice(0, 40)
}

const DEMO_PNG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2b3a55"/>'
  + '<circle cx="250" cy="50" r="26" fill="#ffc56d"/><path d="M0 150 Q80 90 160 140 T320 120 V180 H0Z" fill="#3f7d4e"/></svg>')

export function demoContexts(): ContextSource {
  const params = new URLSearchParams(location.search)
  const failing = () => params.get('ctxfail') === '1' || (window as unknown as { __ctxfail?: boolean }).__ctxfail === true
  const stale = params.get('ctxstale') === '1'
  const now = () => new Date().toISOString()
  const repos = new Map<string, DemoRepo>()
  const add = (id: string, name: string, description: string, files: Record<string, string>, status: 'active' | 'archived' = 'active') => {
    const sha = fakeSha(id + JSON.stringify(files))
    repos.set(id, {
      row: { id, name, description, status, branch: 'main', origin: 'catalog', web: `https://git.example/developer/${id}` },
      commits: [{ sha, files: new Map(Object.entries(files)), subject: 'first', date: '2026-09-20T10:00:00+09:00' }],
    })
  }
  add('protoprey-refs', 'ProtoPrey references', 'Stories, compositions and templates for ProtoPrey; the folder structure is part of the meaning',
    { 'README.md': '# ProtoPrey references\n\nThe meadow at dusk, seen from a mouse.\n', 'biomes/meadow/composition.png': DEMO_PNG, 'stories/meadow.md': 'Dusk over the meadow.\n' })
  add('world-lore', 'World lore', 'Places, factions and the timeline of the shared setting',
    { 'README.md': '# World lore\n\n日本語のメモもここに置く。\n', 'timeline.md': '- Year 0: the flood\n' })
  add('old-sketches', 'Old sketches', 'Retired concept sketches', { 'README.md': '# Old\n' }, 'archived')
  const head = (repo: DemoRepo) => repo.commits[repo.commits.length - 1]
  const fail = <T,>(): Outcome<T> => ({ ok: false, status: 502, error: 'the demo relay is failing on purpose (&ctxfail=1)' })
  const delay = <T,>(value: T): Promise<T> => new Promise((done) => window.setTimeout(() => done(value), 250))
  const find = (id: string, revision: string) => {
    const repo = repos.get(id)
    if (!repo) return null
    const commit = revision === 'latest' ? head(repo) : repo.commits.find((c) => c.sha.startsWith(revision))
    return commit ? { repo, commit } : null
  }
  const resolved = (id: string, commit: DemoRepo['commits'][number]): Resolved => ({
    id, ref: referenceOf(id, commit.sha), revision: commit.sha, short: commit.sha.slice(0, 7), date: commit.date, subject: commit.subject,
  })
  const commitOn = (repo: DemoRepo, files: PublishFile[], subject: string) => {
    const next = new Map(head(repo).files)
    for (const file of files) {
      if (file.delete) next.delete(file.path)
      else next.set(file.path, file.text ?? (file.base64 ? `data:application/octet-stream;base64,${file.base64}` : ''))
    }
    const sha = fakeSha(repo.row.id + subject + repo.commits.length + now())
    repo.commits.push({ sha, files: next, subject, date: now() })
    return repo.commits[repo.commits.length - 1]
  }
  return {
    board: async (options = {}) => {
      if (failing()) return delay(fail())
      const sources = [...repos.values()].filter((repo) => options.all || repo.row.status === 'active').map((repo) => {
        const commit = head(repo)
        return { ...repo.row, head: { state: 'current', revision: commit.sha, short: commit.sha.slice(0, 7), date: commit.date, subject: commit.subject } } as ContextRow
      })
      return delay({ ok: true, value: {
        catalog: { url: 'https://git.example/developer/context-catalog.git', state: stale ? 'last-known' : 'current', revision: fakeSha('catalog'),
          fetched_at: Date.now() / 1000 - (stale ? 3600 : 5), error: stale ? 'git fetch failed: could not resolve host (demo)' : null, issues: [] },
        sources, archived_hidden: options.all ? 0 : [...repos.values()].filter((r) => r.row.status === 'archived').length,
        write: { configured: true, reason: null, owner: 'developer' },
      } })
    },
    resolve: async (id, revision = 'latest') => {
      if (failing()) return delay(fail())
      const found = find(id, revision)
      return delay(found ? { ok: true, value: resolved(id, found.commit) } : { ok: false, status: 404, error: `no revision ${revision} in ${id}` })
    },
    tree: async (id, revision) => {
      if (failing()) return delay(fail())
      const found = find(id, revision)
      if (!found) return delay({ ok: false, status: 404, error: `no revision ${revision} in ${id}` })
      const files = [...found.commit.files.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([path, data]) => ({ path, size: data.length, text: !data.startsWith('data:') }))
      const readme = found.commit.files.get('README.md')
      return delay({ ok: true, value: { ...resolved(id, found.commit), name: found.repo.row.name, description: found.repo.row.description, files,
        readme: readme ? { path: 'README.md', text: readme, truncated: false } : null } })
    },
    fileUrl: (id, revision, path) => {
      const data = find(id, revision)?.commit.files.get(path) ?? ''
      return data.startsWith('data:') ? data : `data:text/plain;charset=utf-8,${encodeURIComponent(data)}`
    },
    fileText: async (id, revision, path) => {
      const data = find(id, revision)?.commit.files.get(path)
      return delay(data === undefined ? { ok: false, status: 404, error: 'no such file' } : { ok: true, value: data })
    },
    create: async (body) => {
      if (failing()) return delay(fail())
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.id)) return delay({ ok: false, status: 400, error: `${JSON.stringify(body.id)} is not an id` })
      if (!repos.has(body.id)) add(body.id, body.name || body.id, body.description, { 'README.md': body.readme || `# ${body.name}\n` })
      const commit = head(repos.get(body.id)!)
      return delay({ ok: true, value: { ...resolved(body.id, commit), steps: ['repository created', 'README published', 'registered in the catalog'] } })
    },
    register: async (body) => {
      if (failing()) return delay(fail())
      add(body.id, body.name || body.id, body.description, { 'README.md': `# ${body.name || body.id}\n` })
      return delay({ ok: true, value: resolved(body.id, head(repos.get(body.id)!)) })
    },
    update: async (id, body) => {
      if (failing()) return delay(fail())
      const repo = repos.get(id)
      if (!repo) return delay({ ok: false, status: 404, error: `${id} is not in the catalog` })
      Object.assign(repo.row, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)))
      return delay({ ok: true, value: { changed: true } })
    },
    publish: async (id, body) => {
      if (failing()) return delay(fail())
      const repo = repos.get(id)
      if (!repo) return delay({ ok: false, status: 404, error: `${id} is not in the catalog` })
      const current = head(repo)
      if (current.sha !== body.base) {
        return delay({ ok: false, status: 409, error: `${id} has a newer publication (${current.sha.slice(0, 7)})`,
          conflict: { conflict: true, head: current.sha, short: current.sha.slice(0, 7), base: body.base, changed: ['README.md'],
            touched: body.files.map((f) => f.path).filter((p) => p === 'README.md') } })
      }
      const commit = commitOn(repo, body.files, body.message || 'update')
      return delay({ ok: true, value: { ...resolved(id, commit), files: body.files.map((f) => f.path) } })
    },
  }
}

// A publication made elsewhere, for the demo's conflict path: `window.__ctxBump('world-lore')`.
export function demoBump(source: ContextSource, id: string): void {
  void source.resolve(id).then((found) => {
    if (found.ok) void source.publish(id, { base: found.value.revision, message: 'published elsewhere', files: [{ path: 'README.md', text: `# changed elsewhere ${Date.now()}\n` }] })
  })
}
