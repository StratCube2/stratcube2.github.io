import { state } from './state.js';

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

export function fetchModrinthVersionData(slugOrId) {
  const params = new URLSearchParams({
    loaders: JSON.stringify(getLoaders()),
    game_versions: JSON.stringify([state.mcVersion])
  });
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

function toMrpackData(version) {
  const file = version.files.find(f => f.primary) || version.files[0];
  return {
    path: 'mods/' + file.filename,
    hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
    env: { client: 'required', server: 'required' },
    downloads: [file.url],
    fileSize: file.size
  };
}

/**
 * Builds a mod-list entry for a Modrinth project, or null if no compatible version exists.
 * Shared by search, addons, Sinytra auto-install and the dependency resolver.
 */
export async function buildModrinthMod(slugOrId, { category } = {}) {
  const version = pickVersion(await fetchModrinthVersionData(slugOrId));
  if (!version) return null;

  const proj = await fetchModrinthProjectData(slugOrId);
  return {
    id: proj.id,
    slug: proj.slug,
    title: proj.title,
    category: category ?? primaryCategory(proj.categories),
    custom: false,
    source: 'modrinth',
    viaConnector: isViaConnector(version.loaders),
    mrpackData: toMrpackData(version)
  };
}

export async function resolveDependencies() {
  let addedCount = 0;
  const queue = state.mods.filter(m => m.source === 'modrinth').map(m => m.id);
  const processed = new Set(state.mods.map(m => m.id));

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

        state.mods.push(mod);
        addedCount++;
        queue.push(mod.id);
      }
    } catch (e) {
      console.error('Resolver error for', currentId, e);
    }
  }
  return addedCount;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search filters (all optional except `page`):
 * { query, page, sort, categories[], environment, openSource, minDownloads, minFollows }
 */
function buildModrinthFacets(f) {
  const loaderFacet = getLoaders().map(l => `categories:${l}`); // OR group
  const facets = [['project_type:mod'], [`versions:${state.mcVersion}`], loaderFacet];

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

  const params = new URLSearchParams({
    gameId: 432, classId: 6, searchFilter: f.query || '',
    gameVersion: state.mcVersion,
    // CurseForge can't take a loader list, so use "Any" (0) when Sinytra is on.
    modLoaderType: isConnectorActive() ? 0 : (CF_LOADERS[state.loader] || 4),
    sortField: CF_SORT[f.sort] || 2, sortOrder: 'desc',
    index: (f.page - 1) * SEARCH_PAGE_SIZE,
    pageSize: SEARCH_PAGE_SIZE
  });

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
