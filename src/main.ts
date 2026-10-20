// This bundle is the Front Desk (`/?view=frontdesk`) and the Arguing Room
// (`/?view=argue`), on one Phaser scene. Home is the agdev dashboard
// (retire_old_ui p1): nginx sends a bare `/` there, and any other address of
// this site lands there too.
import { AGDEV_URL } from './endpoints'

const view = new URLSearchParams(location.search).get('view')
if (view === 'frontdesk' || view === 'argue') void import('./frontDesk')
else location.replace(AGDEV_URL)
