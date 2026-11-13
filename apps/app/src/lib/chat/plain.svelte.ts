/**
 * Plain snapshots of the open chat's reactive state, shared by everything that hands it to
 * `@tm/core` (the chat page, slash commands, script generations). Core may write into what it is
 * given and must never touch `$state` proxies; one snapshot per change, not one per reader.
 */
import type { CharacterLike } from '@tm/core';
import type { Group } from '@tm/formats';
import { chatStore, type Character } from './store.svelte';

class PlainChat {
  readonly settings = $derived<Record<string, unknown> | null>(
    chatStore.settings ? $state.snapshot(chatStore.settings) : null,
  );
  readonly character = $derived<Character | null>(
    chatStore.character ? ($state.snapshot(chatStore.character) as Character) : null,
  );
  readonly group = $derived<Group | null>(
    chatStore.group ? ($state.snapshot(chatStore.group) as Group) : null,
  );
  readonly members = $derived($state.snapshot(chatStore.members) as unknown as CharacterLike[]);
  /** read-only: clone before handing it to core, which adds `variables` to it */
  readonly chatMetadata = $derived<Record<string, unknown>>(
    $state.snapshot(chatStore.chatMetadata),
  );
}

export const plainChat = new PlainChat();
