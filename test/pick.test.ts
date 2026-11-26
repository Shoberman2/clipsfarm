import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPickPrompt, chunkSegments, cleanHook, finishPicks, maxClipSec, MIN_SCORE, parsePicks, pickFromTranscript, selectBest, snapToWords, trimLeadingFiller } from "../src/pick.js";

const segs = Array.from({ length: 120 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 5,
  text: i === 60 ? "Why did nobody see this billion dollar mistake coming?" : "and then we talked about the numbers for a while",
}));

test("parsePicks extracts valid, non-overlapping moments from model output", () => {
  const text = `Here you go:\n[{"start": 100, "end": 140, "hook": "\\"The $5B mistake\\"", "why": "x"},
    {"start": 120, "end": 150, "hook": "overlaps"}, {"start": 300, "end": 302, "hook": "too short"},
    {"start": "abc", "end": 10}, {"start": 400, "end": 9999, "hook": "clamped"}]`;
  const picks = parsePicks(text, 600);
  assert.deepEqual(picks.map((p) => [p.start, p.end]), [[100, 140], [400, 600]]);
  assert.equal(picks[0].hook, "The $5B mistake");
  assert.deepEqual(parsePicks("no json here", 600), []);
});

test("pickFromTranscript favours hook-like windows and skips the intro", () => {
  const picks = pickFromTranscript(segs, 600, 1, 40);
  assert.equal(picks.length, 1);
  assert.ok(picks[0].start <= 300 && picks[0].end >= 305, `expected the window with the hook line, got ${JSON.stringify(picks)}`);
  assert.ok(pickFromTranscript(segs, 600, 3, 40).every((p) => p.start >= 20));
});

test("buildPickPrompt includes the transcript, peaks and the JSON contract, and stays bounded", () => {
  const p = buildPickPrompt("My Video", segs, 600, 2, 45, [300]);
  assert.match(p, /"My Video"/);
  assert.match(p, /most replayed/);
  assert.match(p, /\[300\] Why did nobody/);
  assert.match(p, /ONLY a JSON array/);
  const huge = Array.from({ length: 40000 }, (_, i) => ({ start: i, end: i + 1, text: "lots of words in this caption line" }));
  assert.ok(buildPickPrompt("x", huge, 40000, 2, 45).length < 110_000);
});

test("parsePicks keeps the score, kind and quoted edge words", () => {
  const text = `[{"start": 10, "end": 40, "score": 8, "kind": "Humor", "first_words": "You will not believe", "last_words": "and he quit", "hook": "x"},
    {"start": 50, "end": 80, "score": "nope"}]`;
  const [a, b] = parsePicks(text, 600);
  assert.equal(a.score, 8);
  assert.equal(a.kind, "humor");
  assert.equal(a.firstWords, "You will not believe");
  assert.equal(a.lastWords, "and he quit");
  assert.equal(b.score, undefined);
});

test("selectBest drops candidates under the bar, ranks by score and returns them in time order", () => {
  const c = [
    { start: 300, end: 330, score: 9 },
    { start: 100, end: 130, score: 8 },
    { start: 310, end: 340, score: 8.5 }, // overlaps the 9
    { start: 500, end: 530, score: MIN_SCORE - 1 }, // boring
    { start: 600, end: 607, score: 10 }, // too short
    { start: 700, end: 900, score: 10 }, // too long for a 45s target
    { start: 20, end: 50, score: 7 },
  ];
  assert.deepEqual(selectBest(c, 2, 45).map((m) => m.start), [100, 300]);
  assert.deepEqual(selectBest(c, 5, 45).map((m) => m.start), [20, 100, 300]);
  assert.deepEqual(selectBest([{ start: 1, end: 30, score: 4 }], 2, 45), []);
  assert.deepEqual(selectBest([{ start: 1, end: 30 }], 2, 45), []); // unscored never clears the bar
});

test("snapToWords moves edges onto the quoted words and tolerates one misheard word", () => {
  const said = "um so yeah the CEO fired me on my birthday and I laughed okay next question".split(" ");
  const words = said.map((text, i) => ({ start: 100 + i * 0.8, end: 100 + i * 0.8 + 0.8, text }));
  const m = snapToWords({ start: 101, end: 111, firstWords: "the CEO fired me", lastWords: "and I laughed" }, words);
  assert.ok(Math.abs(m.start - 102.4) < 1e-9, `start ${m.start}`); // "the", not "um so yeah", and none of "yeah"
  assert.equal(m.end, 110.4); // right after "laughed", before "okay"
  const fuzzy = snapToWords({ start: 101, end: 111, firstWords: "the CFO fired me", lastWords: "zzz qqq" }, words);
  assert.ok(Math.abs(fuzzy.start - 102.4) < 1e-9, `start ${fuzzy.start}`);
  assert.equal(fuzzy.end, 111); // quote not found: edge left alone
  assert.deepEqual(snapToWords({ start: 1, end: 9 }, words), { start: 1, end: 9 });
});

test("chunkSegments covers the whole transcript in overlapping parts that fit the budget", () => {
  const long = Array.from({ length: 3000 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, text: "some words that were said here".repeat(2) }));
  const parts = chunkSegments(long, 50_000, 60);
  assert.ok(parts.length > 1);
  assert.equal(parts[0][0], long[0]);
  assert.equal(parts[parts.length - 1].at(-1), long.at(-1));
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i][0].start < parts[i - 1].at(-1)!.end, "parts overlap");
  for (const p of parts) assert.ok(p.map((s) => `[${s.start}] ${s.text}`).join("\n").length <= 50_000);
  assert.deepEqual(chunkSegments(segs).length, 1);
});

test("buildPickPrompt asks for harsh scores, cold opens and quoted edges", () => {
  const p = buildPickPrompt("My Video", segs, 600, 2, 45, [], { index: 2, total: 3 });
  assert.match(p, /Score every candidate/);
  assert.match(p, /Cold open/);
  assert.match(p, /first_words/);
  assert.match(p, /part 2 of 3/);
  assert.match(p, /up to 6 candidates/);
});

test("pickFromTranscript prefers a laughing exchange over a lecture", () => {
  const talk = Array.from({ length: 120 }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text:
      i >= 40 && i < 48
        ? "basically in other words the framework essentially means the definition"
        : i >= 80 && i < 88
          ? ">> no way, he fired you? [laughter] >> I swear it was hilarious"
          : "and then we talked for a while about things",
  }));
  const [best] = pickFromTranscript(talk, 600, 1, 40);
  assert.ok(best.start >= 390 && best.start < 440, `expected the laughing exchange, got ${JSON.stringify(best)}`);
});

test("parsePicks only accepts real 0-10 scores", () => {
  const text = `[{"start": 10, "end": 40, "score": "8"}, {"start": 50, "end": 80, "score": "7-8"},
    {"start": 90, "end": 120, "score": [8]}, {"start": 130, "end": 160, "score": 80}, {"start": 170, "end": 200, "score": "NaN"}]`;
  assert.deepEqual(parsePicks(text, 600).map((m) => m.score), [8, undefined, undefined, undefined, undefined]);
});

const w = (said: string, t0 = 0, step = 0.5) => said.split(" ").map((text, i) => ({ start: t0 + i * step, end: t0 + i * step + step, text }));

test("finishPicks treats unusable replies as failures, not as boring videos", () => {
  assert.throws(() => finishPicks(["[unavailable]"], [], 600, 2, 45), /JSON array/);
  assert.throws(() => finishPicks(["Sorry, I can't help with that."], [], 600, 2, 45), /JSON array/);
  assert.throws(() => finishPicks(['[{"start": "x", "end": 3}]'], [], 600, 2, 45), /valid time ranges/);
  assert.throws(() => finishPicks(['[{"start": 10, "end": 40}]'], [], 600, 2, 45), /score/);
  assert.throws(() => finishPicks(['[{"start": 10, "end": 300, "score": 9}]'], [], 600, 2, 45), /unusable lengths/);
  // A valid "nothing here is good": empty moments, candidates kept for the inbox note.
  assert.deepEqual(finishPicks(["[]"], [], 600, 2, 45), { moments: [], candidates: [] });
  const low = finishPicks(['[{"start": 10, "end": 40, "score": 5, "hook": "meh"}]'], [], 600, 2, 45);
  assert.deepEqual(low.moments, []);
  assert.equal(low.candidates[0].score, 5);
});

test("finishPicks resolves overlaps by score, not listing order, and stays inside the video", () => {
  const text = `[{"start": 10, "end": 40, "score": 5}, {"start": 20, "end": 50, "score": 9}, {"start": 580, "end": 640, "score": 8}]`;
  const { moments } = finishPicks([text], [], 600, 3, 45);
  assert.deepEqual(moments.map((m) => [m.start, m.end]), [[20, 50], [580, 600]]);
});

test("buildPickPrompt stays bounded and terminates on one oversized caption line", () => {
  const p = buildPickPrompt("x", [{ start: 0, end: 5, text: "word ".repeat(30_000) }], 600, 2, 45);
  assert.ok(p.length < 110_000);
  assert.equal(chunkSegments([{ start: 0, end: 5, text: "word ".repeat(30_000) }]).length, 1);
});

test("chunk overlap covers every clip up to the longest allowed length", () => {
  const segs3 = Array.from({ length: 2000 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, text: "x".repeat(40) }));
  const longest = maxClipSec(45) + 10;
  const parts = chunkSegments(segs3, 20_000, maxClipSec(45) + 15);
  assert.ok(parts.length > 2);
  for (let t = 0; t + longest <= 6000; t += 7)
    assert.ok(parts.some((p) => p[0].start <= t && p.at(-1)!.end >= t + longest), `clip ${t}-${t + longest} straddles a seam`);
});

test("snapToWords picks the right repeat of a phrase and never leaks a neighbouring word", () => {
  const words = [...w("I never told anyone about Alice", 100), ...w("I never told anyone about payroll and it cost me", 106)];
  const m = snapToWords({ start: 101, end: 115, firstWords: "I never told anyone about payroll", lastWords: "and it cost me" }, words);
  assert.ok(Math.abs(m.start - 105.9) < 1e-9, `start ${m.start}`); // the "payroll" line (0.1s lead-in over silence), not the nearer "Alice" one
  // Back-to-back words: the cut ends where the next word starts.
  const tight = [{ start: 10, end: 20, text: "start" }, { start: 20, end: 20.12, text: "done" }, { start: 20.12, end: 20.5, text: "next" }];
  assert.equal(snapToWords({ start: 9, end: 21, firstWords: "x y", lastWords: "start done" }, tight).end, 20.12);
});

test("cleanHook drops em dashes, hashtags, emoji and wrapping quotes but keeps number ranges", () => {
  assert.equal(cleanHook("He bet $1,000 — and lost"), "He bet $1,000, and lost");
  assert.equal(cleanHook("“The GPU is a time machine” #nvidia #ai 🔥"), "The GPU is a time machine");
  assert.equal(cleanHook("Prices from 1990–2000 doubled"), "Prices from 1990–2000 doubled");
  assert.equal(cleanHook("  #shorts  "), "");
  const [m] = parsePicks('[{"start": 1, "end": 30, "hook": "Woody’s $1,000 bet — explained 🏀"}]', 600);
  assert.equal(m.hook, "Woody’s $1,000 bet, explained");
});

test("buildPickPrompt values learning moments and carries the hook header rules", () => {
  const p = buildPickPrompt("My Video", segs, 600, 2, 45);
  assert.match(p, /insight: something new to learn/);
  assert.match(p, /"I didn't know that"/);
  assert.match(p, /6 words or fewer, never more than 10/);
  assert.match(p, /hold back the twist/);
  assert.match(p, /no em dashes, emoji, hashtags/);
  assert.match(p, /quote or insight/);
});

test("pickFromTranscript rewards a surprising lesson over small talk", () => {
  const talk = Array.from({ length: 120 }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text: i >= 60 && i < 68 ? "turns out most people think it's the opposite, and the trick is to wait" : "and then we talked for a while about things",
  }));
  const [best] = pickFromTranscript(talk, 600, 1, 40);
  assert.ok(best.start >= 270 && best.start < 340, `expected the lesson, got ${JSON.stringify(best)}`);
});

test("parsePicks keeps a cleaned post description and the prompt carries its rules", () => {
  const [m] = parsePicks('[{"start": 1, "end": 30, "description": "Woody Harrelson on the bet he rigged \u2014 #hotones \u{1F525}"}]', 600);
  assert.equal(m.description, "Woody Harrelson on the bet he rigged");
  const p = buildPickPrompt("My Video", segs, 600, 2, 45);
  assert.match(p, /Description rules:/);
  assert.match(p, /under 150 characters/);
  assert.match(p, /clipswarm adds the credit line itself/);
  assert.match(p, /"description": "<post text>"/);
});

test("selectBest spreads picks out and prefers a new kind of moment on a tie", () => {
  const c = [
    { start: 200, end: 260, score: 8, kind: "surprise" },
    { start: 877, end: 936, score: 7, kind: "story" },
    { start: 946, end: 992, score: 7, kind: "story" }, // 10s after the last one: same stretch
    { start: 2169, end: 2238, score: 7, kind: "story" },
    { start: 4442, end: 4493, score: 7, kind: "insight" },
  ];
  assert.deepEqual(selectBest(c, 3, 45).map((m) => m.start), [200, 877, 4442]);
});

test("trimLeadingFiller opens the clip on real words", () => {
  const words = w("And so, uh, they found the cheapest boarding school in America for us that year", 100, 0.5);
  const m = trimLeadingFiller({ start: 100, end: 110 }, words);
  assert.ok(Math.abs(m.start - 101.5) < 1e-9, `start ${m.start}`); // "they", after "And so, uh,"
  const ex = w("For example, I now know how hard it is to build this company from scratch", 200, 0.5);
  assert.ok(Math.abs(trimLeadingFiller({ start: 200, end: 210 }, ex).start - 201) < 1e-9);
  // Nothing to trim, or trimming would leave too little: unchanged.
  assert.deepEqual(trimLeadingFiller({ start: 101.5, end: 110 }, words), { start: 101.5, end: 110 });
  assert.deepEqual(trimLeadingFiller({ start: 100, end: 108.5 }, words), { start: 100, end: 108.5 });
});
