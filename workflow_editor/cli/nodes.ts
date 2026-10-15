// `wfe nodes …`: the person's node catalog (p7/ex1, docs/catalog.md) from the
// command line — the same operations as the dashboard's "User nodes"
// (server/catalog.ts) — and instantiation of a template into a workflow or a
// draft of a run's definition.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EXAMPLES, TEMPLATE_TYPES, type NodeTemplate, type TemplateContent } from '../shared/catalog.ts'
import { APPEARANCE_COLORS, APPEARANCE_ICONS } from '../shared/model.ts'
import type { Workspace } from '../server/workspace.ts'

export interface NodesCli {
  positional: string[]
  opt: (k: string) => string | undefined
  opts: (k: string) => string[]
  area: () => string
  by: () => string | undefined // the registry's approver, when no --by is given
  workspace: () => Promise<Workspace>
  workflowFile: (ws: Workspace, name: string) => Promise<string>
  out: (human: string, data: unknown) => void
  usage: (m: string) => Error
  refused: (m: string, detail?: unknown) => Error
}

export const NODES_HELP = `wfe nodes <subcommand> …   (the person's node catalog; docs/catalog.md)

The catalog lists activities the person recognizes as distinct workflow
steps. Each template is a reusable node over an existing type. It states how
the person expects the activity to appear, and gives the copy to start from.
It does not add nodes by itself: whoever designs a workflow or adjusts a run
decides whether and where an activity becomes a node.

  list                       the templates (id, revision, type, name, expectation)
  show <id>                  one template in full
  create <id> --name <text> --type study|do|talk|delegate --description <text> --expectation <text>
             [--icon <token>] [--color <token>] [--target-project <id>] [--target-workflow <id>] [--accepts person|parent] [--by <name>]
  update <id> --expect-revision <n> [--name …] [--type …] [--description …]
             [--expectation …] [--icon …] [--color …] [--by <name>]
                             fields not given stay; --icon '' / --color '' clear
  delete <id> --expect-revision <n> [--by <name>]
  example [<example>] [--id <id>] [--by <name>]
                             without a name: the examples offered; with one:
                             add it as your own template, to edit
  instantiate <template> (--workflow <workflow> | --file <path>) [--run <run>]
             [--id <node id>] [--bind <binding key>]… [--after <node>]… [--before <node>]…

Fields of a template:
  name         the card label of nodes made from it
  type         ${TEMPLATE_TYPES.join(', ')}
  target       delegate templates only (p10): --target-project, --target-workflow
               and --accepts, copied into the node; any of them may be left to
               the workflow's author (wfe delegate help)
  description  for the agent PERFORMING the activity: what to do and record.
               It is copied into the node's description; the node then runs
               like any node of its type
  expectation  for the agent or person DESIGNING the workflow: how the person
               expects this activity to appear (as its own node, where).
               It stays with the node as provenance, not as instructions
  icon, color  display only: ${APPEARANCE_ICONS.join(' ')} / ${APPEARANCE_COLORS.join(' ')}
--description-file / --expectation-file read the text from a file.

Revisions: a template's revision goes up when its content changes. An update
or deletion names the revision it was based on (--expect-revision) and is
refused if the template changed meanwhile. Deleted ids are not reused.

Instantiation copies type, name, description and appearance into an ordinary
node and records template: {id, revision, expectation}. Editing the node
never changes the catalog, and editing the catalog never changes a workflow.
  --workflow <wf>  a workflow of this workspace (devdocs/workflows), saved
  --file <path>    any workflow YAML file, e.g. a draft of a run's definition
                   (wfe run revisions <run> --show r<n> > draft.yaml) that
                   wfe run adjust then applies
  --run <run>      take the template from that run's catalog snapshot (what
                   the run was given at creation) instead of the live catalog.
                   An agent performing a run uses this
  --id             the node id (default: the template id, made unique)
  --bind <key>     a binding the node uses; it must be declared by the
                   workflow (instantiation never adds access)
  --after/--before connect it; both together insert it between the two nodes
                   (their direct edge is removed)
A node made from a template keeps no link to the catalog: its provenance is
outside both approval digests and the compiled graph; its type, name,
description and repositories are ordinary definition content.

The catalog is <area>/node-catalog.json, beside the registry. A file that
cannot be read is reported and never replaced with defaults.`

const line = (t: Pick<NodeTemplate, 'id' | 'revision' | 'type' | 'name' | 'expectation'>) => `  ${t.id.padEnd(24)} r${String(t.revision).padEnd(3)} ${t.type.padEnd(6)} ${t.name}\n      expects: ${t.expectation.split('\n').join('\n               ')}`
export const full = (t: Pick<NodeTemplate, 'id' | 'revision' | 'type' | 'name' | 'expectation' | 'description' | 'appearance'> & Partial<Pick<NodeTemplate, 'updated' | 'by'>>) => [
  `${t.id} (revision ${t.revision}) — ${t.name}, type ${t.type}${t.appearance ? `, icon ${t.appearance.icon || '(type)'} color ${t.appearance.color || '(type)'}` : ''}`,
  ...(t.updated ? [`changed ${t.updated}${t.by ? ` by ${t.by}` : ''}`] : []),
  '', 'Expectation (for the workflow designer):', ...t.expectation.split('\n').map(l => `  ${l}`),
  '', 'Description (for the agent performing it; copied into the node):', ...t.description.split('\n').map(l => `  ${l}`),
].join('\n')

export async function nodesCommand(c: NodesCli): Promise<number> {
  const { addExample, createTemplate, deleteTemplate, instantiateIntoWorkflow, instantiateText, readCatalog, templateIn, updateTemplate } = await import('../server/catalog.ts')
  const [sub, arg] = c.positional
  const text = (k: string) => { const f = c.opt(`${k}-file`); return f !== undefined ? readFileSync(resolve(f), 'utf8') : c.opt(k) }
  const by = () => { const b = c.opt('by') ?? c.by(); if (!b?.trim()) throw c.usage('--by <name> is required: who makes the change'); return b }
  const rev = () => { const v = Number(c.opt('expect-revision')); if (!Number.isInteger(v) || v < 1) throw c.usage('--expect-revision <n> is required: the revision you read (wfe nodes show <id>)'); return v }
  const appearance = (base?: TemplateContent['appearance']) => {
    const icon = c.opt('icon') ?? base?.icon ?? '', color = c.opt('color') ?? base?.color ?? ''
    return icon || color ? { appearance: { icon, color } } : {}
  }
  // A delegate template's target (p10): given fields replace, '' clears one.
  const target = (base?: TemplateContent['target']) => {
    const g = { project: c.opt('target-project') ?? base?.project ?? '', workflow: c.opt('target-workflow') ?? base?.workflow ?? '', accepts: c.opt('accepts') ?? base?.accepts ?? '' }
    const kept = Object.fromEntries(Object.entries(g).filter(([, v]) => v))
    return Object.keys(kept).length ? { target: kept } : {}
  }
  const live = async () => {
    const r = await readCatalog(c.area())
    if (r.state !== 'ok') throw c.refused(`the node catalog is unavailable: ${r.problem}`)
    return r
  }
  switch (sub ?? 'list') {
    case 'help': console.log(NODES_HELP); return 0
    case 'list': {
      const r = await live()
      const head = r.initializedNow ? `Created ${r.file} with the presets present and cleanup as your templates.\n` : ''
      c.out(r.catalog.templates.length ? `${head}${r.catalog.templates.map(line).join('\n')}` : `${head}The catalog has no templates (${r.file}). Add one with wfe nodes create, or an example (wfe nodes example).`, { state: r.state, file: r.file, generation: r.catalog.generation, templates: r.catalog.templates })
      return 0
    }
    case 'show': {
      if (!arg) throw c.usage('show <id>')
      const t = templateIn((await live()).catalog, arg)
      c.out(full(t), t)
      return 0
    }
    case 'create': {
      if (!arg) throw c.usage('create <id> --name … --type … --description … --expectation …')
      const r = await createTemplate(c.area(), arg, { name: c.opt('name') ?? '', type: c.opt('type') ?? '', description: text('description') ?? '', expectation: text('expectation') ?? '', ...appearance(), ...target() }, by())
      c.out(`Created template ${r.template.id} (revision 1).`, { ok: true, template: r.template })
      return 0
    }
    case 'update': {
      if (!arg) throw c.usage('update <id> --expect-revision <n> …')
      const cur = templateIn((await live()).catalog, arg)
      const r = await updateTemplate(c.area(), arg, { name: c.opt('name') ?? cur.name, type: c.opt('type') ?? cur.type, description: text('description') ?? cur.description, expectation: text('expectation') ?? cur.expectation, ...appearance(cur.appearance), ...target(cur.target) }, rev(), by())
      c.out(r.changed ? `Template ${arg} is now revision ${r.template.revision}.` : `Nothing changed; template ${arg} stays at revision ${r.template.revision}.`, { ok: true, changed: r.changed, template: r.template })
      return 0
    }
    case 'delete': {
      if (!arg) throw c.usage('delete <id> --expect-revision <n>')
      await deleteTemplate(c.area(), arg, rev(), by())
      c.out(`Deleted template ${arg}. Nodes made from it keep their content and provenance; the id is not reused.`, { ok: true })
      return 0
    }
    case 'example': {
      if (!arg) {
        c.out(Object.entries(EXAMPLES).map(([id, e]) => full({ id, revision: 0, ...e }).replace(' (revision 0)', ' (example)')).join('\n\n'), { examples: EXAMPLES })
        return 0
      }
      const r = await addExample(c.area(), arg, by(), c.opt('id'))
      c.out(`Added ${r.template.id} from the example. It is your template now: edit it to say what you expect (wfe nodes update ${r.template.id} --expect-revision 1 …).`, { ok: true, template: r.template })
      return 0
    }
    case 'instantiate': {
      if (!arg) throw c.usage('instantiate <template> (--workflow <wf> | --file <path>) …')
      const o = { id: c.opt('id'), repositories: c.opts('bind'), after: c.opts('after'), before: c.opts('before') }
      const wf = c.opt('workflow'), file = c.opt('file'), runArg = c.opt('run')
      if (!!wf === !!file) throw c.usage('instantiate takes --workflow <workflow> or --file <path>')
      let template: Parameters<typeof instantiateText>[1]
      if (runArg) {
        const ws = await c.workspace()
        const { resolveRef, runCatalog } = await import('../server/runs.ts')
        const rc = await runCatalog(ws, await resolveRef(ws, runArg))
        if (rc.state !== 'supplied') throw c.refused(rc.state === 'none' ? `run ${runArg} was given no node catalog (created before p7/ex1)` : `run ${runArg}'s catalog was unavailable when it was created: ${rc.problem}`)
        const t = rc.snapshot.templates.find(x => x.id === arg)
        if (!t) throw c.refused(`run ${runArg}'s catalog snapshot has no template "${arg}" (wfe run nodes ${runArg})`)
        template = t
      } else template = templateIn((await live()).catalog, arg)
      if (file) {
        const path = resolve(file)
        const r = instantiateText(readFileSync(path, 'utf8'), template, o)
        writeFileSync(path, r.text)
        c.out(`Added node ${r.node} from template ${arg} (revision ${template.revision}) to ${file}.`, { ok: true, node: r.node, file: path, template: { id: arg, revision: template.revision } })
        return 0
      }
      if (runArg) throw c.usage('--run takes the template from a run; it goes into a draft --file of that run\'s definition, not into a project workflow')
      const ws = await c.workspace()
      const r = await instantiateIntoWorkflow(c.area(), ws, await c.workflowFile(ws, wf!), arg, o)
      c.out(`Added node ${r.node} from template ${arg} (revision ${r.template.revision}) to devdocs/workflows/${r.file}. Saved, not committed.`, { ok: true, node: r.node, file: r.file, template: { id: arg, revision: r.template.revision } })
      return 0
    }
    default: throw c.usage(`no subcommand "${sub}"`)
  }
}
