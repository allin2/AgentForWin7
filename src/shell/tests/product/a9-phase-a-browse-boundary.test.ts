/// <reference path="./better-sqlite3.d.ts" />
/**
 * Phase A8（H-P2-11）：a9.workspace.browse 与读取共用工作区边界规则。
 * 用户自选（ordinary）工作区同样不得列出工作区外目录、绝对路径、盘符或 UNC。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const { normalizeConversationTitle } = require('../../../state/dist');
const { createA9AgentRuntime, openA9RuntimePersistence } = require('../../product/a9-agent-runtime');
const { createA9WorkspaceRegistry } = require('../../product/a9-workspace-registry');
const { createA9ProductRequestHandler } = require('../../product/a9-product-ipc');

describe('Phase A8: a9.workspace.browse boundary', () => {
  let root: string, documents: string, dataRoot: string, outside: string, workspace: string;
  let registry: any, handler: any, databases: any[];
  const scope = () => { const e = registry.getActive(); return { workspaceId: e.workspaceId, conversationId: e.runtime.getSnapshot().activeConversationId }; };
  const browse = (target: string) => handler({}, { schemaVersion: 9, action: 'a9.workspace.browse', payload: { path: target }, scope: scope() });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a9-phase-a-browse-')));
    documents = path.join(root, 'docs'); dataRoot = path.join(root, 'data'); outside = path.join(root, '工作区外 目录');
    workspace = path.join(root, '用户 工作区');
    for (const dir of [documents, outside, workspace, path.join(workspace, '子 目录')]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.writeFileSync(path.join(workspace, '子 目录', 'a.txt'), 'a');
    fs.writeFileSync(path.join(workspace, 'top.txt'), 't');
    databases = [];
    const options = { dataRoot, openDatabase: (file: string, flags: any) => { const db = new Database(file, flags); databases.push(db); return db; } };
    registry = createA9WorkspaceRegistry({ getDocumentsPath: () => documents, now: () => new Date(2026, 10, 9, 12), normalizeConversationTitle,
      openPersistence: () => openA9RuntimePersistence(options),
      createRuntime: (workspaceRoot: string, host: any) => createA9AgentRuntime({ ...options, ...host, workspaceRoot, ownerId: `main-${process.pid}` }) });
    handler = createA9ProductRequestHandler({ workspaceRegistry: registry, isValidRendererSender: () => true,
      getA9Runtime: () => registry.getActive()?.runtime });
    registry.activate(workspace);
  });
  afterEach(async () => {
    try { await registry.shutdown(); }
    finally { try { for (const db of databases) if (db.open) db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } }
  });

  it('still lists the workspace root and nested relative directories', async () => {
    const rootList = await browse('');
    expect(rootList.ok).toBe(true);
    expect(rootList.result.entries.map((e: any) => e.name).sort()).toEqual(['top.txt', '子 目录']);
    const dot = await browse('.');
    expect(dot.ok).toBe(true);
    const nested = await browse('子 目录');
    expect(nested.ok).toBe(true);
    expect(nested.result.entries.map((e: any) => e.name)).toEqual(['a.txt']);
  });

  it.each([
    ['parent directory', '..'],
    ['parent traversal', '../工作区外 目录'],
    ['embedded traversal', '子 目录/../../工作区外 目录'],
    ['backslash traversal', '..\\工作区外 目录'],
    ['Windows drive path', 'C:\\Windows'],
    ['Windows drive-relative path', 'C:Windows'],
    ['UNC path', '\\\\server\\share'],
    ['slash UNC path', '//server/share/dir'],
    ['rooted path', '/etc'],
  ])('rejects %s', async (_label, target) => {
    const result = await browse(target);
    expect(result.ok).toBeFalsy();
    expect(result.error.code).toBe('A9_WORKSPACE_BROWSE_PATH_INVALID');
  });

  it('rejects an absolute path to an outside directory even though it exists', async () => {
    const result = await browse(outside);
    expect(result.error.code).toBe('A9_WORKSPACE_BROWSE_PATH_INVALID');
    expect(JSON.stringify(result)).not.toContain('secret.txt');
  });

  it('rejects a symlink inside the workspace that resolves outside', async () => {
    fs.symlinkSync(outside, path.join(workspace, 'link-out'), 'dir');
    const result = await browse('link-out');
    expect(result.error.code).toBe('A9_WORKSPACE_BROWSE_OUTSIDE');
    expect(JSON.stringify(result)).not.toContain('secret.txt');
  });

  it('applies the same unsafe-path rule to the Viewer read entry', async () => {
    const read = (target: string) => registry.getActive().runtime.readWorkspaceFile({ path: target });
    for (const target of ['C:\\Windows\\win.ini', '\\\\server\\share\\x.txt', '../x', outside]) {
      await expect(read(target)).rejects.toMatchObject({ code: 'A9_WORKSPACE_READ_PATH_INVALID' });
    }
  });
});
