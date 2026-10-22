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
}, {
  // Reading a discussion (argue p4 ex2): its purpose category (`discussion`
  // or `check`: an operational check, a fixture) and an optional display
  // title, with an append-only history of who set them and why; and the
  // overview — a source-linked interpretation (purpose, outcome, unresolved
  // points) with its author, run, the newest message it covers and the
  // messages it cites, kept as append-only revisions apart from the speech.
  // Every existing discussion starts as `discussion`; historical checks are
  // classified explicitly, each change recorded.
  version: 9,
  up: db => db.exec(`
    ALTER TABLE conversations ADD COLUMN category TEXT;
    ALTER TABLE conversations ADD COLUMN display_title TEXT;
    UPDATE conversations SET category = 'discussion' WHERE kind = 'discussion';
    CREATE TABLE discussion_meta (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, field TEXT NOT NULL, value TEXT,
      by TEXT NOT NULL, run TEXT, at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
    CREATE INDEX discussion_meta_conv ON discussion_meta (conv, id);
    CREATE TABLE overviews (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, author TEXT NOT NULL, run TEXT, purpose TEXT NOT NULL,
      outcome TEXT, unresolved TEXT NOT NULL DEFAULT '[]', through INTEGER NOT NULL, sources TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL, token TEXT NOT NULL, UNIQUE (conv, token));
    CREATE INDEX overviews_conv ON overviews (conv, id);
  `),
}, {
  // Workflows in a discussion (argue p4 ex3, server/discussionWorkflows.ts):
  // which workflow a turn referenced, created, edited or executed, at which
  // version (byte sha256 and semantic digest, before and after), with its
  // turn (run, attempt, invitation, activity), source messages, evidence and
  // operation; later message associations as events; and every version a
  // record names, captured by sha256 (a saved definition is a draft the next
  // save replaces). `state` pending is a journal entry of an operation in
  // progress and is never shown. `since`: when recording began; what is
  // derived for operations before it is backfill.
  version: 10,
  up: db => db.exec(`
    CREATE TABLE workflow_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, relation TEXT NOT NULL, role TEXT NOT NULL, project TEXT NOT NULL,
      workflow TEXT NOT NULL, target TEXT NOT NULL, after TEXT, before TEXT, nodes TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL,
      operation TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]', activity INTEGER, invitation INTEGER, run TEXT, attempt TEXT, actor TEXT NOT NULL, origin TEXT,
      state TEXT NOT NULL, at TEXT NOT NULL, token TEXT NOT NULL, UNIQUE (conv, token));
    CREATE INDEX workflow_refs_conv ON workflow_refs (conv, id);
    CREATE INDEX workflow_refs_state ON workflow_refs (state);
    CREATE TABLE workflow_ref_events (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, ref INTEGER NOT NULL, message INTEGER NOT NULL, by TEXT NOT NULL,
      run TEXT, at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
    CREATE INDEX workflow_ref_events_conv ON workflow_ref_events (conv, id);
    CREATE TABLE workflow_snapshots (sha256 TEXT PRIMARY KEY, text TEXT NOT NULL, captured TEXT NOT NULL, origin TEXT NOT NULL);
    CREATE TABLE workflow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO workflow_meta (key, value) VALUES ('since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `),
}, {
  // Attachments (challenge p1, docs/challenges.md): what a person's message
  // carried, for conversations and discussions alike — a challenge at the
  // revision it was sent with (commit, the title it had, the file's sha256).
  // Written with the message, never changed: a later edit of the challenge
  // is a separate, current read.
  version: 11,
  up: db => db.exec(`
    CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, message INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
      commit_id TEXT NOT NULL, title TEXT NOT NULL, sha256 TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (message, kind, ref));
    CREATE INDEX attachments_conv ON attachments (conv, message);
  `),
}]
