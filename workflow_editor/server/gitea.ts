// Gitea: where projects and shared repositories are stored and shared (p4).
//
// The host setting is a small JSON file, never tracked:
//   {"url": "http://host:3000", "owner": "developer", "tokenFile": "gitea.token"}
// `tokenFile` is relative to the setting's own file. The token reaches Git as
// an HTTP header through GIT_CONFIG_* environment variables, scoped to the
// Gitea URL; it is never written into a URL, a remote, a Git config file, a
// project file or a run record. Repository URLs inside projects are relative
// (`../<name>.git`), so .gitmodules names no host either.
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { git } from './git.ts'

export interface GiteaSetting { url: string; owner: string; tokenFile: string; file: string }
export interface GiteaRepo {
  id: number
  owner: string
  name: string
  fullName: string
  cloneUrl: string // without credentials
  htmlUrl: string
  description: string
  empty: boolean
  defaultBranch: string
  archived: boolean
}

export class GiteaError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function loadGiteaSetting(file: string): Promise<GiteaSetting> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch { throw new GiteaError(0, `the Gitea setting ${file} does not exist; write {"url", "owner", "tokenFile"} there (see README, "Gitea")`) }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (e) { throw new GiteaError(0, `the Gitea setting ${file} is not valid JSON: ${(e as Error).message}`) }
  if (!isObj(raw) || typeof raw.url !== 'string' || typeof raw.owner !== 'string' || typeof raw.tokenFile !== 'string') throw new GiteaError(0, `the Gitea setting ${file} needs text "url", "owner" and "tokenFile"`)
  return { url: raw.url.replace(/\/+$/, ''), owner: raw.owner, tokenFile: resolve(dirname(file), raw.tokenFile), file }
}

export class Gitea {
  readonly setting: GiteaSetting
  private token?: string
  constructor(setting: GiteaSetting) { this.setting = setting }
  get url() { return this.setting.url }
  get owner() { return this.setting.owner }

  private async auth(): Promise<string> {
    if (this.token === undefined) {
      try { this.token = (await readFile(this.setting.tokenFile, 'utf8')).trim() } catch { throw new GiteaError(0, `the Gitea token file ${this.setting.tokenFile} cannot be read`) }
      if (!this.token) throw new GiteaError(0, `the Gitea token file ${this.setting.tokenFile} is empty`)
    }
    return this.token
  }

  async call<T>(method: string, path: string, body?: unknown, okMissing = false): Promise<T | null> {
    const headers: Record<string, string> = { authorization: `token ${await this.auth()}`, accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await fetch(`${this.url}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    } catch (e) {
      throw new GiteaError(0, `Gitea at ${this.url} cannot be reached (${(e as Error).message})`)
    }
    if (okMissing && res.status === 404) return null
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 300)
      try { const j = JSON.parse(text) as { message?: string }; if (j.message) message = j.message } catch { /* keep the text */ }
      throw new GiteaError(res.status, `Gitea ${method} ${path}: ${res.status} ${message}`)
    }
    return (text ? JSON.parse(text) : null) as T
  }

  async login(): Promise<string> {
    return (await this.call<{ login: string }>('GET', '/user'))!.login
  }

  static repoOf(raw: Record<string, unknown>): GiteaRepo {
    const owner = (raw.owner as { login?: string; username?: string } | undefined)
    return {
      id: Number(raw.id), owner: owner?.login ?? owner?.username ?? String(raw.full_name).split('/')[0], name: String(raw.name), fullName: String(raw.full_name),
      cloneUrl: String(raw.clone_url), htmlUrl: String(raw.html_url), description: String(raw.description ?? ''),
      empty: raw.empty === true, defaultBranch: String(raw.default_branch || 'main'), archived: raw.archived === true,
    }
  }

  async repo(owner: string, name: string): Promise<GiteaRepo | null> {
    const raw = await this.call<Record<string, unknown>>('GET', `/repos/${enc(owner)}/${enc(name)}`, undefined, true)
    return raw ? Gitea.repoOf(raw) : null
  }

  async repoById(id: number): Promise<GiteaRepo | null> {
    const raw = await this.call<Record<string, unknown>>('GET', `/repositories/${id}`, undefined, true)
    return raw ? Gitea.repoOf(raw) : null
  }

  // Creates an empty repository under the configured owner: the token's own
  // user, or an organization of that name.
  async createRepo(name: string, description: string): Promise<GiteaRepo> {
    const me = await this.login()
    const body = { name, description, private: false, auto_init: false, default_branch: 'main' }
    const raw = me === this.owner
      ? await this.call<Record<string, unknown>>('POST', '/user/repos', body)
      : await this.call<Record<string, unknown>>('POST', `/orgs/${enc(this.owner)}/repos`, body)
    return Gitea.repoOf(raw!)
  }

  // Gitea's `empty` flag and branch list are updated after a push is
  // processed and can lag behind it; the refs Git serves are what it has.
  async hasContent(owner: string, name: string): Promise<boolean> {
    const r = await git(tmpdir(), ['ls-remote', '--heads', '--', this.cloneUrl(owner, name)], { env: await this.gitEnv(), timeoutMs: 30_000 })
    if (r.code !== 0) throw new GiteaError(0, `git ls-remote ${owner}/${name} failed: ${r.stderr.trim()}`)
    return r.stdout.trim() !== ''
  }

  async search(q: string, limit = 50): Promise<GiteaRepo[]> {
    const r = await this.call<{ data: Record<string, unknown>[] }>('GET', `/repos/search?q=${encodeURIComponent(q)}&limit=${limit}`)
    return (r?.data ?? []).map(Gitea.repoOf)
  }

  // A file of a branch or commit, or null when it does not exist there.
  async raw(owner: string, name: string, path: string, ref?: string): Promise<string | null> {
    const res = await fetch(`${this.url}/api/v1/repos/${enc(owner)}/${enc(name)}/raw/${path.split('/').map(enc).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
      { headers: { authorization: `token ${await this.auth()}` }, signal: AbortSignal.timeout(15_000) }).catch(e => { throw new GiteaError(0, `Gitea at ${this.url} cannot be reached (${(e as Error).message})`) })
    if (res.status === 404) return null
    if (!res.ok) throw new GiteaError(res.status, `Gitea raw ${owner}/${name}:${path}: ${res.status}`)
    return res.text()
  }

  // Files of a branch as Git serves them (the raw API can lag behind a push):
  // a shallow fetch into a bare cache repository under `cacheDir`, then
  // `git show`. Returns the commit read and each file's text (null: absent),
  // or commit null when the branch does not exist.
  async readFiles(owner: string, name: string, branch: string, paths: string[], cacheDir: string): Promise<{ commit: string | null; files: Record<string, string | null> }> {
    const cache = resolve(cacheDir, `${owner}--${name}.git`)
    const env = await this.gitEnv()
    if ((await git(tmpdir(), ['init', '--bare', '-q', cache])).code !== 0) throw new GiteaError(0, `cannot create the cache ${cache}`)
    const f = await git(cache, ['fetch', '--depth', '1', '-q', '--', this.cloneUrl(owner, name), `+refs/heads/${branch}:refs/heads/${branch}`], { env, timeoutMs: 60_000 })
    if (f.code !== 0) {
      if (/couldn't find remote ref|not found/i.test(f.stderr)) return { commit: null, files: Object.fromEntries(paths.map(p => [p, null])) }
      throw new GiteaError(0, `fetching ${owner}/${name} failed: ${f.stderr.trim()}`)
    }
    const commit = (await git(cache, ['rev-parse', `refs/heads/${branch}`])).stdout.trim()
    const files: Record<string, string | null> = {}
    for (const p of paths) { const r = await git(cache, ['show', `${commit}:${p}`]); files[p] = r.code === 0 ? r.stdout : null }
    return { commit, files }
  }

  // The environment that lets Git authenticate to this Gitea only.
  async gitEnv(): Promise<Record<string, string>> {
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${this.url}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: token ${await this.auth()}`,
      GIT_TERMINAL_PROMPT: '0',
    }
  }

  cloneUrl(owner: string, name: string) { return `${this.url}/${owner}/${name}.git` }
  webUrl(owner: string, name: string) { return `${this.url}/${owner}/${name}` }
}

const enc = encodeURIComponent

// A submodule URL relative to a project root stored under `fromOwner`.
export function relativeRepoUrl(fromOwner: string, owner: string, name: string): string {
  return owner === fromOwner ? `../${name}.git` : `../../${owner}/${name}.git`
}

// The Gitea owner/name a submodule URL points to, given the root's own
// owner/name and the Gitea base URL; null when it is elsewhere.
export function repoOfUrl(url: string, base: { giteaUrl: string; owner: string; name: string }): { owner: string; name: string } | null {
  let u = url.trim()
  if (u.startsWith('./') || u.startsWith('../')) {
    const parts = [base.owner, base.name]
    for (const seg of u.split('/')) {
      if (seg === '..') parts.pop()
      else if (seg !== '.' && seg !== '') parts.push(seg)
    }
    if (parts.length !== 2) return null
    return { owner: parts[0], name: parts[1].replace(/\.git$/, '') }
  }
  const prefix = `${base.giteaUrl.replace(/\/+$/, '')}/`
  if (!u.startsWith(prefix)) return null
  u = u.slice(prefix.length).replace(/\.git$/, '').replace(/\/+$/, '')
  const [owner, name, ...rest] = u.split('/')
  return owner && name && !rest.length ? { owner, name } : null
}
