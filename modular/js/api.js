import { state } from './state.js';
import { PROJECT_TYPES, typeOf } from './project-types.js';

const MODRINTH = 'https://api.modrinth.com/v2';
const KNOWN_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
const SINYTRA_LOADERS = new Set(['forge', 'neoforge']);
// Fabric API is replaced by Forgified Fabric API when Sinytra Connector is active.
const FABRIC_API_ID = 'P7dR8mSH';

export const SEARCH_PAGE_SIZE = 20;

const cache = new Map();

async function cachedFetch(url, signal) {
  if (cache.has(url)) return cache.get(url);

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  const data = await res.json();

  cache.set(url, data);
  return data;
}

const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Loader / Sinytra helpers
// ---------------------------------------------------------------------------

/** True when Fabric mods are allowed on a Forge/NeoForge pack via Sinytra Connector. */
export function isConnectorActive() {
  return state.sinytraEnabled && SINYTRA_LOADERS.has(state.loader);
}

/** Loaders to request from Modrinth. The pack's own loader always comes first. */
export function getLoaders() {
  return isConnectorActive() ? [state.loader, 'fabric'] : [state.loader];
}

/**
 * Picks the best version from a Modrinth version list.
 * Modrinth returns versions newest-first across *all* requested loaders, so with
 * Sinytra on, blindly taking [0] would often select the Fabric build. Prefer the
 * newest build for the pack's real loader and only fall back to Fabric if none exists.
 */
export function pickVersion(versions) {
  if (!versions || versions.length === 0) return null;
  return versions.find(v => v.loaders?.includes(state.loader)) || versions[0];
}

/** True if a picked version/hit is only available through Sinytra (i.e. it's a Fabric mod). */
export function isViaConnector(loaders) {
  return isConnectorActive() && !!loaders && !loaders.includes(state.loader);
}

// ---------------------------------------------------------------------------
// Modrinth: projects & versions
// ---------------------------------------------------------------------------

export async function fetchGameVersions() {
  try {
    const data = await cachedFetch(`${MODRINTH}/tag/game_version`);
    return data.filter(v => v.version_type === 'release').map(v => v.version);
  } catch (err) {
    console.error('Failed to fetch game versions', err);
    return [];
  }
}

/** Loader filter for a project type: the pack's loaders for mods, "datapack" for datapacks, none otherwise. */
function loadersFor(type) {
  if (type === 'mod') return getLoaders();
  return PROJECT_TYPES[type]?.loaders || null;
}

export function fetchModrinthVersionData(slugOrId, type = 'mod') {
  const loaders = loadersFor(type);
  const params = new URLSearchParams({ game_versions: JSON.stringify([state.mcVersion]) });
  if (loaders) params.set('loaders', JSON.stringify(loaders));
  return cachedFetch(`${MODRINTH}/project/${slugOrId}/version?${params}`);
}

export function fetchModrinthProjectData(slugOrId) {
  return cachedFetch(`${MODRINTH}/project/${slugOrId}`);
}

/** First real category in a list (Modrinth search hits mix loaders into `categories`). */
export function primaryCategory(categories = []) {
  if (categories.includes('shader')) return 'Shader';
  const cat = categories.find(c => !KNOWN_LOADERS.has(c));
  return capitalize(cat || 'utility');
}

function toMrpackData(version, type = 'mod') {
  const file = version.files.find(f => f.primary) || version.files[0];
  const info = PROJECT_TYPES[type] || PROJECT_TYPES.mod;
  return {
    path: `${info.dir}/${file.filename}`,
    hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
    env: { ...info.env },
    downloads: [file.url],
    fileSize: file.size
  };
}

/**
 * Builds a mod-list entry for a Modrinth project, or null if no compatible version exists.
 * Shared by search, addons, Sinytra auto-install and the dependency resolver.
 */
export async function buildModrinthMod(slugOrId, { category, type = 'mod' } = {}) {
  const version = pickVersion(await fetchModrinthVersionData(slugOrId, type));
  if (!version) return null;

  const proj = await fetchModrinthProjectData(slugOrId);
  return {
    id: proj.id,
    slug: proj.slug,
    title: proj.title,
    type,
    category: category ?? (type === 'mod' ? primaryCategory(proj.categories) : PROJECT_TYPES[type].singular),
    custom: false,
    source: 'modrinth',
    viaConnector: type === 'mod' && isViaConnector(version.loaders),
    mrpackData: toMrpackData(version, type)
  };
}

/** Whether a mod has a usable version for the current MC version / loader setup. */
export async function checkModAvailability(slug) {
  try {
    const version = pickVersion(await fetchModrinthVersionData(slug));
    return version
      ? { available: true, viaConnector: isViaConnector(version.loaders) }
      : { available: false };
  } catch {
    return { available: false }; // unknown slug or API error
  }
}

const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/** Maps SHA-1 hashes of mod files to the Modrinth versions they belong to: { [sha1]: version } */
export async function lookupVersionsByHash(hashes) {
  const result = {};
  for (const batch of chunk([...new Set(hashes)], 200)) {
    const res = await fetch(`${MODRINTH}/version_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: batch, algorithm: 'sha1' })
    });
    if (!res.ok) throw new Error(`Modrinth API Error: ${res.status}`);
    Object.assign(result, await res.json());
  }
  return result;
}

export async function fetchProjects(ids) {
  const projects = [];
  for (const batch of chunk([...new Set(ids)], 100)) {
    projects.push(...await cachedFetch(`${MODRINTH}/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`));
  }
  return projects;
}

/**
 * Adds the required Modrinth dependencies of pack mods (and of whatever that pulls in).
 * @param {{ only?: string[] }} [options] start from just these project ids instead of every Modrinth mod in the pack
 * @returns {Promise<object[]>} the mod entries that were added to the pack
 */
export async function resolveDependencies({ only } = {}) {
  const added = [];
  // Dependencies are only followed for mods; shaders, resource packs and datapacks are left as picked.
  const queue = only ? [...only] : state.mods.filter(m => m.source === 'modrinth' && typeOf(m) === 'mod').map(m => m.id);
  const processed = new Set(state.mods.map(m => m.id));
  const parentTitle = new Map(state.mods.map(m => [m.id, m.title]));

  while (queue.length > 0) {
    const currentId = queue.shift();
    try {
      const version = pickVersion(await fetchModrinthVersionData(currentId));
      if (!version?.dependencies) continue;

      for (const dep of version.dependencies) {
        if (dep.dependency_type !== 'required' || !dep.project_id || processed.has(dep.project_id)) continue;
        processed.add(dep.project_id);

        // Forgified Fabric API (installed with Sinytra) already covers Fabric API.
        if (isConnectorActive() && dep.project_id === FABRIC_API_ID) continue;

        const mod = await buildModrinthMod(dep.project_id);
        if (!mod) continue;

        mod.addedAsDependencyOf = parentTitle.get(currentId) ?? null;
        state.mods.push(mod);
        parentTitle.set(mod.id, mod.title);
        added.push(mod);
        queue.push(mod.id);
      }
    } catch (e) {
      console.error('Resolver error for', currentId, e);
    }
  }
  return added;
}

/**
 * Finds Modrinth projects that might ship the mod with this mod id (the id from fabric.mod.json
 * or mods.toml). Modrinth has no lookup by mod id, so this guesses from the slug and a search;
 * the caller must confirm a candidate by reading its jar, because a slug can match an unrelated mod.
 * @returns {Promise<string[]>} project ids, best guess first (at most `limit`)
 */
export async function findModrinthCandidates(modId, { limit = 3 } = {}) {
  const ids = [];
  const slugs = [...new Set([modId, modId.replace(/_/g, '-'), modId.replace(/-/g, '_')])];
  for (const slug of slugs) {
    try {
      const proj = await fetchModrinthProjectData(slug);
      if (proj?.project_type === 'mod' && !ids.includes(proj.id)) ids.push(proj.id);
    } catch { /* not a slug; try the next spelling */ }
    if (ids.length) break;
  }

  if (ids.length < limit) {
    try {
      const facets = [['project_type:mod'], [`versions:${state.mcVersion}`], getLoaders().map(l => `categories:${l}`)];
      const params = new URLSearchParams({ query: modId.replace(/[_-]+/g, ' '), facets: JSON.stringify(facets), limit: 5 });
      const res = await fetch(`${MODRINTH}/search?${params}`);
      if (res.ok) {
        const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const target = norm(modId);
        const hits = (await res.json()).hits || [];
        // Hits whose slug or title mentions the id first; Modrinth's own ranking breaks ties.
        hits.sort((a, b) => Number(norm(b.slug).includes(target) || norm(b.title).includes(target))
                          - Number(norm(a.slug).includes(target) || norm(a.title).includes(target)));
        for (const h of hits) if (!ids.includes(h.project_id)) ids.push(h.project_id);
      }
    } catch (err) { console.warn('Modrinth search failed for', modId, err); }
  }
  return ids.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search filters (all optional except `page`):
 * { query, page, type, sort, categories[], environment, openSource, minDownloads, minFollows }
 */
function buildModrinthFacets(f) {
  const type = PROJECT_TYPES[f.type] ? f.type : 'mod';
  const facets = [[`project_type:${PROJECT_TYPES[type].modrinth}`], [`versions:${state.mcVersion}`]];
  // Only mods are tied to the pack's loader; shaders, resource packs and datapacks work with any.
  if (type === 'mod') facets.push(getLoaders().map(l => `categories:${l}`)); // OR group

  (f.categories || []).forEach(c => facets.push([`categories:${c}`])); // AND between categories

  if (f.environment === 'client') facets.push(['client_side:required', 'client_side:optional']);
  if (f.environment === 'server') facets.push(['server_side:required', 'server_side:optional']);
  if (f.openSource) facets.push(['open_source:true']);
  if (f.minDownloads > 0) facets.push([`downloads>=${f.minDownloads}`]);
  if (f.minFollows > 0) facets.push([`follows>=${f.minFollows}`]);
  return facets;
}

export async function searchModrinth(f, signal) {
  const params = new URLSearchParams({
    query: f.query || '',
    facets: JSON.stringify(buildModrinthFacets(f)),
    index: f.sort || 'relevance',
    offset: (f.page - 1) * SEARCH_PAGE_SIZE,
    limit: SEARCH_PAGE_SIZE
  });

  const res = await fetch(`${MODRINTH}/search?${params}`, { signal });
  if (!res.ok) throw new Error(`Modrinth API Error: ${res.status}`);
  const data = await res.json();
  return { hits: data.hits, total: data.total_hits };
}

// CurseForge sortField values
const CF_SORT = { relevance: 2, follows: 2, downloads: 6, newest: 11, updated: 3 };
const CF_LOADERS = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

export async function searchCurseForge(f, signal) {
  let apiKey = localStorage.getItem('cf_api_key');
  if (!apiKey) {
    apiKey = prompt('CurseForge API requires an API key.\nEnter your key:');
    if (!apiKey) throw new Error('No API Key');
    localStorage.setItem('cf_api_key', apiKey);
  }

  const type = PROJECT_TYPES[f.type] ? f.type : 'mod';
  const params = new URLSearchParams({
    gameId: 432, classId: PROJECT_TYPES[type].curseforgeClass, searchFilter: f.query || '',
    gameVersion: state.mcVersion,
    sortField: CF_SORT[f.sort] || 2, sortOrder: 'desc',
    index: (f.page - 1) * SEARCH_PAGE_SIZE,
    pageSize: SEARCH_PAGE_SIZE
  });
  // CurseForge can't take a loader list, so use "Any" (0) when Sinytra is on. Only mods have loaders.
  if (type === 'mod') params.set('modLoaderType', isConnectorActive() ? 0 : (CF_LOADERS[state.loader] || 4));

  const res = await fetch(`https://api.curseforge.com/v1/mods/search?${params}`, {
    signal,
    headers: { 'x-api-key': apiKey, 'Accept': 'application/json' }
  });

  if (!res.ok) {
    if (res.status === 403) localStorage.removeItem('cf_api_key');
    throw new Error('CORS or Invalid Key');
  }
  const data = await res.json();
  return { hits: data.data, total: data.pagination?.totalCount ?? data.data.length };
}
