// Pack Tools: settings the editor turns into config files for specific mods.
// Pure logic only (no DOM) so it can be used by import, export and the panel alike.
import { state, createPackTools } from './state.js';

// ---------------------------------------------------------------------------
// Minimal JSON5 reader (comments + trailing commas), enough for mod configs
// ---------------------------------------------------------------------------

/** Parses JSON that may contain // and block comments and trailing commas. Throws on anything else. */
export function parseJson5(text) {
  text = text.replace(/^\uFEFF/, '');

  // Pass 1: drop comments (never touching string contents)
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c; out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }

  // Pass 2: drop trailing commas before } or ]
  let result = '';
  quote = null;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quote) {
      result += c;
      if (c === '\\') result += out[++i] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c; result += c;
    } else if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] !== '}' && out[j] !== ']') result += c;
    } else {
      result += c;
    }
  }
  return JSON.parse(result);
}

// ---------------------------------------------------------------------------
// You Shall Not Spawn
// ---------------------------------------------------------------------------

const YSNS_DIR = 'overrides/config/ysns/';
const YSNS_DISABLED = `${YSNS_DIR}disabled_entities.json5`;
const YSNS_DIMENSIONS = `${YSNS_DIR}per_dimension_entities.json5`;

const YSNS_DISABLED_TEMPLATE = list => `{
  // ----------------------------------------------------------------------------------------------------------------
  //                                     You Shall Not Spawn by ElocinDev.
  //                                          disabled_entities.json5
  // ----------------------------------------------------------------------------------------------------------------
  //
  // Here you can disable entities from spawning globally, with no exceptions.
  // Format: "modid:entity_name"
  // Example: "minecraft:zombie"
  //
  // Note: As a more advanced method, you can use regex by starting the entry with !
  // Format: "!{Regular expression}"
  // Example: "!minecraft:.*" will disable all entities from minecraft. (NOT RECOMMENDED, JUST AN EXAMPLE)
  //
  "disabled": ${JSON.stringify(list, null, 4)},
  // Don't touch this!
  "CONFIG_VERSION": 1
}`;

const YSNS_DIMENSIONS_TEMPLATE = list => `{
  // ----------------------------------------------------------------------------------------------------------------
  //                                     You Shall Not Spawn by ElocinDev.
  //                                       per_dimension_entities.json5
  // ----------------------------------------------------------------------------------------------------------------
  //
  //  entity: The entity's id you want to adjust. (For example: minecraft:zombie, regex can be used.)
  //  dimension: The dimension id you want to adjust. (For example: minecraft:overworld, regex can be used.)
  //  spawn_chance: The chance of the entity spawning. (For example: 0.1 is 10%, 0.5 is 50%, 0.0 will disable the spawn.)
  //
  //  YSNS CAN'T INCREASE SPAWN RATES! ANYTHING ABOVE 1.0 WILL NOT INCREASE SPAWNRATE!
  //
  // Note: As a more advanced method, you can use regex by starting the entry with !
  // With regex, you can do things such as disabling multiple entities in a single entry, or cover multiple (or all) dimensions
  // Format: "!{Regular expression}"
  // Example: "!minecraft:.*" will disable all entities from minecraft. (NOT RECOMMENDED, JUST AN EXAMPLE)
  //
  // Regex works on both entity and dimension entries.
  "dimensions": ${JSON.stringify(list, null, 4)},
  // Don't touch this!
  "CONFIG_VERSION": 1
}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const isPackToolPath = path => [YSNS_DISABLED, YSNS_DIMENSIONS].includes(path.toLowerCase());

export const resetPackTools = () => { state.packTools = createPackTools(); };

export function packToolsRuleCount() {
  return state.packTools.ysns.disabled.length + state.packTools.ysns.dimensions.length;
}

/** @returns {Record<string, string>} zip path -> file text for every tool that has settings */
export function buildPackToolFiles() {
  const files = {};
  const { disabled, dimensions } = state.packTools.ysns;
  if (disabled.length > 0) files[YSNS_DISABLED] = YSNS_DISABLED_TEMPLATE(disabled);
  if (dimensions.length > 0) {
    files[YSNS_DIMENSIONS] = YSNS_DIMENSIONS_TEMPLATE(
      dimensions.map(({ entity, dimension, spawn_chance }) => ({ entity, dimension, spawn_chance }))
    );
  }
  return files;
}

/**
 * Loads settings from config files found in an imported pack into state.packTools.
 * Files that parse cleanly are "claimed" (the panel owns them from now on); anything
 * else is left for the caller to carry through untouched.
 * @param {{ path: string, text: string }[]} entries
 * @returns {{ claimed: Set<string>, summary: string[], failed: string[] }}
 */
export function readPackTools(entries) {
  const claimed = new Set();
  const failed = [];
  const ysns = state.packTools.ysns;

  for (const { path, text } of entries) {
    const lower = path.toLowerCase();
    try {
      const data = parseJson5(text);
      if (lower === YSNS_DISABLED) {
        if (!Array.isArray(data.disabled) || !data.disabled.every(e => typeof e === 'string')) throw new Error('bad "disabled" list');
        ysns.disabled = [...new Set(data.disabled.map(e => e.trim()).filter(Boolean))];
        claimed.add(path);
      } else if (lower === YSNS_DIMENSIONS) {
        if (!Array.isArray(data.dimensions)) throw new Error('bad "dimensions" list');
        ysns.dimensions = data.dimensions.map(r => {
          const entity = r?.entity ?? r?.entityId;
          const chance = Number(r?.spawn_chance);
          if (typeof entity !== 'string' || typeof r?.dimension !== 'string' || !Number.isFinite(chance)) throw new Error('bad rule');
          return { entity, dimension: r.dimension, spawn_chance: chance };
        });
        claimed.add(path);
      }
    } catch (err) {
      console.warn(`Could not read ${path}, keeping it as a plain file`, err);
      failed.push(path);
    }
  }

  const summary = [];
  if (claimed.size > 0) {
    summary.push(`You Shall Not Spawn: ${ysns.disabled.length} disabled, ${ysns.dimensions.length} per-dimension rule${ysns.dimensions.length === 1 ? '' : 's'}`);
  }
  return { claimed, summary, failed };
}
