// The conversation store's discussion tables (workflow_editor p16,
// docs/discussions.md). A discussion shares the store's conversations,
// messages and links with direct conversations; these are what it adds:
// members (an append-only history), invitations (the only thing that starts
// a run in a discussion) and the archive's bookkeeping.
import type { Migration } from './sqlite.ts'

export const DISCUSSION_MIGRATIONS: Migration[] = [{
  version: 4,
  up: db => db.exec(`
    ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'conversation';
    ALTER TABLE messages ADD COLUMN participant TEXT;
    ALTER TABLE messages ADD COLUMN invitation INTEGER;
    ALTER TABLE messages ADD COLUMN addressed TEXT;
    CREATE TABLE membership (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, participant TEXT NOT NULL, kind TEXT NOT NULL,
      workspace TEXT, workflow TEXT, action TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
    CREATE INDEX membership_conv ON membership (conv, id);
    CREATE TABLE invitations (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, participant TEXT NOT NULL, workspace TEXT NOT NULL, workflow TEXT NOT NULL,
      question TEXT NOT NULL, source TEXT NOT NULL DEFAULT '[]', by TEXT NOT NULL, by_run TEXT, awaited_by TEXT, horizon INTEGER NOT NULL DEFAULT 0,
      token TEXT, state TEXT NOT NULL, run TEXT, error TEXT, tries INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL,
      answered_by INTEGER, late INTEGER NOT NULL DEFAULT 0, reported TEXT, UNIQUE (conv, token));
    CREATE INDEX invitations_conv ON invitations (conv, id);
    CREATE INDEX invitations_state ON invitations (state);
    CREATE TABLE invitation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, invitation INTEGER NOT NULL, state TEXT NOT NULL,
      at TEXT NOT NULL, run TEXT, message INTEGER, note TEXT NOT NULL DEFAULT '');
    CREATE INDEX invitation_events_conv ON invitation_events (conv, id);
    CREATE TABLE archives (conv TEXT PRIMARY KEY, state TEXT NOT NULL, commit_id TEXT, horizon TEXT, published_at TEXT, error TEXT,
      tries INTEGER NOT NULL DEFAULT 0, attempted_at TEXT);
  `),
}]
