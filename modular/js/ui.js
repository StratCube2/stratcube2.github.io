import { state, saveState, removeCustomFile } from './state.js';
import { escapeHtml } from './utils.js';
import {
  searchModrinth, searchCurseForge, buildModrinthMod, primaryCategory,
  isViaConnector, checkModAvailability, SEARCH_PAGE_SIZE
} from './api.js';

const FALLBACK_ICON = 'https://docs.modrinth.com/img/logo.svg';

let currentSearchController = null;
let lastResults = null; // { hits, source } — lets us refresh "Added" buttons without refetching

const formatCount = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * @param {object} filters  see api.js (query, page, sort, categories, ...)
 * @param {string} source   'modrinth' | 'curseforge'
 * @param {(page:number)=>void} onPageChange
 */
export async function executeSearch(filters, source, onPageChange) {
  const resultsDiv = document.getElementById('search-results');
  const pagerDiv = document.getElementById('search-pagination');

  currentSearchController?.abort();
  currentSearchController = new AbortController();
  const { signal } = currentSearchController;

  resultsDiv.innerHTML = '<span class="text-muted">Searching...</span>';
  pagerDiv.innerHTML = '';

  try {
    const { hits, total } = source === 'modrinth'
      ? await searchModrinth(filters, signal)
      : await searchCurseForge(filters, signal);

    lastResults = { hits, source };
    renderSearchResults();
    resultsDiv.scrollTop = 0;
    renderPagination(pagerDiv, filters.page, total, onPageChange);
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer search
    lastResults = null;
    resultsDiv.innerHTML = `<span class="text-muted" style="color:#ff4466">Search Error: ${escapeHtml(err.message)}</span>`;
  }
}

/** Re-renders the cached results (e.g. after a mod was added/removed). Keeps scroll position. */
export function refreshSearchResults() {
  if (!lastResults) return;
  const container = document.getElementById('search-results');
  const scroll = container.scrollTop;
  renderSearchResults();
  container.scrollTop = scroll;
}

function normalizeHit(hit, source) {
  if (source === 'modrinth') {
    return {
      id: hit.project_id, slug: hit.slug, title: hit.title, desc: hit.description,
      icon: hit.icon_url, downloads: hit.downloads, follows: hit.follows,
      category: primaryCategory(hit.categories),
      viaConnector: isViaConnector(hit.categories)
    };
  }
  return {
    id: String(hit.id), slug: hit.slug, title: hit.name, desc: hit.summary,
    icon: hit.logo?.thumbnailUrl, downloads: hit.downloadCount, follows: null,
    category: 'Utility', viaConnector: false
  };
}

function renderSearchResults() {
  const container = document.getElementById('search-results');
  const { hits, source } = lastResults;
  container.innerHTML = '';

  if (hits.length === 0) {
    container.innerHTML = '<span class="text-muted">No mods found for this configuration.</span>';
    return;
  }

  const fragment = document.createDocumentFragment();
  hits.forEach(hit => fragment.appendChild(createModCard(normalizeHit(hit, source), source)));
  container.appendChild(fragment);
}

function createModCard(mod, source) {
  const added = state.mods.some(m => m.id === mod.id);
  const stats = [
    `⬇ ${formatCount(mod.downloads)}`,
    mod.follows != null ? `★ ${formatCount(mod.follows)}` : null,
    mod.viaConnector ? '<span class="badge-connector" title="Fabric mod, runs through Sinytra Connector">Fabric via Connector</span>' : null
  ].filter(Boolean).join(' · ');

  const div = document.createElement('div');
  div.className = 'mod-card';
  div.innerHTML = `
    <img src="${escapeHtml(mod.icon || FALLBACK_ICON)}" class="mod-icon" alt="icon">
    <div class="mod-info">
      <h4>${escapeHtml(mod.title)}</h4>
      <p>${escapeHtml(mod.desc)}</p>
      <div class="mod-stats">${stats}</div>
    </div>
    <button class="btn-primary" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add'}</button>
  `;

  if (!added) {
    const btn = div.querySelector('button');
    btn.addEventListener('click', () => addSearchedMod(mod, source, btn));
  }
  return div;
}

async function addSearchedMod(mod, source, btn) {
  btn.textContent = 'Adding...';
  btn.disabled = true;

  let entry;
  if (source === 'modrinth') {
    try {
      entry = await buildModrinthMod(mod.slug, { category: mod.category });
    } catch (e) { console.error(e); }
    // No compatible file found: still list the mod (matches previous behaviour).
    entry ??= { id: mod.id, slug: mod.slug, title: mod.title, category: mod.category, custom: false, source, mrpackData: null };
  } else {
    entry = {
      id: mod.id, slug: mod.slug, title: mod.title, category: mod.category,
      custom: false, source, mrpackData: { isCurseForge: true }
    };
  }

  state.mods.push(entry);
  saveState();
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function pageWindow(page, totalPages) {
  const pages = new Set([1, totalPages]);
  for (let p = page - 2; p <= page + 2; p++) if (p > 1 && p < totalPages) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);

  const out = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('…');
    out.push(p);
  });
  return out;
}

function renderPagination(container, page, total, onPageChange) {
  container.innerHTML = '';
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  if (total === 0) return;

  const makeBtn = (label, target, { active = false, disabled = false } = {}) => {
    const b = document.createElement('button');
    b.className = 'btn-primary page-btn' + (active ? ' active' : '');
    b.textContent = label;
    b.disabled = disabled || active;
    if (!b.disabled) b.addEventListener('click', () => onPageChange(target));
    return b;
  };

  container.appendChild(makeBtn('‹', page - 1, { disabled: page <= 1 }));
  pageWindow(page, totalPages).forEach(p => {
    if (p === '…') {
      const gap = document.createElement('span');
      gap.className = 'page-gap';
      gap.textContent = '…';
      container.appendChild(gap);
    } else {
      container.appendChild(makeBtn(String(p), p, { active: p === page }));
    }
  });
  container.appendChild(makeBtn('›', page + 1, { disabled: page >= totalPages }));

  const info = document.createElement('span');
  info.className = 'page-info text-muted';
  info.textContent = `${total.toLocaleString()} results`;
  container.appendChild(info);
}

// ---------------------------------------------------------------------------
// Mod list (right sidebar)
// ---------------------------------------------------------------------------

export function renderModList() {
  const container = document.getElementById('mod-list-container');
  container.innerHTML = '';

  if (state.mods.length === 0) {
    container.innerHTML = '<p class="text-muted text-xs text-center mt-2">No mods added.</p>';
    return;
  }

  const groups = {};
  state.mods.forEach(mod => {
    let c = mod.category || 'Unknown';
    if (c.toLowerCase() === 'shaders') c = 'Shader';
    (groups[c] ??= []).push(mod);
  });

  const shaderGroup = groups['Shader'] || [];
  delete groups['Shader'];

  const fragment = document.createDocumentFragment();
  for (const [cat, mods] of Object.entries(groups).sort()) fragment.appendChild(createCategoryDOM(cat, mods));
  if (shaderGroup.length > 0) fragment.appendChild(createCategoryDOM('Shader', shaderGroup));
  container.appendChild(fragment);
}

function createCategoryDOM(categoryName, mods) {
  const div = document.createElement('div');
  div.className = 'mod-category';

  const title = document.createElement('div');
  title.className = 'mod-category-title';
  title.textContent = categoryName;
  div.appendChild(title);

  mods.forEach(mod => {
    const badge = mod.viaConnector ? ' <span class="badge-connector">Fabric</span>' : '';
    const item = document.createElement('div');
    item.className = 'mod-item';
    item.innerHTML = `
      <span class="mod-item-name" title="${escapeHtml(mod.title)}">${mod.source === 'curseforge' ? '🔥 ' : ''}${escapeHtml(mod.title)}${badge}</span>
      <button class="mod-item-del" title="Remove">&times;</button>
    `;
    item.querySelector('.mod-item-del').addEventListener('click', () => {
      state.mods = state.mods.filter(m => m.id !== mod.id);
      removeCustomFile(mod.id);
      saveState();
    });
    div.appendChild(item);
  });
  return div;
}

// ---------------------------------------------------------------------------
// Addons
// ---------------------------------------------------------------------------

const addonViews = [];

const configKey = () => [state.mcVersion, state.loader, state.sinytraEnabled].join('|');
const isAdded = slug => state.mods.some(m => m.slug === slug);

async function runPool(items, limit, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

export async function renderAddons() {
  const container = document.getElementById('addons-list');
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error('data.json not found');
    const data = await res.json();

    container.innerHTML = '';
    addonViews.length = 0;
    const fragment = document.createDocumentFragment();
    data.addons.forEach(addon => {
      const view = createAddonView(addon);
      addonViews.push(view);
      fragment.appendChild(view.el);
    });
    container.appendChild(fragment);
  } catch (err) {
    container.innerHTML = `<span class="text-muted p-2">Failed to load Addons: ${escapeHtml(err.message)}</span>`;
  }
}

/**
 * Call after anything that can change the answer: mod list, MC version, loader or Sinytra.
 * Re-checks open addons if the configuration changed and refreshes "added" states.
 */
export function refreshAddons() {
  addonViews.forEach(view => {
    if (view.el.open) ensureChecked(view);
    renderAddonRows(view);
  });
}

function createAddonView(addon) {
  const el = document.createElement('details');
  el.className = 'addon-item';
  el.innerHTML = `
    <summary>
      <h4>${escapeHtml(addon.name)}</h4>
      <p>${escapeHtml(addon.description)}</p>
      <span class="addon-meta">${addon.mods.length} mods</span>
    </summary>
    <div class="addon-mods"></div>
    <div class="addon-actions">
      <button class="link-btn" data-act="all">Select all</button>
      <button class="link-btn" data-act="none">None</button>
    </div>
    <button class="btn-primary w-full addon-install"></button>
  `;

  const view = {
    addon, el,
    status: new Map(),     // slug -> 'checking' | { available, viaConnector }
    selected: new Set(),
    checkedKey: null,
    checking: null,
    installing: false,
    listEl: el.querySelector('.addon-mods'),
    installBtn: el.querySelector('.addon-install')
  };

  el.addEventListener('toggle', () => { if (el.open) ensureChecked(view); });
  el.querySelector('[data-act="all"]').addEventListener('click', () => {
    addon.mods.forEach(slug => { if (isSelectable(view, slug)) view.selected.add(slug); });
    renderAddonRows(view);
  });
  el.querySelector('[data-act="none"]').addEventListener('click', () => {
    view.selected.clear();
    renderAddonRows(view);
  });
  view.installBtn.addEventListener('click', () => installAddon(view));

  renderAddonRows(view);
  return view;
}

function isSelectable(view, slug) {
  const st = view.status.get(slug);
  return typeof st === 'object' && st.available && !isAdded(slug);
}

async function ensureChecked(view) {
  const key = configKey();
  if (!state.mcVersion || !state.loader || view.checkedKey === key || view.checking === key) return;

  view.checking = key;
  view.status.clear();
  view.selected.clear();
  view.addon.mods.forEach(slug => view.status.set(slug, 'checking'));
  renderAddonRows(view);

  await runPool(view.addon.mods, 4, async slug => {
    const result = await checkModAvailability(slug);
    if (configKey() !== key) return; // configuration changed mid-check; a newer check supersedes this one
    view.status.set(slug, result);
    if (result.available && !isAdded(slug)) view.selected.add(slug);
    renderAddonRows(view);
  });

  if (view.checking === key) view.checking = null;
  if (configKey() === key) view.checkedKey = key;
  renderAddonRows(view);
}

function renderAddonRows(view) {
  view.addon.mods.forEach(slug => { if (isAdded(slug)) view.selected.delete(slug); });

  view.listEl.innerHTML = '';
  view.addon.mods.forEach(slug => {
    const st = view.status.get(slug);
    const added = isAdded(slug);

    let label = '';
    if (added) label = '<span class="addon-status muted">added</span>';
    else if (st === 'checking') label = '<span class="addon-status muted">checking…</span>';
    else if (st?.available === false) label = '<span class="addon-status bad">unavailable</span>';
    else if (st?.viaConnector) label = '<span class="badge-connector">Fabric via Connector</span>';
    else if (st?.available) label = '<span class="addon-status ok">✓</span>';

    const row = document.createElement('label');
    row.className = 'addon-mod';
    row.innerHTML = `
      <input type="checkbox" ${view.selected.has(slug) ? 'checked' : ''} ${isSelectable(view, slug) ? '' : 'disabled'}>
      <span class="addon-mod-name" title="${escapeHtml(slug)}">${escapeHtml(slug)}</span>
      ${label}
    `;
    row.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) view.selected.add(slug); else view.selected.delete(slug);
      updateInstallButton(view);
    });
    view.listEl.appendChild(row);
  });

  updateInstallButton(view);
}

function updateInstallButton(view) {
  if (view.installing) return;
  const n = view.selected.size;
  view.installBtn.textContent = `Install Selected (${n})`;
  view.installBtn.disabled = n === 0 || !!view.checking;
}

async function installAddon(view) {
  if (!state.mcVersion || !state.loader) return alert('Set MC version and loader!');
  const slugs = [...view.selected].filter(slug => !isAdded(slug));
  if (slugs.length === 0) return;

  view.installing = true;
  view.installBtn.disabled = true;

  let added = 0;
  for (const [i, slug] of slugs.entries()) {
    view.installBtn.textContent = `Installing ${i + 1}/${slugs.length}...`;
    try {
      const mod = await buildModrinthMod(slug);
      if (mod) { state.mods.push(mod); added++; }
    } catch (err) {
      console.warn(`Could not install ${slug}:`, err);
    }
  }

  if (added > 0) saveState(); // also re-renders this addon's rows via refreshAddons()
  view.installBtn.textContent = added > 0 ? `Added ${added} mods` : 'Nothing installed';
  setTimeout(() => { view.installing = false; renderAddonRows(view); }, 2000);
}

// ---------------------------------------------------------------------------
// Toasts & progress overlay
// ---------------------------------------------------------------------------

export function toast(message, { type = 'info', duration = 7000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  el.addEventListener('click', () => el.remove());
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

export function showProgress(text, fraction = null) {
  document.getElementById('progress-overlay').classList.remove('hidden');
  document.getElementById('progress-text').textContent = text;
  document.getElementById('progress-bar-fill').style.width = fraction == null ? '100%' : `${Math.round(fraction * 100)}%`;
}

export function hideProgress() {
  document.getElementById('progress-overlay').classList.add('hidden');
}
