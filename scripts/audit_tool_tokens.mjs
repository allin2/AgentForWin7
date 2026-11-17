#!/usr/bin/env node
// Tool-primitive token audit (harness action 4).
//
// Loads the compiled tool catalog from src/core/dist and measures what each
// model-facing tool definition costs: total tokens, description, parameter
// descriptions, enums. Token estimates use the project's conservative UTF-8
// rule (scripts/lib/token_estimate.mjs, mirror of src/core/src/token-estimator.ts).
//
// Usage:
//   node scripts/audit_tool_tokens.mjs [--json] [--mode full|review|read-only]
//        [--no-images] [--no-office] [--dist <dir>] [--baseline <report.json>]
//        [--desc-chars N] [--param-chars N] [--tool-tokens N]
//        [--max-total N] [--max-tool N] [--output <file>]
//
// Exit codes: 0 ok, 1 budget exceeded (--max-total/--max-tool), 2 usage or load error.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { estimateTokens } from './lib/token_estimate.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

export const DEFAULT_THRESHOLDS = Object.freeze({
  descriptionChars: 150, // description longer than this is a slimming candidate
  paramDescriptionChars: 300, // total parameter-description characters per tool
  toolTokens: 400, // total tokens per tool
});

const MODES = { full: 'full_access', review: 'review', 'read-only': 'read_only' };

const USAGE = `Usage: node scripts/audit_tool_tokens.mjs [options]
  --json                 print machine-readable JSON
  --mode <m>             full (default) | review | read-only
  --no-images            exclude read_image
  --no-office            exclude document_* and office workflow tools
  --dist <dir>           compiled core directory (default src/core/dist)
  --baseline <file>      JSON report from an earlier run; print per-tool deltas
  --desc-chars <n>       description flag threshold (default ${DEFAULT_THRESHOLDS.descriptionChars})
  --param-chars <n>      parameter-description flag threshold (default ${DEFAULT_THRESHOLDS.paramDescriptionChars})
  --tool-tokens <n>      per-tool token flag threshold (default ${DEFAULT_THRESHOLDS.toolTokens})
  --max-total <n>        CI gate: fail when total surface tokens exceed n
  --max-tool <n>         CI gate: fail when any single tool exceeds n tokens
  --output <file>        also write the report to a file
  -h, --help             show this help`;

export class UsageError extends Error {}

function positiveInt(flag, raw) {
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) {
    throw new UsageError(`${flag} requires a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

export function parseArgs(argv) {
  const options = {
    json: false, mode: 'full', images: true, office: true, dist: undefined, baseline: undefined,
    thresholds: { ...DEFAULT_THRESHOLDS }, maxTotal: undefined, maxTool: undefined, output: undefined, help: false,
  };
  const valueFlags = new Set(['--mode', '--dist', '--baseline', '--desc-chars', '--param-chars', '--tool-tokens', '--max-total', '--max-tool', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let inline;
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (equals > 0) { inline = arg.slice(equals + 1); arg = arg.slice(0, equals); }
    if (arg === '--json') options.json = true;
    else if (arg === '--no-images') options.images = false;
    else if (arg === '--no-office') options.office = false;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (valueFlags.has(arg)) {
      const value = inline !== undefined ? inline : argv[++index];
      if (value === undefined || value === '') throw new UsageError(`${arg} requires a value`);
      switch (arg) {
        case '--mode':
          if (!(value in MODES)) throw new UsageError(`--mode must be one of ${Object.keys(MODES).join(', ')}`);
          options.mode = value; break;
        case '--dist': options.dist = value; break;
        case '--baseline': options.baseline = value; break;
        case '--output': options.output = value; break;
        case '--desc-chars': options.thresholds.descriptionChars = positiveInt(arg, value); break;
        case '--param-chars': options.thresholds.paramDescriptionChars = positiveInt(arg, value); break;
        case '--tool-tokens': options.thresholds.toolTokens = positiveInt(arg, value); break;
        case '--max-total': options.maxTotal = positiveInt(arg, value); break;
        case '--max-tool': options.maxTool = positiveInt(arg, value); break;
        default: break;
      }
    } else throw new UsageError(`unknown option: ${arg}`);
  }
  return options;
}

const charLength = (text) => [...String(text)].length;

/**
 * Measure one ToolSpec. The model-facing payload is {name, description,
 * parameters: inputSchema} (see a9-agent-loop.ts), so total tokens estimate its
 * compact JSON. descriptionTokens / propertyDescriptionTokens / enumTokens are
 * the standalone cost of those parts; schemaOverheadTokens is the remainder
 * (keys, types, defaults, limits, JSON punctuation).
 */
export function measureTool(spec, thresholds = DEFAULT_THRESHOLDS) {
  const schema = spec.inputSchema || { properties: {}, required: [] };
  const properties = Object.entries(schema.properties || {});
  const payload = JSON.stringify({ name: spec.name, description: spec.description, parameters: schema });
  const totalTokens = estimateTokens(payload);
  const descriptionTokens = estimateTokens(spec.description || '');
  let propertyDescriptionChars = 0;
  let propertyDescriptionTokens = 0;
  let enumTokens = 0;
  let enumValues = 0;
  for (const [, property] of properties) {
    const text = property.description || '';
    propertyDescriptionChars += charLength(text);
    if (text) propertyDescriptionTokens += estimateTokens(text);
    if (Array.isArray(property.enum)) {
      enumValues += property.enum.length;
      enumTokens += estimateTokens(JSON.stringify(property.enum));
    }
  }
  const descriptionChars = charLength(spec.description || '');
  const flags = [];
  if (descriptionChars > thresholds.descriptionChars) flags.push('DESC_LONG');
  if (propertyDescriptionChars > thresholds.paramDescriptionChars) flags.push('PARAMS_LONG');
  if (totalTokens > thresholds.toolTokens) flags.push('TOKENS_HIGH');
  return {
    name: spec.name,
    totalTokens,
    payloadChars: charLength(payload),
    descriptionChars,
    descriptionTokens,
    paramCount: properties.length,
    requiredCount: (schema.required || []).length,
    propertyDescriptionChars,
    propertyDescriptionTokens,
    enumValues,
    enumTokens,
    schemaOverheadTokens: Math.max(0, totalTokens - descriptionTokens - propertyDescriptionTokens - enumTokens),
    flags,
  };
}

export function auditSpecs(specs, thresholds = DEFAULT_THRESHOLDS) {
  const tools = specs.map((spec) => measureTool(spec, thresholds))
    .sort((a, b) => (b.totalTokens - a.totalTokens) || a.name.localeCompare(b.name));
  const sum = (key) => tools.reduce((acc, tool) => acc + tool[key], 0);
  const flagged = tools.filter((tool) => tool.flags.length > 0);
  const totals = {
    toolCount: tools.length,
    totalTokens: sum('totalTokens'),
    descriptionTokens: sum('descriptionTokens'),
    propertyDescriptionTokens: sum('propertyDescriptionTokens'),
    enumTokens: sum('enumTokens'),
    schemaOverheadTokens: sum('schemaOverheadTokens'),
    paramCount: sum('paramCount'),
    flaggedCount: flagged.length,
  };
  return { thresholds: { ...thresholds }, totals, tools };
}

function requireDist(distDir, file) {
  const target = join(distDir, file);
  if (!existsSync(target)) {
    throw new UsageError(`${target} not found; run "npm --prefix src/core run build" first`);
  }
  return createRequire(import.meta.url)(target);
}

/** Load the full tool surface exactly as A9AgentLoop registers it. */
export function loadToolSpecs({ distDir, mode = 'full', images = true, office = true } = {}) {
  const dist = resolve(distDir || join(DEFAULT_ROOT, 'src', 'core', 'dist'));
  const tools = requireDist(dist, 'a9-tools.js');
  const permissionMode = MODES[mode];
  if (!permissionMode) throw new UsageError(`unknown mode: ${mode}`);
  const specs = [...tools.a9ToolSpecs(permissionMode, { images, office })];
  if (office) {
    const workflow = requireDist(dist, 'a9-office-tools.js');
    const supported = [...workflow.OFFICE_READ_TOOLS, ...workflow.OFFICE_WRITE_TOOLS];
    specs.push(...workflow.officeWorkflowToolSpecs(permissionMode, supported));
  }
  return specs;
}

export function compareReports(current, baseline) {
  const before = new Map(baseline.tools.map((tool) => [tool.name, tool.totalTokens]));
  const rows = current.tools.map((tool) => ({
    name: tool.name,
    before: before.has(tool.name) ? before.get(tool.name) : null,
    after: tool.totalTokens,
  }));
  for (const tool of baseline.tools) {
    if (!current.tools.some((item) => item.name === tool.name)) rows.push({ name: tool.name, before: tool.totalTokens, after: null });
  }
  const totalBefore = baseline.totals.totalTokens;
  const totalAfter = current.totals.totalTokens;
  return {
    totalBefore,
    totalAfter,
    delta: totalAfter - totalBefore,
    percent: totalBefore > 0 ? Number((((totalAfter - totalBefore) / totalBefore) * 100).toFixed(2)) : 0,
    changed: rows.filter((row) => row.before !== row.after).map((row) => ({
      ...row, delta: (row.after ?? 0) - (row.before ?? 0),
    })).sort((a, b) => a.delta - b.delta),
  };
}

function pad(value, width, right = true) {
  const text = String(value);
  return right ? text.padStart(width) : text.padEnd(width);
}

export function formatTable(report, comparison) {
  const columns = [
    ['#', (tool, index) => String(index + 1), true],
    ['tool', (tool) => tool.name, false],
    ['total', (tool) => tool.totalTokens, true],
    ['desc', (tool) => `${tool.descriptionTokens}/${tool.descriptionChars}c`, true],
    ['params', (tool) => tool.paramCount, true],
    ['prop-desc', (tool) => `${tool.propertyDescriptionTokens}/${tool.propertyDescriptionChars}c`, true],
    ['enum', (tool) => tool.enumTokens, true],
    ['schema', (tool) => tool.schemaOverheadTokens, true],
    ['flags', (tool) => tool.flags.join(',') || '-', false],
  ];
  const rows = report.tools.map((tool, index) => columns.map(([, get]) => String(get(tool, index))));
  const widths = columns.map(([title], i) => Math.max(title.length, ...rows.map((row) => row[i].length)));
  const render = (cells) => cells.map((cell, i) => pad(cell, widths[i], columns[i][2])).join('  ').trimEnd();
  const lines = [render(columns.map(([title]) => title)), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of rows) lines.push(render(row));
  const t = report.totals;
  lines.push('');
  lines.push(`tools=${t.toolCount}  total=${t.totalTokens}  description=${t.descriptionTokens}  prop-description=${t.propertyDescriptionTokens}  enum=${t.enumTokens}  schema=${t.schemaOverheadTokens}  params=${t.paramCount}  flagged=${t.flaggedCount}`);
  lines.push(`thresholds: description>${report.thresholds.descriptionChars}c, prop-description>${report.thresholds.paramDescriptionChars}c, tool>${report.thresholds.toolTokens} tokens (conservative UTF-8 estimate)`);
  if (comparison) {
    lines.push('');
    lines.push(`baseline: ${comparison.totalBefore} -> ${comparison.totalAfter} tokens (${comparison.delta >= 0 ? '+' : ''}${comparison.delta}, ${comparison.percent}%)`);
    for (const row of comparison.changed) {
      lines.push(`  ${pad(row.name, Math.max(...comparison.changed.map((r) => r.name.length)), false)}  ${row.before ?? '-'} -> ${row.after ?? '-'}  (${row.delta >= 0 ? '+' : ''}${row.delta})`);
    }
  }
  return lines.join('\n');
}

/** Evaluate CI gates; returns a list of failure messages (empty = pass). */
export function checkGates(report, { maxTotal, maxTool } = {}) {
  const failures = [];
  if (maxTotal !== undefined && report.totals.totalTokens > maxTotal) {
    failures.push(`total ${report.totals.totalTokens} tokens exceeds --max-total ${maxTotal}`);
  }
  if (maxTool !== undefined) {
    for (const tool of report.tools) {
      if (tool.totalTokens > maxTool) failures.push(`${tool.name} ${tool.totalTokens} tokens exceeds --max-tool ${maxTool}`);
    }
  }
  return failures;
}

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) { io.stdout.write(`${USAGE}\n`); return 0; }
    const specs = loadToolSpecs({ distDir: options.dist, mode: options.mode, images: options.images, office: options.office });
    const report = auditSpecs(specs, options.thresholds);
    report.surface = { mode: options.mode, images: options.images, office: options.office };
    let comparison;
    if (options.baseline) {
      if (!existsSync(options.baseline)) throw new UsageError(`baseline file not found: ${options.baseline}`);
      let baseline;
      try { baseline = JSON.parse(readFileSync(options.baseline, 'utf8').replace(/^﻿/, '')); } catch (error) {
        throw new UsageError(`baseline is not valid JSON: ${error.message}`);
      }
      if (!baseline || !baseline.totals || !Array.isArray(baseline.tools)) throw new UsageError('baseline is not an audit report');
      comparison = compareReports(report, baseline);
      report.comparison = comparison;
    }
    const failures = checkGates(report, options);
    if (failures.length) report.gateFailures = failures;
    const text = options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatTable(report, comparison)}\n`;
    if (options.output) writeFileSync(options.output, text, 'utf8');
    io.stdout.write(text);
    for (const failure of failures) io.stderr.write(`GATE FAIL: ${failure}\n`);
    return failures.length ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`audit_tool_tokens: ${error.message}\n`);
      return 2;
    }
    io.stderr.write(`audit_tool_tokens: ${error && error.stack ? error.stack : error}\n`);
    return 2;
  }
}

const isMain = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = run(process.argv.slice(2));
