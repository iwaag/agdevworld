// Reading an attempt's IO in full (p10): what a cut message links to. The
// same entries and the same redaction as the IO channel's messages; never
// the raw log.
import { loadNotifyConfig, NotifyStore } from './notify.ts'
import { entryAt, ioConfig, Redactor } from './io.ts'
import type { ExecStore } from './exec.ts'
import { readRun } from './runs.ts'
import { runSpace } from './runspace.ts'
import { RequestError, type Workspace } from './workspace.ts'
import type { RunRef } from '../shared/run.ts'

export async function ioEntries(area: string, exec: ExecStore, ws: Workspace, ref: RunRef, attempt?: string, line?: number) {
  const rec = (await readRun(await runSpace(ws, ref), ref)).record
  if (!rec) throw new RequestError(409, 'the run cannot be read')
  const n = new NotifyStore({ area, registryFile: exec.ctx.registryFile, exec })
  try {
    const io = n.ioStatus(rec)
    if (!attempt) return { attempt: '', line: 0, entries: [], io }
    const a = exec.attemptRow(attempt)
    if (!a || a.workspace !== ws.shared.reg.id || a.workflow !== ref.workflow || a.run !== ref.run) throw new RequestError(404, `attempt ${attempt} is not an attempt of run ${ref.workflow}/${ref.run} on this host`)
    if (!a.log) throw new RequestError(404, `attempt ${attempt} kept no log`)
    if (!line || !Number.isInteger(line) || line < 1) throw new RequestError(400, 'line is a positive line number of the attempt\'s log')
    const cfg = loadNotifyConfig(area)
    const redact = await Redactor.from(cfg && !('problem' in cfg) ? ioConfig(cfg.io)?.secretFiles ?? [] : [])
    const entries = (await entryAt(a.log, line).catch(() => { throw new RequestError(404, `the log of attempt ${attempt} is not readable on this host`) }))
      .map(e => ({ line: e.line, kind: e.kind, head: redact.apply(e.head), ...(e.body !== undefined ? { body: redact.apply(e.body) } : {}) }))
    return { attempt, line, entries, io }
  } finally { n.close() }
}
