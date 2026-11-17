/**
 * @module a9-ignore
 * @description A9 工作区文件忽略规则与过滤 (PRD §5 A9-F01 / ADR-0089)
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.agent_recovery',
  'dist',
  'build',
  'bin',
  'obj',
]);

export interface IgnoreRuleWarning {
  rule: string;
  reason: string;
}

export interface IgnoreFilter {
  isIgnored(relativePath: string, isDirectory?: boolean): boolean;
  /** 编译失败而被跳过的规则（单条坏规则不影响其余规则与 list/search）。 */
  readonly warnings?: ReadonlyArray<IgnoreRuleWarning>;
}

const MAX_RULE_LENGTH = 512;
const MAX_WARNINGS = 20;

interface IgnoreRule {
  negate: boolean;
  matches(targetPath: string): boolean;
}

/**
 * 构建针对指定工作区的忽略规则过滤器
 */
export function createWorkspaceIgnoreFilter(workspaceRoot: string): IgnoreFilter {
  const rules: IgnoreRule[] = [];
  const warnings: IgnoreRuleWarning[] = [];

  const loadFile = (fileName: string): void => {
    const filePath = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(filePath)) return;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      recordWarning(warnings, fileName, `读取失败：${String((error as Error)?.message ?? error).slice(0, 200)}`);
      return;
    }
    for (const line of parseIgnoreLines(content)) {
      try {
        rules.push(compileIgnoreRule(line));
      } catch (error) {
        recordWarning(warnings, line, `规则无法编译，已跳过：${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
  };

  // 读取 .gitignore 与 .agentignore（后者在后，同一路径上后出现的规则优先）
  loadFile('.gitignore');
  loadFile('.agentignore');

  return {
    warnings,
    isIgnored(relativePath: string, _isDirectory?: boolean): boolean {
      const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!normalized || normalized === '.') return false;

      const segments = normalized.split('/');
      for (const segment of segments) {
        if (DEFAULT_IGNORED_NAMES.has(segment)) return true;
      }

      let ignored = false;
      for (const rule of rules) {
        if (rule.matches(normalized)) ignored = !rule.negate;
      }
      return ignored;
    },
  };
}

function recordWarning(warnings: IgnoreRuleWarning[], rule: string, reason: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push({ rule: rule.slice(0, 120), reason });
  process.emitWarning(`A9 ignore rule skipped: ${rule.slice(0, 120)} (${reason})`, {
    type: 'A9IgnoreRuleWarning',
    code: 'A9_IGNORE_RULE_INVALID',
  });
}

function parseIgnoreLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * glob 编译后的指令序列。语义与此前的 glob→RegExp 完全一致：`**` 跨目录，`*` 与 `?` 不跨 `/`，
 * `[...]`/`[!...]` 字符类，`**\/` 表示零或多层目录；未闭合的 `[` 按字面处理。
 *
 * 为避免 `*a*a*a*…*b` 之类规则在回溯正则引擎上产生灾难性回溯（ReDoS，P2-3），不再生成正则，
 * 而是用 Thompson NFA 状态集模拟匹配：单次匹配时间 O(路径长度 × 规则指令数)，与规则结构无关。
 */
const enum Op {
  Char,
  /** `*`：可匹配空串，循环消费任意非 `/` 码元。 */
  Star,
  /** `**`：可匹配空串，循环消费任意（非行终止符）码元。 */
  GlobStar,
  /** `**\/` 的入口：空转移到“跳过”（i+2）或进入目录循环（i+1）。 */
  DirFork,
  /** `**\/` 的循环：消费任意（非行终止符）码元并留在原地，消费 `/` 后进入 i+1。 */
  DirLoop,
}

interface GlobInstruction {
  op: Op;
  /** 仅 Op.Char：判断单个 UTF-16 码元是否匹配。 */
  test?: (ch: string) => boolean;
}

const GLOBSTAR_LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

function compileGlobProgram(glob: string): GlobInstruction[] {
  const program: GlobInstruction[] = [];
  let lastWildcard: Op | undefined;
  const pushWildcard = (op: Op): void => {
    // 连续同类通配符等价于一个，合并以缩小状态集。
    if (lastWildcard === op) return;
    lastWildcard = op;
    if (op === Op.DirFork) {
      program.push({ op: Op.DirFork }, { op: Op.DirLoop });
    } else {
      program.push({ op });
    }
  };
  const pushChar = (test: (ch: string) => boolean): void => {
    lastWildcard = undefined;
    program.push({ op: Op.Char, test });
  };
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      let j = i;
      while (glob[j] === '*') j += 1;
      if (j - i >= 2) {
        if ((i === 0 || glob[i - 1] === '/') && glob[j] === '/') {
          pushWildcard(Op.DirFork);
          i = j + 1;
        } else {
          pushWildcard(Op.GlobStar);
          i = j;
        }
      } else {
        pushWildcard(Op.Star);
        i = j;
      }
      continue;
    }
    if (ch === '?') {
      pushChar((c) => c !== '/');
      i += 1;
      continue;
    }
    if (ch === '[') {
      let k = i + 1;
      let negate = false;
      if (glob[k] === '!' || glob[k] === '^') { negate = true; k += 1; }
      const bodyStart = k;
      if (glob[k] === ']') k += 1;
      while (k < glob.length && glob[k] !== ']') k += 1;
      if (k >= glob.length) {
        pushChar((c) => c === '[');
        i += 1;
        continue;
      }
      const body = glob.slice(bodyStart, k).replace(/[\\\]\[^]/g, '\\$&');
      // 非法范围（如 [z-a]）在此抛出，由调用方按“规则无法编译”跳过。
      const classRegex = new RegExp(`^[${negate ? '^' : ''}${body}]$`);
      pushChar((c) => classRegex.test(c));
      i = k + 1;
      continue;
    }
    pushChar((c) => c === ch);
    i += 1;
  }
  return program;
}

/**
 * 在 `target` 上搜索 glob：`anchored` 时从开头起匹配，否则可从开头或任意 `/` 之后起匹配；
 * 匹配必须结束在 `/` 之前或字符串末尾（与旧正则 `(?:^|/)…(?:/|$)` 等价）。
 */
function createGlobMatcher(program: GlobInstruction[], anchored: boolean): (target: string) => boolean {
  const accept = program.length;
  const marks = new Int32Array(accept + 1);
  let stamp = 0;
  let current: number[] = [];
  let next: number[] = [];

  // 加入状态并沿空转移展开（栈深不超过指令数）。
  const add = (list: number[], state: number): void => {
    if (marks[state] === stamp) return;
    marks[state] = stamp;
    list.push(state);
    if (state >= accept) return;
    switch (program[state].op) {
      case Op.Star:
      case Op.GlobStar:
        add(list, state + 1);
        break;
      case Op.DirFork:
        add(list, state + 1);
        add(list, state + 2);
        break;
      default:
        break;
    }
  };

  return (target: string): boolean => {
    const length = target.length;
    // P1-1 防护：Int32Array 在 2^31-1 处会回绕为负数导致去重标记失效；
    // 在接近上限时重置 marks 并将 stamp 归零，保证长时间运行后状态集去重依然有效。
    if (stamp >= 0x7fff0000) {
      marks.fill(0);
      stamp = 0;
    }
    stamp += 1;
    current.length = 0;
    add(current, 0);
    for (let pos = 0; ; pos += 1) {
      if (marks[accept] === stamp && (pos === length || target[pos] === '/')) return true;
      // 非锚定规则可在任意 `/` 之后重新开始，因此只有锚定规则才能在状态集为空时提前结束。
      if (pos >= length || (anchored && current.length === 0)) return false;
      const ch = target[pos];
      stamp += 1;
      next.length = 0;
      for (const state of current) {
        if (state >= accept) continue;
        const instruction = program[state];
        switch (instruction.op) {
          case Op.Char:
            if (instruction.test!(ch)) add(next, state + 1);
            break;
          case Op.Star:
            if (ch !== '/') add(next, state);
            break;
          case Op.GlobStar:
            if (!GLOBSTAR_LINE_TERMINATOR.test(ch)) add(next, state);
            break;
          case Op.DirLoop:
            if (!GLOBSTAR_LINE_TERMINATOR.test(ch)) add(next, state);
            if (ch === '/') add(next, state + 1);
            break;
          default:
            break;
        }
      }
      if (!anchored && ch === '/') add(next, 0);
      const swap = current; current = next; next = swap;
    }
  };
}

function compileIgnoreRule(line: string): IgnoreRule {
  if (line.length > MAX_RULE_LENGTH) throw new Error(`规则长度超过 ${MAX_RULE_LENGTH} 字符`);
  let pattern = line;
  let negate = false;
  if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  let cleanPattern = pattern.replace(/\\/g, '/');
  if (cleanPattern.endsWith('/')) {
    cleanPattern = cleanPattern.slice(0, -1);
  }
  if (!cleanPattern) throw new Error('规则为空');

  const anchored = cleanPattern.startsWith('/');
  if (anchored) cleanPattern = cleanPattern.slice(1);
  if (!cleanPattern) throw new Error('规则为空');

  if (!/[*?[]/.test(cleanPattern)) {
    if (anchored) {
      return { negate, matches: (target) => target === cleanPattern || target.startsWith(cleanPattern + '/') };
    }
    return {
      negate,
      matches: (target) => target === cleanPattern || target.endsWith('/' + cleanPattern) || target.includes('/' + cleanPattern + '/'),
    };
  }

  const matcher = createGlobMatcher(compileGlobProgram(cleanPattern), anchored);
  return { negate, matches: matcher };
}
