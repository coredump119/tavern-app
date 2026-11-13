import { describe, expect, it, vi } from 'vitest';
import { ApiRouter, Coverage } from '@tm/st-compat';
import { dataRoutes, type RouteDeps, type UploadedImage } from '../src/lib/ext/routes';

function setup(overrides: Partial<RouteDeps> = {}) {
  const saved: UploadedImage[] = [];
  const reinstall = vi.fn(async () => {});
  const deps: RouteDeps = {
    installed: () => [
      { name: 'from-github', source: 'https://github.com/someone/from-github' },
      { name: 'from-zip', source: null },
    ],
    reinstall,
    saveImage: async (file) => {
      saved.push(file);
      return `/user/images/${file.chName ?? ''}/${file.fileName ?? 'now'}.${file.format}`;
    },
    listImages: async (folder) =>
      folder === 'box'
        ? [
            { name: 'b.png', mtimeMs: 30 },
            { name: 'clip.mp4', mtimeMs: 20 },
            { name: 'a.webp', mtimeMs: 40 },
            { name: 'notes.txt', mtimeMs: 10 },
            { name: 'song.mp3', mtimeMs: 5 },
          ]
        : [],
    imageFolders: async () => ['Sera', 'box'],
    deleteImage: async (path) =>
      !path.replace(/^\//, '').startsWith('user/images/')
        ? 'invalid'
        : path.endsWith('gone.png')
          ? 'missing'
          : 'removed',
    ...overrides,
  };
  const router = new ApiRouter(dataRoutes(deps), new Coverage());
  const post = (path: string, body?: unknown) =>
    router.handle({ method: 'POST', path, query: new URLSearchParams(), body });
  return { post, saved, reinstall };
}

describe('extension data routes (DEV_NOTES §9.34 第 4 轮)', () => {
  it('uploads an image the way ST names it', async () => {
    const { post, saved } = setup();
    const reply = await post('/api/images/upload', {
      image: 'aGk=',
      format: 'png',
      filename: 'shot',
      ch_name: 'Sera',
    });
    expect(reply).toEqual({ status: 200, body: { path: '/user/images/Sera/shot.png' } });
    expect(saved).toEqual([{ chName: 'Sera', fileName: 'shot', format: 'png', image: 'aGk=' }]);
  });

  it('lists a folder of user/images the way ST sorts and filters it', async () => {
    const { post } = setup();
    const list = async (body: unknown) => (await post('/api/images/list', body)).body;
    // images only, oldest first
    expect(await list({ folder: 'box' })).toEqual(['b.png', 'a.webp']);
    expect(await list({ folder: 'box', sortOrder: 'desc' })).toEqual(['a.webp', 'b.png']);
    expect(await list({ folder: 'box', sortField: 'name' })).toEqual(['a.webp', 'b.png']);
    expect(await list({ folder: 'box', type: 0b111 })).toEqual([
      'song.mp3',
      'clip.mp4',
      'b.png',
      'a.webp',
    ]);
    expect(await list({ folder: 'box', type: 0b010 })).toEqual(['clip.mp4']);
    expect(await list({ folder: 'empty' })).toEqual([]);
    expect(await post('/api/images/list', {})).toEqual({
      status: 400,
      body: { error: 'No folder specified' },
    });
    expect(await post('/api/images/folders', {})).toEqual({ status: 200, body: ['Sera', 'box'] });
  });

  it('deletes a stored image with the answers ST gives', async () => {
    const { post } = setup();
    expect(await post('/api/images/delete', {})).toEqual({
      status: 400,
      body: 'No path specified',
    });
    expect(await post('/api/images/delete', { path: 'settings.json' })).toEqual({
      status: 400,
      body: 'Invalid path',
    });
    expect(await post('/api/images/delete', { path: 'user/images/box/gone.png' })).toEqual({
      status: 404,
      body: 'File not found',
    });
    expect(await post('/api/images/delete', { path: '/user/images/box/b.png' })).toEqual({
      status: 200,
      body: 'OK',
    });
  });

  it('refuses an upload ST would refuse', async () => {
    const { post, saved } = setup();
    expect(await post('/api/images/upload')).toMatchObject({ status: 400 });
    expect(await post('/api/images/upload', { format: 'png' })).toEqual({
      status: 400,
      body: { error: 'No image data provided' },
    });
    expect(await post('/api/images/upload', { image: 'aGk=', format: 'exe' })).toEqual({
      status: 400,
      body: { error: 'Invalid image format' },
    });
    expect(saved).toEqual([]);
  });

  it('a failed write is a 500', async () => {
    const { post } = setup({ saveImage: () => Promise.reject(new Error('disk full')) });
    const reply = await post('/api/images/upload', { image: 'aGk=', format: 'png' });
    expect(reply.status).toBe(500);
  });

  it('updates from the recorded address only', async () => {
    const { post, reinstall } = setup();
    // ST's client strips `third-party` and leaves the slash
    const reply = await post('/api/extensions/update', { extensionName: '/from-github' });
    expect(reply).toMatchObject({
      status: 200,
      body: { isUpToDate: false, remoteUrl: 'https://github.com/someone/from-github' },
    });
    expect(reinstall).toHaveBeenCalledWith('https://github.com/someone/from-github');

    expect((await post('/api/extensions/update', { extensionName: 'from-zip' })).status).toBe(500);
    expect((await post('/api/extensions/update', { extensionName: 'nope' })).status).toBe(404);
    expect((await post('/api/extensions/update', {})).status).toBe(400);
    expect(reinstall).toHaveBeenCalledTimes(1);
  });

  it('reports a version without git', async () => {
    const { post } = setup();
    expect(await post('/api/extensions/version', { extensionName: 'from-zip' })).toEqual({
      status: 200,
      body: { currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' },
    });
    expect((await post('/api/extensions/version', { extensionName: 'nope' })).status).toBe(404);
  });
});
