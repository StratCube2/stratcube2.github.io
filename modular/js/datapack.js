// Datapack editor core: data model, version rules, and the builder that turns the model into files.
// Pure logic (no DOM, no state import) so the importer, exporter and UI can all use it.
//
// Everything generated here is loaded in-game through Paxi (config/paxi/datapacks and
// config/paxi/resourcepacks), which applies packs to every world.

export const PAXI_SLUG = 'paxi';
export const DEFAULT_NAMESPACE = 'modular';

// ---------------------------------------------------------------------------
// Minecraft version rules
// ---------------------------------------------------------------------------

/** Parses "1.20.1" -> [1, 20, 1]. Returns null for snapshots and anything non-numeric. */
export function parseMc(version) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/**
 * What the datapack builder needs to know about a Minecraft version.
 * `known` is false for versions this editor hasn't been checked against; the numbers are then a best guess.
 */
export function mcRules(version) {
  const v = parseMc(version);
  if (!v || v[0] !== 1) return { known: false, singular: true, components: true, dataFormat: 48, resFormat: 34 };
  const [, minor, patch] = v;
  const at = (m, p = 0) => minor > m || (minor === m && patch >= p);
  let dataFormat, resFormat, known = true;
  if (!at(20, 2)) { dataFormat = 15; resFormat = 15; if (minor < 20) known = false; }
  else if (!at(20, 3)) { dataFormat = 18; resFormat = 18; }
  else if (!at(20, 5)) { dataFormat = 26; resFormat = 22; }
  else if (!at(21)) { dataFormat = 41; resFormat = 32; }
  else if (!at(21, 2)) { dataFormat = 48; resFormat = 34; }
  else if (!at(21, 4)) { dataFormat = 57; resFormat = 42; }
  else { dataFormat = 57; resFormat = 42; known = false; }
  return {
    known,
    singular: at(21),      // 1.21 renamed data folders: recipes -> recipe, loot_tables -> loot_table, tags/items -> tags/item
    components: at(20, 5), // 1.20.5 replaced item NBT with data components
    resultId: at(20, 5),   // recipe/advancement item stacks use "id" instead of "item"
    cookingResultObject: at(21),
    dataFormat, resFormat
  };
}

// ---------------------------------------------------------------------------
// Worldgen targets
// ---------------------------------------------------------------------------

/** The worldgen setups this editor knows how to configure, by Minecraft version. */
export const WORLDGEN_PROFILES = {
  '1.20.1': {
    label: 'Terralith 2.5.4 + Tectonic (5373b2)',
    mods: [
      {
        name: 'Terralith',
        slug: 'terralith',
        role: 'Biomes & Caves',
        description: 'Overhauls the Overworld with 95+ biomes, new caves, and dramatic landmarks using vanilla blocks.',
        note: 'Optional · Datapack/mod',
        url: 'https://modrinth.com/mod/terralith'
      },
      {
        name: 'Tectonic',
        slug: 'tectonic',
        role: 'Terrain & Height',
        description: 'Adds towering mountain ranges, deep oceans, underground rivers, and smooth continental terrain.',
        note: 'Configurable below',
        url: 'https://modrinth.com/mod/tectonic'
      }
    ],
    rewrite: false
  },
  '1.21.1': {
    label: 'Tectonic rewrite squared',
    mods: [
      {
        name: 'Tectonic',
        slug: 'tectonic',
        role: 'Terrain & Height',
        description: 'Rebuilt terrain engine with smoother continents, deeper oceans, configurable elevation, and ore fixes.',
        note: 'Configurable below',
        url: 'https://modrinth.com/mod/tectonic'
      }
    ],
    rewrite: true
  }
};

export const worldgenProfile = mc => WORLDGEN_PROFILES[String(mc || '').trim()] ?? null;

/**
 * Options of config/tectonic.json. Names and defaults come from Tectonic's ConfigState codecs
 * (both targets). Options marked `rewrite` only exist in the rewrite.
 */
export const TECTONIC_OPTIONS = [
  { path: 'general.snow_start_offset', label: 'Snow start offset', type: 'int', def: 128 },
  { path: 'global_terrain.vertical_scale', label: 'Vertical scale', type: 'number', def: 1.125, step: 0.025 },
  { path: 'global_terrain.elevation_boost', label: 'Elevation boost', type: 'number', def: 0, step: 0.05 },
  { path: 'global_terrain.lava_tunnels', label: 'Lava tunnels', type: 'bool', def: true },
  { path: 'global_terrain.ultrasmooth', label: 'Ultrasmooth terrain', type: 'bool', def: false },
  { path: 'continents.ocean_offset', label: 'Ocean offset', type: 'number', def: -0.8, step: 0.05 },
  { path: 'continents.continents_scale', label: 'Continents scale', type: 'number', def: 0.13, step: 0.01 },
  { path: 'continents.erosion_scale', label: 'Erosion scale', type: 'number', def: 0.25, step: 0.01 },
  { path: 'continents.ridge_scale', label: 'Ridge scale', type: 'number', def: 0.25, step: 0.01 },
  { path: 'continents.flat_terrain_skew', label: 'Flat terrain skew', type: 'number', def: 0.1, step: 0.05 },
  { path: 'continents.underground_rivers', label: 'Underground rivers', type: 'bool', def: true },
  { path: 'continents.river_lanterns', label: 'River lanterns', type: 'bool', def: true },
  { path: 'continents.river_ice', label: 'River ice', type: 'bool', def: false, rewrite: true },
  { path: 'continents.rolling_hills', label: 'Rolling hills', type: 'bool', def: true },
  { path: 'continents.jungle_pillars', label: 'Jungle pillars', type: 'bool', def: true },
  { path: 'islands.enabled', label: 'Islands', type: 'bool', def: true },
  { path: 'oceans.ocean_depth', label: 'Ocean depth', type: 'number', def: -0.22, step: 0.01 },
  { path: 'oceans.deep_ocean_depth', label: 'Deep ocean depth', type: 'number', def: -0.45, step: 0.01 },
  { path: 'oceans.remove_frozen_ocean_ice', label: 'Remove frozen ocean ice', type: 'bool', def: false },
  { path: 'caves.depth_cutoff_start', label: 'Cave depth cutoff start', type: 'number', def: 0.1, step: 0.01 },
  { path: 'caves.depth_cutoff_size', label: 'Cave depth cutoff size', type: 'number', def: 0.1, step: 0.01 },
  { path: 'caves.cheese_enabled', label: 'Cheese caves', type: 'bool', def: true },
  { path: 'caves.cheese_additive', label: 'Cheese cave additive', type: 'number', def: 0.27, step: 0.01 },
  { path: 'caves.noodle_enabled', label: 'Noodle caves', type: 'bool', def: true },
  { path: 'caves.noodle_additive', label: 'Noodle cave additive', type: 'number', def: -0.075, step: 0.005 },
  { path: 'caves.spaghetti_enabled', label: 'Spaghetti caves', type: 'bool', def: true },
  { path: 'caves.carvers_enabled', label: 'Vanilla carvers', type: 'bool', def: true },
  { path: 'caves.ore_fix', label: 'Ore fix', type: 'bool', def: false, rewrite: true }
];

export const tectonicOptionsFor = profile => TECTONIC_OPTIONS.filter(o => !o.rewrite || profile?.rewrite);

/** Builds config/tectonic.json text from the user's changed options, or null if nothing changed. */
export function buildTectonicConfig(overrides, profile) {
  const allowed = new Map(tectonicOptionsFor(profile).map(o => [o.path, o]));
  const changed = Object.entries(overrides || {}).filter(([path, value]) => {
    const opt = allowed.get(path);
    return opt && value !== opt.def && (opt.type === 'bool' ? typeof value === 'boolean' : Number.isFinite(value));
  });
  if (!changed.length) return null;
  // "general" is required by Tectonic's codec; minor_version 1 stops it applying legacy ultrasmooth height fixes.
  const config = { minor_version: 1, general: { mod_enabled: true, snow_start_offset: 128 } };
  for (const [path, value] of changed) {
    const [section, key] = path.split('.');
    (config[section] ??= {})[key] = value;
  }
  return JSON.stringify(config, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const createDatapack = () => ({
  namespace: DEFAULT_NAMESPACE,
  recipes: [],
  tags: [],
  lootTables: [],
  advancements: [],
  items: [],
  tectonic: {},
  rawFiles: []
});

const arr = v => (Array.isArray(v) ? v : []);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Fills in anything missing so saves from older versions (or bad data) can't break the editor. */
export function normalizeDatapack(raw) {
  const dp = createDatapack();
  if (!raw || typeof raw !== 'object') return dp;
  dp.namespace = /^[a-z0-9_.-]+$/.test(str(raw.namespace)) ? raw.namespace : DEFAULT_NAMESPACE;
  dp.recipes = arr(raw.recipes).filter(r => r && typeof r.id === 'string').map(r => ({
    id: r.id, type: str(r.type, 'shaped'),
    grid: Array.from({ length: 9 }, (_, i) => str(arr(r.grid)[i]) || ''),
    ingredients: arr(r.ingredients).map(i => str(i)).filter(Boolean),
    ingredient: str(r.ingredient),
    result: { id: str(obj(r.result).id), custom: str(obj(r.result).custom), count: num(obj(r.result).count, 1) },
    experience: num(r.experience, 0.1), cookingtime: num(r.cookingtime, 200)
  }));
  dp.tags = arr(raw.tags).filter(t => t && typeof t.id === 'string').map(t => ({
    id: t.id, kind: str(t.kind, 'item'), replace: !!t.replace, values: arr(t.values).map(v => str(v)).filter(Boolean)
  }));
  dp.lootTables = arr(raw.lootTables).filter(t => t && typeof t.id === 'string').map(t => ({
    id: t.id, type: str(t.type, 'generic'),
    pools: arr(t.pools).map(p => ({
      rollsMin: num(obj(p).rollsMin, 1), rollsMax: num(obj(p).rollsMax, 1),
      entries: arr(obj(p).entries).map(e => ({
        item: str(obj(e).item), custom: str(obj(e).custom), weight: num(obj(e).weight, 1),
        min: num(obj(e).min, 1), max: num(obj(e).max, 1)
      }))
    }))
  }));
  dp.advancements = arr(raw.advancements).filter(a => a && typeof a.id === 'string').map(a => ({
    id: a.id, parent: str(a.parent), title: str(a.title), description: str(a.description), icon: str(a.icon, 'minecraft:stone'),
    frame: str(a.frame, 'task'), trigger: str(a.trigger, 'inventory_changed'), item: str(a.item),
    toast: a.toast !== false, announce: a.announce !== false,
    rewardXp: num(a.rewardXp, 0), rewardRecipes: arr(a.rewardRecipes).map(x => str(x)).filter(Boolean),
    rewardLoot: arr(a.rewardLoot).map(x => str(x)).filter(Boolean)
  }));
  dp.items = arr(raw.items).filter(i => i && typeof i.id === 'string').map(i => ({
    id: i.id, base: str(i.base, 'minecraft:paper'), name: str(i.name), customModelData: num(i.customModelData, 1),
    extra: str(i.extra), hasTexture: !!i.hasTexture
  }));
  dp.tectonic = Object.fromEntries(Object.entries(obj(raw.tectonic)).filter(([, v]) => typeof v === 'boolean' || Number.isFinite(v)));
  dp.rawFiles = arr(raw.rawFiles).filter(f => f && typeof f.path === 'string').map(f => ({ path: f.path, content: str(f.content) }));
  return dp;
}

/** Number of things the user has authored (not counting settings left at defaults). */
export function datapackContentCount(dp) {
  return dp.recipes.length + dp.tags.length + dp.lootTables.length + dp.advancements.length + dp.items.length + dp.rawFiles.length;
}

export const hasTectonicChanges = dp => Object.keys(dp.tectonic || {}).length > 0;

// ---------------------------------------------------------------------------
// Ids and text helpers
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const PATH_RE = /^[a-z0-9_./-]+$/;

/** "ns:path" with the default namespace filled in for a bare "path". */
export const qualify = (id, ns) => {
  const s = String(id || '').trim();
  return s.includes(':') ? s : `${ns}:${s}`;
};
export const isValidId = id => ID_RE.test(String(id || ''));
export const splitId = id => { const i = id.indexOf(':'); return [id.slice(0, i), id.slice(i + 1)]; };
export const isTagRef = s => String(s).startsWith('#');

const textComponent = text => ({ text, italic: false });
const snbtString = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const HANDHELD = /_(sword|pickaxe|axe|shovel|hoe)$|^minecraft:(stick|blaze_rod|bone|fishing_rod|carrot_on_a_stick|warped_fungus_on_a_stick|breeze_rod|trident)$/;
/** Best guess of an item's base model parent, for the model override we write. */
export const baseParent = base => (HANDHELD.test(base) ? 'minecraft:item/handheld' : 'minecraft:item/generated');

// ---------------------------------------------------------------------------
// Custom items: a vanilla item with a name, custom model data and optional extra data
// ---------------------------------------------------------------------------

const customItemById = (dp, id) => dp.items.find(i => i.id === id);

/** The item stack data for a custom item, in the shape the Minecraft version uses. */
function customStack(item, rules) {
  const name = item.name.trim();
  if (rules.components) {
    const components = { 'minecraft:custom_model_data': item.customModelData };
    if (name) components['minecraft:custom_name'] = textComponent(name);
    if (item.extra.trim()) Object.assign(components, JSON.parse(item.extra));
    return { components };
  }
  const parts = [`CustomModelData:${item.customModelData}`];
  if (name) parts.push(`display:{Name:${snbtString(JSON.stringify(textComponent(name)))}}`);
  if (item.extra.trim()) parts.push(item.extra.trim().replace(/^,|,$/g, ''));
  return { nbt: `{${parts.join(',')}}` };
}

function validateCustomItem(item, rules, issues) {
  const where = `Item ${item.id}`;
  if (!PATH_RE.test(item.id)) issues.push({ level: 'error', where, message: 'Item id may only use a-z, 0-9, _ . / -' });
  if (!isValidId(item.base)) issues.push({ level: 'error', where, message: 'Base item must look like minecraft:paper.' });
  if (!Number.isInteger(item.customModelData) || item.customModelData < 0) issues.push({ level: 'error', where, message: 'Custom model data must be a whole number.' });
  if (!rules.known) issues.push({ level: 'warn', where, message: 'This Minecraft version has not been checked; item data may not match.' });
  if (item.extra.trim() && rules.components) {
    try { if (typeof JSON.parse(item.extra) !== 'object') throw 0; }
    catch { issues.push({ level: 'error', where, message: 'Extra data must be a JSON object of components, e.g. {"minecraft:unbreakable":{}}.' }); }
  }
  return !issues.some(i => i.level === 'error' && i.where === where);
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export const RECIPE_TYPES = {
  shaped: { label: 'Shaped crafting', json: 'minecraft:crafting_shaped' },
  shapeless: { label: 'Shapeless crafting', json: 'minecraft:crafting_shapeless' },
  smelting: { label: 'Smelting', json: 'minecraft:smelting', cooking: true, defaultTime: 200 },
  blasting: { label: 'Blasting', json: 'minecraft:blasting', cooking: true, defaultTime: 100 },
  smoking: { label: 'Smoking', json: 'minecraft:smoking', cooking: true, defaultTime: 100 },
  campfire: { label: 'Campfire cooking', json: 'minecraft:campfire_cooking', cooking: true, defaultTime: 600 },
  stonecutting: { label: 'Stonecutting', json: 'minecraft:stonecutting' }
};

const ingredientJson = ref => (isTagRef(ref) ? { tag: ref.slice(1) } : { item: ref });

/** Turns a 3x3 grid of ingredient refs into a trimmed pattern and key. Returns null for an empty grid. */
export function shapedFromGrid(grid) {
  const cells = Array.from({ length: 9 }, (_, i) => grid[i] || '');
  const rows = [0, 1, 2].filter(r => cells.slice(r * 3, r * 3 + 3).some(Boolean));
  const cols = [0, 1, 2].filter(c => [0, 1, 2].some(r => cells[r * 3 + c]));
  if (!rows.length) return null;
  const letters = new Map();
  const letterFor = ref => {
    if (!letters.has(ref)) letters.set(ref, 'ABCDEFGHI'[letters.size]);
    return letters.get(ref);
  };
  const pattern = [];
  for (let r = rows[0]; r <= rows.at(-1); r++) {
    let line = '';
    for (let c = cols[0]; c <= cols.at(-1); c++) line += cells[r * 3 + c] ? letterFor(cells[r * 3 + c]) : ' ';
    pattern.push(line);
  }
  const key = {};
  for (const [ref, letter] of letters) key[letter] = ingredientJson(ref);
  return { pattern, key };
}

/** Result stack JSON for a recipe, or an error string. */
function resultJson(dp, result, rules, ctx, { asString = false, withCount = true } = {}) {
  const count = Math.max(1, Math.floor(result.count) || 1);
  let base = result.id, extra = null;
  if (result.custom) {
    const item = customItemById(dp, result.custom);
    if (!item) return { error: `Custom item "${result.custom}" no longer exists.` };
    base = item.base;
    extra = customStack(item, rules);
    if (extra.nbt && ctx.loader !== 'forge') {
      return { error: 'Recipes can only output custom NBT on Forge for 1.20.1. Use a loot table for this item instead.' };
    }
  }
  if (!isValidId(base)) return { error: 'Result item is missing or not a valid id.' };
  const key = rules.resultId ? 'id' : 'item';
  if (asString && !extra) return { value: base, count };
  const value = { [key]: base };
  if (withCount && (count > 1 || rules.components)) value.count = count;
  if (extra?.components) value.components = extra.components;
  if (extra?.nbt) value.nbt = extra.nbt;
  return { value, count };
}

function buildRecipe(dp, recipe, rules, ctx, issues) {
  const where = `Recipe ${recipe.id}`;
  const meta = RECIPE_TYPES[recipe.type];
  if (!meta) { issues.push({ level: 'error', where, message: 'Unknown recipe type.' }); return null; }
  const ref = r => (r && (isTagRef(r) ? isValidId(r.slice(1)) : isValidId(r)) ? r : null);
  const out = { type: meta.json };

  if (recipe.type === 'shaped') {
    const shaped = shapedFromGrid(recipe.grid);
    if (!shaped) { issues.push({ level: 'error', where, message: 'The crafting grid is empty.' }); return null; }
    if (recipe.grid.some(c => c && !ref(c))) { issues.push({ level: 'error', where, message: 'An ingredient is not a valid item id.' }); return null; }
    out.pattern = shaped.pattern;
    out.key = shaped.key;
  } else if (recipe.type === 'shapeless') {
    const list = recipe.ingredients.filter(Boolean);
    if (!list.length || list.length > 9) { issues.push({ level: 'error', where, message: 'Shapeless recipes need 1-9 ingredients.' }); return null; }
    if (list.some(i => !ref(i))) { issues.push({ level: 'error', where, message: 'An ingredient is not a valid item id.' }); return null; }
    out.ingredients = list.map(ingredientJson);
  } else {
    if (!ref(recipe.ingredient)) { issues.push({ level: 'error', where, message: 'Pick a valid input item.' }); return null; }
    out.ingredient = ingredientJson(recipe.ingredient);
  }

  const flat = (meta.cooking || recipe.type === 'stonecutting') && !rules.cookingResultObject;
  const res = resultJson(dp, recipe.result, rules, ctx, { asString: flat });
  if (res.error) { issues.push({ level: 'error', where, message: res.error }); return null; }

  out.result = res.value;
  if (flat) {
    // 1.20.x cooking/stonecutting recipes use a plain item id as the result.
    if (recipe.type === 'stonecutting') out.count = res.count;
    else if (res.count > 1) issues.push({ level: 'warn', where, message: 'Cooking recipes always produce 1 item in this version; count ignored.' });
  }
  if (meta.cooking) {
    out.experience = Math.max(0, recipe.experience);
    out.cookingtime = Math.max(1, Math.floor(recipe.cookingtime) || meta.defaultTime);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tags, loot tables, advancements
// ---------------------------------------------------------------------------

export const TAG_KINDS = {
  item: { label: 'Item', dir: 'item', plural: 'items' },
  block: { label: 'Block', dir: 'block', plural: 'blocks' },
  entity_type: { label: 'Entity type', dir: 'entity_type', plural: 'entity_types' },
  fluid: { label: 'Fluid', dir: 'fluid', plural: 'fluids' },
  biome: { label: 'Biome', fixed: 'worldgen/biome' },
  structure: { label: 'Structure', fixed: 'worldgen/structure' }
};

const tagDir = (kind, rules) => {
  const k = TAG_KINDS[kind];
  return k.fixed ?? (rules.singular ? k.dir : k.plural);
};

export const LOOT_TYPES = { generic: 'Generic', block: 'Block drops', chest: 'Chest', entity: 'Entity drops' };
export const FRAMES = ['task', 'goal', 'challenge'];

function buildLootTable(dp, table, rules, ctx, issues) {
  const where = `Loot table ${table.id}`;
  if (!table.pools.length || table.pools.every(p => !p.entries.length)) {
    issues.push({ level: 'error', where, message: 'Add at least one pool with an entry.' }); return null;
  }
  const pools = [];
  for (const pool of table.pools) {
    const entries = [];
    for (const e of pool.entries) {
      let name = e.item, functions = [];
      if (e.custom) {
        const item = customItemById(dp, e.custom);
        if (!item) { issues.push({ level: 'error', where, message: `Custom item "${e.custom}" no longer exists.` }); return null; }
        name = item.base;
        const stack = customStack(item, rules);
        functions.push(stack.components
          ? { function: 'minecraft:set_components', components: stack.components }
          : { function: 'minecraft:set_nbt', tag: stack.nbt });
      }
      if (!isValidId(name)) { issues.push({ level: 'error', where, message: 'An entry has no valid item.' }); return null; }
      const min = Math.max(1, Math.floor(e.min) || 1), max = Math.max(min, Math.floor(e.max) || min);
      if (max > 1) functions.push({ function: 'minecraft:set_count', count: min === max ? min : { type: 'minecraft:uniform', min, max } });
      const entry = { type: 'minecraft:item', name, weight: Math.max(1, Math.floor(e.weight) || 1) };
      if (functions.length) entry.functions = functions;
      entries.push(entry);
    }
    if (!entries.length) continue;
    const rMin = Math.max(0, pool.rollsMin), rMax = Math.max(rMin, pool.rollsMax);
    pools.push({ rolls: rMin === rMax ? rMin : { type: 'minecraft:uniform', min: rMin, max: rMax }, entries });
  }
  return { type: `minecraft:${table.type}`, pools };
}

const iconJson = (item, rules) => (rules.resultId ? { id: item } : { item });

function buildAdvancement(adv, rules, issues) {
  const where = `Advancement ${adv.id}`;
  if (!isValidId(adv.icon)) { issues.push({ level: 'error', where, message: 'Pick a valid icon item.' }); return null; }
  if (!adv.title.trim()) { issues.push({ level: 'error', where, message: 'Give the advancement a title.' }); return null; }
  if (adv.parent && !isValidId(adv.parent)) { issues.push({ level: 'error', where, message: 'Parent must look like namespace:path.' }); return null; }
  let criteria;
  if (adv.trigger === 'inventory_changed') {
    if (!isValidId(adv.item)) { issues.push({ level: 'error', where, message: 'Pick the item that triggers this advancement.' }); return null; }
    criteria = { obtained: { trigger: 'minecraft:inventory_changed', conditions: { items: [{ items: [adv.item] }] } } };
  } else {
    criteria = { manual: { trigger: 'minecraft:impossible' } };
    issues.push({ level: 'warn', where, message: 'Trigger "impossible" is only granted by commands or functions.' });
  }
  const out = {
    display: {
      icon: iconJson(adv.icon, rules), title: { text: adv.title.trim() }, description: { text: adv.description.trim() },
      frame: adv.frame, show_toast: adv.toast, announce_to_chat: adv.announce, hidden: false
    },
    criteria
  };
  if (adv.parent) out.parent = adv.parent;
  const rewards = {};
  if (adv.rewardRecipes.length) rewards.recipes = adv.rewardRecipes;
  if (adv.rewardLoot.length) rewards.loot = adv.rewardLoot;
  if (adv.rewardXp > 0) rewards.experience = Math.floor(adv.rewardXp);
  if (Object.keys(rewards).length) out.rewards = rewards;
  return out;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const json = v => JSON.stringify(v, null, 2) + '\n';
const slug = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'modpack';

/**
 * Turns the model into files.
 * @param {object} dp the datapack model
 * @param {{ mcVersion: string, loader: string, name?: string, textures?: Map<string, Blob> }} ctx
 * @returns {{ files: Map<string, string|Blob>, issues: {level:'error'|'warn', where:string, message:string}[], usesPaxi: boolean }}
 *   file paths are relative to the pack: "datapack/...", "resourcepack/...", or "config/tectonic.json".
 */
export function buildDatapack(dp, ctx) {
  const rules = mcRules(ctx.mcVersion);
  const profile = worldgenProfile(ctx.mcVersion);
  const ns = dp.namespace;
  const files = new Map();
  const issues = [];
  const dir = (a, b) => (rules.singular ? a : b);

  if (!rules.known && datapackContentCount(dp) > 0) {
    issues.push({ level: 'warn', where: 'Minecraft version', message: `Pack formats for ${ctx.mcVersion || 'this version'} are a guess; check the generated pack.mcmeta.` });
  }

  const seen = new Set();
  const claim = (path, where) => {
    if (seen.has(path)) { issues.push({ level: 'error', where, message: `Two entries write the same file (${path}).` }); return false; }
    seen.add(path);
    return true;
  };

  // Custom items first: they're used by recipes and loot tables.
  const goodItems = dp.items.filter(item => validateCustomItem(item, rules, issues));
  const itemNames = new Set();
  for (const item of goodItems) {
    if (itemNames.has(item.id)) { issues.push({ level: 'error', where: `Item ${item.id}`, message: 'Duplicate item id.' }); continue; }
    itemNames.add(item.id);
    const stack = (() => { try { return customStack(item, rules); } catch { return null; } })();
    if (!stack) continue;
    // Loot table so the item can always be obtained: /loot give @s loot <ns>:items/<id>
    const lootPath = `datapack/data/${ns}/${dir('loot_table', 'loot_tables')}/items/${item.id}.json`;
    if (claim(lootPath, `Item ${item.id}`)) {
      files.set(lootPath, json({
        type: 'minecraft:generic',
        pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: item.base, functions: [stack.components
          ? { function: 'minecraft:set_components', components: stack.components }
          : { function: 'minecraft:set_nbt', tag: stack.nbt }] }] }]
      }));
    }
    // Resource pack: model + texture
    const texture = ctx.textures?.get(item.id);
    files.set(`resourcepack/assets/${ns}/models/item/${item.id}.json`, json({
      parent: 'minecraft:item/generated',
      textures: { layer0: `${ns}:item/${item.id}` }
    }));
    if (texture) files.set(`resourcepack/assets/${ns}/textures/item/${item.id}.png`, texture);
    else issues.push({ level: 'warn', where: `Item ${item.id}`, message: 'No texture uploaded; the item will show a missing-texture cube.' });
  }

  // Base item model overrides, one file per base item (several custom items can share a base).
  const byBase = new Map();
  for (const item of goodItems) {
    if (!itemNames.has(item.id)) continue;
    if (!byBase.has(item.base)) byBase.set(item.base, []);
    byBase.get(item.base).push(item);
  }
  for (const [base, list] of byBase) {
    const [bns, bpath] = splitId(base);
    const cmds = list.map(i => i.customModelData);
    if (new Set(cmds).size !== cmds.length) issues.push({ level: 'error', where: `Base ${base}`, message: 'Two custom items on the same base item share a custom model data number.' });
    files.set(`resourcepack/assets/${bns}/models/item/${bpath}.json`, json({
      parent: baseParent(base),
      textures: { layer0: `${bns}:item/${bpath}` },
      overrides: list.map(i => ({ predicate: { custom_model_data: i.customModelData }, model: `${ns}:item/${i.id}` }))
    }));
    if (bns === 'minecraft' && !HANDHELD.test(base) && /(^|_)(block|planks|log|stone|ore|slab|stairs|door|chest|bed)$/.test(bpath)) {
      issues.push({ level: 'warn', where: `Base ${base}`, message: 'This looks like a block item; flat item models only suit flat items such as paper or stick.' });
    }
  }

  for (const recipe of dp.recipes) {
    const id = qualify(recipe.id, ns);
    if (!isValidId(id)) { issues.push({ level: 'error', where: `Recipe ${recipe.id}`, message: 'Recipe id must look like namespace:path.' }); continue; }
    const body = buildRecipe(dp, { ...recipe, id }, rules, ctx, issues);
    const [rns, rpath] = splitId(id);
    const path = `datapack/data/${rns}/${dir('recipe', 'recipes')}/${rpath}.json`;
    if (body && claim(path, `Recipe ${id}`)) files.set(path, json(body));
  }

  for (const tag of dp.tags) {
    const id = qualify(tag.id, ns);
    const where = `Tag ${id}`;
    if (!isValidId(id) || !TAG_KINDS[tag.kind]) { issues.push({ level: 'error', where, message: 'Tag id must look like namespace:path.' }); continue; }
    const bad = tag.values.find(v => !(isTagRef(v) ? isValidId(v.slice(1)) : isValidId(v)));
    if (bad) { issues.push({ level: 'error', where, message: `"${bad}" is not a valid id.` }); continue; }
    if (!tag.values.length && !tag.replace) { issues.push({ level: 'error', where, message: 'Add at least one value.' }); continue; }
    const [tns, tpath] = splitId(id);
    const path = `datapack/data/${tns}/tags/${tagDir(tag.kind, rules)}/${tpath}.json`;
    if (claim(path, where)) files.set(path, json({ replace: tag.replace, values: tag.values }));
  }

  for (const table of dp.lootTables) {
    const id = qualify(table.id, ns);
    if (!isValidId(id)) { issues.push({ level: 'error', where: `Loot table ${table.id}`, message: 'Loot table id must look like namespace:path.' }); continue; }
    const body = buildLootTable(dp, { ...table, id }, rules, ctx, issues);
    const [lns, lpath] = splitId(id);
    const path = `datapack/data/${lns}/${dir('loot_table', 'loot_tables')}/${lpath}.json`;
    if (body && claim(path, `Loot table ${id}`)) files.set(path, json(body));
  }

  for (const adv of dp.advancements) {
    const id = qualify(adv.id, ns);
    if (!isValidId(id)) { issues.push({ level: 'error', where: `Advancement ${adv.id}`, message: 'Advancement id must look like namespace:path.' }); continue; }
    const body = buildAdvancement(adv, rules, issues);
    const [ans, apath] = splitId(id);
    const path = `datapack/data/${ans}/${dir('advancement', 'advancements')}/${apath}.json`;
    if (body && claim(path, `Advancement ${id}`)) files.set(path, json(body));
  }

  for (const raw of dp.rawFiles) {
    const where = `File ${raw.path}`;
    const m = /^(data|assets)\/([a-z0-9_.-]+\/)?[a-z0-9_./-]+$/.exec(raw.path);
    if (!m || raw.path.includes('..')) { issues.push({ level: 'error', where, message: 'Path must start with data/ or assets/ and use only a-z, 0-9, _ . / -' }); continue; }
    if (raw.path.endsWith('.json')) {
      try { JSON.parse(raw.content); } catch (e) { issues.push({ level: 'error', where, message: `Invalid JSON: ${e.message}` }); continue; }
    }
    const path = `${m[1] === 'data' ? 'datapack' : 'resourcepack'}/${raw.path}`;
    if (claim(path, where)) files.set(path, raw.content);
  }

  const hasData = [...files.keys()].some(p => p.startsWith('datapack/'));
  const hasAssets = [...files.keys()].some(p => p.startsWith('resourcepack/'));
  if (hasData) files.set('datapack/pack.mcmeta', json({ pack: { pack_format: rules.dataFormat, description: `${ctx.name || 'Modpack'} (made with Modular)` } }));
  if (hasAssets) files.set('resourcepack/pack.mcmeta', json({ pack: { pack_format: rules.resFormat, description: `${ctx.name || 'Modpack'} assets (made with Modular)` } }));

  if (hasTectonicChanges(dp)) {
    if (!profile) issues.push({ level: 'warn', where: 'Worldgen', message: `Tectonic settings are only supported for ${Object.keys(WORLDGEN_PROFILES).join(' and ')}; not exported.` });
    else {
      const config = buildTectonicConfig(dp.tectonic, profile);
      if (config) files.set('config/tectonic.json', config);
    }
  }

  return { files, issues, usesPaxi: hasData || hasAssets };
}

/** Maps builder output paths to full .mrpack paths. Each pack goes in its own Paxi folder. */
export function toOverridePaths(files, packName) {
  const folder = slug(packName);
  const out = new Map();
  for (const [path, data] of files) {
    if (path.startsWith('datapack/')) out.set(`overrides/config/paxi/datapacks/${folder}/${path.slice(9)}`, data);
    else if (path.startsWith('resourcepack/')) out.set(`overrides/config/paxi/resourcepacks/${folder}/${path.slice(13)}`, data);
    else if (path === 'config/tectonic.json') out.set('overrides/config/tectonic.json', data);
    else out.set(`overrides/${path}`, data);
  }
  return out;
}

/** Paths in the passthrough store that the generated output will replace on export. */
export function conflictingPaths(overridePaths, generated) {
  const set = new Set(overridePaths);
  return [...generated.keys()].filter(p => set.has(p));
}
