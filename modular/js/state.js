import { newId } from './utils.js';
import { putRecord, deleteRecord, clearStore, getAllRecords } from './storage.js';
import { createDatapack, normalizeDatapack } from './datapack.js';

/** Settings for the Pack Tools panel. Exported into the pack as config files. */
export const createPackTools = () => ({
  ysns: { disabled: [], dimensions: [] } // You Shall Not Spawn
});

/** Fills in anything missing so saves from older versions (or bad data) can't break the panel. */
export function normalizePackTools(raw) {
  const tools = createPackTools();
  const ysns = raw?.ysns;
  if (Array.isArray(ysns?.disabled)) {
    tools.ysns.disabled = ysns.disabled.filter(e => typeof e === 'string' && e.trim()).map(e => e.trim());
  }
  if (Array.isArray(ysns?.dimensions)) {
    tools.ysns.dimensions = ysns.dimensions.flatMap(r => {
      const entity = r?.entity ?? r?.entityId; // older saves used "entityId"
      const chance = Number(r?.spawn_chance);
      if (typeof entity !== 'string' || typeof r?.dimension !== 'string' || !Number.isFinite(chance)) return [];
      return [{ entity, dimension: r.dimension, spawn_chance: chance }];
    });
  }
  return tools;
}

export const state = {
  name: "My Modpack",
  mcVersion: "",
  loader: "fabric",
  loaderVersion: "",
  sinytraEnabled: false,
  mods: [],
  packTools: createPackTools(),
  datapack: createDatapack()
};

export let customFiles = [];

export const questState = {
  chapters: [{
    id: newId(), filename: 'getting_started', title: 'Getting Started',
    order_index: 0, quests: []
  }],
  activeChapter: 0,
  selectedQuestId: null,
  linkSource: null,
  canvasOffset: { x: 60, y: 60 },
  canvasScale: 1,
  dragging: null,
  isPanning: false,
  panStart: null
};

const STORAGE_KEY = "modpackgen_state";
const listeners = [];

export function onStateChange(fn) { listeners.push(fn); }

export function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved);
    Object.assign(state, parsed, { mods: parsed.mods || [], packTools: normalizePackTools(parsed.packTools), datapack: normalizeDatapack(parsed.datapack) });
  }
}

export function saveState() {
  const stateToSave = { ...state, mods: state.mods.map(m => ({ ...m, fileBlob: null })) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
  listeners.forEach(fn => fn());
}

export function loadQuestState() {
  const saved = localStorage.getItem('modpackgen_quests');
  if (saved) {
    const parsed = JSON.parse(saved);
    if (parsed.chapters) questState.chapters = parsed.chapters;
  }
}

export function saveQuestState() {
  localStorage.setItem('modpackgen_quests', JSON.stringify({ chapters: questState.chapters }));
}

export function addCustomFile(modObj, file) {
  state.mods.push(modObj);
  customFiles.push({ id: modObj.id, file: file });
  putRecord('jars', modObj.id, file);
  saveState();
}

export function removeCustomFile(id) {
  customFiles = customFiles.filter(f => f.id !== id);
  deleteRecord('jars', id);
}

export function clearCustomFiles() {
  customFiles = [];
  clearStore('jars');
}

/** Registers the File behind a custom mod without touching the mod list or saving. */
export function setCustomFile(id, file) {
  customFiles.push({ id, file });
  putRecord('jars', id, file);
}

/** Reloads custom mod jars saved by a previous session. Call once at startup. */
export async function hydrateCustomFiles() {
  const wanted = new Set(state.mods.filter(m => m.custom).map(m => m.id));
  const records = await getAllRecords('jars');
  for (const { key, value } of records) {
    if (!wanted.has(key)) { deleteRecord('jars', key); continue; } // orphan from a removed mod
    if (!customFiles.some(c => c.id === key)) customFiles.push({ id: key, file: value });
  }
  return customFiles.length;
}
