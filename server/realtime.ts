import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getApiKey } from "./openai";

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const TRANSCRIBE_MODEL = process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

type RtSessionState = {
  id: string;
  ws: WebSocket;
  closed: boolean;
  ready: boolean;
  createdAt: number;
  completedCount: number;
  lastTranscriptAt: number;
  itemOrder: string[];
  partialByItem: Map<string, string>;
  completedByItem: Map<string, string>;
  lastError: string | null;
  readyResolve: (() => void) | null;
  readyReject: ((err: Error) => void) | null;
};

const sessions = new Map<string, RtSessionState>();

function clean(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

function buildTranscript(state: RtSessionState): string {
  const lines: string[] = [];
  for (const itemId of state.itemOrder) {
    const completed = state.completedByItem.get(itemId);
    const partial = state.partialByItem.get(itemId);
    const text = clean(completed || partial || "");
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

function toRealtimeWsUrl(): string {
  if (process.env.OPENAI_REALTIME_WS_URL) {
    const url = new URL(process.env.OPENAI_REALTIME_WS_URL);
    url.searchParams.set("intent", "transcription");
    return url.toString();
  }

  const normalized = OPENAI_BASE_URL.replace(/\/$/, "");
  const wsBase = normalized.replace(/^http/i, "ws");
  const url = new URL(`${wsBase}/realtime`);
  url.searchParams.set("intent", "transcription");
  return url.toString();
}

function sendEvent(state: RtSessionState, event: unknown): void {
  if (state.closed) throw new Error("Realtime session is closed");
  if (state.ws.readyState !== WebSocket.OPEN) throw new Error("Realtime websocket is not open");
  state.ws.send(JSON.stringify(event));
}

async function waitForOpen(ws: WebSocket, timeoutMs = 10000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Realtime websocket open timed out"));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: any) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };

    ws.on("open", onOpen);
    ws.on("error", onError);
  });
}

async function waitForReady(state: RtSessionState, timeoutMs = 6000): Promise<void> {
  if (state.ready) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Realtime transcription session update timed out"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      state.readyResolve = null;
      state.readyReject = null;
    };

    state.readyResolve = () => {
      cleanup();
      resolve();
    };

    state.readyReject = (err: Error) => {
      cleanup();
      reject(err);
    };
  });
}

async function waitForQuiet(state: RtSessionState, timeoutMs = 4500, quietMs = 350): Promise<void> {
  const startedAt = Date.now();
  const baseCount = state.completedCount;
  let sawNewCompletion = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (state.closed) return;

    if (state.completedCount > baseCount) {
      sawNewCompletion = true;
    }

    const msSinceTranscript = Date.now() - state.lastTranscriptAt;
    if (sawNewCompletion && msSinceTranscript >= quietMs) return;
    await new Promise((r) => setTimeout(r, 80));
  }
}

function closeSession(sessionId: string, reason: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  sessions.delete(sessionId);
  state.closed = true;

  if (state.readyReject) {
    state.readyReject(new Error(`Session closed: ${reason}`));
    state.readyReject = null;
    state.readyResolve = null;
  }

  try {
    state.ws.close(1000, reason);
  } catch {
    // noop
  }
}

function handleRealtimeEvent(state: RtSessionState, raw: WebSocket.RawData): void {
  let event: any = null;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const type = String(event?.type || "");
  if (!type) return;

  if (type === "transcription_session.updated") {
    state.ready = true;
    if (state.readyResolve) state.readyResolve();
    return;
  }

  if (type === "error") {
    const message = String(event?.error?.message || "Realtime error");
    state.lastError = message;
    if (state.readyReject) {
      state.readyReject(new Error(message));
    }
    return;
  }

  if (type === "conversation.item.input_audio_transcription.delta") {
    const itemId = String(event?.item_id || "");
    const delta = String(event?.delta || "");
    if (!itemId || !delta) return;
    if (!state.itemOrder.includes(itemId)) state.itemOrder.push(itemId);
    const prev = state.partialByItem.get(itemId) || "";
    state.partialByItem.set(itemId, prev + delta);
    state.lastTranscriptAt = Date.now();
    return;
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    const itemId = String(event?.item_id || "");
    const transcript = String(event?.transcript || "");
    if (!itemId) return;
    if (!state.itemOrder.includes(itemId)) state.itemOrder.push(itemId);
    state.completedByItem.set(itemId, transcript);
    state.partialByItem.delete(itemId);
    state.completedCount += 1;
    state.lastTranscriptAt = Date.now();
    return;
  }

  if (type === "conversation.item.input_audio_transcription.failed") {
    const itemId = String(event?.item_id || "");
    const message = String(event?.error?.message || "transcription failed");
    if (!itemId) return;
    if (!state.itemOrder.includes(itemId)) state.itemOrder.push(itemId);
    state.partialByItem.set(itemId, `[transcription failed: ${message}]`);
    state.lastTranscriptAt = Date.now();
  }
}

export async function startRealtimeTranscriptionSession(): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  const ws = new WebSocket(toRealtimeWsUrl(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  await waitForOpen(ws);

  const id = randomUUID();
  const state: RtSessionState = {
    id,
    ws,
    closed: false,
    ready: false,
    createdAt: Date.now(),
    completedCount: 0,
    lastTranscriptAt: Date.now(),
    itemOrder: [],
    partialByItem: new Map(),
    completedByItem: new Map(),
    lastError: null,
    readyResolve: null,
    readyReject: null
  };

  ws.on("message", (raw: WebSocket.RawData) => handleRealtimeEvent(state, raw));
  ws.on("close", () => {
    state.closed = true;
    sessions.delete(id);
  });
  ws.on("error", (err: Error) => {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    if (state.readyReject) state.readyReject(new Error(message));
  });

  sessions.set(id, state);

  sendEvent(state, {
    type: "transcription_session.update",
    session: {
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: TRANSCRIBE_MODEL,
        language: "en"
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.45,
        prefix_padding_ms: 250,
        silence_duration_ms: 500
      }
    }
  });

  await waitForReady(state);
  return id;
}

export async function appendRealtimeAudio(sessionId: string, audioChunks: string[]): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state || state.closed) throw new Error("Realtime session not found");
  if (!state.ready) throw new Error("Realtime session is not ready");
  if (!Array.isArray(audioChunks) || audioChunks.length === 0) return;

  for (const chunk of audioChunks) {
    if (!chunk) continue;
    sendEvent(state, {
      type: "input_audio_buffer.append",
      audio: chunk
    });
  }
}

export function getRealtimeTranscript(sessionId: string): string {
  const state = sessions.get(sessionId);
  if (!state || state.closed) return "";
  return buildTranscript(state);
}

export async function stopRealtimeTranscriptionSession(sessionId: string): Promise<string> {
  const state = sessions.get(sessionId);
  if (!state || state.closed) return "";

  sendEvent(state, {
    type: "input_audio_buffer.commit"
  });

  await waitForQuiet(state);

  const transcript = buildTranscript(state);
  const err = state.lastError;
  closeSession(sessionId, "transcription complete");

  if (!transcript && err) {
    throw new Error(err);
  }

  return transcript;
}

export async function cancelRealtimeTranscriptionSession(sessionId: string): Promise<void> {
  closeSession(sessionId, "cancelled");
}
