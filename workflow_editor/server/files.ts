// File access bounded to registered workspace roots, and atomic saves.
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class BoundaryError extends Error {}

// Resolves a project-relative path inside `root` and refuses anything that
// leaves it, lexically or through a symlink of an existing parent.
export async function inside(root: string, rel: string): Promise<string> {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new BoundaryError(`path "${rel}" leaves the workspace`)
  const realRoot = await realpath(root)
  const target = resolve(realRoot, rel)
  if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new BoundaryError(`path "${rel}" leaves the workspace`)
  // Check the deepest existing ancestor through realpath.
  let probe = target
  for (;;) {
    try {
      const real = await realpath(probe)
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new BoundaryError(`path "${rel}" resolves outside the workspace`)
      break
    } catch (e) {
      if (e instanceof BoundaryError) throw e
      const up = dirname(probe)
      if (up === probe) break
      probe = up
    }
  }
  return target
}

export const relativeTo = (root: string, path: string) => relative(root, path).split(sep).join('/')

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

// Writes a temporary file next to the target, flushes it, and renames it over
// the target. Readers see the old or the new file, never a partial one. This
// is about integrity, not about simultaneous writers.
export async function atomicWrite(target: string, text: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID().slice(0, 8)}.tmp`)
  const fh = await open(tmp, 'wx')
  try {
    await fh.writeFile(text)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, target)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

// Creates a file only if it does not exist yet (used for new workflows).
export async function createExclusive(target: string, text: string): Promise<void> {
  const fh = await open(target, 'wx')
  try { await fh.writeFile(text); await fh.sync() } finally { await fh.close() }
}
