export interface FileItem {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder';
  content?: string;
  language?: string;
  parentId?: string | null;
}

export interface IDEState {
  files: Map<string, FileItem>;
  openTabIds: string[];
  activeFileId: string | null;
}
