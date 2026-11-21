// Files that ride along inside a modpack's override folders but aren't edited as
// mods or quests (configs, scripts, datapacks, options, ...). The importer fills this
// store and the exporter writes it back, so import -> export doesn't lose them.
//
// Keys are the full path inside the .mrpack, e.g. "overrides/config/foo.toml".
// Values are either a string (text we generated/parsed) or a JSZip entry (lazy, binary-safe).
// Held in memory only, like bundled mod jars: a page reload clears it.

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

export const setOverride = (path, data) => { files.set(path, data); };
export const removeOverride = path => files.delete(path);
export const clearOverrides = () => files.clear();
export const overrideCount = () => files.size;
export const listOverrides = () => [...files.keys()].sort((a, b) => a.localeCompare(b));

/** Writes every stored file into a JSZip instance. Call before adding generated files so those win. */
export function writeOverrides(zip) {
  for (const [path, data] of files) {
    zip.file(path, typeof data === 'string' ? data : data.async('uint8array'), { binary: typeof data !== 'string' });
  }
}
