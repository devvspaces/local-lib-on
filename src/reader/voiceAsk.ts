// Voice questions while listening: hold ⌥⇧Space (or tap the mic), ask, hear the answer, keep reading.
// Mic capture + transcription are native and offline (sherpa-onnx); the answer uses the configured AI (Quick mode).
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildContext, llm, numberSources, streamChat, type Source } from "@/lib/assistant";
import { currentSentence, pause, resumeAfterInterruption, speakOnce, cancelSpeakOnce, useTts } from "./tts";

export interface SttModel { id: string; name: string; family: string; size_mb: number; note: string; installed: boolean }
export const sttApi = {
  models: () => invoke<SttModel[]>("stt_models"),
  install: (id: string) => invoke<void>("stt_install", { id }),
  uninstall: (id: string) => invoke<void>("stt_uninstall", { id }),
  start: () => invoke<void>("stt_record_start"),
  stop: (model: string) => invoke<string>("stt_record_stop", { model }),
};

type Phase = "idle" | "listening" | "transcribing" | "thinking" | "speaking";
interface VoiceState { phase: Phase; heard: string; answer: string; sources: Source[]; error: string | null; keepListening: boolean }
export const useVoiceAsk = create<VoiceState>(() => ({ phase: "idle", heard: "", answer: "", sources: [], error: null, keepListening: true }));

const SPOKEN_SYSTEM = `You answer a reader's spoken question while they listen to their book. Reply in 2–4 short sentences of plain spoken English: no Markdown, no lists, no citations, no URLs. Ground the answer in the SOURCES when they cover it; otherwise answer briefly from general knowledge and say so.`;

/** Strip anything that reads badly aloud. */
export function forSpeech(md: string) {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, "") // [1, 2] citations
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

let ctx: { bookId: number; title: string; loc: string | null; wasPlaying: boolean } | null = null;
let unAuto: (() => void) | null = null;

/** Start listening (pauses read-aloud). */
export async function startVoiceAsk(book: { id: number; title: string }, loc: string | null) {
  const s = useVoiceAsk.getState();
  if (s.phase !== "idle") return;
  const models = await sttApi.models().catch(() => []);
  if (!models.some((m) => m.installed)) {
    useVoiceAsk.setState({ phase: "idle", error: "Download a voice-input model first: Settings → Reading & voices → Voice questions." });
    return;
  }
  cancelSpeakOnce();
  const wasPlaying = useTts.getState().status === "playing";
  if (wasPlaying) pause();
  ctx = { bookId: book.id, title: book.title, loc, wasPlaying: wasPlaying || useTts.getState().status === "paused" };
  useVoiceAsk.setState({ phase: "listening", heard: "", answer: "", sources: [], error: null });
  try {
    await sttApi.start();
    unAuto?.();
    const un = await listen("stt_autostop", () => { void finishVoiceAsk(); });
    unAuto = un;
  } catch (e) {
    useVoiceAsk.setState({ phase: "idle", error: String(e) });
    if (ctx?.wasPlaying) resumeAfterInterruption();
  }
}

/** Stop listening → transcribe → answer → speak → resume reading. */
export async function finishVoiceAsk() {
  if (useVoiceAsk.getState().phase !== "listening" || !ctx) return;
  unAuto?.(); unAuto = null;
  const c = ctx;
  useVoiceAsk.setState({ phase: "transcribing" });
  const model = (await sttApi.models().catch(() => [])).find((m) => m.installed)?.id ?? "moonshine-tiny-en";
  let heard = "";
  try { heard = (await sttApi.stop(model)).trim(); } catch (e) { useVoiceAsk.setState({ phase: "idle", error: String(e) }); return done(c); }
  if (!heard) { useVoiceAsk.setState({ phase: "idle", error: "Didn't catch that. Hold ⌥⇧Space and speak, then let go." }); return done(c); }
  useVoiceAsk.setState({ phase: "thinking", heard });

  try {
    const [passages, page] = await Promise.all([
      llm.retrieve(heard, c.bookId, 5).catch(() => []),
      c.loc ? llm.unitText(c.bookId, c.loc).catch(() => null) : Promise.resolve(null),
    ]);
    const sources = numberSources(passages, page && c.loc ? { book_id: c.bookId, title: c.title, loc: c.loc, text: page } : null);
    const sentence = currentSentence();
    const prompt = buildContext({ question: heard, sources, selection: sentence ? `(was just reading) ${sentence}` : null });
    const answer = await new Promise<string>((resolve, reject) => {
      let out = "";
      streamChat([{ role: "user", content: prompt }], (t) => { out += t; useVoiceAsk.setState({ answer: out }); }, (r) => (r.error ? reject(new Error(r.error)) : resolve(out)), SPOKEN_SYSTEM).catch(reject);
    });
    useVoiceAsk.setState({ phase: "speaking", answer, sources });
    await speakOnce(forSpeech(answer));
  } catch (e) {
    useVoiceAsk.setState({ error: String(e) });
  }
  useVoiceAsk.setState({ phase: "idle" });
  done(c);
}

function done(c: { wasPlaying: boolean }) {
  ctx = null;
  if (c.wasPlaying && useVoiceAsk.getState().keepListening) resumeAfterInterruption();
}

export function dismissVoiceAnswer() { cancelSpeakOnce(); useVoiceAsk.setState({ answer: "", heard: "", sources: [], error: null }); }
