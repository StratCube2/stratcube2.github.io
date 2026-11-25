import { state, saveState, removeCustomFile } from './state.js';
import { escapeHtml } from './utils.js';
import { getSetting } from './settings.js';
import {
  searchModrinth, searchCurseForge, buildModrinthMod, primaryCategory,
  isViaConnector, checkModAvailability, SEARCH_PAGE_SIZE, resolveDependencies } from './api.js';
import { PROJECT_TYPES, typeOf } from './project-types.js';
import { modsInGroup, targetGroupId, toggleGroup, renameGroup, deleteGroup, moveGroup } from './groups.js';
import { openMoveMenu, renderGroupTools } from './groups-ui.js';
import { icon as svgIcon } from './icons.js';

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

    lastResults = { hits, source, type: PROJECT_TYPES[filters.type] ? filters.type : 'mod' };
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

function normalizeHit(hit, source, type) {
  const typeLabel = PROJECT_TYPES[type].singular;
  if (source === 'modrinth') {
    return {
      id: hit.project_id, slug: hit.slug, title: hit.title, desc: hit.description,
      icon: hit.icon_url, downloads: hit.downloads, follows: hit.follows,
      category: type === 'mod' ? primaryCategory(hit.categories) : typeLabel,
      viaConnector: type === 'mod' && isViaConnector(hit.categories)
    };
  }
  return {
    id: String(hit.id), slug: hit.slug, title: hit.name, desc: hit.summary,
    icon: hit.logo?.thumbnailUrl, downloads: hit.downloadCount, follows: null,
    category: type === 'mod' ? 'Utility' : typeLabel, viaConnector: false
  };
}

function renderSearchResults() {
  const container = document.getElementById('search-results');
  const { hits, source, type } = lastResults;
  container.innerHTML = '';

  if (hits.length === 0) {
    container.innerHTML = `<span class="text-muted">No ${PROJECT_TYPES[type].label.toLowerCase()} found for this configuration.</span>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  hits.forEach(hit => fragment.appendChild(createModCard(normalizeHit(hit, source, type), source, type)));
  container.appendChild(fragment);
}

function createModCard(mod, source, type) {
  const added = state.mods.some(m => m.id === mod.id);
  const stats = [
    `${svgIcon('download')} ${formatCount(mod.downloads)}`,
    mod.follows != null ? `${svgIcon('star')} ${formatCount(mod.follows)}` : null,
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
    btn.addEventListener('click', () => addSearchedMod(mod, source, type, btn));
  }
  return div;
}

async function addSearchedMod(mod, source, type, btn) {
  btn.textContent = 'Adding...';
  btn.disabled = true;

  let entry;
  if (source === 'modrinth') {
    try {
      entry = await buildModrinthMod(mod.slug, { category: mod.category, type });
    } catch (e) { console.error(e); }
    // No compatible file found: still list the mod (matches previous behaviour).
    entry ??= { id: mod.id, slug: mod.slug, title: mod.title, type, category: mod.category, custom: false, source, mrpackData: null };
  } else {
    entry = {
      id: mod.id, slug: mod.slug, title: mod.title, type, category: mod.category,
      custom: false, source, mrpackData: { isCurseForge: true }
    };
  }

  const group = targetGroupId();       // the group chosen above the pack list, if any
  if (group) entry.group = group;
  state.mods.push(entry);
  saveState();

  // Pull in the mod's required Modrinth dependencies, if the pack has that turned on.
  if (getSetting('autoDependencies') && source === 'modrinth' && type === 'mod' && entry.mrpackData) {
    try {
      const deps = await resolveDependencies({ only: [entry.id] });
      if (deps.length) {
        saveState();
        toast(`Added ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'} for ${entry.title}: ${deps.map(d => d.title).join(', ')}`);
      }
    } catch (err) { console.warn('Auto-adding dependencies failed', err); }
  }
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
  renderGroupTools();
  const container = document.getElementById('mod-list-container');
  container.innerHTML = '';

  if (state.mods.length === 0 && state.groups.length === 0) {
    container.innerHTML = '<p class="text-muted text-xs text-center mt-2">Nothing added yet.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.groups.forEach((group, i) => fragment.appendChild(createGroupDOM(group, i)));

  const loose = modsInGroup(null);
  if (loose.length > 0) {
    // With no groups there is nothing to be "ungrouped" from, so the list stays plain.
    fragment.appendChild(createSectionDOM(state.groups.length ? 'Ungrouped' : '', loose));
  }
  container.appendChild(fragment);
}

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

function groupButton(label, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'grp-btn';
  if (label.startsWith('<svg')) btn.innerHTML = label; else btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function createGroupDOM(group, index) {
  const mods = modsInGroup(group.id);
  const div = document.createElement('div');
  div.className = 'mod-category mod-group' + (group.collapsed ? ' collapsed' : '');

  const head = document.createElement('div');
  head.className = 'mod-group-head';

  const toggle = groupButton(group.collapsed ? '▸' : '▾', group.collapsed ? 'Expand' : 'Collapse', () => toggleGroup(group.id));
  const name = document.createElement('span');
  name.className = 'mod-group-name';
  name.textContent = group.name;
  name.title = group.name;
  name.addEventListener('click', () => toggleGroup(group.id));
  const count = document.createElement('span');
  count.className = 'grp-count';
  count.textContent = String(mods.length);

  head.append(
    toggle, name, count,
    groupButton(svgIcon('pencil'), 'Rename group', () => {
      const next = prompt('Rename group:', group.name);
      if (next) renameGroup(group.id, next);
    }),
    groupButton('▲', 'Move group up', () => moveGroup(group.id, -1)),
    groupButton('▼', 'Move group down', () => moveGroup(group.id, +1)),
    groupButton(svgIcon('trash'), 'Delete group (its items stay in the pack)', () => {
      const n = mods.length;
      if (confirm(`Delete group "${group.name}"?${n ? ` Its ${n} item${n === 1 ? '' : 's'} stay in the pack as Ungrouped.` : ''}`)) deleteGroup(group.id);
    })
  );
  head.querySelector('button:nth-of-type(3)').disabled = index === 0;
  head.querySelector('button:nth-of-type(4)').disabled = index === state.groups.length - 1;
  div.appendChild(head);

  if (!group.collapsed) {
    if (mods.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'text-muted text-xs mod-group-empty';
      empty.textContent = 'Empty. Move items here with the folder button, or pick this group above before adding.';
      div.appendChild(empty);
    } else {
      mods.slice().sort(byTitle).forEach(mod => div.appendChild(createModItemDOM(mod)));
    }
  }
  return div;
}

function createSectionDOM(title, mods) {
  const div = document.createElement('div');
  div.className = 'mod-category';
  if (title) {
    const heading = document.createElement('div');
    heading.className = 'mod-category-title';
    heading.textContent = `${title} (${mods.length})`;
    div.appendChild(heading);
  }
  mods.slice().sort(byTitle).forEach(mod => div.appendChild(createModItemDOM(mod)));
  return div;
}

function createModItemDOM(mod) {
  const info = PROJECT_TYPES[typeOf(mod)];
  const badge = mod.viaConnector ? ' <span class="badge-connector">Fabric</span>' : '';
  const item = document.createElement('div');
  item.className = 'mod-item';
  item.innerHTML = `
    <span class="mod-item-type" title="${info.singular}">${svgIcon(info.icon)}</span>
    <span class="mod-item-name" title="${escapeHtml(mod.title)}">${mod.source === 'curseforge' ? svgIcon('flame') + ' ' : ''}${escapeHtml(mod.title)}${badge}</span>
    <button class="mod-item-move" title="Move to group">${svgIcon('folder')}</button>
    <button class="mod-item-del" title="Remove">&times;</button>
  `;
  const move = item.querySelector('.mod-item-move');
  move.addEventListener('click', () => openMoveMenu(move, mod.id));
  item.querySelector('.mod-item-del').addEventListener('click', () => {
    state.mods = state.mods.filter(m => m.id !== mod.id);
    removeCustomFile(mod.id);
    saveState();
  });
  return item;
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
