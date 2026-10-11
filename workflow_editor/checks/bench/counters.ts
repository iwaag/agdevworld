// Preloaded into the service by checks/measure.ts (node --import). Counts Git
// subprocesses, file-system reads and SSE change events, and answers
// "stats" over the IPC channel with the counts and the process CPU time.
// Nothing in the service depends on it.
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { ServerResponse } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'

const counts: Record<string, number> = { git: 0, readFile: 0, readdir: 0, stat: 0, realpath: 0, sseChange: 0, sseOther: 0 }
const gitByCommand: Record<string, number> = {}

const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>
for (const name of ['readFile', 'readdir', 'stat', 'realpath']) {
  const orig = promises[name]
  promises[name] = function (this: unknown, ...a: unknown[]) { counts[name]++; return orig.apply(this, a) }
}
const execFile = childProcess.execFile as unknown as (...a: unknown[]) => unknown
;(childProcess as unknown as Record<string, unknown>).execFile = function (this: unknown, file: unknown, ...rest: unknown[]) {
  if (file === 'git') {
    counts.git++
    const args = (Array.isArray(rest[0]) ? rest[0] : []) as string[]
    let i = 0
    while (args[i] === '-c') i += 2
    const key = args[i] === 'config' || args[i] === 'submodule' ? `${args[i]} ${args[i + 1] ?? ''}` : String(args[i])
    gitByCommand[key] = (gitByCommand[key] ?? 0) + 1
  }
  return execFile.call(this, file, ...rest)
}
syncBuiltinESMExports()

const write = ServerResponse.prototype.write as (...a: unknown[]) => boolean
ServerResponse.prototype.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
  if (typeof chunk === 'string' && chunk.startsWith('event: ')) {
    if (chunk.startsWith('event: change')) counts.sseChange++
    else counts.sseOther++
  }
  return write.call(this, chunk, ...rest)
} as typeof ServerResponse.prototype.write

process.on('message', (m: unknown) => {
  if (m === 'stats') process.send?.({ counts: { ...counts }, gitByCommand: { ...gitByCommand }, cpu: process.cpuUsage(), rss: process.memoryUsage().rss })
})
