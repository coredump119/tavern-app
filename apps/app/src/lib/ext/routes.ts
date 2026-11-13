/**
 * ST server routes an extension calls that reach into the data folder (DEV_NOTES §9.34 第 4 轮,
 * 第 12 轮).
 * Rune-free with the app's side injected, so the node tests reach it. Status codes and reply
 * shapes are ST's (`src/endpoints/images.js`, `src/endpoints/extensions.js`).
 */
import { MEDIA_EXTENSIONS, MEDIA_TYPE, mediaTypeFromName } from '@tm/core';
import type { ApiReply, ApiRoutes } from '@tm/st-compat';

export interface UploadedImage {
  chName: string | null;
  fileName: string | null;
  format: string;
  /** base64, no `data:` prefix */
  image: string;
}

export interface StoredImage {
  name: string;
  /** modification time, ms since the epoch */
  mtimeMs: number;
}

/** ST `MEDIA_REQUEST_TYPE`: the bits of a listing's `type` */
const REQUEST_TYPE = {
  [MEDIA_TYPE.IMAGE]: 0b001,
  [MEDIA_TYPE.VIDEO]: 0b010,
  [MEDIA_TYPE.AUDIO]: 0b100,
};

export interface RouteDeps {
  /** installed extensions: folder name and the address it was installed from, if any */
  installed(): readonly { name: string; source: string | null }[];
  /** install again from that address; rejects when it fails */
  reinstall(source: string): Promise<void>;
  /** writes the file; gives the data-root relative path with a leading slash */
  saveImage(file: UploadedImage): Promise<string>;
  /** the files directly inside `user/images/<folder>/`, in any order */
  listImages(folder: string): Promise<StoredImage[]>;
  /** the folders inside `user/images/` */
  imageFolders(): Promise<string[]>;
  /** deletes one file under `user/images/` by its data-root relative path */
  deleteImage(path: string): Promise<'removed' | 'missing' | 'invalid'>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const NAME_REQUIRED = 'Bad Request: A valid extensionName is required in the request body.';

/** ST's client sends `third-party/<folder>` minus the prefix, which leaves a leading slash */
const folderOf = (name: string): string => name.replace(/^\/?(third-party)?\/?/, '');

export function dataRoutes(deps: RouteDeps): ApiRoutes {
  const find = (body: unknown): ApiReply | { name: string; source: string | null } => {
    const name = isRecord(body) ? body['extensionName'] : undefined;
    if (typeof name !== 'string') return { status: 400, body: NAME_REQUIRED };
    const folder = folderOf(name);
    const found = deps.installed().find((e) => e.name === folder);
    return found ?? { status: 404, body: `Directory does not exist at ${folder}` };
  };

  return {
    'POST /api/images/upload': async ({ body }) => {
      if (!isRecord(body)) return { status: 400, body: { error: 'No data provided' } };
      const image = text(body['image']);
      if (!image) return { status: 400, body: { error: 'No image data provided' } };
      const format = body['format'];
      if (typeof format !== 'string' || !MEDIA_EXTENSIONS.includes(format))
        return { status: 400, body: { error: 'Invalid image format' } };
      const path = await deps.saveImage({
        chName: text(body['ch_name']),
        fileName: text(body['filename']),
        format,
        image,
      });
      return { status: 200, body: { path } };
    },

    'POST /api/images/list': async ({ body }) => {
      const request = isRecord(body) ? body : {};
      const folder = text(request['folder']);
      if (!folder) return { status: 400, body: { error: 'No folder specified' } };
      const type = Number(request['type'] ?? REQUEST_TYPE.image);
      const files = (await deps.listImages(folder)).filter((file) => {
        const kind = mediaTypeFromName(file.name);
        return kind !== null && (type & REQUEST_TYPE[kind]) !== 0;
      });
      const sort = request['sortField'] || 'date';
      if (sort === 'date') files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      else if (sort === 'name') {
        const { compare } = new Intl.Collator();
        files.sort((a, b) => compare(a.name, b.name));
      }
      const names = files.map((file) => file.name);
      if (request['sortOrder'] === 'desc') names.reverse();
      return { status: 200, body: names };
    },

    'POST /api/images/folders': async () => ({ status: 200, body: await deps.imageFolders() }),

    'POST /api/images/delete': async ({ body }) => {
      const path = isRecord(body) ? text(body['path']) : null;
      if (!path) return { status: 400, body: 'No path specified' };
      const done = await deps.deleteImage(path);
      if (done === 'invalid') return { status: 400, body: 'Invalid path' };
      if (done === 'missing') return { status: 404, body: 'File not found' };
      return { status: 200, body: 'OK' };
    },

    'POST /api/extensions/update': async ({ body }) => {
      const found = find(body);
      if ('status' in found) return found;
      // no git here: without a recorded address there is nothing to pull (ST answers 500 too)
      if (!found.source)
        return {
          status: 500,
          body: 'Internal Server Error. Check the server logs for more details.',
        };
      await deps.reinstall(found.source);
      return {
        status: 200,
        body: {
          shortCommitHash: '',
          extensionPath: `extensions/${found.name}`,
          isUpToDate: false,
          remoteUrl: found.source,
        },
      };
    },

    'POST /api/extensions/version': ({ body }) => {
      const found = find(body);
      if ('status' in found) return found;
      return {
        status: 200,
        body: {
          currentBranchName: '',
          currentCommitHash: '',
          isUpToDate: true,
          remoteUrl: found.source ?? '',
        },
      };
    },
  };
}
