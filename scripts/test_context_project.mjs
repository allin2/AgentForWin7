import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BUDGET, TRUNCATION_NOTICE, UsageError, compactText, implicitConcepts, mergeNumberedLists,
  parseArgs, parseSections, parseUnits, projectContext, resolveTask, scoreText, splitKeywords, buildTerms,
} from './context_project.mjs';
import { estimateTokens } from './lib/token_estimate.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const CLI = join(SCRIPT_DIR, 'context_project.mjs');
const created = [];
let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed += 1; } catch (error) { failures.push({ name, error }); }
}

function write(root, relative, content) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

const POISON = 'POISON_DECISIONS_BODY';
const AGENTS_FIXTURE = `# AGENTS.md

## 1. 项目定义与文档优先级

项目是在 Windows 7 SP1 x64 上运行的 Agent。

冲突优先级：

1. \`AGENTS.md\`
2. \`docs/WIN7_CONSTRAINTS.md\`
3. 当前任务书

## 2. 当前阶段与历史入口

- HISTORY_ONLY_MARKER 历史任务不重新开放。

## 4. 实现授权与行为边界

- **授权边界：** 范围内连续完成实现。

## 5. 安全与兼容性红线

- **Win7 SP1 x64 是硬门槛。** 开发机通过不等于 Win7 通过。
- 路径必须兼容中文、空格、盘符和反斜杠。
- 进程必须有输出控制、用户取消和进程树清理。

## 7. Auto Review 与工具成本控制

- COST_ONLY_MARKER 限制工具输出。
`;

const WIN7_FIXTURE = `# WIN7_CONSTRAINTS

## 5. 强制编码与路径规则

1. 文本 I/O 都必须显式声明编码；GBK 与 UTF-8 不得混用。
2. 路径使用路径 API。

## 7. 已知兼容性陷阱

| # | 陷阱 | 规避 |
|---|------|------|
| P01 | 超时 kill 只结束直接子进程，孙进程残留 | 验证整棵进程树 |
| P04 | CP936 conhost 无法表示 Unicode | 控制台适配器显式转码 GBK |

## 9. 候选 Profile 的上游依据

- UPSTREAM_ONLY_MARKER 与本主题无关的上游说明。
`;

const ADR_FIXTURE = `# ADR 索引

| ADR | 标题 | 状态 |
|---|---|---|
| ADR-0001 | 平台冻结 | Superseded by ADR-0027 |
| ADR-0050 | GBK 编码转码策略 | Accepted |
| ADR-0051 | 进程树清理 | Accepted |
| ADR-0060 | 无关主题 | Accepted |
`;

const TASK_FIXTURE = `# T9_01 — 示例任务

\`\`\`text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: EXECUTION_CAPABILITY
Phase-Gate: T9_01_GATE
\`\`\`

## 1. 授权与交付结果

| 交付项 | 结果 |
|---|---|
| 编码修复 | GBK 文件读取不乱码 |

## 2. 行为与兼容性边界

- 不得改动 ADR-0050 已定的转码策略。
- 普通说明文字。

## 4. 执行记录

- 执行记录必须保留 RECORD_ONLY_MARKER。
`;

function fixture({ agents = AGENTS_FIXTURE, win7 = WIN7_FIXTURE, adr = ADR_FIXTURE, tasks = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-project-'));
  created.push(root);
  if (agents !== null) write(root, 'AGENTS.md', agents);
  if (win7 !== null) write(root, 'docs/WIN7_CONSTRAINTS.md', win7);
  if (adr !== null) write(root, 'docs/DECISIONS_INDEX.md', adr);
  write(root, 'docs/DECISIONS.md', `# Decisions\n${POISON}\n`);
  if (tasks) {
    write(root, 'docs/tasks/T9_01_SAMPLE_TASK.md', TASK_FIXTURE);
    write(root, 'docs/tasks/T9_02_OTHER.md', '# T9_02\n');
    write(root, 'docs/tasks/T9_10_TEN.md', '# T9_10\n');
  }
  return root;
}

// --- argument parsing -------------------------------------------------------

test('parseArgs reads every flag, supports --flag=value, applies defaults', () => {
  const options = parseArgs(['--task', 'A9_42', '--module=office', '--topic', 'gbk,unc-path', '--budget', '1500', '--json', '--output', 'out.md', '--root', '/x']);
  assert.deepEqual(
    { task: options.task, module: options.module, topic: options.topic, budget: options.budget, json: options.json, output: options.output, root: options.root },
    { task: 'A9_42', module: 'office', topic: 'gbk,unc-path', budget: 1500, json: true, output: 'out.md', root: '/x' },
  );
  const defaults = parseArgs([]);
  assert.equal(defaults.budget, DEFAULT_BUDGET);
  assert.equal(defaults.budget, 2000);
  assert.equal(defaults.json, false);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects unknown flags, missing values and bad budgets', () => {
  assert.throws(() => parseArgs(['--bogus']), UsageError);
  assert.throws(() => parseArgs(['--task']), /requires a value/);
  assert.throws(() => parseArgs(['--task', '--json']), /requires a value/);
  assert.throws(() => parseArgs(['--budget', 'abc']), /positive integer/);
  assert.throws(() => parseArgs(['--budget', '-5']), UsageError);
  assert.throws(() => parseArgs(['--budget', '12.5']), UsageError);
  assert.throws(() => parseArgs(['--budget', '50']), /at least/);
});

test('splitKeywords normalises separators, case and duplicates', () => {
  assert.deepEqual(splitKeywords('GBK, process；PowerShell  gbk、unc-path'), ['gbk', 'process', 'powershell', 'unc-path']);
  assert.deepEqual(splitKeywords(undefined), []);
});

// --- token estimator --------------------------------------------------------

test('estimateTokens follows the conservative UTF-8 rule', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('中'), 3);
  assert.equal(estimateTokens('中文ab'), 7); // 6 bytes + ceil(2/4)
  assert.equal(estimateTokens(''), 1);
  assert.equal(estimateTokens('😀'), 4);
});

test('estimateTokens matches src/core token-estimator when dist is built', () => {
  const dist = join(REPO, 'src', 'core', 'dist', 'token-estimator.js');
  if (!existsSync(dist)) return;
  const core = createRequire(import.meta.url)(dist);
  for (const sample of ['', 'hello world', '中文规则 mixed ASCII 12345', 'Windows 7 路径 C:\\用户\\文档', '😀🎉 emoji', 'a'.repeat(1001)]) {
    assert.equal(estimateTokens(sample), core.estimateContextTokens(sample).tokens, JSON.stringify(sample));
  }
});

// --- markdown slicing -------------------------------------------------------

test('parseSections ignores headings inside fenced code', () => {
  const sections = parseSections('# T\n\n```md\n## fake\n```\n\n## real\nbody');
  assert.deepEqual(sections.map((section) => section.heading), ['', 'T', 'real']);
});

test('parseUnits yields rows with header, items with bold lead, paragraphs; skips code and separators', () => {
  const units = parseUnits([
    '| A | B |', '|---|---|', '| 1 | 2 |', '', '- **要点。** 展开说明', '  续行', '', '正文一', '正文二', '', '```', '- code item', '```',
  ]);
  assert.deepEqual(units.map((unit) => unit.kind), ['row', 'item', 'para']);
  assert.equal(units[0].header, '| A | B |');
  assert.equal(units[1].lead, '要点。');
  assert.match(units[1].text, /续行/);
  assert.ok(!units.some((unit) => unit.text.includes('code item')));
});

test('compactText keeps the bold lead, first sentence and clips long clauses', () => {
  assert.equal(compactText('- **硬门槛。** 很长的展开', 'item', '硬门槛。'), '- 硬门槛。');
  assert.equal(compactText('- 第一句（括号被删除）。第二句不要。', 'item'), '- 第一句。');
  const long = compactText(`- ${'甲'.repeat(30)}，${'乙'.repeat(60)}`, 'item');
  assert.ok(long.endsWith('…') && [...long].length <= 70, long);
  assert.match(compactText('| P1 | 说明。第二句 | 规避 |', 'row'), /^\| P1 \| 说明。 \| 规避 \|$/);
});

test('mergeNumberedLists folds a numbered priority list into one ordered line', () => {
  const merged = mergeNumberedLists(parseUnits(['冲突优先级：', '', '1. `AGENTS.md`', '2. `docs/X.md`（说明）']));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].compactOverride, '冲突优先级：AGENTS.md > docs/X.md');
});

test('scoreText weighs terms and saturates repeated hits', () => {
  const { terms } = buildTerms({ topics: ['gbk'] });
  const once = scoreText('GBK 编码', terms);
  const many = scoreText('gbk gbk gbk gbk gbk gbk', terms);
  assert.ok(once.score > 0 && once.hit.includes('gbk'));
  assert.ok(many.score <= 2 * 3 + 20, 'saturation keeps one term bounded');
  assert.equal(scoreText('完全无关', terms).score, 0);
});

test('buildTerms expands module and topic concepts; implicitConcepts reads task text', () => {
  const { terms } = buildTerms({ topics: ['unc-path'], moduleName: 'shell' });
  for (const term of ['unc', 'path', 'junction', 'powershell', 'cp936']) assert.ok(terms.has(term), term);
  assert.equal(terms.get('unc-path').weight, 2);
  assert.deepEqual(implicitConcepts('进程 taskkill 进程树 kill 取消'), ['process']);
  assert.deepEqual(implicitConcepts('nothing relevant'), []);
});

// --- task resolution --------------------------------------------------------

test('resolveTask finds a task by code, hyphenated code, glob and direct path without prefix collisions', () => {
  const root = fixture();
  const expect = (spec, name) => assert.equal(resolveTask(spec, root).file && resolveTask(spec, root).file.split(/[\\/]/).pop(), name, spec);
  expect('T9_01', 'T9_01_SAMPLE_TASK.md');
  expect('t9-01', 'T9_01_SAMPLE_TASK.md');
  expect('docs/tasks/T9_01_*.md', 'T9_01_SAMPLE_TASK.md');
  expect('T9_01_SAMPLE_TASK.md', 'T9_01_SAMPLE_TASK.md');
  expect('docs/tasks/T9_02_OTHER.md', 'T9_02_OTHER.md');
  expect('T9_1', null); // T9_1 must not match T9_10 or T9_01
  const missing = resolveTask('NOPE_99', root);
  assert.equal(missing.file, null);
  assert.match(missing.warnings[0], /task not found/);
});

// --- projection -------------------------------------------------------------

test('projectContext slices AGENTS §1/§4/§5 only and never reads DECISIONS.md', () => {
  const root = fixture();
  const { text, result } = projectContext({ root, task: 'T9_01', topic: 'gbk', budget: 2000 });
  assert.match(text, /^<projected_context task="T9_01" topic="gbk" budget="2000">\n/);
  assert.ok(text.trimEnd().endsWith('</projected_context>'));
  assert.match(text, /Win7 SP1 x64 是硬门槛/);
  assert.match(text, /冲突优先级/);
  assert.match(text, /授权边界/);
  for (const marker of ['HISTORY_ONLY_MARKER', 'COST_ONLY_MARKER', POISON]) assert.ok(!text.includes(marker), marker);
  assert.ok(result.slices.every((slice) => !slice.text.includes(POISON)));
});

test('projectContext picks the highest-scoring WIN7 sections and drops unrelated ones', () => {
  const root = fixture();
  const { text, result } = projectContext({ root, topic: 'gbk', budget: 2000 });
  assert.match(text, /GBK 与 UTF-8/);
  assert.match(text, /P04/);
  assert.ok(!text.includes('UPSTREAM_ONLY_MARKER'));
  assert.ok(result.win7Sections.length >= 1 && result.win7Sections.length <= 3);
  assert.ok(result.slices.filter((slice) => slice.source === 'win7' && slice.included).every((slice) => slice.matched.length > 1));
});

test('projectContext lists ADR numbers/titles by topic, penalises Superseded, includes task-linked ADRs', () => {
  const root = fixture();
  const { text } = projectContext({ root, task: 'T9_01', topic: 'gbk', budget: 2000 });
  assert.match(text, /ADR-0050 GBK 编码转码策略/);
  assert.ok(!text.includes('ADR-0060'));
  assert.ok(!text.includes('ADR-0001'));
  const process = projectContext({ root, topic: 'process', budget: 2000 }).text;
  assert.match(process, /ADR-0051 进程树清理/);
});

test('projectContext extracts task goal, metadata and red lines but skips execution records', () => {
  const root = fixture();
  const { text } = projectContext({ root, task: 'T9_01', budget: 2000 });
  assert.match(text, /任务书：T9_01/);
  assert.match(text, /Status: APPROVED_FOR_IMPLEMENTATION/);
  assert.match(text, /GBK 文件读取不乱码/);
  assert.match(text, /不得改动 ADR-0050/);
  assert.ok(!text.includes('RECORD_ONLY_MARKER'));
});

test('without keywords the task text implies concepts (implicit terms are reported)', () => {
  const root = fixture();
  const { result } = projectContext({ root, task: 'T9_01', budget: 2000 });
  assert.ok(result.implicitConcepts.includes('encoding'), JSON.stringify(result.implicitConcepts));
});

// --- budget & truncation ----------------------------------------------------

test('small budgets truncate gracefully: ceiling holds, red line kept, notice appended', () => {
  const root = fixture();
  for (const budget of [100, 150, 250, 400]) {
    const { text, result } = projectContext({ root, task: 'T9_01', topic: 'gbk', budget });
    assert.ok(estimateTokens(text) <= budget, `budget ${budget}: ${estimateTokens(text)}`);
    assert.equal(result.tokens, estimateTokens(text));
    assert.ok(result.truncated, `budget ${budget}`);
    assert.ok(text.includes(TRUNCATION_NOTICE));
    assert.ok(text.trimEnd().endsWith('</projected_context>'));
    assert.ok(text.indexOf(TRUNCATION_NOTICE) < text.lastIndexOf('</projected_context>'));
  }
  const tight = projectContext({ root, task: 'T9_01', topic: 'gbk', budget: 250 }).text;
  assert.match(tight, /硬门槛/, 'highest-priority red line survives');
  assert.ok(!tight.includes('ADR-0050'), 'low-priority ADR list is dropped first');
});

test('a large budget keeps everything and appends no truncation notice', () => {
  const root = fixture();
  const { text, result } = projectContext({ root, task: 'T9_01', topic: 'gbk', budget: 50000 });
  assert.equal(result.truncated, false);
  assert.ok(!text.includes(TRUNCATION_NOTICE));
});

test('output never exceeds the budget across many budget/keyword combinations (real docs)', () => {
  if (!existsSync(join(REPO, 'AGENTS.md')) || !existsSync(join(REPO, 'docs', 'WIN7_CONSTRAINTS.md'))) return;
  for (const budget of [120, 300, 800, 1200, 2000, 3500]) {
    for (const args of [{ topic: 'gbk' }, { module: 'shell', topic: 'powershell' }, { task: 'A9_42' }, { task: 'A9_70', module: 'runner', topic: 'process' }]) {
      const { text } = projectContext({ root: REPO, budget, ...args });
      assert.ok(estimateTokens(text) <= budget, `${JSON.stringify(args)} @${budget}: ${estimateTokens(text)}`);
    }
  }
});

// --- tolerance --------------------------------------------------------------

test('missing docs and unknown task/module degrade to warnings, never throw', () => {
  const root = fixture({ agents: null, win7: null, adr: null, tasks: false });
  const { text, result } = projectContext({ root, task: 'A9_42', module: 'nonsense', topic: 'x', budget: 500 });
  assert.match(text, /^<projected_context /);
  assert.ok(result.warnings.some((warning) => /AGENTS\.md not found/.test(warning)));
  assert.ok(result.warnings.some((warning) => /WIN7_CONSTRAINTS/.test(warning)));
  assert.ok(result.warnings.some((warning) => /DECISIONS_INDEX/.test(warning)));
  assert.ok(result.warnings.some((warning) => /unknown module/.test(warning)));
  assert.ok(result.warnings.some((warning) => /task/.test(warning)));
  assert.ok(estimateTokens(text) <= 500);
});

test('CRLF and BOM documents are parsed the same as LF', () => {
  const lf = fixture();
  const crlf = fixture({ agents: `\uFEFF${AGENTS_FIXTURE.replace(/\n/g, '\r\n')}`, win7: WIN7_FIXTURE.replace(/\n/g, '\r\n'), adr: ADR_FIXTURE.replace(/\n/g, '\r\n') });
  const clean = (text) => text.replace(/ctx-project-\w+/g, '');
  assert.equal(clean(projectContext({ root: lf, topic: 'gbk' }).text), clean(projectContext({ root: crlf, topic: 'gbk' }).text));
});

test('attribute values in the container are escaped', () => {
  const root = fixture();
  const { text } = projectContext({ root, task: 'a"<b>', budget: 1000 });
  assert.match(text, /task="a&quot;&lt;b&gt;"/);
});

// --- CLI --------------------------------------------------------------------

function cli(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, cwd: REPO });
}

test('CLI: default Markdown container, exit 0', () => {
  const root = fixture();
  const run = cli(['--root', root, '--task', 'T9_01', '--topic', 'gbk']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^<projected_context task="T9_01"/);
});

test('CLI: --json emits slice details with chars, tokens and match reasons', () => {
  const root = fixture();
  const run = cli(['--root', root, '--task', 'T9_01', '--topic', 'gbk', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.budget, 2000);
  assert.equal(data.tokenEstimator, 'conservative_utf8');
  assert.ok(data.tokens <= data.budget);
  assert.ok(Array.isArray(data.slices) && data.slices.length > 0);
  const included = data.slices.filter((slice) => slice.included);
  for (const slice of included) {
    assert.equal(typeof slice.chars, 'number');
    assert.equal(slice.tokens, estimateTokens(slice.text));
    assert.ok(Array.isArray(slice.matched) && slice.matched.length > 0);
  }
  assert.deepEqual(Object.keys(data.sources).sort(), ['adr', 'agents', 'task', 'win7']);
});

test('CLI: --output writes UTF-8 without BOM and LF only', () => {
  const root = fixture();
  const target = join(root, 'out', 'ctx.md');
  mkdirSync(dirname(target), { recursive: true });
  const run = cli(['--root', root, '--topic', 'gbk', '--output', target]);
  assert.equal(run.status, 0, run.stderr);
  const bytes = readFileSync(target);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(!bytes.includes(0x0d));
  assert.match(bytes.toString('utf8'), /^<projected_context /);
  assert.match(run.stdout, /wrote .*tokens/);
});

test('CLI: usage errors exit 2, unwritable --output exits 2, --help exits 0', () => {
  assert.equal(cli(['--nope']).status, 2);
  assert.equal(cli(['--budget', 'x']).status, 2);
  const root = fixture();
  const bad = cli(['--root', root, '--output', join(root, 'missing-dir', 'a.md')]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /cannot write --output/);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--budget/);
});

test('CLI: custom --budget is honoured', () => {
  const root = fixture();
  const run = cli(['--root', root, '--task', 'T9_01', '--topic', 'gbk', '--budget', '300', '--json']);
  const data = JSON.parse(run.stdout);
  assert.equal(data.budget, 300);
  assert.ok(data.tokens <= 300);
  assert.equal(data.truncated, true);
});

// --- real repository --------------------------------------------------------

const realDocs = existsSync(join(REPO, 'AGENTS.md')) && existsSync(join(REPO, 'docs', 'WIN7_CONSTRAINTS.md')) && existsSync(join(REPO, 'docs', 'DECISIONS_INDEX.md'));
if (realDocs) {
  test('typical real tasks project to <= 2000 tokens with all four sources', () => {
    for (const args of [['--task', 'A9_42', '--module', 'office', '--topic', 'gbk,unc-path'], ['--task', 'A9_70', '--module', 'runner', '--topic', 'process'], ['--module', 'shell', '--topic', 'powershell']]) {
      const run = cli([...args, '--json']);
      assert.equal(run.status, 0, run.stderr);
      const data = JSON.parse(run.stdout);
      assert.ok(data.tokens <= 2000, `${args.join(' ')}: ${data.tokens}`);
      assert.ok(data.tokens >= 800, `${args.join(' ')} should use a meaningful share of the budget: ${data.tokens}`);
      for (const source of ['agents', 'win7']) assert.ok(data.sources[source].included > 0, `${source} for ${args.join(' ')}`);
    }
  });

  test('real run keeps the Win7 hard gate and omits AGENTS §2/§3/§6-§8 history', () => {
    const run = cli(['--task', 'A9_42', '--topic', 'gbk']);
    assert.match(run.stdout, /Win7 SP1 x64 是硬门槛/);
    assert.ok(!run.stdout.includes('历史里程碑'));
    assert.ok(!run.stdout.includes('Alpha 阶段以产品迭代为先'));
  });

  test('real run preserves AGENTS §1 priority list and stop rule under default budget', () => {
    const run = cli(['--task', 'A9_42', '--module', 'office', '--topic', 'gbk,unc-path', '--budget', '2000']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /冲突优先级/);
    assert.match(run.stdout, /停止相关实现/);
  });

  test('step scan: output never exceeds budget across step scan of budgets (120 to 2500 by step 37)', () => {
    for (let budget = 120; budget <= 2500; budget += 37) {
      for (const args of [{ topic: 'gbk' }, { task: 'A9_42', module: 'office', topic: 'gbk,unc-path' }]) {
        const { text } = projectContext({ root: REPO, budget, ...args });
        assert.ok(estimateTokens(text) <= budget, `${JSON.stringify(args)} @${budget}: ${estimateTokens(text)}`);
      }
    }
  });
}

test('script source never opens DECISIONS.md itself (only DECISIONS_INDEX.md)', () => {
  const source = readFileSync(CLI, 'utf8');
  assert.ok(!/['"`/]DECISIONS\.md['"`]/.test(source.replace(/docs\/DECISIONS\.md（|正文见 docs\/DECISIONS\.md/g, '')));
  assert.ok(source.includes('DECISIONS_INDEX.md'));
});

test('resolveTask rejects DECISIONS.md and STATUS_LOG.md by policy', () => {
  for (const name of ['DECISIONS.md', 'docs/DECISIONS.md', 'STATUS_LOG.md', 'docs/STATUS_LOG.md']) {
    const { file, warnings } = resolveTask(name, REPO);
    assert.equal(file, null, `should reject ${name}`);
    assert.ok(warnings.some((w) => /rejected by policy/.test(w)), `expected warning for ${name}`);
  }
});

for (const dir of created) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  for (const { name, error } of failures) console.error(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`);
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`context_project: ${passed} tests passed`);
