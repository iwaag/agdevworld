#!/usr/bin/env node
// slack-front: the Slack integration's service and its operations (README.md).
import { LogLevel, SocketModeClient } from '@slack/socket-mode'
import { Bridge, conversationId } from './bridge.ts'
import { ConfigError, loadConfig, type Config } from './config.ts'
import { plainForSlack } from './format.ts'
import { Slack } from './slack.ts'
import { Store, type OutRow } from './store.ts'
import { Wfe } from './wfe.ts'

const HELP = `slack-front <command> [--config <file>]   (agdevworld integrations/slack, README.md)

The Developer's Slack DM with the Front bot, carried to and from WFE's
conversations. Configuration: --config, else $SLACK_FRONT_CONFIG, else
./config.json (tokens stay in that ignored file).

run                         the service: Socket Mode connection, inbox → WFE, WFE → outbox → Slack,
                            reconciliation and backfill (one process per store)
check                       validate the configuration; auth.test, the Developer's DM, WFE reachability
status [--json]             connection, WFE, inbox/outbox counts, unresolved deliveries, last backfill
threads                     Slack threads and their WFE conversations (cursor, polling)
deliveries [--all]          outbox rows not sent (unknown, failed, queued); --all: the latest 50
resolve <id> --sent <ts> | --resend | --drop --note <why>
                            settle an unresolved delivery: it is in Slack at <ts>; send it again;
                            or give it up (recorded with the note)
inbox [--all]               inbox rows waiting or failed; --all: the latest 50
retry <inbox-id>            put a failed inbox row back in the queue (same WFE token: no duplicate)
backfill [--from <iso>]     read the DM history from --from (default: the last live moment) into
                            the inbox now (the running service processes it)
trial --text <t> [--conv <conv>]
                            an automated trial message: the bot posts it in the DM marked as a
                            trial, and WFE records it as the configured trialAuthor (never the
                            Developer), via slack-trial. Without --conv it starts a new thread
fault lose-next-response    the next successful post is treated as having no answer (tests
                            unknown-outcome reconciliation on the live service)
`

function args() {
  const a = process.argv.slice(2)
  const pos: string[] = [], opt = new Map<string, string | true>()
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = a[i + 1]; if (v !== undefined && !v.startsWith('--')) { opt.set(k, v); i++ } else opt.set(k, true) } else pos.push(a[i])
  }
  return { pos, opt, s: (k: string) => { const v = opt.get(k); return typeof v === 'string' ? v : undefined } }
}

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)

async function main(): Promise<number> {
  const { pos, opt, s } = args()
  const cmd = pos[0]
  if (!cmd || cmd === 'help' || opt.has('help')) { console.log(HELP); return 0 }
  let config: Config
  try { config = loadConfig(s('config') ?? process.env.SLACK_FRONT_CONFIG ?? 'config.json') } catch (e) {
    if (e instanceof ConfigError) { console.error(`configuration: ${e.message}`); return 2 }
    throw e
  }
  const store = new Store(config.store)
  const slack = new Slack(config.botToken)
  const bridge = new Bridge({ config, store, slack, wfe: new Wfe(config.wfe), log })
  try {
    switch (cmd) {
      case 'run': return await run(config, store, bridge)
      case 'check': {
        const who = await bridge.identify()
        const dm = await bridge.dm()
        const wfe = await fetch(new URL('api/conversations', config.wfe)).then(r => `HTTP ${r.status}`, e => `unreachable: ${(e as Error).message}`)
        console.log(`workspace ${who.team}; bot user ${who.botUser}; Developer ${config.developer}; DM ${dm}\nWFE ${config.wfe}: ${wfe}\nlinks: ${config.linkBase} (desk ${config.deskUrl})`)
        return 0
      }
      case 'status': {
        const st = status(store)
        if (opt.has('json')) console.log(JSON.stringify(st, null, 2))
        else {
          console.log(`Slack: ${st.connection} since ${st.since ?? '-'}; last live ${st.live ?? '-'}; service pid ${st.pid ?? '-'} (started ${st.started ?? '-'})`)
          console.log(`WFE: ${st.wfeError ?? 'ok'}; metadata identity: ${st.metadataOff ? `off (${st.metadataOff})` : 'on'}`)
          console.log(`inbox ${JSON.stringify(st.counts.inbox)}; outbox ${JSON.stringify(st.counts.outbox)}; threads ${st.counts.threads}`)
          console.log(`last backfill: ${st.backfill ?? '-'}`)
          for (const o of st.unresolved) console.log(`  unresolved #${o.id} ${o.state} ${o.key}: ${o.error ?? ''}`)
          for (const t of st.pollErrors) console.log(`  poll ${t.conv}: ${t.poll_error}`)
        }
        return 0
      }
      case 'threads': {
        for (const t of store.threads()) console.log(`${t.conv}  root ${t.root}  cursor ${t.cursor}  activity ${t.activity}  next poll ${new Date(t.next_poll).toISOString()}${t.poll_error ? `  (${t.poll_error})` : ''}`)
        return 0
      }
      case 'deliveries': {
        const rows = opt.has('all') ? store.all<OutRow>('SELECT * FROM outbox ORDER BY id DESC LIMIT 50') : store.outs(['unknown', 'failed', 'queued', 'sending'])
        for (const o of rows) console.log(`#${o.id} ${o.state.padEnd(9)} ${o.key}  tries ${o.tries} checks ${o.checks}${o.slack_ts ? ` ts ${o.slack_ts}` : ''}${o.error ? `  — ${o.error}` : ''}`)
        if (!rows.length) console.log('Nothing waiting or unresolved.')
        return 0
      }
      case 'resolve': {
        const id = Number(pos[1]); const o = store.out(id)
        if (!o) { console.error(`no outbox row ${pos[1]}`); return 1 }
        const note = s('note') ?? 'operator'
        if (s('sent')) { store.tx(() => { store.mark(id, 'sent', { slack_ts: s('sent'), error: `resolved: sent (${note})` }); if (o.conv && o.wfe_message !== null) store.mapPost(o.conv, o.wfe_message, o.channel, s('sent')!, 'bot') }) }
        else if (opt.has('resend')) store.mark(id, 'queued', { next_try: 0, error: `resolved: send again (${note})` })
        else if (opt.has('drop')) store.mark(id, 'dropped', { error: `resolved: dropped (${note})` })
        else { console.error('resolve needs --sent <ts>, --resend or --drop'); return 1 }
        console.log(`#${id}: ${store.out(id)!.state}`)
        return 0
      }
      case 'inbox': {
        const rows = opt.has('all') ? store.all<{ id: number; source: string; state: string; outcome: string | null; conv: string | null; error: string | null; tries: number }>('SELECT * FROM inbox ORDER BY id DESC LIMIT 50')
          : store.all<{ id: number; source: string; state: string; outcome: string | null; conv: string | null; error: string | null; tries: number }>('SELECT * FROM inbox WHERE state IN (\'queued\', \'failed\') ORDER BY id')
        for (const r of rows) console.log(`#${r.id} ${r.state.padEnd(8)} ${r.source}${r.conv ? ` → ${r.conv}` : ''}${r.outcome ? `  ${r.outcome}` : ''}${r.error ? `  — ${r.error} (tries ${r.tries})` : ''}`)
        if (!rows.length) console.log('Nothing waiting or failed.')
        return 0
      }
      case 'retry': {
        const n = Number(store.run('UPDATE inbox SET state = \'queued\', next_try = 0, error = NULL WHERE id = ? AND state = \'failed\'', Number(pos[1])).changes)
        console.log(n ? `#${pos[1]} queued again` : `#${pos[1]} is not a failed inbox row`)
        return n ? 0 : 1
      }
      case 'backfill': {
        await bridge.identify()
        const from = s('from') ? Date.parse(s('from')!) : undefined
        console.log(JSON.stringify(await bridge.backfill('operator', from)))
        return 0
      }
      case 'trial': {
        const text = s('text'); if (!text) { console.error('trial needs --text'); return 1 }
        const who = await bridge.identify()
        const dm = await bridge.dm()
        const conv = s('conv')
        const thread = conv ? store.threadOf(conv)?.root : undefined
        if (conv && !thread) { console.error(`${conv} has no Slack thread here`); return 1 }
        const shown = `🧪 *試験メッセージ*（${plainForSlack(config.trialAuthor)} が送信。開発者本人の発言ではありません）\n${plainForSlack(text)}`
        const posted = await slack.post({ channel: dm, thread: thread ?? '', text: shown, key: null })
        store.receive({ source: `trial:${who.team}:${dm}:${posted.ts}`, team: who.team, channel: dm, ts: posted.ts, thread: thread ?? null, user: null, origin: 'trial', raw: { team: who.team, trial: { text } } })
        console.log(`trial posted at ${posted.ts} in ${thread ? `thread ${thread} (${conv})` : `a new thread (${conversationId(posted.ts)})`}; the running service carries it to WFE`)
        return 0
      }
      case 'fault': {
        if (pos[1] !== 'lose-next-response') { console.error('fault lose-next-response'); return 1 }
        store.set('fault:lose-next-response', new Date().toISOString())
        console.log('the next successful post will be treated as unanswered')
        return 0
      }
    }
    console.error(`unknown command ${cmd}\n\n${HELP}`)
    return 1
  } finally { if (cmd !== 'run') store.close() }
}

function status(store: Store) {
  return {
    connection: store.get('slack:connection') ?? 'unknown', since: store.get('slack:connection-since'), live: (n => n ? new Date(Number(n)).toISOString() : null)(store.get('live:last')),
    pid: store.get('service:pid'), started: store.get('service:started'), wfeError: store.get('wfe:error'), metadataOff: store.get('slack:metadata-off'),
    counts: store.counts(), backfill: store.get('backfill:last'),
    unresolved: store.outs(['unknown', 'failed']).map(o => ({ id: o.id, state: o.state, key: o.key, error: o.error })),
    pollErrors: store.all<{ conv: string; poll_error: string }>('SELECT conv, poll_error FROM threads WHERE poll_error IS NOT NULL AND poll_error != \'not in WFE yet\''),
  }
}

async function run(config: Config, store: Store, bridge: Bridge): Promise<number> {
  const who = await bridge.identify()
  store.set('service:pid', String(process.pid))
  store.set('service:started', new Date().toISOString())
  const state = (s: string) => { store.set('slack:connection', s); store.set('slack:connection-since', new Date().toISOString()); log(`Slack ${s}`) }
  log(`slack-front: workspace ${who.team}, bot ${who.botUser}, Developer ${config.developer}, WFE ${config.wfe}, store ${config.store}`)
  const socket = new SocketModeClient({ appToken: config.appToken, logLevel: LogLevel.WARN })
  let live: ReturnType<typeof setInterval> | undefined
  socket.on('slack_event', async ({ ack, type, body, retry_num, retry_reason }: { ack: (r?: unknown) => Promise<void>; type: string; body: never; retry_num?: number; retry_reason?: string }) => {
    if (type !== 'events_api') { await ack(); return }
    let r: string
    try { r = bridge.receiveEnvelope(body, retry_num) } catch (e) {
      // Not acknowledged: Slack delivers it again.
      log(`event not stored, not acknowledged: ${(e as Error).message}`)
      return
    }
    await ack()
    if (retry_num) log(`event retry ${retry_num} (${retry_reason}): ${r}`)
    void bridge.tick()
  })
  socket.on('connected', () => {
    state('connected')
    store.set('live:last-connect', new Date().toISOString())
    bridge.backfill('reconnected').then(() => bridge.tick(), e => log(`backfill failed: ${(e as Error).message}`))
    clearInterval(live)
    live = setInterval(() => store.set('live:last', String(Date.now())), 30_000)
  })
  const down = (s: string) => () => { clearInterval(live); live = undefined; state(s) }
  socket.on('disconnected', down('disconnected'))
  socket.on('reconnecting', down('reconnecting'))
  state('connecting')
  await socket.start()
  const loop = setInterval(() => {
    void bridge.tick()
    if (live) void bridge.sweep().catch(e => log(`sweep failed: ${(e as Error).message}`))
  }, 1000)
  await new Promise<void>(resolve => {
    const stop = (sig: string) => { log(`${sig}: stopping`); resolve() }
    process.once('SIGTERM', () => stop('SIGTERM'))
    process.once('SIGINT', () => stop('SIGINT'))
  })
  clearInterval(loop); clearInterval(live)
  await socket.disconnect().catch(() => {})
  state('stopped')
  store.close()
  return 0
}

main().then(code => { process.exitCode = code }, e => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1 })
