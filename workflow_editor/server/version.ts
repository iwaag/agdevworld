// Which code this process runs. An installed release carries RELEASE.json,
// written by agdevworld's scripts/wfe-release.sh: the agdevworld commit it was
// built from. A source checkout has none. The service (GET api/version) and
// the CLI (wfe version) report the same thing, so the browser, the API and the
// launcher can be traced to one commit.
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface Release { agdevworld: string; tree: string; built: string }
export interface CodeVersion { package: string; release: Release | null; source: 'release' | 'checkout' }

export function codeVersion(): CodeVersion {
  const pkg = realpathSync(PACKAGE_DIR)
  try {
    const release = JSON.parse(readFileSync(join(pkg, 'RELEASE.json'), 'utf8')) as Release
    return { package: pkg, release, source: 'release' }
  } catch { return { package: pkg, release: null, source: 'checkout' } }
}
