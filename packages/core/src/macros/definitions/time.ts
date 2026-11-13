// ST time-macros.js 移植。
import moment from 'moment';
import { MacroCategory, MacroValueType, type MacroRegistry } from '../registry.js';
import { nowMoment, timestampToMoment } from '../../util/time.js';
import type { CoreState } from '../../state.js';

const now = (s: CoreState) => nowMoment(s.now, s.locale ?? 'en');

export function registerTimeMacros(registry: MacroRegistry): void {
  registry.registerMacro('time', {
    category: MacroCategory.TIME,
    unnamedArgs: [
      {
        name: 'offset',
        optional: true,
        defaultValue: 'null',
        type: MacroValueType.STRING,
        sampleValue: 'UTC+2',
        description: 'UTC offset in the format UTC±(offset).',
      },
    ],
    description: 'Current local time, or UTC offset when called as {{time::UTC±(offset)}}',
    returns: 'A time string in the format HH:mm.',
    displayOverride: '{{time::[UTC±(offset)]}}',
    exampleUsage: ['{{time}}', '{{time::UTC+2}}', '{{time::UTC-7}}'],
    handler: ({ unnamedArgs: [offsetSpec], env }) => {
      const m = now(env.runtime);
      if (!offsetSpec) return m.format('LT');
      const match = /^UTC([+-]\d+)$/.exec(offsetSpec);
      if (!match) return m.format('LT');
      const offset = Number.parseInt(match[1]!, 10);
      if (Number.isNaN(offset)) return m.format('LT');
      return m.utc().utcOffset(offset).format('LT');
    },
  });
  registry.registerMacro('date', {
    category: MacroCategory.TIME,
    description: 'Current local date as a string in the local short format.',
    returns: 'Current local date in local short format.',
    handler: ({ env }) => now(env.runtime).format('LL'),
  });
  registry.registerMacro('weekday', {
    category: MacroCategory.TIME,
    description: 'Current weekday name.',
    returns: 'Current weekday name.',
    handler: ({ env }) => now(env.runtime).format('dddd'),
  });
  registry.registerMacro('isotime', {
    category: MacroCategory.TIME,
    description: 'Current time in HH:mm format.',
    returns: 'Current time in HH:mm format.',
    handler: ({ env }) => now(env.runtime).format('HH:mm'),
  });
  registry.registerMacro('isodate', {
    category: MacroCategory.TIME,
    description: 'Current date in YYYY-MM-DD format.',
    returns: 'Current date in YYYY-MM-DD format.',
    handler: ({ env }) => now(env.runtime).format('YYYY-MM-DD'),
  });
  registry.registerMacro('datetimeformat', {
    category: MacroCategory.TIME,
    unnamedArgs: [
      {
        name: 'format',
        sampleValue: 'YYYY-MM-DD HH:mm:ss',
        description: 'Moment.js format string.',
        type: 'string',
      },
    ],
    description: 'Formats the current date/time using the given moment.js format string.',
    returns: 'Formatted date/time string.',
    exampleUsage: ['{{datetimeformat::YYYY-MM-DD HH:mm:ss}}', '{{datetimeformat::LLLL}}'],
    handler: ({ unnamedArgs: [format], env }) => now(env.runtime).format(format),
  });
  registry.registerMacro('idleDuration', {
    aliases: [{ alias: 'idle_duration', visible: false }],
    category: MacroCategory.TIME,
    description: 'Human-readable duration since the last user message.',
    returns: 'Human-readable duration since the last user message.',
    handler: ({ env }) => getTimeSinceLastMessage(env.runtime),
  });
  registry.registerMacro('timeDiff', {
    category: MacroCategory.TIME,
    unnamedArgs: [
      {
        name: 'left',
        sampleValue: '2023-01-01 12:00:00',
        description: 'Left time value.',
        type: 'string',
      },
      {
        name: 'right',
        sampleValue: '2023-01-01 15:00:00',
        description: 'Right time value.',
        type: 'string',
      },
    ],
    description:
      'Human-readable difference between two times. Order of times does not matter, it will return the absolute difference.',
    returns: 'Human-readable difference between two times.',
    displayOverride: '{{timeDiff::left::right}}',
    exampleUsage: ['{{ timeDiff :: 2023-01-01 12:00:00 :: 2023-01-01 15:00:00 }}'],
    handler: ({ unnamedArgs: [left, right], env }) => {
      const locale = env.runtime.locale ?? 'en';
      const diff = moment.duration(moment(left).locale(locale).diff(moment(right)));
      return diff.locale(locale).humanize(true);
    },
  });
}

export function getTimeSinceLastMessage(state: CoreState): string {
  const current = now(state);
  const chat = state.chat;
  if (Array.isArray(chat) && chat.length > 0) {
    let lastMessage: (typeof chat)[number] | undefined;
    let takeNext = false;
    for (let i = chat.length - 1; i >= 0; i--) {
      const message = chat[i]!;
      if (message.is_system) continue;
      if (message.is_user && takeNext) {
        lastMessage = message;
        break;
      }
      takeNext = true;
    }
    if (lastMessage?.send_date) {
      const lastMessageDate = timestampToMoment(lastMessage.send_date, state.locale ?? 'en');
      const duration = moment.duration(current.diff(lastMessageDate));
      return duration.locale(state.locale ?? 'en').humanize();
    }
  }
  return 'just now';
}
