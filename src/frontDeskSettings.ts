// The Front Desk's settings: which revision draws what.
//
// The active revision is read when the screen opens and when the user asks
// for a refresh; it is what new content — a plain reply, a new conversation
// — is drawn with. A dialogue names the revision it was written for, and
// that revision is fetched by id and kept, so a scene being read is never
// silently redrawn with faces that came later. A revision the relay no
// longer retains is reported and the active one stands in for it.

import {
  readRevision,
  readSettings,
  type SettingsCharacter,
  type SettingsManifest,
  type SettingsRevision,
  type SettingsSnapshot,
} from './settingsState'

export interface Resolved {
  manifest: SettingsManifest | null
  // The revision the caller asked for is not the one returned.
  substituted: boolean
  note: string | null
}

export class FrontDeskSettings {
  active: SettingsSnapshot | undefined
  error: string | undefined
  private readonly manifests = new Map<string, SettingsManifest>()
  private readonly missing = new Map<string, string>()
  private readonly pending = new Set<string>()
  private readonly onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  async refresh(): Promise<void> {
    const found = await readSettings()
    // A snapshot carries `error` as a field too (a sync problem beside a
    // still-serving revision), so the schema is what tells the two apart.
    if ('schema' in found) {
      this.error = found.error ?? undefined
      this.active = found
      if (found.manifest) this.manifests.set(found.manifest.revision, found.manifest)
    } else {
      this.error = found.error
    }
    this.onChange()
  }

  get activeManifest(): SettingsManifest | null {
    return this.active?.manifest ?? null
  }

  get activeRevision(): string | null {
    return this.active?.active?.revision ?? null
  }

  // The manifest for a revision, synchronously: the one asked for when it
  // is known, the active one meanwhile (a fetch is started once), and the
  // active one with a note when the relay does not retain it.
  resolve(revision: string | null): Resolved {
    const active = this.activeManifest
    if (!revision || revision === 'demo') return { manifest: active, substituted: false, note: null }
    const known = this.manifests.get(revision)
    if (known) return { manifest: known, substituted: false, note: null }
    const gone = this.missing.get(revision)
    if (gone) return { manifest: active, substituted: true, note: `settings ${revision.slice(0, 12)} — ${gone}; drawn with the current settings` }
    if (!this.pending.has(revision)) {
      this.pending.add(revision)
      void readRevision(revision).then((found) => {
        this.pending.delete(revision)
        const answer = found as Partial<SettingsRevision> & { error?: string }
        if (answer.retained && answer.manifest) {
          this.manifests.set(revision, answer.manifest)
        } else {
          this.missing.set(revision, answer.error ?? 'not retained on the relay')
        }
        this.onChange()
      })
    }
    return { manifest: active, substituted: true, note: `settings ${revision.slice(0, 12)} — reading…` }
  }

  static character(manifest: SettingsManifest | null, id: string | null): SettingsCharacter | null {
    if (!manifest || !id) return null
    return manifest.characters[id] ?? null
  }

  static front(manifest: SettingsManifest | null): SettingsCharacter | null {
    if (!manifest) return null
    return Object.values(manifest.characters).find((c) => c.agents.includes('front')) ?? manifest.characters['front'] ?? null
  }

  static bySender(manifest: SettingsManifest | null, sender: string): SettingsCharacter | null {
    if (!manifest) return null
    return Object.values(manifest.characters).find((c) => c.senders.includes(sender)) ?? null
  }

  static background(manifest: SettingsManifest | null): string | null {
    if (!manifest) return null
    const room = manifest.rooms['front'] ?? Object.values(manifest.rooms)[0]
    return room?.background ?? null
  }

  summary(): string {
    if (this.error && !this.active) return `settings unknown — ${this.error}`
    const active = this.active?.active
    if (!active) return `settings none — ${this.active?.error ?? this.error ?? 'not synced'}`
    const last = this.active?.last_sync
    const failed = last && last.ok === false ? ` · last sync failed: ${last.error}` : ''
    return `settings ${active.short} (${active.ref})${failed}`
  }
}
