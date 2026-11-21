// Pack Tools sidebar panel: Mob Spawn Control (You Shall Not Spawn) and the imported-files list.
import { state, saveState } from './state.js';
import { listOverrides, removeOverride, clearOverrides } from './overrides.js';
import { toast } from './ui.js';

const $ = id => document.getElementById(id);

function listItem(text, onRemove) {
  const row = document.createElement('div');
  row.className = 'tool-item';
  const label = document.createElement('span');
  label.textContent = text;
  const btn = document.createElement('button');
  btn.textContent = '✕';
  btn.title = 'Remove';
  btn.addEventListener('click', onRemove);
  row.append(label, btn);
  return row;
}

function emptyNote(text) {
  const el = document.createElement('div');
  el.className = 'tool-note';
  el.textContent = text;
  return el;
}

function renderYSNS() {
  const { disabled, dimensions } = state.packTools.ysns;

  $('ysns-disabled-list').replaceChildren(...(disabled.length
    ? disabled.map((entity, i) => listItem(entity, () => { disabled.splice(i, 1); saveState(); }))
    : [emptyNote('Nothing disabled.')]));

  $('ysns-dim-list').replaceChildren(...(dimensions.length
    ? dimensions.map((r, i) => listItem(`${r.entity} in ${r.dimension}: ${r.spawn_chance}`, () => { dimensions.splice(i, 1); saveState(); }))
    : [emptyNote('No per-dimension rules.')]));
}

function renderImported() {
  const paths = listOverrides();
  $('imported-count').textContent = paths.length ? `(${paths.length})` : '';
  $('btn-imported-clear').classList.toggle('hidden', paths.length === 0);
  $('imported-list').replaceChildren(...(paths.length
    ? paths.map(path => listItem(path.replace(/^overrides\//i, ''), () => { removeOverride(path); renderImported(); }))
    : [emptyNote('No imported files.')]));
}

/** Re-draws everything in the panel from current state. Safe to call at any time. */
export function renderPackTools() {
  renderYSNS();
  renderImported();
}

function addDisabled() {
  const input = $('ysns-disabled-input');
  const value = input.value.trim();
  if (!value) return;
  const { disabled } = state.packTools.ysns;
  if (!disabled.includes(value)) disabled.push(value);
  input.value = '';
  saveState();
}

function addDimensionRule() {
  const entity = $('ysns-dim-entity').value.trim();
  const dimension = $('ysns-dim-dimension').value.trim();
  const chance = Number($('ysns-dim-chance').value);

  if (!entity || !dimension) return toast('Enter both an entity and a dimension.', { type: 'error' });
  if (!Number.isFinite(chance) || chance < 0 || chance > 1) return toast('Spawn chance must be between 0 and 1.', { type: 'error' });

  const { dimensions } = state.packTools.ysns;
  const existing = dimensions.find(r => r.entity === entity && r.dimension === dimension);
  if (existing) existing.spawn_chance = chance;
  else dimensions.push({ entity, dimension, spawn_chance: chance });

  $('ysns-dim-entity').value = '';
  saveState();
}

export function initPackTools() {
  document.querySelectorAll('.tool-accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('active');
      $(header.dataset.target).classList.toggle('hidden');
    });
  });

  $('btn-ysns-disabled-add').addEventListener('click', addDisabled);
  $('ysns-disabled-input').addEventListener('keydown', e => { if (e.key === 'Enter') addDisabled(); });
  $('btn-ysns-dim-add').addEventListener('click', addDimensionRule);

  $('btn-imported-clear').addEventListener('click', () => {
    if (!confirm('Remove all imported files? They will no longer be exported.')) return;
    clearOverrides();
    renderImported();
  });

  renderPackTools();
}
