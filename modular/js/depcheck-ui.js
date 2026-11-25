// Dependency panel in Pack Info: "Check" (report only) and "Resolve" (add what's missing from Modrinth).
// The "auto-add when adding a mod" switch is in Settings.
import { state } from './state.js';
import { checkPack, resolveEverything } from './depresolve.js';
import { toast } from './ui.js';

const $ = id => document.getElementById(id);
let busy = false;

function row(level, text) {
  const el = document.createElement('div');
  el.className = `dep-issue dep-${level}`;
  el.textContent = text;
  return el;
}

/** Draws a check result into the report box. */
function renderReport(analysis, { added = [], unresolved = [] } = {}) {
  const box = $('dep-report');
  const rows = [];

  added.forEach(a => rows.push(row('ok', `Added ${a.title}${a.requiredBy?.length ? ` (needed by ${a.requiredBy.join(', ')})` : ''}`)));
  unresolved.forEach(u => rows.push(row('error', `Couldn't find ${u.depId} on Modrinth (needed by ${u.requiredBy.join(', ')}). Add it by hand or upload the jar.`)));

  const unresolvedIds = new Set(unresolved.map(u => u.depId));
  analysis.issues
    .filter(i => !(i.kind === 'missing' && unresolvedIds.has(i.depId)))   // already listed above
    .forEach(i => rows.push(row(i.level, i.message)));

  if (analysis.unreadableReasons?.length) {
    const names = analysis.unreadableReasons.map(u => `${u.title} (${u.reason})`).join('; ');
    rows.push(row('info', `Not checked: ${names}`));
  }
  if (!rows.length) rows.push(row('ok', `No problems found in ${analysis.checked} mod${analysis.checked === 1 ? '' : 's'}.`));
  else rows.unshift(row('info', `Checked ${analysis.checked} mod${analysis.checked === 1 ? '' : 's'} using fabric.mod.json / META-INF.`));

  box.replaceChildren(...rows);
  box.classList.remove('hidden');
}

async function run(button, idleLabel, task) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('.dep-btn').forEach(b => { b.disabled = true; });
  try {
    if (!window.JSZip) throw new Error('JSZip failed to load, so mod files cannot be read.');
    if (!state.mcVersion) throw new Error('Pick a Minecraft version first.');
    await task(text => { button.textContent = text; });
  } catch (err) {
    console.error(err);
    toast(err.message || 'Dependency check failed.', { type: 'error' });
  } finally {
    busy = false;
    button.textContent = idleLabel;
    document.querySelectorAll('.dep-btn').forEach(b => { b.disabled = false; });
  }
}

export function initDependencyPanel() {
  const check = $('btn-check-deps'), resolve = $('btn-auto-dep');

  check.addEventListener('click', () => run(check, 'Check Dependencies', async setText => {
    setText('Checking…');
    const analysis = await checkPack({ onProgress: (d, t) => setText(`Reading mods ${d}/${t}…`) });
    renderReport(analysis);
    const errors = analysis.issues.filter(i => i.level === 'error').length;
    toast(errors ? `${errors} dependency problem${errors === 1 ? '' : 's'} found.` : 'No dependency problems found.', { type: errors ? 'error' : 'info' });
  }));

  resolve.addEventListener('click', () => run(resolve, 'Resolve Dependencies', async setText => {
    setText('Resolving…');
    const { added, unresolved, analysis } = await resolveEverything({ onStatus: setText });
    renderReport(analysis, { added, unresolved });
    toast(added.length ? `Added ${added.length} dependenc${added.length === 1 ? 'y' : 'ies'}.` : unresolved.length ? 'Some dependencies could not be found.' : 'All good!',
      { type: unresolved.length ? 'error' : 'info' });
  }));
}
