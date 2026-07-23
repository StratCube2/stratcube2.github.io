declare const JSZip: any;
declare const saveAs: any;
declare const require: any;

interface IDEFile {
  id: string;
  name: string;
  path: string;
  content: string;
  language: string;
}

class StratsDatapackIDE {
  private files: Map<string, IDEFile> = new Map();
  private activeFileId: string | null = null;
  private monacoEditor: any = null;

  // Pixel Canvas State
  private canvasSize = 16;
  private pixelData: string[][] = [];

  constructor() {
    this.setupDefaultFiles();
    this.initUI();
    this.initMonaco();
    this.initCanvas();
  }

  private setupDefaultFiles() {
    const mainFunc: IDEFile = {
      id: 'f1',
      name: 'tick.mcfunction',
      path: 'data/strat/function/tick.mcfunction',
      language: 'plaintext',
      content: `# Called every tick by Minecraft\nparticle minecraft:flame ~ ~1 ~ 0.2 0.2 0.2 0.01 5\nexecute as @a[tag=magic] run effect give @s minecraft:speed 1 1 true`
    };

    const customScript: IDEFile = {
      id: 'f2',
      name: 'magic_wand.script',
      path: 'data/strat/function/magic_wand.script',
      language: 'plaintext',
      content: `// Your custom scripting language format\non right_click {\n    shoot fireball speed 1.5;\n    sound minecraft:entity.blaze.shoot;\n}`
    };

    this.files.set(mainFunc.id, mainFunc);
    this.files.set(customScript.id, customScript);
    this.activeFileId = customScript.id;
  }

  private initUI() {
    // Activity Bar Switching
    document.querySelectorAll('.activity-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = (e.currentTarget as HTMLElement).dataset.target;
        document.querySelectorAll('.activity-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.add('hidden'));

        (e.currentTarget as HTMLElement).classList.add('active');
        if (target) document.getElementById(target)?.classList.remove('hidden');
      });
    });

    // Center Tab Switching
    document.querySelectorAll('.center-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = (e.currentTarget as HTMLElement).dataset.target;
        document.querySelectorAll('.center-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));

        (e.currentTarget as HTMLElement).classList.add('active');
        if (target) document.getElementById(target)?.classList.remove('hidden');
      });
    });

    // File Creation
    document.getElementById('btn-add-file')?.addEventListener('click', () => {
      const name = prompt("Enter file name (e.g. magic.mcfunction):");
      if (!name) return;
      
      const id = Date.now().toString();
      const file: IDEFile = {
        id,
        name,
        path: `data/strat/function/${name}`,
        language: 'plaintext',
        content: `# New file: ${name}\n`
      };

      this.files.set(id, file);
      this.activeFileId = id;
      this.renderFileTree();
      this.loadActiveFileToEditor();
    });

    // Export Datapack
    document.getElementById('btn-export-datapack')?.addEventListener('click', () => this.exportZip());

    this.renderFileTree();
  }

  private renderFileTree() {
    const treeContainer = document.getElementById('file-tree');
    if (!treeContainer) return;

    treeContainer.innerHTML = '';
    this.files.forEach(file => {
      const item = document.createElement('div');
      item.className = `file-node ${file.id === this.activeFileId ? 'active' : ''}`;
      item.innerHTML = `📄 ${file.name}`;
      item.addEventListener('click', () => {
        this.activeFileId = file.id;
        this.renderFileTree();
        this.loadActiveFileToEditor();
      });
      treeContainer.appendChild(item);
    });

    this.renderOutline();
  }

  private renderOutline() {
    const outlineFunctions = document.getElementById('outline-functions');
    if (!outlineFunctions) return;
    
    outlineFunctions.innerHTML = '';
    this.files.forEach(f => {
      const div = document.createElement('div');
      div.style.padding = '4px 0';
      div.style.color = 'var(--text)';
      div.textContent = `> ${f.name}`;
      outlineFunctions.appendChild(div);
    });
  }

  private initMonaco() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
    
    require(['vs/editor/editor.main'], () => {
      // @ts-ignore
      monaco.editor.defineTheme('strat-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: '', background: '020408', foreground: 'e2e8f0' },
          { token: 'comment', foreground: '4db842', fontStyle: 'italic' },
          { token: 'keyword', foreground: '6EE75A', fontStyle: 'bold' }
        ],
        colors: {
          'editor.background': '#020408',
          'editor.foreground': '#e2e8f0',
          'editorCursor.foreground': '#6EE75A',
          'editor.lineHighlightBackground': '#070d14',
          'editorLineNumber.foreground': 'rgba(110, 231, 90, 0.3)'
        }
      });

      // @ts-ignore
      this.monacoEditor = monaco.editor.create(document.getElementById('monaco-container')!, {
        value: this.files.get(this.activeFileId!)?.content || '',
        language: 'plaintext',
        theme: 'strat-dark',
        fontFamily: 'JetBrains Mono',
        fontSize: 13,
        automaticLayout: true
      });

      this.monacoEditor.onDidChangeModelContent(() => {
        if (this.activeFileId && this.files.has(this.activeFileId)) {
          this.files.get(this.activeFileId)!.content = this.monacoEditor.getValue();
        }
      });
    });
  }

  private loadActiveFileToEditor() {
    if (this.monacoEditor && this.activeFileId) {
      const file = this.files.get(this.activeFileId);
      if (file) {
        this.monacoEditor.setValue(file.content);
      }
    }
  }

  // 16x16 Pixel Editor
  private initCanvas() {
    const canvas = document.getElementById('pixel-canvas') as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    // Init grid data
    this.pixelData = Array(16).fill(0).map(() => Array(16).fill('transparent'));

    let isDrawing = false;

    const drawGrid = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cellSize = canvas.width / 16;

      for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 16; c++) {
          if (this.pixelData[r][c] !== 'transparent') {
            ctx.fillStyle = this.pixelData[r][c];
            ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
          }
          ctx.strokeStyle = 'rgba(110, 231, 90, 0.08)';
          ctx.strokeRect(c * cellSize, r * cellSize, cellSize, cellSize);
        }
      }
    };

    const paint = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const col = Math.floor(x / (canvas.width / 16));
      const row = Math.floor(y / (canvas.height / 16));

      const colorInput = document.getElementById('pixel-color') as HTMLInputElement;
      if (row >= 0 && row < 16 && col >= 0 && col < 16) {
        this.pixelData[row][col] = colorInput.value;
        drawGrid();
      }
    };

    canvas.addEventListener('mousedown', (e) => { isDrawing = true; paint(e); });
    canvas.addEventListener('mousemove', (e) => { if (isDrawing) paint(e); });
    window.addEventListener('mouseup', () => { isDrawing = false; });

    document.getElementById('btn-clear-canvas')?.addEventListener('click', () => {
      this.pixelData = Array(16).fill(0).map(() => Array(16).fill('transparent'));
      drawGrid();
    });

    drawGrid();
  }

  // Generate .zip output
  private async exportZip() {
    const zip = new JSZip();

    const packName = (document.getElementById('pack-name') as HTMLInputElement).value || 'strat_datapack';
    const namespace = (document.getElementById('pack-namespace') as HTMLInputElement).value || 'strat';
    const format = parseInt((document.getElementById('pack-format') as HTMLInputElement).value || '48');
    const desc = (document.getElementById('pack-desc') as HTMLInputElement).value;

    // 1. Pack mcmeta
    zip.file('pack.mcmeta', JSON.stringify({
      pack: { pack_format: format, description: desc }
    }, null, 2));

    // 2. Add functions
    const funcFolder = zip.folder(`data/${namespace}/function`);
    this.files.forEach(file => {
      funcFolder?.file(file.name, file.content);
    });

    // 3. Download ZIP
    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, `${packName}.zip`);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new StratsDatapackIDE();
});
