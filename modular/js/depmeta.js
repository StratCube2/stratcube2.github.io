// Reads what a mod jar says about itself and its dependencies:
//   fabric.mod.json              Fabric (and Quilt, which also loads it)
//   quilt.mod.json               Quilt
//   META-INF/mods.toml           Forge
//   META-INF/neoforge.mods.toml  NeoForge
// plus the jars nested inside it (Fabric "jars", Forge/NeoForge META-INF/jarjar), whose mods
// count as provided by the outer jar. No DOM or browser APIs, so this runs under Node too.
import { parseJson5 } from './packtools.js';

const MAX_NESTED = 40;
const MAX_DEPTH = 2;

const parseJson = text => { try { return JSON.parse(text); } catch { return parseJson5(text); } };

// ---------------------------------------------------------------------------
// A small TOML reader: just what mods.toml files use (tables, arrays of tables,
// strings incl. ''' blocks, booleans, numbers, simple arrays).
// ---------------------------------------------------------------------------

function parseTomlValue(text) {
  const t = text.trim();
  if (t.startsWith('[')) {                                // simple array
    const inner = t.slice(1, t.lastIndexOf(']'));
    const items = [];
    let cur = '', quote = null;
    for (const ch of inner) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === ',') { if (cur.trim()) items.push(parseTomlValue(cur)); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) items.push(parseTomlValue(cur));
    return items;
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"')) {
    try { return JSON.parse(t.replace(/\\U[0-9a-fA-F]{8}|\\u[0-9a-fA-F]{4}/g, m => String.fromCodePoint(parseInt(m.slice(2), 16)))); }
    catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'")) return t.slice(1, -1);
  return t;
}

/** Cuts a trailing "# comment" that isn't inside a string. */
function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote && line[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

export function parseToml(text) {
  const root = {};
  let table = root;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  const descend = (path, asArray) => {
    let node = root;
    path.forEach((key, i) => {
      const last = i === path.length - 1;
      if (last && asArray) {
        (node[key] ??= []).push(node = {});
      } else {
        let next = node[key];
        if (Array.isArray(next)) next = next[next.length - 1];   // [[a]] then [a.b] belongs to the latest a
        node = node[key] = next ?? {};
        if (Array.isArray(node)) node = node[node.length - 1];
      }
    });
    return node;
  };
  const splitPath = s => s.split('.').map(k => k.trim().replace(/^["']|["']$/g, ''));

  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i]).trim();
    if (!line) continue;
    let m;
    if ((m = /^\[\[\s*(.+?)\s*\]\]$/.exec(line))) { table = descend(splitPath(m[1]), true); continue; }
    if ((m = /^\[\s*(.+?)\s*\]$/.exec(line))) { table = descend(splitPath(m[1]), false); continue; }
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    let value = line.slice(eq + 1).trim();

    // Multi-line strings ('''...''' or """...""")
    const triple = value.startsWith("'''") ? "'''" : value.startsWith('"""') ? '"""' : null;
    if (triple) {
      let body = value.slice(3);
      while (!body.includes(triple) && i + 1 < lines.length) body += '\n' + lines[++i];
      table[key] = body.slice(0, body.indexOf(triple)).replace(/^\n/, '');
      continue;
    }
    // Multi-line arrays: keep reading until the brackets balance.
    if (value.startsWith('[')) {
      const depth = s => (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
      while (depth(value) > 0 && i + 1 < lines.length) value += ' ' + stripTomlComment(lines[++i]).trim();
    }
    table[key] = parseTomlValue(value);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Per-format readers. Each returns { loader, mods: [{ id, version, name, provides, deps }] }
// where deps are { id, range, kind, side } and kind is one of:
//   required | recommended | optional | breaks | conflicts
// ---------------------------------------------------------------------------

const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const asRange = v => (Array.isArray(v) ? v.map(String) : v == null ? '*' : String(v));

export function readFabricJson(json) {
  if (!json || typeof json.id !== 'string') return null;
  const deps = [];
  const collect = (obj, kind) => {
    for (const [id, range] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
      deps.push({ id, range: asRange(range), kind, style: 'fabric' });
    }
  };
  collect(json.depends, 'required');
  collect(json.recommends, 'recommended');
  collect(json.suggests, 'optional');
  collect(json.breaks, 'breaks');
  collect(json.conflicts, 'conflicts');
  return {
    loader: 'fabric',
    mods: [{
      id: json.id, version: json.version == null ? null : String(json.version), name: json.name || json.id,
      provides: asArray(json.provides).map(p => (typeof p === 'string' ? p : p?.id)).filter(Boolean),
      deps, environment: json.environment || '*'
    }],
    nested: asArray(json.jars).map(j => j?.file).filter(f => typeof f === 'string')
  };
}

export function readQuiltJson(json) {
  const q = json?.quilt_loader;
  if (!q || typeof q.id !== 'string') return null;
  const deps = [];
  const walk = (list, kind) => asArray(list).forEach(d => {
    const id = typeof d === 'string' ? d : d?.id;
    if (!id) return;
    const range = typeof d === 'string' ? '*' : asRange(d.versions);
    const optional = typeof d === 'object' && d.optional === true;
    deps.push({ id, range, kind: optional ? 'optional' : kind, style: 'fabric' });
  });
  walk(q.depends, 'required');
  walk(q.breaks, 'breaks');
  return {
    loader: 'quilt',
    mods: [{
      id: q.id, version: q.version == null ? null : String(q.version), name: q.metadata?.name || q.id,
      provides: asArray(q.provides).map(p => (typeof p === 'string' ? p : p?.id)).filter(Boolean),
      deps, environment: json.minecraft?.environment || '*'
    }],
    nested: Object.values(q.jars ? { j: q.jars } : {}).flat().filter(f => typeof f === 'string')
  };
}

/** mods.toml / neoforge.mods.toml. `manifestVersion` fills ${file.jarVersion}. */
export function readModsToml(toml, loader, manifestVersion) {
  const mods = asArray(toml?.mods).filter(m => m && typeof m.modId === 'string');
  if (!mods.length) return null;
  const resolveVersion = v => {
    if (v == null) return null;
    const s = String(v);
    return s.includes('${file.jarVersion}') ? (manifestVersion ?? null) : s;
  };
  return {
    loader,
    mods: mods.map(m => {
      const deps = [];
      for (const d of asArray(toml.dependencies?.[m.modId])) {
        if (!d || typeof d.modId !== 'string') continue;
        // NeoForge: type = required | optional | incompatible | discouraged. Forge: mandatory = true/false.
        let kind;
        const type = typeof d.type === 'string' ? d.type.toLowerCase() : null;
        if (type === 'incompatible') kind = 'breaks';
        else if (type === 'discouraged') kind = 'conflicts';
        else if (type === 'optional') kind = 'optional';
        else if (type === 'required') kind = 'required';
        else kind = d.mandatory === false ? 'optional' : 'required';
        deps.push({
          id: d.modId, range: d.versionRange == null ? '*' : String(d.versionRange), kind, style: 'maven',
          side: typeof d.side === 'string' ? d.side.toUpperCase() : 'BOTH'
        });
      }
      return { id: m.modId, version: resolveVersion(m.version), name: m.displayName || m.modId, provides: [], deps, environment: '*' };
    }),
    nested: []
  };
}

/** "Implementation-Version" from META-INF/MANIFEST.MF, if present. */
function manifestVersion(text) {
  const joined = String(text || '').replace(/\r?\n /g, '');   // continuation lines start with a space
  const m = /^Implementation-Version:\s*(.+)$/mi.exec(joined);
  return m ? m[1].trim() : null;
}

/** Forge/NeoForge jar-in-jar: META-INF/jarjar/metadata.json lists the nested jar paths. */
function jarJarPaths(json) {
  return asArray(json?.jars).map(j => j?.path).filter(p => typeof p === 'string');
}

// ---------------------------------------------------------------------------
// The main reader
// ---------------------------------------------------------------------------

/**
 * @param {import('jszip')} zip an opened jar
 * @param {{ jszip?: { loadAsync: Function }, depth?: number }} [opts] `jszip` is needed to open nested jars
 * @returns {Promise<{ loaders: string[], mods: object[], nestedMods: object[], errors: string[] }>}
 *   `mods` are the jar's own mods, `nestedMods` are mods found in jars inside it.
 */
export async function readJarMeta(zip, { jszip, depth = 0 } = {}) {
  const out = { loaders: [], mods: [], nestedMods: [], errors: [] };
  const read = async path => (zip.file(path) ? zip.file(path).async('string') : null);
  const nestedPaths = new Set();
  const note = (parsed, loader) => {
    if (!parsed) return;
    if (!out.loaders.includes(loader)) out.loaders.push(loader);
    // Multi-loader jars repeat the same mod per format; keep the first, but gather every dep style.
    for (const mod of parsed.mods) {
      const existing = out.mods.find(m => m.id === mod.id);
      if (!existing) out.mods.push({ ...mod, loader });
      else {
        existing.provides = [...new Set([...existing.provides, ...mod.provides])];
        existing.loaders = [...new Set([...(existing.loaders || [existing.loader]), loader])];
      }
    }
    parsed.nested.forEach(p => nestedPaths.add(p));
  };

  try { const t = await read('fabric.mod.json'); if (t) note(readFabricJson(parseJson(t)), 'fabric'); }
  catch (e) { out.errors.push(`fabric.mod.json: ${e.message}`); }

  try { const t = await read('quilt.mod.json'); if (t) note(readQuiltJson(parseJson(t)), 'quilt'); }
  catch (e) { out.errors.push(`quilt.mod.json: ${e.message}`); }

  const manifest = manifestVersion(await read('META-INF/MANIFEST.MF'));
  for (const [path, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    try { const t = await read(path); if (t) note(readModsToml(parseToml(t), loader, manifest), loader); }
    catch (e) { out.errors.push(`${path}: ${e.message}`); }
  }

  try {
    const t = await read('META-INF/jarjar/metadata.json');
    if (t) jarJarPaths(parseJson(t)).forEach(p => nestedPaths.add(p));
  } catch (e) { out.errors.push(`jarjar/metadata.json: ${e.message}`); }

  // Nested jars: their mods are provided by this jar. Only read their metadata, not their assets.
  if (jszip && depth < MAX_DEPTH) {
    for (const path of [...nestedPaths].slice(0, MAX_NESTED)) {
      const entry = zip.file(path);
      if (!entry) continue;
      try {
        const inner = await readJarMeta(await jszip.loadAsync(await entry.async('uint8array')), { jszip, depth: depth + 1 });
        out.nestedMods.push(...inner.mods, ...inner.nestedMods);
      } catch (e) { out.errors.push(`${path}: ${e.message}`); }
    }
  }
  return out;
}

/** A compact, structured-clone-safe copy for the IndexedDB scan cache. */
export const slimMeta = meta => meta && ({
  loaders: meta.loaders,
  mods: meta.mods.map(({ id, version, name, provides, deps, environment, loader, loaders }) => ({ id, version, name, provides, deps, environment, loader, loaders })),
  nestedMods: meta.nestedMods.map(({ id, version, provides }) => ({ id, version, provides })),
  errors: meta.errors
});
