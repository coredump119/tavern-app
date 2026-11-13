<script lang="ts">
  import { onMount } from 'svelte';
  import AppShell from './lib/components/AppShell.svelte';
  import TopBar from './lib/components/TopBar.svelte';
  import NavList, { type Route } from './lib/components/NavList.svelte';
  import ThemePanel from './lib/components/ThemePanel.svelte';
  import PopupHost from './lib/components/PopupHost.svelte';
  import AvatarCropper from './lib/components/AvatarCropper.svelte';
  import ToastHost from './lib/components/ToastHost.svelte';
  import ExtensionsMenu from './lib/components/ExtensionsMenu.svelte';
  import Chat from './routes/Chat.svelte';
  import Characters from './routes/Characters.svelte';
  import CharacterEditor from './routes/CharacterEditor.svelte';
  import GroupEditor from './routes/GroupEditor.svelte';
  import Connection from './routes/Connection.svelte';
  import WorldInfo from './routes/WorldInfo.svelte';
  import Persona from './routes/Persona.svelte';
  import Regex from './routes/Regex.svelte';
  import Extensions from './routes/Extensions.svelte';
  import Data from './routes/Data.svelte';
  import Presets from './routes/Presets.svelte';
  import { chatStore } from './lib/chat/store.svelte';
  import { extensionHost } from './lib/ext/host.svelte';
  import { themeStore } from './lib/theme.svelte';
  import Styleguide from './routes/Styleguide.svelte';
  import NetCheck from './routes/NetCheck.svelte';
  import { ping } from './lib/ipc';

  let route = $state<Route>('chat');
  let sidebarOpen = $state(false);
  let inspectorOpen = $state(false);
  let backend = $state('…');
  let editAvatar = $state<string | null>(null);
  function editCharacter(avatar: string) {
    editAvatar = avatar;
    route = 'character';
  }
  // group editor: an id, or null for "new group"
  let editGroupId = $state<string | null>(null);
  function editGroup(id: string | null) {
    editGroupId = id;
    route = 'group';
  }

  onMount(async () => {
    const p = await ping();
    backend = `${p.platform} · ${p.version}`;
  });

  // DEV_NOTES §9.31: come back to the page that was open last time (pages needing an id fall back)
  const RESTORABLE: Route[] = [
    'chat',
    'characters',
    'worlds',
    'persona',
    'regex',
    'extensions',
    'connection',
    'presets',
    'data',
    'styleguide',
    'netcheck',
  ];
  // $state: the second effect must re-run once the restore happened, not only when `route` changes
  let restored = $state(false);
  $effect(() => {
    if (restored || !chatStore.ready) return;
    restored = true;
    const saved = chatStore.savedRoute;
    if (saved && (RESTORABLE as string[]).includes(saved)) route = saved as Route;
  });
  $effect(() => {
    if (!restored) return;
    const r = route;
    chatStore.rememberRoute(r === 'character' || r === 'group' ? 'characters' : r);
  });

  // DEV_NOTES §9.34: extensions load once the data root and settings are there
  $effect(() => {
    if (chatStore.ready) void extensionHost.init();
  });

  // transparent floating top bar only on the chat page with a chat open (theme layout.immersiveChat)
  const immersive = $derived(
    route === 'chat' && chatStore.open && themeStore.current.layout.immersiveChat,
  );
  let chatTitle = $state('聊天');
  let chatSubtitle = $state<string | undefined>(undefined);
  const titles: Record<Route, string> = {
    characters: '角色',
    character: '角色设定',
    group: '群组设定',
    chat: '聊天',
    worlds: '世界书',
    persona: '用户设定',
    regex: '正则脚本',
    extensions: '扩展',
    connection: 'API 连接',
    presets: '预设 / 采样',
    data: '数据与备份',
    styleguide: '设计系统',
    netcheck: '网络自检',
  };
</script>

<AppShell bind:sidebarOpen bind:inspectorOpen>
  {#snippet sidebar()}
    <NavList
      {route}
      footer={backend}
      onNavigate={(r) => {
        route = r;
        sidebarOpen = false;
      }}
    />
  {/snippet}
  {#snippet main()}
    <TopBar
      title={route === 'chat' ? chatTitle : titles[route]}
      subtitle={route === 'chat' ? chatSubtitle : undefined}
      onMenu={() => (sidebarOpen = true)}
      onInspector={() => (inspectorOpen = true)}
      {immersive}
    />
    {#if route === 'chat'}
      <Chat
        onOpenCharacters={() => (route = 'characters')}
        onEditCharacter={editCharacter}
        onEditGroup={editGroup}
        onTitle={(t, sub) => {
          chatTitle = t;
          chatSubtitle = sub;
        }}
      />
    {:else if route === 'characters'}
      <Characters
        onOpen={() => (route = 'chat')}
        onEdit={editCharacter}
        onEditGroup={editGroup}
        onNewGroup={() => editGroup(null)}
      />
    {:else if route === 'character' && editAvatar}
      <CharacterEditor
        avatar={editAvatar}
        onClose={() => (route = 'characters')}
        onOpenChat={async (a) => {
          if (chatStore.character?.avatar !== a) await chatStore.openCharacter(a);
          route = 'chat';
        }}
        onRenamed={(a) => (editAvatar = a)}
        onDeleted={() => {
          editAvatar = null;
          route = 'characters';
        }}
      />
    {:else if route === 'group'}
      <GroupEditor
        id={editGroupId}
        onClose={() => (route = 'characters')}
        onSaved={(id) => (editGroupId = id)}
        onOpenChat={async (id) => {
          if (chatStore.group?.id !== id) await chatStore.openGroup(id);
          route = 'chat';
        }}
        onDeleted={() => {
          editGroupId = null;
          route = 'characters';
        }}
      />
    {:else if route === 'worlds'}
      <WorldInfo />
    {:else if route === 'persona'}
      <Persona onOpenWorlds={() => (route = 'worlds')} />
    {:else if route === 'regex'}
      <Regex />
    {:else if route === 'extensions'}
      <!-- drawn below: the page stays mounted -->
    {:else if route === 'connection'}
      <Connection />
    {:else if route === 'presets'}
      <Presets />
    {:else if route === 'data'}
      <Data />
    {:else if route === 'netcheck'}
      <NetCheck onOpenChat={() => (route = 'chat')} />
    {:else}
      <Styleguide />
    {/if}
    <Extensions active={route === 'extensions'} />
  {/snippet}
  {#snippet inspector()}
    <ThemePanel />
  {/snippet}
</AppShell>
<PopupHost />
<AvatarCropper />
<ExtensionsMenu />
<ToastHost />
