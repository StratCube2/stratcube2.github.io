// Version comparison and range matching for the dependency check.
//   - Fabric / Quilt: semver-style predicates (">=0.15.0", "~1.20", "^1.2", "1.20.x", "*"),
//     space separated = AND, an array of ranges = OR.
//   - Forge / NeoForge: Maven ranges ("[47,)", "[1.20,1.21)", "[1.0]").
// Every matcher returns true, false, or null when the version or range can't be understood
// (unreplaced ${version} placeholders, snapshots like 23w14a). Callers treat null as "fine",
// so an odd version string never raises a false alarm.
// No DOM or browser APIs, so this runs under Node too.

/** @returns {{ nums: number[], pre: string[] } | null} */
export function parseVersion(text) {
  const raw = String(text ?? '').trim().replace(/^v(?=\d)/i, '');
  if (!raw || raw.includes('${')) return null;
  const clean = raw.split('+')[0];                       // drop build metadata
  const m = /^(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(clean);
  if (!m) return null;
  return { nums: m[1].split('.').map(Number), pre: m[2] ? m[2].split(/[.-]/) : [] };
}

const comparePre = (a, b) => {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;                               // 1.0 is newer than 1.0-beta
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) { const d = Number(a[i]) - Number(b[i]); if (d) return d < 0 ? -1 : 1; }
    else if (an !== bn) return an ? -1 : 1;              // numbers sort below words
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

/** @returns {number|null} -1, 0, 1, or null if either side can't be parsed */
export function compareVersions(a, b) {
  const pa = typeof a === 'object' && a ? a : parseVersion(a);
  const pb = typeof b === 'object' && b ? b : parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

// ---------------------------------------------------------------------------
// Fabric / Quilt
// ---------------------------------------------------------------------------

/** One predicate like ">=1.2.3", "~1.2", "1.20.x". */
function matchPredicate(version, predicate) {
  const p = predicate.trim();
  if (!p || p === '*' || p.toLowerCase() === 'x') return true;
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(p);
  if (!m) return null;
  const op = m[1] || '=';
  const target = m[2].trim();

  // Wildcards: "1.20.x" / "1.20.*" mean "1.20.<anything>".
  if (/(^|\.)[x*]$/i.test(target)) {
    const base = parseVersion(target.replace(/\.?[x*]$/i, ''));
    if (!base) return null;
    return base.nums.every((n, i) => (version.nums[i] ?? 0) === n);
  }

  const t = parseVersion(target);
  if (!t) return null;
  const cmp = compareVersions(version, t);
  if (cmp === null) return null;
  switch (op) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '=': return cmp === 0;
    case '~': {                                          // ~1.2.3 := >=1.2.3 <1.3.0 ; ~1.2 := same minor
      if (cmp < 0) return false;
      const upper = t.nums.length >= 2 ? [t.nums[0], t.nums[1] + 1] : [t.nums[0] + 1];
      return compareVersions(version, { nums: upper, pre: [] }) < 0;
    }
    case '^': {                                          // ^1.2.3 := >=1.2.3 <2.0.0 (0.x pins the minor)
      if (cmp < 0) return false;
      const upper = t.nums[0] > 0 ? [t.nums[0] + 1] : [0, (t.nums[1] ?? 0) + 1];
      return compareVersions(version, { nums: upper, pre: [] }) < 0;
    }
    default: return null;
  }
}

/** @param {string} version @param {string|string[]} range @returns {boolean|null} */
export function satisfiesFabric(version, range) {
  const v = parseVersion(version);
  if (!v) return null;
  const alternatives = Array.isArray(range) ? range : [range];
  let unknown = false;
  for (const alt of alternatives) {
    // ">= 1.2 < 2" -> [">=1.2", "<2"]: glue each operator to its version, then whitespace means AND.
    const predicates = String(alt ?? '*').trim().replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1').split(/\s+/).filter(Boolean);
    let all = true, anyUnknown = false;
    for (const pred of predicates.length ? predicates : ['*']) {
      const r = matchPredicate(v, pred);
      if (r === null) anyUnknown = true;
      else if (!r) { all = false; break; }
    }
    if (all && !anyUnknown) return true;
    if (all && anyUnknown) unknown = true;
  }
  return unknown ? null : false;
}

// ---------------------------------------------------------------------------
// Forge / NeoForge (Maven ranges)
// ---------------------------------------------------------------------------

/** Splits "[1,2),(3,]" into ["[1,2)", "(3,]"], leaving a bare version as a single piece. */
function splitMaven(spec) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of spec) {
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** @param {string} version @param {string} range @returns {boolean|null} */
export function satisfiesMaven(version, range) {
  const v = parseVersion(version);
  if (!v) return null;
  const spec = String(range ?? '').trim();
  if (!spec || spec === '*') return true;
  const pieces = splitMaven(spec);
  let unknown = false;
  for (const piece of pieces) {
    const m = /^([\[(])\s*([^,\]\)]*?)\s*(?:(,)\s*([^,\]\)]*?)\s*)?([\])])$/.exec(piece);
    if (!m) {
      // A bare version is a soft requirement: Forge accepts any version.
      if (parseVersion(piece)) return true;
      unknown = true; continue;
    }
    const [, open, lo, comma, hi, close] = m;
    if (!comma) {                                        // "[1.0]" exact
      const c = compareVersions(v, lo);
      if (c === null) { unknown = true; continue; }
      if (c === 0) return true;
      continue;
    }
    let ok = true;
    if (lo) {
      const c = compareVersions(v, lo);
      if (c === null) { unknown = true; continue; }
      ok = open === '[' ? c >= 0 : c > 0;
    }
    if (ok && hi) {
      const c = compareVersions(v, hi);
      if (c === null) { unknown = true; continue; }
      ok = close === ']' ? c <= 0 : c < 0;
    }
    if (ok) return true;
  }
  return unknown ? null : false;
}

/** Matches with whichever syntax fits: Maven for Forge-style ranges, semver predicates otherwise. */
export function satisfies(version, range, style = 'fabric') {
  return style === 'maven' ? satisfiesMaven(version, range) : satisfiesFabric(version, range);
}
