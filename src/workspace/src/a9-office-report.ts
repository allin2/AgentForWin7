/** A9-70 P4. PPTX structured layouts / template filling (pptxgenjs + image-size / docxtemplater)
 * and escaped offline single-file HTML+SVG dashboard generation.
 * Host owns path checks, SHA binding, exclusive publication, and checkpoints.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CheckpointManager } from './checkpoint-manager';
import { IoGuard, captureAnchor, captureNearestAnchor, samePath } from './directory-identity';
import { OfficeBatchIdentity } from './a9-office-batch';
import { officePath, readOfficeFile } from './a9-office-files';

export const OFFICE_REPORT_LIMITS = Object.freeze({
  maxSlides: 40,
  maxPptxOutputBytes: 16 * 1024 * 1024,
  maxHtmlOutputBytes: 4 * 1024 * 1024,
  maxImageBytes: 2 * 1024 * 1024,
  outputPathChars: 240,
  maxPlans: 16,
  maxTextChars: 4096,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export class OfficeReportError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'OfficeReportError';
  }
}

function fail(code: string, details?: Record<string, unknown>): never {
  throw new OfficeReportError(code, details);
}
function errorCode(error: unknown): string {
  if (error instanceof OfficeReportError) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code) return code;
  return 'REPORT_FAILED';
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('REPORT_CANCELLED');
}
const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (v as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return v;
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
function fileIdentity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function fileStat(file: string, guard: IoGuard): fs.Stats {
  guard.check(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('REPORT_NOT_REGULAR_FILE');
  return stat;
}
function absent(file: string, guard: IoGuard): void {
  guard.check(file);
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  fail('REPORT_TARGET_EXISTS');
}

function validateIdentity(value: OfficeBatchIdentity): void {
  if (!value || Object.keys(value).sort().join(',') !== 'conversationId,turnId,workspaceId'
    || Object.values(value).some(v => typeof v !== 'string' || !/^[\w.-]{1,128}$/.test(v))) {
    fail('REPORT_IDENTITY_INVALID');
  }
}
function identityKey(value: OfficeBatchIdentity): string {
  validateIdentity(value);
  return JSON.stringify([value.workspaceId, value.conversationId, value.turnId]);
}

function relativeName(value: string): string {
  if (typeof value !== 'string') fail('REPORT_PATH_INVALID');
  const norm = value.replace(/\/+$/, '');
  if (!norm || norm.length > 4096 || /[\\\x00-\x1f:*?"<>|]/.test(norm)
    || path.isAbsolute(norm) || path.win32.isAbsolute(norm)) {
    fail('REPORT_PATH_INVALID');
  }
  const segments = norm.split('/');
  if (segments.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
    || ['.git', '.agent_recovery'].includes(s.toLowerCase()) || /^~\$/.test(s)
    || /^_待清理隔离区_/.test(s) || /^\.a9-(?:archive|batch|transfer|tpl|rep)-/i.test(s))) {
    fail('REPORT_PATH_INVALID');
  }
  return norm;
}

function validText(value: unknown, maxLen: number = OFFICE_REPORT_LIMITS.maxTextChars, allowEmpty = false): string {
  if (typeof value !== 'string') fail('REPORT_TEXT_INVALID');
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) fail('REPORT_TEXT_INVALID');
  if (value.length > maxLen || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value)) {
    fail('REPORT_TEXT_INVALID');
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('REPORT_TEXT_INVALID');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('REPORT_TEXT_INVALID');
    }
  }
  return value;
}

function validateSources(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) fail('REPORT_SOURCES_REQUIRED');
  return raw.map(item => validText(item, 240, false).trim());
}

function validateRenderData(value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string') {
    validText(value, 16384, true);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2000) fail('REPORT_DATA_LIMIT');
    for (const item of value) validateRenderData(item);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) fail('REPORT_DATA_INVALID');
      validateRenderData(v);
    }
    return;
  }
  fail('REPORT_DATA_INVALID');
}

export type PresentationSlideSpec =
  | { layout: 'cover'; title: string; subtitle?: string; meta?: string; imagePath?: string; sources: string[]; notes?: string }
  | { layout: 'toc'; title: string; items: Array<string | { title: string; detail?: string }>; sources: string[]; notes?: string }
  | { layout: 'two_column'; title: string; left: { heading: string; items: string[] }; right: { heading: string; items: string[] }; sources: string[]; notes?: string }
  | { layout: 'table'; title: string; headers: string[]; rows: string[][]; sources: string[]; notes?: string }
  | { layout: 'summary'; title: string; takeaways: string[]; nextSteps?: string[]; sources: string[]; notes?: string };

export type PresentationCreateInput =
  | {
    mode: 'layouts';
    outputPath: string;
    title: string;
    subtitle?: string;
    author?: string;
    slides: PresentationSlideSpec[];
  }
  | {
    mode: 'template';
    templatePath: string;
    templateSha256: string;
    outputPath: string;
    data: Record<string, unknown>;
    sources?: string[];
  };

export interface PresentationPlan {
  schemaVersion: 1;
  planId: string;
  identity: OfficeBatchIdentity;
  mode: 'layouts' | 'template';
  outputPath: string;
  title?: string;
  templatePath?: string;
  templateSha256?: string;
  slideCount?: number;
  layouts?: string[];
  sources: string[];
  dataSha256: string;
  approvalRequired: true;
}

export interface PresentationResult {
  schemaVersion: 1;
  planId: string;
  status: 'completed' | 'partial' | 'cancelled' | 'failed';
  code: string;
  mode: 'layouts' | 'template';
  outputPath: string;
  published: boolean;
  sha256?: string;
  bytes?: number;
  slideCount?: number;
  slides?: Array<{ index: number; partName: string; texts: string[]; notesTexts: string[] }>;
  sources: string[];
  recovery: 'recorded' | 'unknown' | 'not_needed';
  checkpointStatus: 'recorded' | 'persistence_failed' | 'not_needed';
  persistenceError?: string;
  warnings: string[];
  limitations: string[];
}

export interface HtmlReportKpi {
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  source?: string;
}

export interface HtmlReportChart {
  kind: 'bar' | 'line';
  title: string;
  unit?: string;
  source: string;
  series: Array<{ label: string; value: number }>;
}

export interface HtmlReportTable {
  title: string;
  source: string;
  headers: string[];
  rows: string[][];
}

export interface HtmlReportCreateInput {
  outputPath: string;
  title: string;
  subtitle?: string;
  generatedAt?: string;
  sources: string[];
  kpis?: HtmlReportKpi[];
  charts?: HtmlReportChart[];
  tables?: HtmlReportTable[];
  notes?: string[];
}

export interface HtmlReportPlan {
  schemaVersion: 1;
  planId: string;
  identity: OfficeBatchIdentity;
  outputPath: string;
  title: string;
  sources: string[];
  kpiCount: number;
  chartCount: number;
  tableCount: number;
  dataSha256: string;
  approvalRequired: true;
}

export interface HtmlReportResult {
  schemaVersion: 1;
  planId: string;
  status: 'completed' | 'partial' | 'cancelled' | 'failed';
  code: string;
  outputPath: string;
  published: boolean;
  sha256?: string;
  bytes?: number;
  sources: string[];
  recovery: 'recorded' | 'unknown' | 'not_needed';
  checkpointStatus: 'recorded' | 'persistence_failed' | 'not_needed';
  persistenceError?: string;
  previewBaseline: 'chromium_108_restricted';
  warnings: string[];
  limitations: string[];
}

export interface ReportApprovalBinding {
  schemaVersion: 1;
  purpose: 'presentation' | 'html_report';
  planId: string;
  identity: OfficeBatchIdentity;
  workspaceRoot: string;
  outputPath: string;
  mode?: 'layouts' | 'template';
  templatePath?: string;
  templateSha256?: string;
  slideCount?: number;
  sources: string[];
  dataSha256: string;
  bindingSha256: string;
}

export interface OfficeReportApprovalPort {
  consume(approvalId: string, binding: ReportApprovalBinding): Promise<{ status: 'approved'; bindingSha256: string }>;
}

export interface OfficeReportWorkerPort {
  createLayoutsPresentation(
    input: {
      tempPath: string;
      tempIdentity: FileIdentity;
      title: string;
      author?: string;
      slides: PresentationSlideSpec[];
      images: Record<string, Buffer>;
      maxOutputBytes: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    tempPath: string;
    bytes: number;
    sha256: string;
    slideCount: number;
    slides: Array<{ index: number; partName: string; texts: string[]; notesTexts: string[] }>;
    workerExitCode: number;
  }>;
  fillTemplatePresentation(
    input: {
      tempPath: string;
      tempIdentity: FileIdentity;
      templateBuffer: Buffer;
      data: Record<string, unknown>;
      maxOutputBytes: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    tempPath: string;
    bytes: number;
    sha256: string;
    slideCount: number;
    slides: Array<{ index: number; partName: string; texts: string[]; notesTexts: string[] }>;
    workerExitCode: number;
  }>;
  close?(): Promise<void>;
}

interface StoredPresentationPlan {
  plan: PresentationPlan;
  key: string;
  used: boolean;
  guard: IoGuard;
  outputAbs: string;
  author?: string;
  normalizedSlides?: PresentationSlideSpec[];
  imagePaths?: Array<{ rel: string; sha256: string }>;
  templateData?: Record<string, unknown>;
}

interface StoredHtmlPlan {
  plan: HtmlReportPlan;
  key: string;
  used: boolean;
  guard: IoGuard;
  outputAbs: string;
  normalizedInput: HtmlReportCreateInput;
}

type Resolver = (value: string) => { absPath: string; relPath: string; isOutside: boolean };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSvgChart(chart: HtmlReportChart): string {
  const width = 680;
  const height = 240;
  const padLeft = 56;
  const padRight = 24;
  const padTop = 26;
  const padBottom = 52;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const values = chart.series.map(s => s.value);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values);
  const span = maxVal - minVal || 1;
  const yFor = (v: number): number => padTop + plotH - ((v - minVal) / span) * plotH;
  const zeroY = yFor(0);

  const gridLines: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const val = minVal + (span * i) / 4;
    const y = yFor(val);
    gridLines.push(
      `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`,
      `<text x="${padLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748b">${escapeHtml(Number.isInteger(val) ? String(val) : val.toFixed(1))}</text>`,
    );
  }

  let bodySvg = '';
  const n = chart.series.length;
  const stepX = plotW / n;

  if (chart.kind === 'bar') {
    const barW = Math.max(10, Math.min(48, stepX * 0.56));
    bodySvg = chart.series.map((pt, idx) => {
      const cx = padLeft + stepX * idx + stepX / 2;
      const x = cx - barW / 2;
      const yVal = yFor(pt.value);
      const rectY = Math.min(yVal, zeroY);
      const rectH = Math.max(2, Math.abs(zeroY - yVal));
      const labelY = pt.value >= 0 ? rectY - 6 : rectY + rectH + 13;
      const shortLabel = pt.label.length > 12 ? `${pt.label.slice(0, 11)}…` : pt.label;
      return `<g>` +
        `<rect x="${x.toFixed(1)}" y="${rectY.toFixed(1)}" width="${barW.toFixed(1)}" height="${rectH.toFixed(1)}" rx="3" fill="#2563eb"><title>${escapeHtml(pt.label)}: ${escapeHtml(String(pt.value))}</title></rect>` +
        `<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="#0f172a">${escapeHtml(String(pt.value))}</text>` +
        `<text x="${cx.toFixed(1)}" y="${height - 18}" text-anchor="middle" font-size="11" fill="#475569">${escapeHtml(shortLabel)}</text>` +
        `</g>`;
    }).join('');
  } else {
    const pts = chart.series.map((pt, idx) => {
      const cx = n === 1 ? padLeft + plotW / 2 : padLeft + (plotW * idx) / (n - 1);
      const cy = yFor(pt.value);
      return { cx, cy, pt };
    });
    const polyline = pts.map(p => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
    const dots = pts.map((p) => {
      const shortLabel = p.pt.label.length > 12 ? `${p.pt.label.slice(0, 11)}…` : p.pt.label;
      return `<g>` +
        `<circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="4.5" fill="#1d4ed8" stroke="#ffffff" stroke-width="1.5"><title>${escapeHtml(p.pt.label)}: ${escapeHtml(String(p.pt.value))}</title></circle>` +
        `<text x="${p.cx.toFixed(1)}" y="${(p.cy - 9).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="#0f172a">${escapeHtml(String(p.pt.value))}</text>` +
        `<text x="${p.cx.toFixed(1)}" y="${height - 18}" text-anchor="middle" font-size="11" fill="#475569">${escapeHtml(shortLabel)}</text>` +
        `</g>`;
    }).join('');
    bodySvg = `<polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${polyline}"/>${dots}`;
  }

  const unitLabel = chart.unit ? `（${escapeHtml(chart.unit)}）` : '';
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(chart.title)}${unitLabel}">` +
    `<title>${escapeHtml(chart.title)}${unitLabel}</title>` +
    `${gridLines.join('')}` +
    `<line x1="${padLeft}" y1="${zeroY.toFixed(1)}" x2="${width - padRight}" y2="${zeroY.toFixed(1)}" stroke="#94a3b8" stroke-width="1.2"/>` +
    `${bodySvg}` +
    `</svg>`;
}

export function renderOfflineHtmlDashboard(input: HtmlReportCreateInput): string {
  const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const subtitleHtml = input.subtitle ? `<p class="subtitle">${escapeHtml(input.subtitle)}</p>` : '';
  const generated = input.generatedAt ? escapeHtml(input.generatedAt) : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sourcesBadge = input.sources.map(s => `<span class="badge">${escapeHtml(s)}</span>`).join('');

  const kpisHtml = input.kpis && input.kpis.length
    ? `<section class="section"><h2>关键指标</h2><div class="kpi-grid">${input.kpis.map(k => (
      `<article class="kpi-card">` +
      `<div class="kpi-label">${escapeHtml(k.label)}</div>` +
      `<div class="kpi-value">${escapeHtml(k.value)}${k.unit ? `<span class="kpi-unit">${escapeHtml(k.unit)}</span>` : ''}</div>` +
      `${k.delta ? `<div class="kpi-delta">${escapeHtml(k.delta)}</div>` : ''}` +
      `${k.source ? `<div class="source-note">来源：${escapeHtml(k.source)}</div>` : ''}` +
      `</article>`
    )).join('')}</div></section>`
    : '';

  const chartsHtml = input.charts && input.charts.length
    ? `<section class="section"><h2>趋势与对比图表</h2><div class="chart-grid">${input.charts.map(c => (
      `<details class="panel" open><summary class="panel-head"><span>${escapeHtml(c.title)}${c.unit ? `（${escapeHtml(c.unit)}）` : ''}</span><span class="source-chip">来源：${escapeHtml(c.source)}</span></summary>` +
      `<div class="panel-body">${renderSvgChart(c)}</div></details>`
    )).join('')}</div></section>`
    : '';

  const tablesHtml = input.tables && input.tables.length
    ? `<section class="section"><h2>结构化明细</h2>${input.tables.map(t => (
      `<details class="panel" open><summary class="panel-head"><span>${escapeHtml(t.title)}</span><span class="source-chip">来源：${escapeHtml(t.source)}</span></summary>` +
      `<div class="table-wrap"><table><thead><tr>${t.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` +
      `<tbody>${t.rows.map(r => `<tr>${r.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`
    )).join('')}</section>`
    : '';

  const notesHtml = input.notes && input.notes.length
    ? `<section class="section"><details class="panel" open><summary class="panel-head"><span>说明与口径备注</span></summary>` +
      `<ul class="notes-list">${input.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></details></section>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(input.title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:24px;font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;background:#f8fafc;color:#0f172a;line-height:1.55}
.container{max-width:1120px;margin:0 auto}
.hero{background:#1b365d;color:#ffffff;padding:24px 28px;border-radius:10px;margin-bottom:20px}
.hero h1{margin:0 0 6px;font-size:24px;line-height:1.3}
.subtitle{margin:0 0 12px;color:#e2e8f0;font-size:14px}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:#cbd5e1}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.15);color:#fff}
.section{margin-bottom:20px}
.section>h2{margin:0 0 10px;font-size:16px;color:#1b365d}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.kpi-card{background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:14px 16px}
.kpi-label{font-size:13px;color:#475569}
.kpi-value{font-size:24px;font-weight:700;color:#0f172a;margin:4px 0}
.kpi-unit{font-size:13px;font-weight:400;color:#64748b;margin-left:4px}
.kpi-delta{font-size:12px;color:#1d4ed8}
.chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px}
.panel{background:#fff;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:14px;overflow:hidden}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;background:#f1f5f9;font-weight:600;cursor:pointer;list-style:none}
.panel-body{padding:12px 16px}
.source-chip,.source-note{font-size:12px;font-weight:400;color:#475569}
.table-wrap{overflow-x:auto;padding:0 16px 14px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#1b365d;color:#fff;font-weight:600}
tr:nth-child(even) td{background:#f8fafc}
.notes-list{margin:0;padding:14px 28px}
.notes-list li{margin:4px 0}
.footer{margin-top:20px;padding-top:12px;border-top:1px solid #cbd5e1;font-size:12px;color:#64748b}
</style>
</head>
<body>
<main class="container">
<header class="hero">
<h1>${escapeHtml(input.title)}</h1>
${subtitleHtml}
<div class="meta"><span>生成时间：${generated}</span><span>数据来源：</span>${sourcesBadge}</div>
</header>
${kpisHtml}
${chartsHtml}
${tablesHtml}
${notesHtml}
<footer class="footer">
离线单文件数据看板（无外部网络资源、无脚本执行）。默认查看基线为应用内 Chromium 108 受限预览；外部系统默认浏览器兼容性需另行核验。
</footer>
</main>
</body>
</html>
`;
}

export class OfficeReportService {
  private readonly presentationPlans = new Map<string, StoredPresentationPlan>();
  private readonly htmlPlans = new Map<string, StoredHtmlPlan>();
  private active = false;

  constructor(
    private readonly root: string,
    private readonly checkpoint: CheckpointManager,
    private readonly resolve: Resolver,
    private readonly approval?: OfficeReportApprovalPort,
    private readonly worker?: OfficeReportWorkerPort,
  ) {}

  private checkNoLinks(value: string): void {
    if (!value) return;
    let probe = this.root;
    for (const seg of value.split('/')) {
      probe = path.join(probe, seg);
      try {
        if (fs.lstatSync(probe).isSymbolicLink()) fail('REPORT_PATH_REDIRECTED');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  private resolveOutput(value: string, extensionRe: RegExp): { relative: string; absolute: string } {
    const relative = relativeName(value);
    if (!extensionRe.test(relative)) fail('REPORT_PATH_INVALID');
    const lexicalAbs = path.resolve(this.root, relative);
    const tempSample = path.join(path.dirname(lexicalAbs), `.a9-rep-${'0'.repeat(16)}.tmp`);
    if (lexicalAbs.length > OFFICE_REPORT_LIMITS.outputPathChars || tempSample.length > OFFICE_REPORT_LIMITS.outputPathChars) {
      fail('REPORT_PATH_TOO_LONG');
    }
    let resolved: { absPath: string; relPath: string; isOutside: boolean };
    try {
      resolved = this.resolve(relative);
    } catch (error: any) {
      if (error && error.code === 'PATH_TOO_LONG') fail('REPORT_PATH_TOO_LONG');
      throw error;
    }
    if (resolved.isOutside || !samePath(lexicalAbs, resolved.absPath)) fail('REPORT_PATH_REDIRECTED');
    this.checkNoLinks(relative);
    return { relative, absolute: lexicalAbs };
  }

  async planPresentation(binding: OfficeBatchIdentity, input: PresentationCreateInput, signal?: AbortSignal): Promise<PresentationPlan> {
    if (!this.worker) fail('REPORT_WORKER_UNAVAILABLE');
    cancelled(signal);
    const key = identityKey(binding);
    const boundIdentity = { ...binding };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('REPORT_INPUT_INVALID');
    if (this.presentationPlans.size >= OFFICE_REPORT_LIMITS.maxPlans) {
      const used = [...this.presentationPlans].find(([, s]) => s.used);
      if (used) this.presentationPlans.delete(used[0]);
    }
    if (this.presentationPlans.size >= OFFICE_REPORT_LIMITS.maxPlans) fail('REPORT_PLAN_LIMIT');

    const rootAnchor = captureAnchor(this.root);

    if (input.mode === 'template') {
      if (Object.keys(input).some(k => !['mode', 'templatePath', 'templateSha256', 'outputPath', 'data', 'sources'].includes(k))) {
        fail('REPORT_INPUT_INVALID');
      }
      if (!/^[a-f0-9]{64}$/.test(String(input.templateSha256 || ''))) fail('REPORT_SOURCE_INVALID');
      const tplRel = relativeName(input.templatePath);
      if (!/\.pptx$/i.test(tplRel)) fail('A9_OFFICE_FORMAT_UNSUPPORTED');
      const out = this.resolveOutput(input.outputPath, /\.pptx$/i);
      if (out.relative.toLowerCase() === tplRel.toLowerCase()) fail('REPORT_PATH_CONFLICT');
      const tplFile = await readOfficeFile(this.root, tplRel, signal);
      if (tplFile.sha256 !== input.templateSha256) fail('REPORT_SOURCE_DRIFT');
      if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) fail('REPORT_DATA_INVALID');
      validateRenderData(input.data);
      const sources = input.sources !== undefined ? validateSources(input.sources) : [tplFile.path];
      const outParent = captureNearestAnchor(path.dirname(out.absolute));
      const guard = new IoGuard([rootAnchor, outParent]);
      absent(out.absolute, guard);

      const dataSha256 = digest(canonicalJson({ data: input.data, sources }));
      const plan = freeze<PresentationPlan>({
        schemaVersion: 1,
        planId: crypto.randomBytes(16).toString('hex'),
        identity: boundIdentity,
        mode: 'template',
        outputPath: out.relative,
        templatePath: tplFile.path,
        templateSha256: tplFile.sha256,
        sources,
        dataSha256,
        approvalRequired: true,
      });
      this.presentationPlans.set(plan.planId, {
        plan,
        key,
        used: false,
        guard,
        outputAbs: out.absolute,
        templateData: input.data,
      });
      return plan;
    }

    if (input.mode !== 'layouts') fail('REPORT_INPUT_INVALID');
    if (Object.keys(input).some(k => !['mode', 'outputPath', 'title', 'subtitle', 'author', 'slides'].includes(k))) {
      fail('REPORT_INPUT_INVALID');
    }
    const title = validText(input.title, 200, false).trim();
    const author = input.author !== undefined ? validText(input.author, 120, false).trim() : undefined;
    const out = this.resolveOutput(input.outputPath, /\.pptx$/i);
    if (!Array.isArray(input.slides) || input.slides.length === 0 || input.slides.length > OFFICE_REPORT_LIMITS.maxSlides) {
      fail('REPORT_SLIDE_LIMIT');
    }

    const outParent = captureNearestAnchor(path.dirname(out.absolute));
    const guard = new IoGuard([rootAnchor, outParent]);
    absent(out.absolute, guard);

    const normalizedSlides: PresentationSlideSpec[] = [];
    const allSources = new Set<string>();
    const imageHashes: Array<{ rel: string; sha256: string }> = [];

    for (const rawSlide of input.slides) {
      if (!rawSlide || typeof rawSlide !== 'object' || Array.isArray(rawSlide)) fail('REPORT_SLIDE_INVALID');
      const slide = rawSlide as Record<string, unknown>;
      const slideSources = validateSources(slide.sources);
      slideSources.forEach(s => allSources.add(s));
      const notes = slide.notes !== undefined ? validText(slide.notes, 2000, true) : undefined;
      const sTitle = validText(slide.title, 200, false).trim();

      if (slide.layout === 'cover') {
        if (Object.keys(slide).some(k => !['layout', 'title', 'subtitle', 'meta', 'imagePath', 'sources', 'notes'].includes(k))) {
          fail('REPORT_SLIDE_INVALID');
        }
        let imageRel: string | undefined;
        if (slide.imagePath !== undefined) {
          const imgPath = relativeName(slide.imagePath as string);
          if (!/\.(png|jpe?g)$/i.test(imgPath)) fail('REPORT_IMAGE_UNSUPPORTED');
          const resolvedImg = officePath(this.root, imgPath, false);
          const st = fs.lstatSync(resolvedImg.absolute);
          if (!st.isFile() || st.isSymbolicLink()) fail('REPORT_IMAGE_UNSUPPORTED');
          if (st.size <= 0 || st.size > OFFICE_REPORT_LIMITS.maxImageBytes) fail('REPORT_IMAGE_BYTE_LIMIT');
          const imgBuf = fs.readFileSync(resolvedImg.absolute);
          imageRel = resolvedImg.relative;
          imageHashes.push({ rel: imageRel, sha256: digest(imgBuf) });
        }
        normalizedSlides.push({
          layout: 'cover',
          title: sTitle,
          ...(slide.subtitle !== undefined ? { subtitle: validText(slide.subtitle, 400, true) } : {}),
          ...(slide.meta !== undefined ? { meta: validText(slide.meta, 240, true) } : {}),
          ...(imageRel ? { imagePath: imageRel } : {}),
          sources: slideSources,
          ...(notes !== undefined ? { notes } : {}),
        });
      } else if (slide.layout === 'toc') {
        if (Object.keys(slide).some(k => !['layout', 'title', 'items', 'sources', 'notes'].includes(k))) {
          fail('REPORT_SLIDE_INVALID');
        }
        if (!Array.isArray(slide.items) || slide.items.length === 0 || slide.items.length > 20) fail('REPORT_SLIDE_INVALID');
        const items = slide.items.map((item) => {
          if (typeof item === 'string') return validText(item, 200, false).trim();
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const obj = item as Record<string, unknown>;
            if (Object.keys(obj).some(k => !['title', 'detail'].includes(k))) fail('REPORT_SLIDE_INVALID');
            return {
              title: validText(obj.title, 200, false).trim(),
              ...(obj.detail !== undefined ? { detail: validText(obj.detail, 240, true) } : {}),
            };
          }
          fail('REPORT_SLIDE_INVALID');
        });
        normalizedSlides.push({ layout: 'toc', title: sTitle, items, sources: slideSources, ...(notes !== undefined ? { notes } : {}) });
      } else if (slide.layout === 'two_column') {
        if (Object.keys(slide).some(k => !['layout', 'title', 'left', 'right', 'sources', 'notes'].includes(k))) {
          fail('REPORT_SLIDE_INVALID');
        }
        const checkCol = (rawCol: unknown) => {
          if (!rawCol || typeof rawCol !== 'object' || Array.isArray(rawCol)) fail('REPORT_SLIDE_INVALID');
          const c = rawCol as Record<string, unknown>;
          if (Object.keys(c).some(k => !['heading', 'items'].includes(k))) fail('REPORT_SLIDE_INVALID');
          const heading = validText(c.heading, 160, false).trim();
          if (!Array.isArray(c.items) || c.items.length > 15) fail('REPORT_SLIDE_INVALID');
          return { heading, items: c.items.map(i => validText(i, 400, false).trim()) };
        };
        normalizedSlides.push({
          layout: 'two_column',
          title: sTitle,
          left: checkCol(slide.left),
          right: checkCol(slide.right),
          sources: slideSources,
          ...(notes !== undefined ? { notes } : {}),
        });
      } else if (slide.layout === 'table') {
        if (Object.keys(slide).some(k => !['layout', 'title', 'headers', 'rows', 'sources', 'notes'].includes(k))) {
          fail('REPORT_SLIDE_INVALID');
        }
        if (!Array.isArray(slide.headers) || slide.headers.length === 0 || slide.headers.length > 12) fail('REPORT_SLIDE_INVALID');
        const headers = slide.headers.map(h => validText(h, 160, false).trim());
        if (!Array.isArray(slide.rows) || slide.rows.length > 40) fail('REPORT_SLIDE_INVALID');
        const rows = slide.rows.map((r) => {
          if (!Array.isArray(r) || r.length !== headers.length) fail('REPORT_SLIDE_INVALID');
          return r.map(cell => validText(cell, 512, true));
        });
        normalizedSlides.push({ layout: 'table', title: sTitle, headers, rows, sources: slideSources, ...(notes !== undefined ? { notes } : {}) });
      } else if (slide.layout === 'summary') {
        if (Object.keys(slide).some(k => !['layout', 'title', 'takeaways', 'nextSteps', 'sources', 'notes'].includes(k))) {
          fail('REPORT_SLIDE_INVALID');
        }
        if (!Array.isArray(slide.takeaways) || slide.takeaways.length === 0 || slide.takeaways.length > 15) fail('REPORT_SLIDE_INVALID');
        const takeaways = slide.takeaways.map(t => validText(t, 400, false).trim());
        let nextSteps: string[] | undefined;
        if (slide.nextSteps !== undefined) {
          if (!Array.isArray(slide.nextSteps) || slide.nextSteps.length > 15) fail('REPORT_SLIDE_INVALID');
          nextSteps = slide.nextSteps.map(s => validText(s, 400, false).trim());
        }
        normalizedSlides.push({
          layout: 'summary',
          title: sTitle,
          takeaways,
          ...(nextSteps ? { nextSteps } : {}),
          sources: slideSources,
          ...(notes !== undefined ? { notes } : {}),
        });
      } else {
        fail('REPORT_LAYOUT_UNSUPPORTED');
      }
    }

    const plan = freeze<PresentationPlan>({
      schemaVersion: 1,
      planId: crypto.randomBytes(16).toString('hex'),
      identity: boundIdentity,
      mode: 'layouts',
      outputPath: out.relative,
      title,
      slideCount: normalizedSlides.length,
      layouts: normalizedSlides.map(s => s.layout),
      sources: [...allSources],
      dataSha256: digest(canonicalJson({ title, author, slides: normalizedSlides, imageHashes })),
      approvalRequired: true,
    });
    this.presentationPlans.set(plan.planId, {
      plan,
      key,
      used: false,
      guard,
      outputAbs: out.absolute,
      ...(author ? { author } : {}),
      normalizedSlides,
      imagePaths: imageHashes,
    });
    return plan;
  }

  async preparePresentation(planId: string, binding: OfficeBatchIdentity, signal?: AbortSignal): Promise<ReportApprovalBinding> {
    const stored = this.presentationPlans.get(planId);
    if (!stored) fail('REPORT_PLAN_UNKNOWN');
    if (stored.used) fail('REPORT_PLAN_CONSUMED');
    if (identityKey(binding) !== stored.key) fail('REPORT_IDENTITY_MISMATCH');
    cancelled(signal);
    stored.guard.assertAnchors();
    absent(stored.outputAbs, stored.guard);

    if (stored.plan.mode === 'template') {
      const tpl = await readOfficeFile(this.root, stored.plan.templatePath!, signal);
      if (tpl.sha256 !== stored.plan.templateSha256) fail('REPORT_SOURCE_DRIFT');
    } else if (stored.imagePaths) {
      for (const img of stored.imagePaths) {
        const resolved = officePath(this.root, img.rel, false);
        const bytes = fs.readFileSync(resolved.absolute);
        if (digest(bytes) !== img.sha256) fail('REPORT_IMAGE_DRIFT');
      }
    }

    const base = {
      schemaVersion: 1 as const,
      purpose: 'presentation' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      outputPath: stored.plan.outputPath,
      mode: stored.plan.mode,
      ...(stored.plan.templatePath ? { templatePath: stored.plan.templatePath, templateSha256: stored.plan.templateSha256 } : {}),
      ...(stored.plan.slideCount !== undefined ? { slideCount: stored.plan.slideCount } : {}),
      sources: stored.plan.sources,
      dataSha256: stored.plan.dataSha256,
    };
    return freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });
  }

  async executePresentation(options: {
    planId: string;
    identity: OfficeBatchIdentity;
    approvalId: string;
    signal?: AbortSignal;
  }): Promise<PresentationResult> {
    if (!this.worker) fail('REPORT_WORKER_UNAVAILABLE');
    if (this.active) fail('REPORT_BUSY');
    const stored = this.presentationPlans.get(options.planId);
    if (!stored) fail('REPORT_PLAN_UNKNOWN');
    if (stored.used) fail('REPORT_PLAN_CONSUMED');
    if (identityKey(options.identity) !== stored.key) fail('REPORT_IDENTITY_MISMATCH');
    if (!this.approval || typeof options.approvalId !== 'string' || !options.approvalId) fail('REPORT_APPROVAL_REQUIRED');
    const signal = options.signal;
    cancelled(signal);

    const base = {
      schemaVersion: 1 as const,
      purpose: 'presentation' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      outputPath: stored.plan.outputPath,
      mode: stored.plan.mode,
      ...(stored.plan.templatePath ? { templatePath: stored.plan.templatePath, templateSha256: stored.plan.templateSha256 } : {}),
      ...(stored.plan.slideCount !== undefined ? { slideCount: stored.plan.slideCount } : {}),
      sources: stored.plan.sources,
      dataSha256: stored.plan.dataSha256,
    };
    const authorization = freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });

    this.active = true;
    stored.used = true;
    let guard = stored.guard;
    const turnId = stored.plan.identity.turnId;
    let tempAbs: string | undefined;
    let tempRel: string | undefined;
    let tempId: FileIdentity | undefined;
    let status: PresentationResult['status'] = 'failed';
    let code = 'REPORT_FAILED';
    let published = false;
    let recovery: PresentationResult['recovery'] = 'not_needed';
    let checkpointStatus: PresentationResult['checkpointStatus'] = 'not_needed';
    let persistenceError: string | undefined;
    let outSha256: string | undefined;
    let outBytes: number | undefined;
    let slideCount: number | undefined;
    let slides: PresentationResult['slides'];
    const warnings: string[] = [];

    try {
      cancelled(signal);
      const approved = await this.approval.consume(options.approvalId, authorization);
      if (!approved || approved.status !== 'approved' || approved.bindingSha256 !== authorization.bindingSha256) {
        fail('REPORT_APPROVAL_REJECTED');
      }
      stored.guard.assertAnchors();
      absent(stored.outputAbs, stored.guard);

      let templateBuffer: Buffer | undefined;
      const images: Record<string, Buffer> = {};
      if (stored.plan.mode === 'template') {
        const tpl = await readOfficeFile(this.root, stored.plan.templatePath!, signal);
        if (tpl.sha256 !== stored.plan.templateSha256) fail('REPORT_SOURCE_DRIFT');
        templateBuffer = tpl.buffer;
      } else if (stored.imagePaths) {
        for (const img of stored.imagePaths) {
          const resolved = officePath(this.root, img.rel, false);
          const bytes = fs.readFileSync(resolved.absolute);
          if (digest(bytes) !== img.sha256) fail('REPORT_IMAGE_DRIFT');
          images[img.rel] = bytes;
        }
      }

      tempAbs = path.join(path.dirname(stored.outputAbs), `.a9-rep-${crypto.randomBytes(8).toString('hex')}.tmp`);
      if (tempAbs.length > OFFICE_REPORT_LIMITS.outputPathChars) fail('REPORT_PATH_TOO_LONG');
      tempRel = path.relative(this.root, tempAbs).replace(/\\/g, '/');

      guard = this.checkpoint.createIoGuard([stored.outputAbs, tempAbs]).with([() => { stored.guard.assertAnchors(); return undefined; }]);
      await this.checkpoint.recordPreMutationAsync(turnId, stored.plan.outputPath, { guard, signal });
      await this.checkpoint.recordPreMutationAsync(turnId, tempRel, { guard, signal });
      guard.ensureDirectory(path.dirname(stored.outputAbs));
      guard = guard.with([captureAnchor(path.dirname(stored.outputAbs))]);

      guard.check(tempAbs);
      const fd = fs.openSync(tempAbs, 'wx');
      try {
        tempId = fileIdentity(fs.fstatSync(fd));
      } finally {
        fs.closeSync(fd);
      }
      await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'create', { guard, fileHash: EMPTY_SHA256, skipNewBlob: true });

      const workerOut = stored.plan.mode === 'layouts'
        ? await this.worker.createLayoutsPresentation({
          tempPath: tempAbs,
          tempIdentity: tempId,
          title: stored.plan.title || '工作汇报',
          ...(stored.author ? { author: stored.author } : {}),
          slides: stored.normalizedSlides!,
          images,
          maxOutputBytes: OFFICE_REPORT_LIMITS.maxPptxOutputBytes,
        }, signal)
        : await this.worker.fillTemplatePresentation({
          tempPath: tempAbs,
          tempIdentity: tempId,
          templateBuffer: templateBuffer!,
          data: stored.templateData!,
          maxOutputBytes: OFFICE_REPORT_LIMITS.maxPptxOutputBytes,
        }, signal);

      if (signal?.aborted) {
        status = 'cancelled';
        code = 'REPORT_CANCELLED';
      } else {
        guard.assertAnchors();
        const st = fileStat(tempAbs, guard);
        if (st.dev !== tempId.dev || st.ino !== tempId.ino) fail('REPORT_TEMP_IDENTITY_CHANGED');
        absent(stored.outputAbs, guard);
        guard.check(tempAbs);
        guard.check(stored.outputAbs);
        try {
          fs.linkSync(tempAbs, stored.outputAbs);
        } catch (linkErr) {
          if (errorCode(linkErr) === 'EEXIST') fail('REPORT_TARGET_EXISTS');
          throw linkErr;
        }
        published = true;
        outSha256 = workerOut.sha256;
        outBytes = workerOut.bytes;
        slideCount = workerOut.slideCount;
        slides = workerOut.slides;
        recovery = 'unknown';
        checkpointStatus = 'persistence_failed';
        try {
          await this.checkpoint.recordPostMutationAsync(turnId, stored.plan.outputPath, 'create', {
            guard,
            fileHash: outSha256,
            skipNewBlob: true,
          });
          recovery = 'recorded';
          checkpointStatus = 'recorded';
          status = 'completed';
          code = 'REPORT_PPTX_OK';
        } catch (persistErr) {
          persistenceError = persistErr instanceof Error ? persistErr.message : String(persistErr);
          code = 'REPORT_CHECKPOINT_PERSIST_FAILED';
          status = 'partial';
          warnings.push('PPTX 文件已发布，但恢复记录持久化失败。');
        }
      }
    } catch (err) {
      code = errorCode(err);
      status = code === 'REPORT_CANCELLED' || code === 'A9_OFFICE_CANCELLED' || signal?.aborted ? 'cancelled' : 'failed';
      if (status === 'cancelled') code = 'REPORT_CANCELLED';
      if (published && status === 'failed') status = 'partial';
    } finally {
      if (tempAbs && tempRel && tempId) {
        try {
          guard.check(tempAbs);
          const cur = fileStat(tempAbs, guard);
          if (cur.dev === tempId.dev && cur.ino === tempId.ino) fs.unlinkSync(tempAbs);
          await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'delete', { guard });
        } catch (_ignored) {
          recovery = 'unknown';
        }
      }
      this.active = false;
    }

    return {
      schemaVersion: 1,
      planId: stored.plan.planId,
      status,
      code,
      mode: stored.plan.mode,
      outputPath: stored.plan.outputPath,
      published,
      ...(outSha256 ? { sha256: outSha256, bytes: outBytes } : {}),
      ...(slideCount !== undefined ? { slideCount, slides } : {}),
      sources: [...stored.plan.sources],
      recovery,
      checkpointStatus,
      ...(persistenceError ? { persistenceError } : {}),
      warnings,
      limitations: [
        'PPTX 由纯 JS 生成与 XML 回读核验；实际字体替换、复杂图形或跨页版式以指定 PowerPoint / WPS 查看环境为准。',
        '不生成 PDF 或调用本地 Office COM。',
      ],
    };
  }

  async planHtmlReport(binding: OfficeBatchIdentity, input: HtmlReportCreateInput, signal?: AbortSignal): Promise<HtmlReportPlan> {
    cancelled(signal);
    const key = identityKey(binding);
    const boundIdentity = { ...binding };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('REPORT_INPUT_INVALID');
    const allowed = ['outputPath', 'title', 'subtitle', 'generatedAt', 'sources', 'kpis', 'charts', 'tables', 'notes'];
    if (Object.keys(input).some(k => !allowed.includes(k))) fail('REPORT_INPUT_INVALID');
    if (this.htmlPlans.size >= OFFICE_REPORT_LIMITS.maxPlans) {
      const used = [...this.htmlPlans].find(([, s]) => s.used);
      if (used) this.htmlPlans.delete(used[0]);
    }
    if (this.htmlPlans.size >= OFFICE_REPORT_LIMITS.maxPlans) fail('REPORT_PLAN_LIMIT');

    const out = this.resolveOutput(input.outputPath, /\.html?$/i);
    const title = validText(input.title, 200, false).trim();
    const subtitle = input.subtitle !== undefined ? validText(input.subtitle, 400, true) : undefined;
    const generatedAt = input.generatedAt !== undefined ? validText(input.generatedAt, 80, false).trim() : undefined;
    const sources = validateSources(input.sources);

    const kpis: HtmlReportKpi[] = [];
    if (input.kpis !== undefined) {
      if (!Array.isArray(input.kpis) || input.kpis.length > 24) fail('REPORT_HTML_INVALID');
      for (const rawK of input.kpis) {
        if (!rawK || typeof rawK !== 'object' || Array.isArray(rawK)) fail('REPORT_HTML_INVALID');
        if (Object.keys(rawK).some(k => !['label', 'value', 'unit', 'delta', 'source'].includes(k))) fail('REPORT_HTML_INVALID');
        kpis.push({
          label: validText(rawK.label, 120, false).trim(),
          value: validText(rawK.value, 120, false).trim(),
          ...(rawK.unit !== undefined ? { unit: validText(rawK.unit, 40, true) } : {}),
          ...(rawK.delta !== undefined ? { delta: validText(rawK.delta, 80, true) } : {}),
          ...(rawK.source !== undefined ? { source: validText(rawK.source, 200, false).trim() } : {}),
        });
      }
    }

    const charts: HtmlReportChart[] = [];
    if (input.charts !== undefined) {
      if (!Array.isArray(input.charts) || input.charts.length > 12) fail('REPORT_HTML_INVALID');
      for (const rawC of input.charts) {
        if (!rawC || typeof rawC !== 'object' || Array.isArray(rawC)) fail('REPORT_HTML_INVALID');
        if (Object.keys(rawC).some(k => !['kind', 'title', 'unit', 'source', 'series'].includes(k))) fail('REPORT_HTML_INVALID');
        if (rawC.kind !== 'bar' && rawC.kind !== 'line') fail('REPORT_CHART_UNSUPPORTED');
        if (!Array.isArray(rawC.series) || rawC.series.length === 0 || rawC.series.length > 30) fail('REPORT_HTML_INVALID');
        const series = rawC.series.map((pt) => {
          if (!pt || typeof pt !== 'object' || Array.isArray(pt)) fail('REPORT_HTML_INVALID');
          if (Object.keys(pt).some(k => !['label', 'value'].includes(k))) fail('REPORT_HTML_INVALID');
          if (typeof pt.value !== 'number' || !Number.isFinite(pt.value)) fail('REPORT_HTML_INVALID');
          return { label: validText(pt.label, 160, false).trim(), value: pt.value };
        });
        charts.push({
          kind: rawC.kind,
          title: validText(rawC.title, 160, false).trim(),
          ...(rawC.unit !== undefined ? { unit: validText(rawC.unit, 40, true) } : {}),
          source: validText(rawC.source, 200, false).trim(),
          series,
        });
      }
    }

    const tables: HtmlReportTable[] = [];
    if (input.tables !== undefined) {
      if (!Array.isArray(input.tables) || input.tables.length > 12) fail('REPORT_HTML_INVALID');
      for (const rawT of input.tables) {
        if (!rawT || typeof rawT !== 'object' || Array.isArray(rawT)) fail('REPORT_HTML_INVALID');
        if (Object.keys(rawT).some(k => !['title', 'source', 'headers', 'rows'].includes(k))) fail('REPORT_HTML_INVALID');
        if (!Array.isArray(rawT.headers) || rawT.headers.length === 0 || rawT.headers.length > 16) fail('REPORT_HTML_INVALID');
        const headers = rawT.headers.map(h => validText(h, 160, false).trim());
        if (!Array.isArray(rawT.rows) || rawT.rows.length > 200) fail('REPORT_HTML_INVALID');
        const rows = rawT.rows.map((r) => {
          if (!Array.isArray(r) || r.length !== headers.length) fail('REPORT_HTML_INVALID');
          return r.map(c => validText(c, 1024, true));
        });
        tables.push({
          title: validText(rawT.title, 160, false).trim(),
          source: validText(rawT.source, 200, false).trim(),
          headers,
          rows,
        });
      }
    }

    const notes: string[] = [];
    if (input.notes !== undefined) {
      if (!Array.isArray(input.notes) || input.notes.length > 30) fail('REPORT_HTML_INVALID');
      for (const n of input.notes) notes.push(validText(n, 1024, false).trim());
    }

    if (!kpis.length && !charts.length && !tables.length && !notes.length) fail('REPORT_HTML_EMPTY');

    const rootAnchor = captureAnchor(this.root);
    const outParent = captureNearestAnchor(path.dirname(out.absolute));
    const guard = new IoGuard([rootAnchor, outParent]);
    absent(out.absolute, guard);

    const normalizedInput: HtmlReportCreateInput = {
      outputPath: out.relative,
      title,
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(generatedAt !== undefined ? { generatedAt } : {}),
      sources,
      ...(kpis.length ? { kpis } : {}),
      ...(charts.length ? { charts } : {}),
      ...(tables.length ? { tables } : {}),
      ...(notes.length ? { notes } : {}),
    };

    const plan = freeze<HtmlReportPlan>({
      schemaVersion: 1,
      planId: crypto.randomBytes(16).toString('hex'),
      identity: boundIdentity,
      outputPath: out.relative,
      title,
      sources,
      kpiCount: kpis.length,
      chartCount: charts.length,
      tableCount: tables.length,
      dataSha256: digest(canonicalJson(normalizedInput)),
      approvalRequired: true,
    });
    this.htmlPlans.set(plan.planId, {
      plan,
      key,
      used: false,
      guard,
      outputAbs: out.absolute,
      normalizedInput,
    });
    return plan;
  }

  async prepareHtmlReport(planId: string, binding: OfficeBatchIdentity, signal?: AbortSignal): Promise<ReportApprovalBinding> {
    const stored = this.htmlPlans.get(planId);
    if (!stored) fail('REPORT_PLAN_UNKNOWN');
    if (stored.used) fail('REPORT_PLAN_CONSUMED');
    if (identityKey(binding) !== stored.key) fail('REPORT_IDENTITY_MISMATCH');
    cancelled(signal);
    stored.guard.assertAnchors();
    absent(stored.outputAbs, stored.guard);

    const base = {
      schemaVersion: 1 as const,
      purpose: 'html_report' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      outputPath: stored.plan.outputPath,
      sources: stored.plan.sources,
      dataSha256: stored.plan.dataSha256,
    };
    return freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });
  }

  async executeHtmlReport(options: {
    planId: string;
    identity: OfficeBatchIdentity;
    approvalId: string;
    signal?: AbortSignal;
  }): Promise<HtmlReportResult> {
    if (this.active) fail('REPORT_BUSY');
    const stored = this.htmlPlans.get(options.planId);
    if (!stored) fail('REPORT_PLAN_UNKNOWN');
    if (stored.used) fail('REPORT_PLAN_CONSUMED');
    if (identityKey(options.identity) !== stored.key) fail('REPORT_IDENTITY_MISMATCH');
    if (!this.approval || typeof options.approvalId !== 'string' || !options.approvalId) fail('REPORT_APPROVAL_REQUIRED');
    const signal = options.signal;
    cancelled(signal);

    const base = {
      schemaVersion: 1 as const,
      purpose: 'html_report' as const,
      planId: stored.plan.planId,
      identity: stored.plan.identity,
      workspaceRoot: this.root,
      outputPath: stored.plan.outputPath,
      sources: stored.plan.sources,
      dataSha256: stored.plan.dataSha256,
    };
    const authorization = freeze({ ...base, bindingSha256: digest(canonicalJson(base)) });

    this.active = true;
    stored.used = true;
    let guard = stored.guard;
    const turnId = stored.plan.identity.turnId;
    let tempAbs: string | undefined;
    let tempRel: string | undefined;
    let tempId: FileIdentity | undefined;
    let status: HtmlReportResult['status'] = 'failed';
    let code = 'REPORT_FAILED';
    let published = false;
    let recovery: HtmlReportResult['recovery'] = 'not_needed';
    let checkpointStatus: HtmlReportResult['checkpointStatus'] = 'not_needed';
    let persistenceError: string | undefined;
    let outSha256: string | undefined;
    let outBytes: number | undefined;
    const warnings: string[] = [];

    try {
      cancelled(signal);
      const approved = await this.approval.consume(options.approvalId, authorization);
      if (!approved || approved.status !== 'approved' || approved.bindingSha256 !== authorization.bindingSha256) {
        fail('REPORT_APPROVAL_REJECTED');
      }
      stored.guard.assertAnchors();
      absent(stored.outputAbs, stored.guard);

      const html = renderOfflineHtmlDashboard(stored.normalizedInput);
      const bytes = Buffer.from(html, 'utf8');
      if (bytes.length > OFFICE_REPORT_LIMITS.maxHtmlOutputBytes) fail('REPORT_BYTE_LIMIT');

      tempAbs = path.join(path.dirname(stored.outputAbs), `.a9-rep-${crypto.randomBytes(8).toString('hex')}.tmp`);
      if (tempAbs.length > OFFICE_REPORT_LIMITS.outputPathChars) fail('REPORT_PATH_TOO_LONG');
      tempRel = path.relative(this.root, tempAbs).replace(/\\/g, '/');

      guard = this.checkpoint.createIoGuard([stored.outputAbs, tempAbs]).with([() => { stored.guard.assertAnchors(); return undefined; }]);
      await this.checkpoint.recordPreMutationAsync(turnId, stored.plan.outputPath, { guard, signal });
      await this.checkpoint.recordPreMutationAsync(turnId, tempRel, { guard, signal });
      guard.ensureDirectory(path.dirname(stored.outputAbs));
      guard = guard.with([captureAnchor(path.dirname(stored.outputAbs))]);

      guard.check(tempAbs);
      const fd = fs.openSync(tempAbs, 'wx');
      try {
        tempId = fileIdentity(fs.fstatSync(fd));
        fs.writeSync(fd, bytes, 0, bytes.length, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'create', { guard, fileHash: digest(bytes), skipNewBlob: true });

      if (signal?.aborted) {
        status = 'cancelled';
        code = 'REPORT_CANCELLED';
      } else {
        guard.assertAnchors();
        const st = fileStat(tempAbs, guard);
        if (st.dev !== tempId.dev || st.ino !== tempId.ino) fail('REPORT_TEMP_IDENTITY_CHANGED');
        absent(stored.outputAbs, guard);
        guard.check(tempAbs);
        guard.check(stored.outputAbs);
        try {
          fs.linkSync(tempAbs, stored.outputAbs);
        } catch (linkErr) {
          if (errorCode(linkErr) === 'EEXIST') fail('REPORT_TARGET_EXISTS');
          throw linkErr;
        }
        published = true;
        outSha256 = digest(bytes);
        outBytes = bytes.length;
        recovery = 'unknown';
        checkpointStatus = 'persistence_failed';
        try {
          await this.checkpoint.recordPostMutationAsync(turnId, stored.plan.outputPath, 'create', {
            guard,
            fileHash: outSha256,
            skipNewBlob: true,
          });
          recovery = 'recorded';
          checkpointStatus = 'recorded';
          status = 'completed';
          code = 'REPORT_HTML_OK';
        } catch (persistErr) {
          persistenceError = persistErr instanceof Error ? persistErr.message : String(persistErr);
          code = 'REPORT_CHECKPOINT_PERSIST_FAILED';
          status = 'partial';
          warnings.push('HTML 看板已发布，但恢复记录持久化失败。');
        }
      }
    } catch (err) {
      code = errorCode(err);
      status = code === 'REPORT_CANCELLED' || signal?.aborted ? 'cancelled' : 'failed';
      if (status === 'cancelled') code = 'REPORT_CANCELLED';
      if (published && status === 'failed') status = 'partial';
    } finally {
      if (tempAbs && tempRel && tempId) {
        try {
          guard.check(tempAbs);
          const cur = fileStat(tempAbs, guard);
          if (cur.dev === tempId.dev && cur.ino === tempId.ino) fs.unlinkSync(tempAbs);
          await this.checkpoint.recordPostMutationAsync(turnId, tempRel, 'delete', { guard });
        } catch (_ignored) {
          recovery = 'unknown';
        }
      }
      this.active = false;
    }

    return {
      schemaVersion: 1,
      planId: stored.plan.planId,
      status,
      code,
      outputPath: stored.plan.outputPath,
      published,
      ...(outSha256 ? { sha256: outSha256, bytes: outBytes } : {}),
      sources: [...stored.plan.sources],
      recovery,
      checkpointStatus,
      ...(persistenceError ? { persistenceError } : {}),
      previewBaseline: 'chromium_108_restricted',
      warnings,
      limitations: [
        'HTML 看板无外部网络资源、无脚本执行，内置数据全部转义；查看基线为应用内 Chromium 108 受限预览。',
        '不承诺 Win7 任意外部默认浏览器与本看板 SVG/CSS 完全兼容。',
      ],
    };
  }
}
