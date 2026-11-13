// 把 RegexEngine 接到 CC/TC 管线的 applyRegex 钩子上（script.js Generate() 中各处 getRegexedString 的调用参数）。
import type { ApplyRegex, RegexPlacement } from '../prompt/core-chat.js';
import type { RegexEngine } from './engine.js';
import { REGEX_PLACEMENT } from './types.js';

const PLACEMENT_MAP: Record<RegexPlacement, number> = {
  user: REGEX_PLACEMENT.USER_INPUT,
  ai: REGEX_PLACEMENT.AI_OUTPUT,
  reasoning: REGEX_PLACEMENT.REASONING,
  world_info: REGEX_PLACEMENT.WORLD_INFO,
};

export function createApplyRegex(engine: RegexEngine): ApplyRegex {
  return (text, placement, { isPrompt, depth }) => {
    const params =
      placement === 'world_info'
        ? { depth, isMarkdown: false, isPrompt: true }
        : { isPrompt, depth };
    return engine.getRegexedString(text, PLACEMENT_MAP[placement], params);
  };
}
