// A minimal ST third-party extension, written for this repo, to check the extension host on a device.
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
// not an ST export: must come back undefined and show up under 「缺的接口」, not break the import
import { tmSampleNoSuchExport } from '../../../utils.js';

const NAME = 'tm-sample';
const FOLDER = `third-party/${NAME}`;
/** 自己拼的 1×1 灰色 PNG */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==';

const results = [];
const seen = { events: [] };
window.tmSample = { results, seen };

function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok), detail: String(detail) });
  const list = document.getElementById('tm_sample_log');
  if (!list) return;
  list.replaceChildren(
    ...results.map((r) => {
      const li = document.createElement('li');
      li.dataset.ok = String(r.ok);
      li.textContent = `${r.ok ? '✓' : '✗'} ${r.label}${r.detail ? `（${r.detail}）` : ''}`;
      return li;
    }),
  );
}

function attempt(label, run) {
  try {
    const out = run();
    check(label, out !== false, out === true || out === false ? '' : out);
  } catch (error) {
    check(label, false, error?.message ?? error);
  }
}

for (const name of [
  'APP_INITIALIZED',
  'APP_READY',
  'CHAT_CHANGED',
  'MESSAGE_RECEIVED',
  'MESSAGE_SENT',
  'MESSAGE_EDITED',
  'MESSAGE_DELETED',
  'GENERATION_STARTED',
  'GENERATION_ENDED',
]) {
  eventSource.on(event_types[name], (...args) => {
    seen.events.push([name, ...args]);
  });
}

export function onActivate() {
  seen.activated = true;
}

async function addPanel() {
  const html = await renderExtensionTemplateAsync(FOLDER, 'panel', { title: 'TM 样例扩展' });
  $('#extensions_settings').append(html);

  extension_settings[NAME] ??= { flag: false, loads: 0 };
  const settings = extension_settings[NAME];
  settings.loads += 1;
  saveSettingsDebounced();

  $('#tm_sample_flag')
    .prop('checked', settings.flag)
    .on('input', function () {
      settings.flag = Boolean($(this).prop('checked'));
      saveSettingsDebounced();
    });
  $('#tm_sample_toast').on('click', () => toastr.success('样例扩展的提示', 'toastr'));
  $('#tm_sample_popup').on('click', async () => {
    seen.popup = await callGenericPopup('<b>样例扩展</b>的确认框', POPUP_TYPE.CONFIRM);
    check('callGenericPopup 有返回', seen.popup !== undefined, seen.popup);
  });
}

function addMenuItem() {
  const item = $(
    '<div id="tm_sample_menu" class="list-group-item flex-container flexGap5 interactable">' +
      '<div class="fa-solid fa-flask extensionsMenuExtensionButton"></div><span>样例扩展</span></div>',
  );
  item.on('click', () => {
    seen.menuClicks = (seen.menuClicks ?? 0) + 1;
    toastr.info('魔杖菜单里的项被点了');
  });
  $('#extensionsMenu').append(item);
}

async function run() {
  attempt(
    'window.SillyTavern.getContext 和模块里的是同一个',
    () => SillyTavern.getContext === getContext,
  );
  const context = getContext();
  attempt('context.chat 是数组', () => Array.isArray(context.chat) && `${context.chat.length} 条`);
  attempt(
    'context.characters 是数组',
    () => Array.isArray(context.characters) && `${context.characters.length} 个`,
  );
  attempt(
    'context.extensionSettings 就是 extension_settings',
    () => context.extensionSettings === extension_settings,
  );
  attempt(
    'context.eventSource 就是模块里的 eventSource',
    () => context.eventSource === eventSource,
  );
  attempt('全局 $ / toastr / DOMPurify / moment 都在', () =>
    [window.$, window.jQuery, window.toastr, window.DOMPurify, window.moment].every(Boolean),
  );
  attempt(
    'SillyTavern.libs.lodash 可用',
    () => SillyTavern.libs.lodash.chunk([1, 2, 3], 2).length === 2,
  );
  attempt('不存在的导出是 undefined', () => tmSampleNoSuchExport === undefined);
  attempt('不存在的 context 成员是 undefined', () => context.tmSampleNoSuchMember === undefined);
  attempt('getExtensionManifest 读得到自己', () => context.getExtensionManifest?.(FOLDER)?.version);
  attempt('substituteParams 展开 {{user}}', () => {
    const out = context.substituteParams('{{user}}');
    return out !== '{{user}}' && out.length > 0;
  });

  try {
    await addPanel();
    check(
      '设置面板加进 #extensions_settings',
      document.querySelector('#extensions_settings .tm-sample-settings'),
    );
  } catch (error) {
    check('设置面板加进 #extensions_settings', false, error?.message ?? error);
  }
  attempt('菜单项加进 #extensionsMenu', () => {
    addMenuItem();
    return Boolean(document.querySelector('#extensionsMenu #tm_sample_menu'));
  });
  attempt(
    '样式表生效',
    () => getComputedStyle(document.getElementById('tm_sample_log')).paddingLeft !== '0px',
  );
  attempt('extension_settings 记下了加载次数', () => `第 ${extension_settings[NAME].loads} 次`);

  // 第 2 轮：斜杠命令、宏、生成接口（生成拦截器在 manifest 的 generate_interceptor 里登记）
  try {
    const [parser, command, args, legacy, system] = await Promise.all([
      import('../../../slash-commands/SlashCommandParser.js'),
      import('../../../slash-commands/SlashCommand.js'),
      import('../../../slash-commands/SlashCommandArgument.js'),
      import('../../../macros.js'),
      import('../../../macros/macro-system.js'),
    ]);
    parser.SlashCommandParser.addCommandObject(
      command.SlashCommand.fromProps({
        name: 'tm-sample-echo',
        callback: (named, text) => `${named.prefix ?? ''}${text}`,
        namedArgumentList: [
          args.SlashCommandNamedArgument.fromProps({
            name: 'prefix',
            typeList: [args.ARGUMENT_TYPE.STRING],
          }),
        ],
        unnamedArgumentList: [args.SlashCommandArgument.fromProps({ description: '要回显的字' })],
      }),
    );
    const ran = await context.executeSlashCommandsWithOptions('/tm-sample-echo prefix=a b');
    check('注册的斜杠命令跑得起来', ran?.pipe === 'ab', ran?.pipe);
    legacy.MacrosParser.registerMacro('tm_sample_legacy', () => 'legacy-ok', '样例宏');
    system.macros.register('tm_sample_new', {
      category: system.MacroCategory.UTILITY,
      description: '样例宏',
      handler: () => 'new-ok',
    });
    check(
      '两种写法的宏都注册上了',
      system.macros.registry.hasMacro('tm_sample_legacy') &&
        system.macros.registry.hasMacro('tm_sample_new'),
    );
    check(
      'getContext 有 generateRaw / generateQuietPrompt',
      typeof context.generateRaw === 'function' &&
        typeof context.generateQuietPrompt === 'function',
    );
  } catch (error) {
    check('第 2 轮接口', false, error?.message ?? error);
  }

  try {
    const headers = context.getRequestHeaders();
    const found = await fetch('/api/extensions/discover', { method: 'POST', headers, body: '{}' });
    const list = await found.json();
    check(
      '/api/extensions/discover 列出自己',
      list.some((e) => e.name === FOLDER),
      `${list.length} 个`,
    );
    const missing = await fetch('/api/plugins/tm-sample/none', {
      method: 'POST',
      headers,
      body: '{}',
    });
    check('没做的服务端接口回 501', missing.status === 501, missing.status);
    const own = await fetch(`/scripts/extensions/${FOLDER}/manifest.json`);
    check('读得到自己文件夹里的文件', own.ok && (await own.json()).version === '0.1.0');

    // 第 4 轮：落到数据目录的服务端接口
    const uploaded = await fetch('/api/images/upload', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image: PIXEL,
        format: 'png',
        filename: 'tm-sample-pixel.jpg',
        ch_name: NAME,
      }),
    });
    const { path } = await uploaded.json();
    check(
      '/api/images/upload 存图并回路径',
      path === `/user/images/${NAME}/tm-sample-pixel.png`,
      path,
    );
    const refused = await fetch('/api/images/upload', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image: PIXEL, format: 'exe' }),
    });
    check('/api/images/upload 不收别的格式', refused.status === 400, refused.status);
    const version = await fetch('/api/extensions/version', {
      method: 'POST',
      headers,
      body: JSON.stringify({ extensionName: NAME }),
    });
    const info = await version.json();
    check(
      '/api/extensions/version 回得出来',
      info.isUpToDate === true,
      info.remoteUrl || '没有来源',
    );
  } catch (error) {
    check('fetch', false, error?.message ?? error);
  }

  // 第 3 轮：不在聊天页时这些挂点也得在
  attempt('#qr--bar 随时找得到，加的按钮留得住', () => {
    const bar = document.querySelector('#qr--bar');
    if (!bar) return false;
    const group = document.createElement('div');
    group.className = 'qr--buttons';
    const button = document.createElement('div');
    button.className = 'qr--button menu_button';
    button.id = 'tm_sample_qr';
    button.title = 'tm-sample';
    button.textContent = '样例';
    group.append(button);
    bar.append(group);
    return document.querySelector('#qr--bar #tm_sample_qr') === button;
  });
  attempt('#top-settings-holder 找得到', () => !!document.querySelector('#top-settings-holder'));

  // 第 8 轮：函数工具、指定楼层的 swipe、一次生成的事件顺序
  try {
    context.registerFunctionTool({
      name: 'tm_sample_clock',
      displayName: '样例时钟',
      description: 'Returns the current time. Call it whenever the user asks what time it is.',
      parameters: {
        type: 'object',
        properties: { zone: { type: 'string', description: 'IANA time zone name' } },
        required: [],
      },
      action: ({ zone }) => `${zone || 'UTC'} 12:34`,
      formatMessage: () => '样例时钟在走',
    });
    const told = await context.ToolManager.invokeFunctionTool('tm_sample_clock', '{"zone":"UTC"}');
    check('注册的函数工具调得起来', told === 'UTC 12:34', told);
    check('工具调用的开关读得到', typeof context.isToolCallingSupported() === 'boolean');
    check(
      'swipe 能指定楼层',
      typeof context.swipe?.to === 'function' && typeof context.swipe?.isAllowed === 'function',
    );
  } catch (error) {
    check('第 8 轮接口', false, error?.message ?? error);
  }
  const order = [];
  const ORDERED = [
    'GENERATION_STARTED',
    'MESSAGE_SENT',
    'USER_MESSAGE_RENDERED',
    'GENERATION_AFTER_COMMANDS',
    'CHAT_COMPLETION_PROMPT_READY',
    'GENERATE_AFTER_DATA',
    'STREAM_TOKEN_RECEIVED',
    'TOOL_CALLS_PERFORMED',
    'TOOL_CALLS_RENDERED',
    'MESSAGE_RECEIVED',
    'CHARACTER_MESSAGE_RENDERED',
  ];
  for (const name of ORDERED)
    eventSource.on(event_types[name], () => {
      // 流式的字一帧一次，只记头一次
      if (order.at(-1) !== name) order.push(name);
    });
  eventSource.on(event_types.GENERATION_ENDED, () => {
    console.warn(`[tm-sample] 事件顺序 ${order.splice(0).join(' > ')} > GENERATION_ENDED`);
  });

  eventSource.on(event_types.APP_READY, () => {
    check('activate 钩子跑过', seen.activated === true);
    check('收到 APP_READY', true);
  });
  eventSource.on(event_types.CHAT_CHANGED, (id) => {
    check('收到 CHAT_CHANGED', true, id === undefined ? '没开聊天' : '有聊天');
    if (id === undefined) return report();
    attempt('注册的宏在聊天里能替换', () => {
      const out = context.substituteParams('{{tm_sample_legacy}}/{{tm_sample_new}}');
      return out === 'legacy-ok/new-ok' || out;
    });
    attempt('进了聊天页，#qr--bar 在 #send_form 里且按钮还在', () => {
      const form = document.querySelector('#send_form');
      if (!form) return false;
      return !!form.querySelector(':scope > #qr--bar #tm_sample_qr');
    });
    report();
  });
  report();
}

/** 一行汇总进控制台：不开面板也能看结果 */
function report() {
  const failed = results.filter((r) => !r.ok).map((r) => `${r.label}（${r.detail}）`);
  console.warn(`[tm-sample] ${results.length - failed.length}/${results.length} 通过`, ...failed);
}

/** ST generate_interceptor：只记一笔，不改 chat */
globalThis.tmSampleInterceptor = (chat, contextSize, abort, type) => {
  seen.intercepted = { messages: chat.length, contextSize, type };
  console.warn('[tm-sample] 生成拦截器', chat.length, contextSize, type);
};

await run();
