// Read aloud on top of the system speech engine (speechSynthesis → macOS voices, offline).
// Engines supply text chunk by chunk (and highlight what is being read); the controller speaks them.
import { create } from "zustand";

import { invoke } from "@tauri-apps/api/core";
import type { TtsChunk } from "./types";

export interface TtsSource {
  /** First chunk from the current position (or from the selection). null = nothing to read. */
  ttsStart(): Promise<TtsChunk | null>;
  /** Next chunk; the engine advances pages/sections itself. null = end of book. */
  ttsNext(): Promise<TtsChunk | null>;
  ttsStop(): void;
}

/** "system:<voiceURI>" or "neural:<packId>:<sid>". */
interface TtsState {
  status: "idle" | "playing" | "paused";
  rate: number;
  voiceURI: string | null;
  neural: { pack: string; sid: number } | null;
  owner: string | null;
}

const load = () => { try { return JSON.parse(localStorage.getItem("local-lib-tts") ?? "{}"); } catch { return {}; } };

export const useTts = create<TtsState>(() => ({ status: "idle", rate: load().rate ?? 1, voiceURI: load().voiceURI ?? null, neural: load().neural ?? null, owner: null }));
useTts.subscribe((s) => { try { localStorage.setItem("local-lib-tts", JSON.stringify({ rate: s.rate, voiceURI: s.voiceURI, neural: s.neural })); } catch { /* ignore */ } });

export const voices = () => speechSynthesis.getVoices().filter((v) => v.lang).sort((a, b) => Number(b.localService) - Number(a.localService) || a.lang.localeCompare(b.lang));

export interface VoicePack { id: string; name: string; family: "kokoro" | "piper"; archive: string; size_mb: number; lang: string; note: string; speakers: { sid: number; name: string }[]; installed: boolean }
export const neuralApi = {
  voices: () => invoke<VoicePack[]>("tts_voices"),
  install: (id: string) => invoke<void>("tts_install", { id }),
  uninstall: (id: string) => invoke<void>("tts_uninstall", { id }),
  synth: (voice: string, sid: number, text: string, speed: number) => invoke<string>("tts_synth", { voice, sid, text, speed }),
};

/** Base64 WAV → object URL. */
function wavUrl(b64: string) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

let current: { src: TtsSource; token: number } | null = null;
let token = 0;
let audio: HTMLAudioElement | null = null;
/** Prefetched next chunk (neural): synthesis started while the current one plays. */
let ahead: Promise<{ chunk: TtsChunk; url: string | null } | null> | null = null;

const isCurrent = (t: number) => current?.token === t;

// ── System voices (speechSynthesis) ──
let lastChunk: TtsChunk | null = null;
/** Text of the sentence being read right now (context for voice questions). */
export const currentSentence = () => lastChunk?.text ?? null;

function speakSystem(c: TtsChunk, t: number) {
  lastChunk = c;
  c.show?.();
  const u = new SpeechSynthesisUtterance(c.text);
  const { rate, voiceURI } = useTts.getState();
  u.rate = rate;
  const v = voices().find((x) => x.voiceURI === voiceURI);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.onend = async () => {
    if (!isCurrent(t) || useTts.getState().status !== "playing") return;
    const next = await current!.src.ttsNext().catch(() => null);
    if (!isCurrent(t)) return;
    if (next) speakSystem(next, t); else stop();
  };
  u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") console.warn("[tts]", e.error); };
  speechSynthesis.speak(u);
}

// ── Neural voices (sherpa-onnx, offline) ──
async function synth(c: TtsChunk): Promise<string | null> {
  const n = useTts.getState().neural;
  if (!n || !c.text.trim()) return null;
  try { return wavUrl(await neuralApi.synth(n.pack, n.sid, c.text, useTts.getState().rate)); } catch (e) { console.warn("[tts] synth", e); return null; }
}

function prefetch(t: number) {
  ahead = (async () => {
    if (!isCurrent(t)) return null;
    const chunk = await current!.src.ttsNext().catch(() => null);
    if (!chunk) return null;
    return { chunk, url: await synth(chunk) };
  })();
}

async function playNeural(item: { chunk: TtsChunk; url: string | null }, t: number) {
  if (!isCurrent(t)) return;
  prefetch(t); // overlap synthesis of the next sentence with playback of this one
  if (!item.url) { // empty/failed chunk → skip ahead
    const next = await ahead;
    if (next && isCurrent(t)) return playNeural(next, t);
    return stop();
  }
  lastChunk = item.chunk;
  item.chunk.show?.();
  audio = new Audio(item.url);
  audio.onended = async () => {
    URL.revokeObjectURL(item.url!);
    if (!isCurrent(t) || useTts.getState().status !== "playing") return;
    const next = await ahead;
    if (!isCurrent(t)) return;
    if (next) playNeural(next, t); else stop();
  };
  await audio.play().catch((e) => console.warn("[tts] play", e));
}

export async function play(src: TtsSource, owner: string) {
  stop();
  const t = ++token;
  current = { src, token: t };
  useTts.setState({ status: "playing", owner });
  const first = await src.ttsStart().catch(() => null);
  if (!first) { stop(); return false; }
  if (!isCurrent(t)) return true;
  if (useTts.getState().neural) {
    const url = await synth(first);
    if (!url && !useTts.getState().neural) return false;
    playNeural({ chunk: first, url }, t);
  } else speakSystem(first, t);
  return true;
}

export function pause() {
  if (useTts.getState().status !== "playing") return;
  if (audio) audio.pause(); else speechSynthesis.pause();
  useTts.setState({ status: "paused" });
}

export function resume() {
  if (useTts.getState().status !== "paused") return;
  if (audio) audio.play(); else speechSynthesis.resume();
  useTts.setState({ status: "playing" });
}

export function stop() {
  token++;
  const c = current;
  current = null;
  ahead = null;
  speechSynthesis.cancel();
  if (audio) { audio.pause(); audio = null; }
  c?.src.ttsStop();
  useTts.setState({ status: "idle", owner: null });
}

/** Skip to the next chunk now. */
export async function skip() {
  if (!current) return;
  const t = ++token;
  current.token = t;
  if (useTts.getState().neural) {
    if (audio) { audio.onended = null; audio.pause(); }
    const next = (await ahead) ?? null;
    if (next && isCurrent(t)) playNeural(next, t);
    return;
  }
  speechSynthesis.cancel();
  const next = await current.src.ttsNext().catch(() => null);
  if (next && isCurrent(t)) speakSystem(next, t);
}

/** Play a short sample of a neural voice (Settings / voice menu). */
export async function sample(pack: string, sid: number) {
  const url = wavUrl(await neuralApi.synth(pack, sid, "Here is how this voice sounds when it reads your books aloud.", 1));
  const a = new Audio(url);
  a.onended = () => URL.revokeObjectURL(url);
  await a.play();
}

/** Sentence splitter tuned for book text (abbreviations, initials, decimals). */
export function splitSentences(text: string): string[] {
  const t = text.replace(/-\n(?=[a-z])/g, "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const abbrev = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Fig|fig|No|Vol|pp|Ch|al)\.$/;
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    const next = t[i + 1];
    const after = t[i + 2];
    if (next !== undefined && next !== " " && next !== "”" && next !== '"' && next !== ")") continue;
    const piece = t.slice(start, i + 1);
    if (c === "." && (abbrev.test(piece) || /\b[A-Z]\.$/.test(piece) || /\d\.$/.test(piece) && after && /\d/.test(after))) continue;
    if (after && /[a-z]/.test(after) && c === ".") continue; // "e.g. something"
    out.push(piece.trim());
    start = i + 1;
  }
  if (start < t.length) out.push(t.slice(start).trim());
  // Merge very short fragments (headings, list markers) into the next sentence; split very long ones.
  const merged: string[] = [];
  for (const s of out.filter(Boolean)) {
    if (merged.length && merged[merged.length - 1].length < 12) merged[merged.length - 1] += " " + s;
    else merged.push(s);
  }
  return merged.flatMap((s) => (s.length > 400 ? s.match(/.{1,300}(?:[,;:]\s|$)|.{1,300}/g) ?? [s] : [s]));
}

/** Plain text from foliate's SSML chunks. */
export const ssmlToText = (ssml: string) =>
  new DOMParser().parseFromString(ssml, "application/xml").documentElement?.textContent?.replace(/\s+/g, " ").trim() ?? ssml.replace(/<[^>]+>/g, " ");

/**
 * Speak a one-off text (e.g. a voice-question answer) in the chosen voice without disturbing the paused
 * read-aloud session. Resolves when finished. `cancelSpeakOnce()` stops it early.
 */
let once: { stop: () => void } | null = null;
export async function speakOnce(text: string): Promise<void> {
  cancelSpeakOnce();
  const n = useTts.getState().neural;
  if (n) {
    const parts = splitSentences(text);
    let stopped = false;
    let a: HTMLAudioElement | null = null;
    once = { stop: () => { stopped = true; a?.pause(); } };
    let nextUrl: Promise<string | null> | null = parts.length ? neuralApi.synth(n.pack, n.sid, parts[0], useTts.getState().rate).then(wavUrl).catch(() => null) : null;
    for (let i = 0; i < parts.length && !stopped; i++) {
      const url = await nextUrl;
      nextUrl = i + 1 < parts.length ? neuralApi.synth(n.pack, n.sid, parts[i + 1], useTts.getState().rate).then(wavUrl).catch(() => null) : null;
      if (!url || stopped) continue;
      a = new Audio(url);
      await new Promise<void>((res) => { a!.onended = () => res(); a!.onpause = () => res(); a!.play().catch(() => res()); });
      URL.revokeObjectURL(url);
    }
    once = null;
    return;
  }
  await new Promise<void>((res) => {
    const u = new SpeechSynthesisUtterance(text);
    const { rate, voiceURI } = useTts.getState();
    u.rate = rate;
    const v = voices().find((x) => x.voiceURI === voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = () => res();
    u.onerror = () => res();
    once = { stop: () => { speechSynthesis.cancel(); res(); } };
    // System voices share one queue: drop the paused sentence (it's re-read on resume) and speak the answer.
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
  once = null;
}
export function cancelSpeakOnce() { once?.stop(); once = null; }

/** Resume read-aloud after a voice question: neural audio continues mid-sentence; system voices re-read the sentence. */
export function resumeAfterInterruption() {
  if (!current || useTts.getState().status !== "paused") return;
  if (audio) { resume(); return; }
  const t = ++token;
  current.token = t;
  useTts.setState({ status: "playing" });
  if (lastChunk) speakSystem(lastChunk, t);
}
