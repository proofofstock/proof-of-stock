// scripts/stocks/notify-failure.mjs: a systemd unit failed; tell the owner (scripts/lib/alert.mjs). Started by
// stp-alert@<unit>.service, which every unit names in OnFailure= (deployment/systemd/).
//
// Usage: node scripts/stocks/notify-failure.mjs <unit name>
import { alert } from '../lib/alert.mjs'

const unit = String(process.argv[2] || 'a unit').replace(/[^\w@.\-:]/g, '').slice(0, 80)
const what = {
  'stp-peg.service': 'the price recorder failed: readings or the issuer list may be missing for this run',
  'stp-impostors.service': 'the look-alike list was not rebuilt',
  'stp-web.service': 'the site process failed; systemd restarts it',
  'stp-health.service': 'the health check itself failed',
}[unit] || 'it failed'
// One message per failed unit an hour at most; the next health check says when things are fine again.
await alert({ key: `unit:${unit}`, text: `${unit}: ${what}. See journalctl -u ${unit} on the host.` }, { everyMs: 3600e3 })
