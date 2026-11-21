// Reads a mod jar (already opened with JSZip) and works out which items and mobs it adds,
// what they're called, and which texture to use as their icon. Everything comes from the
// jar's own assets/ folder, so nothing here is guessed or hand-maintained:
//   - assets/<ns>/lang/en_us.json            display names ("item.<ns>.<id>", "entity.<ns>.<id>")
//   - assets/<ns>/models/item/*.json         which items exist, and which texture they use
//   - assets/<ns>/items/*.json               same, for Minecraft 1.21.4+
//   - assets/<ns>/textures/{item,block}/...  icon images
// No DOM or browser APIs are used here (icon resizing is injected), so it can run under Node.
import { parseJson5 } from './packtools.js';

export const SCAN_VERSION = 1;

const MAX_ICON_BYTES = 200 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** @returns {{ w: number, h: number } | null} dimensions read straight from the PNG header */
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

export const prettifyId = id => id.split('/').pop().replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const parseJson = text => { try { return JSON.parse(text); } catch { return parseJson5(text); } };

/** Splits "ns:path" (namespace optional) */
function splitRef(ref, defaultNs) {
  const i = ref.indexOf(':');
  return i === -1 ? [defaultNs, ref] : [ref.slice(0, i), ref.slice(i + 1)];
}

// Which texture slot best represents an item, in order of preference.
const TEXTURE_SLOTS = ['layer0', 'all', 'texture', 'top', 'front', 'side', 'particle'];

/** Finds the first string stored under a "model" key anywhere in a 1.21.4+ item definition. */
function findModelRef(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (typeof node.model === 'string') return node.model;
  for (const value of Object.values(node)) {
    const found = findModelRef(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * @param {import('jszip')} zip
 * @param {{ normalizeIcon?: (bytes: Uint8Array) => Promise<Uint8Array|null> }} [options]
 * @returns {Promise<{ namespaces: Record<string, { items: {id:string,name:string,icon:string|null}[], entities: {id:string,name:string}[] }>, icons: Record<string, Uint8Array> }>}
 */
export async function scanJar(zip, { normalizeIcon } = {}) {
  // --- 1. Index the file list by namespace -------------------------------------------------
  const perNs = new Map();
  const names = new Set();
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path].dir) continue;
    names.add(path);
    const m = /^assets\/([^/]+)\/(.+)$/.exec(path);
    if (!m) continue;
    const [, ns, rest] = m;
    if (ns === 'minecraft') continue; // vanilla is handled separately
    let info = perNs.get(ns);
    if (!info) perNs.set(ns, info = { models: new Set(), defs: new Set(), itemTex: new Set() });
    let t;
    if ((t = /^models\/item\/([^/]+)\.json$/.exec(rest))) info.models.add(t[1]);
    else if ((t = /^items\/([^/]+)\.json$/.exec(rest))) info.defs.add(t[1]);
    else if ((t = /^textures\/item\/([^/]+)\.png$/.exec(rest))) info.itemTex.add(t[1]);
  }

  const readText = async path => names.has(path) ? zip.file(path).async('string') : null;
  const modelCache = new Map();

  /** Merged "textures" map of a model and its parents that live inside this jar. */
  async function modelTextures(ref, defaultNs, depth = 0) {
    const [ns, path] = splitRef(ref, defaultNs);
    const file = `assets/${ns}/models/${path}.json`;
    if (modelCache.has(file)) return modelCache.get(file);
    let result = {};
    const text = depth < 5 ? await readText(file) : null;
    if (text) {
      try {
        const json = parseJson(text);
        const inherited = typeof json.parent === 'string' ? await modelTextures(json.parent, ns, depth + 1) : {};
        result = { ...inherited, ...(json.textures || {}) };
      } catch { /* unreadable model, treat as having no textures */ }
    }
    modelCache.set(file, result);
    return result;
  }

  /** @returns {Promise<string|null>} texture ref like "ns:item/foo" */
  async function textureFromModel(modelRef, ns) {
    const textures = await modelTextures(modelRef, ns);
    const resolve = (value, hops = 0) => (typeof value === 'string' && value.startsWith('#') && hops < 4)
      ? resolve(textures[value.slice(1)], hops + 1) : value;
    for (const slot of [...TEXTURE_SLOTS, ...Object.keys(textures)]) {
      const value = resolve(textures[slot]);
      if (typeof value === 'string' && !value.startsWith('#')) return value;
    }
    return null;
  }

  // --- 2. Per namespace: names, item ids, icons ---------------------------------------------
  const out = { namespaces: {}, icons: {} };
  const iconPaths = new Map(); // zip path -> icon key (null if unusable); shared by items using the same texture

  async function loadIcon(zipPath) {
    if (iconPaths.has(zipPath)) return iconPaths.get(zipPath);
    let key = null;
    if (names.has(zipPath)) {
      let bytes = await zip.file(zipPath).async('uint8array');
      if (normalizeIcon) bytes = await normalizeIcon(bytes);
      if (bytes && bytes.length <= MAX_ICON_BYTES) {
        key = zipPath.slice('assets/'.length);
        out.icons[key] = bytes;
      }
    }
    iconPaths.set(zipPath, key);
    return key;
  }

  let processed = 0;
  for (const [ns, info] of perNs) {
    // Display names
    const langText = await readText(`assets/${ns}/lang/en_us.json`);
    const itemNames = new Map(), blockNames = new Map(), entityNames = new Map();
    if (langText) {
      try {
        for (const [key, value] of Object.entries(parseJson(langText))) {
          if (typeof value !== 'string') continue;
          const m = /^(item|block|entity)\.([^.]+)\.([^.]+)$/.exec(key); // ids with extra dots are tooltips/variants
          if (!m || m[2] !== ns) continue;
          (m[1] === 'item' ? itemNames : m[1] === 'block' ? blockNames : entityNames).set(m[3], value);
        }
      } catch (err) { console.warn(`Could not read lang for ${ns}`, err); }
    }

    // Item ids: anything the jar defines a model for or names in its lang file.
    const ids = new Set([...itemNames.keys(), ...blockNames.keys(), ...info.models, ...info.defs]);
    // Only a texture folder to go on (no lang, no models)? Fall back to the texture names.
    if (ids.size === 0) info.itemTex.forEach(id => ids.add(id));

    const items = [];
    for (const id of [...ids].sort()) {
      if (++processed % 40 === 0) await new Promise(r => setTimeout(r)); // keep the page responsive

      // Work out which texture represents the item.
      let texRef = null;
      try {
        if (info.defs.has(id)) {
          const def = await readText(`assets/${ns}/items/${id}.json`);
          const modelRef = def && findModelRef(parseJson(def));
          if (modelRef) texRef = await textureFromModel(modelRef, ns);
        }
        if (!texRef && info.models.has(id)) texRef = await textureFromModel(`${ns}:item/${id}`, ns);
      } catch { /* fall through to filename guesses */ }

      const candidates = [];
      if (texRef) { const [tns, tpath] = splitRef(texRef, ns); candidates.push(`assets/${tns}/textures/${tpath}.png`); }
      for (const p of [`item/${id}`, `block/${id}`, `block/${id}_front`, `block/${id}_side`, `block/${id}_top`]) {
        candidates.push(`assets/${ns}/textures/${p}.png`);
      }
      let icon = null;
      for (const candidate of candidates) {
        if (names.has(candidate) && (icon = await loadIcon(candidate))) break;
      }

      items.push({ id, name: itemNames.get(id) ?? blockNames.get(id) ?? prettifyId(id), icon });
    }

    const entities = [...entityNames].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
    if (items.length || entities.length) out.namespaces[ns] = { items, entities };
  }
  return out;
}
