// Quest explorer: the "Quest Items" sidebar. Browse and search every item and mob from vanilla
// and from the mods in the pack (read from their jars, see itemdb.js), then add them to quests.
import { questState, onStateChange } from './state.js';
import { escapeHtml, debounce } from './utils.js';
import * as db from './itemdb.js';
import { toast } from './ui.js';
import { exceedsDownloadWarning } from './settings.js';

const PAGE = 80;                      // rows rendered at a time; more load as you scroll

const ui = {
  kind: 'item',     // 'item' | 'entity'
  ns: '',           // mod filter ('' = all)
  query: '',
  as: 'task',       // 'task' | 'reward' (items only; mobs are always kill tasks)
  multi: false,
  picked: new Map(),// key -> entry, while multi-select is on
  results: [],
  shown: PAGE,
  scanning: false,
  abort: null,
  progress: null
};

let addToQuest = () => ({ message: '' });
const $ = id => document.getElementById(id);

const formatMB = bytes => bytes >= 1024 * 1024 * 10 ? `${Math.round(bytes / 1048576)} MB` : `${(bytes / 1048576).toFixed(1)} MB`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function rowHtml(entry) {
  return `<div class="qx-row${ui.picked.has(entry.key) ? ' selected' : ''}" data-key="${escapeHtml(entry.key)}" title="${escapeHtml(entry.key)}">
    ${db.iconHtml(entry, 28)}
    <div class="qx-meta"><div class="qx-name">${escapeHtml(entry.name)}</div><div class="qx-id">${escapeHtml(entry.key)}</div></div>
  </div>`;
}

function emptyMessage() {
  const scan = db.describePack();
  if (scan.vanillaStatus === 'failed' && !db.hasModData()) return "Couldn't load Minecraft's item list. Check your connection and press Retry below.";
  if (ui.query || ui.ns) return 'Nothing matches.';
  return ui.kind === 'entity' ? 'No mobs found.' : 'No items found.';
}

export function renderList() {
  const list = $('qx-list');
  ui.results = db.search({ kind: ui.kind, query: ui.query.trim(), ns: ui.ns });
  ui.shown = PAGE;
  list.scrollTop = 0;
  list.innerHTML = ui.results.length
    ? ui.results.slice(0, ui.shown).map(rowHtml).join('')
    : `<div class="qx-empty">${escapeHtml(emptyMessage())}</div>`;
  $('qx-count').textContent = ui.results.length
    ? `${ui.results.length.toLocaleString()} ${ui.kind === 'entity' ? 'mobs' : 'items'}`
    : '';
}

function appendRows() {
  if (ui.shown >= ui.results.length) return;
  const next = ui.results.slice(ui.shown, ui.shown + PAGE);
  ui.shown += next.length;
  $('qx-list').insertAdjacentHTML('beforeend', next.map(rowHtml).join(''));
}

function renderControls() {
  document.querySelectorAll('#qx-kind button').forEach(b => b.classList.toggle('active', b.dataset.kind === ui.kind));
  document.querySelectorAll('#qx-as button').forEach(b => b.classList.toggle('active', b.dataset.as === ui.as));
  $('qx-as').classList.toggle('hidden', ui.kind === 'entity');
  $('qx-multi').classList.toggle('active', ui.multi);
  $('qx-search').placeholder = ui.kind === 'entity' ? 'Search mobs…' : 'Search items…';

  // Mod filter: only mods that actually have something of the chosen kind.
  const select = $('qx-mod');
  const field = ui.kind === 'entity' ? 'entities' : 'items';
  const options = db.listNamespaces().filter(n => n[field] > 0);
  if (ui.ns && !options.some(o => o.ns === ui.ns)) ui.ns = '';
  select.innerHTML = `<option value="">All mods</option>` + options
    .map(o => `<option value="${escapeHtml(o.ns)}">${escapeHtml(o.label)} (${o[field]})</option>`).join('');
  select.value = ui.ns;
}

/** Shows where a click will land: the selected quest, or a brand new one. */
export function renderTarget() {
  const chapter = questState.chapters[questState.activeChapter];
  const quest = chapter?.quests.find(q => q.id === questState.selectedQuestId);
  const what = ui.kind === 'entity' ? 'kill task' : ui.as;
  $('qx-dest').innerHTML = quest
    ? `Adds as ${what} to <b>${escapeHtml(quest.title || 'Untitled')}</b>`
    : `Adds as ${what} to a <b>new quest</b>. Select a quest to add to it instead.`;
  renderSelection();
}

function renderSelection() {
  const bar = $('qx-selection');
  const count = ui.picked.size;
  bar.classList.toggle('hidden', !(ui.multi && count > 0));
  if (!(ui.multi && count > 0)) return;
  const hasQuest = !!questState.chapters[questState.activeChapter]?.quests.some(q => q.id === questState.selectedQuestId);
  bar.innerHTML = `<span>${count} selected</span>
    ${hasQuest ? '<button data-act="add" class="btn-primary">Add to quest</button>' : ''}
    <button data-act="new" class="btn-primary">New quest</button>
    <button data-act="clear" class="btn-primary">Clear</button>`;
}

export function renderScan() {
  const box = $('qx-scan');
  const info = db.describePack();
  const total = info.rows.length;
  const ready = info.rows.filter(r => r.state === 'ready').length;
  const failed = info.rows.filter(r => r.state === 'failed').length;

  let html;
  if (ui.scanning) {
    const p = ui.progress ?? { done: 0, total: 0 };
    html = `<div class="qx-scan-row"><span>Reading mods… ${p.done}/${p.total}</span><button id="qx-cancel" class="btn-primary">Cancel</button></div>
      <div class="qx-bar"><div style="width:${p.total ? Math.round(p.done / p.total * 100) : 0}%"></div></div>`;
  } else if (info.downloadCount > 0) {
    const size = info.downloadBytes ? ` (~${formatMB(info.downloadBytes)})` : '';
    html = `<button id="qx-scan-btn" class="btn-primary w-full">${failed ? 'Retry' : 'Scan'} ${info.downloadCount} mod${info.downloadCount === 1 ? '' : 's'}${size}</button>
      <div class="qx-note">Downloads each mod once and reads its items and names. Results are saved in this browser.</div>`;
  } else if (info.vanillaStatus === 'failed') {
    html = `<button id="qx-scan-btn" class="btn-primary w-full">Retry loading Minecraft data</button>`;
  } else {
    html = total === 0
      ? `<div class="qx-note">Add mods to your pack to browse their items here.</div>`
      : `<div class="qx-note">${ready ? 'All scannable mods are read.' : 'Nothing to scan.'}</div>`;
  }

  if (total > 0) {
    html += `<details class="qx-details"><summary>${ready}/${total} mods read${failed ? `, ${failed} failed` : ''}</summary>
      ${info.rows.map(r => `<div class="qx-mod ${r.state}"><span>${escapeHtml(r.title)}</span><span>${escapeHtml(r.state === 'ready' ? '✓' : r.detail || r.state)}</span></div>`).join('')}
    </details>`;
  }
  // Keep the details panel open across the frequent re-renders while scanning.
  const wasOpen = box.querySelector('details')?.open;
  box.innerHTML = html;
  if (wasOpen) box.querySelector('details')?.setAttribute('open', '');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function pick(entries, { newQuest = false } = {}) {
  const result = addToQuest({
    entries: entries.map(e => ({ kind: e.kind, id: e.key, name: e.name })),
    as: ui.kind === 'entity' ? 'task' : ui.as,
    newQuest
  });
  if (result?.message) toast(result.message, { duration: 2500 });
}

async function startScan() {
  const info = db.describePack();
  if (exceedsDownloadWarning(info.downloadBytes) && !confirm(`This will download about ${formatMB(info.downloadBytes)}. Continue?`)) return;

  if (info.downloadCount === 0) { await db.syncRegistry({ force: true }); return; } // just retrying vanilla

  ui.scanning = true;
  ui.abort = new AbortController();
  ui.progress = { done: 0, total: info.downloadCount };
  renderScan();
  try {
    await db.scanPackMods({ signal: ui.abort.signal, onProgress: (done, total) => { ui.progress = { done, total }; } });
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
  const cancelled = ui.abort.signal.aborted;
  ui.scanning = false;
  ui.abort = null;
  renderScan();
  const failed = db.describePack().rows.filter(r => r.state === 'failed').length;
  if (failed) toast(`${failed} mod${failed === 1 ? '' : 's'} couldn't be read. Open "mods read" below for details.`, { type: 'error' });
  else if (!cancelled) toast('Finished reading mods.', { duration: 2500 });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** @param {{ addToQuest: (req: { entries: {kind:string,id:string,name:string}[], as: string, newQuest: boolean }) => { message: string } }} hooks */
export function initExplorer(hooks) {
  addToQuest = hooks.addToQuest;
  db.installIconFallback();

  $('qx-search').addEventListener('input', debounce(e => { ui.query = e.target.value; renderList(); }, 150));
  $('qx-mod').addEventListener('change', e => { ui.ns = e.target.value; renderList(); });

  $('qx-kind').addEventListener('click', e => {
    const kind = e.target.closest('button')?.dataset.kind;
    if (!kind || kind === ui.kind) return;
    ui.kind = kind;
    ui.picked.clear();
    renderControls(); renderList(); renderTarget();
  });
  $('qx-as').addEventListener('click', e => {
    const as = e.target.closest('button')?.dataset.as;
    if (!as) return;
    ui.as = as;
    renderControls(); renderTarget();
  });
  $('qx-multi').addEventListener('click', () => {
    ui.multi = !ui.multi;
    ui.picked.clear();
    renderControls(); renderList(); renderTarget();
  });

  $('qx-list').addEventListener('click', e => {
    const row = e.target.closest('.qx-row');
    const entry = row && db.getEntry(ui.kind, row.dataset.key);
    if (!entry) return;
    if (ui.multi) {
      ui.picked.has(entry.key) ? ui.picked.delete(entry.key) : ui.picked.set(entry.key, entry);
      row.classList.toggle('selected');
      renderSelection();
    } else {
      pick([entry]);
    }
  });
  $('qx-list').addEventListener('scroll', e => {
    const el = e.target;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 240) appendRows();
  }, { passive: true });

  $('qx-selection').addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    if (act !== 'clear') pick([...ui.picked.values()], { newQuest: act === 'new' });
    ui.picked.clear();
    document.querySelectorAll('#qx-list .qx-row.selected').forEach(r => r.classList.remove('selected'));
    renderSelection();
  });

  $('qx-scan').addEventListener('click', e => {
    if (e.target.closest('#qx-cancel')) ui.abort?.abort();
    else if (e.target.closest('#qx-scan-btn')) startScan();
  });

  db.onRegistryChange(() => { renderControls(); renderList(); renderScan(); });
  db.onScanStatus(renderScan);
  // New mods added, removed or updated, or a different Minecraft version: pick up what's already cached.
  onStateChange(debounce(() => db.syncRegistry().then(renderScan), 400));

  renderControls(); renderList(); renderTarget(); renderScan();
  db.syncRegistry();
}
