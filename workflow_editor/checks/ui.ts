// UI operations shared by browser checks: what a person does with the editor.
import { rename, writeFile } from 'node:fs/promises'
import type { Page } from 'playwright-core'

// Workflow settings (p8): opened explicitly, in the inspector column.
export async function openSettings(page: Page) {
  if (!(await page.getByLabel('New binding key').isVisible())) await page.getByRole('button', { name: 'Workflow settings' }).click()
}

// The intent is edited in the workflow's Context section (p13 ex1); the
// approvals stay behind Intent & approvals (p8). Opens both.
export async function openIntent(page: Page) {
  if (!(await page.getByLabel('Workflow intent').isVisible())) await page.locator('.ctx-section[data-context-scope="workflow"] .ctx-toggle').click()
  if (!(await page.getByRole('button', { name: 'Approve intent' }).isVisible())) await page.getByRole('button', { name: 'Intent & approvals' }).click()
}

// An inspector group (p8: Appearance, Repositories, Connections), opened if closed.
export async function openGroup(page: Page, group: string) {
  const g = page.locator(`.inspector .insp-group[data-group="${group}"]`)
  if (!(await g.evaluate(e => (e as HTMLDetailsElement).open))) await g.locator('summary').click()
}

export async function addBinding(page: Page, key: string, path: string, access: string) {
  await openSettings(page)
  await page.getByLabel('New binding key').fill(key)
  await page.getByLabel('New binding path').selectOption(path)
  await page.getByLabel('New binding access').selectOption(access)
  await page.locator('.add-binding button', { hasText: 'Add' }).click()
  await page.waitForSelector(`.binding-row[data-binding="${key}"]`)
}

export async function addNode(page: Page, type: string, name: string, description: string, repos: string[] = []): Promise<string> {
  await page.getByRole('button', { name: 'Add node', exact: true }).click() // the Add node menu (p8)
  await page.getByRole('menuitem', { name: `Add ${type} node` }).click()
  await page.getByLabel('Node name').fill(name)
  await page.getByLabel('Node description').fill(description)
  for (const r of repos) await page.getByLabel(`Bind ${r}`).check()
  return (await page.locator('.node.selected').getAttribute('data-id'))!
}

export async function fit(page: Page) {
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
}

export async function selectNode(page: Page, id: string) {
  await fit(page)
  await page.locator(`.node[data-id="${id}"]`).click()
}

export async function connectVia(page: Page, from: string, to: string) {
  await selectNode(page, from)
  await openGroup(page, 'connections')
  await page.getByLabel('Connect to node').selectOption(to)
  await page.locator('.inspector button', { hasText: 'Connect' }).click()
}

export async function connectDrag(page: Page, from: string, to: string) {
  await fit(page)
  const card = page.locator(`.node[data-id="${from}"]`)
  await card.hover()
  const port = await card.locator('.port').boundingBox()
  const target = await page.locator(`.node[data-id="${to}"]`).boundingBox()
  await page.mouse.move(port!.x + port!.width / 2, port!.y + port!.height / 2)
  await page.mouse.down()
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 8 })
  await page.mouse.up()
}

export async function dragNode(page: Page, id: string, dx: number, dy: number) {
  const box = await page.locator(`.node[data-id="${id}"]`).boundingBox()
  await page.mouse.move(box!.x + 40, box!.y + 20)
  await page.mouse.down()
  await page.mouse.move(box!.x + 40 + dx, box!.y + 20 + dy, { steps: 10 })
  await page.mouse.up()
}

export async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => /^Saved \d/.test(document.querySelector('.save-state')?.textContent ?? ''))
}

// An IDE-style save: write a sibling file and rename it over the target.
export async function ideSave(path: string, text: string) {
  await writeFile(`${path}.ide-swap`, text)
  await rename(`${path}.ide-swap`, path)
}

export function waitFor(fn: () => Promise<boolean>, label: string, ms = 6000): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now()
    const tick = async () => {
      if (await fn().catch(() => false)) return resolve(true)
      if (Date.now() - start > ms) { console.log(`    (timed out waiting: ${label})`); return resolve(false) }
      setTimeout(tick, 150)
    }
    void tick()
  })
}

export const pillStatus = (page: Page, kind: 'intent' | 'definition') =>
  page.locator(`.approval-pill[data-kind="${kind}"]`).getAttribute('data-status')
