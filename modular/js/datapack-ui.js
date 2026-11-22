// The "Datapack" tab: recipes, tags, loot tables, advancements, custom items, worldgen settings,
// raw files, and a browser for every file the pack will carry. Edits mutate state.datapack and save;
// the form only re-renders on structural changes (select, add, remove) so typing never loses focus.
import { state, saveState, onStateChange } from './state.js';
import { debounce, escapeHtml } from './utils.js';
import { search, getEntry, iconHtml, displayName, hasModData } from './itemdb.js';
import { buildModrinthMod, fetchModrinthProjectData } from './api.js';
import { toast } from './ui.js';
import { openItemBrowser } from './item-browser.js';
import {
  RECIPE_TYPES, TAG_KINDS, LOOT_TYPES, FRAMES, WORLDGEN_PROFILES, worldgenProfile, tectonicOptionsFor,
  datapackContentCount, isValidId, qualify, PAXI_SLUG, mcRules
} from './datapack.js';
import { generate, hasPaxi, textureCache, saveTexture, removeTexture, renameTexture, isPng } from './datapack-io.js';
import { listOverrides, removeOverride, overrideSize, readOverrideText, onOverridesChange } from './overrides.js';

const SECTIONS = [
  ['recipes', 'Recipes'], ['items', 'Custom items'], ['tags', 'Tags'], ['loot', 'Loot tables'],
  ['advancements', 'Advancements'], ['worldgen', 'Worldgen'], ['files', 'Files']
];
const ui = { section: 'recipes', selected: { recipes: 0, items: 0, tags: 0, loot: 0, advancements: 0, raw: 0 }, fileFilter: '', preview: null };

const dp = () => state.datapack;
const save = debounce(() => { saveState(); refreshStatus(); }, 300);

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}

function field(label, input, hint) {
  return el('label', { class: 'dp-field' }, el('span', { class: 'dp-label', text: label }), input, hint ? el('span', { class: 'tool-note', text: hint }) : null);
}

function textInput(value, onInput, props = {}) {
  return el('input', { type: 'text', value, spellcheck: 'false', ...props, oninput: e => onInput(e.target.value) });
}

function numberInput(value, onInput, props = {}) {
  return el('input', { type: 'number', value, ...props, oninput: e => onInput(e.target.value === '' ? NaN : Number(e.target.value)) });
}

function select(options, value, onChange) {
  const sel = el('select', { onchange: e => onChange(e.target.value) },
    options.map(([v, label]) => el('option', { value: v, text: label, selected: v === value })));
  return sel;
}

function checkbox(label, checked, onChange) {
  return el('label', { class: 'dp-check' }, el('input', { type: 'checkbox', checked, onchange: e => onChange(e.target.checked) }), el('span', { text: label }));
}

const button = (text, onclick, cls = '') => el('button', { type: 'button', class: `btn-primary ${cls}`.trim(), onclick, text });
const removeBtn = onclick => el('button', { type: 'button', class: 'dp-x', title: 'Remove', onclick, text: '✕' });

// ---------------------------------------------------------------------------
// Item picker: free text with suggestions from the pack's scanned items (vanilla + mods + custom jars)
// ---------------------------------------------------------------------------

function itemPicker({ value, onChange, allowTag = false, placeholder = 'minecraft:stone', compact = false, kind = 'item' }) {
  const dbKind = kind === 'entity_type' ? 'entity' : 'item'; // itemdb only knows items and mobs
  const icon = el('span', { class: 'dp-icon' });
  const input = el('input', { type: 'text', value: value || '', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const menu = el('div', { class: 'dp-suggest hidden' });
  const browse = el('button', {
    type: 'button', class: 'dp-browse', title: 'Browse all items', text: '⌕',
    onclick: async () => { const picked = await openItemBrowser({ kind: dbKind }); if (picked) commit(picked); }
  });
  const wrap = el('div', { class: `dp-picker${compact ? ' compact' : ''}` }, icon, input, browse, menu);

  const paintIcon = () => {
    const id = input.value.trim();
    const entry = id && !id.startsWith('#') ? getEntry(dbKind, id) : null;
    icon.innerHTML = entry ? iconHtml(entry, 20) : '';
  };
  const commit = v => { input.value = v; paintIcon(); menu.classList.add('hidden'); onChange(v); };

  const showMenu = () => {
    const q = input.value.trim().replace(/^#/, '');
    if ((allowTag && input.value.trim().startsWith('#')) || !q) { menu.classList.add('hidden'); return; }
    const hits = search({ kind: dbKind, query: q.includes(':') ? q.split(':').pop() : q }).slice(0, 30);
    if (!hits.length) { menu.classList.add('hidden'); return; }
    menu.replaceChildren(...hits.map(h => {
      const row = el('div', { class: 'dp-suggest-row' });
      row.innerHTML = `${iconHtml(h, 20)}<span>${escapeHtml(h.name)}</span><small>${escapeHtml(h.key)}</small>`;
      row.addEventListener('pointerdown', e => { e.preventDefault(); commit(h.key); });
      return row;
    }));
    menu.classList.remove('hidden');
  };

  input.addEventListener('input', () => { onChange(input.value.trim()); paintIcon(); showMenu(); });
  input.addEventListener('focus', showMenu);
  input.addEventListener('blur', () => setTimeout(() => menu.classList.add('hidden'), 120));
  paintIcon();
  return wrap;
}

/** Picker for "what this recipe/loot entry gives": a normal item, or one of the pack's custom items. */
function stackPicker(target, { onChange }) {
  const customs = dp().items;
  const mode = target.custom ? 'custom' : 'item';
  const box = el('div', { class: 'dp-stack' });
  if (customs.length) {
    box.append(select([['item', 'Item'], ...customs.map(i => ['c:' + i.id, `Custom: ${i.name || i.id}`])],
      target.custom ? 'c:' + target.custom : 'item', v => {
        if (v === 'item') { target.custom = ''; } else { target.custom = v.slice(2); target.id = target.id || ''; }
        onChange(true);
      }));
  }
  if (mode === 'item') box.append(itemPicker({ value: target.id ?? target.item ?? '', onChange: v => { if ('item' in target && !('id' in target)) target.item = v; else target.id = v; onChange(false); } }));
  return box;
}

// ---------------------------------------------------------------------------
// Generic list + form layout
// ---------------------------------------------------------------------------

function listLayout({ key, items, label, onAdd, onRemove, onDuplicate, renderForm, empty, noun = 'entry' }) {
  const add = () => { onAdd(); ui.selected[key] = items.length - 1; save(); render(); };
  if (!items.length) return el('div', { class: 'dp-empty' }, el('p', { text: empty }), button(`+ Create ${noun}`, add));
  const sel = Math.max(0, Math.min(ui.selected[key] ?? 0, items.length - 1));
  ui.selected[key] = sel;
  const list = el('div', { class: 'dp-list' },
    button('+ New', add, 'w-full'),
    ...items.map((item, i) => el('div', { class: `dp-list-item${i === sel ? ' active' : ''}`, onclick: () => { ui.selected[key] = i; render(); } },
      el('span', { class: 'dp-list-name', text: label(item) || '(unnamed)' }),
      onDuplicate ? el('button', { type: 'button', class: 'dp-ib', title: 'Duplicate', text: '⧉', onclick: e => { e.stopPropagation(); ui.selected[key] = onDuplicate(i); save(); render(); } }) : null,
      removeBtn(e => { e.stopPropagation(); if (!confirm(`Delete "${label(item) || 'this entry'}"?`)) return; onRemove(i); save(); render(); }))));
  return el('div', { class: 'dp-split' }, list, el('div', { class: 'dp-form' }, renderForm(items[sel], sel)));
}

function dupe(list, i, tweak) {
  const copy = structuredClone(list[i]);
  const taken = new Set(list.map(e => e.id));
  let id = `${copy.id}_copy`, n = 2;
  while (taken.has(id)) id = `${copy.id}_copy${n++}`;
  copy.id = id;
  tweak?.(copy);
  list.splice(i + 1, 0, copy);
  return i + 1;
}

const uniqueId = (existing, base) => {
  const taken = new Set(existing.map(e => e.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderRecipes() {
  const d = dp();
  return listLayout({
    key: 'recipes', items: d.recipes, label: r => r.id, empty: 'No recipes yet. Add one to craft, smelt or cut items.',
    onAdd: () => d.recipes.push({ id: uniqueId(d.recipes, 'new_recipe'), type: 'shaped', grid: Array(9).fill(''), ingredients: [''], ingredient: '', result: { id: '', custom: '', count: 1 }, experience: 0.1, cookingtime: 200 }),
    onRemove: i => d.recipes.splice(i, 1), onDuplicate: i => dupe(d.recipes, i), noun: 'recipe',
    renderForm: r => {
      const meta = RECIPE_TYPES[r.type];
      const body = el('div', { class: 'dp-body' });
      const paint = () => {
        const m = RECIPE_TYPES[r.type];
        body.replaceChildren();
        let craftGrid = null;
        if (r.type === 'shaped') {
          body.append(el('span', { class: 'dp-label', text: 'Crafting grid (type #minecraft:planks for a tag)' }));
          craftGrid = (
            el('div', { class: 'dp-grid' }, r.grid.map((cell, i) => itemPicker({ value: cell, allowTag: true, compact: true, placeholder: '—', onChange: v => { r.grid[i] = v; save(); } }))));
        } else if (r.type === 'shapeless') {
          body.append(el('span', { class: 'dp-label', text: 'Ingredients (up to 9)' }),
            ...r.ingredients.map((ing, i) => el('div', { class: 'dp-row' },
              itemPicker({ value: ing, allowTag: true, onChange: v => { r.ingredients[i] = v; save(); } }),
              removeBtn(() => { r.ingredients.splice(i, 1); save(); paint(); }))),
            r.ingredients.length < 9 ? button('+ Ingredient', () => { r.ingredients.push(''); paint(); }) : null);
        } else {
          body.append(field('Input', itemPicker({ value: r.ingredient, allowTag: true, onChange: v => { r.ingredient = v; save(); } })));
          if (m.cooking) {
            body.append(el('div', { class: 'dp-row' },
              field('Experience', numberInput(r.experience, v => { r.experience = v; save(); }, { step: '0.05', min: '0' })),
              field('Cook time (ticks)', numberInput(r.cookingtime, v => { r.cookingtime = v; save(); }, { min: '1' }))));
          }
        }
        const resultBox = el('div', { class: 'dp-row' });
        const paintResult = () => resultBox.replaceChildren(
          field('Result', stackPicker(r.result, { onChange: redraw => { save(); if (redraw) paintResult(); } })),
          field('Count', numberInput(r.result.count, v => { r.result.count = v; save(); }, { min: '1', max: '64' })));
        paintResult();
        if (craftGrid) body.append(el('div', { class: 'dp-craft' }, craftGrid, el('span', { class: 'dp-arrow', text: '→' }), resultBox));
        else body.append(resultBox);
      };
      paint();
      return el('div', {},
        field('Recipe id', textInput(r.id, v => { r.id = v.trim(); save(); }), 'Use a namespace to override another recipe, e.g. minecraft:stick'),
        field('Type', select(Object.entries(RECIPE_TYPES).map(([k, v]) => [k, v.label]), r.type, v => {
          r.type = v; const t = RECIPE_TYPES[v]; if (t.cooking) r.cookingtime = t.defaultTime; save(); paint();
        })),
        body,
        r.result.custom ? el('p', { class: 'tool-note', text: mcRules(state.mcVersion).components || state.loader === 'forge' ? '' : 'Custom items cannot be crafted on Fabric/Quilt 1.20.1. Use a loot table or advancement reward.' }) : null);
    }
  });
}

function renderItems() {
  const d = dp();
  return listLayout({
    key: 'items', items: d.items, label: i => i.name || i.id, empty: 'Custom items re-skin a vanilla item with a name, texture and custom model data.',
    onAdd: () => d.items.push({ id: uniqueId(d.items, 'custom_item'), base: 'minecraft:paper', name: '', customModelData: Math.max(0, ...d.items.map(i => i.customModelData)) + 1, extra: '', hasTexture: false }),
    onRemove: i => { removeTexture(d.items[i].id); d.items.splice(i, 1); },
    onDuplicate: i => dupe(d.items, i, c => { c.hasTexture = false; c.name = c.name ? c.name + ' copy' : ''; c.customModelData = Math.max(0, ...d.items.map(x => x.customModelData)) + 1; }), noun: 'custom item',
    renderForm: item => {
      const rules = mcRules(state.mcVersion);
      const preview = el('div', { class: 'dp-texture' });
      const paintTexture = () => {
        const blob = textureCache.get(item.id);
        preview.replaceChildren(...[
          blob ? el('img', { src: URL.createObjectURL(blob), alt: 'texture', class: 'dp-texture-img' }) : el('span', { class: 'tool-note', text: 'No texture yet.' }),
          el('input', {
            type: 'file', accept: 'image/png', onchange: async e => {
              const file = e.target.files[0]; e.target.value = '';
              if (!file) return;
              if (!(await isPng(file))) return toast('Textures must be PNG files.', { type: 'error' });
              if (file.size > 512 * 1024) return toast('That texture is over 512 KB; item textures should be tiny (16x16 or 32x32).', { type: 'error' });
              await saveTexture(item.id, file); item.hasTexture = true; save(); paintTexture();
            }
          }),
          blob ? button('Remove texture', async () => { await removeTexture(item.id); item.hasTexture = false; save(); paintTexture(); }) : null
        ].filter(Boolean));
      };
      paintTexture();
      return el('div', {},
        field('Item id', textInput(item.id, v => {
          const next = v.trim().toLowerCase();
          if (!/^[a-z0-9_./-]+$/.test(next) || d.items.some(o => o !== item && o.id === next)) return;
          const old = item.id;
          d.recipes.forEach(r => { if (r.result.custom === old) r.result.custom = next; });
          d.lootTables.forEach(t => t.pools.forEach(p => p.entries.forEach(e => { if (e.custom === old) e.custom = next; })));
          item.id = next; renameTexture(old, next); save();
        }), 'Lowercase letters, numbers, _ - . /'),
        field('Base item', itemPicker({ value: item.base, onChange: v => { item.base = v; save(); } }), 'A flat item such as paper, stick or an ingot works best.'),
        field('Display name', textInput(item.name, v => { item.name = v; save(); })),
        field('Custom model data', numberInput(item.customModelData, v => { item.customModelData = v; save(); }, { min: '0', step: '1' })),
        field(rules.components ? 'Extra components (JSON object)' : 'Extra NBT tags',
          el('textarea', { rows: 3, spellcheck: 'false', placeholder: rules.components ? '{"minecraft:unbreakable":{}}' : 'Unbreakable:1b', oninput: e => { item.extra = e.target.value; save(); } }, item.extra),
          rules.components ? 'Merged into the item components.' : 'Added inside the item tag, comma separated.'),
        el('span', { class: 'dp-label', text: 'Texture (PNG)' }), preview,
        el('p', { class: 'tool-note', text: `Get it in game with: /loot give @s loot ${d.namespace}:items/${item.id}` }));
    }
  });
}

function stringList(values, { allowTag, onChange, kind }) {
  const box = el('div', { class: 'dp-stack-col' });
  const paint = () => box.replaceChildren(
    ...values.map((v, i) => el('div', { class: 'dp-row' },
      kind === 'item' || kind === 'block' || kind === 'fluid' || kind === 'entity_type' ? itemPicker({ kind, value: v, allowTag, onChange: x => { values[i] = x; onChange(); } })
        : textInput(v, x => { values[i] = x.trim(); onChange(); }, { placeholder: kind === 'entity_type' ? 'minecraft:zombie' : 'minecraft:plains' }),
      removeBtn(() => { values.splice(i, 1); onChange(); paint(); }))),
    button('+ Value', () => { values.push(''); paint(); }));
  paint();
  return box;
}

function renderTags() {
  const d = dp();
  return listLayout({
    key: 'tags', items: d.tags, label: t => t.id, empty: 'Tags group items, blocks or entities so recipes and other mods can refer to them together.',
    onAdd: () => d.tags.push({ id: uniqueId(d.tags, 'new_tag'), kind: 'item', replace: false, values: [''] }),
    onRemove: i => d.tags.splice(i, 1), onDuplicate: i => dupe(d.tags, i), noun: 'tag',
    renderForm: t => el('div', {},
      field('Tag id', textInput(t.id, v => { t.id = v.trim(); save(); }), 'Use an existing id like minecraft:planks to extend it, or c:ingots/ruby for a new shared tag.'),
      field('Kind', select(Object.entries(TAG_KINDS).map(([k, v]) => [k, v.label]), t.kind, v => { t.kind = v; save(); render(); })),
      checkbox('Replace existing tag instead of adding to it', t.replace, v => { t.replace = v; save(); }),
      el('span', { class: 'dp-label', text: 'Values (use #namespace:tag to include another tag)' }),
      stringList(t.values, { allowTag: true, kind: t.kind, onChange: save }))
  });
}

function renderLoot() {
  const d = dp();
  return listLayout({
    key: 'loot', items: d.lootTables, label: t => t.id, empty: 'Loot tables control drops. Use an existing id like minecraft:blocks/stone to override vanilla.',
    onAdd: () => d.lootTables.push({ id: uniqueId(d.lootTables, 'new_loot'), type: 'generic', pools: [{ rollsMin: 1, rollsMax: 1, entries: [{ item: '', custom: '', weight: 1, min: 1, max: 1 }] }] }),
    onRemove: i => d.lootTables.splice(i, 1), onDuplicate: i => dupe(d.lootTables, i), noun: 'loot table',
    renderForm: t => {
      const pools = el('div', { class: 'dp-stack-col' });
      const paint = () => pools.replaceChildren(...t.pools.map((p, pi) => el('div', { class: 'dp-card' },
        el('div', { class: 'dp-row' },
          el('strong', { text: `Pool ${pi + 1}` }),
          field('Rolls min', numberInput(p.rollsMin, v => { p.rollsMin = v; save(); }, { min: '0' })),
          field('Rolls max', numberInput(p.rollsMax, v => { p.rollsMax = v; save(); }, { min: '0' })),
          removeBtn(() => { t.pools.splice(pi, 1); save(); paint(); })),
        ...p.entries.map((e, ei) => {
          const row = el('div', { class: 'dp-row dp-entry' });
          const paintRow = () => row.replaceChildren(
            stackPicker(e, { onChange: redraw => { save(); if (redraw) paintRow(); } }),
            field('Weight', numberInput(e.weight, v => { e.weight = v; save(); }, { min: '1' })),
            field('Min', numberInput(e.min, v => { e.min = v; save(); }, { min: '1' })),
            field('Max', numberInput(e.max, v => { e.max = v; save(); }, { min: '1' })),
            removeBtn(() => { p.entries.splice(ei, 1); save(); paint(); }));
          paintRow();
          return row;
        }),
        button('+ Entry', () => { p.entries.push({ item: '', custom: '', weight: 1, min: 1, max: 1 }); paint(); }))),
        button('+ Pool', () => { t.pools.push({ rollsMin: 1, rollsMax: 1, entries: [{ item: '', custom: '', weight: 1, min: 1, max: 1 }] }); paint(); }));
      paint();
      return el('div', {},
        field('Loot table id', textInput(t.id, v => { t.id = v.trim(); save(); })),
        field('Type', select(Object.entries(LOOT_TYPES), t.type, v => { t.type = v; save(); })),
        pools);
    }
  });
}

function renderAdvancements() {
  const d = dp();
  return listLayout({
    key: 'advancements', items: d.advancements, label: a => a.title || a.id, empty: 'Advancements can give players recipes, loot or XP.',
    onAdd: () => d.advancements.push({ id: uniqueId(d.advancements, 'new_advancement'), parent: '', title: '', description: '', icon: 'minecraft:stone', frame: 'task', trigger: 'inventory_changed', item: '', toast: true, announce: true, rewardXp: 0, rewardRecipes: [], rewardLoot: [] }),
    onRemove: i => d.advancements.splice(i, 1), onDuplicate: i => dupe(d.advancements, i), noun: 'advancement',
    renderForm: a => {
      const trig = el('div', {});
      const paintTrig = () => trig.replaceChildren(a.trigger === 'inventory_changed' ? field('Triggers when the player gets', itemPicker({ value: a.item, onChange: v => { a.item = v; save(); } })) : null);
      paintTrig();
      return el('div', {},
        field('Advancement id', textInput(a.id, v => { a.id = v.trim(); save(); })),
        field('Title', textInput(a.title, v => { a.title = v; save(); })),
        field('Description', textInput(a.description, v => { a.description = v; save(); })),
        field('Icon', itemPicker({ value: a.icon, onChange: v => { a.icon = v; save(); } })),
        field('Parent (optional)', textInput(a.parent, v => { a.parent = v.trim(); save(); }, { placeholder: 'minecraft:story/mine_stone' })),
        field('Frame', select(FRAMES.map(f => [f, f]), a.frame, v => { a.frame = v; save(); })),
        field('Trigger', select([['inventory_changed', 'Player obtains an item'], ['impossible', 'Granted manually (commands)']], a.trigger, v => { a.trigger = v; save(); paintTrig(); })),
        trig,
        el('div', { class: 'dp-row' }, checkbox('Toast', a.toast, v => { a.toast = v; save(); }), checkbox('Announce in chat', a.announce, v => { a.announce = v; save(); })),
        field('XP reward', numberInput(a.rewardXp, v => { a.rewardXp = v; save(); }, { min: '0' })),
        el('span', { class: 'dp-label', text: 'Recipes to unlock (ids)' }),
        stringList(a.rewardRecipes, { kind: 'text', onChange: save }),
        el('span', { class: 'dp-label', text: 'Loot tables to give (ids)' }),
        stringList(a.rewardLoot, { kind: 'text', onChange: save }));
    }
  });
}

// ---------------------------------------------------------------------------
// Worldgen
// ---------------------------------------------------------------------------

async function addMod(slug, button_) {
  button_.disabled = true; button_.textContent = 'Adding...';
  try {
    const mod = await buildModrinthMod(slug, { category: slug === PAXI_SLUG ? 'Utility' : 'Worldgen' });
    if (!mod) toast(`No ${slug} version found for ${state.mcVersion || 'this version'} on ${state.loader}.`, { type: 'error' });
    else if (!state.mods.some(m => m.slug === mod.slug)) { state.mods.push(mod); saveState(); }
  } catch { toast(`Could not reach Modrinth to add ${slug}.`, { type: 'error' }); }
  render();
}

function removeMod(slug) {
  state.mods = state.mods.filter(m => m.slug !== slug);
  saveState();
  render();
}

const FALLBACK_MOD_ICON = 'https://docs.modrinth.com/img/logo.svg';
const modMetaCache = new Map();
const modMetaPending = new Map();
const formatCount = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

function getModMeta(slug, onLoad) {
  if (modMetaCache.has(slug)) return modMetaCache.get(slug);
  if (!modMetaPending.has(slug)) {
    modMetaPending.set(slug, fetchModrinthProjectData(slug)
      .then(proj => { modMetaCache.set(slug, proj); onLoad?.(proj); })
      .catch(() => {})
      .finally(() => modMetaPending.delete(slug)));
  }
  return null;
}

function modOptionCard(m) {
  const present = state.mods.some(x => x.slug === m.slug);
  const icon = el('img', { class: 'mod-icon', src: FALLBACK_MOD_ICON, alt: `${m.name} icon` });
  const stats = el('div', { class: 'mod-stats' });

  const paintMeta = proj => {
    if (proj?.icon_url) icon.src = proj.icon_url;
    const parts = [];
    if (proj) parts.push(`⬇ ${formatCount(proj.downloads)}`, `★ ${formatCount(proj.followers)}`);
    if (m.note) parts.push(m.note);
    stats.textContent = parts.join(' · ');
  };

  paintMeta(getModMeta(m.slug, paintMeta));

  const action = present
    ? el('button', { type: 'button', class: 'btn-primary dp-mod-remove', text: 'Remove', onclick: () => removeMod(m.slug) })
    : el('button', { type: 'button', class: 'btn-primary', text: '+ Add', onclick: e => addMod(m.slug, e.target) });

  return el('div', { class: `dp-mod-card${present ? ' active' : ''}` },
    icon,
    el('div', { class: 'mod-info' },
      el('h4', {},
        el('span', { text: m.name }),
        m.role ? el('span', { class: 'dp-mod-role', text: m.role }) : null,
        present ? el('span', { class: 'dp-mod-badge', text: '✓ In pack' }) : null),
      el('p', { text: m.description || '' }),
      stats),
    el('div', { class: 'dp-mod-actions' },
      action,
      m.url ? el('a', { class: 'dp-mod-link', href: m.url, target: '_blank', rel: 'noopener noreferrer', text: 'Modrinth ↗' }) : null));
}

const WG_GROUPS = {
  general: 'General', global_terrain: 'Terrain shape', continents: 'Continents & rivers',
  islands: 'Islands', oceans: 'Oceans', caves: 'Caves'
};
const wgClosed = new Set();
let wgFilter = '';

function renderWorldgen() {
  const d = dp();
  const profile = worldgenProfile(state.mcVersion);
  if (!profile) {
    return el('div', { class: 'dp-form' },
      el('p', { class: 'tool-note', text: `Worldgen tools target ${Object.entries(WORLDGEN_PROFILES).map(([v, p]) => `${v} (${p.label})`).join(' and ')}. Set the Minecraft version to one of those to use them.` }),
      renderRaw());
  }

  const total = el('strong');
  const groups = new Map();                       // section -> {details, badge, rows: [{row, opt}]}
  const fmt = v => typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);

  const refresh = () => {
    let changed = 0;
    groups.forEach(g => {
      const n = g.rows.filter(r => r.opt.path in d.tectonic).length;
      changed += n;
      g.badge.textContent = n ? `${n} changed` : '';
    });
    total.textContent = changed ? `${changed} option${changed === 1 ? '' : 's'} changed` : 'All defaults';
  };

  for (const opt of tectonicOptionsFor(profile)) {
    const section = opt.path.split('.')[0];
    if (!groups.has(section)) {
      const badge = el('span', { class: 'dp-wg-badge' });
      const details = el('details', { class: 'dp-wg-group', open: !wgClosed.has(section), ontoggle: e => { e.target.open ? wgClosed.delete(section) : wgClosed.add(section); } },
        el('summary', {}, el('span', { text: WG_GROUPS[section] || section }), badge));
      const rowsBox = el('div', { class: 'dp-wg-rows' });
      details.append(rowsBox);
      groups.set(section, { details, badge, rowsBox, rows: [] });
    }
    const g = groups.get(section);

    const current = opt.path in d.tectonic ? d.tectonic[opt.path] : opt.def;
    const row = el('div', { class: 'dp-wg-row' });
    let input;
    const mark = () => { row.classList.toggle('changed', opt.path in d.tectonic); refresh(); };
    const set = v => {
      if (v === opt.def || (typeof v === 'number' && !Number.isFinite(v))) delete d.tectonic[opt.path]; else d.tectonic[opt.path] = v;
      save(); mark();
    };
    if (opt.type === 'bool') input = el('input', { type: 'checkbox', class: 'dp-switch', checked: current, onchange: e => set(e.target.checked) });
    else input = numberInput(current, set, { step: opt.type === 'int' ? '1' : String(opt.step ?? 0.01), inputmode: 'decimal' });
    const reset = el('button', { type: 'button', class: 'dp-ib dp-wg-reset', title: 'Reset to default', text: '↺', onclick: () => {
      delete d.tectonic[opt.path];
      if (opt.type === 'bool') input.checked = opt.def; else input.value = opt.def;
      save(); mark();
    } });
    row.append(el('div', { class: 'dp-wg-name' }, el('span', { text: opt.label }), el('small', { text: `default ${fmt(opt.def)}` })), input, reset);
    row.classList.toggle('changed', opt.path in d.tectonic);
    row.dataset.text = `${opt.label} ${opt.path}`.toLowerCase();
    g.rowsBox.append(row);
    g.rows.push({ row, opt });
  }

  const applyFilter = () => {
    const q = wgFilter.trim().toLowerCase();
    groups.forEach(g => {
      let visible = 0;
      g.rows.forEach(r => { const show = !q || r.row.dataset.text.includes(q); r.row.classList.toggle('hidden', !show); if (show) visible++; });
      g.details.classList.toggle('hidden', visible === 0);
      if (q) g.details.open = true;
    });
  };

  const bar = el('div', { class: 'dp-wg-bar' },
    el('input', { type: 'search', placeholder: 'Find an option…', value: wgFilter, oninput: e => { wgFilter = e.target.value; applyFilter(); } }),
    total,
    button('Reset all', () => { if (!Object.keys(d.tectonic).length || !confirm('Reset every Tectonic option to its default?')) return; d.tectonic = {}; save(); render(); }));

  const out = el('div', { class: 'dp-form dp-wide' },
    el('div', { class: 'dp-wg-head' },
      el('strong', { text: 'Worldgen Mods' }),
      el('span', { class: 'tool-note', text: `Minecraft ${state.mcVersion} · ${profile.label}` })),
    el('div', { class: 'dp-wg-mods' }, ...profile.mods.map(modOptionCard)),
    el('p', { class: 'tool-note', text: 'Only Tectonic options you change are written, to config/tectonic.json. Tectonic fills in the rest the first time it loads. For changes to the terrain itself, use a raw file below.' }),
    bar, ...[...groups.values()].map(g => g.details),
    renderRaw());
  refresh(); applyFilter();
  return out;
}

const rawOpen = new WeakSet();

function jsonCheck(path, content) {
  if (!/\.json$/i.test(path)) return null;
  try { JSON.parse(content); return { ok: true, text: '✓ valid JSON' }; }
  catch (e) { return { ok: false, text: `✕ ${String(e.message).replace(/^JSON\.parse: /, '').slice(0, 70)}` }; }
}

function renderRaw() {
  const d = dp();
  const box = el('div', { class: 'dp-card' }, el('strong', { text: 'Raw files' }),
    el('p', { class: 'tool-note', text: 'Add any JSON file to the datapack (data/…) or resource pack (assets/…), for example data/minecraft/worldgen/noise_settings/overworld.json or a single Terralith biome override.' }));
  d.rawFiles.forEach(f => {
    const badge = el('span', { class: 'dp-valid' });
    const nameEl = el('span', { class: 'dp-raw-path', text: f.path || '(no path)' });
    const paintBadge = () => { const r = jsonCheck(f.path, f.content); badge.className = r ? (r.ok ? 'dp-valid' : 'dp-invalid') : ''; badge.textContent = r ? r.text : ''; nameEl.textContent = f.path || '(no path)'; };
    paintBadge();
    const details = el('details', { class: 'dp-card dp-raw', open: rawOpen.has(f), ontoggle: e => { e.target.open ? rawOpen.add(f) : rawOpen.delete(f); } },
      el('summary', {}, nameEl, badge, removeBtn(e => { e.preventDefault(); if (!confirm(`Delete ${f.path || 'this file'}?`)) return; d.rawFiles.splice(d.rawFiles.indexOf(f), 1); save(); render(); })),
      el('div', { class: 'dp-stack-col' },
        textInput(f.path, v => { f.path = v.trim(); save(); paintBadge(); }, { placeholder: 'data/minecraft/worldgen/biome/plains.json' }),
        el('textarea', { rows: 10, spellcheck: 'false', oninput: e => { f.content = e.target.value; save(); paintBadge(); } }, f.content)));
    box.append(details);
  });
  box.append(button('+ Raw file', () => { const f = { path: 'data/minecraft/', content: '{\n}\n' }; d.rawFiles.push(f); rawOpen.add(f); save(); render(); }));
  return box;
}

// ---------------------------------------------------------------------------
// Files browser (imported pass-through files + what the editor will generate)
// ---------------------------------------------------------------------------

const fmtSize = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function renderFiles() {
  const generated = generate();
  const imported = listOverrides();
  const q = ui.fileFilter.toLowerCase();
  const match = p => !q || p.toLowerCase().includes(q);
  const groupOf = p => p.replace(/^(client-|server-)?overrides\//i, '').split('/').slice(0, 2).join('/');
  const groups = new Map();
  const add = (path, source) => {
    if (!match(path)) return;
    const g = groupOf(path);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ path, source });
  };
  imported.forEach(p => add(p, 'imported'));
  [...generated.overrides.keys()].forEach(p => add(p, 'generated'));

  const preview = el('div', { class: 'dp-preview' });
  if (ui.preview) {
    const gen = generated.overrides.get(ui.preview);
    Promise.resolve(gen !== undefined ? (typeof gen === 'string' ? gen : null) : readOverrideText(ui.preview)).then(text => {
      preview.replaceChildren(el('strong', { text: ui.preview }), el('pre', { text: text == null ? '(binary file)' : text.length > 60000 ? text.slice(0, 60000) + '\n… (truncated)' : text }));
    }).catch(() => { preview.textContent = 'Could not read this file.'; });
  }

  const tree = el('div', { class: 'dp-tree' }, groups.size ? [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) =>
    el('details', { open: q ? true : null },
      el('summary', {}, el('span', { text: name || '(root)' }), el('small', { text: ` ${list.length}` }),
        list.some(f => f.source === 'imported') ? el('button', {
          type: 'button', class: 'dp-x', title: 'Remove all imported files in this folder', text: '✕ all',
          onclick: e => { e.preventDefault(); const rm = list.filter(f => f.source === 'imported'); if (!confirm(`Remove ${rm.length} imported file${rm.length === 1 ? '' : 's'} from ${name}?`)) return; rm.forEach(f => removeOverride(f.path)); render(); }
        }) : null),
      list.sort((a, b) => a.path.localeCompare(b.path)).map(f => el('div', { class: 'dp-file' },
        el('span', { class: `dp-badge ${f.source}`, text: f.source }),
        el('a', { href: '#', text: f.path.replace(/^(client-|server-)?overrides\//i, '').slice(name.length + 1) || f.path, title: f.path, onclick: e => { e.preventDefault(); ui.preview = f.path; render(); } }),
        el('small', { text: fmtSize(f.source === 'imported' ? overrideSize(f.path) : (typeof generated.overrides.get(f.path) === 'string' ? new Blob([generated.overrides.get(f.path)]).size : generated.overrides.get(f.path)?.size)) }),
        f.source === 'imported' ? removeBtn(() => { removeOverride(f.path); if (ui.preview === f.path) ui.preview = null; render(); }) : null))))
    : el('p', { class: 'tool-note', text: q ? 'No files match.' : 'No files yet. Imported configs and generated datapack files appear here.' }));

  return el('div', { class: 'dp-form dp-wide' },
    el('p', { class: 'tool-note', text: 'Everything the exported pack will contain besides mods and quests. Imported files are saved in this browser and written back on export; generated files come from the editor and win on conflict.' }),
    generated.conflicts.length ? el('p', { class: 'dp-warn', text: `${generated.conflicts.length} imported file${generated.conflicts.length === 1 ? ' is' : 's are'} replaced by generated files: ${generated.conflicts.slice(0, 3).join(', ')}${generated.conflicts.length > 3 ? '…' : ''}` }) : null,
    el('input', { type: 'search', placeholder: 'Filter files…', value: ui.fileFilter, oninput: e => { ui.fileFilter = e.target.value; clearTimeout(renderFiles.t); renderFiles.t = setTimeout(() => { render(); document.querySelector('#datapack-root input[type=search]')?.focus(); }, 250); } }),
    tree, preview);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function renderStatus() {
  const g = generate();
  const errors = g.issues.filter(i => i.level === 'error'), warns = g.issues.filter(i => i.level === 'warn');
  const bar = el('div', { class: 'dp-status' });
  if (g.usesPaxi) {
    bar.append(hasPaxi()
      ? el('span', { class: 'dp-ok', text: '✓ Paxi is in the pack, so these packs load in every world.' })
      : el('span', { class: 'dp-warn' }, 'Paxi is needed to load these packs in every world. ', el('button', { type: 'button', class: 'btn-primary', text: 'Add Paxi', onclick: e => addMod(PAXI_SLUG, e.target) })));
  }
  if (!hasModData() && datapackContentCount(dp()) > 0) bar.append(el('span', { class: 'tool-note', text: 'Tip: scan the pack mods from the Quests tab explorer to search mod items here.' }));
  if (g.issues.length) {
    bar.append(el('details', {}, el('summary', { class: errors.length ? 'dp-warn' : 'tool-note', text: `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}` }),
      ...g.issues.map(i => el('div', { class: i.level === 'error' ? 'dp-warn' : 'tool-note', text: `${i.level === 'error' ? '✕' : '!'} ${i.where}: ${i.message}` }))));
  }
  return bar;
}

function refreshStatus() {
  const old = document.getElementById('dp-status-slot');
  if (old) old.replaceChildren(renderStatus());
}

const RENDERERS = { recipes: renderRecipes, items: renderItems, tags: renderTags, loot: renderLoot, advancements: renderAdvancements, worldgen: renderWorldgen, files: renderFiles };

export function render() {
  const root = document.getElementById('datapack-root');
  if (!root) return;
  const scroll = root.querySelector('.dp-content')?.scrollTop ?? 0;
  const d = dp();
  const counts = { recipes: d.recipes.length, items: d.items.length, tags: d.tags.length, loot: d.lootTables.length, advancements: d.advancements.length, worldgen: Object.keys(d.tectonic).length + d.rawFiles.length };
  const nav = el('div', { class: 'dp-nav' }, SECTIONS.map(([id, label]) =>
    el('button', { type: 'button', class: `dp-nav-btn${ui.section === id ? ' active' : ''}`, onclick: () => { ui.section = id; render(); } },
      label, counts[id] ? el('span', { class: 'dp-count', text: String(counts[id]) }) : null)));
  const content = el('div', { class: 'dp-content' }, RENDERERS[ui.section]());
  root.replaceChildren(
    el('div', { class: 'dp-head' }, nav,
      el('div', { class: 'dp-ns' }, el('span', { class: 'dp-label', text: 'Namespace' }), textInput(dp().namespace, v => { if (/^[a-z0-9_.-]+$/.test(v)) { dp().namespace = v; save(); } }, { size: '12' }))),
    el('div', { id: 'dp-status-slot' }, renderStatus()), content);
  content.scrollTop = scroll;
}

export function initDatapack() {
  onOverridesChange(() => { if (ui.section === 'files' && document.getElementById('tab-datapack')?.classList.contains('active')) render(); });
  onStateChange(() => { if (ui.section === 'worldgen' && document.getElementById('tab-datapack')?.classList.contains('active')) render(); });
  document.querySelector('.center-tab[data-target="tab-datapack"]')?.addEventListener('click', render);
  render();
}
