// `/?view=project` — the Project Room: following a project or a study from
// its purpose through its plans and runs, and talking in the selected one.
//
// `project_room` p1 step 3. The screen is a room (`scenes/ProjectRoomScene`:
// the settings' background, softened, and the portrait of whoever answers in
// the selected conversation) with board panels over it, in DOM because a
// board is text that scrolls, wraps, is selected and typed into:
//
//   left    — every project and study, kind, counts and an "updated since you
//             looked" mark;
//   centre  — the selected project's purpose documents, setup, missions with
//             their tasks (recorded work state *and* reply state, task counts,
//             never a percentage), unrecorded plans, orphan tasks, and the
//             gaps the relay names (setup only; a research plan is not work;
//             an archived work channel makes a count incomplete);
//   right   — the selected document or plan as written, its links
//             (repository / report / zulip), the record's facts;
//   bottom  — the selected conversation's history as written and the
//             composer, posting into the source conversation as the
//             Developer (the IME textarea of the other rooms).
//
// Selection, the URL, scroll positions and the per-conversation draft
// survive the periodic refresh (`operationDashboard.ts`'s pattern: re-render
// on a changed signature, restore scrollTop, keep the keys). Loading the
// room never starts anything; a post always buys autolab a run, so it is a
// button press and a ✔'d conversation asks once more before it is resumed.
// A document has no composer: it says where to take the discussion (Front).

import Phaser from 'phaser'
import { createFrontDeskInput, type FrontDeskInputHandle } from './frontDeskInput'
import { FrontDeskSettings } from './frontDeskSettings'
import { demoSource } from './projectDemo'
import {
  Drafts,
  kindLabel,
  postConversation,
  readConversation,
  ReadPositions,
  refKey,
  relaySource,
  replyLabel,
  replyTone,
  workTone,
  type ConversationRef,
  type DocumentRow,
  type MissionRow,
  type ProjectBoard,
  type ProjectDetail,
  type ProjectRow,
  type ProjectSource,
  type Reply,
  type SetupRow,
  type TalkDetail,
  type TaskRow,
} from './projectState'
import { ago, clock, submitToken } from './roomState'
import { ProjectRoomScene } from './scenes/ProjectRoomScene'

const CONVERSATION_MS = 4000
const BOARD_MS = 15000
const NARROW = 900

const CSS = `
#project-room { position: fixed; inset: 0; display: grid; grid-template-columns: 260px minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: 48px minmax(0, 1fr) 320px; gap: 10px; padding: 10px; box-sizing: border-box; pointer-events: none; color: #f7f4ff; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Helvetica Neue", Arial, sans-serif; font-size: 13px; }
#project-room > * { pointer-events: auto; min-width: 0; min-height: 0; }
#project-room header { grid-column: 1 / 4; display: flex; align-items: center; gap: 14px; padding: 0 14px; background: rgba(13,15,20,0.78); border: 1px solid #3a4060; border-radius: 12px; }
#project-room header .pr-title { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; letter-spacing: 2px; color: #70c7ff; white-space: nowrap; }
#project-room header .pr-health { flex: 1; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #7d8199; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#project-room header nav { display: flex; gap: 8px; }
#project-room header nav a, #project-room header nav button { color: #8dccff; font: 12px system-ui; background: rgba(27,32,48,0.9); padding: 5px 10px; border-radius: 6px; text-decoration: none; border: none; cursor: pointer; }
.pr-panel { background: rgba(13,15,20,0.86); border: 1px solid #3a4060; border-radius: 12px; overflow-y: auto; padding: 10px 12px; box-sizing: border-box; }
.pr-panel h2 { margin: 0 0 8px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: 2px; color: #70c7ff; font-weight: normal; display: flex; align-items: baseline; gap: 8px; }
.pr-panel h2 small { letter-spacing: 0; color: #7d8199; font-size: 10.5px; }
.pr-panel h3 { margin: 12px 0 6px; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; letter-spacing: 1.5px; color: #b9bdd6; font-weight: normal; }
.pr-projects { grid-row: 2; grid-column: 1; }
.pr-stage { grid-row: 3; grid-column: 1; pointer-events: none !important; }
.pr-tree { grid-row: 2; grid-column: 2; }
.pr-detail { grid-row: 2; grid-column: 3; }
.pr-talk { grid-row: 3; grid-column: 2 / 4; display: flex; flex-direction: column; overflow: hidden; }
.pr-row { display: block; width: 100%; text-align: left; background: rgba(27,32,48,0.6); border: 1px solid transparent; border-radius: 8px; padding: 6px 8px; margin: 0 0 6px; color: inherit; font: inherit; cursor: pointer; box-sizing: border-box; }
.pr-row:hover { border-color: #3a4060; }
.pr-row.selected { border-color: #70c7ff; background: rgba(27,32,48,0.95); }
.pr-row.archived { opacity: 0.6; }
.pr-row .pr-name { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.pr-row .pr-sub { display: block; margin-top: 2px; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: #7d8199; white-space: normal; word-break: break-word; }
.pr-row.task { margin-left: 18px; }
.pr-chip { display: inline-block; font-family: ui-monospace, Menlo, monospace; font-size: 10px; padding: 1px 6px; border-radius: 6px; background: #1b2030; color: #b9bdd6; white-space: nowrap; }
.pr-chip.live { color: #67e8a5; } .pr-chip.warn { color: #ffc56d; } .pr-chip.bad { color: #ff8aa8; } .pr-chip.accent { color: #70c7ff; } .pr-chip.dim { color: #7d8199; } .pr-chip.muted { color: #c3c7de; } .pr-chip.other { color: #c9b8ff; }
.pr-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ffb3d9; box-shadow: 0 0 6px #ffb3d9; flex: none; }
.pr-gap { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #ffc56d; margin: 2px 0; }
.pr-note { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #7d8199; margin: 4px 0; }
.pr-empty { color: #7d8199; font-size: 12.5px; }
.pr-doc { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; color: #f7f4ff; margin: 6px 0; }
.pr-links { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.pr-links a { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: #70c7ff; background: #1b2030; padding: 3px 8px; border-radius: 6px; text-decoration: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #b9bdd6; margin: 6px 0; }
.pr-facts dt { color: #7d8199; } .pr-facts dd { margin: 0; word-break: break-word; }
.pr-talk .pr-dest { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #b9bdd6; margin: 0 0 6px; word-break: break-word; }
.pr-posts { flex: 1; overflow-y: auto; min-height: 0; padding-right: 4px; }
.pr-post { display: grid; grid-template-columns: 28px 1fr; gap: 8px; margin: 0 0 8px; }
.pr-post .pr-avatar { width: 28px; height: 28px; border-radius: 50%; background: #3a3f50; display: flex; align-items: center; justify-content: center; font-size: 13px; overflow: hidden; }
.pr-post .pr-avatar img { width: 100%; height: 100%; object-fit: cover; }
.pr-post .pr-avatar.human { background: #2a4a6a; }
.pr-post .pr-who { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: #70c7ff; }
.pr-post .pr-who.agent { color: #c9b8ff; }
.pr-post .pr-body { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.45; }
.pr-post.ack { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: #7d8199; display: block; margin: 0 0 6px 36px; }
.pr-composer { display: flex; align-items: flex-end; gap: 8px; margin-top: 8px; flex: none; }
.pr-composer .pr-slot { flex: 1; height: 44px; }
.pr-composer button { background: #1b2030; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #70c7ff; white-space: nowrap; }
.pr-composer button.resume { color: #0d0f14; background: #ffc56d; }
.pr-composer button:disabled { color: #7d8199; cursor: not-allowed; }
.pr-send-status { font-family: ui-monospace, Menlo, monospace; font-size: 11px; margin: 4px 0 0; min-height: 14px; word-break: break-word; }
.pr-send-status.warn { color: #ffc56d; } .pr-send-status.bad { color: #ff8aa8; } .pr-send-status.live { color: #67e8a5; } .pr-send-status.dim { color: #7d8199; }
.pr-front { margin: 8px 0; }
.pr-front a { color: #8dccff; margin-right: 10px; }
.pr-toggle { background: none; border: 1px solid #2c3450; border-radius: 6px; color: #b9bdd6; font: 10.5px ui-monospace, Menlo, monospace; padding: 2px 8px; cursor: pointer; }
@media (max-width: ${NARROW}px) {
  #project-room { display: block; overflow-y: auto; padding: 8px; }
  #project-room > * { margin-bottom: 8px; }
  #project-room header { flex-wrap: wrap; height: auto; padding: 8px 12px; gap: 8px; }
  #project-room header .pr-health { flex-basis: 100%; white-space: normal; }
  .pr-panel { max-height: 45vh; }
  .pr-stage { display: none; }
  .pr-talk { max-height: 70vh; height: 60vh; }
}
`

type SendPhase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'resume'; text: string; token: string; error: string }
  | { kind: 'failed'; text: string }
  | { kind: 'uncertain'; text: string }
  | { kind: 'sent'; resumed: boolean }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}
function chip(text: string, tone = 'muted') { return el('span', `pr-chip ${tone}`, text) }

function withScroll(node: HTMLElement, draw: () => void) {
  const top = node.scrollTop
  draw()
  node.scrollTop = top
}

export function initProjectRoom(): void {
  const params = new URLSearchParams(location.search)
  const demo = params.get('demo') === '1'
  const source: ProjectSource = demo ? demoSource() : relaySource
  const seen = new ReadPositions()
  const drafts = new Drafts()

  // --- selection, restored from the URL --------------------------------------------
  let projectKey: string | null = params.get('project')
  let ref: ConversationRef | null = null
  if (params.get('plan') && /^\d+$/.test(params.get('plan')!)) ref = { kind: 'work', anchor: Number(params.get('plan')) }
  else if (params.get('run') && /^\d+$/.test(params.get('run')!)) ref = { kind: 'work', anchor: Number(params.get('run')) }
  else if (params.get('topic') && projectKey) ref = { kind: 'topic', project: projectKey, topic: params.get('topic')! }
  let refRole: 'plan' | 'run' | 'topic' = params.has('run') ? 'run' : params.has('topic') ? 'topic' : 'plan'
  let showResolved = false

  let board: ProjectBoard | undefined
  let boardError: string | undefined
  let detail: ProjectDetail | undefined
  let detailError: string | undefined
  let talk: TalkDetail | undefined
  let talkError: string | undefined
  let send: SendPhase = { kind: 'idle' }
  let sending = false
  let signatures = { projects: '', tree: '', detail: '', talk: '' }

  // --- the stage ---------------------------------------------------------------------
  const style = el('style'); style.textContent = CSS; document.head.append(style)
  const app = document.getElementById('app')
  if (app) app.style.inset = '0'
  const scene = new ProjectRoomScene(() => { renderTalk(true); renderSpeaker(); renderHealth() })
  new Phaser.Game({
    type: Phaser.AUTO, parent: 'app', backgroundColor: '#0d0f14',
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH }, scene: [scene],
  })

  // --- the board -------------------------------------------------------------------
  const root = el('main'); root.id = 'project-room'
  const header = el('header')
  const title = el('span', 'pr-title', 'PROJECT ROOM')
  const health = el('span', 'pr-health', 'reading the relay…')
  const nav = el('nav')
  for (const [label, href] of [['Front Desk ↗', demo ? '/?view=frontdesk&demo=1' : '/?view=frontdesk'], ['Arguing Room ↗', demo ? '/?view=argue&demo=1' : '/?view=argue'], ['Operation room ↗', '/']]) {
    const a = el('a', '', label); a.href = href; nav.append(a)
  }
  const refreshButton = el('button', '', 'refresh'); refreshButton.onclick = () => { void refreshAll() }
  nav.append(refreshButton)
  header.append(title, health, nav)
  const projectsPanel = el('aside', 'pr-panel pr-projects')
  const stage = el('div', 'pr-stage')
  const treePanel = el('section', 'pr-panel pr-tree')
  const detailPanel = el('section', 'pr-panel pr-detail')
  const talkPanel = el('section', 'pr-panel pr-talk')
  root.append(header, projectsPanel, stage, treePanel, detailPanel, talkPanel)
  document.body.append(root)

  // The composer: the rooms' IME textarea, placed over the slot in the talk panel.
  const dest = el('p', 'pr-dest')
  const posts = el('div', 'pr-posts')
  const composer = el('div', 'pr-composer')
  const slot = el('div', 'pr-slot')
  const sendButton = el('button', '', 'Send ⏎ · buys a run')
  const resumeButton = el('button', 'resume', 'resume and post · buys a run'); resumeButton.style.display = 'none'
  composer.append(slot, resumeButton, sendButton)
  const sendStatus = el('p', 'pr-send-status dim')
  const talkTitle = el('h2', '', 'CONVERSATION')
  talkPanel.append(talkTitle, dest, posts, composer, sendStatus)
  let draft = ''
  const keys: FrontDeskInputHandle = createFrontDeskInput({
    onChange: (text) => {
      draft = text
      if (ref) drafts.set(refKey(ref), text)
      renderComposer()
    },
    onSubmit: () => void submit(false),
  })
  sendButton.onclick = () => void submit(false)
  resumeButton.onclick = () => void submit(true)

  function placeComposer() {
    const narrow = window.innerWidth < NARROW
    const rect = slot.getBoundingClientRect()
    const visible = talkPanel.offsetParent !== null && rect.width > 20 && (ref !== null) && (talk?.conversation.destination.postable ?? true)
    if (!visible) { keys.place({ x: -1000, y: -1000, width: 10, height: 10 }); return }
    keys.place({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    const stageRect = stage.getBoundingClientRect()
    scene.setStage(narrow || stageRect.height < 60 ? { x: 0, y: 0, width: 0, height: 0 } : { x: stageRect.left + 4, y: stageRect.top, width: stageRect.width - 8, height: stageRect.height })
  }
  window.addEventListener('resize', placeComposer)
  root.addEventListener('scroll', placeComposer)
  scene.whenLaidOut(placeComposer)

  // --- reads -------------------------------------------------------------------------
  async function refreshBoard() {
    const found = await source.board()
    if ('error' in found) { boardError = found.error; renderHealth(); renderProjects(); return }
    boardError = undefined
    board = found
    renderHealth()
    renderProjects()
    if (projectKey && !board.projects.some((p) => p.key === projectKey || p.channel === projectKey || p.slug === projectKey)) {
      detailError = `no project ${projectKey} on the board`
    }
  }
  async function refreshProject() {
    if (!projectKey) { detail = undefined; renderTree(); renderDetail(); return }
    const found = await source.project(projectKey)
    if ('error' in found) { detailError = found.error; renderTree(); renderDetail(); return }
    detailError = undefined
    detail = found
    if (found.project.key !== projectKey) { projectKey = found.project.key; writeUrl() }
    renderTree()
    renderDetail()
  }
  async function refreshTalk() {
    const current = ref
    if (!current) { talk = undefined; renderTalk(); renderSpeaker(); return }
    const found = await readConversation(source, current)
    if (refKey(current) !== refKey(ref)) return
    if ('error' in found) { talkError = found.error; renderTalk(); return }
    talkError = undefined
    talk = found
    const newest = found.conversation.posts[found.conversation.posts.length - 1]
    if (newest) seen.mark(refKey(current), newest.message_id)
    renderTalk()
    renderDetail()
    renderSpeaker()
    renderProjects()
    renderTree()
  }
  async function refreshAll() { await Promise.all([refreshBoard(), refreshProject(), refreshTalk()]) }

  // --- selection --------------------------------------------------------------------
  function writeUrl() {
    const url = new URL(location.href)
    for (const key of ['project', 'plan', 'run', 'topic']) url.searchParams.delete(key)
    if (projectKey) url.searchParams.set('project', projectKey)
    if (ref?.kind === 'work') url.searchParams.set(refRole === 'run' ? 'run' : 'plan', String(ref.anchor))
    if (ref?.kind === 'topic') url.searchParams.set('topic', ref.topic)
    history.replaceState(null, '', url)
  }
  function selectProject(key: string) {
    if (key === projectKey) return
    projectKey = key
    detail = undefined; detailError = undefined
    selectConversation(null, 'plan')
    writeUrl()
    void refreshProject()
  }
  function selectConversation(next: ConversationRef | null, role: 'plan' | 'run' | 'topic') {
    if (refKey(next) === refKey(ref) && role === refRole) return
    if (ref) drafts.set(refKey(ref), draft)
    ref = next; refRole = role
    talk = undefined; talkError = undefined
    send = { kind: 'idle' }
    draft = next ? drafts.get(refKey(next)) : ''
    keys.set(draft)
    writeUrl()
    renderTalk(); renderDetail(); renderProjects(); renderTree(); renderSpeaker()
    void refreshTalk()
    keys.focus()
  }

  // --- writes -----------------------------------------------------------------------
  async function submit(resume: boolean) {
    const text = (send.kind === 'resume' ? send.text : draft).trim()
    if (!ref || text === '' || sending || keys.composing()) return
    const conversation = talk?.conversation
    if (conversation && !conversation.destination.postable) {
      send = { kind: 'failed', text: 'a document is not a conversation anybody serves; take it to Front (links above)' }
      renderComposer(); return
    }
    if (talk && !talk.chat.configured) {
      send = { kind: 'failed', text: talk.chat.reason ?? 'the relay cannot post right now' }
      renderComposer(); return
    }
    if (talk?.chat.max_chars && text.length > talk.chat.max_chars) {
      send = { kind: 'failed', text: `${text.length} characters is over the ${talk.chat.max_chars} the relay sends` }
      renderComposer(); return
    }
    const token = send.kind === 'resume' ? send.token : submitToken()
    sending = true
    send = { kind: 'sending' }
    renderComposer()
    const result = await postConversation(source, ref, text, token, resume)
    sending = false
    if (result.sent) {
      send = { kind: 'sent', resumed: Boolean(result.resumed) }
      draft = ''
      drafts.set(refKey(ref), '')
      keys.set('')
    } else if (result.needs_resume) {
      // The draft stays; the same token is reused, so the confirmed submit is
      // the same submit to the relay.
      send = { kind: 'resume', text, token, error: result.error ?? 'the conversation carries ✔' }
    } else if (result.uncertain) {
      send = { kind: 'uncertain', text: `${result.error ?? 'the post may have landed'}${result.note ? ` — ${result.note}` : ''}` }
    } else {
      send = { kind: 'failed', text: result.error ?? 'the post was refused' }
    }
    renderComposer()
    keys.focus()
    await refreshTalk()
  }

  // --- rendering --------------------------------------------------------------------
  function unreadOf(project: ProjectRow): boolean {
    const rows: { key: string; last: { message_id: number } | null | undefined }[] = [
      ...project.documents.map((d) => ({ key: `topic:${project.key}/${d.topic}`, last: d.last_post })),
      ...project.setups.map((s) => ({ key: `topic:${project.key}/${s.topic}`, last: s.last_post })),
      ...project.plans.map((s) => ({ key: `topic:${project.key}/${s.topic}`, last: s.last_post })),
      ...project.missions.map((m) => ({ key: `work:${m.anchor}`, last: m.last_post })),
      ...project.missions.flatMap((m) => (m.tasks ?? []).map((t) => ({ key: `work:${t.anchor}`, last: t.last_post }))),
    ]
    return rows.some((row) => seen.unread(row.key, row.last))
  }

  function renderHealth() {
    if (boardError) { health.textContent = `⚠ UNKNOWN — ${boardError}; last known board`; health.style.color = '#ffc56d'; return }
    if (!board) { health.textContent = 'reading the relay…'; health.style.color = '#7d8199'; return }
    const h = board.health
    const chat = talk ? (talk.chat.configured ? 'you post as the Developer' : (talk.chat.reason ?? 'chat read-only')) : ''
    if (h.state !== 'live') { health.textContent = `⚠ UNKNOWN — ${h.reason}; last known board · reply states unknown`; health.style.color = '#ffc56d'; return }
    const images = scene.unreadableImages ? ` · ${scene.unreadableImages} image(s) unreadable, fallback shown` : ''
    health.textContent = `relay live · ${board.counts.live} live project(s), ${board.counts.archived} archived · ${scene.settings.summary()}${chat ? ` · ${chat}` : ''}${images}`
    health.style.color = '#67e8a5'
  }

  function replyChip(reply: Reply | undefined | null) {
    return chip(`reply ${replyLabel(reply)}`, replyTone(reply?.state))
  }

  function renderProjects() {
    const rows = board?.projects ?? []
    const signature = JSON.stringify([rows.map((p) => [p.key, p.kind, p.archived, p.counts, p.reply, p.latest?.message_id, unreadOf(p), p.gaps.map((g) => g.kind)]), projectKey, boardError])
    if (signature === signatures.projects) return
    signatures.projects = signature
    withScroll(projectsPanel, () => {
      projectsPanel.replaceChildren()
      const h2 = el('h2', '', 'PROJECTS & STUDIES'); h2.append(el('small', '', rows.length ? `${rows.length}` : ''))
      projectsPanel.append(h2)
      if (!board && boardError) projectsPanel.append(el('p', 'pr-empty', `⚠ ${boardError}`))
      else if (!board) projectsPanel.append(el('p', 'pr-empty', 'reading…'))
      else if (!rows.length) projectsPanel.append(el('p', 'pr-empty', 'no project channel on the realm'))
      let archivedShown = false
      for (const project of rows) {
        if (project.archived && !archivedShown) { projectsPanel.append(el('h3', '', 'ARCHIVED')); archivedShown = true }
        const row = el('button', `pr-row${project.key === projectKey ? ' selected' : ''}${project.archived ? ' archived' : ''}`)
        const name = el('span', 'pr-name')
        if (unreadOf(project)) name.append(el('span', 'pr-dot'))
        name.append(document.createTextNode(project.slug), chip(kindLabel(project.kind), project.kind === 'unknown' ? 'dim' : 'accent'))
        if (project.reply.state !== 'quiet') name.append(chip(project.reply.state, replyTone(project.reply.state)))
        row.append(name)
        const c = project.counts
        const bits = [`${c.missions} mission${c.missions === 1 ? '' : 's'}${c.open_missions ? ` (${c.open_missions} open)` : ''}`,
          c.tasks ? `tasks ${c.tasks_finished}/${c.tasks}${project.tasks_read.complete ? '' : '?'}` : '',
          c.documents ? `${c.documents} doc` : '', c.setups ? 'setup' : '', c.plans_unrecorded ? `${c.plans_unrecorded} unrecorded` : '',
          project.latest ? `· ${ago(Date.now() / 1000 - project.latest.at)} ago` : ''].filter(Boolean)
        row.append(el('span', 'pr-sub', bits.join(' · ')))
        for (const gap of project.gaps.slice(0, 1)) row.append(el('span', 'pr-sub', `⚠ ${gap.kind}`))
        row.onclick = () => selectProject(project.key)
        projectsPanel.append(row)
      }
    })
  }

  function convRow(label: string, sub: string[], selected: boolean, unread: boolean, chips: HTMLElement[], onClick: () => void, extra = '') {
    const row = el('button', `pr-row${selected ? ' selected' : ''}${extra ? ` ${extra}` : ''}`)
    const name = el('span', 'pr-name')
    if (unread) name.append(el('span', 'pr-dot'))
    name.append(document.createTextNode(label), ...chips)
    row.append(name)
    if (sub.length) row.append(el('span', 'pr-sub', sub.filter(Boolean).join(' · ')))
    row.onclick = onClick
    return row
  }

  function renderTree() {
    const project = detail?.project
    const signature = JSON.stringify([project && [project.key, project.documents, project.setups, project.missions, project.plans, project.orphan_tasks, project.gaps], refKey(ref), showResolved, detailError, seen])
    if (signature === signatures.tree) return
    signatures.tree = signature
    withScroll(treePanel, () => {
      treePanel.replaceChildren()
      const h2 = el('h2', '', project ? project.channel.toUpperCase() : 'PROJECT')
      const toggle = el('button', 'pr-toggle', showResolved ? 'hide ✔ history' : 'show ✔ history')
      toggle.onclick = () => { showResolved = !showResolved; renderTree() }
      h2.append(toggle)
      treePanel.append(h2)
      if (!project) {
        treePanel.append(el('p', 'pr-empty', detailError ? `⚠ ${detailError}` : projectKey ? 'reading…' : 'Pick a project or study on the left. Its purpose, setup, plans and runs are listed here; select one to read it and talk in it.'))
        return
      }
      const head = el('p', 'pr-note')
      head.append(chip(kindLabel(project.kind), project.kind === 'unknown' ? 'dim' : 'accent'))
      if (project.origin) {
        const a = el('a', '', ` from argue ${project.origin.topic} ↗`)
        a.href = project.origin.anchor ? `/?view=argue&argue=${project.origin.anchor}${demo ? '&demo=1' : ''}` : (project.origin.zulip_url ?? '#')
        a.style.color = '#8dccff'
        head.append(a)
      }
      if (project.zulip_url) { const a = el('a', '', ' · channel in Zulip ↗'); a.href = project.zulip_url; a.target = '_blank'; a.style.color = '#8dccff'; head.append(a) }
      treePanel.append(head)
      if (project.description) treePanel.append(el('p', 'pr-note', project.description))
      for (const gap of project.gaps) treePanel.append(el('p', 'pr-gap', `⚠ ${gap.text}`))
      if (!project.tasks_read.complete && project.tasks_read.incomplete_missions.length) {
        treePanel.append(el('p', 'pr-gap', `task counts incomplete for ${project.tasks_read.incomplete_missions.join(', ')}: their work channel is not mirrored`))
      }

      const isSel = (r: ConversationRef) => refKey(r) === refKey(ref)
      const topicRef = (topic: string): ConversationRef => ({ kind: 'topic', project: project.key, topic })
      treePanel.append(el('h3', '', 'PURPOSE'))
      if (!project.documents.length) treePanel.append(el('p', 'pr-empty', 'no goal or research plan posted'))
      for (const d of project.documents as DocumentRow[]) {
        const r = topicRef(d.topic)
        treePanel.append(convRow(d.title || d.topic, [d.document_kind, `${d.versions} version${d.versions === 1 ? '' : 's'}`, d.last_post ? `${clock(d.last_post.at)} by ${d.last_post.by}` : ''],
          isSel(r), seen.unread(refKey(r), d.last_post), [chip('document', 'other')], () => selectConversation(r, 'topic')))
      }
      if (project.setups.length) {
        treePanel.append(el('h3', '', 'SETUP'))
        for (const s of project.setups as SetupRow[]) {
          if (s.resolved && !showResolved) continue
          const r = topicRef(s.topic)
          treePanel.append(convRow(s.topic, [s.last_post ? `${clock(s.last_post.at)} by ${s.last_post.by}` : 'no post', 'plans no mission'],
            isSel(r), seen.unread(refKey(r), s.last_post), [replyChip(s.reply), ...(s.resolved ? [chip('✔', 'live')] : [])], () => selectConversation(r, 'topic')))
        }
      }
      treePanel.append(el('h3', '', `PLANS & RUNS`))
      // Finished missions are history: folded away while something is still
      // open, shown when the project has nothing else to show.
      const finished = (m: MissionRow) => m.resolved && ['done', 'cancelled', 'replaced'].includes(m.work.state)
      const anyOpen = (project.missions as MissionRow[]).some((m) => !finished(m))
      const missions = (project.missions as MissionRow[]).filter((m) => showResolved || !anyOpen || !finished(m))
      const hidden = project.missions.length - missions.length
      if (!project.missions.length && !project.plans.length) treePanel.append(el('p', 'pr-empty', 'no mission has been asked for'))
      for (const m of missions) {
        const r: ConversationRef = { kind: 'work', anchor: m.anchor }
        const c = m.task_counts
        const chips = [chip(`work ${m.work.state}`, workTone(m.work.state)), replyChip(m.reply)]
        if (m.setup) chips.push(chip('setup', 'dim'))
        if (m.resolved) chips.push(chip('✔', 'live'))
        if (m.replaces) chips.push(chip(`replaces m${m.replaces}`, 'dim'))
        if (m.replaced_by) chips.push(chip(`replaced by m${m.replaced_by}`, 'dim'))
        const sub = [m.label, m.topic, `tasks ${c.finished}/${c.live}${c.cancelled ? ` (+${c.cancelled} cancelled)` : ''}${m.tasks_read.complete ? '' : ' — incomplete'}`,
          m.last_post ? `${clock(m.last_post.at)} by ${m.last_post.by}` : '']
        treePanel.append(convRow(m.title || m.document?.title || m.topic, sub, isSel(r), seen.unread(refKey(r), m.last_post), chips, () => selectConversation(r, 'plan')))
        for (const gap of m.gaps) treePanel.append(el('p', 'pr-gap', `   ⚠ ${gap.text}`))
        for (const t of (m.tasks ?? []) as TaskRow[]) {
          const tr: ConversationRef = { kind: 'work', anchor: t.anchor }
          treePanel.append(convRow(`#${t.serial} ${t.document?.title ?? t.topic}`, [t.label, t.last_post ? `${clock(t.last_post.at)} by ${t.last_post.by}` : 'no post'],
            isSel(tr), seen.unread(refKey(tr), t.last_post), [chip(t.state, workTone(t.state)), replyChip(t.reply), ...(t.resolved ? [chip('✔', 'live')] : [])],
            () => selectConversation(tr, 'run'), 'task'))
        }
      }
      if (hidden) treePanel.append(el('p', 'pr-note', `${hidden} finished mission(s) hidden — show ✔ history`))
      if (project.plans.length) {
        treePanel.append(el('h3', '', 'PLANS WITHOUT A RECORD'))
        for (const p of project.plans as SetupRow[]) {
          if (p.resolved && !showResolved) continue
          const r = topicRef(p.topic)
          treePanel.append(convRow(p.topic, ['no [mission] note', p.last_post ? `${clock(p.last_post.at)} by ${p.last_post.by}` : ''],
            isSel(r), seen.unread(refKey(r), p.last_post), [replyChip(p.reply), ...(p.resolved ? [chip('✔', 'live')] : [])], () => selectConversation(r, 'topic')))
        }
      }
      if (project.orphan_tasks?.length) {
        treePanel.append(el('h3', '', 'TASKS WHOSE MISSION IS MISSING'))
        for (const t of project.orphan_tasks) {
          const tr: ConversationRef = { kind: 'work', anchor: t.anchor }
          treePanel.append(convRow(`${t.label} ${t.document?.title ?? t.topic}`, [`mission m${t.mission} is not in any project channel`],
            isSel(tr), seen.unread(refKey(tr), t.last_post), [chip(t.state, workTone(t.state)), replyChip(t.reply)], () => selectConversation(tr, 'run')))
        }
      }
    })
  }

  function linksBlock(links: { url: string; kind: string }[], zulip: string | null | undefined) {
    const block = el('div', 'pr-links')
    if (zulip) { const a = el('a', '', '💬 source in Zulip'); a.href = zulip; a.target = '_blank'; a.rel = 'noopener'; block.append(a) }
    for (const link of links) {
      let label = link.url
      try { const u = new URL(link.url); label = u.host + (u.pathname === '/' ? '' : u.pathname) } catch { /* keep */ }
      const a = el('a', '', `${link.kind === 'repository' ? '📦' : link.kind === 'report' ? '📄' : link.kind === 'zulip' ? '💬' : '🔗'} ${label}`)
      a.href = link.url; a.target = '_blank'; a.rel = 'noopener'; a.title = link.url
      block.append(a)
    }
    return block
  }

  function facts(pairs: [string, string][]) {
    const dl = el('dl', 'pr-facts')
    for (const [k, v] of pairs) { if (!v) continue; dl.append(el('dt', '', k), el('dd', '', v)) }
    return dl
  }

  function renderDetail() {
    const project = detail?.project
    const conversation = talk?.conversation
    const signature = JSON.stringify([project?.key, refKey(ref), conversation?.record, conversation?.destination, talkError, project?.documents, project?.gaps])
    if (signature === signatures.detail) return
    signatures.detail = signature
    withScroll(detailPanel, () => {
      detailPanel.replaceChildren()
      if (!project) { detailPanel.append(el('h2', '', 'DOCUMENT'), el('p', 'pr-empty', 'nothing selected')); return }
      if (!ref) {
        detailPanel.append(el('h2', '', 'ABOUT THIS ' + kindLabel(project.kind).toUpperCase()))
        const c = project.counts
        detailPanel.append(facts([['channel', `#${project.channel}`], ['kind', kindLabel(project.kind)], ['origin', project.origin ? `#${project.origin.channel} › ${project.origin.topic}` : 'not recorded'],
          ['missions', `${c.missions} (${Object.entries(c.missions_by_state).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`],
          ['tasks', `${c.tasks_finished} finished of ${c.tasks}${project.tasks_read.complete ? '' : ' (incomplete read)'}`],
          ['latest', project.latest ? `${clock(project.latest.at)} in ${project.latest.topic} by ${project.latest.by}` : 'no post read']]))
        for (const gap of project.gaps) detailPanel.append(el('p', 'pr-gap', `⚠ ${gap.text}`))
        const first = project.documents[0]
        if (first?.current?.content) {
          detailPanel.append(el('h3', '', first.document_kind === 'goal' ? 'GOAL' : `RESEARCH PLAN ${first.topic}`))
          detailPanel.append(el('div', 'pr-doc', first.current.content))
        }
        return
      }
      const record = conversation?.record
      if (conversation?.kind === 'document') {
        const doc = project.documents.find((d) => d.topic === (ref?.kind === 'topic' ? ref.topic : '')) as DocumentRow | undefined
        detailPanel.append(el('h2', '', doc?.document_kind === 'goal' ? 'GOAL' : 'RESEARCH PLAN'))
        detailPanel.append(facts([['topic', conversation.destination.topic], ['versions', String(doc?.versions ?? conversation.posts.length)],
          ['current', doc?.current ? `${clock(doc.current.at)} by ${doc.current.by}` : '']]))
        detailPanel.append(el('p', 'pr-gap', '⚠ a document is not executable work: no mission belongs to it by name. Ask Front how to proceed.'))
        if (conversation.front) {
          const p = el('p', 'pr-front')
          const desk = el('a', '', 'Front Desk ↗'); desk.href = conversation.front.desk; p.append(desk)
          if (conversation.front.argue) { const a = el('a', '', 'the argue it grew out of ↗'); a.href = conversation.front.argue; p.append(a) }
          detailPanel.append(p)
        }
        detailPanel.append(linksBlock(doc?.links ?? [], conversation.zulip_url))
        detailPanel.append(el('div', 'pr-doc', doc?.current?.content ?? conversation.posts[conversation.posts.length - 1]?.content ?? ''))
        return
      }
      if (record && 'task_counts' in record) {
        const m = record as MissionRow
        detailPanel.append(el('h2', '', m.setup ? 'SETUP MISSION' : 'MISSION PLAN'))
        const c = m.task_counts
        detailPanel.append(facts([['mission', `${m.label} · #${m.channel} › ${m.live_topic}`], ['recorded state', `${m.work.state} — ${m.work.note}`], ['reply', `${replyLabel(m.reply)}${m.reply.evidence ? ` — ${m.reply.evidence}` : ''}`],
          ['tasks', `${c.finished} finished of ${c.live} live (${c.completed} completed, ${c.accepted} accepted, ${c.open} open${c.cancelled ? `, ${c.cancelled} cancelled` : ''})${m.tasks_read.complete ? '' : ' — incomplete: ' + (m.tasks_read.note ?? '')}`],
          ['replaces', m.replaces ? `m${m.replaces}` : ''], ['replaced by', m.replaced_by ? `m${m.replaced_by}` : ''],
          ['origins', (m.origins ?? []).map((o) => `#${o.channel} › ${o.topic} (${o.by})`).join('; ')]]))
        for (const gap of m.gaps) detailPanel.append(el('p', 'pr-gap', `⚠ ${gap.text}`))
        detailPanel.append(linksBlock(m.links ?? [], m.zulip_url))
        if (m.document?.content) { detailPanel.append(el('h3', '', `PLAN · ${m.document.title}`)); detailPanel.append(el('div', 'pr-doc', m.document.content)) }
        else detailPanel.append(el('p', 'pr-empty', 'no current plan document is recorded'))
        return
      }
      if (record && 'serial' in record) {
        const t = record as TaskRow
        detailPanel.append(el('h2', '', `TASK ${t.serial}`))
        detailPanel.append(facts([['task', `${t.label} · #${t.channel} › ${t.live_topic}`], ['recorded state', t.state], ['reply', `${replyLabel(t.reply)}${t.reply.evidence ? ` — ${t.reply.evidence}` : ''}`],
          ['origins', (t.origins ?? []).map((o) => `#${o.channel} › ${o.topic} (${o.by})`).join('; ')]]))
        detailPanel.append(linksBlock(t.links ?? [], t.zulip_url))
        if (t.document?.content) { detailPanel.append(el('h3', '', `TASK · ${t.document.title}`)); detailPanel.append(el('div', 'pr-doc', t.document.content)) }
        const result = [...conversation!.posts].reverse().find((p) => p.kind === 'agent' && /result|report|done|completed/i.test(p.content))
        if (result) { detailPanel.append(el('h3', '', `LATEST REPORT · ${clock(result.at)} by ${result.by}`)); detailPanel.append(el('div', 'pr-doc', result.content)) }
        return
      }
      detailPanel.append(el('h2', '', conversation?.kind === 'setup' ? 'SETUP' : conversation?.kind === 'plan' ? 'PLAN WITHOUT A RECORD' : 'CONVERSATION'))
      if (talkError) detailPanel.append(el('p', 'pr-gap', `⚠ ${talkError}`))
      if (conversation) {
        detailPanel.append(el('p', 'pr-note', conversation.note))
        detailPanel.append(linksBlock([], conversation.zulip_url))
        const first = conversation.posts[0]
        if (first) { detailPanel.append(el('h3', '', `REQUEST · ${clock(first.at)} by ${first.by}`)); detailPanel.append(el('div', 'pr-doc', first.content)) }
      } else if (!talkError) detailPanel.append(el('p', 'pr-empty', 'reading…'))
    })
  }

  function avatarFor(post: TalkDetail['conversation']['posts'][number]) {
    const box = el('span', `pr-avatar${post.kind === 'human' ? ' human' : ''}`)
    if (post.kind === 'human') { box.textContent = '👤'; return box }
    const character = FrontDeskSettings.forSpeaker(scene.settings.activeManifest, post.agent, post.speaker)
    if (character?.face) { const img = document.createElement('img'); img.src = `${(import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? 'http://localhost:8094'}${character.face}`; img.alt = character.name; box.append(img) }
    else box.textContent = '?'
    return box
  }

  function renderTalk(force = false) {
    const conversation = talk?.conversation
    const signature = JSON.stringify([refKey(ref), conversation?.posts.map((p) => [p.message_id, p.content]), conversation?.status, conversation?.destination, talkError, talk?.health.state])
    if (!force && signature === signatures.talk) { renderComposer(); return }
    signatures.talk = signature
    const atBottom = posts.scrollHeight - posts.scrollTop - posts.clientHeight < 40
    if (!ref) {
      talkTitle.textContent = 'CONVERSATION'
      dest.textContent = 'select a plan, a run, a setup or a document above'
      posts.replaceChildren(el('p', 'pr-empty', 'The selected conversation is read here, as written, and your comment goes into it as the Developer.'))
      renderComposer(); placeComposer(); return
    }
    if (!conversation) {
      talkTitle.textContent = 'CONVERSATION'
      dest.textContent = talkError ? `⚠ ${talkError}` : 'reading…'
      if (talkError) posts.replaceChildren(el('p', 'pr-empty', `⚠ UNKNOWN — ${talkError}; last known history, if any, is above`))
      renderComposer(); placeComposer(); return
    }
    const d = conversation.destination
    talkTitle.textContent = d.role === 'planning' ? 'PLANNING CONVERSATION' : d.role === 'execution' ? 'EXECUTION CONVERSATION' : 'DOCUMENT'
    talkTitle.append(el('small', '', `${conversation.status.state}${conversation.status.stale_state ? ` (last ${conversation.status.stale_state})` : ''} — ${conversation.status.evidence}`))
    dest.textContent = `${d.label}${d.resolved ? ' · ✔ resolved' : ''}${talk?.health.state !== 'live' ? ` · ⚠ relay ${talk?.health.state}: ${talk?.health.reason}` : ''}`
    posts.replaceChildren()
    if (!conversation.posts.length) posts.append(el('p', 'pr-empty', 'nothing has been said here yet'))
    for (const post of conversation.posts) {
      if (post.kind === 'ack') { posts.append(el('p', 'pr-post ack', `· ${post.by} received it · ${clock(post.at)}`)); continue }
      const row = el('div', 'pr-post')
      const body = el('div')
      body.append(el('div', `pr-who${post.kind === 'agent' ? ' agent' : ''}`, `${post.speaker} · ${clock(post.at)}${post.edited ? ' · edited' : ''}`), el('div', 'pr-body', post.content))
      row.append(avatarFor(post), body)
      posts.append(row)
    }
    if (atBottom || force) posts.scrollTop = posts.scrollHeight
    renderComposer()
    placeComposer()
  }

  function renderComposer() {
    const conversation = talk?.conversation
    const postable = Boolean(ref) && (conversation?.destination.postable ?? true) && !talkError
    composer.style.display = ref && conversation && !conversation.destination.postable ? 'none' : 'flex'
    keys.setDisabled(!postable || sending || (talk ? !talk.chat.configured : false))
    keys.setPlaceholder(!ref ? '' : !conversation ? 'reading…' : !conversation.destination.postable ? 'a document is not posted into'
      : !talk!.chat.configured ? (talk!.chat.reason ?? 'the relay cannot post') : conversation.destination.resolved ? 'this conversation carries ✔ — a post resumes it (asked once more)'
      : d(conversation.destination.role))
    sendButton.disabled = !postable || sending || draft.trim() === ''
    sendButton.textContent = sending ? 'sending…' : draft.trim() ? `Send ⏎ · ${draft.length}${talk?.chat.max_chars ? `/${talk.chat.max_chars}` : ''} · buys a run` : 'Send ⏎ · buys a run'
    resumeButton.style.display = send.kind === 'resume' ? 'inline-block' : 'none'
    const status = sendStatus
    status.className = 'pr-send-status dim'
    if (send.kind === 'sending') status.textContent = 'sending as the Developer…'
    else if (send.kind === 'resume') { status.className = 'pr-send-status warn'; status.textContent = `↩ ${send.error} — press "resume and post" to do that on purpose; the draft is kept` }
    else if (send.kind === 'failed') { status.className = 'pr-send-status bad'; status.textContent = `✗ ${send.text} — the draft is kept` }
    else if (send.kind === 'uncertain') { status.className = 'pr-send-status warn'; status.textContent = `? ${send.text} — the draft is kept; check the history before sending again` }
    else if (send.kind === 'sent') { status.className = 'pr-send-status live'; status.textContent = send.resumed ? '↩ resumed this conversation and posted; the work it recorded stays as it is' : '✓ posted; the answer lands here when autolab serves it' }
    else if (conversation && !conversation.destination.postable) { status.textContent = conversation.note }
    else if (conversation) status.textContent = conversation.note
    else status.textContent = ''
    function d(role: string) { return role === 'planning' ? 'Comment on this plan (autolab reads it here)…' : 'Comment in this run (autolab reads it here)…' }
  }

  function renderSpeaker() {
    const manifest = scene.settings.activeManifest
    const conversation = talk?.conversation
    if (!conversation) { scene.setSpeaker({ character: FrontDeskSettings.front(manifest), label: FrontDeskSettings.front(manifest)?.name ?? 'Front', sub: ref ? 'reading…' : 'pick a conversation' }); return }
    const who = conversation.destination.responsible[0]
    if (conversation.destination.role === 'none' || !who) {
      const front = FrontDeskSettings.front(manifest)
      scene.setSpeaker({ character: front, label: front?.name ?? 'Front', sub: 'take a document to Front' })
      return
    }
    const character = FrontDeskSettings.forSpeaker(manifest, who.agent, who.instance)
    scene.setSpeaker({ character, label: character ? `${character.name}${character.nickname ? `（${character.nickname}）` : ''}` : who.instance, sub: `${who.instance} answers here` })
  }

  // --- go ------------------------------------------------------------------------------
  renderProjects(); renderTree(); renderDetail(); renderTalk(); renderHealth()
  keys.set(ref ? drafts.get(refKey(ref)) : '')
  draft = keys.value()
  void refreshAll()
  window.setInterval(() => void refreshTalk(), CONVERSATION_MS)
  window.setInterval(() => { void refreshBoard(); void refreshProject() }, BOARD_MS)
  window.setInterval(placeComposer, 1000)
  // The fixture driver reads a few facts back through this.
  ;(window as unknown as { __projectRoom: unknown }).__projectRoom = {
    state: () => ({ projectKey, ref, refRole, send: send.kind, draft, posts: talk?.conversation.posts.length ?? null, status: talk?.conversation.status.state ?? null, dest: talk?.conversation.destination.label ?? null, health: health.textContent }),
    select: (key: string) => selectProject(key),
    open: (next: ConversationRef, role: 'plan' | 'run' | 'topic') => selectConversation(next, role),
    rows: () => [...treePanel.querySelectorAll<HTMLButtonElement>('.pr-row')].map((r) => r.querySelector('.pr-name')?.textContent ?? ''),
    projects: () => [...projectsPanel.querySelectorAll<HTMLButtonElement>('.pr-row')].map((r) => r.querySelector('.pr-name')?.textContent ?? ''),
    click: (text: string) => { const found = [...root.querySelectorAll<HTMLButtonElement>('.pr-row')].find((r) => (r.textContent ?? '').includes(text)); found?.click(); return Boolean(found) },
  }
}
