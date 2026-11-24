import { state, loadState, saveState, onStateChange, addCustomFile, loadQuestState, hydrateCustomFiles } from './state.js';
import { hydrateOverrides } from './overrides.js';
import { requestPersistence } from './storage.js';
import { hydrateTextures } from './datapack-io.js';
import { initDatapack } from './datapack-ui.js';
import { fetchGameVersions, resolveDependencies, buildModrinthMod } from './api.js';
import { renderModList, executeSearch, renderAddons, refreshAddons, refreshSearchResults, toast } from './ui.js';
import { debounce } from './utils.js';
import { PROJECT_TYPES, categoryLabel } from './project-types.js';
import { initQuests, triggerQuestRenders } from './quests.js';
import { exportMrPack, exportQuestsZip } from './export.js';
import { importMrPack, importQuests } from './import.js';
import { initPackTools, renderPackTools } from './packtools-ui.js';

document.addEventListener("DOMContentLoaded", async () => {
  loadState();
  loadQuestState();
  // Imported files, custom jars and item textures saved by earlier sessions (IndexedDB).
  await Promise.all([hydrateOverrides(), hydrateCustomFiles(), hydrateTextures()]);
  requestPersistence();
  
  // Mod list changed: update the list and the "Added" buttons, but don't refetch
  // (that would reset the page and scroll position on every add/remove or keystroke).
  onStateChange(() => {
    renderModList();
    refreshSearchResults();
    refreshAddons(); // re-checks addon availability when version/loader/Sinytra changed
    renderPackTools();
  });
  
  bindNavigation();
  bindFormInputs();
  bindExportButtons();
  bindImportButtons();
  initPackTools();
  
  await populateGameVersions();
  updateSinytraVisibility();

  await initQuests();
  initDatapack();
  await renderAddons(); 
  
  renderModList();
  triggerSearch();
});

function bindNavigation() {
  document.querySelectorAll('.activity-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.activity-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.add('hidden'));
      
      btn.classList.add('active');
      const targetPanel = document.getElementById(btn.dataset.target);
      targetPanel.classList.remove('hidden');
      targetPanel.classList.add('active');
    });
  });

  document.querySelectorAll('.center-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.center-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      
      btn.classList.add('active');
      const targetPane = document.getElementById(btn.dataset.target);
      targetPane.classList.remove('hidden');
      targetPane.classList.add('active');
      
      if (btn.dataset.target === 'tab-quests') {
        document.getElementById('right-mods-view').classList.add('hidden');
        document.getElementById('right-quest-view').classList.remove('hidden');
        triggerQuestRenders(); 
      } else {
        document.getElementById('right-mods-view').classList.remove('hidden');
        document.getElementById('right-quest-view').classList.add('hidden');
      }
    });
  });
}

function bindFormInputs() {
  document.getElementById('pack-name').value = state.name;
  document.getElementById('pack-name').addEventListener('input', e => { state.name = e.target.value; saveState(); });

  document.getElementById('loader-version').value = state.loaderVersion;
  document.getElementById('loader-version').addEventListener('input', e => { state.loaderVersion = e.target.value; saveState(); });

  document.getElementById('mc-version').addEventListener('change', e => handleClearStateConfirm(e, 'mcVersion', "Changing Minecraft version will clear all current mods. Proceed?"));
  document.getElementById('pack-loader').addEventListener('change', e => handleClearStateConfirm(e, 'loader', "Changing Mod Loader will clear all current mods. Proceed?"));

  bindSearchControls();

  // Auto-Dependency Button
  document.getElementById('btn-auto-dep').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.textContent = "Resolving...";
    btn.disabled = true;
    
    const addedCount = await resolveDependencies();
    btn.textContent = addedCount > 0 ? `Added ${addedCount} mods` : "All good!";
    
    if (addedCount > 0) saveState();
    setTimeout(() => { btn.textContent = "Resolve Dependencies"; btn.disabled = false; }, 3000);
  });

  // Custom Mod Upload
  document.getElementById('btn-add-custom').addEventListener('click', () => document.getElementById('custom-mod-input').click());
  document.getElementById('custom-mod-input').addEventListener('change', (e) => {
    for(let file of e.target.files) {
      addCustomFile({
        id: 'custom-' + Date.now() + Math.random(), 
        slug: file.name, 
        title: file.name, 
        category: 'Custom', 
        custom: true
      }, file);
    }
    e.target.value = '';
  });

  // Sinytra Toggle Logic
  const sinytraToggle = document.getElementById('sinytra-toggle');
  sinytraToggle.addEventListener('change', async (e) => {
    state.sinytraEnabled = e.target.checked;
    
    if (state.sinytraEnabled) {
      // Temporarily disable the UI to fetch the 3 core mods
      sinytraToggle.disabled = true;
      await installSinytraMods();
      sinytraToggle.disabled = false;
    } else {
      removeSinytraMods();
    }
    
    saveState();
    triggerSearch(); // Reload searches to reflect the newly allowed/disabled fabric mods
  });
}

function updateSinytraVisibility() {
  const sinytraGroup = document.getElementById('sinytra-group');
  const sinytraToggle = document.getElementById('sinytra-toggle');

  if (state.loader === 'forge' || state.loader === 'neoforge') {
    sinytraGroup.style.display = 'block';
    sinytraToggle.checked = state.sinytraEnabled;
  } else {
    sinytraGroup.style.display = 'none';
    if (state.sinytraEnabled) {
      state.sinytraEnabled = false;
      removeSinytraMods();
      saveState();
    }
  }
}

const SINYTRA_SLUGS = ['connector', 'connector-extras', 'forgified-fabric-api'];

async function installSinytraMods() {
  let added = 0;

  for (const slug of SINYTRA_SLUGS) {
    if (state.mods.some(m => m.slug === slug)) continue;
    try {
      const mod = await buildModrinthMod(slug, { category: 'Utility' });
      if (mod) { state.mods.push(mod); added++; }
    } catch (err) {
      console.warn(`Could not auto-install Sinytra requirement: ${slug}`, err);
    }
  }

  if (added === 0 && SINYTRA_SLUGS.some(s => !state.mods.some(m => m.slug === s))) {
    alert('Warning: Could not fetch Sinytra mods. Ensure they exist for this Minecraft version.');
  }
}

function removeSinytraMods() {
  state.mods = state.mods.filter(m => !SINYTRA_SLUGS.includes(m.slug));
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function ensureOption(select, value) {
  if (![...select.options].some(o => o.value === value)) select.add(new Option(value, value));
  select.value = value;
}

/** Pushes imported pack settings from state back into the form controls. */
function syncPackInputs() {
  $('pack-name').value = state.name;
  $('loader-version').value = state.loaderVersion;
  ensureOption($('mc-version'), state.mcVersion);
  $('pack-loader').value = state.loader;
  updateSinytraVisibility();
}

function bindImportButtons() {
  const bindImport = (buttonId, inputId, handler, afterImport) => {
    const button = $(buttonId), input = $(inputId);
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      if (files.length === 0) return;

      try {
        const message = await handler(files);
        if (message === null) return; // cancelled
        afterImport();
        toast(message, { type: 'success' });
      } catch (err) {
        console.error(err);
        toast(`Import failed: ${err.message}`, { type: 'error' });
      }
    });
  };

  bindImport('btn-import-mrpack', 'mrpack-input', files => importMrPack(files[0]), () => {
    syncPackInputs();
    triggerSearch();
    triggerQuestRenders();
  });
  bindImport('btn-import-quests', 'quests-input', importQuests, triggerQuestRenders);
}

function bindExportButtons() {
  document.querySelectorAll('.btn-export:not(#btn-export-quests)').forEach(btn => {
    btn.addEventListener('click', exportMrPack);
  });
  
  const exportQuestsBtn = document.getElementById('btn-export-quests');
  if (exportQuestsBtn) {
    exportQuestsBtn.addEventListener('click', exportQuestsZip);
  }
}

function handleClearStateConfirm(e, stateKey, msg) {
  if(state.mods.length > 0) {
    if(!confirm(msg)) { 
      e.target.value = state[stateKey]; 
      return; 
    }
    state.mods = []; 
  }
  state[stateKey] = e.target.value;
  saveState();
  updateSinytraVisibility();
  triggerSearch();
}

async function populateGameVersions() {
  const versions = await fetchGameVersions();
  const select = document.getElementById('mc-version');
  select.innerHTML = '';
  
  versions.forEach(ver => {
    const opt = document.createElement('option');
    opt.value = ver; 
    opt.textContent = ver;
    select.appendChild(opt);
  });
  
  if(!state.mcVersion || !versions.includes(state.mcVersion)) {
    state.mcVersion = versions[0];
  }
  select.value = state.mcVersion;
  document.getElementById('pack-loader').value = state.loader;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let currentPage = 1;
const $ = id => document.getElementById(id);

function readFilters() {
  return {
    query: $('mod-search').value.trim(),
    page: currentPage,
    type: $('search-type').value,
    sort: $('search-sort').value,
    categories: [...document.querySelectorAll('#search-categories input:checked')].map(i => i.value),
    environment: $('search-environment').value,
    openSource: $('search-open-source').checked,
    minDownloads: Number($('search-min-downloads').value),
    minFollows: Number($('search-min-follows').value)
  };
}

function bindSearchControls() {
  const search = debounce(() => triggerSearch(), 300);
  const searchNow = () => triggerSearch();

  $('mod-search').addEventListener('input', search);
  $('mod-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchNow(); });
  $('btn-search').addEventListener('click', searchNow);

  ['search-source', 'search-sort', 'search-environment', 'search-min-downloads', 'search-min-follows', 'search-open-source']
    .forEach(id => $(id).addEventListener('change', searchNow));
  // Chips are rebuilt whenever the type changes, so listen on the container instead of each chip.
  $('search-categories').addEventListener('change', search);

  document.querySelectorAll('#search-type-tabs .type-tab').forEach(tab => {
    tab.addEventListener('click', () => setSearchType(tab.dataset.type));
  });
  renderCategoryChips();

  $('search-source').addEventListener('change', updateSourceFilters);

  $('btn-reset-filters').addEventListener('click', () => {
    $('search-sort').value = 'relevance';
    $('search-environment').value = '';
    $('search-min-downloads').value = '0';
    $('search-min-follows').value = '0';
    $('search-open-source').checked = false;
    document.querySelectorAll('#search-categories input').forEach(i => { i.checked = false; });
    searchNow();
  });

  updateSourceFilters();
}

/** Switches what the search looks for: mods, shaders, resource packs or datapacks. */
function setSearchType(type) {
  if (!PROJECT_TYPES[type] || $('search-type').value === type) return;
  $('search-type').value = type;
  document.querySelectorAll('#search-type-tabs .type-tab').forEach(t => t.classList.toggle('active', t.dataset.type === type));
  $('mod-search').placeholder = `Search ${PROJECT_TYPES[type].label.toLowerCase()}... (Leave empty for popular)`;
  renderCategoryChips();
  triggerSearch();
}

/** Category filter chips differ per type (a shader has "realistic", a mod has "magic"). */
function renderCategoryChips() {
  const box = $('search-categories');
  box.replaceChildren(...PROJECT_TYPES[$('search-type').value].categories.map(value => {
    const label = document.createElement('label');
    label.className = 'chip';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'category';
    input.value = value;
    const span = document.createElement('span');
    span.textContent = categoryLabel(value);
    label.append(input, span);
    return label;
  }));
}

// Category / environment / min-downloads / min-stars filters are Modrinth-only.
function updateSourceFilters() {
  const isModrinth = $('search-source').value === 'modrinth';
  document.querySelectorAll('.modrinth-only').forEach(el => el.classList.toggle('hidden', !isModrinth));
}

/** Runs a search. Any change to the filters/query starts again from page 1. */
function triggerSearch({ page = 1 } = {}) {
  if (!state.mcVersion || !state.loader) return;
  currentPage = page;
  executeSearch(readFilters(), $('search-source').value, p => triggerSearch({ page: p }));
}
