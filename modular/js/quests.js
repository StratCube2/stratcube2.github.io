import { questState, saveQuestState } from './state.js';
import { newId, escapeHtml, debounce, TASK_ICONS } from './utils.js';
import { initExplorer, renderTarget } from './quest-explorer.js';
import { getEntry, displayName, iconHtml, onRegistryChange } from './itemdb.js';
import { toast } from './ui.js';

const GRID = 80;                       // px per quest-map unit
const NODE_W = 150, NODE_H = 70;       // default rectangular node size
const SHAPE_SIZE = 124;                // 1:1 size for shaped nodes
const MIN_SCALE = 0.25, MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 6;              // px of movement before a tap becomes a drag/pan
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const currentChapter = () => questState.chapters[questState.activeChapter];
const saveSoon = debounce(saveQuestState, 300);
// Don't lose a pending edit if the tab is closed or backgrounded (common on tablets).
window.addEventListener('pagehide', saveQuestState);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveQuestState(); });

const isShaped = q => !!(q?.shape && q.shape !== 'default');
const nodeSize = q => isShaped(q) ? { w: SHAPE_SIZE, h: SHAPE_SIZE } : { w: NODE_W, h: NODE_H };

function gearPoints(teeth = 8, rOut = 47, rIn = 38) {
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i * 2 * Math.PI) / teeth;
    for (const [da, r] of [[-0.25, rIn], [-0.14, rOut], [0.14, rOut], [0.25, rIn]]) {
      pts.push(`${(50 + r * Math.cos(a + da)).toFixed(1)},${(50 + r * Math.sin(a + da)).toFixed(1)}`);
    }
  }
  return pts.join(' ');
}

function sunPoints(rays = 12, rOut = 48, rIn = 37) {
  const pts = [];
  for (let i = 0; i < rays * 2; i++) {
    const a = (i * Math.PI) / rays - Math.PI / 2;
    const r = i % 2 === 0 ? rOut : rIn;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

const SHAPE_GEOMETRY = {
  square:   '<rect class="qn-shape-path" x="4" y="4" width="92" height="92" rx="2" />',
  rsquare:  '<rect class="qn-shape-path" x="4" y="4" width="92" height="92" rx="18" />',
  circle:   '<circle class="qn-shape-path" cx="50" cy="50" r="46" />',
  diamond:  '<polygon class="qn-shape-path" points="50,3 97,50 50,97 3,50" />',
  pentagon: '<polygon class="qn-shape-path" points="50,6 93.7,37.8 77,89.2 23,89.2 6.3,37.8" />',
  hexagon:  '<polygon class="qn-shape-path" points="50,4 89.8,27 89.8,73 50,96 10.2,73 10.2,27" />',
  octagon:  '<polygon class="qn-shape-path" points="32.4,7.5 67.6,7.5 92.5,32.4 92.5,67.6 67.6,92.5 32.4,92.5 7.5,67.6 7.5,32.4" />',
  gear:     `<polygon class="qn-shape-path" points="${gearPoints()}" />`,
  sun:      `<polygon class="qn-shape-path" points="${sunPoints()}" />`
};

function shapeSvg(shape) {
  const body = SHAPE_GEOMETRY[shape] || SHAPE_GEOMETRY.square;
  return `<svg class="qn-shape-svg" viewBox="0 0 100 100" aria-hidden="true">${body}</svg>`;
}

const nodeEls = new Map();             // quest id -> its DOM node (kept between renders)
let shownChapterId = null;

export async function initQuests() {
  bindQuestUI();
  initExplorer({ addToQuest: addEntriesToQuest });
  // Item names and icons arrive after a mod scan finishes, so redraw whatever shows them.
  onRegistryChange(() => {
    renderQuestCanvas();
    if (!document.activeElement?.closest('#quest-editor-container')) renderQuestEditor();
  });
}

export function triggerQuestRenders() {
  renderQuestChapters();
  renderTarget();
  renderQuestCanvas();
  renderQuestEditor();
}

/** The item or mob a task/reward refers to, if it's one the explorer knows about. */
const entryForTask = t => t.taskType === 'checkmark' ? null : getEntry(t.taskType === 'kill' ? 'entity' : 'item', t.item);
const entryForReward = r => r.rewardType === 'item' ? getEntry('item', r.item) : null;

// ---------------------------------------------------------------------------
// View (pan / zoom)
// ---------------------------------------------------------------------------

function applyTransform() {
  const inner = $('quest-canvas-inner');
  if (inner) inner.style.transform = `translate(${questState.canvasOffset.x}px, ${questState.canvasOffset.y}px) scale(${questState.canvasScale})`;
  const chip = $('qs-zoom');
  if (chip) chip.textContent = Math.round(questState.canvasScale * 100) + '%';
}

/** Zooms to newScale keeping the point (cx, cy), in container pixels, fixed on screen. */
function zoomAt(newScale, cx, cy) {
  const s = clamp(newScale, MIN_SCALE, MAX_SCALE);
  const k = s / questState.canvasScale;
  questState.canvasOffset.x = cx - (cx - questState.canvasOffset.x) * k;
  questState.canvasOffset.y = cy - (cy - questState.canvasOffset.y) * k;
  questState.canvasScale = s;
  applyTransform();
}

function zoomCenter(factor) {
  const r = $('quest-canvas-container').getBoundingClientRect();
  zoomAt(questState.canvasScale * factor, r.width / 2, r.height / 2);
}

function fitView() {
  const chapter = currentChapter();
  const box = $('quest-canvas-container').getBoundingClientRect();
  if (!chapter || !chapter.quests.length) { questState.canvasScale = 1; questState.canvasOffset = { x: 60, y: 60 }; return applyTransform(); }
  const boxes = chapter.quests.map(q => { const s = nodeSize(q); return { x: q.x * GRID, y: q.y * GRID, w: s.w, h: s.h }; });
  const minX = Math.min(...boxes.map(b => b.x)), minY = Math.min(...boxes.map(b => b.y));
  const w = Math.max(...boxes.map(b => b.x + b.w)) - minX, h = Math.max(...boxes.map(b => b.y + b.h)) - minY;
  const pad = 48;
  const s = clamp(Math.min((box.width - pad * 2) / w, (box.height - pad * 2) / h), MIN_SCALE, 1.5);
  questState.canvasScale = s;
  questState.canvasOffset = { x: (box.width - w * s) / 2 - minX * s, y: (box.height - h * s) / 2 - minY * s };
  applyTransform();
}

// ---------------------------------------------------------------------------
// Selection / linking
// ---------------------------------------------------------------------------

function paintNodeState() {
  nodeEls.forEach((node, id) => {
    node.classList.toggle('selected', id === questState.selectedQuestId);
    node.classList.toggle('link-src', id === questState.linkSource);
  });
  $('quest-canvas-container')?.classList.toggle('linking', !!questState.linkSource);
}

function selectQuest(id) {
  if (questState.selectedQuestId === id) return;
  questState.selectedQuestId = id;
  paintNodeState();
  renderQuestEdges();
  renderQuestEditor();
}

function setLinkSource(id) {
  questState.linkSource = id;
  paintNodeState();
  updateStatus();
}

/** True if `from` already depends (directly or not) on `target`, so target -> from would make a loop. */
function dependsOn(chapter, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const q = chapter.quests.find(x => x.id === from);
  return !!q && q.dependencies.some(d => dependsOn(chapter, d, target, seen));
}

function completeLink(targetId) {
  const chapter = currentChapter();
  const target = chapter?.quests.find(q => q.id === targetId);
  const src = questState.linkSource;
  if (!target || !src || src === targetId) return setLinkSource(null);
  if (target.dependencies.includes(src)) { toast('Already linked.', { type: 'info' }); return setLinkSource(null); }
  if (dependsOn(chapter, src, targetId)) { toast('That would make a dependency loop.', { type: 'error' }); return setLinkSource(null); }
  target.dependencies.push(src);
  saveQuestState();
  setLinkSource(null);
  renderQuestEdges();
  renderQuestEditor();
  renderQuestCanvas();
}

// ---------------------------------------------------------------------------
// Pointer input: one pointer pans or drags, two pointers pinch-zoom (touch, pen and mouse)
// ---------------------------------------------------------------------------

function bindCanvasInput(container) {
  const pointers = new Map();          // pointerId -> {x, y} in client px
  let gesture = null;                  // {kind: 'pan'|'node'|'pinch'|'ignore', ...}
  let edgesPending = false;
  const scheduleEdges = () => {
    if (edgesPending) return;
    edgesPending = true;
    requestAnimationFrame(() => { edgesPending = false; renderQuestEdges(); });
  };
  const local = e => { const r = container.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pinchMetrics = () => {
    const [a, b] = [...pointers.values()];
    const r = container.getBoundingClientRect();
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
  };

  container.addEventListener('pointerdown', e => {
    if (e.target.closest('button, .status-chip')) return;        // map controls handle themselves
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { container.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();

    if (pointers.size === 2) {                                   // second finger: switch to pinch
      if (gesture?.kind === 'node' && gesture.moved) { saveQuestState(); renderQuestEditor(); }
      const m = pinchMetrics();
      gesture = { kind: 'pinch', dist: m.dist, x: m.x, y: m.y, scale: questState.canvasScale, off: { ...questState.canvasOffset } };
      return;
    }
    if (pointers.size > 2) return;

    const nodeEl = e.target.closest('.quest-node');
    const forcePan = e.button === 1 || e.altKey;
    if (nodeEl && !forcePan) {
      const id = nodeEl.dataset.id;
      if (questState.linkSource) { gesture = { kind: 'ignore' }; completeLink(id); return; }
      const q = currentChapter()?.quests.find(x => x.id === id);
      if (!q) return;
      selectQuest(id);
      gesture = { kind: 'node', id, startX: e.clientX, startY: e.clientY, origX: q.x, origY: q.y, moved: false };
    } else {
      gesture = { kind: 'pan', startX: e.clientX, startY: e.clientY, off: { ...questState.canvasOffset }, moved: false, forced: forcePan };
    }
  });

  container.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const m = pinchMetrics();
      const s = clamp(gesture.scale * m.dist / gesture.dist, MIN_SCALE, MAX_SCALE);
      // Keep the world point that started under the fingers' midpoint under their current midpoint.
      const wx = (gesture.x - gesture.off.x) / gesture.scale, wy = (gesture.y - gesture.off.y) / gesture.scale;
      questState.canvasScale = s;
      questState.canvasOffset = { x: m.x - wx * s, y: m.y - wy * s };
      applyTransform();
      return;
    }
    const dx = e.clientX - gesture.startX, dy = e.clientY - gesture.startY;
    if (gesture.kind === 'node') {
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      gesture.moved = true;
      const q = currentChapter()?.quests.find(x => x.id === gesture.id);
      if (!q) return;
      q.x = +(gesture.origX + dx / questState.canvasScale / GRID).toFixed(2);
      q.y = +(gesture.origY + dy / questState.canvasScale / GRID).toFixed(2);
      const el = nodeEls.get(q.id);
      if (el) { el.style.left = q.x * GRID + 'px'; el.style.top = q.y * GRID + 'px'; el.classList.add('dragging'); }
      scheduleEdges();
    } else if (gesture.kind === 'pan') {
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      gesture.moved = true;
      container.classList.add('panning');
      questState.canvasOffset = { x: gesture.off.x + dx, y: gesture.off.y + dy };
      applyTransform();
    }
  });

  const end = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try { container.releasePointerCapture(e.pointerId); } catch {}
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      // Leave the remaining finger idle until it lifts, so the pinch doesn't turn into a jumpy pan.
      if (pointers.size < 2) gesture = pointers.size ? { kind: 'ignore' } : null;
      return;
    }
    if (pointers.size) return;
    if (gesture.kind === 'node') {
      nodeEls.get(gesture.id)?.classList.remove('dragging');
      if (gesture.moved) { saveQuestState(); renderQuestEdges(); renderQuestEditor(); }
    } else if (gesture.kind === 'pan') {
      container.classList.remove('panning');
      // A tap on empty space deselects (and cancels a pending link).
      if (!gesture.moved && !gesture.forced && e.type === 'pointerup') {
        questState.linkSource = null;
        questState.selectedQuestId = null;
        paintNodeState(); updateStatus(); renderQuestEdges(); renderQuestEditor();
      }
    }
    gesture = null;
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('lostpointercapture', e => { if (pointers.has(e.pointerId)) end(e); });

  container.addEventListener('wheel', e => {
    e.preventDefault();
    const p = local(e);
    zoomAt(questState.canvasScale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  }, { passive: false });

  container.addEventListener('contextmenu', e => e.preventDefault());   // long-press on touch shouldn't pop a menu
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function bindQuestUI() {
  $('btn-link-dep').addEventListener('click', () => {
    if (!questState.selectedQuestId) return toast('Select a quest first, then tap another quest to make this one its prerequisite.', { type: 'info' });
    setLinkSource(questState.linkSource ? null : questState.selectedQuestId);
  });

  $('btn-del-quest').addEventListener('click', () => {
    const chapter = currentChapter();
    if (!chapter || !questState.selectedQuestId || !confirm('Delete this quest?')) return;
    const id = questState.selectedQuestId;
    chapter.quests = chapter.quests.filter(q => q.id !== id);
    chapter.quests.forEach(q => { q.dependencies = q.dependencies.filter(d => d !== id); });
    questState.selectedQuestId = null;
    questState.linkSource = null;
    saveQuestState();
    renderQuestCanvas();
    renderQuestEditor();
  });

  const container = $('quest-canvas-container');
  bindCanvasInput(container);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && questState.linkSource) setLinkSource(null);
  });

  $('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
  $('btn-zoom-out').addEventListener('click', () => zoomCenter(1 / 1.25));
  $('btn-zoom-reset').addEventListener('click', () => { questState.canvasScale = 1; questState.canvasOffset = { x: 60, y: 60 }; applyTransform(); });
  $('btn-zoom-fit')?.addEventListener('click', fitView);

  $('btn-add-chapter').addEventListener('click', () => {
    const title = `Chapter ${questState.chapters.length + 1}`;
    questState.chapters.push({ id: newId(), filename: title.toLowerCase().replace(/ /g, '_'), title, order_index: questState.chapters.length, quests: [] });
    questState.activeChapter = questState.chapters.length - 1;
    questState.selectedQuestId = null;
    saveQuestState();
    triggerQuestRenders();
  });

  $('btn-layout-quests').addEventListener('click', () => {
    const chapter = currentChapter();
    if (!chapter) return;
    chapter.quests.forEach((q, i) => { q.x = (i % 5) * 2.5; q.y = Math.floor(i / 5) * 2.5; });
    saveQuestState();
    renderQuestCanvas();
    renderQuestEditor();
    fitView();
  });

  $('btn-add-quest').addEventListener('click', () => addQuest());
}

/** A free spot near the middle of what the user is looking at, snapped to half a grid unit. */
function spotInView(chapter) {
  const box = $('quest-canvas-container').getBoundingClientRect();
  const s = questState.canvasScale;
  const wx = (box.width / 2 - questState.canvasOffset.x) / s - NODE_W / 2;
  const wy = (box.height / 2 - questState.canvasOffset.y) / s - NODE_H / 2;
  let x = Math.round(wx / GRID * 2) / 2, y = Math.round(wy / GRID * 2) / 2;
  const taken = () => chapter.quests.some(q => Math.abs(q.x - x) < 0.5 && Math.abs(q.y - y) < 0.5);
  for (let i = 0; i < 40 && taken(); i++) { x += 0.5; if (i % 8 === 7) { x -= 4; y += 0.5; } }
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

function addQuest(title = 'New Quest', tasks = [], rewards = []) {
  const chapter = currentChapter();
  if (!chapter) return null;
  const id = newId();
  const { x, y } = spotInView(chapter);
  const quest = { id, title, subtitle: '', description: [], x, y, shape: 'default', dependencies: [], tasks, rewards };
  chapter.quests.push(quest);
  questState.selectedQuestId = id;
  saveQuestState();
  renderQuestChapters();
  renderQuestCanvas();
  renderQuestEditor();
  return quest;
}

/**
 * Adds items/mobs picked in the explorer to the selected quest, or to a new one.
 * Picking the same thing twice bumps its count instead of adding a duplicate row.
 */
function addEntriesToQuest({ entries, as, newQuest }) {
  const chapter = currentChapter();
  if (!chapter || entries.length === 0) return { message: 'Nothing to add.' };

  const tasks = [], rewards = [];
  const bump = (list, make, entry) => {
    const existing = list.find(x => x.item === entry.id && make.type === (x.taskType ?? x.rewardType));
    if (existing) existing.count = (existing.count || 1) + 1;
    else list.push({ id: newId(), item: entry.id, count: 1, ...make.fields });
  };
  for (const entry of entries) {
    if (entry.kind === 'entity') bump(tasks, { type: 'kill', fields: { taskType: 'kill', sourceType: 'kill' } }, entry);
    else if (as === 'reward') bump(rewards, { type: 'item', fields: { rewardType: 'item' } }, entry);
    else bump(tasks, { type: 'item', fields: { taskType: 'item', sourceType: 'collect' } }, entry);
  }

  let quest = newQuest ? null : chapter.quests.find(q => q.id === questState.selectedQuestId);
  if (quest) {
    // Merge into the existing quest, reusing rows that already hold the same item.
    for (const t of tasks) {
      const same = quest.tasks.find(x => x.item === t.item && x.taskType === t.taskType);
      if (same) same.count = (same.count || 1) + t.count; else quest.tasks.push(t);
    }
    for (const r of rewards) {
      const same = quest.rewards.find(x => x.item === r.item && x.rewardType === r.rewardType);
      if (same) same.count = (same.count || 1) + r.count; else quest.rewards.push(r);
    }
    saveQuestState();
    renderQuestCanvas();
    renderQuestEditor();
  } else {
    quest = addQuest(entries.length === 1 ? entries[0].name : 'New Quest', tasks, rewards);
    if (!quest) return { message: 'No chapter to add to.' };
  }

  const what = entries.length === 1 ? entries[0].name : `${entries.length} entries`;
  return { message: `Added ${what} to "${quest.title}".` };
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

function renameChapter(ch) {
  const newName = prompt('Rename chapter:', ch.title);
  if (!newName || !newName.trim()) return;
  ch.title = newName.trim();
  ch.filename = ch.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'chapter';
  saveQuestState();
  renderQuestChapters();
}

export function renderQuestChapters() {
  const container = $('quest-chapters-list');
  if (!container) return;
  const fragment = document.createDocumentFragment();

  questState.chapters.forEach((ch, idx) => {
    const active = idx === questState.activeChapter;
    const btn = document.createElement('div');
    btn.className = `qc-chapter${active ? ' active' : ''}`;
    btn.setAttribute('role', 'button');
    const label = document.createElement('span');
    label.textContent = `${ch.title} (${ch.quests.length})`;
    btn.appendChild(label);

    if (active) {
      const edit = document.createElement('span');
      edit.className = 'qc-chapter-act'; edit.title = 'Rename chapter'; edit.textContent = '✎';
      edit.addEventListener('click', e => { e.stopPropagation(); renameChapter(ch); });
      btn.appendChild(edit);
    }
    if (questState.chapters.length > 1) {
      const del = document.createElement('span');
      del.className = 'qc-chapter-act danger'; del.title = 'Delete chapter'; del.textContent = '×';
      del.addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`Delete chapter "${ch.title}" and its ${ch.quests.length} quest(s)?`)) return;
        questState.chapters.splice(idx, 1);
        questState.activeChapter = Math.max(0, idx - 1);
        questState.selectedQuestId = null;
        questState.linkSource = null;
        saveQuestState();
        triggerQuestRenders();
      });
      btn.appendChild(del);
    }

    btn.addEventListener('click', () => {
      if (questState.activeChapter === idx) return;
      questState.activeChapter = idx;
      questState.selectedQuestId = null;
      questState.linkSource = null;
      triggerQuestRenders();
      fitView();
    });
    btn.addEventListener('dblclick', () => renameChapter(ch));
    fragment.appendChild(btn);
  });
  container.replaceChildren(fragment);
}

// ---------------------------------------------------------------------------
// Canvas rendering. Nodes are created once and updated in place, so selecting,
// dragging and editing never rebuilds the map.
// ---------------------------------------------------------------------------

function renderQuestEdges() {
  const chapter = currentChapter();
  const g = $('quest-edges-paths');
  if (!chapter || !g) return;

  let edgesHtml = '';
  const byId = new Map(chapter.quests.map(q => [q.id, q]));
  chapter.quests.forEach(quest => {
    quest.dependencies.forEach(depId => {
      const dep = byId.get(depId);
      if (!dep) return;
      const isSelected = quest.id === questState.selectedQuestId || depId === questState.selectedQuestId;

      const s1 = nodeSize(dep), s2 = nodeSize(quest);
      const cx1 = dep.x * GRID + s1.w / 2, cy1 = dep.y * GRID + s1.h / 2;
      const cx2 = quest.x * GRID + s2.w / 2, cy2 = quest.y * GRID + s2.h / 2;
      const dx = cx2 - cx1, dy = cy2 - cy1;
      const distance = Math.hypot(dx, dy);
      if (distance < 10) return;

      const cos = dx / distance, sin = dy / distance;
      const pullBack = (q, { w, h }, pad) => {
        if (q.shape === 'circle') return w * 0.46 + pad;
        if (q.shape === 'diamond') return 1 / (Math.abs(cos) / (w * 0.47) + Math.abs(sin) / (h * 0.47)) + pad;
        return Math.min(cos !== 0 ? Math.abs((w / 2 + pad) / cos) : Infinity, sin !== 0 ? Math.abs((h / 2 + pad) / sin) : Infinity);
      };
      const pullTarget = pullBack(quest, s2, 10), pullSource = pullBack(dep, s1, 2);
      if (distance <= pullTarget + pullSource) return;

      const sx = cx1 + cos * pullSource, sy = cy1 + sin * pullSource;
      const tx = cx2 - cos * pullTarget, ty = cy2 - sin * pullTarget;
      edgesHtml += `<path d="M ${sx} ${sy} L ${tx} ${ty}" style="stroke:${isSelected ? 'var(--green)' : 'var(--green-dim)'}" stroke-width="${isSelected ? 2 : 1.5}" fill="none" stroke-dasharray="${isSelected ? '6,3' : '4,3'}" marker-end="url(#${isSelected ? 'arr-sel' : 'arr'})" opacity="0.8" />`;
    });
  });
  g.innerHTML = edgesHtml;
}

function nodeHtml(quest) {
  let taskHtml = '';
  quest.tasks.slice(0, 4).forEach(t => {
    const entry = entryForTask(t);
    const label = t.taskType === 'checkmark' ? t.item : displayName(t.taskType === 'kill' ? 'entity' : 'item', t.item);
    const icon = (entry && t.taskType !== 'kill') ? iconHtml(entry, 14) + ' ' : (TASK_ICONS[t.sourceType || t.taskType] || '');
    taskHtml += `<span class="qn-chip">${icon}${escapeHtml(String(label).slice(0, 22))}</span>`;
  });
  if (quest.tasks.length > 4) taskHtml += `<span class="qn-more">+${quest.tasks.length - 4}</span>`;
  if (quest.tasks.length === 0) taskHtml += `<span class="qn-none">no tasks</span>`;

  const shaped = isShaped(quest);
  const depsText = shaped ? `⬅ ${quest.dependencies.length}` : `⬅ ${quest.dependencies.length} dep(s)`;
  const inner = `
    <div class="qn-title" title="${escapeHtml(quest.title || 'Untitled')}">${escapeHtml(quest.title || 'Untitled')}</div>
    <div class="qn-tasks">${taskHtml}</div>
    ${quest.dependencies.length > 0 ? `<div class="qn-deps">${depsText}</div>` : ''}
  `;

  if (shaped) {
    return `<div class="qn-card">${shapeSvg(quest.shape)}<div class="qn-content">${inner}</div></div>`;
  }
  return `<div class="qn-card">${inner}</div>`;
}

function updateStatus() {
  const bar = $('quest-status-bar');
  const chapter = currentChapter();
  if (!bar) return;
  if (!$('qs-zoom')) bar.innerHTML = '<span class="status-chip" id="qs-zoom"></span><span class="status-chip" id="qs-count"></span><span class="status-chip hidden" id="qs-link"></span>';
  $('qs-zoom').textContent = Math.round(questState.canvasScale * 100) + '%';
  $('qs-count').textContent = `${chapter ? chapter.quests.length : 0} quests`;
  const link = $('qs-link');
  link.classList.toggle('hidden', !questState.linkSource);
  link.textContent = '🔗 Tap the quest that needs this one first';
}

export function renderQuestCanvas() {
  const nodesContainer = $('quest-nodes');
  if (!nodesContainer) return;
  applyTransform();
  const chapter = currentChapter();
  if (!chapter) return;

  if (shownChapterId !== chapter.id) {            // switched chapter: start with a clean map
    nodesContainer.replaceChildren();
    nodeEls.clear();
    shownChapterId = chapter.id;
  }

  const live = new Set(chapter.quests.map(q => q.id));
  nodeEls.forEach((el, id) => { if (!live.has(id)) { el.remove(); nodeEls.delete(id); } });

  for (const quest of chapter.quests) {
    let el = nodeEls.get(quest.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'quest-node';
      el.id = 'quest-node-' + quest.id;
      el.dataset.id = quest.id;
      nodeEls.set(quest.id, el);
      nodesContainer.appendChild(el);
    }
    el.classList.toggle('shaped', isShaped(quest));
    el.dataset.shape = quest.shape || 'default';
    const html = nodeHtml(quest);
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.style.left = quest.x * GRID + 'px';
    el.style.top = quest.y * GRID + 'px';
  }

  const empty = $('quest-empty');
  if (empty) empty.classList.toggle('hidden', chapter.quests.length > 0);
  paintNodeState();
  renderQuestEdges();
  updateStatus();
}

export function renderQuestEditor() {
  renderTarget();
  const container = document.getElementById('quest-editor-container');
  if(!container) return;
  
  const chapter = questState.chapters[questState.activeChapter];
  const quest = chapter ? chapter.quests.find(q => q.id === questState.selectedQuestId) : null;
  
  if(!quest) {
    container.innerHTML = `<div class="text-muted text-center" style="margin-top:20px;">No quest selected.</div>`;
    return;
  }
  
  // XSS Protection for Editor Inputs
  const safeTitle = escapeHtml(quest.title);
  const safeSubtitle = escapeHtml(quest.subtitle || '');
  
  let html = `
    <div style="font-size:9px; color:var(--muted); margin-bottom:8px; font-family:monospace; background:rgba(0,0,0,0.2); border-radius:3px; padding:2px 6px;">${quest.id}</div>
    
    <div class="input-group" style="padding:0; border:none; margin-bottom:8px;">
      <label>Title</label>
      <input type="text" id="qe-title" value="${safeTitle}">
    </div>
    
    <div class="input-group" style="padding:0; border:none; margin-bottom:8px;">
      <label>Subtitle</label>
      <input type="text" id="qe-subtitle" value="${safeSubtitle}">
    </div>
    
    <div class="input-group" style="padding:0; border:none; margin-bottom:8px;">
      <label>Shape</label>
      <select id="qe-shape">
        ${['default','circle','square','pentagon','hexagon','gear','diamond','rsquare','octagon','sun'].map(s => `<option value="${s}" ${quest.shape === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <div class="input-group" style="padding:0; border:none; flex:1;">
        <label>X</label>
        <input type="number" step="0.5" id="qe-x" value="${quest.x}">
      </div>
      <div class="input-group" style="padding:0; border:none; flex:1;">
        <label>Y</label>
        <input type="number" step="0.5" id="qe-y" value="${quest.y}">
      </div>
    </div>
    
    <div class="input-group" style="padding:0; border:none; margin-bottom:8px;">
      <label>Description</label>
      <div id="qe-desc"></div>
      <div style="display:flex; gap:4px; margin-top:4px;">
        <input type="text" id="qe-new-desc" placeholder="Add description line..." style="flex:1;">
        <button id="btn-add-desc" class="btn-primary" style="padding:2px 6px;">+</button>
      </div>
    </div>
    
    <div class="input-group" style="padding:0; border:none; margin-bottom:8px;">
      <label>Dependencies</label>
      <div id="qe-deps" style="display:flex; flex-direction:column; gap:4px; margin-bottom:4px;">
        ${quest.dependencies.map(depId => {
          const depObj = chapter.quests.find(q => q.id === depId);
          const depName = escapeHtml(depObj ? depObj.title : depId);
          return `<div style="display:flex; align-items:center; gap:4px;">
                    <span style="flex:1; font-size:10px; color:var(--green); background:rgba(0,0,0,0.2); padding:2px 6px; border-radius:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${depName}</span>
                    <button class="btn-del-dep icon-btn" data-id="${depId}" style="color:#ff4466; font-size:14px;">×</button>
                  </div>`;
        }).join('')}
      </div>
    </div>
    
    <div class="input-group" style="padding:0; border:none; margin-bottom:8px;">
      <label>Tasks (${quest.tasks.length})</label>
      <div id="qe-tasks"></div>
      <div style="margin-top:4px; display:flex; gap:4px;">
        <select id="qe-new-task-type" style="width:70px;"><option value="item">item</option><option value="kill">kill</option><option value="checkmark">check</option></select>
        <input type="text" id="qe-new-task-item" placeholder="mod:item_id" style="flex:1;">
        <button id="btn-add-task" class="btn-primary" style="padding:2px 6px;">+</button>
      </div>
    </div>
    
    <div class="input-group" style="padding:0; border:none; margin-bottom:8px;">
      <label>Rewards (${quest.rewards.length})</label>
      <div id="qe-rewards"></div>
      <div style="margin-top:4px; display:flex; gap:4px;">
        <select id="qe-new-reward-type" style="width:70px;"><option value="item">item</option><option value="xp">xp</option><option value="command">cmd</option></select>
        <input type="text" id="qe-new-reward-item" placeholder="mod:item_id" style="flex:1;">
        <button id="btn-add-reward" class="btn-primary" style="padding:2px 6px;">+</button>
      </div>
    </div>
  `;
  container.innerHTML = html;
  
  const descContainer = document.getElementById('qe-desc');
  (quest.description || []).forEach((line, i) => {
    const div = document.createElement('div');
    div.style.cssText = "display:flex; gap:4px; margin-bottom:4px;";
    div.innerHTML = `
      <input type="text" value="${escapeHtml(line)}" class="qe-desc-line" data-index="${i}" style="flex:1;">
      <button class="btn-del-desc icon-btn" data-index="${i}" style="color:#ff4466; font-size:14px;">×</button>
    `;
    descContainer.appendChild(div);
  });
  
  const tasksContainer = document.getElementById('qe-tasks');
  quest.tasks.forEach(t => {
    const div = document.createElement('div');
    div.style.cssText = "display:flex; gap:4px; margin-bottom:4px; align-items:center;";
    div.innerHTML = `
      <span style="font-size:10px; color:var(--muted); width:40px; overflow:hidden;">${escapeHtml(t.taskType)}</span>
      ${t.taskType === 'checkmark' ? '' : iconHtml(entryForTask(t), 20)}
      <input type="text" value="${escapeHtml(t.item)}" class="qe-task-item" data-id="${t.id}" title="${escapeHtml(t.taskType === 'checkmark' ? t.item : displayName(t.taskType === 'kill' ? 'entity' : 'item', t.item))}" style="flex:1; min-width:0;">
      <input type="number" value="${t.count || 1}" class="qe-task-count" data-id="${t.id}" style="width:40px;" ${t.taskType === 'checkmark' ? 'disabled' : ''}>
      <button class="btn-del-task icon-btn" data-id="${t.id}" style="color:#ff4466; font-size:14px;">×</button>
    `;
    tasksContainer.appendChild(div);
  });
  
  const rewardsContainer = document.getElementById('qe-rewards');
  quest.rewards.forEach(r => {
    const div = document.createElement('div');
    div.style.cssText = "display:flex; gap:4px; margin-bottom:4px; align-items:center;";
    div.innerHTML = `
      <span style="font-size:10px; color:var(--muted); width:40px; overflow:hidden;">${escapeHtml(r.rewardType)}</span>
      ${r.rewardType === 'item' ? iconHtml(entryForReward(r), 20) : ''}
      <input type="text" value="${escapeHtml(r.item)}" class="qe-reward-item" data-id="${r.id}" title="${escapeHtml(r.rewardType === 'item' ? displayName('item', r.item) : r.item)}" style="flex:1; min-width:0;">
      <input type="number" value="${r.count || 1}" class="qe-reward-count" data-id="${r.id}" style="width:40px;" ${r.rewardType === 'command' ? 'disabled' : ''}>
      <button class="btn-del-reward icon-btn" data-id="${r.id}" style="color:#ff4466; font-size:14px;">×</button>
    `;
    rewardsContainer.appendChild(div);
  });
  
  // Re-bind Editor Events
  document.getElementById('qe-title').addEventListener('input', e => { quest.title = e.target.value; saveSoon(); renderQuestCanvas(); });
  document.getElementById('qe-subtitle').addEventListener('input', e => { quest.subtitle = e.target.value; saveSoon(); });
  document.getElementById('qe-shape').addEventListener('change', e => { quest.shape = e.target.value; saveQuestState(); renderQuestCanvas(); });
  document.getElementById('qe-x').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;          // ignore half-typed values like "-" or ""
    quest.x = v;
    saveSoon();
    const nodeEl = document.getElementById('quest-node-' + quest.id);
    if(nodeEl) { nodeEl.style.left = (quest.x * GRID) + 'px'; }
    renderQuestEdges();
  });
  document.getElementById('qe-y').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;          // ignore half-typed values like "-" or ""
    quest.y = v;
    saveSoon();
    const nodeEl = document.getElementById('quest-node-' + quest.id);
    if(nodeEl) { nodeEl.style.top = (quest.y * GRID) + 'px'; }
    renderQuestEdges();
  });
  
  document.querySelectorAll('.btn-del-dep').forEach(el => el.addEventListener('click', () => {
    quest.dependencies = quest.dependencies.filter(d => d !== el.dataset.id);
    saveQuestState(); renderQuestEditor(); renderQuestCanvas();
  }));

  document.querySelectorAll('.qe-desc-line').forEach(el => el.addEventListener('input', e => {
    quest.description[el.dataset.index] = e.target.value; saveSoon();
  }));
  document.querySelectorAll('.btn-del-desc').forEach(el => el.addEventListener('click', () => {
    quest.description.splice(el.dataset.index, 1);
    saveQuestState(); renderQuestEditor();
  }));
  document.getElementById('btn-add-desc').addEventListener('click', () => {
    const val = document.getElementById('qe-new-desc').value.trim();
    if(val) {
      if(!quest.description) quest.description = [];
      quest.description.push(val);
      saveQuestState(); renderQuestEditor();
    }
  });
  
  document.querySelectorAll('.qe-task-item').forEach(el => el.addEventListener('input', e => {
    const t = quest.tasks.find(x => x.id === el.dataset.id);
    if(t) { t.item = e.target.value; saveSoon(); renderQuestCanvas(); }
  }));
  document.querySelectorAll('.qe-task-count').forEach(el => el.addEventListener('input', e => {
    const t = quest.tasks.find(x => x.id === el.dataset.id);
    if(t) { t.count = parseInt(e.target.value)||1; saveSoon(); }
  }));
  document.querySelectorAll('.btn-del-task').forEach(el => el.addEventListener('click', () => {
    quest.tasks = quest.tasks.filter(x => x.id !== el.dataset.id);
    saveQuestState(); renderQuestEditor(); renderQuestCanvas();
  }));
  document.getElementById('btn-add-task').addEventListener('click', () => {
    const type = document.getElementById('qe-new-task-type').value;
    const item = document.getElementById('qe-new-task-item').value.trim();
    if(item || type === 'checkmark') {
      quest.tasks.push({ id: newId(), item: item || 'Task', count: 1, taskType: type, sourceType: type });
      saveQuestState(); renderQuestEditor(); renderQuestCanvas();
    }
  });
  
  document.querySelectorAll('.qe-reward-item').forEach(el => el.addEventListener('input', e => {
    const r = quest.rewards.find(x => x.id === el.dataset.id);
    if(r) { r.item = e.target.value; saveSoon(); }
  }));
  document.querySelectorAll('.qe-reward-count').forEach(el => el.addEventListener('input', e => {
    const r = quest.rewards.find(x => x.id === el.dataset.id);
    if(r) { r.count = parseInt(e.target.value)||1; saveSoon(); }
  }));
  document.querySelectorAll('.btn-del-reward').forEach(el => el.addEventListener('click', () => {
    quest.rewards = quest.rewards.filter(x => x.id !== el.dataset.id);
    saveQuestState(); renderQuestEditor();
  }));
  document.getElementById('btn-add-reward').addEventListener('click', () => {
    const type = document.getElementById('qe-new-reward-type').value;
    const item = document.getElementById('qe-new-reward-item').value.trim();
    if(item) {
      quest.rewards.push({ id: newId(), item: item, count: type === 'xp' ? 100 : 1, rewardType: type });
      saveQuestState(); renderQuestEditor();
    }
  });
}
