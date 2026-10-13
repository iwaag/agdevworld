// Where the browser reaches the host's services: the same host the page was
// opened from, so the views work from any PC on the LAN. VITE_AGENTROOM_URL /
// VITE_AGDEV_URL at build time point elsewhere.
const here = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost'
const host = here.includes(':') ? `[${here}]` : here
const scheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'https:' : 'http:'

export const AGENTROOM_URL = (import.meta.env.VITE_AGENTROOM_URL as string | undefined) ?? `${scheme}//${host}:8094`
export const AGDEV_URL = (import.meta.env.VITE_AGDEV_URL as string | undefined) ?? `${scheme}//${host}:8093/wfe/`
