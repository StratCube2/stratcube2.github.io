// Inline SVG icons that replace emoji and emoji-capable symbols, so the UI looks the same on every device
// and follows the theme (they draw with currentColor). No imports, so any module can use this.

const PATHS = {
  scroll:    '<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M12 8h4M12 12h4"/>',
  link:      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  trash:     '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  folder:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  flame:     '<path d="M12 22c4 0 7-2.8 7-7 0-3-1.5-5-3-7-.5 1.5-1.5 2.5-2.5 3 .5-3-.5-6-3.5-9-.5 3-2 5-3.5 7C5 11.5 5 13 5 15c0 4.2 3 7 7 7z"/>',
  sword:     '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/>',
  hammer:    '<path d="M14 4l6 6"/><path d="M12 6l6 6-3 3-6-6z"/><path d="M12 12L4 20"/>',
  map:       '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14"/><path d="M15 6v14"/>',
  hand:      '<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6"/><path d="M11 11V3.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3 14.5a1.6 1.6 0 0 1 2.4-2L8 15"/>',
  package:   '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3.3 7.5L12 12.5l8.7-5"/><path d="M12 22V12.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  puzzle:    '<path d="M10 4a2 2 0 1 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 1 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H5V7a1 1 0 0 1 1-1h4z"/>',
  sunrise:   '<path d="M12 3v4"/><path d="M5.6 9.6l2.2 2.2"/><path d="M18.4 9.6l-2.2 2.2"/><path d="M2 18h20"/><path d="M6 18a6 6 0 0 1 12 0"/>',
  image:     '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-9 9"/>',
  upload:    '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  download:  '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  maximize:  '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  refresh:   '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  grid:      '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  star:      '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  pencil:    '<path d="M4 20l1-4L17 4a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M15 6l3 3"/>'
};

/** SVG markup for an icon, sized in `em` by default so it matches the surrounding text. */
export function icon(name, size = '1em') {
  const body = PATHS[name];
  if (!body) return '';
  const dim = typeof size === 'number' ? `${size}px` : size;
  return `<svg class="svg-icon" width="${dim}" height="${dim}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Fills every `<i class="ico" data-icon="name">` placeholder in the page (used by the static HTML). */
export function hydrateIcons(root = document) {
  root.querySelectorAll('i.ico[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
    el.removeAttribute('data-icon');
  });
}

export const ICON_NAMES = Object.keys(PATHS);
