/**
 * Tells a code listing apart from prose that merely sits in a `<pre>`.
 *
 * `<pre>` means "preformatted", not "source code". Judges and docs routinely
 * use it for input/output specifications, ASCII tables, and pseudocode — all
 * of which are written for a human and are worth translating. Actual source
 * code is not: translating identifiers or keywords would corrupt it.
 *
 * Immersive Translate settles this with a hand-maintained table (`PRE` sits in
 * its global `excludeTags`, and 44 individual site rules take it back out
 * again). A rule table is not reproducible here, so the decision is made from
 * the content itself: classify each line, then let the majority win.
 *
 * Ties go to "code", because translating a listing is a visible corruption
 * while leaving prose untranslated is merely a missed opportunity.
 */

/** Lines that only source code produces. */
const CODE_LINE_PATTERNS: RegExp[] = [
  // preprocessor / module directives
  /^\s*[#@]\s*(include|import|define|pragma|require|ifndef|endif|using)\b/i,
  /^\s*(?:from|import)\s+[\w.]+\s*(?:import\b|$)/,
  // declarations
  /^\s*(?:public|private|protected|static|final|abstract|const|let|var|def|fn|func|function|class|struct|interface|enum|impl|trait|namespace|package|module|type|template|typedef|export|async)\s+\S/,
  // a statement terminator or a brace doing structural work
  /[;{]\s*$/,
  /^\s*[}\])]+\s*[;,)]?\s*$/,
  // comments
  /^\s*(?:\/\/|\/\*|\*\/|\*\s|--\s|;;)/,
  // a shell prompt: "$ npm run build" reads as three plain words otherwise
  /^\s*[$>%]\s+\S/,
  // assignment, but not "x = y" prose like "let n = the number of nodes"
  /^\s*[\w.\[\]$]+\s*(?:[-+*/%|&^]|<<|>>)?=\s*[^=\s]/,
  // operators that essentially never appear in prose
  /(?:==|!=|<=>|&&|\|\||=>|->|::|\+\+|--|<<|>>|\+=|-=|\*=|\/=)/,
  // a call or index with no prose around it
  /^\s*[\w.]+\([^)]*\)\s*[;{]?\s*$/,
  /^\s*(?:for|while|if|elif|else if|switch|catch)\s*\([^)]*\)\s*\{?\s*$/,
];

/**
 * A line reads as prose when it carries enough plain words.
 *
 * Three is the threshold because two-word lines are overwhelmingly labels and
 * identifiers ("Return counter", "Push q"), which are ambiguous either way.
 */
const MIN_PROSE_WORDS = 3;

function isCodeLine(line: string): boolean {
  return CODE_LINE_PATTERNS.some((re) => re.test(line));
}

function proseWordCount(line: string): number {
  return line
    .split(/[\s,;:.]+/)
    .filter((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w) && w.length > 1).length;
}

export function looksLikeCode(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;

  // A single line has too little signal for a majority vote, so it is code
  // unless it reads as an unambiguous sentence.
  if (lines.length === 1) {
    const only = lines[0]!;
    return isCodeLine(only) || proseWordCount(only) < 5;
  }

  let code = 0;
  let prose = 0;
  for (const line of lines) {
    if (isCodeLine(line)) code++;
    else if (proseWordCount(line) >= MIN_PROSE_WORDS) prose++;
    // Anything else is ambiguous and abstains rather than skewing the vote.
  }

  if (!code && !prose) return true;
  return code >= prose;
}
