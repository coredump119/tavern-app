/** In-memory data root standing in for the Rust commands the lib modules call. */
import { vi } from 'vitest';

export interface MockFs {
  files: Map<string, string>;
  calls: string[];
}

export function createMockFs(initial: Record<string, string> = {}): MockFs {
  return { files: new Map(Object.entries(initial)), calls: [] };
}

/** Pass to `vi.mock('../src/lib/ipc', () => ipcModule(fs))`. Paths are `${root}/${rel}`. */
export function ipcModule(fs: MockFs) {
  const key = (root: string, rel: string) => `${root}/${rel}`;
  return {
    isTauri: () => false,
    dataList: vi.fn(async (root: string, rel: string, ext?: string) => {
      const prefix = `${root}/${rel}/`;
      return [...fs.files.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => k.slice(prefix.length))
        .filter((f) => !ext || f.endsWith(`.${ext}`))
        .sort();
    }),
    dataReadText: vi.fn(async (root: string, rel: string) => {
      const v = fs.files.get(key(root, rel));
      if (v === undefined) throw new Error(`ENOENT ${rel}`);
      return v;
    }),
    dataWriteText: vi.fn(async (root: string, rel: string, text: string) => {
      fs.calls.push(`write ${rel}`);
      fs.files.set(key(root, rel), text);
    }),
    dataDelete: vi.fn(async (root: string, rel: string) => {
      fs.calls.push(`delete ${rel}`);
      if (!fs.files.delete(key(root, rel))) throw new Error(`ENOENT ${rel}`);
    }),
    cardRead: vi.fn(async (path: string) => {
      const v = fs.files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    }),
    cardWrite: vi.fn(async (path: string, json: string) => {
      fs.files.set(path, json);
    }),
    cardRename: vi.fn(async (_root: string, avatar: string, newName: string) => {
      fs.calls.push(`rename ${avatar} -> ${newName}`);
      return `${newName}.png`;
    }),
    cardDelete: vi.fn(async () => undefined),
    cardDuplicate: vi.fn(async () => 'dup.png'),
    cardAvatarReplace: vi.fn(async () => undefined),
    chatRenameCharacter: vi.fn(async () => 2),
    chatRenameGroupMember: vi.fn(async (_root: string, chatIds: string[]) => chatIds.length),
  };
}
