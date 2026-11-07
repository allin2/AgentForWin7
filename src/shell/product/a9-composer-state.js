'use strict';

// Main owns unsent text. Execution authority is deliberately never serialized.
const PREFIX = '\u0000A9_COMPOSER\n';
const MAX_ITEMS = 8;
const MAX_TEXT = 8000;

function createComposerState(storage) {
  const conversations = new Map();
  function read(id) {
    if (conversations.has(id)) return conversations.get(id);
    const value = { text: '', items: [], paused: true, persistence: 'memory', note: '' };
    const ciphertext = storage.read(id);
    conversations.set(id, value);
    if (!ciphertext) {
      value.persistence = storage.available() ? 'dpapi' : 'memory';
      if (value.persistence === 'memory') value.note = 'Windows DPAPI 不可用，草稿和队列仅在当前进程保留。';
      return value;
    }
    value.durable = true;
    try {
      if (!storage.available()) throw new Error('ENCRYPTION_UNAVAILABLE');
      const plaintext = storage.decrypt(ciphertext);
      if (plaintext.startsWith(PREFIX)) {
        const payload = JSON.parse(plaintext.slice(PREFIX.length));
        if (payload.schemaVersion !== 1 || typeof payload.text !== 'string' || payload.text.length > 32000
          || !Array.isArray(payload.items) || payload.items.length > MAX_ITEMS
          || payload.items.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 100
            || typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_TEXT)
          || new Set(payload.items.map(item => item.id)).size !== payload.items.length) throw new Error('INVALID_ENVELOPE');
        value.text = payload.text;
        value.items = payload.items.map(item => ({ id: item.id, text: item.text }));
      } else value.text = plaintext; // Existing DPAPI draft, without an envelope.
      value.persistence = 'dpapi';
    } catch (_error) {
      value.preserveCiphertext = true;
      value.note = '已保存内容无法解密或格式不受支持；原密文保留，本次内容仅在内存中。';
    }
    return value;
  }
  function save(id) {
    const value = read(id);
    if (!value.preserveCiphertext && storage.available()) {
      try {
        const serialized = PREFIX + JSON.stringify({ schemaVersion: 1, text: value.text, items: value.items });
        storage.write(id, value.text || value.items.length ? storage.encrypt(serialized) : null);
        value.persistence = 'dpapi';
        value.durable = true;
        value.note = '';
        return;
      } catch (_error) { /* Keep the previous ciphertext and current memory contents. */ }
    }
    value.persistence = 'memory';
    value.note = value.note || 'Windows DPAPI 不可用或保存失败，草稿和队列仅在当前进程保留。';
  }
  function draft(id) {
    const value = read(id);
    return { text: value.text, persistence: value.persistence,
      ...(value.note ? { note: value.note } : {}) };
  }
  function snapshot(id) {
    const value = read(id);
    return { schemaVersion: 1, paused: value.paused, items: value.items.map(item => ({ ...item })),
      persistence: value.persistence, note: [value.error && value.error.message, value.note].filter(Boolean).join(' '),
      ...(value.error ? { error: { ...value.error } } : {}) };
  }
  return {
    draft, snapshot,
    saveDraft(id, text) {
      read(id).text = String(text == null ? '' : text).slice(0, 32000);
      save(id);
      const { persistence, note } = draft(id);
      return { ok: true, persistence, ...(note ? { note } : {}) };
    },
    add(id, itemId, text) {
      const value = read(id);
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('A9_QUEUE_TEXT_INVALID');
      if (value.items.length >= MAX_ITEMS) throw new Error('A9_QUEUE_FULL');
      const wasEmpty = value.items.length === 0;
      value.items.push({ id: itemId, text });
      if (wasEmpty) value.paused = false;
      save(id);
      return snapshot(id);
    },
    remove(id, itemId) {
      const value = read(id);
      value.items = value.items.filter(item => item.id !== itemId);
      save(id);
      return snapshot(id);
    },
    pause(id, error = null) {
      // Stop and shutdown must not depend on a database read. A not-yet-loaded
      // conversation already restores paused and cannot own dispatch authority.
      const value = conversations.get(id);
      if (value) { value.paused = true; value.error = error; }
    },
    resume(id) { const value = read(id); value.paused = false; value.error = null; },
    take(id) {
      const value = read(id);
      if (value.paused || !value.items.length) return null;
      const item = value.items.shift();
      save(id);
      // A stale durable copy could replay after a crash. Refuse dispatch when
      // removal failed, retaining the item for an explicit user decision.
      if (value.persistence !== 'dpapi' && (value.durable || storage.available())) {
        value.items.unshift(item); value.paused = true;
        return null;
      }
      return item;
    },
  };
}

module.exports = { createComposerState };
