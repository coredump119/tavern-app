/** Host controller and hub wired back to back through a queue that clones like `postMessage`. */
import { expect } from 'vitest';
import { HostController, type HostStatus, type Port } from '../src/host.js';
import {
  openEnvelope,
  type ChatSplice,
  type HostToHub,
  type HubToHost,
  type RawMessage,
  type ScriptsState,
} from '../src/protocol.js';
import { Hub } from '../src/realm/hub.js';
import type { ScriptScope, ScriptTree } from '../src/scripts.js';

export const ORIGIN = 'tmhelper://localhost';
export const msg = (mes: string, over: Partial<RawMessage> = {}): RawMessage => ({
  name: over.is_user ? 'Me' : 'Seraphina',
  is_user: false,
  send_date: '2026-01-01T00:00:00.000Z',
  mes,
  extra: {},
  ...over,
});

export function setup() {
  const queue: (() => void)[] = [];
  let chat: readonly RawMessage[] = [msg('first'), msg('hi', { is_user: true }), msg('reply')];
  const saved: Record<string, unknown> = {};
  const statuses: HostStatus[] = [];
  /** what the fake app was asked to do, in order */
  const calls: unknown[][] = [];
  let library: ScriptsState | null = null;
  let ids = 0;
  const hubPort: Port = {
    postMessage(message, origin) {
      expect(origin).toBe(ORIGIN);
      const copy = structuredClone(message);
      queue.push(() => hub.receive(openEnvelope<HostToHub>(copy)!));
    },
  };
  const host = new HostController(
    ORIGIN,
    {
      spliceChat(splice: ChatSplice) {
        const next = chat.slice();
        next.splice(splice.start, splice.deleteCount, ...splice.messages);
        chat = next;
        return chat;
      },
      setVariables: (scope, value) => void (saved[scope] = value),
      timestamp: () => 'NOW',
      async runSlash(command) {
        calls.push(['slash', command]);
        if (command.startsWith('/nope')) throw new Error('未支持的 slash 命令：/nope');
        return `ran ${command}`;
      },
      async generate(kind, config, generationId, on) {
        calls.push(['generate', kind, config, generationId]);
        if (config['custom_api']) throw new Error('generate 的 custom_api 尚未支持');
        on.start();
        if (config['should_stream']) {
          on.text('He', 'He');
          on.text('Hello', 'llo');
        }
        return config['should_return_reasoning'] ? { content: 'Hello', reasoning: 'hm' } : 'Hello';
      },
      stopGeneration: (generationId) => void calls.push(['stop', generationId]),
      setScriptTrees(scope: ScriptScope, trees: ScriptTree[]) {
        calls.push(['scripts', scope, trees]);
        if (!library) return;
        // the app stores it, then its sync effect pushes the library back
        library = { ...library, trees: { ...library.trees, [scope]: trees } };
        host.syncScripts(library);
      },
      newId: () => `new-${++ids}`,
      async call(name, args, from) {
        calls.push(['call', name, args, from]);
        if (name === 'nope') throw new Error('未知的调用：nope');
        return { name, args };
      },
    },
    (s) => statuses.push(s),
  );
  const hub = new Hub((message: HubToHost) => {
    const copy = structuredClone({ ...message, tm: 'th', v: 1 });
    queue.push(() => host.handleMessage(hubPort, copy));
  });
  /** deliver until both sides are quiet, letting microtasks (variable flushes) run in between */
  const pump = async () => {
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      const next = queue.shift();
      if (!next) {
        // an async capability answers a few microtasks after its request was delivered
        for (let k = 0; k < 8 && queue.length === 0; k++) await Promise.resolve();
        if (queue.length === 0) return;
        continue;
      }
      next();
    }
    throw new Error('bridge did not settle');
  };
  const api = hub.createApi(globalThis, { name: 'TH-message--2--0', messageId: 2 });
  return {
    host,
    hub,
    hubPort,
    api,
    pump,
    statuses,
    saved,
    calls,
    setLibrary(state: ScriptsState) {
      library = state;
      host.syncScripts(state);
    },
    library: () => library,
    chat: () => chat,
    /** what the app does after its own store changed */
    appSet(next: readonly RawMessage[]) {
      chat = next;
      host.syncChat('chat-a', chat);
    },
    async start() {
      host.attachHub(hubPort);
      host.syncChat('chat-a', chat);
      host.syncVariables('chat', { hp: 10 });
      host.syncVariables('global', { lang: 'zh' });
      host.syncNames({ user: 'Me', char: 'Seraphina' });
      host.handleMessage(hubPort, { tm: 'th', v: 1, type: 'ready', ok: true });
      await pump();
    },
  };
}
