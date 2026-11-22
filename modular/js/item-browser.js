// Item browser dialog: the same item list the quest explorer uses (vanilla + every scanned mod,
// including custom jars), as a pop-up so the datapack editor can pick items visually.
import { escapeHtml, debounce } from './utils.js';
import * as db from './itemdb.js';
import { toast } from './ui.js';

const PAGE = 80;
const BIG_DOWNLOAD = 150 * 1024 * 1024;
const formatMB = bytes => `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB`;

let open = null; // only one browser at a time

/**
 * Lets the user search and pick an item (or mob) from everything the pack knows about.
 * @param {{ kind?: 'item'|'entity', title?: string }} [opts]
 * @returns {Promise<string|null>} the chosen id (e.g. "minecraft:stone"), or null if closed
 */
export function openItemBrowser({ kind = 'item', title } = {}) {
  open?.close(null);
  return new Promise(resolve => {
    const ui = { query: '', ns: '', results: [], shown: PAGE, scanning: false, abort: null, progress: null };

    const overlay = document.createElement('div');
    overlay.className = 'ib-overlay';
    overlay.innerHTML = `
      <div class="ib-modal" role="dialog" aria-modal="true">
        <div class="ib-head"><strong>${escapeHtml(title || (kind === 'entity' ? 'Pick a mob' : 'Pick an item'))}</strong><button type="button" class="dp-x ib-close" title="Close">✕</button></div>
        <div class="ib-controls">
          <input type="text" class="ib-search" placeholder="${kind === 'entity' ? 'Search mobs…' : 'Search items…'}" autocomplete="off" spellcheck="false">
          <select class="ib-mod" title="Filter by mod"></select>
        </div>
        <div class="qx-count ib-count"></div>
        <div class="qx-list ib-list"></div>
        <div class="qx-scan ib-scan"></div>
      </div>`;
    document.body.append(overlay);
    const $ = sel => overlay.querySelector(sel);

    const finish = value => {
      ui.abort?.abort();
      off(); offScan();
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      open = null;
      resolve(value);
    };
    open = { close: finish };

    const rowHtml = e => `<div class="qx-row" data-key="${escapeHtml(e.key)}" title="${escapeHtml(e.key)}">
      ${db.iconHtml(e, 28)}<div class="qx-meta"><div class="qx-name">${escapeHtml(e.name)}</div><div class="qx-id">${escapeHtml(e.key)}</div></div></div>`;

    const renderControls = () => {
      const field = kind === 'entity' ? 'entities' : 'items';
      const options = db.listNamespaces().filter(n => n[field] > 0);
      if (ui.ns && !options.some(o => o.ns === ui.ns)) ui.ns = '';
      const sel = $('.ib-mod');
      sel.innerHTML = `<option value="">All mods</option>` + options.map(o => `<option value="${escapeHtml(o.ns)}">${escapeHtml(o.label)} (${o[field]})</option>`).join('');
      sel.value = ui.ns;
    };

    const renderList = () => {
      const list = $('.ib-list');
      ui.results = db.search({ kind, query: ui.query.trim(), ns: ui.ns });
      ui.shown = PAGE;
      list.scrollTop = 0;
      const failed = db.describePack().vanillaStatus === 'failed' && !db.hasModData();
      list.innerHTML = ui.results.length
        ? ui.results.slice(0, ui.shown).map(rowHtml).join('')
        : `<div class="qx-empty">${failed ? "Couldn't load Minecraft's item list. Check your connection and press Retry below." : 'Nothing matches.'}</div>`;
      $('.ib-count').textContent = ui.results.length ? `${ui.results.length.toLocaleString()} ${kind === 'entity' ? 'mobs' : 'items'}` : '';
    };

    const renderScan = () => {
      const box = $('.ib-scan');
      const info = db.describePack();
      if (ui.scanning) {
        const p = ui.progress ?? { done: 0, total: 0 };
        box.innerHTML = `<div class="qx-scan-row"><span>Reading mods… ${p.done}/${p.total}</span><button type="button" class="btn-primary ib-cancel">Cancel</button></div>
          <div class="qx-bar"><div style="width:${p.total ? Math.round(p.done / p.total * 100) : 0}%"></div></div>`;
      } else if (info.downloadCount > 0) {
        const size = info.downloadBytes ? ` (~${formatMB(info.downloadBytes)})` : '';
        box.innerHTML = `<button type="button" class="btn-primary w-full ib-scan-btn">Scan ${info.downloadCount} mod${info.downloadCount === 1 ? '' : 's'}${size} to include their items</button>`;
      } else if (info.vanillaStatus === 'failed') {
        box.innerHTML = `<button type="button" class="btn-primary w-full ib-scan-btn">Retry loading Minecraft data</button>`;
      } else {
        box.innerHTML = '';
      }
      box.classList.toggle('hidden', !box.innerHTML);
    };

    const startScan = async () => {
      const info = db.describePack();
      if (info.downloadBytes > BIG_DOWNLOAD && !confirm(`This will download about ${formatMB(info.downloadBytes)}. Continue?`)) return;
      if (info.downloadCount === 0) { await db.syncRegistry({ force: true }); return; }
      ui.scanning = true; ui.abort = new AbortController(); ui.progress = { done: 0, total: info.downloadCount };
      renderScan();
      try { await db.scanPackMods({ signal: ui.abort.signal, onProgress: (done, total) => { ui.progress = { done, total }; } }); }
      catch (err) { toast(err.message, { type: 'error' }); }
      ui.scanning = false; ui.abort = null;
      renderScan();
    };

    $('.ib-search').addEventListener('input', debounce(e => { ui.query = e.target.value; renderList(); }, 150));
    $('.ib-mod').addEventListener('change', e => { ui.ns = e.target.value; renderList(); });
    $('.ib-list').addEventListener('click', e => {
      const key = e.target.closest('.qx-row')?.dataset.key;
      if (key) finish(key);
    });
    $('.ib-list').addEventListener('scroll', e => {
      const el = e.target;
      if (el.scrollTop + el.clientHeight > el.scrollHeight - 240 && ui.shown < ui.results.length) {
        const next = ui.results.slice(ui.shown, ui.shown + PAGE);
        ui.shown += next.length;
        el.insertAdjacentHTML('beforeend', next.map(rowHtml).join(''));
      }
    }, { passive: true });
    $('.ib-scan').addEventListener('click', e => {
      if (e.target.closest('.ib-cancel')) ui.abort?.abort();
      else if (e.target.closest('.ib-scan-btn')) startScan();
    });
    $('.ib-close').addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) finish(null); });
    const onKey = e => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);

    const off = db.onRegistryChange(() => { renderControls(); renderList(); renderScan(); });
    const offScan = db.onScanStatus(renderScan);

    renderControls(); renderList(); renderScan();
    db.syncRegistry(); // make sure vanilla data is loaded even if the explorer hasn't asked yet
    $('.ib-search').focus();
  });
}
