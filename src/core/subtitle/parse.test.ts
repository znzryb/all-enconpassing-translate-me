import { describe, expect, it } from 'vitest';
import { parseSubtitle } from './parse';

describe('WebVTT', () => {
  it('parses cues with and without ids', () => {
    const cues = parseSubtitle(
      `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello there.

00:00:04.000 --> 00:00:06.000
General Kenobi.`,
      'https://example.com/track.vtt',
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 3.5, text: 'Hello there.' });
    expect(cues[1]!.text).toBe('General Kenobi.');
  });

  it('handles short timestamps and inline tags', () => {
    const cues = parseSubtitle(
      `WEBVTT

01:02.000 --> 01:04.000
<v Speaker>Some <b>bold</b> text`,
      'x.vtt',
    );
    expect(cues[0]).toMatchObject({ start: 62, end: 64, text: 'Some bold text' });
  });
});

describe('YouTube json3', () => {
  it('joins segments into one line', () => {
    const cues = parseSubtitle(
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
          { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: '\n' }] },
          { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'Second line' }] },
        ],
      }),
      'https://www.youtube.com/api/timedtext?fmt=json3',
    );
    expect(cues.map((c) => c.text)).toEqual(['Hello world', 'Second line']);
    expect(cues[0]).toMatchObject({ start: 0, end: 2 });
  });

  it('collapses the word-by-word stutter of auto-generated tracks', () => {
    const cues = parseSubtitle(
      JSON.stringify({
        events: [
          { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'the quick' }] },
          { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'the quick brown fox' }] },
          { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'jumps over' }] },
        ],
      }),
      'timedtext',
    );
    expect(cues.map((c) => c.text)).toEqual(['the quick brown fox', 'jumps over']);
  });
});

describe('XML tracks', () => {
  it('parses YouTube legacy transcripts with entities', () => {
    // YouTube double-encodes: the XML entity yields `&amp;`, which is itself an
    // HTML entity for `&`. Both layers have to come off or captions read
    // "Tom &amp; Jerry" on screen.
    const cues = parseSubtitle(
      `<?xml version="1.0"?><transcript>` +
        `<text start="0.5" dur="2">Tom &amp;amp; Jerry</text>` +
        `<text start="3" dur="2">Second</text></transcript>`,
      'timedtext',
    );
    expect(cues[0]).toMatchObject({ start: 0.5, end: 2.5, text: 'Tom & Jerry' });
    expect(cues).toHaveLength(2);
  });

  it('parses TTML clock values', () => {
    const cues = parseSubtitle(
      `<tt><body><div><p begin="00:00:02.000" end="00:00:05.000">Line one</p></div></body></tt>`,
      'x.ttml',
    );
    expect(cues[0]).toMatchObject({ start: 2, end: 5, text: 'Line one' });
  });
});

describe('robustness', () => {
  it('returns nothing for junk instead of throwing', () => {
    expect(parseSubtitle('', 'x')).toEqual([]);
    expect(parseSubtitle('{"bad json', 'x')).toEqual([]);
    expect(parseSubtitle('<html><body>404</body></html>', 'x')).toEqual([]);
    expect(parseSubtitle('random text body', 'x')).toEqual([]);
  });
});
