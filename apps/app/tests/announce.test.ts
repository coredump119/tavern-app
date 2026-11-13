import { describe, expect, it } from 'vitest';
import { plainText, replyAnnouncement } from '../src/lib/announce';

describe('plainText', () => {
  it('drops markdown marks, tags and link targets', () => {
    expect(plainText('*She smiles.* "Hello, **traveller**."')).toBe(
      'She smiles. "Hello, traveller."',
    );
    expect(plainText('<div class="x">one</div>\n\n<p>two</p>')).toBe('one two');
    expect(plainText('see [the map](https://example.invalid/m) and ![pic](a.png)')).toBe(
      'see the map and pic',
    );
    expect(plainText('# Title\n> quoted ~~gone~~')).toBe('Title quoted gone');
  });

  it('drops code blocks and style / script bodies, closed or not', () => {
    expect(plainText('before\n```js\nlet a = 1;\n```\nafter')).toBe('before after');
    expect(plainText('before\n```js\nlet a = 1;')).toBe('before');
    expect(plainText('a<style>.x { color: red }</style>b<script>run()</script>c')).toBe('a b c');
  });
});

describe('replyAnnouncement', () => {
  it('names the speaker', () => {
    expect(replyAnnouncement('Seraphina', '*nods* Yes.')).toBe('Seraphina：nods Yes.');
    expect(replyAnnouncement('', 'Yes.')).toBe('Yes.');
  });

  it('says nothing for a message with no readable text', () => {
    expect(replyAnnouncement('Seraphina', '')).toBe('');
    expect(replyAnnouncement('Seraphina', '```\ncode only\n```')).toBe('');
  });

  it('cuts a long message at 300 characters without splitting a surrogate pair', () => {
    const long = replyAnnouncement('', 'a'.repeat(500));
    expect(long).toBe(`${'a'.repeat(300)}…`);
    const emoji = replyAnnouncement('', `${'a'.repeat(299)}😀${'b'.repeat(50)}`);
    expect(emoji).toBe(`${'a'.repeat(299)}…`);
  });
});
