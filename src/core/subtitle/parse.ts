/**
 * Subtitle parsers.
 *
 * Players disagree about format — YouTube serves its own JSON, most HTML5
 * players use WebVTT, and a long tail ships TTML or SRT — but every one of them
 * reduces to the same list of timed cues, which is all the renderer needs.
 */

export interface Cue {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
  translation?: string;
}

export function parseSubtitle(body: string, url: string): Cue[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJson3(trimmed);
  if (/^WEBVTT/i.test(trimmed)) return parseVtt(trimmed);
  if (trimmed.startsWith('<')) return parseXml(trimmed);
  if (/^\d+\s*$/m.test(trimmed.split('\n')[0] ?? '') || /-->/.test(trimmed)) return parseSrt(trimmed);

  // Fall back on the extension when sniffing the body was inconclusive.
  if (/\.vtt/i.test(url)) return parseVtt(trimmed);
  return [];
}

/** YouTube's `/api/timedtext?fmt=json3` payload. */
function parseJson3(body: string): Cue[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }

  const events = (data as { events?: Json3Event[] })?.events;
  if (!Array.isArray(events)) return [];

  const cues: Cue[] = [];
  for (const event of events) {
    if (!event?.segs || typeof event.tStartMs !== 'number') continue;
    const text = event.segs
      .map((s) => s?.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    // Auto-generated tracks emit blank "rollup" events between real lines.
    if (!text || text === '\n') continue;
    const start = event.tStartMs / 1000;
    const duration = (event.dDurationMs ?? 4000) / 1000;
    cues.push({ start, end: start + duration, text });
  }
  return dedupe(cues);
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

function parseVtt(body: string): Cue[] {
  const cues: Cue[] = [];
  // Blocks are separated by blank lines; a block may carry an optional id line.
  for (const block of body.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const timeIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeIndex === -1) continue;
    const range = parseTimeRange(lines[timeIndex]!);
    if (!range) continue;
    const text = stripTags(lines.slice(timeIndex + 1).join(' '));
    if (text) cues.push({ ...range, text });
  }
  return dedupe(cues);
}

function parseSrt(body: string): Cue[] {
  return parseVtt(body);
}

/** TTML / DFXP, and YouTube's legacy `<transcript>` format. */
function parseXml(body: string): Cue[] {
  const doc = new DOMParser().parseFromString(body, 'text/xml');
  if (doc.querySelector('parsererror')) return [];

  const cues: Cue[] = [];

  for (const node of Array.from(doc.querySelectorAll('text'))) {
    const start = Number(node.getAttribute('start'));
    const dur = Number(node.getAttribute('dur') ?? 4);
    const text = decodeEntities(node.textContent ?? '');
    if (Number.isFinite(start) && text.trim()) {
      cues.push({ start, end: start + (Number.isFinite(dur) ? dur : 4), text: text.trim() });
    }
  }

  for (const node of Array.from(doc.querySelectorAll('p, span[begin]'))) {
    const begin = parseClock(node.getAttribute('begin'));
    const endAttr = parseClock(node.getAttribute('end'));
    const durAttr = parseClock(node.getAttribute('dur'));
    if (begin === undefined) continue;
    const end = endAttr ?? (durAttr !== undefined ? begin + durAttr : begin + 4);
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start: begin, end, text });
  }

  return dedupe(cues);
}

function parseTimeRange(line: string): { start: number; end: number } | undefined {
  const match = line.match(
    /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/,
  );
  if (!match) return undefined;
  const start = clock(match[1], match[2]!, match[3]!, match[4]!);
  const end = clock(match[5], match[6]!, match[7]!, match[8]!);
  return { start, end };
}

function clock(h: string | undefined, m: string, s: string, ms: string): number {
  const hours = h ? Number(h.replace(':', '')) : 0;
  return hours * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

/** TTML clock values: `00:01:02.500` or offsets like `12.5s`. */
function parseClock(value: string | null): number | undefined {
  if (!value) return undefined;
  const offset = value.match(/^([\d.]+)(h|m|s|ms)$/);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case 'h': return n * 3600;
      case 'm': return n * 60;
      case 'ms': return n / 1000;
      default: return n;
    }
  }
  const parts = value.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return undefined;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

/**
 * Auto-generated tracks repeat each line as it is built up word by word.
 * Keeping only the longest cue per start time turns that stutter into one
 * stable line, which is also what makes the translation cost sane.
 */
function dedupe(cues: Cue[]): Cue[] {
  const sorted = cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
  const out: Cue[] = [];
  for (const cue of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.start - cue.start) < 0.05) {
      if (cue.text.length > prev.text.length) out[out.length - 1] = cue;
      continue;
    }
    if (prev && prev.text === cue.text && cue.start - prev.end < 0.2) {
      prev.end = cue.end;
      continue;
    }
    out.push(cue);
  }
  return out;
}
