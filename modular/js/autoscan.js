// Optional background scan of mod jars (item names, textures, dependency info) whenever the pack changes.
// Off by default because it downloads the jars; see the "Scan mod files automatically" setting.
import { onStateChange } from './state.js';
import { describePack, scanPackMods } from './itemdb.js';
import { getSetting, onSettingsChange, autoScanLimitBytes } from './settings.js';
import { debounce } from './utils.js';
import { toast } from './ui.js';

const formatMB = bytes => `${Math.round(bytes / (1024 * 1024))} MB`;

export function initAutoScan() {
  let running = false, rerun = false, lastSkipped = null;

  const run = async () => {
    if (!getSetting('autoScan') || !window.JSZip) return;
    if (running) { rerun = true; return; }       // pack changed mid-scan: look again afterwards

    const info = describePack();
    if (!info.pendingCount) return;

    const limit = autoScanLimitBytes();
    if (limit && info.pendingBytes > limit) {
      // Say so once per size, not on every edit.
      const note = `${info.pendingCount}:${info.pendingBytes}`;
      if (lastSkipped !== note) {
        lastSkipped = note;
        toast(`Auto-scan skipped: ${info.pendingCount} mod${info.pendingCount === 1 ? '' : 's'} would download about ${formatMB(info.pendingBytes)}. Scan from the Quest Items tab, or raise the limit in Settings.`, { duration: 9000 });
      }
      return;
    }

    running = true;
    try { await scanPackMods({ skipFailed: true }); }   // failed mods are retried by hand, not on every edit
    catch (err) { console.warn('Auto-scan failed', err); }
    finally {
      running = false;
      if (rerun) { rerun = false; schedule(); }
    }
  };

  const schedule = debounce(run, 2500);   // let a burst of adds/removes settle first
  onStateChange(schedule);
  onSettingsChange(key => { if (key === 'autoScan' || key === 'autoScanLimitMB') { lastSkipped = null; schedule(); } });
  schedule();
}
