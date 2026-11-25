// The Settings panel (gear icon at the bottom of the activity bar).
import { THEMES, getSetting, setSetting, resetSettings, onSettingsChange } from './settings.js';

const $ = id => document.getElementById(id);

const SCAN_LIMITS = [[25, '25 MB'], [50, '50 MB'], [100, '100 MB'], [250, '250 MB'], [500, '500 MB'], [0, 'No limit']];
const CONFIRM_LIMITS = [[50, '50 MB'], [150, '150 MB'], [500, '500 MB'], [0, 'Never ask']];

const options = list => list.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

function render(panel) {
  panel.innerHTML = `
    <div class="panel-header">SETTINGS</div>
    <div style="flex:1; overflow-y:auto;">
      <div class="input-group">
        <label>Theme</label>
        <div class="theme-grid" id="set-themes">
          ${THEMES.map(t => `<button type="button" class="theme-swatch" data-theme="${t.id}"><span class="theme-dot" style="background:${t.swatch}"></span>${t.label}</button>`).join('')}
        </div>
      </div>

      <div class="input-group">
        <label>Mod scanning</label>
        <label class="setting-row"><input type="checkbox" id="set-auto-scan"> Scan mod files automatically</label>
        <div class="setting-hint">Reads item names, textures and dependency info from your mods in the background whenever the pack changes. Downloads the jars, so it uses data.</div>
        <select id="set-auto-scan-limit" class="setting-select" title="Automatic scans that would download more than this are skipped">${options(SCAN_LIMITS)}</select>
        <div class="setting-hint">Skip automatic scans larger than this. You can still scan by hand.</div>
        <select id="set-confirm" class="setting-select" title="Ask before a manual scan downloads more than this">${options(CONFIRM_LIMITS)}</select>
        <div class="setting-hint">Ask before a manual scan downloads more than this.</div>
      </div>

      <div class="input-group">
        <label>Dependencies</label>
        <label class="setting-row"><input type="checkbox" id="set-auto-deps"> Auto-add dependencies when adding a mod</label>
        <div class="setting-hint">Adds the required Modrinth dependencies of a mod you add from search.</div>
      </div>

      <div class="input-group">
        <button type="button" id="set-reset" class="btn-primary w-full">Reset settings</button>
        <div class="setting-hint">Settings are saved in this browser and are not part of an exported pack.</div>
      </div>
    </div>`;
}

/** Puts the current setting values into the controls. */
function sync() {
  document.querySelectorAll('#set-themes .theme-swatch')
    .forEach(b => b.classList.toggle('active', b.dataset.theme === getSetting('theme')));
  $('set-auto-scan').checked = getSetting('autoScan');
  $('set-auto-scan-limit').value = String(getSetting('autoScanLimitMB'));
  $('set-auto-scan-limit').disabled = !getSetting('autoScan');
  $('set-confirm').value = String(getSetting('confirmDownloadMB'));
  $('set-auto-deps').checked = getSetting('autoDependencies');
}

export function initSettingsPanel() {
  const panel = $('panel-settings');
  render(panel);

  $('set-themes').addEventListener('click', e => {
    const btn = e.target.closest('.theme-swatch');
    if (btn) setSetting('theme', btn.dataset.theme);
  });
  $('set-auto-scan').addEventListener('change', e => setSetting('autoScan', e.target.checked));
  $('set-auto-scan-limit').addEventListener('change', e => setSetting('autoScanLimitMB', Number(e.target.value)));
  $('set-confirm').addEventListener('change', e => setSetting('confirmDownloadMB', Number(e.target.value)));
  $('set-auto-deps').addEventListener('change', e => setSetting('autoDependencies', e.target.checked));
  $('set-reset').addEventListener('click', () => {
    if (confirm('Reset all settings to their defaults?')) resetSettings();
  });

  onSettingsChange(sync);
  sync();
}
