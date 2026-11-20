import { state, questState, customFiles } from './state.js';
import { buildQuestFiles } from './quest-io.js';

export async function exportQuestsZip() {
  if (!window.JSZip || !window.saveAs) return alert("Export libraries failed to load.");

  const zip = new JSZip();
  Object.entries(buildQuestFiles()).forEach(([path, text]) => zip.file(path, text));

  saveAs(await zip.generateAsync({ type: "blob" }), "ftbquests.zip");
}

export async function exportMrPack() {
  if (state.mods.length === 0) return alert("Add some mods first!");
  if (!window.JSZip || !window.saveAs) return alert("Export libraries failed to load.");

  const exportButtons = document.querySelectorAll('.btn-export:not(#btn-export-quests)');
  const resetButtons = () => {
    exportButtons.forEach(btn => {
      btn.textContent = "Export as .mrpack";
      btn.disabled = false;
    });
  };

  exportButtons.forEach(btn => {
    btn.textContent = "Generating...";
    btn.disabled = true;
  });

  try {
    const zip = new JSZip();

    let loaderVersion;
    if (state.loaderVersion.trim() !== "") {
        loaderVersion = state.loaderVersion.trim();
    } else {
        try {
            const prismUidMap = { 'fabric': 'net.fabricmc.fabric-loader', 'forge': 'net.minecraftforge', 'quilt': 'org.quiltmc.quilt-loader', 'neoforge': 'net.neoforged' };
            const uid = prismUidMap[state.loader];
            if (uid) {
                const metaRes = await fetch(`https://meta.prismlauncher.org/v1/${uid}/index.json`);
                if (metaRes.ok) {
                    const metaData = await metaRes.json();
                    const validVersions = metaData.versions.filter(v => v.requires && v.requires.some(req => req.uid === 'net.minecraft' && req.equals === state.mcVersion));
                    if (validVersions.length > 0) {
                        const recommended = validVersions.find(v => v.recommended);
                        loaderVersion = recommended ? recommended.version : validVersions[0].version;
                    }
                }
            }
        } catch (e) {
            console.error("Failed to fetch loader version:", e);
        }
    }

    if (!loaderVersion) {
        alert("Could not automatically determine a compatible loader version. Please enter a specific version in the 'Loader Version' text box and try exporting again.");
        resetButtons();
        return;
    }

    const indexJson = {
      formatVersion: 1, game: "minecraft", versionId: "1.0.0", name: state.name || "Custom Modpack",
      dependencies: { minecraft: state.mcVersion }, files:[]
    };
    
    const loaderKeyMap = { 'fabric': 'fabric-loader', 'forge': 'forge', 'quilt': 'quilt-loader', 'neoforge': 'neoforge' };
    const loaderKey = loaderKeyMap[state.loader] || state.loader;
    indexJson.dependencies[loaderKey] = loaderVersion;

    state.mods.forEach(mod => {
      if (mod.custom) {
        const cf = customFiles.find(c => c.id === mod.id);
        if (cf && cf.file) {
          zip.file("overrides/mods/" + mod.slug, cf.file);
        } else {
          console.warn("Custom mod file missing in session:", mod.slug);
        }
      } 
      else if (mod.source === 'modrinth' && mod.mrpackData) {
        indexJson.files.push(mod.mrpackData);
      }
      else if (mod.source === 'curseforge') {
        console.warn("CurseForge mods cannot be bundled perfectly into mrpack via browser yet.");
      }
    });

    zip.file("modrinth.index.json", JSON.stringify(indexJson, null, 2));

    // Bundle quests into the pack's overrides
    if (questState.chapters.some(c => c.quests.length > 0)) {
      Object.entries(buildQuestFiles()).forEach(([path, text]) => {
        zip.file("overrides/config/ftbquests/quests/" + path, text);
      });
    }

    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, (state.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() || "modpack") + ".mrpack");
  } catch (err) {
    console.error(err);
    alert("An unexpected error occurred during export.");
  } finally {
    resetButtons();
  }
}
