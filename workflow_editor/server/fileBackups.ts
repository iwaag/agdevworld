// The backup of message files (workflow_editor p19, docs/message-files.md
// *Archive, export and backup*): each accepted bundle copied outside the live
// share to the destination attachments.json names, and its hashes read back
// from there. The state of each bundle's copy is recorded (store v14
// `file_backups`): `verified` names where and when; `failed` the reason,
// retried by the next run (every executor reconcile). A copy is never
// replaced; an archive clone or a control-area backup is not this.
import type { ConversationService } from './conversationService.ts'
import { backupBundle, manifestOf, type AllocatedFile, type FilesConfig } from './messageFiles.ts'

export interface BackupRow { bundle: string; conv: string; state: 'verified' | 'failed' | 'pending'; destination: string | null; detail: string | null; error: string | null; tries: number; at: string | null }

export class FileBackups {
  readonly ds: ConversationService
  readonly cfg: FilesConfig
  constructor(ds: ConversationService, cfg: FilesConfig) { this.ds = ds; this.cfg = cfg }
  private accepted() { return this.ds.db.prepare('SELECT * FROM uploads WHERE state = \'accepted\' ORDER BY id').all() as unknown as { conv: string; bundle: string; share: string; prefix: string; files: string }[] }
  private row(bundle: string) { return this.ds.db.prepare('SELECT * FROM file_backups WHERE bundle = ?').get(bundle) as BackupRow | undefined }
  // Every accepted bundle with its backup's state (`pending`: not tried yet).
  status(): BackupRow[] {
    return this.accepted().map(u => this.row(u.bundle) ?? { bundle: u.bundle, conv: u.conv, state: 'pending', destination: null, detail: null, error: null, tries: 0, at: null })
  }
  // Copies what is not verified there yet; a failure waits 2^tries minutes
  // (at most an hour) before the next try.
  async run(at = Date.now()): Promise<string[]> {
    if (!this.cfg.backup) return []
    const notes: string[] = []
    for (const u of this.accepted()) {
      const r = this.row(u.bundle)
      if (r?.state === 'verified') continue
      if (r?.state === 'failed' && r.at && at - Date.parse(r.at) < Math.min(2 ** r.tries, 60) * 60_000) continue
      const m = manifestOf({ conversation: u.conv, bundle: u.bundle, share: u.share, prefix: u.prefix, files: JSON.parse(u.files) as AllocatedFile[] })
      const when = new Date().toISOString()
      try {
        const b = await backupBundle(this.cfg, m)
        this.ds.db.prepare('INSERT INTO file_backups (bundle, conv, state, destination, detail, error, tries, at) VALUES (?, ?, \'verified\', ?, ?, NULL, ?, ?) ON CONFLICT (bundle) DO UPDATE SET state = \'verified\', destination = excluded.destination, detail = excluded.detail, error = NULL, tries = excluded.tries, at = excluded.at')
          .run(u.bundle, u.conv, b.destination, b.detail, (r?.tries ?? 0) + 1, when)
        notes.push(`message files ${u.conv} ${u.bundle}: backed up to ${b.destination} (${b.detail})`)
      } catch (e) {
        this.ds.db.prepare('INSERT INTO file_backups (bundle, conv, state, destination, detail, error, tries, at) VALUES (?, ?, \'failed\', NULL, NULL, ?, ?, ?) ON CONFLICT (bundle) DO UPDATE SET state = \'failed\', error = excluded.error, tries = excluded.tries, at = excluded.at')
          .run(u.bundle, u.conv, (e as Error).message, (r?.tries ?? 0) + 1, when)
        notes.push(`message files ${u.conv} ${u.bundle}: backup failed — ${(e as Error).message}`)
      }
    }
    return notes
  }
}
