/**
 * Library scripts (DEV_NOTES §9.5, round 2): one hidden `srcdoc` frame per running script, kept
 * in the hub document so a script outlives the cards and sees the same API they do.
 */
import { REALM_SANDBOX, type ScriptsState } from '../protocol.js';
import {
  allScripts,
  SCRIPT_SCOPES,
  scriptFrameName,
  type Script,
  type ScriptScope,
} from '../scripts.js';
import type { Hub } from './hub.js';
import { buildScriptDocument } from './srcdoc.js';

interface Entry {
  frame: HTMLIFrameElement;
  /** what the frame was built from: a different `content` means a reload */
  content: string;
  name: string;
  scope: ScriptScope;
  /** the script's window once it has asked for its API; keys its listeners in the hub */
  owner: Window | null;
}

export interface ScriptsWindow extends Window {
  __tmScripts?: { install(target: Window): void };
}

export class ScriptFrames {
  private readonly entries = new Map<string, Entry>();
  private epoch: string | null = null;

  constructor(
    private readonly win: ScriptsWindow,
    private readonly hub: Hub,
    private readonly jqueryUrl: string,
    private readonly libBase?: string,
  ) {
    win.__tmScripts = { install: (target) => this.install(target) };
    hub.onScripts = (state) => this.sync(state);
    if (hub.scripts) this.sync(hub.scripts);
  }

  /** Bring the frames in line with the library: stop what should not run, start what should. */
  sync(state: ScriptsState): void {
    const reloadAll = state.epoch !== this.epoch;
    this.epoch = state.epoch;
    const running = new Set(state.running);
    const wanted = new Map<string, { script: Script; scope: ScriptScope }>();
    for (const scope of SCRIPT_SCOPES)
      for (const script of allScripts(state.trees[scope]))
        if (running.has(script.id) && !wanted.has(script.id))
          wanted.set(script.id, { script, scope });

    for (const [id, entry] of this.entries) {
      const want = wanted.get(id);
      if (reloadAll || !want || want.script.content !== entry.content) this.destroy(id);
    }
    for (const [id, want] of wanted)
      if (!this.entries.has(id)) this.create(want.script, want.scope);
  }

  private create(script: Script, scope: ScriptScope): void {
    const doc = this.win.document;
    const frame = doc.createElement('iframe');
    const name = scriptFrameName(script);
    frame.name = name;
    frame.id = name;
    frame.hidden = true;
    frame.setAttribute('sandbox', REALM_SANDBOX);
    this.entries.set(script.id, { frame, content: script.content, name, scope, owner: null });
    const libs = this.libBase === undefined ? undefined : { base: this.libBase };
    frame.srcdoc = buildScriptDocument(script.content, this.jqueryUrl, libs);
    doc.body.appendChild(frame);
  }

  private destroy(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.owner) this.hub.release(entry.owner);
    entry.frame.remove();
  }

  /** Called by the script document before its code runs. */
  private install(target: Window): void {
    for (const [id, entry] of this.entries) {
      if (entry.frame.contentWindow !== target) continue;
      entry.owner = target;
      this.hub.install(target, {
        name: entry.name,
        messageId: -1,
        script: { id, scope: entry.scope, reload: () => this.reload(id) },
      });
      return;
    }
  }

  /** `reloadIframe()`: after the caller returns, since it is the frame being removed */
  private reload(id: string): void {
    this.win.setTimeout(() => {
      const state = this.hub.scripts;
      if (!state || !this.entries.has(id)) return;
      this.destroy(id);
      this.sync(state);
    }, 0);
  }
}
