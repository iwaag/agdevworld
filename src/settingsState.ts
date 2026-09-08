// The settings repository, as the relay serves it (`front_desk` p2).
//
// Characters (display names, lore, portraits, which agents speak as them)
// and rooms (backgrounds) come from a Git repository synced on the relay's
// host, never from this bundle: `GET /settings` is the active revision and
// `GET /settings/<revision>` a retained one. Every asset URL carries the
// revision, so a replaced image is a new URL and a browser cache can never
// keep the old one. The Front Desk reads this when the screen opens and when
// the user asks for a refresh; a dialogue saved against a revision asks for
// that revision by id, so it is drawn with the faces it was written for.

const BASE = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'

export interface SettingsCharacter {
  id: string
  name: string
  nickname: string | null
  agents: string[]
  senders: string[]
  lore: string
  lore_path: string
  // Relay-relative: `/settings/<revision>/characters/<id>/face.jpg`.
  face: string
  face_path: string
}

export interface SettingsRoom {
  id: string
  name: string
  background: string
  background_path: string
}

export interface SettingsManifest {
  schema: string
  revision: string
  characters: Record<string, SettingsCharacter>
  rooms: Record<string, SettingsRoom>
}

export interface SettingsActive {
  revision: string
  short: string
  url: string
  ref: string
  synced_at: number
  characters: string[]
  rooms: string[]
}

export interface SettingsSnapshot {
  schema: string
  generated_at: number
  config: { url: string; ref: string; path: string } | null
  active: SettingsActive | null
  last_sync: { ok: boolean; error: string | null; at: number; revision?: string | null } | null
  manifest: SettingsManifest | null
  error: string | null
}

export interface SettingsRevision {
  schema: string
  revision: string
  retained: boolean
  manifest?: SettingsManifest
  error?: string
}

// An asset path from a manifest, made absolute against the relay.
export function assetUrl(path: string): string {
  return `${BASE}${path}`
}

async function read<T>(path: string): Promise<T | { error: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8000) })
  } catch {
    return { error: `the agentroom relay is not answering on ${BASE}` }
  }
  const payload = await response.json().catch(() => undefined)
  if (!payload || typeof payload !== 'object') return { error: `agentroom answered ${response.status} without a readable body` }
  if (!response.ok && !('retained' in payload)) {
    return { error: (payload as { error?: string }).error ?? `agentroom answered ${response.status}` }
  }
  return payload as T
}

export const readSettings = () => read<SettingsSnapshot>('/settings')
export const readRevision = (revision: string) => read<SettingsRevision>(`/settings/${encodeURIComponent(revision)}`)
