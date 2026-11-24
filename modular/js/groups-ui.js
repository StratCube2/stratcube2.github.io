// Small pieces of UI for the group feature: the "new items go to" bar and the "move to group" menu.
import { state } from './state.js';
import { addGroup, setModGroup, setActiveGroup, groupById } from './groups.js';

export function promptNewGroup() {
  const name = prompt('New group name:');
  return name ? addGroup(name) : null;
}

let openMenu = null;

export function closeMoveMenu() {
  if (!openMenu) return;
  openMenu.remove();
  document.removeEventListener('pointerdown', openMenu._outside, true);
  document.removeEventListener('keydown', openMenu._escape, true);
  openMenu = null;
}

/** Popup next to `anchor` listing every group, to move one mod into. Works with touch (no drag and drop needed). */
export function openMoveMenu(anchor, modId) {
  closeMoveMenu();
  const mod = state.mods.find(m => m.id === modId);
  if (!mod) return;

  const menu = document.createElement('div');
  menu.className = 'move-menu';

  const heading = document.createElement('div');
  heading.className = 'move-menu-title';
  heading.textContent = 'Move to…';
  menu.appendChild(heading);

  const addOption = (label, groupId, { current = false, accent = false } = {}) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'move-menu-item' + (current ? ' current' : '') + (accent ? ' accent' : '');
    btn.textContent = (current ? '✓ ' : '') + label;
    btn.addEventListener('click', () => {
      closeMoveMenu();
      if (groupId === undefined) { // "New group…"
        const group = promptNewGroup();
        if (group) setModGroup(modId, group.id);
      } else {
        setModGroup(modId, groupId);
      }
    });
    menu.appendChild(btn);
  };

  addOption('Ungrouped', null, { current: !groupById(mod.group) });
  state.groups.forEach(g => addOption(g.name, g.id, { current: mod.group === g.id }));
  addOption('＋ New group…', undefined, { accent: true });

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) + 'px';

  menu._outside = e => { if (!menu.contains(e.target)) closeMoveMenu(); };
  menu._escape = e => { if (e.key === 'Escape') closeMoveMenu(); };
  // Added on the next tick so the tap that opened the menu doesn't immediately close it.
  setTimeout(() => {
    if (openMenu !== menu) return;
    document.addEventListener('pointerdown', menu._outside, true);
    document.addEventListener('keydown', menu._escape, true);
  });
  openMenu = menu;
}

/** The bar above the pack list: choose where new items go, and make a new group. */
export function renderGroupTools() {
  const bar = document.getElementById('mod-list-tools');
  if (!bar) return;
  bar.replaceChildren();

  const label = document.createElement('label');
  label.textContent = 'Add new items to';
  const select = document.createElement('select');
  select.title = 'Anything you add from search goes into this group';
  const options = [[null, 'Ungrouped'], ...state.groups.map(g => [g.id, g.name])];
  options.forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id ?? '';
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = groupById(state.activeGroup) ? state.activeGroup : '';
  select.addEventListener('change', () => setActiveGroup(select.value || null));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn-primary group-add-btn';
  add.textContent = '+ Group';
  add.addEventListener('click', () => {
    const group = promptNewGroup();
    if (group) setActiveGroup(group.id); // new group becomes the place new items go
  });

  label.appendChild(select);
  bar.append(label, add);
}
