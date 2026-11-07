const { createComposerState } = require('../../product/a9-composer-state');
const { controls } = require('../../product/renderer/a9-composer-controller');

describe('A9-50 unsent Composer state', () => {
  function fixture() {
    const disk = new Map();
    const storage = { available: () => true, read: (id: string) => disk.get(id),
      write: (id: string, value: string) => disk.set(id, value),
      encrypt: (text: string) => Buffer.from(text).toString('base64'),
      decrypt: (text: string) => Buffer.from(text, 'base64').toString('utf8') };
    return { disk, storage, make: () => createComposerState(storage) };
  }
  it('keeps drafts and FIFO isolated by conversation, restores only paused items', () => {
    const f = fixture(); const state = f.make();
    state.saveDraft('a', 'unsent'); state.add('a', 'one', 'first'); state.add('a', 'two', 'second');
    expect(state.draft('b').text).toBe('');
    expect(state.draft('a').text).toBe('unsent');
    expect(state.take('a')).toEqual({ id: 'one', text: 'first' });
    const restored = f.make();
    expect(restored.snapshot('a')).toMatchObject({ paused: true, items: [{ id: 'two', text: 'second' }] });
    expect(restored.take('a')).toBeNull();
    restored.resume('a'); expect(restored.take('a').text).toBe('second');
    expect(restored.draft('a').text).toBe('unsent');
  });
  it('preserves legacy drafts and unknown envelopes without overwriting ciphertext', () => {
    const f = fixture();
    f.disk.set('old', f.storage.encrypt('old text'));
    expect(f.make().draft('old').text).toBe('old text');
    const unknown = f.storage.encrypt('\u0000A9_COMPOSER\n{"schemaVersion":99}');
    f.disk.set('unknown', unknown);
    const state = f.make(); state.saveDraft('unknown', 'new in memory');
    expect(f.disk.get('unknown')).toBe(unknown);
    expect(state.draft('unknown')).toMatchObject({ text: 'new in memory', persistence: 'memory' });
  });
  it('does not dispatch a durable item when removal cannot be persisted', () => {
    const f = fixture(); const state = f.make(); state.add('a', 'one', 'sensitive unsent');
    const before = f.disk.get('a');
    f.storage.write = () => { throw new Error('disk unavailable'); };
    expect(state.take('a')).toBeNull();
    expect(state.snapshot('a')).toMatchObject({ paused: true, items: [{ id: 'one' }], persistence: 'memory' });
    expect(f.disk.get('a')).toBe(before);
  });
  it('can pause without reading storage, so a storage error cannot block Stop', () => {
    const f = fixture(); f.storage.read = () => { throw new Error('storage unavailable'); };
    const state = f.make(); expect(() => state.pause('a')).not.toThrow();
    expect(() => state.snapshot('a')).toThrow('storage unavailable');
    expect(() => state.snapshot('a')).toThrow('storage unavailable');
  });
  it('bounds memory-only queues and never serializes execution authority', () => {
    const f = fixture(); f.storage.available = () => false;
    const state = f.make();
    for (let i = 0; i < 8; i++) state.add('a', String(i), `message ${i}`);
    expect(() => state.add('a', 'overflow', 'overflow')).toThrow('A9_QUEUE_FULL');
    expect(() => state.add('b', 'long', 'x'.repeat(8001))).toThrow('A9_QUEUE_TEXT_INVALID');
    state.pause('a'); expect(state.take('a')).toBeNull();
    state.remove('a', '0'); state.resume('a'); expect(state.take('a').id).toBe('1');
    expect(f.disk.size).toBe(0);
  });
  it('separates editing, sending and queueing under real blockers', () => {
    const ready = { status: 'ready', mode: 'read_only', agentStatus: 'running',
      provider: { configured: true, probe: { classification: 'tool_calling' } } };
    expect(controls(ready, true, 'next')).toEqual({ canDraft: true, canSend: false, canQueue: true });
    expect(controls({ ...ready, agentStatus: 'idle' }, false, 'next').canSend).toBe(true);
    for (const block of [{ status: 'diagnostics' }, { pendingApproval: {} }, { pendingQuestion: {} }, { mode: 'review' }, { agentStatus: 'cancelling' }]) {
      expect(controls({ ...ready, ...block }, true, 'next')).toEqual({ canDraft: false, canSend: false, canQueue: false });
    }
    expect(controls(null, false, 'next').canDraft).toBe(false);
  });
});
