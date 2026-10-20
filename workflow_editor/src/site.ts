// The site's own places outside this app (retire_old_ui p1, workflow_editor
// p15). The dashboard is the site's Home; aghangout, a managed project's
// application where a person talks with the project agents, is served beside
// it on the agdev origin at /hangout/. Through agdevworld's /wfe/ route that
// is this origin's `/hangout/`; elsewhere (the service's own port, the dev
// server) it is the same host's agdev origin, named by the host the page was
// opened under rather than a machine name.
import { h } from './dom.ts'

const AGDEV_PORT = 8093

export function hangoutHref(): string {
  if (location.pathname.startsWith('/wfe/')) return '/hangout/'
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname
  return `${location.protocol}//${host}:${AGDEV_PORT}/hangout/`
}

// The links every top-level screen offers beside its own actions.
export function siteLinks(current?: 'usage'): HTMLElement[] {
  return [
    current === 'usage' ? null : h('a.button', { href: '#/usage', title: 'Subscription windows and what executions used' }, 'Usage'),
    h('a.button', { href: hangoutHref(), title: 'Talk with Front, forge, archsage and the other project agents (aghangout)' }, 'aghangout ↗'),
  ].filter((x): x is HTMLAnchorElement => !!x)
}
