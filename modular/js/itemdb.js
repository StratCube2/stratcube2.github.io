// Item/mob database for the quest explorer. It is built from the real contents of the mods in
// the pack: each mod jar is downloaded once, read with jarscan.js, and the result is cached in
// IndexedDB (keyed by file hash, so updating a mod re-scans just that mod). Vanilla Minecraft
// comes from the misode/mcmeta data repo, since vanilla isn't in any mod jar.
import { state, customFiles } from './state.js';
import { escapeHtml } from './utils.js';
import { scanJar, SCAN_VERSION, prettifyId, pngSize } from './jarscan.js';

const MCMETA = 'https://raw.githubusercontent.com/misode/mcmeta';
const DB_NAME = 'modpackgen_items';
const STORE = 'scans';
const CONCURRENCY = 3;
const NOT_MODS = new Set(['Shader', 'Resource Pack']);

// ---------------------------------------------------------------------------
// IndexedDB cache (silently unavailable in private windows; everything still works, just uncached)
// ---------------------------------------------------------------------------

let dbPromise;
function openDb() {
  dbPromise ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

async function cacheGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise(resolve => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result?.v === SCAN_VERSION ? req.result : null);
    req.onerror = () => resolve(null);
  });
}

async function cachePut(record) {
  const db = await openDb();
  if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}

export async function clearItemCache() {
  const db = await openDb();
  if (db) await new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
  cachedKeys = new Set();
  await syncRegistry();
}

// ---------------------------------------------------------------------------
// Registry (what the explorer reads)
// ---------------------------------------------------------------------------

/** @typedef {{ kind: 'item'|'entity', ns: string, id: string, key: string, name: string, hay: string, sort: string, iconUrl: string|null, vanilla: boolean }} Entry */

const emptyRegistry = () => ({ items: new Map(), entities: new Map(), namespaces: new Map(), urls: [], assetsRef: null });
let registry = emptyRegistry();
let cachedKeys = new Set();
let vanillaStatus = 'idle'; // idle | ready | failed
let syncGen = 0;
let lastSignature = null;
const statuses = new Map(); // mod id -> { state: 'scanning'|'failed', message? }
const registryListeners = new Set(); // the registry was rebuilt (items/icons changed)
const statusListeners = new Set();   // scan progress or per-mod status changed

export const onRegistryChange = fn => { registryListeners.add(fn); return () => registryListeners.delete(fn); };
export const onScanStatus = fn => { statusListeners.add(fn); return () => statusListeners.delete(fn); };
const notify = () => registryListeners.forEach(fn => fn());
const notifyStatus = () => statusListeners.forEach(fn => fn());

function makeEntry(kind, ns, id, name, iconUrl, vanilla) {
  return { kind, ns, id, key: `${ns}:${id}`, name, hay: `${name} ${id} ${ns}`.toLowerCase(), sort: name.toLowerCase(), iconUrl, vanilla };
}

function addNamespace(reg, ns, label, kind) {
  let info = reg.namespaces.get(ns);
  if (!info) reg.namespaces.set(ns, info = { label, items: 0, entities: 0 });
  info[kind === 'item' ? 'items' : 'entities']++;
}

function ingestScan(reg, record, title) {
  const urls = new Map();
  const urlFor = key => {
    if (!key || !record.icons?.[key]) return null;
    if (!urls.has(key)) {
      const url = URL.createObjectURL(new Blob([record.icons[key]], { type: 'image/png' }));
      reg.urls.push(url);
      urls.set(key, url);
    }
    return urls.get(key);
  };

  // The jar's main namespace gets the mod's title; extra namespaces (libraries) show their id.
  const entries = Object.entries(record.namespaces);
  const primary = entries.reduce((best, cur) => (!best || cur[1].items.length > best[1].items.length) ? cur : best, null)?.[0];

  for (const [ns, { items, entities }] of entries) {
    const label = ns === primary && title ? title : prettifyId(ns);
    for (const it of items) {
      const entry = makeEntry('item', ns, it.id, it.name, urlFor(it.icon), false);
      if (reg.items.has(entry.key)) continue; // first mod to define an id wins
      reg.items.set(entry.key, entry);
      addNamespace(reg, ns, label, 'item');
    }
    for (const en of entities) {
      const entry = makeEntry('entity', ns, en.id, en.name, null, false);
      if (reg.entities.has(entry.key)) continue;
      reg.entities.set(entry.key, entry);
      addNamespace(reg, ns, label, 'entity');
    }
  }
}

// ---------------------------------------------------------------------------
// Vanilla Minecraft
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

async function loadVanilla(version) {
  const key = `vanilla:${version || 'latest'}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const refs = [];
  if (version) refs.push({ reg: `${version}-registries`, assets: `${version}-assets` });
  refs.push({ reg: 'registries', assets: 'assets' }); // latest data if this version has no tag
  for (const ref of refs) {
    try {
      const [itemIds, entityIds, lang] = await Promise.all([
        fetchJson(`${MCMETA}/${ref.reg}/item/data.json`),
        fetchJson(`${MCMETA}/${ref.reg}/entity_type/data.json`),
        fetchJson(`${MCMETA}/${ref.assets}/assets/minecraft/lang/en_us.json`)
      ]);
      const nameOf = (prefixes, id) => prefixes.map(p => lang[`${p}.minecraft.${id}`]).find(Boolean) ?? prettifyId(id);
      const record = {
        key, v: SCAN_VERSION, assetsRef: ref.assets,
        items: itemIds.map(id => ({ id, name: nameOf(['item', 'block'], id) })),
        entities: entityIds.map(id => ({ id, name: nameOf(['entity'], id) }))
      };
      await cachePut(record);
      return record;
    } catch (err) {
      console.warn('Vanilla data fetch failed for', ref.reg, err);
    }
  }
  return null;
}

function ingestVanilla(reg, record) {
  reg.assetsRef = record.assetsRef;
  const label = 'Minecraft';
  for (const it of record.items) {
    reg.items.set(`minecraft:${it.id}`, makeEntry('item', 'minecraft', it.id, it.name, null, true));
    addNamespace(reg, 'minecraft', label, 'item');
  }
  for (const en of record.entities) {
    reg.entities.set(`minecraft:${en.id}`, makeEntry('entity', 'minecraft', en.id, en.name, null, true));
    addNamespace(reg, 'minecraft', label, 'entity');
  }
}

// ---------------------------------------------------------------------------
// Which pack mods can be scanned
// ---------------------------------------------------------------------------

/** @returns {{ mod: object, key: string|null, url?: string, file?: File, size?: number, reason?: string }[]} */
export function planMods() {
  return state.mods.map(mod => {
    if (NOT_MODS.has(mod.category)) return { mod, key: null, reason: 'not a mod' };
    if (mod.custom) {
      const file = customFiles.find(c => c.id === mod.id)?.file;
      return file
        ? { mod, key: `file:${file.name}:${file.size}:${file.lastModified}`, file, size: file.size }
        : { mod, key: null, reason: 'file is not loaded in this session' };
    }
    const data = mod.mrpackData;
    if (data?.hashes?.sha1 && data.downloads?.[0]) {
      return { mod, key: `modrinth:${data.hashes.sha1}`, url: data.downloads[0], size: data.fileSize || 0 };
    }
    return { mod, key: null, reason: mod.source === 'curseforge' ? "CurseForge files can't be downloaded from the browser" : 'no download link' };
  });
}

const packSignature = () => `${state.mcVersion}|${planMods().map(p => p.key ?? p.mod.id).join(',')}`;

/**
 * Rebuilds the registry from vanilla data plus every pack mod already scanned (cache only, no mod downloads).
 * Cheap to call; does nothing if neither the pack's mods nor its Minecraft version changed.
 */
export async function syncRegistry({ force = false } = {}) {
  const signature = packSignature();
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  const gen = ++syncGen;

  const reg = emptyRegistry();
  const vanilla = await loadVanilla(state.mcVersion);
  vanillaStatus = vanilla ? 'ready' : 'failed';
  if (vanilla) ingestVanilla(reg, vanilla);

  const keys = new Set();
  for (const plan of planMods()) {
    if (!plan.key) continue;
    const record = await cacheGet(plan.key);
    if (!record) continue;
    keys.add(plan.key);
    ingestScan(reg, record, plan.mod.title);
  }

  if (gen !== syncGen) { reg.urls.forEach(u => URL.revokeObjectURL(u)); return; } // a newer sync took over
  registry.urls.forEach(u => URL.revokeObjectURL(u));
  registry = reg;
  cachedKeys = keys;
  notify();
  notifyStatus();
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Shrinks big or animated textures to a single 32px frame so icons stay small. */
async function normalizeIcon(bytes) {
  const size = pngSize(bytes);
  if (!size) return null;
  if (size.w === size.h && size.w <= 32) return bytes;
  if (typeof createImageBitmap !== 'function') return size.w <= 128 ? bytes : null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const side = Math.min(bitmap.width, bitmap.height); // tall images are animation strips: take the first frame
    const out = Math.min(side, 32);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(out, out) : Object.assign(document.createElement('canvas'), { width: out, height: out });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, side, side, 0, 0, out, out);
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** What scanning would do right now, for the panel's button and details list. */
export function describePack() {
  const rows = [];
  let downloadCount = 0, downloadBytes = 0;
  let pendingCount = 0, pendingBytes = 0; // like the above, but without mods whose download already failed
  for (const plan of planMods()) {
    const status = statuses.get(plan.mod.id);
    let stage, detail = '';
    if (status) {
      stage = status.state; detail = status.message ?? '';
      if (stage === 'failed' && plan.key) { downloadCount++; downloadBytes += plan.size || 0; } // a retry would download it again
    }
    else if (!plan.key) { stage = 'skipped'; detail = plan.reason; }
    else if (cachedKeys.has(plan.key)) stage = 'ready';
    else { stage = 'pending'; downloadCount++; downloadBytes += plan.size || 0; pendingCount++; pendingBytes += plan.size || 0; }
    rows.push({ title: plan.mod.title, state: stage, detail });
  }
  return { rows, downloadCount, downloadBytes, pendingCount, pendingBytes, vanillaStatus };
}

/**
 * Dependency metadata of every pack mod that has been scanned (cache only, no downloads).
 * @returns {Promise<{ mod: object, key: string|null, meta: object|null }[]>} meta is null when the mod hasn't been read
 */
export async function getPackMeta() {
  const out = [];
  for (const plan of planMods()) {
    const record = plan.key ? await cacheGet(plan.key) : null;
    out.push({ mod: plan.mod, key: plan.key, meta: record?.meta ?? null, reason: plan.reason });
  }
  return out;
}

/**
 * Downloads and reads every pack mod that isn't cached yet.
 * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void, skipFailed?: boolean }} [options]
 *   `skipFailed` leaves out mods whose last download failed (an automatic scan shouldn't keep retrying them).
 */
export function scanPackMods(options = {}) {
  // One scan at a time: a second caller (auto-scan, the dependency check, the item browser) waits its turn
  // and then only reads what is still missing, so no jar is downloaded twice.
  const run = scanQueue.then(() => scanPackModsNow(options));
  scanQueue = run.catch(() => {});
  return run;
}
let scanQueue = Promise.resolve();

async function scanPackModsNow({ signal, onProgress, skipFailed = false } = {}) {
  if (!window.JSZip) throw new Error('JSZip failed to load, so mods cannot be read.');

  const todo = planMods().filter(p => p.key && !cachedKeys.has(p.key)
    && !(skipFailed && statuses.get(p.mod.id)?.state === 'failed'));
  let done = 0, next = 0;
  onProgress?.(0, todo.length);

  async function worker() {
    while (next < todo.length && !signal?.aborted) {
      const plan = todo[next++];
      statuses.set(plan.mod.id, { state: 'scanning' });
      notifyStatus();
      try {
        let blob = plan.file;
        if (!blob) {
          const res = await fetch(plan.url, { signal });
          if (!res.ok) throw new Error(`download failed (${res.status})`);
          blob = await res.blob();
        }
        const scan = await scanJar(await JSZip.loadAsync(blob), { normalizeIcon, jszip: JSZip });
        await cachePut({ key: plan.key, v: SCAN_VERSION, title: plan.mod.title, ...scan, at: Date.now() });
        cachedKeys.add(plan.key);
        statuses.delete(plan.mod.id);
      } catch (err) {
        if (signal?.aborted) { statuses.delete(plan.mod.id); return; }
        console.warn(`Could not scan ${plan.mod.title}`, err);
        // A blocked download usually shows up as a bare "Failed to fetch" (CORS or network).
        statuses.set(plan.mod.id, { state: 'failed', message: err.message === 'Failed to fetch' ? "couldn't download (blocked or offline)" : err.message });
      }
      onProgress?.(++done, todo.length);
      notifyStatus();
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  await syncRegistry({ force: true });
}

// ---------------------------------------------------------------------------
// Queries and icons
// ---------------------------------------------------------------------------

export const getEntry = (kind, id) => (kind === 'entity' ? registry.entities : registry.items).get(id) ?? null;
export const listNamespaces = () => [...registry.namespaces].map(([ns, info]) => ({ ns, ...info }))
  .sort((a, b) => (a.ns === 'minecraft' ? -1 : b.ns === 'minecraft' ? 1 : a.label.localeCompare(b.label)));
export const hasModData = () => [...registry.namespaces.keys()].some(ns => ns !== 'minecraft');

/** @returns {Entry[]} matches for the query, best first */
export function search({ kind = 'item', query = '', ns = '' } = {}) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const phrase = tokens.join(' ');
  const scored = [];
  for (const entry of (kind === 'entity' ? registry.entities : registry.items).values()) {
    if (ns && entry.ns !== ns) continue;
    if (!tokens.every(t => entry.hay.includes(t))) continue;
    scored.push([phrase ? (entry.sort === phrase ? 0 : entry.sort.startsWith(phrase) ? 1 : entry.sort.includes(phrase) ? 2 : 3) : 0, entry]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].sort.localeCompare(b[1].sort));
  return scored.map(s => s[1]);
}

/** Display name for an item/mob id, falling back to a prettified id when it isn't known. */
export function displayName(kind, id) {
  return getEntry(kind, id)?.name ?? prettifyId((id || '?').split(':').pop());
}

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function vanillaIconUrls(entry) {
  const base = `${MCMETA}/${registry.assetsRef}/assets/minecraft/textures`;
  // Block items usually reuse a block texture, often under a suffixed name.
  return [`item/${entry.id}`, `block/${entry.id}`, `block/${entry.id}_front`, `block/${entry.id}_side`, `block/${entry.id}_top`]
    .map(p => `${base}/${p}.png`);
}

/** HTML for an item's icon. Safe to put in innerHTML. Missing textures degrade to a blank tile (see installIconFallback). */
export function iconHtml(entry, size = 24) {
  const dims = `width="${size}" height="${size}"`;
  if (entry?.kind === 'entity') return `<span class="item-icon ph" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.6)}px">⚔</span>`;
  let src = entry?.iconUrl ?? null, fallbacks = [];
  if (entry?.vanilla && registry.assetsRef) [src, ...fallbacks] = vanillaIconUrls(entry);
  if (!src) return `<span class="item-icon ph" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px">${escapeHtml((entry?.name ?? '?').charAt(0).toUpperCase())}</span>`;
  return `<img class="item-icon" ${dims} alt="" loading="lazy" decoding="async" src="${escapeHtml(src)}"${fallbacks.length ? ` data-fb="${escapeHtml(fallbacks.join('|'))}"` : ''}>`;
}

/** Walks through alternative texture URLs when one 404s, then gives up quietly. Call once at startup. */
export function installIconFallback() {
  document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('item-icon')) return;
    const [next, ...rest] = (img.dataset.fb || '').split('|').filter(Boolean);
    if (next) { img.dataset.fb = rest.join('|'); img.src = next; }
    else { img.classList.add('missing'); img.src = BLANK; }
  }, true);
}
