import { state, loadState, saveState, onStateChange, addCustomFile, loadQuestState } from './state.js';
import { fetchGameVersions, resolveDependencies, buildModrinthMod } from './api.js';
import { renderModList, executeSearch, renderAddons, refreshSearchResults } from './ui.js';
import { debounce } from './utils.js';
import { initQuests, triggerQuestRenders } from './quests.js';
import { exportMrPack, exportQuestsZip } from './export.js';

document.addEventListener("DOMContentLoaded", async () => {
  loadState();
  loadQuestState();
  
  // Mod list changed: update the list and the "Added" buttons, but don't refetch
  // (that would reset the page and scroll position on every add/remove or keystroke).
  onStateChange(() => {
    renderModList();
    refreshSearchResults();
  });
  
  bindNavigation();
  bindFormInputs();
  bindExportButtons();
  
  await populateGameVersions();
  updateSinytraVisibility();

  await initQuests();
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
  document.querySelectorAll('#search-categories input').forEach(i => i.addEventListener('change', search));

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
