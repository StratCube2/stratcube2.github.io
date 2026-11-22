// Files that ride along inside a modpack's override folders but aren't edited as
// mods or quests (configs, scripts, datapacks, options, ...). The importer fills this
// store and the exporter writes it back, so import -> export doesn't lose them.
//
// Keys are the full path inside the .mrpack, e.g. "overrides/config/foo.toml".
// Values are a string (text we generated/parsed), a Blob, or a JSZip entry (lazy, binary-safe)
// that is converted to a Blob and saved to IndexedDB so it survives a page reload.
import { putRecord, deleteRecord, clearStore, getAllRecords } from './storage.js';

const files = new Map();

/** Folders the .mrpack format extracts into the game directory. */
export const OVERRIDE_ROOTS = /^(overrides|client-overrides|server-overrides)\//i;

// Handled elsewhere, so they must not also be copied through as raw files.
const CUSTOM_MOD_JAR = /^overrides\/mods\/[^/]+\.jar$/i;                  // custom mods (state.mods)
const QUEST_CORE = /^overrides\/config\/ftbquests\/quests\/(data\.snbt|chapter_groups\.snbt|chapters\/[^/]+\.snbt)$/i; // quest editor

/** True if a zip path is a plain override file this store should carry through. */
export function isPassthroughPath(path) {
  return OVERRIDE_ROOTS.test(path) && !path.endsWith('/') && !CUSTOM_MOD_JAR.test(path) && !QUEST_CORE.test(path);
}

const listeners = new Set();
export const onOverridesChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach(fn => fn());

/** Stores a file. Lazy zip entries are materialised to Blobs in the background and persisted. */
export function setOverride(path, data) {
  files.set(path, data);
  materialiseAndSave(path, data);
  notify();
}

async function materialiseAndSave(path, data) {
  try {
    const value = typeof data === 'string' || data instanceof Blob ? data : await data.async('blob');
    if (files.get(path) !== data) return; // replaced or removed while we were reading it
    if (value !== data) files.set(path, value);
    await putRecord('overrides', path, value);
  } catch (err) {
    console.warn('Could not persist', path, err);
  }
}

export const removeOverride = path => {
  const had = files.delete(path);
  deleteRecord('overrides', path);
  notify();
  return had;
};
export const clearOverrides = () => { files.clear(); clearStore('overrides'); notify(); };
export const overrideCount = () => files.size;
export const listOverrides = () => [...files.keys()].sort((a, b) => a.localeCompare(b));

/** Size in bytes when known (strings and Blobs); null for entries still waiting to be read. */
export function overrideSize(path) {
  const data = files.get(path);
  if (typeof data === 'string') return new Blob([data]).size;
  return data instanceof Blob ? data.size : null;
}

/** Text content of a stored file, or null if it can't be read as text. */
export async function readOverrideText(path) {
  const data = files.get(path);
  if (data == null) return null;
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text();
  return data.async('string');
}

/** Loads files saved by a previous session. Call once at startup, before anything reads the store. */
export async function hydrateOverrides() {
  const records = await getAllRecords('overrides');
  for (const { key, value } of records) if (!files.has(key)) files.set(key, value);
  if (records.length) notify();
  return records.length;
}

/** Writes every stored file into a JSZip instance. Call before adding generated files so those win. */
export function writeOverrides(zip) {
  for (const [path, data] of files) {
    if (typeof data === 'string') zip.file(path, data);
    else if (data instanceof Blob) zip.file(path, data, { binary: true });
    else zip.file(path, data.async('uint8array'), { binary: true });
  }
}
