// The Project Room with no relay behind it (`?view=project&demo=1`).
//
// A fixture in the shape the relay's read model returns, so the screen can
// be looked at and driven with nothing running: a setup-only project fresh
// from an argue, a study with a research plan and no mission, a study with
// several missions and runs in every state — one replaced and renamed aside,
// one resolved without a recorded end, one with an archived work channel —
// and an archived legacy project. Posting answers with an ack and a reply a
// moment later; one target fails once (uncertain); a ✔'d target asks for a
// resume. Nothing here reaches the realm.

import type {
  ConversationKind, MissionRow, PostResult, ProjectBoard, ProjectDetail, ProjectRow, ProjectSource, SetupRow, TalkDetail,
  TalkPost, TaskRow,
} from './projectState'

const NOW = () => Date.now() / 1000
const AUTOLAB = { instance: 'autolab-demo1', agent: 'autolab', bot: 'autolab-demo1', bot_id: 11 }
const HEALTH = { state: 'live', reason: 'demo source, nothing here reaches the realm' }

interface Conv { posts: TalkPost[]; resolved: boolean }

export function demoSource(): ProjectSource {
  let next = 8000
  const convs = new Map<string, Conv>()
  const conv = (key: string, seed: TalkPost[] = [], resolved = false): Conv => {
    let found = convs.get(key)
    if (!found) { found = { posts: seed, resolved }; convs.set(key, found) }
    return found
  }
  const post = (by: string, sender_id: number, kind: TalkPost['kind'], content: string, ago = 0, agent: string | null = null): TalkPost => ({
    message_id: next++, at: NOW() - ago, by, sender_id, kind, agent, speaker: by, content,
  })
  const human = (text: string, ago = 0) => post('Developer', 8, 'human', text, ago)
  const front = (text: string, ago = 0) => post('Front', 15, 'agent', text, ago, 'front')
  const lab = (text: string, ago = 0) => post('autolab-demo1', 11, 'agent', text, ago, 'autolab')
  const ack = (ago = 0) => post('autolab-demo1', 11, 'ack', 'Message received. Please wait for the reply.', ago, 'autolab')

  // Anchors for the recorded work.
  const M1 = 6770, M2 = 6371, M2R = 6400, M3 = 6900, T1 = 6773, T2 = 6777, T3 = 6781, T4 = 6785, T2R = 6405
  const last = (c: Conv) => { const p = c.posts[c.posts.length - 1]; return p ? { message_id: p.message_id, at: p.at, by: p.by } : null }

  // --- the conversations ---------------------------------------------------------------
  conv('topic:170/goal', [front('# Desk grow box\n\n## Final goal\n\nBuild a small, always-on, cheap, 3D-printed desktop box that grows edible sprouts unattended, from seed to harvest, using off-the-shelf parts. "Done" is one such box on the desk that has produced a *second* unattended harvest.\n\n## Why this is the goal\n\nThis is the human\'s own desire, recorded in argue `argue-desk-garden`.\n\n---\nOpened from argue **#argue › argue-desk-garden**.', 86400)])
  conv('topic:170/workplan-setup-desk-garden', [
    front('Please prepare the workspace for the project `desk-garden` — **setup only, no research and no development, and no mission to plan**: reply when the folders and repositories exist.', 86000),
    ack(85990),
    lab('@**Front**\n\nSetup is done. `main/` — repository `autodev/desk-garden` (`http://git.demo.invalid:3000/autodev/desk-garden.git`), with `GOAL.md` committed and pushed. `README_PROJECT.md` names this channel, the `goal` topic and the argue.', 85900),
  ])
  conv('topic:172/researchplan-worldtrend', [front('# worldtrend — Round 1: 測定枠組みの発見\n\n## この study が答えようとしている問い\n\n技術革新が続く一方で、政治・社会・環境の面では世界が悪化しているように感じられる、という違和感を検証する。\n\n## Round 1 の範囲\n\n1. 対象領域と評価指標の候補を列挙する\n2. 時間地平を 1990 年以降に置く\n3. 「不合格」の基準を開発者と合意する\n\n---\nOpened from argue **#argue › argue-20260918-124701**.', 4000)])
  conv('topic:172/workplan-setup-worldtrend', [
    front('Please prepare the workspace for the study `worldtrend` — setup only, no mission to plan.', 3900),
    ack(3890),
  ])
  conv(`work:${M1}`, [
    human('**Mission: establish YuE2 as a mediagen subject — basic usage, and conditions that repeatedly produce usable music.**\n\nYuE2 is a just-released lyrics-to-song model. mediagen has no music subject yet.', 30000),
    ack(29990),
    lab('# Establish YuE2 as a mediagen subject\n\n`main/subjects/INDEX.md` has no music subject yet. This mission adds the first one, `subjects/yue2/`, following Gather → baseline → exploration → write-up.\n\n## Tasks\n\n1. Recon YuE2, download weights, attempt one generation\n2. Reproducibility: two generations at one seed\n3. Exploration: cfg_scale and cot\n4. Write-up in `subjects/yue2/tips.md`\n\nRepository: http://git.demo.invalid:3000/autodev/mediagen.git', 29900),
    lab('@**Developer**\n\nPlan and four tasks are written. Budget: up to 8 generations. Start task 1 in its run topic when you agree.', 29890),
    human('The mission is complete and I accept it. All four tasks are done, approved and committed. 5/5 tracks usable by ear.', 3600),
    ack(3590),
    lab('@**Developer**\n\nThe YuE2 mission (`m6770`) is finished, accepted, and committed. `subjects/yue2/tips.md` lists four follow-up candidates. Report: http://git.demo.invalid:3000/autodev/mediagen/src/branch/main/subjects/yue2/report.md', 3500),
  ], true)
  conv(`work:${T1}`, [
    lab('# Recon YuE2, download weights, attempt one generation\n\nRead the upstream docs and record what they say about how a song is asked for.', 29800),
    human('Start task 1. The budget and the shape in your plan are approved as written.', 29000),
    ack(28990),
    lab('Recon done, weights download + one feasibility generation submitted as a single job, handed off to the observer. Ending this serving now.', 28800),
    lab('**Feasibility result**: the job succeeded outright, first attempt. Wall time 146.9 s. Output `feasibility_00001.flac`, 37.7 s.', 28000),
    human('Task 1 is done — I agree it is complete. Commit and push.', 27000),
    ack(26990),
    lab('## Result\n\nStatus: **done, approved by developer, committed and pushed.** Report: http://git.demo.invalid:3000/autodev/mediagen-gentest-YuE2/src/branch/main/report.md', 26900),
  ], true)
  conv(`work:${T2}`, [lab('# Reproducibility: two generations at one seed\n\nSame prompt, seed 424242, twice.', 26000), human('Start task 2.', 20000), ack(19990), lab('Both runs produced byte-identical FLACs. Completed.', 19000)], true)
  conv(`work:${T3}`, [lab('# Exploration: cfg_scale and cot\n\nSix generations at most.', 18000), human('Start task 3.', 15000), ack(14990), lab('Done: cfg 3.0 at seed 909090 is noticeably higher-energy. Completed.', 12000)], true)
  conv(`work:${T4}`, [lab('# Write-up\n\n`subjects/yue2/tips.md`.', 11000), human('Start task 4.', 8000), ack(7990), lab('Written and pushed. Completed.', 5000)], true)
  conv(`work:${M2}`, [
    front('Requesting one mission for the studyuspolitics project, per the study-uspolitics routine\'s guide.', 90000),
    ack(89990),
    lab('# Collect and analyze congressional political-contribution data — first study\n\nA deliberately narrow first pass.', 89900),
    human('Developer here. **Scrap this plan entirely and re-ask the mission.** Please retire m6371 rather than correcting it in place.', 88000),
    ack(87990),
    lab('Retired. This conversation is renamed aside; the replacement takes the name.', 87900),
  ], true)
  conv(`work:${M2R}`, [
    lab('@**Developer**\n\n# Replacing mission m6371\n\nThe previous plan for this request is retired; this topic is now mission m6400.', 87800),
    lab('# Collect and analyze congressional political-contribution data — first study (replacement)\n\n## What carries forward\n\nThe mission itself is unchanged.', 87790),
    human('Task 1 of m6400 is complete and I have verified it independently against the raw bulk file.', 80000),
    ack(79990),
    lab('@**Developer**\n\nMission m6400 is complete — task 1 finished, verified by the developer.', 79900),
  ], true)
  conv(`work:${T2R}`, [lab('# Collect one slice\n\nFEC bulk file, 2026 Senate.', 87700), human('Start.', 86000), ack(85990), lab('35 candidates matched. Completed.', 81000)], true)
  conv(`work:${M3}`, [
    human('**Mission:** next slice — itemized individual-donor geography for the 2026 Senate slice.', 7200),
    ack(7190),
    lab('# Next slice: itemized individual-donor geography\n\n## Steps\n\n1. Pull itemized contributions\n2. Aggregate by state\n\nRepository: http://git.demo.invalid:3000/autodev/studyuspolitics.git', 7100),
    lab('@**Developer**\n\nPlan and one task are written; start it in its run topic.', 7090),
    human('Looks fine. One more thing: keep the employer field.', 1800),
  ])
  conv('topic:152/workplan-old-style', [human('Mission: an old-style ask, planned before the conversation became the record.', 400000), lab('Planned it the old way; the work is in Plane (gone now).', 399000)], true)

  // --- the projects ---------------------------------------------------------------------
  const cv = (key: string) => convs.get(key)!
  const convRow = (key: string, channel: string, topic: string, extra: Partial<MissionRow> = {}) => {
    const c = cv(key)
    const lastPost = last(c)
    const lastKind = c.posts[c.posts.length - 1]?.kind
    const reply = c.resolved ? { state: 'done', evidence: 'the topic carries ✔' }
      : lastKind === 'agent' ? { state: 'quiet', evidence: 'nobody owes a reply' }
      : lastKind === 'ack' ? { state: 'acked', instance: AUTOLAB.instance, short: 'ack posted, no answer yet' }
      : (NOW() - (lastPost?.at ?? NOW())) > 900 ? { state: 'stalled', instance: AUTOLAB.instance, short: `${Math.round((NOW() - (lastPost?.at ?? 0)) / 60)} min unanswered` }
      : { state: 'awaiting', instance: AUTOLAB.instance, short: `${Math.round((NOW() - (lastPost?.at ?? 0)) / 60)} min unanswered` }
    const links = c.posts.flatMap((p) => [...p.content.matchAll(/https?:\/\/[^\s<>)\]`'"]+/g)].map((m) => ({
      url: m[0], kind: (m[0].endsWith('.git') ? 'repository' : m[0].endsWith('.md') ? 'report' : 'other') as 'repository' | 'report' | 'other', message_id: p.message_id })))
    return {
      channel, topic, live_topic: c.resolved ? `✔ ${topic}` : topic, resolved: c.resolved, posts: c.posts.length, last_post: lastPost,
      read: { complete: true, note: null }, reply, origins: [], links, zulip_url: null, ...extra,
    }
  }
  const doc = (key: string, topic: string, document_kind: 'goal' | 'researchplan') => {
    const c = cv(key); const p = c.posts[c.posts.length - 1]
    const title = p.content.match(/^#\s+(.+)$/m)?.[1] ?? topic
    return { kind: 'document' as const, topic, document_kind, stem: document_kind === 'goal' ? null : topic.replace('researchplan-', ''),
      title, versions: c.posts.length, resolved: false, last_post: last(c),
      current: { message_id: p.message_id, at: p.at, by: p.by, title, content: p.content }, missions: [],
      note: 'a document: not executable work; discuss how to proceed with Front', reply: { state: 'quiet' }, links: [], read: { complete: true, note: null } }
  }
  const task = (anchor: number, mission: number, serial: number, channel: string, state: string, title: string): TaskRow => ({
    kind: 'task', anchor, label: `m${mission}#${serial}`, serial, mission, state, finished: state === 'completed' || state === 'accepted',
    replaces: null, by: AUTOLAB.bot, document: { message_id: anchor + 2, at: NOW() - 20000, by: AUTOLAB.bot, title, content: cv(`work:${anchor}`).posts[0].content },
    ...convRow(`work:${anchor}`, channel, `workrun-task${serial}-m${mission}`),
  } as TaskRow)
  const counts = (tasks: TaskRow[]) => {
    const live = tasks.filter((t) => t.state !== 'cancelled')
    return { total: tasks.length, live: live.length, finished: live.filter((t) => t.finished).length,
      completed: tasks.filter((t) => t.state === 'completed').length, accepted: tasks.filter((t) => t.state === 'accepted').length,
      cancelled: tasks.filter((t) => t.state === 'cancelled').length, open: live.filter((t) => !t.finished).length }
  }
  const mission = (anchor: number, channel: string, topic: string, work: string, tasks: TaskRow[], extra: Partial<MissionRow> = {}): MissionRow => {
    const c = cv(`work:${anchor}`)
    const planPost = c.posts.find((p) => p.kind === 'agent' && p.content.startsWith('# '))
    const gaps = [] as { kind: string; text: string }[]
    if (!tasks.length && extra.tasks_read?.complete !== false) gaps.push({ kind: 'no-task', text: 'no task is recorded for this mission' })
    if (c.resolved && (work === 'planned' || work === 'started')) gaps.push({ kind: 'resolved-unfinished', text: `the conversation carries ✔ while the recorded state is \`${work}\`: closed without a recorded end` })
    return {
      kind: 'mission', anchor, label: `m${anchor}`, setup: false, slug: channel.replace('pj-', ''), by: AUTOLAB.bot,
      work: { state: work, note: work === 'done' ? 'marked done by whoever accepted it' : 'recorded by autolab; `started` does not prove a process is running' },
      task_counts: counts(tasks), tasks_read: { complete: true, channel: `work-m${anchor}`, note: null }, tasks,
      replaces: null, replaced_by: null, gaps,
      document: planPost ? { message_id: planPost.message_id, at: planPost.at, by: planPost.by, title: planPost.content.match(/^#\s+(.+)$/m)?.[1] ?? '', content: planPost.content } : null,
      title: planPost?.content.match(/^#\s+(.+)$/m)?.[1] ?? '',
      ...convRow(`work:${anchor}`, channel, topic),
      ...extra,
    } as MissionRow
  }
  const setup = (key: string, channel: string, topic: string): SetupRow => ({ kind: 'setup', ...convRow(key, channel, topic),
    note: 'workspace preparation: autolab replies when the folders exist and plans no mission' } as SetupRow)

  const projects = (): ProjectRow[] => {
    const garden: ProjectRow = {
      key: '170', stream_id: 170, channel: 'pj-desk-garden', slug: 'desk-garden', folder_id: 19, archived: false, kind: 'project',
      description: '[AUTO] project: desk-garden; project; opened from argue argue/argue-desk-garden',
      origin: { channel: 'argue', topic: 'argue-desk-garden', anchor: 7149 }, zulip_url: null,
      counts: { documents: 1, setups: 1, missions: 0, open_missions: 0, plans_unrecorded: 0, orphan_tasks: 0, tasks: 0, tasks_finished: 0, other_topics: 0, missions_by_state: {} },
      tasks_read: { complete: true, incomplete_missions: [] }, latest: null, reply: { state: 'quiet' },
      gaps: [{ kind: 'setup-only', text: 'setup only: the workspace was prepared and no mission has been asked for' }],
      documents: [doc('topic:170/goal', 'goal', 'goal')], setups: [setup('topic:170/workplan-setup-desk-garden', 'pj-desk-garden', 'workplan-setup-desk-garden')], missions: [], plans: [],
    }
    const trend: ProjectRow = {
      key: '172', stream_id: 172, channel: 'pj-worldtrend', slug: 'worldtrend', folder_id: 20, archived: false, kind: 'study',
      description: '[AUTO] project: worldtrend; study; opened from argue argue/argue-20260918-124701',
      origin: { channel: 'argue', topic: 'argue-20260918-124701', anchor: 7217 }, zulip_url: null,
      counts: { documents: 1, setups: 1, missions: 0, open_missions: 0, plans_unrecorded: 0, orphan_tasks: 0, tasks: 0, tasks_finished: 0, other_topics: 0, missions_by_state: {} },
      tasks_read: { complete: true, incomplete_missions: [] }, latest: null, reply: { state: 'acked' },
      gaps: [{ kind: 'setup-only', text: 'setup only: the workspace was prepared and no mission has been asked for' }],
      documents: [doc('topic:172/researchplan-worldtrend', 'researchplan-worldtrend', 'researchplan')],
      setups: [setup('topic:172/workplan-setup-worldtrend', 'pj-worldtrend', 'workplan-setup-worldtrend')], missions: [], plans: [],
    }
    const m1 = mission(M1, 'pj-mediagen', 'workplan-yue2-music-study', 'done', [
      task(T1, M1, 1, 'work-m6770', 'completed', 'Recon YuE2, download weights, attempt one generation'),
      task(T2, M1, 2, 'work-m6770', 'completed', 'Reproducibility: two generations at one seed'),
      task(T3, M1, 3, 'work-m6770', 'accepted', 'Exploration: cfg_scale and cot'),
      task(T4, M1, 4, 'work-m6770', 'completed', 'Write-up'),
    ])
    const media: ProjectRow = {
      key: '93', stream_id: 93, channel: 'pj-mediagen', slug: 'mediagen', folder_id: 6, archived: false, kind: 'study',
      description: 'autolab project: mediagen (study pattern)', origin: null, zulip_url: null,
      counts: { documents: 0, setups: 0, missions: 1, open_missions: 0, plans_unrecorded: 0, orphan_tasks: 0, tasks: 4, tasks_finished: 4, other_topics: 0, missions_by_state: { done: 1 } },
      tasks_read: { complete: true, incomplete_missions: [] }, latest: null, reply: { state: 'done' },
      gaps: [{ kind: 'no-document', text: 'no goal or research plan document is posted' }],
      documents: [], setups: [], missions: [m1], plans: [],
    }
    const m2 = mission(M2, 'pj-studyuspolitics', `retired-workplan-collect-and-analyze-contributions-m${M2}`, 'replaced', [], { replaced_by: M2R, tasks_read: { complete: false, channel: `work-m${M2}`, note: 'the work channel is archived: its conversations are not mirrored, so tasks here may be missing' }, gaps: [{ kind: 'tasks-unknown', text: 'the work channel is archived: its conversations are not mirrored, so tasks here may be missing' }] })
    const m2r = mission(M2R, 'pj-studyuspolitics', 'workplan-collect-and-analyze-contributions', 'done', [task(T2R, M2R, 1, `work-m${M2R}`, 'completed', 'Collect one slice')], { replaces: M2 })
    const m3 = mission(M3, 'pj-studyuspolitics', 'workplan-next-uspolitics-slice', 'planned', [], { tasks_read: { complete: false, channel: `work-m${M3}`, note: 'no work channel of that name is in the realm: none opened yet, or it was deleted' }, gaps: [{ kind: 'tasks-unknown', text: 'no work channel of that name is in the realm: none opened yet, or it was deleted' }] })
    const pol: ProjectRow = {
      key: '152', stream_id: 152, channel: 'pj-studyuspolitics', slug: 'studyuspolitics', folder_id: 17, archived: false, kind: 'study',
      description: 'Study project: US federal political contributions.', origin: null, zulip_url: null,
      counts: { documents: 0, setups: 0, missions: 3, open_missions: 1, plans_unrecorded: 1, orphan_tasks: 0, tasks: 1, tasks_finished: 1, other_topics: 0, missions_by_state: { done: 1, planned: 1, replaced: 1 } },
      tasks_read: { complete: false, incomplete_missions: [`m${M2}`, `m${M3}`] }, latest: null, reply: { state: 'awaiting' },
      gaps: [{ kind: 'no-document', text: 'no goal or research plan document is posted' }],
      documents: [], setups: [], missions: [m2, m2r, m3],
      plans: [{ kind: 'plan', recorded: false, ...convRow('topic:152/workplan-old-style', 'pj-studyuspolitics', 'workplan-old-style'), note: 'a workplan- conversation with no `[mission]` note' } as SetupRow],
    }
    const ancient: ProjectRow = {
      key: '23', stream_id: 23, channel: 'pj-assetpipe1', slug: 'assetpipe1', folder_id: null, archived: true, kind: 'unknown',
      description: 'asset_pipeline1 p1 end-to-end check', origin: null, zulip_url: null,
      counts: { documents: 0, setups: 0, missions: 0, open_missions: 0, plans_unrecorded: 0, orphan_tasks: 0, tasks: 0, tasks_finished: 0, other_topics: 0, missions_by_state: {} },
      tasks_read: { complete: false, incomplete_missions: [] }, latest: null, reply: { state: 'unknown' },
      gaps: [{ kind: 'archived', text: 'the channel is archived: its conversations are not mirrored' }],
      documents: [], setups: [], missions: [], plans: [],
    }
    for (const project of [garden, trend, media, pol]) {
      const every = [...project.documents, ...project.setups, ...project.missions, ...project.plans, ...project.missions.flatMap((m) => m.tasks ?? [])]
      const newest = every.filter((c) => c.last_post).sort((a, b) => (b.last_post!.at - a.last_post!.at))[0]
      project.latest = newest ? { ...newest.last_post!, channel: newest.channel ?? project.channel, topic: newest.topic, kind: (newest as { kind?: string }).kind ?? 'topic' } : null
      const states = every.map((c) => c.reply?.state).filter(Boolean) as string[]
      const order = ['stalled', 'unknown', 'awaiting', 'acked', 'done', 'quiet']
      project.reply = { state: states.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? 'quiet' }
    }
    return [garden, trend, media, pol, ancient]
  }

  const locate = (anchor: number): { kind: ConversationKind; projectKey: string; record: MissionRow | TaskRow; role: 'planning' | 'execution' } | null => {
    for (const project of projects()) {
      for (const m of project.missions) {
        if (m.anchor === anchor) return { kind: 'mission', projectKey: project.key, record: m, role: 'planning' }
        for (const t of m.tasks ?? []) if (t.anchor === anchor) return { kind: 'task', projectKey: project.key, record: t, role: 'execution' }
      }
    }
    return null
  }
  const talk = (kind: ConversationKind, key: string, c: Conv, channel: string, topic: string, role: 'planning' | 'execution' | 'none', projectKey: string, record: MissionRow | TaskRow | null): TalkDetail => {
    const lastPost = c.posts[c.posts.length - 1]
    const status = c.resolved ? { state: 'done', since: lastPost?.at ?? null, evidence: 'the topic carries ✔' }
      : !lastPost ? { state: 'quiet', since: null, evidence: 'no real post' }
      : lastPost.kind === 'ack' ? { state: 'received', since: lastPost.at, evidence: `${lastPost.by}'s ack is the newest post` }
      : lastPost.agent === 'autolab' ? { state: 'answered', since: lastPost.at, evidence: `${lastPost.by}'s post is the newest` }
      : role === 'none' ? { state: 'quiet', since: lastPost.at, evidence: 'nobody serves a document' }
      : { state: 'waiting', since: lastPost.at, evidence: `${lastPost.by}'s post is the newest and no serving agent has picked it up` }
    const project = projects().find((p) => p.key === projectKey)!
    return {
      schema: 'ag.projecttalk.v1', generated_at: NOW(), health: HEALTH, chat: { configured: true, reason: null, max_chars: 4000 },
      conversation: {
        kind, anchor: key.startsWith('work:') ? Number(key.slice(5)) : null,
        project: { key: project.key, channel: project.channel, slug: project.slug, kind: project.kind, origin: project.origin },
        record, destination: {
          channel, topic, live_topic: c.resolved ? `✔ ${topic}` : topic, resolved: c.resolved, role,
          responsible: role === 'none' ? [] : [AUTOLAB],
          label: `#${channel} › ${topic} — ${role === 'planning' ? 'the planning conversation, answered by autolab-demo1' : role === 'execution' ? 'the execution conversation, answered by autolab-demo1' : 'a document topic, which nobody serves'}`,
          postable: role !== 'none',
        },
        posts: [...c.posts], status, zulip_url: null,
        front: role === 'none' ? { desk: '/?view=frontdesk&demo=1', argue: project.origin?.anchor ? `/?view=argue&demo=1` : null, note: 'a document dispatches nothing; ask Front how to proceed' } : null,
        note: role === 'none' ? 'this is a document: reading it starts nothing, and nothing is posted here' : 'posting here is a comment in the conversation autolab serves: it buys a run',
      },
    }
  }
  const topicOf = (key: string, topic: string) => {
    const project = projects().find((p) => p.key === key || p.channel === key || p.slug === key)
    if (!project) return null
    const c = convs.get(`topic:${project.key}/${topic}`)
    if (!c) return null
    const kind: ConversationKind = topic === 'goal' || topic.startsWith('researchplan-') ? 'document' : topic.startsWith('workplan-setup-') ? 'setup' : 'plan'
    return { project, c, kind }
  }
  const answer = (c: Conv) => {
    window.setTimeout(() => {
      c.posts.push(ack())
      window.setTimeout(() => c.posts.push(lab('Noted (demo). I read the comment in this conversation and will carry it into the next serving.')), 2500)
    }, 800)
  }
  let failedOnce = false
  const send = (c: Conv, text: string, resume: boolean, anchor: number | null, channel: string, topic: string): PostResult => {
    if (c.resolved && !resume) {
      return { sent: false, needs_resume: true, resolved: true, error: `#${channel} › ✔ ${topic} carries ✔: a post would resume it and buy a run; submit again with resume: true to do that on purpose` }
    }
    if (text.includes('fail once') && !failedOnce) {
      failedOnce = true
      return { sent: false, uncertain: true, error: 'ReadTimeout: the realm did not answer in time (demo)', note: `the post may have landed; read #${channel} › ${topic} before sending again` }
    }
    const resumed = c.resolved
    c.resolved = false
    c.posts.push(human(text))
    answer(c)
    return { sent: true, message_id: next - 1, resumed, key: anchor === null ? undefined : String(anchor), note: resumed ? 'the conversation is resumed and the comment is live' : 'the comment is live (demo)' }
  }

  return {
    async board(): Promise<ProjectBoard> {
      const rows = projects()
      return { schema: 'ag.projectroom.v1', generated_at: NOW(), health: HEALTH, stale: false, projects: rows,
        counts: { projects: rows.length, live: rows.filter((r) => !r.archived).length, archived: rows.filter((r) => r.archived).length } }
    },
    async project(key): Promise<ProjectDetail | { error: string }> {
      const found = projects().find((p) => p.key === key || p.channel === key || p.slug === key)
      if (!found) return { error: `no project channel is known as '${key}' (demo)` }
      return { schema: 'ag.projectroom.v1', generated_at: NOW(), health: HEALTH, stale: false, project: found }
    },
    async work(anchor) {
      const found = locate(anchor)
      if (!found) return { error: `no mission or task wears the anchor ${anchor} (demo)` }
      return talk(found.kind, `work:${anchor}`, cv(`work:${anchor}`), found.record.channel!, found.record.topic, found.role, found.projectKey, found.record)
    },
    async topic(key, topic) {
      const found = topicOf(key, topic)
      if (!found) return { error: `no conversation named '${topic}' in that project channel (demo)` }
      return talk(found.kind, `topic:${found.project.key}/${topic}`, found.c, found.project.channel, topic, found.kind === 'document' ? 'none' : 'planning', found.project.key, null)
    },
    async postWork(anchor, text, _token, resume) {
      const found = locate(anchor)
      if (!found) return { sent: false, error: `no mission or task wears the anchor ${anchor} (demo)` }
      return send(cv(`work:${anchor}`), text, resume, anchor, found.record.channel!, found.record.topic)
    },
    async postTopic(key, topic, text, _token, resume) {
      const found = topicOf(key, topic)
      if (!found) return { sent: false, error: `no conversation named '${topic}' (demo)` }
      if (found.kind === 'document') {
        return { sent: false, error: 'a document is not a conversation anybody serves: posting there would dispatch nothing. Ask Front how to proceed instead',
          front: { desk: '/?view=frontdesk&demo=1', argue: found.project.origin?.anchor ? '/?view=argue&demo=1' : null, note: 'a document dispatches nothing' } }
      }
      return send(found.c, text, resume, null, found.project.channel, topic)
    },
  }
}
