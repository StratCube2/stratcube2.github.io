import { FileItem, IDEState } from './types';

// Declare global Monaco loader
declare const require: any;

// Initial Datapack File System Mock
const initialFiles: FileItem[] = [
  {
    id: '1',
    name: 'pack.mcmeta',
    path: 'pack.mcmeta',
    type: 'file',
    language: 'json',
    content: JSON.stringify({
      pack: {
        pack_format: 48,
        description: "Custom Datapack made in Matrix IDE"
      }
    }, null, 2)
  },
  { id: '2', name: 'data', path: 'data', type: 'folder' },
  { id: '3', name: 'mypack', path: 'data/mypack', type: 'folder', parentId: '2' },
  { id: '4', name: 'function', path: 'data/mypack/function', type: 'folder', parentId: '3' },
  {
    id: '5',
    name: 'main.mcfunction',
    path: 'data/mypack/function/main.mcfunction',
    type: 'file',
    language: 'plaintext',
    parentId: '4',
    content: `# Matrix IDE Generated Function\nsay Datapack Loaded Successfully!\nparticle minecraft:totem_of_undying ~ ~1 ~ 0.5 0.5 0.5 0.1 100`
  },
  {
    id: '6',
    name: 'magic_wand.script',
    path: 'data/mypack/function/magic_wand.script',
    type: 'file',
    language: 'plaintext',
    parentId: '4',
    content: `// Your custom script syntax here\nitem magic_wand {\n    name: "Wand of Sparks"\n    on right_click {\n        shoot fireball speed 2.0\n    }\n}`
  }
];

class MatrixIDE {
  private state: IDEState = {
    files: new Map(),
    openTabIds: ['5', '6'],
    activeFileId: '6'
  };

  private monacoInstance: any = null;

  constructor() {
    this.initFiles();
    this.initMonaco();
    this.bindEvents();
  }

  private initFiles() {
    initialFiles.forEach(f => this.state.files.set(f.id, f));
  }

  private initMonaco() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
    
    require(['vs/editor/editor.main'], () => {
      // Custom Matrix Theme Definition for Monaco
      // @ts-ignore
      monaco.editor.defineTheme('matrix-theme', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: '', background: '050a06', foreground: 'd0f7d8' },
          { token: 'comment', foreground: '33a85c', fontStyle: 'italic' },
          { token: 'keyword', foreground: '00ff66', fontStyle: 'bold' },
          { token: 'string', foreground: '88ffaa' },
          { token: 'number', foreground: '00e5ff' }
        ],
        colors: {
          'editor.background': '#050a06',
          'editor.foreground': '#d0f7d8',
          'editorCursor.foreground': '#00ff66',
          'editor.lineHighlightBackground': '#122917',
          'editorLineNumber.foreground': '#2e633a',
          'editorLineNumber.activeForeground': '#00ff66'
        }
      });

      // @ts-ignore
      this.monacoInstance = monaco.editor.create(document.getElementById('monaco-editor')!, {
        value: this.getActiveFileContent(),
        language: this.getActiveFileLang(),
        theme: 'matrix-theme',
        fontFamily: 'Fira Code',
        fontSize: 14,
        automaticLayout: true,
        minimap: { enabled: false }
      });

      // Update content state when typing in editor
      this.monacoInstance.onDidChangeModelContent(() => {
        if (this.state.activeFileId) {
          const activeFile = this.state.files.get(this.state.activeFileId);
          if (activeFile) {
            activeFile.content = this.monacoInstance.getValue();
          }
        }
      });

      this.render();
    });
  }

  private bindEvents() {
    // Lucide Icons initialization
    // @ts-ignore
    if (window.lucide) window.lucide.createIcons();

    // Top Action Buttons
    document.getElementById('btn-new-file')?.addEventListener('click', () => this.createNewFilePrompt());
    document.getElementById('side-add-file')?.addEventListener('click', () => this.createNewFilePrompt());
    document.getElementById('btn-export')?.addEventListener('click', () => {
      alert("ZIP compilation pipeline ready! Ready to link JSZip.");
    });
  }

  private createNewFilePrompt() {
    const fileName = prompt("Enter file name (e.g., custom_item.json or tick.mcfunction):");
    if (!fileName) return;

    const id = Date.now().toString();
    const newFile: FileItem = {
      id,
      name: fileName,
      path: `data/mypack/function/${fileName}`,
      type: 'file',
      language: fileName.endsWith('.json') ? 'json' : 'plaintext',
      content: `# ${fileName}\n`
    };

    this.state.files.set(id, newFile);
    this.state.openTabIds.push(id);
    this.state.activeFileId = id;

    this.updateMonaco();
    this.render();
  }

  private getActiveFileContent(): string {
    if (!this.state.activeFileId) return "// No open files";
    return this.state.files.get(this.state.activeFileId)?.content || "";
  }

  private getActiveFileLang(): string {
    if (!this.state.activeFileId) return "plaintext";
    return this.state.files.get(this.state.activeFileId)?.language || "plaintext";
  }

  private switchFile(fileId: string) {
    const file = this.state.files.get(fileId);
    if (!file || file.type === 'folder') return;

    if (!this.state.openTabIds.includes(fileId)) {
      this.state.openTabIds.push(fileId);
    }

    this.state.activeFileId = fileId;
    this.updateMonaco();
    this.render();
  }

  private closeTab(fileId: string, event: Event) {
    event.stopPropagation();
    this.state.openTabIds = this.state.openTabIds.filter(id => id !== fileId);

    if (this.state.activeFileId === fileId) {
      this.state.activeFileId = this.state.openTabIds[this.state.openTabIds.length - 1] || null;
      this.updateMonaco();
    }

    this.render();
  }

  private updateMonaco() {
    if (!this.monacoInstance) return;
    
    // @ts-ignore
    const model = monaco.editor.createModel(
      this.getActiveFileContent(),
      this.getActiveFileLang()
    );
    this.monacoInstance.setModel(model);

    // Update Status Bar
    const statusElem = document.getElementById('status-file');
    if (statusElem) {
      const file = this.state.files.get(this.state.activeFileId || '');
      statusElem.textContent = file ? file.path : 'No file open';
    }
  }

  private render() {
    this.renderFileTree();
    this.renderTabs();
    // @ts-ignore
    if (window.lucide) window.lucide.createIcons();
  }

  private renderFileTree() {
    const treeContainer = document.getElementById('file-tree');
    if (!treeContainer) return;

    treeContainer.innerHTML = '';

    this.state.files.forEach((file) => {
      const itemEl = document.createElement('div');
      itemEl.className = `tree-item ${file.type} ${file.id === this.state.activeFileId ? 'active' : ''}`;
      
      const icon = file.type === 'folder' ? 'folder' : 'file-code';
      const depthClass = file.parentId ? 'style="padding-left: 28px;"' : '';

      itemEl.innerHTML = `<i data-lucide="${icon}"></i> <span>${file.name}</span>`;
      if (depthClass) itemEl.setAttribute('style', `padding-left: ${file.parentId ? 28 : 12}px`);

      itemEl.addEventListener('click', () => this.switchFile(file.id));
      treeContainer.appendChild(itemEl);
    });
  }

  private renderTabs() {
    const tabBar = document.getElementById('tab-bar');
    if (!tabBar) return;

    tabBar.innerHTML = '';

    this.state.openTabIds.forEach((fileId) => {
      const file = this.state.files.get(fileId);
      if (!file) return;

      const tabEl = document.createElement('div');
      tabEl.className = `tab ${file.id === this.state.activeFileId ? 'active' : ''}`;
      tabEl.innerHTML = `
        <i data-lucide="file-text"></i>
        <span>${file.name}</span>
        <i data-lucide="x" class="tab-close" data-id="${file.id}"></i>
      `;

      tabEl.addEventListener('click', () => this.switchFile(file.id));
      tabEl.querySelector('.tab-close')?.addEventListener('click', (e) => this.closeTab(file.id, e));

      tabBar.appendChild(tabEl);
    });
  }
}

// Instantiate IDE on Load
window.addEventListener('DOMContentLoaded', () => {
  new MatrixIDE();
});
