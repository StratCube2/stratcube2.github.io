// User-made groups for organising the pack list. Nothing here is automatic: groups are created,
// named, ordered and filled by the user. A mod belongs to at most one group (`mod.group`);
// mods without one are "Ungrouped".
import { state, saveState } from './state.js';
import { newId } from './utils.js';

const cleanName = name => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);

export const groupById = id => state.groups.find(g => g.id === id) || null;

export const modsInGroup = id => state.mods.filter(m => (m.group || null) === id);

/** Group that newly added mods land in, or null for Ungrouped. */
export const targetGroupId = () => (groupById(state.activeGroup) ? state.activeGroup : null);

export function addGroup(name) {
  name = cleanName(name);
  if (!name) return null;
  const existing = state.groups.find(g => g.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const group = { id: newId(), name, collapsed: false };
  state.groups.push(group);
  saveState();
  return group;
}

export function renameGroup(id, name) {
  const group = groupById(id);
  name = cleanName(name);
  if (!group || !name) return;
  group.name = name;
  saveState();
}

/** Removes the group only; its mods stay in the pack and become Ungrouped. */
export function deleteGroup(id) {
  state.mods.forEach(m => { if (m.group === id) delete m.group; });
  state.groups = state.groups.filter(g => g.id !== id);
  if (state.activeGroup === id) state.activeGroup = null;
  saveState();
}

export function moveGroup(id, direction) {
  const i = state.groups.findIndex(g => g.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= state.groups.length) return;
  [state.groups[i], state.groups[j]] = [state.groups[j], state.groups[i]];
  saveState();
}

export function toggleGroup(id) {
  const group = groupById(id);
  if (!group) return;
  group.collapsed = !group.collapsed;
  saveState();
}

/** Puts mods in a group (groupId null = Ungrouped). */
export function setModGroup(modIds, groupId) {
  const ids = new Set([].concat(modIds));
  const target = groupById(groupId) ? groupId : null;
  state.mods.forEach(m => {
    if (!ids.has(m.id)) return;
    if (target) m.group = target; else delete m.group;
  });
  saveState();
}

export function setActiveGroup(id) {
  state.activeGroup = groupById(id) ? id : null;
  saveState();
}

// --- .mrpack round trip: groups travel in the index under a "modular" key, keyed by mod slug ---

export function exportGroups() {
  const used = state.groups;
  if (used.length === 0) return null;
  const assignments = {};
  state.mods.forEach(m => { const g = groupById(m.group); if (g) assignments[m.slug] = g.name; });
  return { groups: used.map(g => ({ name: g.name })), assignments };
}

/** Replaces the groups with the ones stored in an imported pack (or clears them if it has none). */
export function applyImportedGroups(mods, data) {
  state.groups = [];
  state.activeGroup = null;
  const names = Array.isArray(data?.groups) ? data.groups.map(g => cleanName(g?.name)).filter(Boolean) : [];
  const byName = new Map();
  names.forEach(n => { if (!byName.has(n)) { const g = { id: newId(), name: n, collapsed: false }; byName.set(n, g); state.groups.push(g); } });
  const assignments = data?.assignments && typeof data.assignments === 'object' ? data.assignments : {};
  mods.forEach(m => { const g = byName.get(assignments[m.slug]); if (g) m.group = g.id; });
}
