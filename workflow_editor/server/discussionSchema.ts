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
}, {
  // An invitation delivered to a run that is already there: the person's
  // reply to a participant's question goes to the run that asked
  // ({question, message}: its WFE question, and the message that asked).
  version: 5,
  up: db => db.exec('ALTER TABLE invitations ADD COLUMN delivery TEXT'),
}, {
  // An awaited result (argue p3): the facilitator awaits the result of a run
  // that is already working (`awaits = 'result'`); no run is started for it.
  version: 6,
  up: db => db.exec('ALTER TABLE invitations ADD COLUMN awaits TEXT'),
}, {
  // Activities (argue p4, docs/discussions.md *Conductor*, *Activities*):
  // the conductor run that owns a discussion's progression and the requester
  // it consults; each announce / ask / ponder / talk of a run's node, bound to
  // its messages, invitations and decision, with an append-only event history
  // (each event keeps the activity as it was then: what the archive exports);
  // the node a message was spoken for; annotations — interventions,
  // recoveries, evaluations and corrections by someone outside the speech.
  version: 7,
  up: db => db.exec(`
    ALTER TABLE conversations ADD COLUMN conductor TEXT;
    ALTER TABLE conversations ADD COLUMN requester TEXT;
    ALTER TABLE invitations ADD COLUMN activity INTEGER;
    ALTER TABLE messages ADD COLUMN node TEXT;
    CREATE TABLE activities (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, run TEXT NOT NULL, node TEXT NOT NULL, attempt TEXT,
      kind TEXT NOT NULL, state TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '[]', message INTEGER, question TEXT,
      awaits TEXT, decision TEXT, obligations TEXT, outcome TEXT, token TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE (conv, token));
    CREATE INDEX activities_conv ON activities (conv, id);
    CREATE INDEX activities_run ON activities (run, node);
    CREATE TABLE activity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, activity INTEGER, kind TEXT NOT NULL, state TEXT NOT NULL,
      at TEXT NOT NULL, by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX activity_events_conv ON activity_events (conv, id);
    CREATE TABLE annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
      re TEXT NOT NULL DEFAULT '[]', run TEXT, at TEXT NOT NULL, token TEXT, UNIQUE (conv, token));
    CREATE INDEX annotations_conv ON annotations (conv, id);
  `),
}, {
  // The archive's destination (argue p4 ex1): the repository a published
  // commit and horizon were verified in. A row whose destination is not the
  // configured archive repository (or, written before v8, has none) is
  // `unverified` until the writer reads the configured one.
  version: 8,
  up: db => db.exec('ALTER TABLE archives ADD COLUMN destination TEXT'),
}]
