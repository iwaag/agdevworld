// The site's own places outside this app (retire_old_ui p1). The dashboard is
// the site's Home; the Front Desk is the one screen agdevworld still serves
// beside it. Through agdevworld's /wfe/ route the desk is this origin's
// `/?view=frontdesk`; elsewhere (the service's own port, the dev server) it
// is the same host's agdevworld origin, named by the host the page was
// opened under rather than a machine name.
import { h } from './dom.ts'

const AGDEVWORLD_PORT = 8093

export function frontDeskHref(): string {
  if (location.pathname.startsWith('/wfe/')) return '/?view=frontdesk'
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname
  return `${location.protocol}//${host}:${AGDEVWORLD_PORT}/?view=frontdesk`
}

// The links every top-level screen offers beside its own actions.
export function siteLinks(current?: 'usage'): HTMLElement[] {
  return [
    current === 'usage' ? null : h('a.button', { href: '#/usage', title: 'Subscription windows and what executions used' }, 'Usage'),
    h('a.button', { href: frontDeskHref(), title: 'Talk with Front' }, 'Front Desk ↗'),
  ].filter((x): x is HTMLAnchorElement => !!x)
}
