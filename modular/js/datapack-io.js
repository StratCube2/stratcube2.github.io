// Glue between the datapack model and the rest of the app: texture storage and export-time generation.
// No DOM here, so export.js can use it too.
import { state } from './state.js';
import { buildDatapack, toOverridePaths, conflictingPaths, PAXI_SLUG } from './datapack.js';
import { listOverrides } from './overrides.js';
import { putRecord, deleteRecord, getAllRecords } from './storage.js';

/** Custom item textures by item id. Loaded from IndexedDB at startup. */
export const textureCache = new Map();

export async function hydrateTextures() {
  for (const { key, value } of await getAllRecords('textures')) textureCache.set(key, value);
}

export async function saveTexture(itemId, blob) {
  textureCache.set(itemId, blob);
  await putRecord('textures', itemId, blob);
}

export async function removeTexture(itemId) {
  textureCache.delete(itemId);
  await deleteRecord('textures', itemId);
}

/** Moves a texture to a new item id (the user renamed the item). */
export async function renameTexture(from, to) {
  const blob = textureCache.get(from);
  if (!blob || from === to) return;
  await removeTexture(from);
  await saveTexture(to, blob);
}

export const hasPaxi = () => state.mods.some(m => m.slug === PAXI_SLUG);

/** Runs the builder against the current state. Cheap enough to call on every edit. */
export function generate() {
  const built = buildDatapack(state.datapack, {
    mcVersion: state.mcVersion, loader: state.loader, name: state.name, textures: textureCache
  });
  const overrides = toOverridePaths(built.files, state.name);
  return { ...built, overrides, conflicts: conflictingPaths(listOverrides(), overrides) };
}

/** Checks that a file really is a PNG. Item textures must be, or the resource pack silently breaks. */
export async function isPng(blob) {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b);
}
