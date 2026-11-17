import { TextDecoder } from 'util';

export type OutputEncoding = 'utf-8' | 'cp936' | 'utf-16le';
/**
 * Node 侧解码模式。`auto`：先严格 UTF-8，失败再回退 CP936（H-P2-04）。
 * 仅用于 SafeOutputStream；原生 helper 协议的 outputEncoding 仍只接受 OutputEncoding。
 */
export type StreamDecodeEncoding = OutputEncoding | 'auto';
export interface ShellOutputChunk {
  requestId: string;
  stream: 'stdout' | 'stderr';
  outputSeq: number;
  sourceSeqThrough: number;
  text: string;
  rawBytesRead: number;
  truncated: boolean;
  warning?: 'redaction_boundary' | 'A9_OUTPUT_ENCODING_ERROR';
}

const MARK = '***redacted***';
const BOUND = 64 * 1024;
// Keep complete private-key header literals out of the packaged source payload.
const PEM_HEADERS = ['', 'RSA ', 'EC ', 'OPENSSH '].map((kind) => '-----BEGIN ' + kind + 'PRIVATE KEY-----');
const KEYS = ['authorization', 'bearer', 'api_key', 'apikey', 'api-key', 'access_token', 'access-token',
  'token', 'password', 'passwd', 'secret', 'credential', 'client_secret', 'private_key'];

/** Frozen secret variants; never retain an unbounded or changing secret set. */
export function secretVariants(values: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    variants.add(value);
    const bases: string[] = [];
    for (const encoding of ['utf8', 'utf16le'] as const) {
      const base = Buffer.from(value, encoding).toString('base64');
      bases.push(base, base.replace(/=+$/, ''), base.replace(/\+/g, '-').replace(/\//g, '_'), base.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    }
    for (const source of [value, ...bases]) {
      variants.add(source);
      const escaped = encodeURIComponent(source);
      for (const v of [escaped, escaped.toLowerCase(), escaped.toUpperCase(), escaped.replace(/%[0-9A-F]{2}/g, (s) => s.toLowerCase())]) {
        variants.add(v); variants.add(v.replace(/%20/gi, '+'));
      }
      const allEscaped = Array.from(Buffer.from(source, 'utf8')).map((b) => '%' + b.toString(16).padStart(2, '0')).join('');
      variants.add(allEscaped); variants.add(allEscaped.toUpperCase());
    }
  }
  const result = [...variants];
  if (result.reduce((n, s) => n + Buffer.byteLength(s), 0) > BOUND) throw new Error('A9_OUTPUT_SECRET_SET_LIMIT');
  return result.sort((a, b) => b.length - a.length);
}

/** Incremental, conservative projection. Potential keys, URLs and secret prefixes stay private. */
/** 返回 data 中不以不完整 UTF-8 序列结尾的最长前缀长度。 */
function completeUtf8Prefix(data: Buffer): number {
  const len = data.length;
  for (let i = len - 1; i >= Math.max(0, len - 3); i -= 1) {
    const b = data[i];
    if ((b & 0xc0) === 0x80) continue;
    if (b >= 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      return len - i < need ? i : len;
    }
    return len;
  }
  return len;
}

export class SafeOutputStream {
  private readonly decoder?: TextDecoder;
  private readonly auto: boolean;
  private autoGbk?: TextDecoder;
  private autoCarry: Buffer = Buffer.alloc(0);
  private autoSawNonAscii = false;
  private pending = '';
  private mode: 'text' | 'value' | 'url' | 'separator' | 'header' | 'pem' = 'text';
  private separatorHeader = false;
  private valueQuote: string | undefined;
  private quoteEscape = false;
  private failed = false;
  private ended = false;
  private atStart = true;
  private readonly prefixLimit: number;
  private readonly normalizedSecrets: readonly string[];
  warning?: ShellOutputChunk['warning'];
  constructor(encoding: StreamDecodeEncoding, private readonly secrets: readonly string[], private readonly redact: (s: string) => string) {
    this.auto = encoding === 'auto';
    if (!this.auto) this.decoder = new TextDecoder(encoding === 'cp936' ? 'gbk' : encoding, { fatal: true });
    this.normalizedSecrets = secrets.map((s) => s.replace(/%[0-9a-f]{1,2}/gi, (p) => p.toUpperCase()));
    this.prefixLimit = Math.max(32, ...secrets.map((s) => s.length));
  }
  push(bytes: Buffer): string {
    if (this.ended) throw new Error('A9_OUTPUT_AFTER_EOF');
    if (this.failed) return '';
    try { return this.consume(this.decodeChunk(bytes, false), false); }
    catch (_error) { this.failed = true; this.pending = ''; this.warning = 'A9_OUTPUT_ENCODING_ERROR'; return ''; }
  }
  finish(): string {
    if (this.ended) return '';
    this.ended = true;
    if (this.failed) return '';
    try { return this.consume(this.decodeChunk(Buffer.alloc(0), true), true); }
    catch (_error) { this.failed = true; this.pending = ''; this.warning = 'A9_OUTPUT_ENCODING_ERROR'; return ''; }
  }
  /** 实际采用的编码；`auto` 在尚未见到非 ASCII 字节时为 undefined。 */
  get detectedEncoding(): 'utf-8' | 'gbk' | undefined {
    if (!this.auto) return undefined;
    return this.autoGbk ? 'gbk' : this.autoSawNonAscii ? 'utf-8' : undefined;
  }
  private decodeChunk(bytes: Buffer, final: boolean): string {
    if (!this.auto) return final ? this.decoder!.decode() : this.decoder!.decode(bytes, { stream: true });
    if (this.autoGbk) return this.autoGbk.decode(bytes, { stream: !final });
    const data = this.autoCarry.length > 0 ? Buffer.concat([this.autoCarry, bytes]) : bytes;
    const cut = final ? data.length : completeUtf8Prefix(data);
    const complete = data.subarray(0, cut);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(complete);
      this.autoCarry = Buffer.from(data.subarray(cut));
      if (!this.autoSawNonAscii && complete.some((b) => b >= 0x80)) this.autoSawNonAscii = true;
      return text;
    } catch (_notUtf8) {
      // 严格 UTF-8 失败：此前已输出的文本均为合法 UTF-8，剩余字节按 CP936 解码。
      this.autoGbk = new TextDecoder('gbk', { fatal: true });
      this.autoCarry = Buffer.alloc(0);
      return this.autoGbk.decode(data, { stream: !final });
    }
  }
  private consume(text: string, eof: boolean): string {
    if (this.atStart && text) { this.atStart = false; text = text.replace(/^\uFEFF/, ''); }
    this.pending += text;
    let out = '';
    while (this.pending) {
      if (this.mode === 'pem') {
        const end = /-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.exec(this.pending);
        if (!end) { this.pending = eof ? '' : this.pending.slice(-64); break; }
        this.pending = this.pending.slice(end.index + end[0].length); this.mode = 'text'; continue;
      }
      const pem = PEM_HEADERS.find((h) => this.pending.startsWith(h));
      if (pem) { out += MARK; this.pending = this.pending.slice(pem.length); this.mode = 'pem'; continue; }
      if (!eof && PEM_HEADERS.some((h) => h.startsWith(this.pending))) break;
      if (this.mode === 'value' || this.mode === 'url' || this.mode === 'header') {
        let boundary: number;
        if (this.mode === 'value' && this.valueQuote) {
          boundary = -1;
          for (let i = 0; i < this.pending.length; i++) {
            const c = this.pending[i];
            if (this.quoteEscape) { this.quoteEscape = false; continue; }
            if (c === '\\') { this.quoteEscape = true; continue; }
            if (c === this.valueQuote) { boundary = i; break; }
          }
        } else {
          boundary = this.pending.search(this.mode === 'header' ? /[\r\n]/ : this.mode === 'url' ? /[\s<>"']/ : /[\r\n&;,<>"']/);
        }
        if (boundary < 0) { this.pending = ''; break; }
        this.pending = this.pending.slice(boundary);
        this.mode = 'text';
        continue;
      }
      if (this.mode === 'separator') {
        // Hold whitespace and quotes after a credential key until its delimiter/value is known.
        const m = this.pending.match(/^[\s"':=]+/);
        if (m) {
          for (const c of m[0]) {
            if (c === ':' || c === '=') this.valueQuote = undefined;
            if (c === '"' || c === "'") this.valueQuote = c;
          }
          out += m[0]; this.pending = this.pending.slice(m[0].length);
          if (!this.pending) break;
        }
        this.mode = this.separatorHeader ? 'header' : 'value'; out += MARK; continue;
      }
      const normalizeEscapes = (s: string) => s.replace(/%[0-9a-f]{1,2}/gi, (part) => part.toUpperCase());
      const normalized = normalizeEscapes(this.pending.slice(0, this.prefixLimit));
      const secret = this.normalizedSecrets.find((s) => normalized.startsWith(s));
      if (secret) { out += MARK; this.pending = this.pending.slice(secret.length); continue; }
      const lower = this.pending.slice(0, 32).toLowerCase();
      const key = KEYS.find((k) => lower.startsWith(k) && (lower.length === k.length || /[\s"':=]/.test(lower[k.length])));
      if (key) {
        if (!eof && lower.length === key.length) break;
        out += this.pending.slice(0, key.length); this.pending = this.pending.slice(key.length); this.separatorHeader = key === 'authorization'; this.valueQuote = undefined; this.quoteEscape = false; this.mode = 'separator'; continue;
      }
      if (/^https?:\/\//i.test(this.pending)) {
        // URL authority/query may carry credentials. Mask the entire URL rather than leak a prefix.
        out += MARK; this.mode = 'url'; continue;
      }
      const candidates = [...KEYS, 'http://', 'https://', ...PEM_HEADERS.map((h) => h.toLowerCase())];
      if (!eof && (this.normalizedSecrets.some((s) => s.startsWith(normalized)) || candidates.some((s) => s.startsWith(lower)) || /^%(?:[0-9a-f]?)$/i.test(this.pending))) break;
      // At EOF unresolved secret/key prefixes are conservatively masked.
      if (eof && (this.normalizedSecrets.some((s) => s.startsWith(normalized)) || candidates.some((s) => s.startsWith(lower)))) { out += MARK; this.pending = ''; break; }
      out += this.pending[0]; this.pending = this.pending.slice(1);
    }
    if (Buffer.byteLength(this.pending) >= BOUND) { this.pending = ''; this.mode = 'value'; this.warning = 'redaction_boundary'; out += MARK; }
    return this.redact(out);
  }
}
