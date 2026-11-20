import { state, questState, saveState, saveQuestState, clearCustomFiles, setCustomFile } from './state.js';
import { newId } from './utils.js';
import { lookupVersionsByHash, fetchProjects, primaryCategory } from './api.js';
import { parseQuestChapters, isChapterPath, describeQuestImport } from './quest-io.js';
import { showProgress, hideProgress } from './ui.js';

// mrpack dependency key -> loader id used by this app
const LOADER_KEYS = { 'fabric-loader': 'fabric', 'forge': 'forge', 'quilt-loader': 'quilt', 'neoforge': 'neoforge' };
const CONNECTOR_LOADERS = new Set(['forge', 'neoforge']);
const QUESTS_DIR = /^overrides\/config\/ftbquests\/quests\//i;

const requireJSZip = () => {
  if (!window.JSZip) throw new Error('JSZip failed to load, so files cannot be imported.');
};

const hasQuests = () => questState.chapters.some(c => c.quests.length > 0);

function applyQuestChapters(chapters) {
  questState.chapters = chapters;
  questState.activeChapter = 0;
  questState.selectedQuestId = null;
  questState.linkSource = null;
  saveQuestState();
}

async function readQuestEntries(zip, pathFilter = isChapterPath) {
  const files = zip.file(/\.snbt$/i).filter(f => pathFilter(f.name));
  return Promise.all(files.map(async f => ({ name: f.name, text: await f.async('string') })));
}

// ---------------------------------------------------------------------------
// Quests (.zip / .mrpack / loose .snbt files)
// ---------------------------------------------------------------------------

const NON_CHAPTER_SNBT = /^(data|chapter_groups)\.snbt$/i;

/** @returns {string|null} a summary message, or null if the user cancelled */
export async function importQuests(files) {
  const entries = [];

  for (const file of files) {
    if (/\.snbt$/i.test(file.name)) {
      if (!NON_CHAPTER_SNBT.test(file.name)) entries.push({ name: file.name, text: await file.text() });
    } else {
      requireJSZip();
      entries.push(...await readQuestEntries(await JSZip.loadAsync(file)));
    }
  }

  if (entries.length === 0) throw new Error('No quest chapters found. Expected a .zip with chapters/*.snbt, or chapter .snbt files.');

  const result = parseQuestChapters(entries);
  if (result.chapters.length === 0) throw new Error(`Could not read any chapters. ${result.errors.join(' ')}`);

  if (hasQuests() && !confirm('Importing replaces your current quests. Continue?')) return null;

  applyQuestChapters(result.chapters);
  return `Imported quests: ${describeQuestImport(result)}.`;
}

// ---------------------------------------------------------------------------
// .mrpack
// ---------------------------------------------------------------------------

function readPackSettings(index) {
  const deps = index.dependencies || {};
  const loaderKey = Object.keys(LOADER_KEYS).find(k => deps[k]);
  if (!deps.minecraft || !loaderKey) throw new Error('This pack has no supported mod loader (Fabric, Forge, Quilt or NeoForge).');
  return {
    name: index.name || 'Imported Modpack',
    mcVersion: deps.minecraft,
    loader: LOADER_KEYS[loaderKey],
    loaderVersion: String(deps[loaderKey])
  };
}

const fileBaseName = path => path.split('/').pop().replace(/\.(jar|zip)$/i, '');

function categoryForPath(path, project) {
  if (/^shaderpacks\//i.test(path)) return 'Shader';
  if (/^resourcepacks\//i.test(path)) return 'Resource Pack';
  return project ? primaryCategory(project.categories) : 'Unknown';
}

/** Looks the pack's files up on Modrinth by hash to recover names/categories. Falls back to filenames. */
async function resolvePackFiles(files, settings) {
  let versions = {}, projects = new Map(), lookupFailed = false;

  try {
    versions = await lookupVersionsByHash(files.map(f => f.hashes?.sha1).filter(Boolean));
    const list = await fetchProjects(Object.values(versions).map(v => v.project_id));
    projects = new Map(list.map(p => [p.id, p]));
  } catch (err) {
    console.warn('Modrinth lookup failed, importing with filenames only', err);
    lookupFailed = true;
  }

  const seen = new Set();
  const mods = [];
  for (const file of files) {
    const version = versions[file.hashes?.sha1];
    const project = version && projects.get(version.project_id);
    const id = project?.id ?? `import-${(file.hashes?.sha1 || newId()).slice(0, 16)}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const viaConnector = !!version && CONNECTOR_LOADERS.has(settings.loader)
      && version.loaders.includes('fabric') && !version.loaders.includes(settings.loader);

    mods.push({
      id,
      slug: project?.slug ?? fileBaseName(file.path),
      title: project?.title ?? fileBaseName(file.path),
      category: categoryForPath(file.path, project),
      custom: false,
      source: 'modrinth',
      viaConnector,
      mrpackData: file
    });
  }
  return { mods, lookupFailed };
}

/** @returns {string|null} a summary message, or null if the user cancelled */
export async function importMrPack(file) {
  requireJSZip();
  const zip = await JSZip.loadAsync(file);

  const indexFile = zip.file('modrinth.index.json');
  if (!indexFile) throw new Error('Not a valid .mrpack: modrinth.index.json is missing.');
  const index = JSON.parse(await indexFile.async('string'));
  const settings = readPackSettings(index);

  const questEntries = await readQuestEntries(zip, p => QUESTS_DIR.test(p) && isChapterPath(p));
  const questResult = questEntries.length ? parseQuestChapters(questEntries) : null;
  const importedQuests = questResult && questResult.chapters.length > 0;
  const jars = zip.file(/^overrides\/mods\/[^/]+\.jar$/i);

  if ((state.mods.length > 0 || (importedQuests && hasQuests()))
      && !confirm(`Importing "${settings.name}" replaces your current mods${importedQuests ? ' and quests' : ''}. Continue?`)) {
    return null;
  }

  showProgress('Looking up mods on Modrinth...');
  try {
    const { mods, lookupFailed } = await resolvePackFiles(index.files || [], settings);

    // Mods bundled inside the pack behave like manually uploaded custom mods.
    clearCustomFiles();
    for (const entry of jars) {
      const filename = entry.name.split('/').pop();
      const id = `custom-${newId()}`;
      setCustomFile(id, new File([await entry.async('blob')], filename, { type: 'application/java-archive' }));
      mods.push({ id, slug: filename, title: filename, category: 'Custom', custom: true });
    }

    Object.assign(state, settings, {
      mods,
      sinytraEnabled: CONNECTOR_LOADERS.has(settings.loader) && mods.some(m => m.slug === 'connector')
    });
    if (importedQuests) applyQuestChapters(questResult.chapters);
    saveState();

    const parts = [`Imported "${settings.name}": ${mods.length} mods`];
    if (jars.length) parts.push(`${jars.length} bundled jar${jars.length === 1 ? '' : 's'} (kept for this session only)`);
    if (importedQuests) parts.push(describeQuestImport(questResult));
    if (lookupFailed) parts.push('Modrinth lookup failed, so mods are listed by filename');
    return parts.join(' · ') + '.';
  } finally {
    hideProgress();
  }
}
