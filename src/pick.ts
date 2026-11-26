/**
 * Choosing which moments to clip when no agent is in the loop (scheduled
 * watches). Best first: an AI pass through the local Claude Code CLI, then a
 * free transcript heuristic.
 *
 * The bar is "would a stranger scrolling past watch this to the end?", not
 * "is this a complete idea?". The AI lists more candidates than needed, scores
 * them harshly, and anything under MIN_SCORE is dropped: a boring clip is
 * worse than no clip.
 */
import { spawn } from "node:child_process";
import { formatTime, resolveCommand, type TranscriptSegment, type Word } from "./core.js";

export interface Moment {
  start: number;
  end: number;
  /** Header text. AI picks write their own; others fall back to the video title. */
  hook?: string;
  why?: string;
  /** AI picks only: 1-10, how likely a stranger scrolling past watches to the end. */
  score?: number;
  /** AI picks only: what makes it work (humor, conflict, surprise, story, emotion, quote). */
  kind?: string;
  /** AI picks only: post description to paste when uploading (clipswarm appends the source credit). */
  description?: string;
  /** AI picks only: the exact first / last words spoken, used to snap the cut to word timings. */
  firstWords?: string;
  lastWords?: string;
}

/** AI candidates scoring below this are dropped. */
export const MIN_SCORE = 7;

/** Longest clip the AI may pick for a given target length. */
export function maxClipSec(clipSec: number): number {
  return Math.max(60, Math.round(clipSec * 1.5));
}

// ---------- AI picker (Claude Code CLI) ----------

let claudeAvailable: Promise<boolean> | undefined;

export function hasClaudeCli(): Promise<boolean> {
  claudeAvailable ??= Promise.resolve(resolveCommand("claude") !== undefined);
  return claudeAvailable;
}

function runClaude(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // No tools, no MCP servers, no saved session: a single pure-text answer.
    // npm installs `claude` as a .cmd shim on Windows, which Node can only launch via a shell.
    // All args are constants (the prompt goes over stdin), so the shell is safe here.
    const bin = resolveCommand("claude") ?? "claude";
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    const p = spawn(
      shell ? `"${bin}"` : bin,
      ["-p", "--output-format", "json", "--tools", shell ? '""' : "", "--strict-mcp-config", "--no-session-persistence"],
      { stdio: ["pipe", "pipe", "pipe"], shell },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error(`claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(-300)}`));
      try {
        const parsed = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (parsed.is_error) return reject(new Error(`claude error: ${parsed.result}`));
        resolve(parsed.result ?? "");
      } catch {
        resolve(out);
      }
    });
    p.stdin.end(prompt);
  });
}

/** Transcript characters per AI call (~25k tokens). Longer videos are split into parts. */
const PROMPT_BUDGET = 100_000;
const lineOf = (s: TranscriptSegment) => `[${Math.round(s.start)}] ${s.text}`;

export function buildPickPrompt(
  title: string,
  segs: TranscriptSegment[],
  duration: number,
  count: number,
  clipSec: number,
  peaks: number[] = [],
  part?: { index: number; total: number },
): string {
  // pickWithAI splits long transcripts into parts first; this only guards direct callers.
  let lines = segs.map(lineOf);
  while (lines.length > 1 && lines.join("\n").length > PROMPT_BUDGET) lines = lines.filter((_, i) => i % 2 === 0);
  if (lines.join("\n").length > PROMPT_BUDGET) lines = [lines[0].slice(0, PROMPT_BUDGET)];
  const pool = Math.max(5, count * 3);
  const span =
    part && segs.length
      ? ` You're reading part ${part.index} of ${part.total}, from ${formatTime(segs[0].start)} to ${formatTime(segs[segs.length - 1].end)}.`
      : "";
  // Hook rules adapted from github.com/Shoberman2/marketing-rules (MIT): on-screen text readable with
  // sound off, moderate concreteness, specific and true, no AI tells.
  return `You are a short-form video editor picking clips for TikTok, Reels and Shorts. The only goal: a stranger scrolling past stops and watches to the end. Being informative is not enough. Most moments in most videos are boring, so be picky.

Video: "${title}" (${formatTime(duration)} long).${span}
${peaks.length ? `YouTube's "most replayed" peaks (seconds): ${peaks.map(Math.round).join(", ")}. Viewers rewound there, so look closely, but judge those spots by the rules below like any other moment: rewinds often just mean a chart, a skipped intro or a dense explanation.\n` : ""}
A clip stops the scroll when it has at least one of these:
- humor: a joke, a roast, banter, someone cracking up ([laughter] in the transcript is a strong sign)
- conflict: a disagreement, pushback, someone getting called out, a hot take people will argue about
- surprise: a counterintuitive claim, a shocking number, a reveal or a twist
- story: a personal anecdote with stakes (money, failure, fear, embarrassment, danger) and a payoff
- emotion: anger, excitement, vulnerability, a big reaction
- quote: a line people would repeat or share
- insight: something new to learn that a viewer would repeat to a friend: a counterintuitive fact, a number that reframes something, a trick they can use this week. It has to be surprising and concrete and land inside the clip; a textbook explanation is not an insight.

Skip moments like these, even when the content is important:
- explaining how something works with no surprise in it, definitions, history, lists, frameworks, product specs
- generic advice or vague optimism ("it's important to...", "the future is exciting")
- anything that needs earlier context, or says "he", "that" or "this" without making clear who or what
- a slow wind-up, a long question from the host, or a clip that ends before the payoff

Editing rules:
- Payoff first: find the payoff (the laugh, the reversal, the reveal, the quotable line), then keep only the set-up a stranger needs to get it. If the best line comes early and what follows is weaker, end on it.
- Cold open: start at the beginning of the sentence that hooks, never mid-sentence. Cut "so", "um", "yeah", "you know", the set-up and the throat-clearing before it. Keep the host's question only if it is one short sentence the answer needs.
- End right after the payoff lands: the punchline, the laugh, the last word of the reveal. Don't trail into more reactions, a recap or the next topic.
- Length follows the moment: 15 to ${maxClipSec(clipSec)} seconds, ideally ${clipSec} or less. Shorter is better when the payoff lands sooner.
- Clips must not overlap. Skip intros, sponsor reads, "like and subscribe" and outros.

Score every candidate from 1 to 10 for "would a stranger watch this to the end, and would someone send it to a friend?":
9-10: could go viral on its own. 7-8: strong, clearly worth posting. 5-6: fine, but most people swipe away. 1-4: boring.
Be harsh. Most moments score 3 to 5. Only a clip with a real hook in its first 3 seconds AND a payoff (a laugh, a reveal or a genuine "I didn't know that") earns 7 or more.

List up to ${pool} candidates, best first. If there are fewer strong moments, list fewer; an empty array is a fine answer for a boring video.

For each candidate:
- start / end: seconds, from the line times below
- first_words / last_words: the exact first and last 4 to 6 words of the clip, copied from the transcript
- kind: humor, conflict, surprise, story, emotion, quote or insight
- hook: the on-screen header (rules below)
- description: the post text to paste under the video (rules below)
- why: one short reason it works

Hook header rules:
- It's read in about a second with the sound off: aim for 6 words or fewer, never more than 10.
- Name the real subject and the stakes, and hold back the twist or the answer for the clip. Never give away the payoff, and never a vague tease like "You won't believe this".
- Be specific: a name, a number or a physical detail from the clip beats an adjective.
- Stack two pulls where you can: a curiosity gap, a broken expectation, a hard number, a scene, stakes or a loss, something useful.
- The clip must fully deliver what the header promises: no exaggeration, no question the clip never answers.
- Sound like a person: no "Not X, it's Y", no colon reveals ("The secret: ..."), no question that answers itself, no "Here's why", "Hot take" or "Wait for it", and no em dashes, emoji, hashtags or quotes around it.
- Don't repeat the video title. Try a few versions and keep the sharpest true one.

Description rules:
- One or two short sentences, under 150 characters. The first sentence must work on its own, because feeds cut the rest off.
- Add what the header doesn't say: who is talking and the context or stakes a stranger needs. Don't repeat the header, and don't give away the payoff.
- Only claims the clip itself supports. Never invent numbers, quotes or outcomes.
- No engagement bait ("follow for more", "comment below", "tag a friend", "like if you agree"), no hashtags, emoji or em dashes, and none of the AI tells above.
- Don't credit the source; clipswarm adds the credit line itself.

Transcript (each line starts with its time in seconds; ">>" marks a new speaker; [laughter] and [applause] are sounds):
${lines.join("\n")}

Reply with ONLY a JSON array, no prose:
[{"start": <seconds>, "end": <seconds>, "first_words": "<exact words>", "last_words": "<exact words>", "kind": "<kind>", "score": <whole number from 1 to 10>, "hook": "<header text>", "description": "<post text>", "why": "<one short reason>"}]`;
}

/** Splits a long transcript into consecutive parts that each fit one prompt, overlapping so no moment is cut in half. */
export function chunkSegments(segs: TranscriptSegment[], budget = PROMPT_BUDGET, overlapSec = 60): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  let i = 0;
  while (i < segs.length) {
    let len = 0;
    let j = i;
    while (j < segs.length && len + lineOf(segs[j]).length + 1 <= budget) len += lineOf(segs[j++]).length + 1;
    if (j === i) j = i + 1;
    chunks.push(segs.slice(i, j));
    if (j >= segs.length) break;
    let k = j;
    while (k > i + 1 && segs[k - 1].start > segs[j].start - overlapSec) k--;
    i = k;
  }
  return chunks;
}

/** The JSON array in a model reply, or undefined if there isn't a valid one. */
function extractArray(text: string): unknown[] | undefined {
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  if (!json) return undefined;
  try {
    const raw: unknown = JSON.parse(json);
    return Array.isArray(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** A 0-10 score from a number or a plain numeric string; anything else (ranges, arrays, 80) is no score. */
function parseScore(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
}

/**
 * Tidies a header hook or post description: drops what the house rules ban
 * and the renderer can't draw (em dashes, hashtags, emoji, wrapping quotes). Number ranges like
 * "1990–2000" keep their dash.
 */
export function cleanHook(s: string): string {
  return s
    .replace(/\s*—\s*|\s+–\s+/g, ", ")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[\s,]+$/, "")
    .trim();
}

/**
 * Validates the model's JSON: numbers, min length and, unless `keepOverlaps`,
 * no overlaps (earlier-listed candidates win).
 */
export function parsePicks(text: string, duration: number, opts: { keepOverlaps?: boolean } = {}): Moment[] {
  const raw = extractArray(text);
  if (!raw) return [];
  const picks: Moment[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const start = Number(r.start);
    const end = Number(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 5 || start < 0) continue;
    const m: Moment = { start, end: Math.min(end, duration || end) };
    if (typeof r.hook === "string" && cleanHook(r.hook)) m.hook = cleanHook(r.hook);
    if (typeof r.why === "string") m.why = r.why;
    if (typeof r.description === "string" && cleanHook(r.description)) m.description = cleanHook(r.description);
    const score = parseScore(r.score);
    if (score !== undefined) m.score = score;
    if (typeof r.kind === "string" && r.kind.trim()) m.kind = r.kind.trim().toLowerCase();
    if (typeof r.first_words === "string" && r.first_words.trim()) m.firstWords = r.first_words.trim();
    if (typeof r.last_words === "string" && r.last_words.trim()) m.lastWords = r.last_words.trim();
    if (opts.keepOverlaps || !picks.some((p) => m.start < p.end && m.end > p.start)) picks.push(m);
  }
  return picks.sort((a, b) => a.start - b.start);
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Moves a pick's edges onto the exact words the model quoted (first_words /
 * last_words), so the clip opens on the hook and stops right after the payoff
 * instead of on whole-second line times. Leaves an edge alone if the quote
 * can't be found within `windowSec` of it.
 */
export function snapToWords(m: Moment, words: Word[], windowSec = 20): Moment {
  if (!words.length || (!m.firstWords && !m.lastWords)) return m;
  const flat: { tok: string; w: number }[] = [];
  words.forEach((w, wi) => tokens(w.text).forEach((tok) => flat.push({ tok, w: wi })));

  // Index into `words` of the first (or last) word of the quote nearest to `near`.
  const find = (quote: string | undefined, near: number, atEnd: boolean): number | undefined => {
    const want = tokens(quote ?? "");
    // Compare up to 8 words so repeated openings ("I never told anyone about...") resolve to the right spot.
    const k = Math.min(want.length, 8);
    if (k < 2) return undefined;
    const target = atEnd ? want.slice(-k) : want.slice(0, k);
    let best: { w: number; hits: number; dist: number } | undefined;
    for (let i = 0; i + k <= flat.length; i++) {
      const w = atEnd ? flat[i + k - 1].w : flat[i].w;
      const dist = Math.abs((atEnd ? words[w].end : words[w].start) - near);
      if (dist > windowSec) continue;
      let hits = 0;
      for (let j = 0; j < k; j++) if (flat[i + j].tok === target[j]) hits++;
      if (hits < k - Math.floor(k / 4)) continue; // a misheard word or two is fine on longer quotes
      if (!best || hits > best.hits || (hits === best.hits && dist < best.dist)) best = { w, hits, dist };
    }
    return best?.w;
  };

  const a = find(m.firstWords, m.start, false);
  const b = find(m.lastWords, m.end, true);
  let start = m.start;
  let end = m.end;
  if (a !== undefined) {
    const prev = words[a - 1];
    start = Math.max(0, words[a].start - 0.1, prev ? prev.end : 0); // never include the previous word
  }
  if (b !== undefined) {
    const w = words[b];
    const next = words[b + 1];
    // Caption word ends run to the next word's start, which can be after a long pause.
    const wordEnd = Math.min(w.end, w.start + 1.5);
    end = wordEnd + 0.25;
    if (next) end = Math.max(wordEnd, Math.min(end, next.start)); // never include the next word
  }
  return end - start >= 5 ? { ...m, start, end } : m;
}

/** Words that pad the start of a clip without saying anything. */
const FILLER = new Set(["and", "so", "uh", "um", "uhm", "erm", "yeah", "well", "okay", "ok", "like"]);
const FILLER_PAIRS = new Set(["you know", "for example", "i mean"]);

/**
 * Moves a clip's start past leading filler ("And so, uh, they found...",
 * "For example, I now know...") so it opens on real words. Shifts at most 3s.
 */
export function trimLeadingFiller(m: Moment, words: Word[]): Moment {
  let i = words.findIndex((w) => w.start >= m.start - 0.05);
  if (i < 0) return m;
  const first = i;
  for (let n = 0; n < 5 && i < words.length; n++) {
    const t = tokens(words[i].text).join(" ");
    const pair = i + 1 < words.length ? `${t} ${tokens(words[i + 1].text).join(" ")}` : "";
    if (FILLER_PAIRS.has(pair)) i += 2;
    else if (FILLER.has(t)) i += 1;
    else break;
  }
  if (i === first || i >= words.length || words[i].start - m.start > 3) return m;
  const start = Math.max(words[i].start - 0.1, words[i - 1].end);
  return m.end - start >= 8 ? { ...m, start } : m;
}

/** Picks closer than this are treated as the same stretch of the video. */
const MIN_GAP_SEC = 30;

/**
 * Keeps the strongest candidates that clear `minScore`, in time order. Picks
 * stay at least MIN_GAP_SEC apart, and on equal scores a kind of moment not
 * picked yet wins, so three clips aren't three beats of the same story.
 */
export function selectBest(cands: Moment[], count: number, clipSec: number, minScore = MIN_SCORE): Moment[] {
  const max = maxClipSec(clipSec) + 10;
  const ok = cands
    .filter((m) => (m.score ?? 0) >= minScore && m.end - m.start >= 8 && m.end - m.start <= max)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const near = (a: Moment, b: Moment) => a.start < b.end + MIN_GAP_SEC && a.end > b.start - MIN_GAP_SEC;
  const picks: Moment[] = [];
  while (picks.length < count) {
    const kinds = new Set(picks.map((p) => p.kind));
    let best: Moment | undefined;
    for (const m of ok) {
      if (picks.some((p) => p === m || near(m, p))) continue;
      const better =
        !best || (m.score ?? 0) > (best.score ?? 0) || ((m.score ?? 0) === (best.score ?? 0) && !kinds.has(m.kind) && kinds.has(best.kind));
      if (better) best = m;
    }
    if (!best) break;
    picks.push(best);
  }
  return picks.sort((a, b) => a.start - b.start);
}

export interface AIPicks {
  /** What to clip: at most `count`, all scoring MIN_SCORE or more. May be empty for a boring video. */
  moments: Moment[];
  /** Every candidate the model listed, with scores, edges already snapped to words. */
  candidates: Moment[];
}

/**
 * Turns the model's replies (one per transcript part) into picks. Throws when
 * the replies aren't usable (no JSON array, no valid ranges, no scores, or only
 * strong candidates of unusable length), so the caller can fall back to another
 * picker. Empty `moments` means the model validly judged nothing good enough.
 */
export function finishPicks(texts: string[], words: Word[], duration: number, count: number, clipSec: number): AIPicks {
  const candidates: Moment[] = [];
  for (const text of texts) {
    const raw = extractArray(text);
    if (!raw) throw new Error(`AI picker didn't return a JSON array: ${text.slice(0, 120)}`);
    // Keep overlapping candidates: selectBest resolves overlaps by score, not by listing order.
    const parsed = parsePicks(text, duration, { keepOverlaps: true });
    if (raw.length && !parsed.length) throw new Error("AI picker returned no valid time ranges.");
    candidates.push(...parsed);
  }
  if (candidates.length && !candidates.some((m) => m.score !== undefined)) throw new Error("AI picker didn't score its candidates.");
  const snapped = candidates.map((m) => {
    const c = trimLeadingFiller(snapToWords(m, words), words);
    return duration > 0 && c.end > duration ? { ...c, end: duration } : c;
  });
  const moments = selectBest(snapped, count, clipSec);
  if (!moments.length && snapped.some((m) => (m.score ?? 0) >= MIN_SCORE))
    throw new Error("AI picker's strongest candidates had unusable lengths.");
  return { moments, candidates: snapped };
}

/**
 * Asks the local Claude Code CLI to find and score moments and write hooks.
 * Long transcripts are read in overlapping parts, two at a time. Throws if the
 * replies aren't usable (see finishPicks).
 */
export async function pickWithAI(
  title: string,
  segs: TranscriptSegment[],
  duration: number,
  count: number,
  clipSec: number,
  peaks: number[] = [],
): Promise<AIPicks> {
  // Parts overlap by more than the longest allowed clip, so no clip straddles a seam.
  const chunks = chunkSegments(segs, PROMPT_BUDGET, maxClipSec(clipSec) + 15);
  const ask = (chunk: TranscriptSegment[], i: number) => {
    const lo = chunk[0].start;
    const hi = chunk[chunk.length - 1].end;
    const part = chunks.length > 1 ? { index: i + 1, total: chunks.length } : undefined;
    return runClaude(buildPickPrompt(title, chunk, duration, count, clipSec, peaks.filter((p) => p >= lo && p <= hi), part), 240_000);
  };
  const texts: string[] = [];
  for (let i = 0; i < chunks.length; i += 2) texts.push(...(await Promise.all(chunks.slice(i, i + 2).map((c, j) => ask(c, i + j)))));
  return finishPicks(texts, segs.flatMap((s) => s.words ?? []), duration, count, clipSec);
}

// ---------- transcript heuristic (free, offline) ----------

const STRONG =
  /\b(never|always|biggest|secret|mistake|crazy|insane|best|worst|truth|wrong|million|billion|why|how|stop|warning|huge|shocking|actually|nobody|everyone|problem|important|lesson|money)\b/gi;
/** Sounds in auto-captions that mean the room reacted. */
const REACTION = /\[(laughter|laughs|laughing|applause|cheering|cheers)\]/gi;
/** Emotion, conflict and storytelling: what makes a moment entertaining rather than informative. */
const FUN =
  /\b(oh my god|no way|are you kidding|what the|i swear|honestly|ridiculous|hilarious|funny|joke|scared|terrified|cried|crying|fired|died|dead|hate|hated|furious|wild|unbelievable|disagree|lied|fight|embarrassing|i remember|one time|true story|you know what happened)\b/gi;
/** Something new to learn: counterintuitive facts and practical tricks. */
const INSIGHT =
  /\b(turns out|most people (think|don'?t)|did you know|the trick is|the reason (is|why)|nobody tells you|no one tells you|i learned|the lesson|little known|counterintuitive)\b/gi;
/** Lecture phrasing: explanations rarely make good shorts. */
const EXPLAINER = /\b(basically|in other words|for example|first of all|secondly|thirdly|step one|framework|definition|essentially|which means)\b/gi;

/**
 * Scores sliding windows of the transcript for entertaining, hook-like signals:
 * laughter and applause, emotional and story words, something new to learn,
 * banter between speakers,
 * questions, numbers, strong words, exclamations and fast delivery, minus
 * lecture phrasing. No AI needed.
 */
export function pickFromTranscript(segs: TranscriptSegment[], duration: number, count: number, clipSec: number): Moment[] {
  if (!segs.length) return [];
  const lo = Math.max(20, duration * 0.04);
  const hi = duration * 0.96;
  const scored: { start: number; end: number; score: number }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const start = segs[i].start;
    if (start < lo) continue;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1].end - start <= clipSec) j++;
    const end = segs[j].end;
    if (end > hi || end - start < clipSec * 0.6) continue;
    const window = segs.slice(i, j + 1);
    const text = window.map((s) => s.text).join(" ");
    const first = segs[i].text;
    const words = text.split(/\s+/).length;
    const score =
      (text.match(/\?/g)?.length ?? 0) * 1.5 +
      (text.match(/[$%]|\b\d[\d,.]*\b/g)?.length ?? 0) * 1 +
      (text.match(STRONG)?.length ?? 0) * 1.2 +
      (text.match(/!/g)?.length ?? 0) * 0.8 +
      (first.match(STRONG)?.length ?? 0) * 2 + // hook in the opening line
      (/\?/.test(first) ? 2 : 0) +
      Math.min(3, words / (end - start) - 2) * 1.5 + // energetic delivery
      (text.match(REACTION)?.length ?? 0) * 3 +
      (text.match(FUN)?.length ?? 0) * 1.5 +
      (text.match(INSIGHT)?.length ?? 0) * 1.5 +
      Math.min(3, (text.match(/>>/g)?.length ?? 0) * 0.5) + // back-and-forth banter
      (text.match(EXPLAINER)?.length ?? 0) * -1;
    scored.push({ start, end, score });
  }
  const picks: Moment[] = [];
  for (const s of scored.sort((a, b) => b.score - a.score)) {
    if (picks.length >= count) break;
    if (picks.some((p) => s.start < p.end + 5 && s.end > p.start - 5)) continue;
    picks.push({ start: Math.max(0, s.start - 0.3), end: s.end + 0.3 });
  }
  return picks.sort((a, b) => a.start - b.start);
}
