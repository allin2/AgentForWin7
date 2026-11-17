#!/usr/bin/env node
// Context projection harness (harness action 2).
//
// Projects the few rules a task actually needs out of the authority documents
// into a small, budgeted Markdown container, instead of loading AGENTS.md,
// WIN7_CONSTRAINTS.md (90 KB) or DECISIONS.md (700 KB) in full.
//
//   node scripts/context_project.mjs --task A9_42 --module office --topic gbk,unc-path
//        [--budget 2000] [--json] [--output <file>] [--root <repo>]
//
// Slices (never DECISIONS.md itself, only docs/DECISIONS_INDEX.md):
//   * task book        goal + acceptance red lines (docs/tasks/<task>*.md)
//   * AGENTS.md        §1 priority, §4 authorization, §5 Win7 red lines
//   * WIN7_CONSTRAINTS highest-scoring sections for the keywords
//   * DECISIONS_INDEX  ADR numbers and titles matching the keywords
// Token estimates use the conservative UTF-8 rule of src/core/src/token-estimator.ts.
//
// Exit codes: 0 ok (warnings allowed), 2 usage error / unwritable output.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { estimateTokens } from './lib/token_estimate.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_BUDGET = 2000;
export const MIN_BUDGET = 100;
export const TRUNCATION_NOTICE = '[其余次要规则已按 Token 预算截断]';

const USAGE = `Usage: node scripts/context_project.mjs [options]
  --task <file|name>     task book path or code (A9_42, A9-42, docs/tasks/A9_42_*.md)
  --module <name>        core | runner | office | shell | state | gateway | git-adapter | workspace
  --topic <keywords>     comma/space separated keywords (gbk, process, powershell, unc-path, ...)
  --budget <tokens>      token ceiling for the whole output (default ${DEFAULT_BUDGET}, min ${MIN_BUDGET})
  --json                 print structured slice details instead of Markdown
  --output <file>        write the result to a file (UTF-8, no BOM, LF)
  --root <dir>           repository root (default: parent of scripts/)
  -h, --help             show this help`;

export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { task: undefined, module: undefined, topic: undefined, budget: DEFAULT_BUDGET, json: false, output: undefined, root: undefined, help: false };
  const valueFlags = new Set(['--task', '--module', '--topic', '--budget', '--output', '--root']);
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let inline;
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (equals > 0) { inline = arg.slice(equals + 1); arg = arg.slice(0, equals); }
    if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (valueFlags.has(arg)) {
      const value = inline !== undefined ? inline : argv[++index];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) {
        throw new UsageError(`${arg} requires a value`);
      }
      if (arg === '--budget') {
        if (!/^\d+$/.test(value)) throw new UsageError(`--budget requires a positive integer, got "${value}"`);
        const budget = Number(value);
        if (budget < MIN_BUDGET) throw new UsageError(`--budget must be at least ${MIN_BUDGET} tokens, got ${budget}`);
        options.budget = budget;
      } else options[arg.slice(2)] = value;
    } else throw new UsageError(`unknown option: ${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Keyword model
// ---------------------------------------------------------------------------

/** Concept expansion: what a keyword means in the Chinese constraint docs. */
const CONCEPTS = {
  encoding: ['编码', 'gbk', 'cp936', 'utf-8', 'utf-16', 'bom', '代码页', 'code page', '转码', 'oem', 'ansi'],
  process: ['进程', 'process', 'taskkill', 'job object', '进程树', 'kill', '孙进程', '取消', 'stdin'],
  powershell: ['powershell', 'encodedcommand', '$lastexitcode', 'wmf', '-noprofile'],
  shell: ['shell', 'cmd.exe', 'powershell', 'trustedshell', 'conhost', '终端'],
  path: ['路径', 'unc', 'max_path', '260', '盘符', '反斜杠', 'junction', 'reparse', '符号链接', '中文'],
  network: ['tls', '证书', 'schannel', '代理', '网络', 'winhttp'],
  git: ['git', 'hooks', 'mingit', 'worktree', 'gitattributes'],
  storage: ['sqlite', '持久化', '状态库', 'checkpoint', '版本化', '审计'],
  approval: ['批准', '授权', '审批', 'policy', 'full access', '确认'],
  office: ['office', 'docx', 'xlsx', 'pptx', 'zip', '附件', '模板', '邮件'],
};

/** keyword → concept. Keys are matched after lower-casing and splitting on [-_/]. */
const KEYWORD_CONCEPT = {
  gbk: 'encoding', cp936: 'encoding', encoding: 'encoding', utf8: 'encoding', 'utf-8': 'encoding', bom: 'encoding', 编码: 'encoding', 乱码: 'encoding',
  process: 'process', 进程: 'process', taskkill: 'process', kill: 'process', job: 'process', stdin: 'process', cancel: 'process', 取消: 'process', runner: 'process',
  powershell: 'powershell', ps: 'powershell', encodedcommand: 'powershell',
  shell: 'shell', cmd: 'shell', terminal: 'shell', 终端: 'shell',
  unc: 'path', path: 'path', 'unc-path': 'path', 路径: 'path', junction: 'path', reparse: 'path', max_path: 'path',
  tls: 'network', network: 'network', proxy: 'network', 代理: 'network', 证书: 'network', 网络: 'network',
  git: 'git', hooks: 'git', worktree: 'git',
  sqlite: 'storage', state: 'storage', checkpoint: 'storage', 状态: 'storage', 持久化: 'storage', audit: 'storage', 审计: 'storage',
  approval: 'approval', policy: 'approval', 批准: 'approval', 授权: 'approval', 审批: 'approval',
  office: 'office', docx: 'office', xlsx: 'office', pptx: 'office', zip: 'office', mail: 'office',
};

export const MODULE_PROFILES = {
  core: { concepts: ['approval', 'storage', 'process'], note: 'Agent Core：Policy、批准、审计、Schema IPC' },
  runner: { concepts: ['process', 'shell', 'encoding'], note: 'Runner：进程树清理、输出上限、取消' },
  office: { concepts: ['office', 'path', 'encoding'], note: 'Office：DOCX/XLSX/ZIP、路径与编码' },
  shell: { concepts: ['shell', 'powershell', 'encoding', 'process'], note: 'TrustedShell：PowerShell/CMD、编码' },
  state: { concepts: ['storage', 'path'], note: 'State：SQLite、版本化持久化、审计' },
  gateway: { concepts: ['network', 'approval'], note: 'Gateway：TLS、代理、模型网络' },
  'git-adapter': { concepts: ['git', 'process', 'approval'], note: 'Git Adapter：隔离配置、命令白名单' },
  workspace: { concepts: ['path', 'encoding', 'approval'], note: 'Workspace：路径边界、Reparse Point、编码' },
};

export function splitKeywords(raw) {
  if (!raw) return [];
  return [...new Set(String(raw).split(/[\s,，;；、]+/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Build the weighted term table. Direct topic words weigh 2, concept
 * expansions and module/implicit terms weigh 1 (a direct hit on an expanded
 * term still keeps the larger weight).
 */
export function buildTerms({ topics = [], moduleName, implicit = [] }) {
  const terms = new Map();
  const matched = [];
  const add = (term, weight, source) => {
    const key = term.toLowerCase();
    if (!key) return;
    if (!terms.has(key) || terms.get(key).weight < weight) terms.set(key, { weight, source });
  };
  for (const topic of topics) {
    add(topic, 2, `topic:${topic}`);
    for (const piece of topic.split(/[-_/]/).filter((piece) => piece.length > 1)) add(piece, 1.5, `topic:${topic}`);
    const concept = KEYWORD_CONCEPT[topic] || KEYWORD_CONCEPT[topic.replace(/[-_]/g, '')] || topic.split(/[-_/]/).map((piece) => KEYWORD_CONCEPT[piece]).find(Boolean);
    if (concept) for (const term of CONCEPTS[concept]) add(term, 1, `topic:${topic}→${concept}`);
  }
  const profile = moduleName ? MODULE_PROFILES[moduleName.toLowerCase()] : undefined;
  if (moduleName) {
    add(moduleName, 1.5, `module:${moduleName}`);
    if (profile) for (const concept of profile.concepts) for (const term of CONCEPTS[concept]) add(term, 1, `module:${moduleName}→${concept}`);
  }
  for (const concept of implicit) for (const term of CONCEPTS[concept]) add(term, 1, `task→${concept}`);
  for (const [term, info] of terms) matched.push({ term, ...info });
  return { terms, list: matched };
}

/** Concepts that dominate a text; used when only --task is given. */
export function implicitConcepts(text, limit = 3) {
  const lower = text.toLowerCase();
  const scored = Object.entries(CONCEPTS).map(([concept, words]) => {
    let score = 0;
    for (const word of words) score += Math.min(countOccurrences(lower, word), 3);
    return [concept, score];
  }).filter(([, score]) => score >= 2).sort((a, b) => b[1] - a[1]);
  return scored.slice(0, limit).map(([concept]) => concept);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Weighted keyword score of a text; each term saturates at 3 hits. */
export function scoreText(text, terms) {
  const lower = text.toLowerCase();
  let score = 0;
  const hit = [];
  for (const [term, info] of terms) {
    const count = countOccurrences(lower, term);
    if (count > 0) { score += info.weight * Math.min(count, 3); hit.push(term); }
  }
  return { score, hit };
}

// ---------------------------------------------------------------------------
// Markdown slicing
// ---------------------------------------------------------------------------

export function readText(file) {
  return readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Split into flat sections by heading; fenced code never starts a section. */
export function parseSections(text) {
  const sections = [{ level: 0, heading: '', lines: [] }];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(```+|~~~+)/);
    if (marker) {
      if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null;
    }
    const heading = !fence && !marker ? line.match(/^(#{1,6})\s+(.*\S)\s*$/) : null;
    if (heading) sections.push({ level: heading[1].length, heading: heading[2], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

const plain = (text) => text.replace(/\*\*/g, '').replace(/[ \t]+/g, ' ').trim();

/** Break section lines into rule units: table rows, list items, paragraphs. Fenced code is skipped. */
export function parseUnits(lines) {
  const units = [];
  let fence = null;
  let current = null;
  let tableHeader = null;
  let tableState = 0; // 0 none, 1 header seen
  const flush = () => {
    if (current) {
      const lead = current.text.match(/^(?:[-*]|\d+\.)\s+\*\*(.+?)\*\*/);
      if (lead) current.lead = plain(lead[1]);
      current.text = plain(current.text);
      if (current.text) units.push(current);
      current = null;
    }
  };
  for (const raw of lines) {
    const marker = raw.match(/^\s*(```+|~~~+)/);
    if (marker) {
      flush();
      if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); tableState = 0; tableHeader = null; continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue; // separator row
      if (tableState === 0) { tableHeader = plain(line); tableState = 1; continue; }
      units.push({ kind: 'row', text: plain(line), header: tableHeader });
      continue;
    }
    tableState = 0; tableHeader = null;
    const quote = line.replace(/^>\s?/, '');
    if (/^[-*]\s|^\d+\.\s/.test(quote)) { flush(); current = { kind: 'item', text: quote }; continue; }
    if (current && /^\s/.test(quote)) { current.text += `\n${quote.trim()}`; continue; }
    if (current && current.kind === 'item') { current.text += `\n${quote.trim()}`; continue; }
    if (current && current.kind === 'para') { current.text += `\n${quote}`; continue; }
    flush();
    current = { kind: 'para', text: quote };
  }
  flush();
  return units;
}

const COMPACT_CHARS = 60;
const CELL_CHARS = 45;

/** Cut at a clause boundary within `limit` characters and mark the cut. */
function clip(text, limit) {
  const chars = [...text];
  if (chars.length <= limit) return text;
  const head = chars.slice(0, limit).join('');
  const boundary = Math.max(head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(';'));
  return `${boundary > limit / 2 ? head.slice(0, boundary) : head}…`;
}

function firstSentence(text) {
  const stripped = text.replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '').replace(/\s+/g, ' ').trim();
  const end = stripped.search(/。(?=\s|$|[^\s。])/);
  return end > 0 ? stripped.slice(0, end + 1) : stripped;
}

/**
 * Cheaper form of a unit for tight budgets: bold lead if the rule has one,
 * else its first sentence without parentheticals, clipped at a clause boundary.
 */
export function compactText(text, kind, lead) {
  if (kind === 'row') {
    const cells = text.replace(/^\||\|$/g, '').split('|').map((cell) => clip(firstSentence(cell.trim()), CELL_CHARS));
    return `| ${cells.join(' | ')} |`;
  }
  const prefix = (text.match(/^([-*]\s|\d+\.\s)/) || [''])[0];
  const body = lead || firstSentence(text.slice(prefix.length).replace(/\n/g, ' '));
  return `${prefix}${clip(body, COMPACT_CHARS)}`;
}

// ---------------------------------------------------------------------------
// Source loaders -> candidate units
// ---------------------------------------------------------------------------

function rel(root, file) {
  return relative(root, file).split(sep).join('/');
}

const FORBIDDEN_TASK_FILES = new Set(['decisions.md', 'status_log.md']);

/** Resolve --task as a file path, glob, or task code. Never throws. */
export function resolveTask(spec, root) {
  const warnings = [];
  if (!spec) return { file: null, warnings };
  const baseName = spec.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (FORBIDDEN_TASK_FILES.has(baseName)) {
    warnings.push(`task file rejected by policy (large reference document): ${spec}`);
    return { file: null, warnings };
  }
  const candidates = [resolve(spec), resolve(root, spec)];
  for (const candidate of candidates) {
    const candBase = candidate.replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (FORBIDDEN_TASK_FILES.has(candBase)) {
      warnings.push(`task file rejected by policy (large reference document): ${spec}`);
      return { file: null, warnings };
    }
    try { if (statSync(candidate).isFile()) return { file: candidate, warnings }; } catch { /* try next */ }
  }
  const dir = join(root, 'docs', 'tasks');
  let names;
  try { names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')); } catch {
    warnings.push(`task directory not found: docs/tasks`);
    return { file: null, warnings };
  }
  const base = spec.replace(/\\/g, '/').split('/').pop();
  let matches;
  if (/[*?]/.test(base)) {
    const pattern = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
    matches = names.filter((name) => pattern.test(name));
  } else {
    const norm = (value) => value.toLowerCase().replace(/\.md$/, '').replace(/-/g, '_');
    const code = norm(base);
    matches = names.filter((name) => {
      const candidate = norm(name);
      if (candidate === code) return true;
      if (!candidate.startsWith(code)) return false;
      const next = candidate[code.length];
      // Boundary: A9_4 must not match A9_42; A9_42 matches A9_42_LIGHTWEIGHT...
      return !(/\d/.test(code[code.length - 1]) && /\d/.test(next));
    });
  }
  matches.sort();
  if (matches.length === 0) {
    warnings.push(`task not found: ${spec}`);
    return { file: null, warnings };
  }
  if (matches.length > 1) warnings.push(`task "${spec}" matched ${matches.length} files; using ${matches[0]}`);
  return { file: join(dir, matches[0]), warnings };
}

const TASK_GOAL_HEADING = /交付结果|任务目标|目标|纳入范围|结论与任务边界|授权/;
const TASK_RULE_HEADING = /边界|红线|验收|必要验证|验证口径|禁止|停止|约束|契约/;
const TASK_STRICT_RULE_HEADING = /边界|红线|验收|验证口径|禁止|停止条件|必要验证/;
const TASK_SKIP_HEADING = /记录|提案|PROPOSED|实施|执行|结果汇总|复验|试用|完成/;
const RULE_VERB = /必须|不得|禁止|拒绝|不允许|停止|仍须|硬门|不(?:改动|开放|放宽|依赖|引入|做|纳入|修改|新增|在未经)/;

export function extractTask(file, root, terms) {
  const text = readText(file);
  const sections = parseSections(text);
  const source = rel(root, file);
  const units = [];
  const title = sections.find((section) => section.level === 1);
  if (title) units.push({ source: 'task', section: source, kind: 'title', text: `任务书：${plain(title.heading)}（${source}）`, priority: 100, reason: ['task:title'] });
  const preamble = sections[0].lines.join('\n') + (title ? '\n' + title.lines.join('\n') : '');
  const meta = preamble.match(/```[a-z]*\n([\s\S]*?)```/);
  if (meta) {
    const fields = meta[1].split('\n').map((line) => line.trim()).filter((line) => /^(Status|Task Type|Phase-Gate|Win7-Validation)\s*:/i.test(line));
    if (fields.length) units.push({ source: 'task', section: source, kind: 'meta', text: `任务元数据：${fields.join('; ')}`, priority: 99, reason: ['task:meta'] });
  }
  const goals = [];
  const rules = [];
  for (const section of sections) {
    if (section.level < 2 || section.level > 3 || TASK_SKIP_HEADING.test(section.heading)) continue;
    // Level-3 headings are usually dated logs or sub-plans; only explicit boundary/acceptance ones count.
    const isGoal = TASK_GOAL_HEADING.test(section.heading) && (section.level === 2 || /纳入范围|交付结果|任务目标/.test(section.heading));
    const isRule = section.level === 2 ? TASK_RULE_HEADING.test(section.heading) : TASK_STRICT_RULE_HEADING.test(section.heading);
    if (!isGoal && !isRule) continue;
    const label = `${source} ${plain(section.heading)}`;
    const sectionUnits = parseUnits(section.lines);
    if (isGoal) {
      // Deliverable rows/items state the goal; date-stamped narrative paragraphs do not.
      const structured = sectionUnits.filter((unit) => unit.kind !== 'para');
      const pool = structured.length ? structured : sectionUnits.filter((unit) => !/^(?:负责人|\d{4}-\d{2}-\d{2})/.test(unit.text) && !/^\d{4}-\d{2}-\d{2}/.test(unit.text));
      for (const unit of pool) goals.push({ source: 'task', section: label, kind: unit.kind, lead: unit.lead, text: unit.text, reason: ['task:goal'] });
    }
    if (isRule) {
      for (const unit of sectionUnits) {
        if (!RULE_VERB.test(unit.text)) continue;
        const { score, hit } = scoreText(unit.text, terms);
        rules.push({ source: 'task', section: label, kind: unit.kind, lead: unit.lead, text: unit.text, hits: score, reason: ['task:redline', ...hit] });
      }
    }
  }
  goals.slice(0, 4).forEach((unit, rank) => {
    const { score, hit } = scoreText(unit.text, terms);
    units.push({ ...unit, priority: 91 - rank * 0.5 + Math.min(score, 2), reason: [...unit.reason, ...hit] });
  });
  // Keep the strongest red lines; document order breaks ties.
  rules.map((unit, order) => ({ ...unit, order })).sort((a, b) => (b.hits - a.hits) || (a.order - b.order)).slice(0, 6).forEach((unit, rank) => {
    units.push({ source: 'task', section: unit.section, kind: unit.kind, lead: unit.lead, text: unit.text, priority: 96 + Math.min(unit.hits, 2) * 0.5 - rank * 0.2, reason: unit.reason });
  });
  return { units, rawText: units.map((unit) => unit.text).join('\n') };
}

const AGENTS_SECTIONS = {
  1: { label: '§1 项目定义与文档优先级', base: 90 },
  4: { label: '§4 实现授权与行为边界', base: 78 },
  5: { label: '§5 安全与兼容性红线', base: 95 },
};

/** Fold "X：" followed by numbered items into one unit; compact form is a single ordered line. */
export function mergeNumberedLists(units) {
  const out = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (unit.kind === 'para' && /[：:]$/.test(unit.text.trim()) && units[index + 1] && /^\d+\.\s/.test(units[index + 1].text)) {
      const items = [];
      while (units[index + 1] && /^\d+\.\s/.test(units[index + 1].text)) { index += 1; items.push(units[index].text); }
      const names = items.map((item) => item.replace(/^\d+\.\s*/, '').replace(/（[^）]*）/g, '').replace(/`/g, '').trim());
      out.push({ kind: 'item', text: `${unit.text}\n${items.join('\n')}`, compactOverride: `${unit.text.trim()}${names.join(' > ')}` });
    } else out.push(unit);
  }
  return out;
}

export function extractAgents(file, root, terms) {
  const sections = parseSections(readText(file));
  const units = [];
  const source = rel(root, file);
  for (const section of sections) {
    const match = section.heading.match(/^(\d+)\.\s/);
    if (!match || !AGENTS_SECTIONS[match[1]]) continue;
    const { label, base } = AGENTS_SECTIONS[match[1]];
    const sectionUnits = mergeNumberedLists(parseUnits(section.lines));
    sectionUnits.forEach((unit, index) => {
      const { score, hit } = scoreText(unit.text, terms);
      const isHardGate = /硬门槛/.test(unit.text);
      const isPriorityRule = match[1] === '1' && /冲突优先级|停止相关实现|规则缺失/.test(unit.text);
      // Bullets decay slightly so ties are deterministic; intro prose ranks below the rules it introduces.
      const priority = (isHardGate ? 96 : isPriorityRule ? 91 : base)
        - index * 0.1
        - (unit.kind === 'para' && !isPriorityRule ? 4 : 0)
        + Math.min(score, 3) * 0.4;
      units.push({
        source: 'agents',
        section: `${source} ${label}`,
        kind: unit.kind,
        lead: unit.lead,
        compactOverride: unit.compactOverride,
        text: unit.text,
        priority,
        bypassQuota: isPriorityRule,
        reason: [`agents:${label.split(' ')[0]}`, ...hit],
      });
    });
  }
  return { units };
}

const WIN7_TOP_SECTIONS = 3;
const WIN7_CORE = /强制编码与路径规则|已知兼容性陷阱|不得隐式假设|A9 TrustedShell Win7 兼容合同/;
const WIN7_HISTORY = /登记|提案|批准|ENGINEERING|R\d+|Proposed|候选|补充|探针|构建机|实施前|\d{4}-\d{2}-\d{2}|ADR-\d+/;

/** Score every WIN7_CONSTRAINTS section and return the units of the best few. */
export function extractWin7(file, root, terms) {
  const sections = parseSections(readText(file));
  const source = rel(root, file);
  const scored = [];
  sections.forEach((section, index) => {
    if (section.level < 2 || !section.heading) return;
    const units = parseUnits(section.lines);
    if (units.length === 0) return;
    const heading = scoreText(section.heading, terms);
    const scoredUnits = units.map((unit) => ({ unit, ...scoreText(unit.text, terms) }));
    const top = scoredUnits.map((item) => item.score).sort((a, b) => b - a).slice(0, 3).reduce((sum, value) => sum + value, 0);
    let score = heading.score * 2 + top;
    if (score <= 0) return;
    if (WIN7_CORE.test(section.heading)) score += 3;
    if (WIN7_HISTORY.test(section.heading) && heading.score < 2) score *= 0.5; // dated registration logs rarely hold the rule itself
    scored.push({ index, section, score, scoredUnits, headingHits: heading.hit });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const chosen = scored.slice(0, WIN7_TOP_SECTIONS);
  const units = [];
  chosen.forEach((entry, rank) => {
    const label = `${source} ${plain(entry.section.heading)}`;
    entry.scoredUnits.forEach(({ unit, score, hit }) => {
      if (score <= 0 || unit.text.length < 8) return;
      units.push({
        source: 'win7', section: label, kind: unit.kind, lead: unit.lead, header: unit.header, text: unit.text,
        priority: 60 + Math.min(score * 4, 22) - rank * 3,
        reason: [`win7:section-score=${entry.score.toFixed(1)}`, ...hit],
      });
    });
  });
  return { units, sections: chosen.map((entry) => ({ heading: plain(entry.section.heading), score: Number(entry.score.toFixed(2)) })) };
}

export function extractAdr(file, root, terms, linkedIds) {
  const source = rel(root, file);
  const rows = [];
  for (const line of readText(file).split('\n')) {
    const match = line.match(/^\|\s*(ADR-\d{4})\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (match) rows.push({ id: match[1], title: match[2], status: match[3] });
  }
  const units = [];
  const seen = new Set();
  const add = (row, priority, reason) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    units.push({ source: 'adr', section: source, kind: 'adr', id: row.id, text: `- ${row.id} ${plain(row.title)}［${plain(row.status).slice(0, 40)}］`, priority, reason });
  };
  for (const id of linkedIds) {
    const row = rows.find((item) => item.id === id);
    if (row) add(row, 62, ['adr:linked-from-task']);
  }
  const scored = rows.map((row, order) => {
    const { score, hit } = scoreText(row.title, terms);
    const stale = /^Superseded/i.test(row.status) ? 0.5 : 1;
    return { row, order, hit, score: score * stale };
  }).filter((item) => item.score > 0).sort((a, b) => (b.score - a.score) || (b.order - a.order));
  for (const item of scored.slice(0, 8)) add(item.row, 40 + Math.min(item.score * 4, 18), ['adr:topic-match', ...item.hit]);
  return { units, total: rows.length };
}

// ---------------------------------------------------------------------------
// Budgeted assembly
// ---------------------------------------------------------------------------

const GROUP_ORDER = ['task', 'agents', 'win7', 'adr'];
const GROUP_TITLE = {
  task: '## 任务目标与验收红线',
  agents: '## AGENTS.md §1/§4/§5',
  win7: '## WIN7_CONSTRAINTS',
  adr: '## 相关 ADR（标题索引）',
};

const GROUP_SHARE = { task: 0.3, agents: 0.28, win7: 0.3, adr: 0.12 };
const tokensOf = (text) => estimateTokens(text);
const TABLE_SEPARATOR = (header) => `|${header.replace(/^\||\|$/g, '').split('|').map(() => '---').join('|')}|`;

export function formatContainer({ openTag, body, truncated, closeTag }) {
  const content = body ? `${body}${truncated ? `\n\n${TRUNCATION_NOTICE}` : ''}` : (truncated ? TRUNCATION_NOTICE : '');
  return `${openTag}\n${content ? content + '\n' : ''}${closeTag}\n`;
}

/**
 * Greedy two-pass selection. Pass 1 admits compact forms by priority so every
 * high-priority red line is represented; pass 2 upgrades units to their full
 * text, again by priority, while budget remains. The final render is re-measured
 * and the lowest-priority unit dropped until it fits.
 */
export function assemble(candidates, { budget, openTag, closeTag }) {
  const emptyFrame = formatContainer({ openTag, body: '', truncated: true, closeTag });
  const frame = tokensOf(emptyFrame);
  const limit = budget - frame;
  const units = candidates.map((unit, order) => ({
    ...unit, order,
    full: unit.text,
    compact: unit.compactOverride ?? compactText(unit.text, unit.kind, unit.lead),
  }));
  const ranked = [...units].sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
  const chosen = new Map(); // order -> 'compact' | 'full'
  const groupsUsed = new Set();
  const headersUsed = new Set();
  let used = 0;
  const costOf = (unit, form) => {
    let cost = tokensOf(`${form === 'full' ? unit.full : unit.compact}\n`);
    if (!groupsUsed.has(unit.source)) cost += tokensOf(`${GROUP_TITLE[unit.source]}\n\n`);
    if (unit.header && !headersUsed.has(`${unit.section}|${unit.header}`)) cost += tokensOf(`${unit.header}\n${TABLE_SEPARATOR(unit.header)}\n`);
    return cost;
  };
  const claim = (unit) => { groupsUsed.add(unit.source); if (unit.header) headersUsed.add(`${unit.section}|${unit.header}`); };
  // Pass 1 honours per-group shares so one noisy source cannot starve the others;
  // mandatory units (like AGENTS §1 core priority/stop rules) bypass the share cap.
  // Pass 2 hands unused budget to anything still waiting, again by priority.
  const spent = {};
  const cap = (source) => Math.floor(limit * (GROUP_SHARE[source] ?? 0.1));
  for (const strict of [true, false]) {
    for (const unit of ranked) {
      if (chosen.has(unit.order)) continue;
      const cost = costOf(unit, 'compact');
      if (used + cost > limit) continue;
      if (strict && !unit.bypassQuota && ((spent[unit.source] || 0) + cost > cap(unit.source))) continue;
      chosen.set(unit.order, 'compact'); used += cost; spent[unit.source] = (spent[unit.source] || 0) + cost; claim(unit);
    }
  }
  for (const unit of ranked) {
    if (!chosen.has(unit.order)) continue;
    if (unit.full === unit.compact) { chosen.set(unit.order, 'full'); continue; }
    const extra = tokensOf(`${unit.full}\n`) - tokensOf(`${unit.compact}\n`);
    if (used + extra <= limit) { chosen.set(unit.order, 'full'); used += extra; }
  }
  const render = () => renderBody(units, chosen);
  let body = render();
  const total = () => estimateTokens(formatContainer({ openTag, body: render(), truncated: chosen.size < units.length, closeTag }));
  while (chosen.size > 0 && total() > budget) {
    const drop = [...chosen.keys()].map((order) => units[order]).sort((a, b) => (a.priority - b.priority) || (b.order - a.order))[0];
    chosen.delete(drop.order);
    body = render();
  }
  return { units, chosen, body, truncated: chosen.size < units.length };
}

function renderBody(units, chosen) {
  const parts = [];
  for (const group of GROUP_ORDER) {
    const selected = units.filter((unit) => unit.source === group && chosen.has(unit.order));
    if (selected.length === 0) continue;
    const lines = [GROUP_TITLE[group], ''];
    let lastSection = null;
    let lastHeader = null;
    for (const unit of selected) {
      if (unit.source === 'win7' || unit.source === 'task') {
        if (unit.section !== lastSection && unit.source === 'win7') lines.push(`### ${unit.section}`);
        lastSection = unit.section;
      }
      if (unit.header && unit.header !== lastHeader) { lines.push(unit.header, TABLE_SEPARATOR(unit.header)); }
      lastHeader = unit.header || null;
      lines.push(chosen.get(unit.order) === 'full' ? unit.full : unit.compact);
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function projectContext(options) {
  const root = resolve(options.root || DEFAULT_ROOT);
  const budget = options.budget ?? DEFAULT_BUDGET;
  const warnings = [];
  const topics = splitKeywords(options.topic);
  const moduleName = options.module ? String(options.module).trim() : undefined;
  if (moduleName && !MODULE_PROFILES[moduleName.toLowerCase()]) {
    const known = existsSync(join(root, 'src', moduleName));
    warnings.push(`unknown module "${moduleName}"${known ? ' (src dir exists, matched by name only)' : ''}; known: ${Object.keys(MODULE_PROFILES).join(', ')}`);
  }

  // Task first: its text can imply keywords when none were given.
  const resolved = resolveTask(options.task, root);
  warnings.push(...resolved.warnings);
  let taskUnits = [];
  let taskText = '';
  let taskRel = null;
  const readUnits = (loader) => { try { return loader(); } catch (error) { warnings.push(`${error.message}`); return null; } };
  if (resolved.file) {
    taskRel = rel(root, resolved.file);
    const preTerms = buildTerms({ topics, moduleName }).terms;
    const extracted = readUnits(() => extractTask(resolved.file, root, preTerms));
    if (extracted) { taskUnits = extracted.units; taskText = extracted.rawText; }
  }
  const explicit = buildTerms({ topics, moduleName });
  let implicit = [];
  if (explicit.list.length === 0) {
    implicit = implicitConcepts(taskText);
    if (implicit.length === 0) implicit = ['encoding', 'path', 'process'];
  }
  const { terms, list: termList } = buildTerms({ topics, moduleName, implicit });

  const candidates = [...taskUnits];
  const sliceInfo = [];
  const docs = {
    agents: join(root, 'AGENTS.md'),
    win7: join(root, 'docs', 'WIN7_CONSTRAINTS.md'),
    adr: join(root, 'docs', 'DECISIONS_INDEX.md'),
  };
  let win7Sections = [];
  let adrTotal = 0;
  if (existsSync(docs.agents)) {
    const result = readUnits(() => extractAgents(docs.agents, root, terms));
    if (result) candidates.push(...result.units);
  } else warnings.push('AGENTS.md not found; red lines unavailable');
  if (existsSync(docs.win7)) {
    const result = readUnits(() => extractWin7(docs.win7, root, terms));
    if (result) { candidates.push(...result.units); win7Sections = result.sections; }
  } else warnings.push('docs/WIN7_CONSTRAINTS.md not found; constraint slices skipped');
  if (existsSync(docs.adr)) {
    const linked = [...new Set((taskText.match(/ADR-\d{4}/g) || []))].slice(0, 5);
    const result = readUnits(() => extractAdr(docs.adr, root, terms, linked));
    if (result) { candidates.push(...result.units); adrTotal = result.total; }
  } else warnings.push('docs/DECISIONS_INDEX.md not found; ADR slices skipped');

  const taskLabel = options.task ? String(options.task) : 'none';
  const attrs = [`task="${escapeAttr(taskLabel)}"`];
  if (moduleName) attrs.push(`module="${escapeAttr(moduleName)}"`);
  if (topics.length) attrs.push(`topic="${escapeAttr(topics.join(','))}"`);
  attrs.push(`budget="${budget}"`);
  const openTag = `<projected_context ${attrs.join(' ')}>`;
  const closeTag = '</projected_context>';
  const minTagTokens = estimateTokens(`${openTag}\n${closeTag}\n`);
  if (budget < minTagTokens) {
    throw new UsageError(`budget ${budget} is too small to fit container tags (${minTagTokens} tokens required)`);
  }
  const assembled = assemble(candidates, { budget, openTag, closeTag });
  const text = formatContainer({
    openTag,
    body: assembled.body,
    truncated: assembled.truncated,
    closeTag,
  });
  const totalTokens = estimateTokens(text);

  const slices = assembled.units.map((unit) => {
    const form = assembled.chosen.get(unit.order);
    const shown = form === 'full' ? unit.full : form === 'compact' ? unit.compact : '';
    return {
      source: unit.source,
      section: unit.section,
      kind: unit.kind,
      included: Boolean(form),
      form: form || 'dropped',
      priority: Number(unit.priority.toFixed(2)),
      chars: [...shown].length,
      tokens: shown ? estimateTokens(shown) : 0,
      fullTokens: estimateTokens(unit.full),
      matched: unit.reason,
      text: shown,
    };
  });
  const bySource = {};
  for (const slice of slices) {
    const entry = bySource[slice.source] || (bySource[slice.source] = { candidates: 0, included: 0, chars: 0, tokens: 0 });
    entry.candidates += 1;
    if (slice.included) { entry.included += 1; entry.chars += slice.chars; entry.tokens += slice.tokens; }
  }
  return {
    text,
    result: {
      task: taskLabel,
      taskFile: taskRel,
      module: moduleName || null,
      topics,
      implicitConcepts: implicit,
      budget,
      tokens: totalTokens,
      chars: [...text].length,
      truncated: assembled.truncated,
      tokenEstimator: 'conservative_utf8',
      terms: termList.map(({ term, weight, source }) => ({ term, weight, source })),
      win7Sections,
      adrIndexEntries: adrTotal,
      sources: bySource,
      warnings,
      slices,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) { io.stdout.write(`${USAGE}\n`); return 0; }
    const { text, result } = projectContext(options);
    for (const warning of result.warnings) io.stderr.write(`context_project: warning: ${warning}\n`);
    const payload = options.json ? `${JSON.stringify(result, null, 2)}\n` : text;
    if (options.output) {
      const target = isAbsolute(options.output) ? options.output : resolve(options.output);
      try { writeFileSync(target, payload, 'utf8'); } catch (error) {
        throw new UsageError(`cannot write --output ${options.output}: ${error.message}`);
      }
      io.stdout.write(`context_project: wrote ${target} (${result.tokens} tokens, budget ${result.budget}${result.truncated ? ', truncated' : ''})\n`);
    } else io.stdout.write(payload);
    return 0;
  } catch (error) {
    io.stderr.write(`context_project: ${error instanceof UsageError ? error.message : (error && error.stack) || error}\n`);
    if (error instanceof UsageError) io.stderr.write(`${USAGE}\n`);
    return 2;
  }
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = run(process.argv.slice(2));
