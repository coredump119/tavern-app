/** `/inject`, `/listinjects`, `/flushinject` (ST slash-commands.js `injectCallback` and friends). */
import { isTrue, SlashClosure, SlashError } from '@tm/st-compat';
import { text, type AddCommand, type SlashEnv } from './shared';

/** ST's default for `depth=` */
const DEFAULT_DEPTH = 4;

export function injectCommands(add: AddCommand, env: Pick<SlashEnv, 'injects'>): void {
  const { injects } = env;

  add(['inject'], {
    run: (named, unnamed) => {
      if (named['filter'] !== undefined) {
        throw new SlashError('/inject 暂不支持 filter= 闭包');
      }
      if (unnamed instanceof SlashClosure) throw new SlashError('/inject 的内容不能是闭包');
      const id = text(named['id']) || Math.random().toString(36).substring(2);
      const content = text(unnamed);
      // ST: an empty text takes the injection away
      if (!content) {
        injects.remove([id]);
        return id;
      }
      const depth = Number(named['depth'] ?? DEFAULT_DEPTH);
      injects.set([
        {
          id,
          position: (injects.position(named['position'] ?? 'after') ?? injects.position('after'))!,
          depth: Number.isNaN(depth) ? DEFAULT_DEPTH : depth,
          role: injects.role(text(named['role'] ?? 'system').trim()),
          content,
          scan: isTrue(named['scan']),
          once: isTrue(named['ephemeral']),
          filtered: false,
        },
      ]);
      return id;
    },
  });

  // ST shows the list in a popup unless `return=` asks for it; scripts only want the value.
  // The shape is ST's `chat_metadata.script_injects`.
  add(['listinjects'], {
    run: (named) => {
      if (text(named['return']).trim().toLowerCase() === 'none') return '';
      const table: Record<string, unknown> = {};
      for (const inject of injects.list()) {
        table[inject.id] = {
          value: inject.content,
          position: inject.position,
          depth: inject.depth,
          scan: inject.scan,
          role: inject.role,
          filter: null,
        };
      }
      return JSON.stringify(table);
    },
  });

  add(['flushinject', 'flushinjects'], {
    run: (_named, unnamed) => {
      const id = text(unnamed).trim();
      if (id) injects.remove([id]);
      else injects.clear();
      return '';
    },
  });
}
