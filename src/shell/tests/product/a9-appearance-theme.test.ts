import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const rendererRoot = path.join(__dirname, '../../product/renderer');
const html = fs.readFileSync(path.join(rendererRoot, 'workbench.html'), 'utf8');
const script = fs.readFileSync(path.join(rendererRoot, 'a9-theme.js'), 'utf8');
// Product profile localStorage only; the record contains no connection settings.
const STORAGE_KEY = 'win7-coding-agent.a9.appearance.v1';

function createHarness(options: { raw?: string | null; readError?: boolean; accessError?: boolean } = {}) {
  const records = new Map<string, string>();
  if (options.raw !== undefined && options.raw !== null) records.set(STORAGE_KEY, options.raw);
  const listeners = new Map<string, () => void>();
  const attrs = new Map<string, string>();
  const themeColor = { setAttribute: jest.fn() };
  const colorScheme = { setAttribute: jest.fn() };
  const select = { value: 'light', addEventListener: jest.fn((type: string, callback: () => void) => listeners.set(type, callback)) };
  const status = { textContent: '', hidden: true };
  let bodyReady = false;
  const getItem = jest.fn((key: string) => {
    if (options.readError) throw new Error('private storage error detail');
    return records.get(key) ?? null;
  });
  const setItem = jest.fn((key: string, value: string) => { records.set(key, value); });
  // Any preload access is a failure: switching appearance must not read/save
  // model settings, probe a Provider, reconnect, or submit a task.
  const preloadAccess = jest.fn(() => { throw new Error('appearance accessed preload'); });
  const windowStub = Object.defineProperties({}, {
    localStorage: { get: () => {
      if (options.accessError) throw new Error('private storage access detail');
      return { getItem, setItem };
    } },
    win7Agent: { get: preloadAccess },
  });
  const documentStub = {
    documentElement: { setAttribute: (name: string, value: string) => attrs.set(name, value) },
    querySelector: (selector: string) => {
      if (selector === 'meta[name="theme-color"]') return themeColor;
      if (selector === 'meta[name="color-scheme"]') return colorScheme;
      throw new Error(`unexpected selector: ${selector}`);
    },
    getElementById: jest.fn((id: string) => {
      if (!bodyReady) throw new Error('body read before head startup completed');
      if (id === 'a9-appearance-theme') return select;
      if (id === 'a9-appearance-status') return status;
      throw new Error(`unexpected settings access: ${id}`);
    }),
    addEventListener: jest.fn((type: string, callback: () => void) => listeners.set(type, callback)),
  };
  const warn = jest.fn();
  vm.runInNewContext(script, { window: windowStub, document: documentStub, console: { warn } });
  return {
    attrs, themeColor, colorScheme, select, status, records, getItem, setItem, warn, preloadAccess, documentStub,
    ready() { bodyReady = true; listeners.get('DOMContentLoaded')!(); },
    change(value: string) { select.value = value; listeners.get('change')!(); },
  };
}

describe('A9-44 production appearance startup and persistence', () => {
  it('runs synchronously in the head before CSS/body with the unchanged production CSP', () => {
    const scriptTag = '<script src="a9-theme.js"></script>';
    expect(html.indexOf(scriptTag)).toBeGreaterThan(html.indexOf('Content-Security-Policy'));
    expect(html.indexOf(scriptTag)).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    expect(html.indexOf(scriptTag)).toBeLessThan(html.indexOf('<body>'));
    expect(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)![1]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('<meta name="theme-color" content="#f4f3ef">');
    expect(html).toContain('<label for="a9-appearance-theme">主题</label>');
    expect(html).toContain('<option value="light">浅色</option><option value="dark">暗色</option>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|<style\b|\sstyle=/);
  });

  it.each(['light', 'dark'])('applies stored %s before any body access without rewriting storage', (theme) => {
    const h = createHarness({ raw: JSON.stringify({ schemaVersion: 1, theme }) });
    expect(h.attrs.get('data-theme')).toBe(theme);
    expect(h.documentStub.getElementById).not.toHaveBeenCalled();
    expect(h.themeColor.setAttribute).toHaveBeenLastCalledWith('content', theme === 'dark' ? '#181b1d' : '#f4f3ef');
    expect(h.colorScheme.setAttribute).toHaveBeenLastCalledWith('content', theme);
    h.ready();
    expect(h.select.value).toBe(theme);
    expect(h.status.hidden).toBe(true);
    expect(h.setItem).not.toHaveBeenCalled();
    expect(h.preloadAccess).not.toHaveBeenCalled();
  });

  it('defaults to warm light when the key is missing and does not create a record', () => {
    const h = createHarness(); h.ready();
    expect(h.attrs.get('data-theme')).toBe('light');
    expect(h.select.value).toBe('light');
    expect(h.getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(h.setItem).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each([
    '', '{broken', 'null', '[]', 'true', '"dark"', '{}',
    '{"schemaVersion":2,"theme":"dark"}', '{"schemaVersion":"1","theme":"dark"}',
    '{"schemaVersion":1,"theme":"system"}', '{"schemaVersion":1,"theme":null}',
    '{"theme":"dark"}', '{"schemaVersion":1}',
    '{"schemaVersion":1,"theme":"dark","otherSetting":"excluded"}',
  ])('falls back on an invalid record %s with bounded diagnostics', (raw) => {
    const h = createHarness({ raw }); h.ready();
    expect(h.attrs.get('data-theme')).toBe('light');
    expect(h.select.value).toBe('light');
    expect(h.status.hidden).toBe(false);
    expect(h.status.textContent).toContain('已使用浅色');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][1]).toEqual({ schemaVersion: 1, code: raw === '' || raw === '{broken' ? 'READ_FAILED' : 'INVALID_RECORD' });
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it.each([{ readError: true }, { accessError: true }])('survives storage read/access exceptions %j', (options) => {
    const h = createHarness(options); h.ready();
    expect(h.attrs.get('data-theme')).toBe('light');
    expect(h.status.hidden).toBe(false);
    expect(h.status.textContent).toContain('无法读取');
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('private');
    expect(h.preloadAccess).not.toHaveBeenCalled();
  });

  it('changes immediately, stores only the exact versioned record, and restores it on the next startup', () => {
    const h = createHarness(); h.ready(); h.change('dark');
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.themeColor.setAttribute).toHaveBeenLastCalledWith('content', '#181b1d');
    expect(h.colorScheme.setAttribute).toHaveBeenLastCalledWith('content', 'dark');
    expect(h.setItem).toHaveBeenCalledTimes(1);
    expect(h.setItem).toHaveBeenLastCalledWith(STORAGE_KEY, '{"schemaVersion":1,"theme":"dark"}');
    const restarted = createHarness({ raw: h.records.get(STORAGE_KEY) }); restarted.ready();
    expect(restarted.select.value).toBe('dark');
    h.change('light');
    expect(h.attrs.get('data-theme')).toBe('light');
    expect(h.setItem).toHaveBeenLastCalledWith(STORAGE_KEY, '{"schemaVersion":1,"theme":"light"}');
    expect(h.preloadAccess).not.toHaveBeenCalled();
    expect(restarted.preloadAccess).not.toHaveBeenCalled();
  });

  it('keeps the in-memory choice on write failure, shows the warning, and clears it after a successful choice', () => {
    const h = createHarness(); h.ready();
    h.setItem.mockImplementationOnce(() => { throw new Error('private quota detail'); });
    h.change('dark');
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.select.value).toBe('dark');
    expect(h.records.has(STORAGE_KEY)).toBe(false);
    expect(h.status.hidden).toBe(false);
    expect(h.status.textContent).toContain('无法记住外观选择');
    expect(h.warn).toHaveBeenLastCalledWith('A9_APPEARANCE', { schemaVersion: 1, code: 'WRITE_FAILED' });
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('private');
    h.change('light');
    expect(h.status.hidden).toBe(true);
    expect(h.status.textContent).toBe('');
    expect(h.preloadAccess).not.toHaveBeenCalled();
  });

  it('does not persist an unsupported value injected into the select', () => {
    const h = createHarness({ raw: '{"schemaVersion":1,"theme":"dark"}' }); h.ready(); h.change('system');
    expect(h.select.value).toBe('dark');
    expect(h.attrs.get('data-theme')).toBe('dark');
    expect(h.setItem).not.toHaveBeenCalled();
    expect(h.preloadAccess).not.toHaveBeenCalled();
  });
});
