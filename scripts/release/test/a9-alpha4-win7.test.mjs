import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { selfCheck } from '../alpha4-win7/alpha4-win7.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const driver = require('../alpha4-win7/driver.cjs');

test('alpha.4 Win7 driver bytes are fixed, ASCII and free of run bindings', () => {
  const text = fs.readFileSync(path.join(repo, 'scripts/release/alpha4-win7/driver.cjs'), 'utf8');
  assert.doesNotMatch(text, /[^\x09\x0a\x0d\x20-\x7e]/);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  assert.doesNotMatch(text, /\b[0-9a-f]{40}\b/);
  assert.doesNotMatch(text, /a944-0f817a86|3b726a4b|cleanup-r1/);
});

test('strict fixture mirrors the Qwen3.5/3.6 system position rule and scripts the A9-45 turn', () => {
  const sys = (content) => ({ role: 'system', content });
  const facts = (messages, tools = []) => driver.wireFacts({ messages, tools: tools.map((name) => ({ type: 'function', function: { name } })) });
  assert.equal(driver.fixtureStep(facts([sys('a'), sys('b'), { role: 'user', content: 'x' }])).status, 400);
  assert.equal(driver.fixtureStep(facts([sys('a'), { role: 'user', content: 'x' }, sys('late')])).status, 400);
  assert.equal(driver.fixtureStep(facts([{ role: 'user', content: 'p' }], ['probe_test_echo'])).kind, 'probe');
  assert.equal(driver.fixtureStep(facts([sys('a'), { role: 'user', content: 'A945-CONTROL' }])).text, 'A945-CONTROL-OK');
  assert.equal(driver.fixtureStep(facts([sys('a'), { role: 'user', content: 'go' }], ['read'])).tool.name, 'read');
  assert.equal(driver.fixtureStep(facts([sys('a'), { role: 'user', content: 'go' }, { role: 'assistant', content: null }, { role: 'tool', content: 'r' }])).text, 'A945-OK');
  const merged = facts([sys('base\n\n<environment_facts>\nx\n</environment_facts>\n\n' + driver.AGENTS_MARKER), { role: 'user', content: 'go' }]);
  assert.deepEqual([merged.systems, merged.system_only_at_head, merged.environment_in_system, merged.agents_in_system], [1, true, true, true]);
});

test('packaged Gateway control: passthrough is rejected, the default merge is accepted', async () => {
  const { OpenAICompatibleProvider } = require(path.join(repo, 'src/gateway/dist/provider/openai-compatible.js'));
  const fixture = await driver.startStrictFixture();
  try {
    const messages = [{ role: 'system', content: 'A945 base' }, { role: 'system', content: '<environment_facts>\ncontrol\n</environment_facts>' }, { role: 'user', content: 'A945-CONTROL' }];
    await assert.rejects(new OpenAICompatibleProvider({ baseUrl: fixture.url, model: 'a945-control', systemMessagePolicy: 'passthrough', totalTimeoutMs: 20000 })
      .sendStreamRequest({ id: 'pass', messages }, () => {}), new RegExp(driver.STRICT_ERROR.replace('.', '\\.')));
    const merged = await new OpenAICompatibleProvider({ baseUrl: fixture.url, model: 'a945-control', totalTimeoutMs: 20000 }).sendStreamRequest({ id: 'merge', messages }, () => {});
    assert.equal(merged.content, 'A945-CONTROL-OK');
    assert.deepEqual(fixture.requests.map((r) => r.status), [400, 200]);
  } finally { await fixture.close(); }
});

test('product runtime completes the strict-template turn with one leading system message', async (t) => {
  const { createA9AgentRuntime } = require(path.join(repo, 'src/shell/product/a9-agent-runtime.js'));
  const Database = require('better-sqlite3');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'win7-coding-agent-alpha4-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace 中文');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspaceRoot); fs.mkdirSync(dataRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# A945 project rules\n\n' + driver.AGENTS_MARKER + '\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'note.txt'), 'A945 note fixture\n', 'utf8');
  const fixture = await driver.startStrictFixture();
  const runtime = createA9AgentRuntime({ workspaceRoot, dataRoot, openDatabase: (p, o) => new Database(p, o && o.readonly ? { readonly: true } : {}) });
  try {
    runtime.setMode('read_only');
    await runtime.configureProvider({ baseUrl: fixture.url, model: 'a945-strict-template', apiKey: 'a945-fixture-key' });
    assert.ok(fixture.requests.some((r) => r.kind === 'probe' && r.status === 200));
    const turnStart = fixture.requests.length;
    assert.equal((await runtime.submitTurn('A945-PROMPT')).ok, true);
    const turns = fixture.requests.slice(turnStart).filter((r) => r.kind === 'turn');
    assert.ok(turns.some((r) => r.tool_messages === 0 && r.step === 'tool:read'));
    assert.ok(turns.some((r) => r.tool_messages >= 1 && r.step === 'text'));
    for (const r of turns) {
      assert.equal(r.status, 200);
      assert.equal(r.systems, 1);
      assert.equal(r.roles[0], 'system');
      assert.equal(r.environment_in_system, true);
      assert.equal(r.agents_in_system, true);
    }
    assert.equal(fixture.requests.filter((r) => r.status !== 200).length, 0);
  } finally {
    await runtime.shutdown();
    await fixture.close();
  }
});

test('alpha.4 Win7 local entry self-check generates bound materials and rejects unsafe scopes', () => {
  const result = selfCheck();
  assert.equal(result.result, 'PASS');
  assert.equal(result.temporary_directory_removed, true);
  assert.ok(result.checks.includes('NEW_WINDOW_BUDGET') && result.checks.includes('CAPACITY_SCOPE') && result.checks.includes('PACKAGE_MANIFEST'));
});
