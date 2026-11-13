/**
 * 生成的宿主侧编排：开始 → 事件 → 结束，并在页面从后台回来时用 Rust 快照补齐错过的内容。
 * Rust 侧在切后台时继续收流（iOS 有约 30s 宽限，Android 由前台服务保活）；网页层可能被冻结，
 * 所以回到前台先拉一次快照，再决定是"已完成"还是"断了、可继续"。
 */
import {
  generateAbort,
  generateForget,
  generateSnapshot,
  generateStart,
  type GenEvent,
  type GenSnapshot,
  type GenState,
  type GenerateRequest,
  type SecretRef,
} from './ipc';

export interface GenerationOutcome {
  id: string;
  state: GenState;
  text: string;
  reasoning: string;
  swipes: string[];
  /** tool calls the model asked for; empty unless the request sent `tools` and finished normally */
  toolCalls: unknown[];
  error: string | null;
  /** 断流 / 中断且已有半截文本：UI 可提供"继续生成"（以 text 作为已有回复走 continue） */
  canContinue: boolean;
  /** 回到前台时从快照补回了错过的内容 */
  recovered: boolean;
}

export interface GenerationHandlers {
  onDelta?: (text: string, reasoning: string) => void;
  onEvent?: (event: GenEvent) => void;
  onRecovered?: (snapshot: GenSnapshot) => void;
}

export interface GenerationHandle {
  id: Promise<string>;
  result: Promise<GenerationOutcome>;
  abort: () => Promise<void>;
}

export function runGeneration(
  request: GenerateRequest,
  secret: SecretRef | null,
  handlers: GenerationHandlers = {},
): GenerationHandle {
  let text = '';
  let reasoning = '';
  let swipes: string[] = [];
  let toolCalls: unknown[] = [];
  let settled = false;
  let recovered = false;
  let resolveResult!: (o: GenerationOutcome) => void;
  const result = new Promise<GenerationOutcome>((r) => (resolveResult = r));

  const finish = (id: string, state: GenState, error: string | null) => {
    if (settled) return;
    settled = true;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    if (id) void generateForget(id).catch(() => undefined);
    resolveResult({
      id,
      state,
      text,
      reasoning,
      swipes,
      toolCalls,
      error,
      canContinue: state !== 'done' && text.length > 0,
      recovered,
    });
  };

  let idValue: string | null = null;
  const applySnapshot = (snap: GenSnapshot) => {
    if (snap.text.length > text.length || snap.reasoning.length > reasoning.length) {
      text = snap.text;
      reasoning = snap.reasoning;
      swipes = snap.swipes;
      recovered = true;
      handlers.onRecovered?.(snap);
      handlers.onDelta?.(text, reasoning);
    }
    if (snap.state !== 'running' && idValue) finish(idValue, snap.state, snap.error);
  };
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || !idValue || settled) return;
    void generateSnapshot(idValue)
      .then((snap) => snap && applySnapshot(snap))
      .catch(() => undefined);
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);

  const id = generateStart(request, secret, (event) => {
    handlers.onEvent?.(event);
    switch (event.type) {
      case 'delta':
        text = event.text;
        reasoning = event.reasoning;
        swipes = event.swipes;
        handlers.onDelta?.(text, reasoning);
        break;
      case 'done':
        text = event.text;
        reasoning = event.reasoning;
        swipes = event.swipes;
        toolCalls = event.tool_calls ?? [];
        handlers.onDelta?.(text, reasoning);
        if (idValue) finish(idValue, 'done', null);
        else void id.then((v) => finish(v, 'done', null));
        break;
      case 'error':
        if (idValue) finish(idValue, 'error', event.message);
        else void id.then((v) => finish(v, 'error', event.message));
        break;
      default:
        break;
    }
  });
  void id.then(
    (v) => {
      idValue = v;
    },
    // the request never left (bad URL, missing key, …): settle instead of waiting forever
    (e: unknown) => finish('', 'error', e instanceof Error ? e.message : String(e)),
  );

  return {
    id,
    result,
    abort: async () => {
      const v = await id;
      await generateAbort(v);
      // 中断后 Rust 不再发事件：用快照收尾
      const snap = await generateSnapshot(v).catch(() => null);
      if (snap) applySnapshot(snap);
      if (!settled) finish(v, 'aborted', null);
    },
  };
}
