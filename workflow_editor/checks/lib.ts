// Shared helpers for browser checks. They drive the real UI against the
// running service and the seeded fixture; screenshots go to ignored storage.
import { chromium, webkit, type Browser, type Page } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// WFE_FIXTURE and WFE_URL point the checks at a private seed and service.
export const FIXTURE = resolve(process.env.WFE_FIXTURE ?? join(here, '..', '..', '.local', 'wfe-fixture'))
export const SHOTS = join(FIXTURE, 'screenshots')
export const BASE = process.env.WFE_URL ?? 'http://127.0.0.1:5175'
export const wsDir = (id: string) => join(FIXTURE, 'workspaces', id)

// Checks written for the full screens open in Detail (p8/ex1): a fresh
// browser would start in Simple. `display: null` keeps the fresh default
// (checks/displayMode.ts). Only an unset preference is filled, so a check
// that switches keeps its choice across navigation.
export async function open(width = 1400, height = 900, opts: { display?: 'simple' | 'detail' | null } = {}): Promise<{ browser: Browser; page: Page; errors: string[] }> {
  await mkdir(SHOTS, { recursive: true })
  // WFE_BROWSER=webkit runs a check in Safari's engine (p8/ex2): the person
  // uses Safari, and Chromium hides Safari-only failures.
  const browser = await (process.env.WFE_BROWSER === 'webkit' ? webkit : chromium).launch()
  const page = await browser.newPage({ viewport: { width, height } })
  const display = opts.display === undefined ? 'detail' : opts.display
  if (display) await page.addInitScript(d => { try { if (!localStorage.getItem('workflow-editor.display')) localStorage.setItem('workflow-editor.display', d) } catch { /* storage unavailable: Simple */ } }, display)
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  page.on('dialog', d => void d.accept())
  return { browser, page, errors }
}

export async function shot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage })
}

let failures = 0
export function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`)
  else { failures++; console.log(`  ✖ ${label}`) }
}
export function done() {
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
  process.exitCode = failures ? 1 : 0
}
