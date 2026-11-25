// App preferences (theme, auto scan, ...). These belong to the person using Modular, not to the
// modpack, so they live under their own localStorage key and are never exported with a pack.

const KEY = 'modular_settings';
const MB = 1024 * 1024;

export const THEMES = [
  { id: 'green',    label: 'Modular',  swatch: '#6EE75A' },
  { id: 'ocean',    label: 'Ocean',    swatch: '#5AB8FF' },
  { id: 'violet',   label: 'Violet',   swatch: '#B38CFF' },
  { id: 'ember',    label: 'Ember',    swatch: '#FFA94D' },
  { id: 'daylight', label: 'Daylight', swatch: '#f4f6f8' }
];

export const DEFAULTS = {
  theme: 'green',
  autoScan: false,        // read mod jars in the background whenever the pack changes
  autoScanLimitMB: 100,   // skip an automatic scan that would download more than this (0 = no limit)
  confirmDownloadMB: 150, // ask before a manual scan downloads more than this (0 = never ask)
  autoDependencies: true  // add a mod's required Modrinth dependencies when it is added
};

const listeners = [];
let values = { ...DEFAULTS };

/** Keeps only known keys of the right type, so a bad or old save can't break anything. */
function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (typeof raw[key] === typeof def) out[key] = raw[key];
  }
  if (!THEMES.some(t => t.id === out.theme)) out.theme = DEFAULTS.theme;
  for (const key of ['autoScanLimitMB', 'confirmDownloadMB']) {
    if (!Number.isFinite(out[key]) || out[key] < 0) out[key] = DEFAULTS[key];
  }
  return out;
}

export const getSetting = key => values[key];
export const allSettings = () => ({ ...values });

export function onSettingsChange(fn) { listeners.push(fn); }

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* private mode / full: still works this session */ }
}

export function setSetting(key, value) {
  if (!(key in DEFAULTS) || values[key] === value) return;
  values = sanitize({ ...values, [key]: value });
  persist();
  if (key === 'theme') applyTheme();
  listeners.forEach(fn => fn(key, values[key]));
}

export function resetSettings() {
  const before = values;
  values = { ...DEFAULTS };
  persist();
  applyTheme();
  Object.keys(DEFAULTS).filter(k => before[k] !== values[k]).forEach(k => listeners.forEach(fn => fn(k, values[k])));
}

export function applyTheme() {
  document.documentElement.dataset.theme = values.theme;
}

/** Loads saved settings and applies the theme. Call once at startup. */
export function loadSettings() {
  try { values = sanitize(JSON.parse(localStorage.getItem(KEY))); } catch { values = { ...DEFAULTS }; }
  applyTheme();
}

/** True when a download this big deserves a confirmation, per the user's setting. */
export const exceedsDownloadWarning = bytes => values.confirmDownloadMB > 0 && bytes > values.confirmDownloadMB * MB;
export const autoScanLimitBytes = () => values.autoScanLimitMB * MB;
