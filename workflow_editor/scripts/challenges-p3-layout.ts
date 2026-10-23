// The challenge repository's move to one directory per challenge (challenge
// p3, docs/challenges.md *The layout before challenge p3*): in a working
// clone, `challenges/<id>.md` becomes `challenges/<id>/summary.md` and
// `evidence/<id>/<f>` becomes `challenges/<id>/evidence/<f>`. Contents are
// kept; relative Markdown links that pointed at a moved file, or that a
// moved file wrote relative to its old place, are rewritten to the same
// target. Nothing is classified: old evidence stays at the challenge's level
// (no trial is invented). Idempotent: a clone already moved changes nothing.
//
//   node scripts/challenges-p3-layout.ts <clone> [--commit --by <actor>] [--readme <file>]
//
// Without --commit it moves and rewrites in the working tree and prints the
// plan; with it, one commit authored by the actor (trailers Challenge-Actor,
// Challenge-Request, Challenge-Via: migration). Pushing is the caller's.
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHALLENGE_ID } from '../server/challenges.ts'
import { gitOk } from '../server/git.ts'

export interface LayoutPlan { moves: [string, string][]; links: { file: string; from: string; to: string }[]; removed: string[]; orphans: string[] }

async function files(dir: string, rel = ''): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...await files(join(dir, e.name), r))
    else out.push(r)
  }
  return out.sort()
}

// Relative link targets in Markdown: [text](target "title"), ![alt](target), <img src="target">.
const LINK = /(\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))|(\bsrc=")([^"]+)(")/g
const external = (t: string) => /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(t)

export async function moveLayout(clone: string): Promise<LayoutPlan> {
  const plan: LayoutPlan = { moves: [], links: [], removed: [], orphans: [] }
  const records = (await readdir(join(clone, 'challenges')).catch(() => [] as string[])).filter(n => n.endsWith('.md') && CHALLENGE_ID.test(n.slice(0, -3)) && !existsSync(join(clone, 'challenges', n.slice(0, -3))))
  const ids = new Set(records.map(n => n.slice(0, -3)))
  const evidenceIds = (await readdir(join(clone, 'evidence'), { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory() && CHALLENGE_ID.test(e.name)).map(e => e.name)
  for (const id of evidenceIds) if (!ids.has(id)) plan.orphans.push(id)
  const moved = new Map<string, string>()
  for (const id of ids) moved.set(`challenges/${id}.md`, `challenges/${id}/summary.md`)
  for (const id of evidenceIds) for (const f of await files(join(clone, 'evidence', id))) moved.set(`evidence/${id}/${f}`, `challenges/${id}/evidence/${f}`)
  if (!moved.size) return plan
  // Every Markdown file the repository has, read before anything moves.
  const all = [...await files(clone)].filter(p => !p.startsWith('.git/') && p.endsWith('.md'))
  const texts = new Map(await Promise.all(all.map(async p => [p, await readFile(join(clone, p), 'utf8')] as const)))
  for (const [from, to] of moved) {
    await mkdir(dirname(join(clone, to)), { recursive: true })
    await gitOk(clone, ['mv', from, to])
    plan.moves.push([from, to])
  }
  for (const [old, text] of texts) {
    const now = moved.get(old) ?? old
    const fix = (target: string): string => {
      if (external(target)) return target
      const cut = target.search(/[#?]/)
      const [path, frag] = cut < 0 ? [target, ''] : [target.slice(0, cut), target.slice(cut)]
      if (!path) return target
      const was = posix.normalize(posix.join(posix.dirname(old), decodeURI(path)))
      const dest = moved.get(was) ?? was
      if (dest === was && now === old) return target
      let rel = posix.relative(posix.dirname(now), dest) || posix.basename(dest)
      if (!rel.startsWith('.') && !rel.includes('/') && path.startsWith('./')) rel = `./${rel}`
      const next = encodeURI(rel) + frag
      if (next !== target) plan.links.push({ file: now, from: target, to: next })
      return next
    }
    const out = text.replace(LINK, (_m, a, t, b, s1, t2, s2) => a ? `${a}${fix(t)}${b}` : `${s1}${fix(t2)}${s2}`)
    if (out !== text) await writeFile(join(clone, now), out)
  }
  for (const keep of ['evidence/.gitkeep', 'challenges/.gitkeep']) {
    if (!existsSync(join(clone, keep))) continue
    const rest = (await gitOk(clone, ['ls-files', '--', dirname(keep)])).split('\n').filter(n => n && n !== keep)
    if (keep.startsWith('evidence/') ? !rest.length : rest.length) { await gitOk(clone, ['rm', '-q', keep]); plan.removed.push(keep) }
  }
  if (existsSync(join(clone, 'evidence')) && !(await gitOk(clone, ['ls-files', '--', 'evidence'])).trim()) await rm(join(clone, 'evidence'), { recursive: true })
  return plan
}

async function main(argv: string[]) {
  const clone = argv[0]
  if (!clone || !existsSync(join(clone, '.git'))) { console.error('usage: challenges-p3-layout.ts <working clone> [--commit --by <actor>] [--readme <file>]'); return 2 }
  const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : undefined }
  const plan = await moveLayout(clone)
  const readme = opt('readme')
  if (readme && plan.moves.length) { await writeFile(join(clone, 'README.md'), await readFile(readme, 'utf8')); await gitOk(clone, ['add', 'README.md']) }
  console.log(JSON.stringify(plan, null, 2))
  if (!plan.moves.length) { console.log('Already in the directory layout: nothing to do.'); return 0 }
  if (argv.includes('--commit')) {
    const by = opt('by')
    if (!by) { console.error('--commit needs --by <actor>'); return 2 }
    await gitOk(clone, ['add', '-A'])
    const email = `${by.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}@agdev.invalid`
    await gitOk(clone, ['-c', `user.name=${by}`, '-c', `user.email=${email}`, 'commit', '-q',
      '-m', 'Move every challenge into its own directory (challenge p3)',
      '-m', 'challenges/<id>.md -> challenges/<id>/summary.md; evidence/<id>/<f> -> challenges/<id>/evidence/<f>; relative links rewritten to the same targets. Contents, ids and states are unchanged; the old evidence stays at each challenge\'s level (no trial is invented). Commits before this one read in the old layout.',
      '-m', `Challenge-Request: migration:challenge-p3-layout\nChallenge-Actor: ${by}\nChallenge-Via: migration`])
    console.log(`Committed ${(await gitOk(clone, ['rev-parse', 'HEAD'])).trim()}.`)
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)))
