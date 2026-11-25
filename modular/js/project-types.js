// The kinds of things a pack can contain, and everything that differs between them:
// how they are searched (Modrinth / CurseForge), where they install, and their filter chips.

const MOD_CATEGORIES = [
  'adventure', 'cursed', 'decoration', 'economy', 'equipment', 'food', 'game-mechanics', 'library', 'magic',
  'management', 'mobs', 'optimization', 'social', 'storage', 'technology', 'transportation', 'utility', 'worldgen'
];

export const PROJECT_TYPES = {
  mod: {
    label: 'Mods', singular: 'Mod', icon: 'puzzle', modrinth: 'mod', curseforgeClass: 6,
    dir: 'mods', env: { client: 'required', server: 'required' }, usesLoader: true,
    categories: MOD_CATEGORIES
  },
  shader: {
    label: 'Shaders', singular: 'Shader', icon: 'sunrise', modrinth: 'shader', curseforgeClass: 6552,
    dir: 'shaderpacks', env: { client: 'required', server: 'unsupported' }, usesLoader: false,
    categories: ['fantasy', 'realistic', 'semi-realistic', 'vanilla-like', 'cartoon', 'cursed', 'atmosphere', 'bloom',
      'colored-lighting', 'foliage', 'path-tracing', 'pbr', 'reflections', 'shadows', 'potato', 'low', 'medium', 'high']
  },
  resourcepack: {
    label: 'Resource Packs', singular: 'Resource Pack', icon: 'image', modrinth: 'resourcepack', curseforgeClass: 12,
    dir: 'resourcepacks', env: { client: 'required', server: 'unsupported' }, usesLoader: false,
    categories: ['audio', 'blocks', 'combat', 'core-shaders', 'cursed', 'decoration', 'entities', 'environment',
      'equipment', 'fonts', 'gui', 'items', 'locale', 'modded', 'models', 'realistic', 'simplistic', 'themed',
      'tweaks', 'utility', 'vanilla-like']
  },
  datapack: {
    label: 'Datapacks', singular: 'Datapack', icon: 'package', modrinth: 'datapack', curseforgeClass: 6945,
    // Datapacks are loaded through Paxi, the same way the Datapack tab's own output is.
    dir: 'config/paxi/datapacks', env: { client: 'required', server: 'required' }, usesLoader: false,
    loaders: ['datapack'],
    categories: MOD_CATEGORIES.filter(c => c !== 'library').concat('minigame')
  }
};

export const TYPE_IDS = Object.keys(PROJECT_TYPES);

/** The type of a pack entry. Entries saved before types existed are all mods. */
export const typeOf = mod => (mod && PROJECT_TYPES[mod.type] ? mod.type : 'mod');

export const categoryLabel = value => value.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Which type a file in an .mrpack belongs to, going by where it installs. */
export function typeForPath(path) {
  if (/^shaderpacks\//i.test(path)) return 'shader';
  if (/^resourcepacks\//i.test(path)) return 'resourcepack';
  if (/^(config\/paxi\/)?datapacks\//i.test(path)) return 'datapack';
  return 'mod';
}
