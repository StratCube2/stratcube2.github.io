import { state, saveState, removeCustomFile } from './state.js';
import { escapeHtml } from './utils.js';
import {
  searchModrinth, searchCurseForge, buildModrinthMod, primaryCategory,
  isViaConnector, SEARCH_PAGE_SIZE
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
  const isAdded = state.mods.some(m => m.id === mod.id);
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
    <button class="btn-primary" ${isAdded ? 'disabled' : ''}>${isAdded ? 'Added' : 'Add'}</button>
  `;

  if (!isAdded) {
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

export async function renderAddons() {
  const container = document.getElementById('addons-list');
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error('data.json not found');
    const data = await res.json();

    container.innerHTML = '';
    const fragment = document.createDocumentFragment();

    data.addons.forEach(addon => {
      const div = document.createElement('div');
      div.className = 'addon-item';
      div.innerHTML = `
        <h4>${escapeHtml(addon.name)}</h4>
        <p>${escapeHtml(addon.description)}</p>
        <button class="btn-primary w-full">Install Addon</button>
      `;
      div.querySelector('button').addEventListener('click', e => installAddon(addon, e.target));
      fragment.appendChild(div);
    });
    container.appendChild(fragment);
  } catch (err) {
    container.innerHTML = `<span class="text-muted p-2">Failed to load Addons: ${escapeHtml(err.message)}</span>`;
  }
}

async function installAddon(addon, btn) {
  if (!state.mcVersion || !state.loader) return alert('Set MC version and loader!');
  btn.textContent = 'Installing...';
  btn.disabled = true;

  let added = 0;
  for (const slug of addon.mods) {
    if (state.mods.some(m => m.slug === slug)) continue;
    try {
      const mod = await buildModrinthMod(slug);
      if (mod) { state.mods.push(mod); added++; }
    } catch (err) {
      console.warn(`Could not install ${slug}:`, err);
    }
  }

  if (added > 0) saveState();
  btn.textContent = added > 0 ? `Added ${added} mods` : 'Already Added / N/A';
  setTimeout(() => { btn.textContent = 'Install Addon'; btn.disabled = false; }, 2000);
}
