// Dependency analysis for a pack, from what the jars say about themselves (see depmeta.js).
// Pure logic, no DOM or network: feed it each pack mod's metadata and the pack's settings and
// it reports what's missing, too old, incompatible or on the wrong loader.
import { satisfies } from './verrange.js';

/**
 * @typedef {{ key: string, title: string, meta: object|null }} PackEntry  meta is depmeta's readJarMeta result (or null if unread)
 * @typedef {{ mcVersion: string, loader: string, loaderVersion?: string, connector?: boolean }} PackContext
 */

// Ids the loader itself provides; they never need a jar in the pack.
const BUILTIN = {
  all: new Set(['minecraft', 'java']),
  fabric: new Set(['fabricloader', 'fabric-loader', 'fabric-language-java']),
  quilt: new Set(['quilt_loader', 'quilt-loader', 'fabricloader', 'fabric-loader']),
  forge: new Set(['forge', 'fml', 'javafml', 'lowcodefml', 'mclanguage', 'mixinextras']),
  neoforge: new Set(['neoforge', 'forge', 'fml', 'javafml', 'lowcodefml', 'mclanguage', 'mixinextras'])
};
// Sinytra Connector brings Forgified Fabric API and the Fabric loader shim with it.
const isConnectorProvided = id => /^fabric([-_].+)?$/.test(id) || id === 'fabricloader';

const hasLoader = (meta, loader) => meta.loaders.includes(loader);

/** Is a jar built for `loader` loadable on this pack? */
function loaderFits(meta, ctx) {
  if (!meta.loaders.length) return true;                          // plain library jar, nothing to judge
  if (hasLoader(meta, ctx.loader)) return true;
  if (ctx.loader === 'quilt' && hasLoader(meta, 'fabric')) return true;
  if ((ctx.loader === 'forge' || ctx.loader === 'neoforge') && ctx.connector && hasLoader(meta, 'fabric')) return true;
  return false;
}

/**
 * @param {PackEntry[]} entries
 * @param {PackContext} ctx
 * @returns {{ issues: object[], missing: object[], unreadable: string[], checked: number }}
 */
export function analyzePack(entries, ctx) {
  const issues = [];
  const unreadable = [];
  const builtin = new Set([...BUILTIN.all, ...(BUILTIN[ctx.loader] || [])]);

  // --- 1. Everything the pack provides ---------------------------------------------------
  /** id -> [{ version, from, nested }] (more than one entry means two jars supply the same id) */
  const provided = new Map();
  const provide = (id, version, from, nested) => {
    if (!provided.has(id)) provided.set(id, []);
    provided.get(id).push({ version, from, nested });
  };
  const readable = [];
  for (const entry of entries) {
    if (!entry.meta || (!entry.meta.mods.length && !entry.meta.loaders.length)) { unreadable.push(entry.title); continue; }
    readable.push(entry);
    for (const mod of entry.meta.mods) {
      provide(mod.id, mod.version, entry.title, false);
      mod.provides.forEach(id => provide(id, mod.version, entry.title, false));
    }
    for (const mod of entry.meta.nestedMods) {
      provide(mod.id, mod.version, entry.title, true);
      (mod.provides || []).forEach(id => provide(id, mod.version, entry.title, true));
    }
  }

  // --- 2. Check each mod ------------------------------------------------------------------
  for (const entry of readable) {
    const { meta, title } = entry;

    if (!loaderFits(meta, ctx)) {
      issues.push({ level: 'warn', kind: 'loader', mod: title, found: meta.loaders.join('/'), message: `${title} is built for ${meta.loaders.join('/')}, not ${ctx.loader}.` });
    }

    for (const mod of meta.mods) {
      // A multi-loader jar lists the same mod under each format; judge it by the pack's own loader.
      const own = mod.loader ? (mod.loader === ctx.loader || (ctx.loader === 'quilt' && mod.loader === 'fabric') || (ctx.connector && mod.loader === 'fabric') || !hasLoader(meta, ctx.loader)) : true;
      if (!own) continue;

      for (const dep of mod.deps) {
        const base = { mod: title, modId: mod.id, depId: dep.id, range: dep.range, kind: dep.kind };

        if (dep.id === 'minecraft') {
          if (!ctx.mcVersion) continue;
          if (dep.kind === 'required' && satisfies(ctx.mcVersion, dep.range, dep.style) === false) {
            issues.push({ ...base, level: 'error', kind: 'minecraft', found: ctx.mcVersion, message: `${title} needs Minecraft ${fmtRange(dep.range)}, but the pack is ${ctx.mcVersion}.` });
          }
          continue;
        }
        if (builtin.has(dep.id)) {
          // Only the loader version can be checked, and only if the user filled it in.
          const loaderIds = ['fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'forge', 'neoforge'];
          if (ctx.loaderVersion && loaderIds.includes(dep.id) && dep.kind === 'required'
              && satisfies(ctx.loaderVersion, dep.range, dep.style) === false) {
            issues.push({ ...base, level: 'warn', kind: 'loader-version', found: ctx.loaderVersion, message: `${title} wants ${dep.id} ${fmtRange(dep.range)}, but the pack's loader version is ${ctx.loaderVersion}.` });
          }
          continue;
        }
        if (ctx.connector && mod.loader === 'fabric' && isConnectorProvided(dep.id)) continue;
        // Client-only Forge dependencies don't matter on a server, but the pack ships to both.
        const present = (provided.get(dep.id) || []).filter(p => p.from !== title || mod.id !== dep.id);
        const have = present[0];

        switch (dep.kind) {
          case 'required':
          case 'recommended': {
            const level = dep.kind === 'required' ? 'error' : 'warn';
            if (!have) {
              issues.push({ ...base, level, kind: dep.kind === 'required' ? 'missing' : 'recommended', message: `${title} ${dep.kind === 'required' ? 'requires' : 'recommends'} ${dep.id}${fmtRangeSuffix(dep.range)}, which isn't in the pack.` });
            } else if (dep.kind === 'required' && !present.some(p => satisfies(p.version, dep.range, dep.style) !== false)) {
              issues.push({ ...base, level, kind: 'version', found: have.version, message: `${title} needs ${dep.id} ${fmtRange(dep.range)}, but ${have.from} has ${have.version}.` });
            }
            break;
          }
          case 'breaks':
            if (have && satisfies(have.version, dep.range, dep.style) !== false) {
              issues.push({ ...base, level: 'error', kind: 'incompatible', found: have.version, message: `${title} doesn't work with ${dep.id}${fmtRangeSuffix(dep.range)} (${have.from} is in the pack).` });
            }
            break;
          case 'conflicts':
            if (have && satisfies(have.version, dep.range, dep.style) !== false) {
              issues.push({ ...base, level: 'warn', kind: 'conflict', found: have.version, message: `${title} may conflict with ${dep.id}${fmtRangeSuffix(dep.range)} (${have.from} is in the pack).` });
            }
            break;
          default: break;                                      // optional/suggested: nothing to report
        }
      }
    }
  }

  // --- 3. Two jars supplying the same mod id ----------------------------------------------
  for (const [id, list] of provided) {
    const top = list.filter(p => !p.nested);
    const froms = [...new Set(top.map(p => p.from))];
    if (froms.length > 1) {
      issues.push({ level: 'warn', kind: 'duplicate', depId: id, mod: froms[0], message: `${id} is provided by more than one file: ${froms.join(', ')}.` });
    }
  }

  // --- 4. What can be fixed by adding mods -------------------------------------------------
  const missingMap = new Map();
  for (const issue of issues) {
    if (issue.kind !== 'missing') continue;
    const m = missingMap.get(issue.depId) ?? { depId: issue.depId, ranges: [], requiredBy: [], style: 'fabric' };
    if (!m.ranges.includes(issue.range)) m.ranges.push(issue.range);
    if (!m.requiredBy.includes(issue.mod)) m.requiredBy.push(issue.mod);
    missingMap.set(issue.depId, m);
  }
  // Remember the range syntax each missing dependency was declared in.
  for (const entry of readable) for (const mod of entry.meta.mods) for (const dep of mod.deps) {
    const m = missingMap.get(dep.id);
    if (m) m.style = dep.style;
  }

  const order = { error: 0, warn: 1 };
  issues.sort((a, b) => (order[a.level] - order[b.level]) || a.mod.localeCompare(b.mod));
  return { issues, missing: [...missingMap.values()], unreadable, checked: readable.length };
}

const fmtRange = r => (Array.isArray(r) ? r.join(' or ') : r);
const fmtRangeSuffix = r => (r === '*' || r === '' || r == null ? '' : ` ${fmtRange(r)}`);
