import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THRESHOLDS, UsageError, auditSpecs, checkGates, compareReports, formatTable, loadToolSpecs, measureTool, parseArgs,
} from './audit_tool_tokens.mjs';
import { estimateTokens } from './lib/token_estimate.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const CLI = join(SCRIPT_DIR, 'audit_tool_tokens.mjs');
const DIST = join(REPO, 'src', 'core', 'dist');
const created = [];
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

const spec = (name, description, properties = {}, required = []) => ({
  schemaVersion: '2.0', name, description, approvalLevel: 'read_only', capability: 'workspace.read',
  inputSchema: { properties, required, additionalProperties: false },
});

// --- measurement ------------------------------------------------------------

test('measureTool computes every dimension against hand-derived numbers', () => {
  const tool = spec('demo', '读取文件。', {
    path: { type: 'string', description: '文件路径。' },
    mode: { type: 'string', description: 'abcd', enum: ['a', 'bb'] },
  }, ['path']);
  const m = measureTool(tool);
  const payload = JSON.stringify({ name: 'demo', description: '读取文件。', parameters: tool.inputSchema });
  assert.equal(m.name, 'demo');
  assert.equal(m.totalTokens, estimateTokens(payload));
  assert.equal(m.payloadChars, [...payload].length);
  assert.equal(m.descriptionChars, 5);
  assert.equal(m.descriptionTokens, 15); // 5 CJK chars x 3 bytes
  assert.equal(m.paramCount, 2);
  assert.equal(m.requiredCount, 1);
  assert.equal(m.propertyDescriptionChars, 9);
  assert.equal(m.propertyDescriptionTokens, 16); // '文件路径。' = 15, 'abcd' = 1
  assert.equal(m.enumValues, 2);
  assert.equal(m.enumTokens, estimateTokens('["a","bb"]'));
  assert.equal(m.schemaOverheadTokens, m.totalTokens - m.descriptionTokens - m.propertyDescriptionTokens - m.enumTokens);
  assert.deepEqual(m.flags, []);
});

test('flag thresholds: description > 150 chars, property text > 300 chars, tool > 400 tokens (strictly greater)', () => {
  const at = (chars) => spec('t', 'x'.repeat(chars));
  assert.deepEqual(measureTool(at(150)).flags, []);
  assert.deepEqual(measureTool(at(151)).flags, ['DESC_LONG']);
  const prop = (chars) => spec('t', 'd', { a: { type: 'string', description: '中'.repeat(chars) } });
  assert.ok(!measureTool(prop(300)).flags.includes('PARAMS_LONG'));
  assert.ok(measureTool(prop(301)).flags.includes('PARAMS_LONG'));
  assert.ok(measureTool(prop(301)).flags.includes('TOKENS_HIGH')); // 301*3 > 400 tokens
  const spread = spec('t', 'd', { a: { type: 'string', description: '中'.repeat(160) }, b: { type: 'string', description: '中'.repeat(141) } });
  assert.ok(measureTool(spread).flags.includes('PARAMS_LONG'), 'sums across properties');
});

test('flag thresholds are overridable', () => {
  const m = measureTool(spec('t', 'x'.repeat(40)), { ...DEFAULT_THRESHOLDS, descriptionChars: 30, toolTokens: 20 });
  assert.deepEqual(m.flags, ['DESC_LONG', 'TOKENS_HIGH']);
});

test('description length counts characters, not UTF-16 units or bytes', () => {
  assert.equal(measureTool(spec('t', '😀😀')).descriptionChars, 2);
  assert.equal(measureTool(spec('t', '中文')).descriptionChars, 2);
});

test('tools without parameters or enums are measured safely', () => {
  const m = measureTool({ name: 'bare', description: 'd', inputSchema: { properties: {}, required: [] } });
  assert.equal(m.paramCount, 0);
  assert.equal(m.enumTokens, 0);
  assert.equal(m.propertyDescriptionTokens, 0);
  const none = measureTool({ name: 'nothing', description: 'd' });
  assert.equal(none.paramCount, 0);
});

// --- aggregation ------------------------------------------------------------

test('auditSpecs ranks by total tokens descending, ties by name, and totals add up', () => {
  const report = auditSpecs([
    spec('b', 'x'), spec('big', '中'.repeat(160)), spec('a', 'x'), spec('mid', '中'.repeat(10)),
  ]);
  assert.deepEqual(report.tools.map((tool) => tool.name), ['big', 'mid', 'a', 'b']);
  const sum = (key) => report.tools.reduce((acc, tool) => acc + tool[key], 0);
  assert.equal(report.totals.toolCount, 4);
  assert.equal(report.totals.totalTokens, sum('totalTokens'));
  assert.equal(report.totals.descriptionTokens, sum('descriptionTokens'));
  assert.equal(report.totals.paramCount, sum('paramCount'));
  assert.equal(report.totals.flaggedCount, report.tools.filter((tool) => tool.flags.length).length);
  assert.equal(report.totals.flaggedCount, 1);
  assert.deepEqual(report.thresholds, DEFAULT_THRESHOLDS);
});

// --- table, baseline, gates -------------------------------------------------

test('formatTable aligns columns, lists flags and summarises totals', () => {
  const report = auditSpecs([spec('short', 'x'), spec('a_much_longer_tool_name', '中'.repeat(160), { p: { type: 'string', description: '说明' } })]);
  const lines = formatTable(report).split('\n');
  const header = lines[0];
  const rule = lines[1];
  assert.match(header, /^ *# +tool +total +desc +params +prop-desc +enum +schema +flags$/);
  assert.match(rule, /^-+( +-+)+$/);
  const rows = lines.slice(2, 4);
  assert.match(rows[0], /^ *1 +a_much_longer_tool_name /);
  assert.match(rows[0], /DESC_LONG/);
  assert.match(rows[1], /^ *2 +short /);
  // right-aligned numeric columns end at the same offsets in every row
  const totalEnd = (line) => line.search(/\d\s+\d+\/\d+c/) + 1;
  assert.equal(totalEnd(rows[0]), totalEnd(rows[1]));
  assert.match(lines.join('\n'), /tools=2 +total=\d+ +description=\d+/);
});

test('compareReports reports totals, per-tool deltas, added and removed tools', () => {
  const before = auditSpecs([spec('keep', '中'.repeat(50)), spec('gone', 'x'), spec('same', 'y')]);
  const after = auditSpecs([spec('keep', '中'.repeat(20)), spec('same', 'y'), spec('fresh', 'z')]);
  const diff = compareReports(after, before);
  assert.equal(diff.totalBefore, before.totals.totalTokens);
  assert.equal(diff.totalAfter, after.totals.totalTokens);
  assert.equal(diff.delta, diff.totalAfter - diff.totalBefore);
  assert.equal(diff.percent, Number(((diff.delta / diff.totalBefore) * 100).toFixed(2)));
  const byName = Object.fromEntries(diff.changed.map((row) => [row.name, row]));
  assert.ok(byName.keep.delta < 0);
  assert.equal(byName.gone.after, null);
  assert.equal(byName.fresh.before, null);
  assert.ok(!('same' in byName));
  assert.equal(diff.changed[0].name, 'keep', 'largest reduction first');
});

test('checkGates fails on total and per-tool ceilings only when exceeded', () => {
  const report = auditSpecs([spec('x', '中'.repeat(100))]);
  assert.deepEqual(checkGates(report, {}), []);
  assert.deepEqual(checkGates(report, { maxTotal: report.totals.totalTokens, maxTool: report.tools[0].totalTokens }), []);
  assert.equal(checkGates(report, { maxTotal: report.totals.totalTokens - 1 }).length, 1);
  assert.match(checkGates(report, { maxTool: 1 })[0], /x \d+ tokens exceeds --max-tool 1/);
});

// --- args -------------------------------------------------------------------

test('parseArgs handles flags, inline values and rejects bad input', () => {
  const o = parseArgs(['--json', '--mode=review', '--no-office', '--no-images', '--desc-chars', '100', '--param-chars=200', '--tool-tokens', '300', '--max-total', '9000', '--max-tool', '500', '--baseline', 'b.json', '--dist', 'd']);
  assert.equal(o.json, true);
  assert.equal(o.mode, 'review');
  assert.equal(o.office, false);
  assert.equal(o.images, false);
  assert.deepEqual(o.thresholds, { descriptionChars: 100, paramDescriptionChars: 200, toolTokens: 300 });
  assert.equal(o.maxTotal, 9000);
  assert.equal(o.maxTool, 500);
  assert.equal(parseArgs([]).mode, 'full');
  assert.throws(() => parseArgs(['--mode', 'x']), UsageError);
  assert.throws(() => parseArgs(['--desc-chars', '0']), UsageError);
  assert.throws(() => parseArgs(['--max-total', 'abc']), UsageError);
  assert.throws(() => parseArgs(['--baseline']), /requires a value/);
  assert.throws(() => parseArgs(['--what']), /unknown option/);
});

// --- real catalog -----------------------------------------------------------

const built = existsSync(join(DIST, 'a9-tools.js')) && existsSync(join(DIST, 'a9-office-tools.js'));
if (built) {
  const core = createRequire(import.meta.url)(join(DIST, 'a9-tools.js'));

  test('loadToolSpecs reproduces the surface A9AgentLoop registers (full / read-only / without office)', () => {
    const full = loadToolSpecs({ distDir: DIST });
    const names = full.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
    for (const required of ['read', 'ask_user', 'document_write_copy', 'shell', 'read_image', 'office_workflow_help', 'batch_organize']) assert.ok(names.includes(required), required);
    const readOnly = loadToolSpecs({ distDir: DIST, mode: 'read-only' }).map((tool) => tool.name);
    assert.ok(!readOnly.includes('shell') && !readOnly.includes('write') && !readOnly.includes('batch_organize'));
    assert.ok(readOnly.includes('office_workflow_help'));
    const lean = loadToolSpecs({ distDir: DIST, office: false, images: false }).map((tool) => tool.name);
    assert.ok(!lean.includes('document_read') && !lean.includes('office_workflow_help') && !lean.includes('read_image'));
    assert.deepEqual(lean, core.a9ToolSpecs('full_access', { images: false, office: false }).map((tool) => tool.name));
  });

  test('real catalog audit is internally consistent and ranked', () => {
    const report = auditSpecs(loadToolSpecs({ distDir: DIST }));
    assert.ok(report.totals.toolCount >= 14);
    for (let i = 1; i < report.tools.length; i += 1) assert.ok(report.tools[i - 1].totalTokens >= report.tools[i].totalTokens);
    for (const tool of report.tools) {
      assert.ok(tool.totalTokens > 0 && tool.schemaOverheadTokens >= 0, tool.name);
      assert.ok(tool.descriptionTokens + tool.propertyDescriptionTokens + tool.enumTokens <= tool.totalTokens + 8, tool.name);
    }
    const read = report.tools.find((tool) => tool.name === 'read');
    assert.equal(read.paramCount, 4);
    assert.equal(read.enumValues, 4);
  });

  test('slimmed tools keep the assertions the core tests rely on', () => {
    const read = core.a9ToolSpecs('full_access').find((tool) => tool.name === 'read').inputSchema.properties;
    assert.ok(read.encoding.description.includes('省略则自动探测'));
    assert.ok(read.startLine.description.includes('正整数'));
    assert.ok(read.maxLines.description.includes('正整数'));
    const ask = core.a9ToolSpecs('full_access').find((tool) => tool.name === 'ask_user');
    assert.ok(ask.description.includes('不批准'));
    assert.ok(ask.inputSchema.properties.options.description.includes('自由填写'));
    const write = loadToolSpecs({ distDir: DIST }).find((tool) => tool.name === 'document_write_copy');
    for (const keyword of ['docx', 'xlsx', 'schemaVersion:1', 'sourcePath', 'sha256', '拒绝覆盖', 'heading', 'paragraph', 'table', '字符串', '"17"']) assert.ok(write.description.includes(keyword), keyword);
  });
}

// --- CLI --------------------------------------------------------------------

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: REPO });
}

if (built) {
  test('CLI: table output is sorted descending and exit 0', () => {
    const run = cli([]);
    assert.equal(run.status, 0, run.stderr);
    const totals = run.stdout.split('\n').slice(2).map((line) => line.match(/^\s*\d+\s+\S+\s+(\d+)\s/)).filter(Boolean).map((match) => Number(match[1]));
    assert.ok(totals.length >= 14);
    assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
  });

  test('CLI: --json is parseable and carries totals, thresholds and per-tool fields', () => {
    const run = cli(['--json']);
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(run.stdout);
    assert.equal(data.totals.toolCount, data.tools.length);
    assert.equal(data.thresholds.descriptionChars, 150);
    assert.deepEqual(Object.keys(data.tools[0]).sort(), ['descriptionChars', 'descriptionTokens', 'enumTokens', 'enumValues', 'flags', 'name', 'paramCount', 'payloadChars', 'propertyDescriptionChars', 'propertyDescriptionTokens', 'requiredCount', 'schemaOverheadTokens', 'totalTokens']);
  });

  test('CLI: --baseline prints deltas; --max-total gate exits 1; usage error exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-tokens-'));
    created.push(dir);
    const base = JSON.parse(cli(['--json']).stdout);
    base.totals.totalTokens += 500;
    base.tools[0].totalTokens += 500;
    const file = join(dir, 'base.json');
    writeFileSync(file, JSON.stringify(base), 'utf8');
    const diff = cli(['--baseline', file]);
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(diff.stdout, /baseline: \d+ -> \d+ tokens \(-500, /);
    const gate = cli(['--max-total', '10']);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /GATE FAIL: total \d+ tokens exceeds --max-total 10/);
    assert.equal(cli(['--mode', 'bogus']).status, 2);
    assert.equal(cli(['--dist', join(dir, 'nope')]).status, 2);
    writeFileSync(file, 'not json', 'utf8');
    assert.equal(cli(['--baseline', file]).status, 2);
    assert.equal(cli(['--baseline', join(dir, 'absent.json')]).status, 2);
  });

  test('CLI: --output writes the same text that is printed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-tokens-'));
    created.push(dir);
    const file = join(dir, 'report.json');
    const run = cli(['--json', '--output', file]);
    assert.equal(readFileSync(file, 'utf8'), run.stdout);
  });
}

for (const dir of created) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  for (const { name, error } of failures) console.error(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`);
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`audit_tool_tokens: ${passed} tests passed${built ? '' : ' (dist not built: catalog tests skipped)'}`);
