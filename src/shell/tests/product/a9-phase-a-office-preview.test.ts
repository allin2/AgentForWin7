/**
 * Phase A6（H-P2-09）：HTML 看板预览必须真实注入 CSP，并显式拦截非目标 file:// 与 UNC 子资源。
 * 使用 Electron 假对象验证主进程侧接线；真实 Electron 22 / Win7 行为未在此验证。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const preview = require('../../product/a9-office-preview');

function makeElectronFakes() {
  const state: any = { windows: [], sessions: [] };
  class FakeWebContents {
    handlers: Record<string, Array<(...args: any[]) => void>> = {};
    setWindowOpenHandler = jest.fn();
    on(name: string, fn: (...args: any[]) => void) { (this.handlers[name] ||= []).push(fn); }
  }
  class FakeBrowserWindow {
    webContents = new FakeWebContents();
    loadedUrls: string[] = [];
    loadFileCalled = false;
    private closedHandlers: Array<() => void> = [];
    constructor(public options: any) { state.windows.push(this); }
    setMenuBarVisibility() { /* noop */ }
    on(name: string, fn: () => void) { if (name === 'closed') this.closedHandlers.push(fn); }
    async loadURL(url: string) { this.loadedUrls.push(url); }
    async loadFile() { this.loadFileCalled = true; }
    isDestroyed() { return false; }
    close() { this.closedHandlers.forEach((fn) => fn()); }
    destroy() { /* noop */ }
  }
  const makeSession = (withProtocol: boolean) => {
    const ses: any = {
      beforeRequest: undefined as undefined | ((d: any, cb: (r: any) => void) => void),
      fileHandler: undefined as undefined | ((r: any, cb: (r: any) => void) => void),
      setPermissionRequestHandler: jest.fn(),
      setPermissionCheckHandler: jest.fn(),
      on: jest.fn(),
      webRequest: { onBeforeRequest(fn: any) { ses.beforeRequest = fn; } },
    };
    if (withProtocol) {
      ses.protocol = { interceptBufferProtocol: (scheme: string, handler: any) => { expect(scheme).toBe('file'); ses.fileHandler = handler; return true; } };
    }
    state.sessions.push(ses);
    return ses;
  };
  return { state, BrowserWindow: FakeBrowserWindow, makeSession };
}

describe('Phase A6: restricted HTML preview', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-a-preview-'))); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  describe('injectPreviewCsp', () => {
    const metaRe = /<meta http-equiv="Content-Security-Policy" content="[^"]*default-src 'none'[^"]*">/;
    it('injects the CSP meta right after <head>', () => {
      const out = preview.injectPreviewCsp(Buffer.from('<!doctype html><html><head><title>t</title></head><body>x</body></html>')).toString('utf8');
      expect(out).toMatch(/<head><meta http-equiv="Content-Security-Policy"/);
      expect(out).toMatch(metaRe);
      expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
    });
    it('adds a <head> when only <html> exists, keeps doctype first when there is neither', () => {
      expect(preview.injectPreviewCsp(Buffer.from('<html><body>x</body></html>')).toString()).toMatch(/<html><head><meta http-equiv="Content-Security-Policy"[^>]*><\/head><body>/);
      const doctypeOnly = preview.injectPreviewCsp(Buffer.from('<!DOCTYPE html>\n<p>x</p>')).toString();
      expect(doctypeOnly.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
      expect(preview.injectPreviewCsp(Buffer.from('<p>x</p>')).toString()).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    });
    it('keeps the original bytes (Chinese, GBK) untouched and respects a UTF-8 BOM', () => {
      const utf8 = preview.injectPreviewCsp(Buffer.from('\uFEFF<p>中文</p>', 'utf8'));
      expect(utf8.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(utf8.toString('utf8')).toContain('<p>中文</p>');
      const gbk = Buffer.concat([Buffer.from('<head></head><p>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</p>')]);
      const out = preview.injectPreviewCsp(gbk);
      expect(out.includes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(true);
    });
    it('rejects UTF-16 documents instead of previewing them without CSP', () => {
      expect(() => preview.injectPreviewCsp(Buffer.from('\uFEFF<p>x</p>', 'utf16le'))).toThrow(/A9_OFFICE_PREVIEW_ENCODING_UNSUPPORTED/);
    });
  });

  describe('request classification', () => {
    it('treats the target URL as allowed regardless of hash or percent-encoding differences', () => {
      const target = pathToFileURL(path.join(root, '汇报 看板.html')).toString();
      expect(preview.isPreviewTargetUrl(target, target)).toBe(true);
      expect(preview.isPreviewTargetUrl(`${target}#top`, target)).toBe(true);
      expect(preview.isPreviewTargetUrl(pathToFileURL(path.join(root, 'other.html')).toString(), target)).toBe(false);
    });
    it('classifies UNC, local and remote requests', () => {
      expect(preview.classifyBlockedRequest('file://attacker/share/x.png')).toBe('file_unc');
      expect(preview.classifyBlockedRequest('file:///C:/secret.png')).toBe('file_local');
      expect(preview.classifyBlockedRequest('https://example.invalid/x')).toBe('remote');
    });
  });

  describe('manager wiring', () => {
    const writeHtml = (name = 'board.html', content = '<html><head><title>t</title></head><body><img src="file://attacker/share/x.png"></body></html>') => {
      fs.writeFileSync(path.join(root, name), content, 'utf8');
      return name;
    };

    it('serves the injected document for the target URL via the file protocol interceptor, with a CSP header', async () => {
      const fakes = makeElectronFakes();
      const manager = preview.createRestrictedHtmlPreviewManager({ BrowserWindow: fakes.BrowserWindow, session: { fromPartition: () => fakes.makeSession(true) } });
      const result = await manager.open({ workspaceRoot: root, relativePath: writeHtml() });
      expect(result).toMatchObject({ ok: true, restricted: true, windowOpened: true, csp: preview.PREVIEW_CSP });

      const win = fakes.state.windows[0];
      const targetUrl = pathToFileURL(path.join(root, 'board.html')).toString();
      expect(win.loadedUrls).toEqual([targetUrl]);
      expect(win.loadFileCalled).toBe(false);

      const ses = fakes.state.sessions[0];
      let response: any;
      ses.fileHandler({ url: targetUrl }, (r: any) => { response = r; });
      expect(response.mimeType).toBe('text/html');
      expect(response.charset).toBe('utf-8');
      expect(response.headers['Content-Security-Policy']).toBe(preview.PREVIEW_CSP);
      expect(Buffer.from(response.data).toString('utf8')).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    });

    it.each([
      ['UNC file URL', 'file://attacker/share/x.png', 'file_unc'],
      ['another local file', 'file:///C:/Users/me/secret.png', 'file_local'],
      ['remote URL', 'https://example.invalid/beacon', 'remote'],
    ])('cancels a %s sub-resource request at both webRequest and the file protocol layer', async (_label, subresource, kind) => {
      const fakes = makeElectronFakes();
      const manager = preview.createRestrictedHtmlPreviewManager({ BrowserWindow: fakes.BrowserWindow, session: { fromPartition: () => fakes.makeSession(true) } });
      await manager.open({ workspaceRoot: root, relativePath: writeHtml() });
      const ses = fakes.state.sessions[0];
      const targetUrl = pathToFileURL(path.join(root, 'board.html')).toString();

      let decision: any;
      ses.beforeRequest({ url: targetUrl }, (r: any) => { decision = r; });
      expect(decision).toEqual({ cancel: false });
      ses.beforeRequest({ url: subresource }, (r: any) => { decision = r; });
      expect(decision).toEqual({ cancel: true });

      if (subresource.startsWith('file:')) {
        let response: any;
        ses.fileHandler({ url: subresource }, (r: any) => { response = r; });
        expect(response).toEqual({ error: -10 });
      }
      expect(manager.getBlockedRequests().some((item: any) => item.kind === kind && item.url === subresource)).toBe(true);
    });

    it('blocks navigation and redirects away from the target document', async () => {
      const fakes = makeElectronFakes();
      const manager = preview.createRestrictedHtmlPreviewManager({ BrowserWindow: fakes.BrowserWindow, session: { fromPartition: () => fakes.makeSession(true) } });
      await manager.open({ workspaceRoot: root, relativePath: writeHtml() });
      const wc = fakes.state.windows[0].webContents;
      for (const event of ['will-navigate', 'will-redirect']) {
        const prevented = jest.fn();
        wc.handlers[event][0]({ preventDefault: prevented }, 'file://attacker/share/page.html');
        expect(prevented).toHaveBeenCalledTimes(1);
        const allowed = jest.fn();
        wc.handlers[event][0]({ preventDefault: allowed }, pathToFileURL(path.join(root, 'board.html')).toString());
        expect(allowed).not.toHaveBeenCalled();
      }
    });

    it('fails closed when the session cannot intercept the file protocol', async () => {
      const fakes = makeElectronFakes();
      const manager = preview.createRestrictedHtmlPreviewManager({ BrowserWindow: fakes.BrowserWindow, session: { fromPartition: () => fakes.makeSession(false) } });
      await expect(manager.open({ workspaceRoot: root, relativePath: writeHtml() })).rejects.toMatchObject({ code: 'A9_OFFICE_PREVIEW_CSP_UNAVAILABLE' });
      expect(fakes.state.windows).toHaveLength(0);
    });

    it('rejects an unsupported-encoding document before opening a window', async () => {
      const fakes = makeElectronFakes();
      const manager = preview.createRestrictedHtmlPreviewManager({ BrowserWindow: fakes.BrowserWindow, session: { fromPartition: () => fakes.makeSession(true) } });
      fs.writeFileSync(path.join(root, 'u16.html'), Buffer.from('\uFEFF<p>x</p>', 'utf16le'));
      await expect(manager.open({ workspaceRoot: root, relativePath: 'u16.html' })).rejects.toMatchObject({ code: 'A9_OFFICE_PREVIEW_ENCODING_UNSUPPORTED' });
      expect(fakes.state.windows).toHaveLength(0);
    });
  });
});
