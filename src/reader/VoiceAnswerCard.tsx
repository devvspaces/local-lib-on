// Floating card for voice questions: listening → transcribing → thinking → speaking, with the answer text.
import { Loader2, Mic, MessageSquare, Square, X } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import type { Book } from "@/lib/api";
import { dismissVoiceAnswer, finishVoiceAsk, useVoiceAsk } from "./voiceAsk";
import { cancelSpeakOnce } from "./tts";

const LABEL = { listening: "Listening… let go of ⌥⇧Space (or pause) when you're done", transcribing: "Transcribing…", thinking: "Thinking…", speaking: "Answering", idle: "" } as const;

export function VoiceAnswerCard({ book, onContinue }: { book: Book; onContinue: (question: string) => void }) {
  const { phase, heard, answer, error, keepListening } = useVoiceAsk();
  if (phase === "idle" && !answer && !error) return null;
  void book;
  return (
    <div role="status" aria-live="polite" className="absolute bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100%-2rem)] rounded-lg border bg-popover p-3 text-[13px] shadow-xl">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        {phase === "listening" ? <Mic className="h-3.5 w-3.5 animate-pulse text-destructive" /> : phase !== "idle" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
        <span className="flex-1">{phase === "idle" ? "Voice question" : LABEL[phase]}</span>
        {phase === "listening" && <button onClick={() => finishVoiceAsk()} className="rounded px-1.5 py-0.5 text-foreground hover:bg-secondary cursor-pointer">Done</button>}
        {phase === "speaking" && <button onClick={() => cancelSpeakOnce()} title="Stop the answer" className="rounded p-1 hover:bg-secondary cursor-pointer" aria-label="Stop the answer"><Square className="h-3 w-3 fill-current" /></button>}
        {phase === "idle" && <button onClick={dismissVoiceAnswer} className="rounded p-1 hover:bg-secondary cursor-pointer" aria-label="Close"><X className="h-3.5 w-3.5" /></button>}
      </div>
      {heard && <p className="mb-1.5 font-medium">“{heard}”</p>}
      {answer && <div className="md-preview max-h-48 overflow-y-auto text-[13px] custom-scrollbar" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer) }} />}
      {error && <p className="text-destructive">{error}</p>}
      {phase === "idle" && (heard || answer) && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {heard && <button onClick={() => { onContinue(heard); dismissVoiceAnswer(); }} className="rounded border px-2 py-0.5 hover:bg-secondary cursor-pointer">Continue in assistant</button>}
          <label className="ml-auto flex items-center gap-1 text-muted-foreground"><input type="checkbox" checked={keepListening} onChange={(e) => useVoiceAsk.setState({ keepListening: e.target.checked })} /> Resume reading after answers</label>
        </div>
      )}
    </div>
  );
}
