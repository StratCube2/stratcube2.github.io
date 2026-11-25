// Runs the dependency check on the real pack and fixes what it can by adding mods from Modrinth.
//   checkPack()        reads every mod jar (cached after the first time) and reports problems
//   resolveEverything() 1) adds the required dependencies Modrinth itself lists,
//                       2) re-checks using fabric.mod.json / META-INF and adds what's still missing
import { state, saveState } from './state.js';
import { resolveDependencies, buildModrinthMod, findModrinthCandidates, isConnectorActive } from './api.js';
import { scanPackMods, getPackMeta } from './itemdb.js';
import { analyzePack } from './depcheck.js';

const MAX_ROUNDS = 8; // each round fixes one layer of dependencies (a dependency's own dependencies)

const context = () => ({
  mcVersion: state.mcVersion, loader: state.loader,
  loaderVersion: state.loaderVersion?.trim() || '', connector: isConnectorActive()
});

/** Reads the jars of the pack's mods and analyses them. */
export async function checkPack({ onProgress, signal } = {}) {
  await scanPackMods({ signal, onProgress });
  const packMeta = await getPackMeta();

  // Only real mods take part: shaders, resource packs and datapacks have no mod metadata.
  const entries = packMeta
    .filter(p => p.reason !== 'not a mod' && (p.mod.type ?? 'mod') === 'mod')
    .map(p => ({ key: p.key, title: p.mod.title, meta: p.meta }));

  const result = analyzePack(entries, context());
  // Say why a mod couldn't be read, e.g. CurseForge files can't be downloaded from the browser.
  result.unreadableReasons = packMeta
    .filter(p => result.unreadable.includes(p.mod.title))
    .map(p => ({ title: p.mod.title, reason: p.reason || "couldn't read its metadata" }));
  return result;
}

/** Does the scanned jar of this pack mod supply `depId`? */
const provides = (meta, depId) => !!meta && (
  meta.mods.some(m => m.id === depId || m.provides?.includes(depId)) ||
  meta.nestedMods.some(m => m.id === depId || m.provides?.includes(depId))
);

/**
 * Adds mods from Modrinth for every required dependency the jars name but the pack lacks.
 * A candidate is only kept after its jar has been read and really supplies the mod id.
 */
async function addMissingFromJars({ onStatus, signal }) {
  const added = [], unresolved = new Map();
  const candidates = new Map();   // depId -> candidate project ids
  const tried = new Map();        // depId -> how many candidates were tried

  for (let round = 1; round <= MAX_ROUNDS && !signal?.aborted; round++) {
    onStatus?.(round === 1 ? 'Checking mod files…' : `Checking again (round ${round})…`);
    const analysis = await checkPack({ signal, onProgress: (d, t) => onStatus?.(`Reading mods ${d}/${t}…`) });

    const wanted = analysis.missing.filter(m => !unresolved.has(m.depId));
    if (!wanted.length) return { added, unresolved, analysis };

    // Add the next untried candidate for each missing dependency.
    const trials = new Map();     // project id -> missing entry
    for (const miss of wanted) {
      onStatus?.(`Looking up ${miss.depId} on Modrinth…`);
      if (!candidates.has(miss.depId)) candidates.set(miss.depId, await findModrinthCandidates(miss.depId));
      const list = candidates.get(miss.depId);

      let mod = null;
      while (!mod && (tried.get(miss.depId) ?? 0) < list.length) {
        const projectId = list[tried.get(miss.depId) ?? 0];
        tried.set(miss.depId, (tried.get(miss.depId) ?? 0) + 1);
        if (state.mods.some(m => m.id === projectId)) continue;           // already here, so it can't be the answer
        try { mod = await buildModrinthMod(projectId); } catch (err) { console.warn('Modrinth lookup failed', projectId, err); }
      }
      if (!mod) { unresolved.set(miss.depId, miss); continue; }

      mod.addedAsDependencyOf = miss.requiredBy[0] ?? null;
      state.mods.push(mod);
      trials.set(mod.id, miss);
    }
    if (!trials.size) return { added, unresolved, analysis };

    // Read the new jars, keep the ones that really provide the mod id, drop the rest.
    await scanPackMods({ signal, onProgress: (d, t) => onStatus?.(`Reading new mods ${d}/${t}…`) });
    const packMeta = await getPackMeta();
    for (const [projectId, miss] of trials) {
      const meta = packMeta.find(p => p.mod.id === projectId)?.meta;
      if (provides(meta, miss.depId)) {
        added.push({ title: state.mods.find(m => m.id === projectId)?.title, depId: miss.depId, requiredBy: miss.requiredBy });
      } else {
        state.mods = state.mods.filter(m => m.id !== projectId);          // wrong project (or unreadable): try the next candidate
      }
    }
  }
  return { added, unresolved, analysis: await checkPack({ signal }) };
}

/**
 * The Resolve button: Modrinth's own dependency lists first, then the jar-metadata check.
 * @returns {Promise<{ added: {title:string, depId?:string, requiredBy?:string[]}[], unresolved: object[], analysis: object }>}
 */
export async function resolveEverything({ onStatus, signal } = {}) {
  onStatus?.('Adding dependencies listed on Modrinth…');
  const viaApi = (await resolveDependencies()).map(m => ({ title: m.title, requiredBy: m.addedAsDependencyOf ? [m.addedAsDependencyOf] : [] }));
  if (viaApi.length) saveState();

  const jar = await addMissingFromJars({ onStatus, signal });
  const added = [...viaApi, ...jar.added];
  if (jar.added.length) saveState();
  return { added, unresolved: [...jar.unresolved.values()], analysis: jar.analysis };
}
