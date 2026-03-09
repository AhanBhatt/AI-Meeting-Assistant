import React, { useEffect, useRef, useState } from "react";
import ChatPane from "./components/ChatPane";
import RightPane from "./components/RightPane";

type Source = { id: string; name: string; thumb: string };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  transcript?: string;
  createdAt: number;
};

type KbFile = {
  vectorStoreFileId: string;
  openaiFileId: string;
  name: string;
};

type RuntimeInfo = {
  serverBaseUrl: string;
  isDev: boolean;
  appVersion: string;
};

type ApiKeySource = "env" | "app" | "none";

type UsageSummaryResponse = {
  monthLabel: string;
  usedUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
  resetDays: number;
  currency: "USD";
  source: "openai-org-costs" | "fallback-local";
  budgetFromOpenAI: boolean;
  warning?: string;
};

declare global {
  interface Window {
    bridge: {
      getRuntimeInfo: () => Promise<RuntimeInfo>;
      listSources: () => Promise<Source[]>;
      screenshotSource: (id: string) => Promise<Uint8Array>;
      openStickyNote: (text: string) => Promise<{ ok: boolean }>;
      onToggleCaptureShortcut: (callback: () => void) => () => void;
    };
  }
}

const PREROLL_MS = 2000;
const TARGET_PCM_RATE = 24000;
const SCRIPT_PROCESSOR_SIZE = 4096;
const PCM_FLUSH_MS = 180;
const LOCAL_API_KEY_STORAGE = "ai_meeting_assistance.openai_api_key";
const USAGE_BUDGET_STORAGE = "ai_meeting_assistance.usage_budget_usd";

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function u8ToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

async function getDesktopStream(sourceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId
      }
    } as any,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId
      }
    } as any
  });
}

function shouldIncludeScreenshot(text: string): boolean {
  return /(code|screen|screenshot|ui|diagram|stack trace|trace|error|bug|line|file|function|class|algorithm|implementation|leetcode|sql)/i.test(
    text || ""
  );
}

function downsampleTo24k(input: Float32Array, inputRate: number): Float32Array {
  if (!input.length) return input;
  if (!Number.isFinite(inputRate) || inputRate <= 0) return input;
  if (Math.round(inputRate) === TARGET_PCM_RATE) return input;
  if (inputRate < TARGET_PCM_RATE) return input;

  const ratio = inputRate / TARGET_PCM_RATE;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);

  let outIdx = 0;
  let inputIdx = 0;
  while (outIdx < outLength) {
    const nextInputIdx = Math.min(input.length, Math.floor((outIdx + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let i = inputIdx; i < nextInputIdx; i++) {
      sum += input[i];
      count++;
    }
    if (count > 0) {
      out[outIdx] = sum / count;
    } else {
      out[outIdx] = input[Math.min(inputIdx, input.length - 1)] || 0;
    }
    outIdx++;
    inputIdx = nextInputIdx;
  }

  return out;
}

function floatChunkToPCM16Base64(input: Float32Array, inputRate: number): string {
  const mono24k = downsampleTo24k(input, inputRate);
  const int16 = new Int16Array(mono24k.length);

  for (let i = 0; i < mono24k.length; i++) {
    const s = Math.max(-1, Math.min(1, mono24k[i]));
    int16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }

  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function monoChunksToWavBlob(chunks: Float32Array[], sampleRate: number): Blob | null {
  const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
  if (totalSamples <= 0) return null;

  const channels = 1;
  const rate = Math.max(8000, Math.round(sampleRate || TARGET_PCM_RATE));
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = rate * blockAlign;
  const dataSize = totalSamples * blockAlign;

  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      offset += 2;
    }
  }

  return new Blob([wav], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read blob"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(task: () => Promise<T>, attempts: number, delayMs: number, label: string): Promise<T> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw new Error(`${label}: ${(lastError as any)?.message || String(lastError)}`);
}

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedSourceName, setSelectedSourceName] = useState<string>("No window selected");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [shortcutBanner, setShortcutBanner] = useState("");

  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

  const [uploadOnAskFiles, setUploadOnAskFiles] = useState<File[]>([]);
  const [persistentFiles, setPersistentFiles] = useState<KbFile[]>([]);
  const [alwaysUseUploadedFiles, setAlwaysUseUploadedFiles] = useState(false);
  const [serverBase, setServerBase] = useState("http://localhost:8787");
  const [runtimeReady, setRuntimeReady] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySource, setApiKeySource] = useState<ApiKeySource>("none");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState(10);
  const [monthlySpendUsd, setMonthlySpendUsd] = useState(0);
  const [monthlyBalanceUsd, setMonthlyBalanceUsd] = useState<number | null>(null);
  const [usageMonthLabel, setUsageMonthLabel] = useState(new Date().toLocaleString(undefined, { month: "long" }));
  const [usageResetDays, setUsageResetDays] = useState(0);
  const [usageWarning, setUsageWarning] = useState("");
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageLastUpdatedAt, setUsageLastUpdatedAt] = useState<number | null>(null);
  const [usageBudgetFromApi, setUsageBudgetFromApi] = useState(false);

  const uploadOnAskInputRef = useRef<HTMLInputElement | null>(null);
  const persistentInputRef = useRef<HTMLInputElement | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const isCapturingRef = useRef(false);
  const isBusyRef = useRef(false);
  const selectedSourceIdRef = useRef<string | null>(null);
  const shortcutBannerTimerRef = useRef<number | null>(null);
  const toggleCaptureRef = useRef<() => Promise<void>>(async () => {});

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sinkGainRef = useRef<GainNode | null>(null);

  const captureSampleRateRef = useRef<number>(TARGET_PCM_RATE);

  const ringChunksRef = useRef<Float32Array[]>([]);
  const ringFramesRef = useRef(0);

  const segmentChunksRef = useRef<Float32Array[]>([]);
  const segmentFramesRef = useRef(0);

  const realtimeSessionIdRef = useRef<string | null>(null);
  const realtimeChunkQueueRef = useRef<string[]>([]);
  const realtimeFlushTimerRef = useRef<number | null>(null);
  const realtimeFlushingRef = useRef(false);
  const realtimeFailedRef = useRef(false);
  const realtimeFailMessageRef = useRef<string>("");
  const usageRefreshInFlightRef = useRef(false);

  function showShortcutToast(text: string) {
    setShortcutBanner(text);
    if (shortcutBannerTimerRef.current != null) {
      window.clearTimeout(shortcutBannerTimerRef.current);
    }
    shortcutBannerTimerRef.current = window.setTimeout(() => {
      setShortcutBanner("");
      shortcutBannerTimerRef.current = null;
    }, 2200);
  }

  function pushRingChunk(chunk: Float32Array) {
    ringChunksRef.current.push(chunk);
    ringFramesRef.current += chunk.length;

    const maxFrames = Math.floor((captureSampleRateRef.current * PREROLL_MS) / 1000);
    while (ringFramesRef.current > maxFrames && ringChunksRef.current.length > 0) {
      const removed = ringChunksRef.current.shift();
      ringFramesRef.current -= removed?.length || 0;
    }
  }

  function pushSegmentChunk(chunk: Float32Array) {
    segmentChunksRef.current.push(chunk);
    segmentFramesRef.current += chunk.length;
  }

  async function refreshPersistentFiles() {
    const resp = await fetch(`${serverBase}/kb/files`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Failed to list files");
    setPersistentFiles(Array.isArray(data?.files) ? data.files : []);
  }

  async function fetchApiKeyStatus() {
    const resp = await fetch(`${serverBase}/config/api-key/status`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Failed to read API key status");
    const source = (data?.source || "none") as ApiKeySource;
    const has = Boolean(data?.hasApiKey);
    setApiKeySource(source);
    setHasApiKey(has);
    return { source, has };
  }

  async function refreshUsageSummary() {
    if (usageRefreshInFlightRef.current) return;
    usageRefreshInFlightRef.current = true;
    setUsageLoading(true);

    try {
      const resp = await fetch(`${serverBase}/usage/summary`);
      const data = (await resp.json()) as UsageSummaryResponse & { error?: string };
      if (!resp.ok) throw new Error(data?.error || "Failed to load usage summary");

      const used = Number(data.usedUsd || 0);
      const budgetFromApi = Number.isFinite(Number(data.budgetUsd)) ? Number(data.budgetUsd) : null;
      const storedFallbackBudget = Number(localStorage.getItem(USAGE_BUDGET_STORAGE) || "");
      const fallbackBudget = Number.isFinite(storedFallbackBudget) && storedFallbackBudget > 0 ? storedFallbackBudget : null;
      const effectiveBudget = budgetFromApi != null && budgetFromApi > 0 ? budgetFromApi : fallbackBudget;

      const balanceFromApi = Number.isFinite(Number(data.remainingUsd)) ? Number(data.remainingUsd) : null;
      const effectiveBalance =
        balanceFromApi != null
          ? Math.max(0, balanceFromApi)
          : effectiveBudget != null
            ? Math.max(0, effectiveBudget - used)
            : null;

      setMonthlySpendUsd(Math.max(0, used));
      if (effectiveBudget != null) {
        setMonthlyBudgetUsd(effectiveBudget);
      }
      setMonthlyBalanceUsd(effectiveBalance);
      setUsageMonthLabel(String(data.monthLabel || new Date().toLocaleString(undefined, { month: "long" })));
      setUsageResetDays(Math.max(0, Number(data.resetDays || 0)));
      setUsageBudgetFromApi(Boolean(data.budgetFromOpenAI && budgetFromApi != null));
      setUsageWarning(String(data.warning || ""));
      setUsageLastUpdatedAt(Date.now());
    } catch (e: any) {
      setUsageWarning(`Usage unavailable: ${e?.message || e}`);
    } finally {
      usageRefreshInFlightRef.current = false;
      setUsageLoading(false);
    }
  }

  async function bootstrapApiKeyFromLocalStorage() {
    const saved = localStorage.getItem(LOCAL_API_KEY_STORAGE)?.trim() || "";
    const status = await fetchApiKeyStatus();

    if (!status.has && saved) {
      const applyResp = await fetch(`${serverBase}/config/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: saved })
      });
      const applyData = await applyResp.json();
      if (!applyResp.ok) throw new Error(applyData?.error || "Failed to apply saved API key");
      return fetchApiKeyStatus();
    }

    return status;
  }

  async function captureSelectedSourceScreenshot(): Promise<string | undefined> {
    if (!selectedSourceId) return undefined;
    const pngBytes = await window.bridge.screenshotSource(selectedSourceId);
    return u8ToBase64(new Uint8Array(pngBytes));
  }

  async function cancelRealtimeSession() {
    const sessionId = realtimeSessionIdRef.current;
    realtimeSessionIdRef.current = null;
    realtimeChunkQueueRef.current = [];
    realtimeFlushingRef.current = false;

    if (realtimeFlushTimerRef.current) {
      window.clearTimeout(realtimeFlushTimerRef.current);
      realtimeFlushTimerRef.current = null;
    }

    if (!sessionId) return;

    try {
      await fetch(`${serverBase}/rt/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
    } catch {
      // ignore cancellation errors
    }
  }

  async function teardownAudioPipeline() {
    const processor = processorNodeRef.current;
    const source = mediaSourceNodeRef.current;
    const sink = sinkGainRef.current;
    const ctx = audioContextRef.current;

    processorNodeRef.current = null;
    mediaSourceNodeRef.current = null;
    sinkGainRef.current = null;
    audioContextRef.current = null;

    if (processor) {
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        // noop
      }
    }

    if (source) {
      try {
        source.disconnect();
      } catch {
        // noop
      }
    }

    if (sink) {
      try {
        sink.disconnect();
      } catch {
        // noop
      }
    }

    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // noop
      }
    }
  }

  function queueRealtimeChunk(chunk: Float32Array) {
    const b64 = floatChunkToPCM16Base64(chunk, captureSampleRateRef.current);
    if (!b64) return;
    realtimeChunkQueueRef.current.push(b64);
    scheduleRealtimeFlush();
  }

  function scheduleRealtimeFlush(delayMs = PCM_FLUSH_MS) {
    if (realtimeFlushTimerRef.current != null) return;
    realtimeFlushTimerRef.current = window.setTimeout(() => {
      realtimeFlushTimerRef.current = null;
      void flushRealtimeQueue();
    }, delayMs);
  }

  async function flushRealtimeQueue() {
    if (realtimeFlushingRef.current) return;
    const sessionId = realtimeSessionIdRef.current;
    if (!sessionId) return;
    if (realtimeChunkQueueRef.current.length === 0) return;

    realtimeFlushingRef.current = true;
    const batch = realtimeChunkQueueRef.current.splice(0, realtimeChunkQueueRef.current.length);

    try {
      const resp = await fetch(`${serverBase}/rt/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, audioChunks: batch })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || "Realtime append failed");
    } catch (e: any) {
      realtimeFailedRef.current = true;
      realtimeFailMessageRef.current = e?.message || String(e);
    } finally {
      realtimeFlushingRef.current = false;
      if (realtimeChunkQueueRef.current.length > 0 && (isCapturingRef.current || realtimeSessionIdRef.current)) {
        scheduleRealtimeFlush(30);
      }
    }
  }

  async function setupAudioPipeline(stream: MediaStream) {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error(
        "No audio track captured from that source. Try selecting Screen 1/2 instead of a window, and ensure system audio is active."
      );
    }

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("AudioContext is unavailable in this environment.");
    }

    const ctx: AudioContext = new AudioCtx();
    await ctx.resume().catch(() => {});

    captureSampleRateRef.current = ctx.sampleRate || TARGET_PCM_RATE;

    const audioOnlyStream = new MediaStream([audioTrack]);
    const sourceNode = ctx.createMediaStreamSource(audioOnlyStream);
    const processor = ctx.createScriptProcessor(SCRIPT_PROCESSOR_SIZE, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;

    sourceNode.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      if (!input || input.length === 0) return;

      const chunk = new Float32Array(input.length);
      chunk.set(input);

      pushRingChunk(chunk);

      if (!isCapturingRef.current) return;

      pushSegmentChunk(chunk);
      queueRealtimeChunk(chunk);
    };

    audioContextRef.current = ctx;
    mediaSourceNodeRef.current = sourceNode;
    processorNodeRef.current = processor;
    sinkGainRef.current = sink;
  }

  function resetBuffers() {
    ringChunksRef.current = [];
    ringFramesRef.current = 0;
    segmentChunksRef.current = [];
    segmentFramesRef.current = 0;
    realtimeChunkQueueRef.current = [];
  }

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  useEffect(() => {
    selectedSourceIdRef.current = selectedSourceId;
  }, [selectedSourceId]);

  useEffect(() => {
    const storedBudget = Number(localStorage.getItem(USAGE_BUDGET_STORAGE) || "");
    if (Number.isFinite(storedBudget) && storedBudget > 0) {
      setMonthlyBudgetUsd(storedBudget);
      setMonthlyBalanceUsd(storedBudget);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const runtime = await window.bridge.getRuntimeInfo();
        if (cancelled) return;

        if (runtime?.serverBaseUrl) {
          setServerBase(runtime.serverBaseUrl);
        }
        setAppVersion(runtime?.appVersion || "");
      } catch (e: any) {
        if (cancelled) return;
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: "assistant",
            text: `Runtime startup error: ${e?.message || e}`,
            createdAt: Date.now()
          }
        ]);
      } finally {
        if (!cancelled) setRuntimeReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!runtimeReady) return;

    (async () => {
      try {
        const list = await window.bridge.listSources();
        setSources(list);

        const status = await withRetry(
          () => bootstrapApiKeyFromLocalStorage(),
          25,
          250,
          "Backend did not become ready"
        );
        if (!status.has) {
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              role: "assistant",
              text: "OpenAI API key is missing. Open Settings / About to add your key.",
              createdAt: Date.now()
            }
          ]);
          setPersistentFiles([]);
          setUsageWarning("Add an OpenAI API key in Settings to show real usage and remaining balance.");
          return;
        }

        await withRetry(
          async () => {
            const kbInitResp = await fetch(`${serverBase}/kb/init`, { method: "POST" });
            const kbInitData = await kbInitResp.json();
            if (!kbInitResp.ok) {
              throw new Error(kbInitData?.error || "Failed to initialize knowledge base");
            }
          },
          8,
          250,
          "Knowledge base initialization failed"
        );

        await refreshPersistentFiles();
        void refreshUsageSummary();
      } catch (e: any) {
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: "assistant",
            text: `Startup error: ${e?.message || e}`,
            createdAt: Date.now()
          }
        ]);
      }
    })();
  }, [runtimeReady, serverBase]);

  useEffect(() => {
    if (!runtimeReady || !hasApiKey) return;

    void refreshUsageSummary();
    const timer = window.setInterval(() => {
      void refreshUsageSummary();
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [runtimeReady, hasApiKey, serverBase]);

  useEffect(() => {
    return () => {
      if (shortcutBannerTimerRef.current != null) {
        window.clearTimeout(shortcutBannerTimerRef.current);
        shortcutBannerTimerRef.current = null;
      }
      isCapturingRef.current = false;
      setIsCapturing(false);
      void cancelRealtimeSession();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setActiveStream(null);
      void teardownAudioPipeline();
      resetBuffers();
    };
  }, []);

  async function refreshSources() {
    const list = await window.bridge.listSources();
    setSources(list);
  }

  async function selectSource(src: Source) {
    setSelectedSourceId(src.id);
    setSelectedSourceName(src.name);

    isCapturingRef.current = false;
    setIsCapturing(false);
    await cancelRealtimeSession();

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActiveStream(null);

    await teardownAudioPipeline();
    resetBuffers();

    try {
      const stream = await getDesktopStream(src.id);
      streamRef.current = stream;
      setActiveStream(stream);
      await setupAudioPipeline(stream);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: `Failed to start capture source: ${e?.message || e}`,
          createdAt: Date.now()
        }
      ]);
    }
  }

  async function startCapture() {
    if (!selectedSourceId) return;
    if (!streamRef.current) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: "Please select a source with capturable audio first.",
          createdAt: Date.now()
        }
      ]);
      return;
    }

    if (streamRef.current.getAudioTracks().length === 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text:
            "No audio track captured from that source. Try selecting a full Screen (Screen 1/2) and ensure system audio is playing.",
          createdAt: Date.now()
        }
      ]);
      return;
    }

    setIsBusy(true);

    realtimeFailedRef.current = false;
    realtimeFailMessageRef.current = "";

    segmentChunksRef.current = [...ringChunksRef.current];
    segmentFramesRef.current = ringFramesRef.current;

    realtimeChunkQueueRef.current = [];
    for (const chunk of ringChunksRef.current) {
      const b64 = floatChunkToPCM16Base64(chunk, captureSampleRateRef.current);
      if (b64) realtimeChunkQueueRef.current.push(b64);
    }

    isCapturingRef.current = true;
    setIsCapturing(true);

    try {
      const resp = await fetch(`${serverBase}/rt/start`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || "Failed to start realtime transcription");

      realtimeSessionIdRef.current = String(data.sessionId || "");
      if (!realtimeSessionIdRef.current) {
        throw new Error("Missing realtime session id");
      }

      scheduleRealtimeFlush(0);
    } catch (e: any) {
      isCapturingRef.current = false;
      setIsCapturing(false);
      realtimeSessionIdRef.current = null;
      realtimeChunkQueueRef.current = [];

      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: `Realtime transcription failed to start: ${e?.message || e}`,
          createdAt: Date.now()
        }
      ]);
    } finally {
      setIsBusy(false);
    }
  }

  async function stopCaptureAndAsk() {
    const stopPressedAt = Date.now();
    const sessionId = realtimeSessionIdRef.current;

    isCapturingRef.current = false;
    setIsCapturing(false);

    if (realtimeFlushTimerRef.current != null) {
      window.clearTimeout(realtimeFlushTimerRef.current);
      realtimeFlushTimerRef.current = null;
    }

    await flushRealtimeQueue();

    const typed = question.trim();
    const forceUseFiles =
      uploadOnAskFiles.length > 0 || (alwaysUseUploadedFiles && persistentFiles.length > 0);

    const typedNeedsVision = shouldIncludeScreenshot(typed);
    const eagerScreenshotPromise = typedNeedsVision
      ? captureSelectedSourceScreenshot()
      : Promise.resolve<string | undefined>(undefined);

    setQuestion("");
    setIsBusy(true);

    try {
      const uploadPromise = (async () => {
        if (uploadOnAskFiles.length === 0) return;
        const form = new FormData();
        for (const f of uploadOnAskFiles) form.append("files", f);

        const uploadResp = await fetch(`${serverBase}/kb/upload`, { method: "POST", body: form });
        const uploadData = await uploadResp.json();
        if (!uploadResp.ok) throw new Error(uploadData?.error || "Upload-on-ask failed");

        setUploadOnAskFiles([]);
        if (uploadOnAskInputRef.current) uploadOnAskInputRef.current.value = "";
        await refreshPersistentFiles();
      })();

      const transcriptPromise = (async () => {
        if (!sessionId) return "";
        const resp = await fetch(`${serverBase}/rt/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || "Failed to finalize realtime transcript");
        return String(data?.transcript || "").trim();
      })();

      const transcript = await transcriptPromise;
      await uploadPromise;

      const needsScreenshot = typedNeedsVision || shouldIncludeScreenshot(transcript);
      let screenshotBase64 = await eagerScreenshotPromise;
      if (!screenshotBase64 && needsScreenshot) {
        screenshotBase64 = await captureSelectedSourceScreenshot();
      }

      realtimeSessionIdRef.current = null;

      let audioDataUrl: string | undefined;
      if (!transcript) {
        const wavBlob = monoChunksToWavBlob(segmentChunksRef.current, captureSampleRateRef.current);
        if (wavBlob && wavBlob.size > 1000) {
          audioDataUrl = await blobToDataUrl(wavBlob);
        }
      }

      if (!transcript && !audioDataUrl) {
        throw new Error(
          realtimeFailedRef.current && realtimeFailMessageRef.current
            ? `No transcript and fallback audio missing. Realtime error: ${realtimeFailMessageRef.current}`
            : "No transcript and no capturable audio were produced."
        );
      }

      const askResp = await fetch(`${serverBase}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          typedQuestion: typed,
          transcript,
          audioDataUrl,
          screenshotBase64Png: screenshotBase64,
          useFiles: forceUseFiles
        })
      });

      const askData = await askResp.json();
      if (!askResp.ok) throw new Error(askData?.error || "Request failed");

      const finalTranscript = String(askData?.transcript || transcript || "").trim();
      const userText = typed.length > 0 ? typed : finalTranscript || "(no transcript)";

      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", text: userText, createdAt: stopPressedAt },
        {
          id: uid(),
          role: "assistant",
          text: askData.answerText,
          transcript: finalTranscript,
          createdAt: Date.now()
        }
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: `Error: ${e?.message || e}`,
          createdAt: Date.now()
        }
      ]);
      await cancelRealtimeSession();
    } finally {
      segmentChunksRef.current = [];
      segmentFramesRef.current = 0;
      setIsBusy(false);
    }
  }

  async function sendPromptOnly() {
    const typed = question.trim();
    if (!typed) return;

    const sendPressedAt = Date.now();
    const useFiles = uploadOnAskFiles.length > 0 || (alwaysUseUploadedFiles && persistentFiles.length > 0);
    const needsScreenshot = shouldIncludeScreenshot(typed);

    setQuestion("");
    setIsBusy(true);

    try {
      const uploadPromise = (async () => {
        if (uploadOnAskFiles.length === 0) return;
        const form = new FormData();
        for (const f of uploadOnAskFiles) form.append("files", f);

        const uploadResp = await fetch(`${serverBase}/kb/upload`, { method: "POST", body: form });
        const uploadData = await uploadResp.json();
        if (!uploadResp.ok) throw new Error(uploadData?.error || "Upload-on-ask failed");

        setUploadOnAskFiles([]);
        if (uploadOnAskInputRef.current) uploadOnAskInputRef.current.value = "";
        await refreshPersistentFiles();
      })();

      const screenshotPromise = needsScreenshot
        ? captureSelectedSourceScreenshot()
        : Promise.resolve<string | undefined>(undefined);

      const [screenshotBase64] = await Promise.all([screenshotPromise, uploadPromise]);

      const askResp = await fetch(`${serverBase}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          typedQuestion: typed,
          screenshotBase64Png: screenshotBase64,
          useFiles
        })
      });

      const askData = await askResp.json();
      if (!askResp.ok) throw new Error(askData?.error || "Request failed");

      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", text: typed, createdAt: sendPressedAt },
        {
          id: uid(),
          role: "assistant",
          text: askData.answerText,
          transcript: askData.transcript,
          createdAt: Date.now()
        }
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: `Error: ${e?.message || e}`,
          createdAt: Date.now()
        }
      ]);
    } finally {
      setIsBusy(false);
    }
  }

  async function toggleCapture() {
    if (!selectedSourceId) return;
    if (isBusy) return;

    if (!isCapturing) {
      await startCapture();
      return;
    }

    await stopCaptureAndAsk();
  }

  toggleCaptureRef.current = toggleCapture;

  useEffect(() => {
    return window.bridge.onToggleCaptureShortcut(() => {
      const wasCapturing = isCapturingRef.current;

      if (isBusyRef.current) {
        showShortcutToast("Shortcut ignored: app is busy.");
        return;
      }

      if (!wasCapturing && !selectedSourceIdRef.current) {
        showShortcutToast("Select a source before starting capture (Ctrl + Alt + A).");
        return;
      }

      void toggleCaptureRef.current().then(() => {
        showShortcutToast(
          wasCapturing
            ? "Capture stopped via Ctrl + Alt + A"
            : "Capture started via Ctrl + Alt + A"
        );
      });
    });
  }, []);

  async function popoutAssistantMessage(msg: ChatMessage) {
    if (msg.role !== "assistant" || !msg.text?.trim()) return;
    try {
      await window.bridge.openStickyNote(msg.text);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: `Failed to open sticky note: ${e?.message || e}`,
          createdAt: Date.now()
        }
      ]);
    }
  }

  async function uploadPersistent(files: FileList | null) {
    if (!files || files.length === 0) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));

    const resp = await fetch(`${serverBase}/kb/upload`, { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Persistent upload failed");

    if (persistentInputRef.current) persistentInputRef.current.value = "";
    await refreshPersistentFiles();
  }

  function addUploadOnAsk(files: FileList | null) {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files);
    setUploadOnAskFiles((prev) => [...prev, ...incoming]);
    if (uploadOnAskInputRef.current) uploadOnAskInputRef.current.value = "";
  }

  function removeUploadOnAsk(index: number) {
    setUploadOnAskFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function removePersistent(vectorStoreFileId: string) {
    const resp = await fetch(`${serverBase}/kb/file/${encodeURIComponent(vectorStoreFileId)}`, {
      method: "DELETE"
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Failed to remove file");
    await refreshPersistentFiles();
  }

  async function saveApiKeyFromSettings() {
    const apiKey = apiKeyInput.trim();
    if (!apiKey) {
      setApiKeyMessage("Enter an API key first.");
      return;
    }

    setApiKeyMessage("Saving key...");
    const resp = await fetch(`${serverBase}/config/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Failed to save API key");

    localStorage.setItem(LOCAL_API_KEY_STORAGE, apiKey);
    await fetchApiKeyStatus();

    const kbInitResp = await fetch(`${serverBase}/kb/init`, { method: "POST" });
    const kbInitData = await kbInitResp.json();
    if (!kbInitResp.ok) throw new Error(kbInitData?.error || "Failed to initialize knowledge base");

    await refreshPersistentFiles();
    await refreshUsageSummary();
    setApiKeyInput("");
    setApiKeyMessage("API key saved and applied.");
  }

  async function clearSavedApiKeyFromSettings() {
    setApiKeyMessage("Clearing saved key...");
    localStorage.removeItem(LOCAL_API_KEY_STORAGE);

    const resp = await fetch(`${serverBase}/config/api-key`, { method: "DELETE" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error || "Failed to clear API key");

    const status = await fetchApiKeyStatus();
    if (!status.has) {
      setPersistentFiles([]);
      setMonthlySpendUsd(0);
      setMonthlyBalanceUsd(null);
      setUsageWarning("Add an OpenAI API key to fetch live usage.");
    }
    setApiKeyMessage("Saved in-app key cleared.");
  }

  const apiKeySourceLabel =
    apiKeySource === "env"
      ? ".env / process environment"
      : apiKeySource === "app"
        ? "Saved in app settings"
        : "Not configured";

  const usagePercent = monthlyBudgetUsd > 0 ? Math.min(100, (monthlySpendUsd / monthlyBudgetUsd) * 100) : 0;

  function formatUsd(value: number) {
    return `$${value.toFixed(2)}`;
  }

  function editUsageBudget() {
    if (usageBudgetFromApi) {
      setUsageWarning("Budget comes from OpenAI account settings.");
      void refreshUsageSummary();
      return;
    }

    const raw = window.prompt("Set monthly API budget (USD)", String(monthlyBudgetUsd));
    if (raw == null) return;
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const rounded = Math.round(parsed * 100) / 100;
    setMonthlyBudgetUsd(rounded);
    setMonthlyBalanceUsd(Math.max(0, rounded - monthlySpendUsd));
    setUsageWarning("Using local budget fallback. Set OPENAI_MONTHLY_BUDGET_USD for server-side fallback.");
    localStorage.setItem(USAGE_BUDGET_STORAGE, String(rounded));
  }

  return (
    <div className="app">
      <div className="left">
        <div className="header">
          <h1>Chat</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pill" onClick={refreshSources}>
              Refresh windows
            </button>
            <button className="pill" onClick={() => setShowSettings(true)}>
              Settings / About
            </button>
          </div>
        </div>

        <ChatPane messages={messages} onPopoutAssistant={(msg) => void popoutAssistantMessage(msg)} />

        <div className="composer">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              if (isBusy || question.trim().length === 0) return;
              e.preventDefault();
              void sendPromptOnly();
            }}
            placeholder="Optional: type a question/instruction (otherwise transcript is used)"
          />
          <button className="pill" onClick={sendPromptOnly} disabled={isBusy || question.trim().length === 0}>
            Send
          </button>
          <button className="pill" onClick={toggleCapture} disabled={!selectedSourceId || isBusy}>
            {isCapturing ? "Stop + Answer" : "Capture"}
          </button>
        </div>
        <div className="statusBar">
          <span>{isCapturing ? "Capture: Active" : "Capture: Idle"}</span>
          <span>Shortcut: Ctrl + Alt + A</span>
          <span>{hasApiKey ? `API key: ${apiKeySourceLabel}` : "API key: missing (open Settings / About)"}</span>
          <span>{runtimeReady ? `Backend: ${serverBase}` : "Backend: initializing..."}</span>
          {appVersion && <span>App version: {appVersion}</span>}
          {shortcutBanner && <span>{shortcutBanner}</span>}
        </div>
      </div>

      <div className="right">
        <div className="header" style={{ justifyContent: "space-between" }}>
          <h1>{selectedSourceName}</h1>
          <div style={{ display: "flex", gap: 10 }}>
            <label className="pill" style={{ cursor: "pointer" }}>
              Upload (persistent)
              <input
                ref={persistentInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  void uploadPersistent(e.target.files).catch((err) => {
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: uid(),
                        role: "assistant",
                        text: `Upload error: ${err?.message || err}`,
                        createdAt: Date.now()
                      }
                    ]);
                  });
                }}
              />
            </label>

            <label className="pill" style={{ cursor: "pointer" }}>
              Upload on ask
              <input
                ref={uploadOnAskInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => addUploadOnAsk(e.target.files)}
              />
            </label>
          </div>
        </div>

        <div className="usageSection">
          <div className="fileSectionTitle">Usage</div>
          <div className="usageCard">
            <div className="usageLabel">{usageMonthLabel} usage</div>
            <div className="usageValue">{formatUsd(monthlySpendUsd)} used</div>
            <div className="usageSubValue">
              {monthlyBalanceUsd != null
                ? `${formatUsd(monthlyBalanceUsd)} left of ${formatUsd(monthlyBudgetUsd)}`
                : `Budget limit unavailable${monthlyBudgetUsd > 0 ? ` (fallback ${formatUsd(monthlyBudgetUsd)})` : ""}`}
            </div>
            <div className="usageBar">
              <div className="usageBarFill" style={{ width: `${usagePercent}%` }} />
              <div className="usageBarMarker" />
            </div>
            <div className="usageMeta">
              <span>Resets in {usageResetDays} days.</span>
              <button className="usageLink" onClick={editUsageBudget}>
                {usageBudgetFromApi ? "Refresh" : "Edit budget"}
              </button>
            </div>
            {usageWarning && <div className="usageWarning">{usageWarning}</div>}
            {usageLastUpdatedAt && (
              <div className="usageStamp">
                Updated {new Date(usageLastUpdatedAt).toLocaleTimeString()}
                {usageLoading ? " (refreshing...)" : ""}
              </div>
            )}
          </div>
        </div>

        <div className="fileSection">
          <label
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={alwaysUseUploadedFiles}
              onChange={(e) => setAlwaysUseUploadedFiles(e.target.checked)}
            />
            Always use uploaded files
          </label>
          <div className="fileEmpty" style={{ marginTop: 6 }}>
            {alwaysUseUploadedFiles
              ? "Maximum-context mode: persistent files are included on every answer."
              : "Lower-latency mode: only Upload-on-ask files are included by default."}
          </div>
        </div>

        <div className="fileSection">
          <div className="fileSectionTitle">Persistent files</div>
          <div className="fileChips">
            {persistentFiles.length === 0 ? (
              <span className="fileEmpty">None uploaded</span>
            ) : (
              persistentFiles.map((f) => (
                <span key={f.vectorStoreFileId} className="fileChip">
                  <span className="fileName" title={f.name}>
                    {f.name}
                  </span>
                  <button
                    className="fileRemove"
                    onClick={() => {
                      void removePersistent(f.vectorStoreFileId).catch((err) => {
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: uid(),
                            role: "assistant",
                            text: `Remove error: ${err?.message || err}`,
                            createdAt: Date.now()
                          }
                        ]);
                      });
                    }}
                    title="Remove file"
                  >
                    x
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        <div className="fileSection" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="fileSectionTitle">Upload on ask files</div>
          <div className="fileChips">
            {uploadOnAskFiles.length === 0 ? (
              <span className="fileEmpty">None queued</span>
            ) : (
              uploadOnAskFiles.map((f, idx) => (
                <span key={`${f.name}-${idx}`} className="fileChip">
                  <span className="fileName" title={f.name}>
                    {f.name}
                  </span>
                  <button className="fileRemove" onClick={() => removeUploadOnAsk(idx)} title="Remove from queue">
                    x
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        <RightPane
          sources={sources}
          selectedSourceId={selectedSourceId}
          onPick={selectSource}
          stream={activeStream}
          isCapturing={isCapturing}
          uploadOnAskCount={uploadOnAskFiles.length}
        />
      </div>

      {showSettings && (
        <div className="modalBackdrop" onClick={() => setShowSettings(false)}>
          <div className="modalCard" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2>Settings / About / Legal</h2>
              <button className="pill" onClick={() => setShowSettings(false)}>
                X
              </button>
            </div>

            <div className="modalSection">
              <div className="modalTitle">OpenAI API key</div>
              <input
                className="modalInput"
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Paste your OpenAI API key (sk-...)"
              />
              <div className="fileEmpty">Current source: {apiKeySourceLabel}</div>
              <div className="modalActions">
                <button
                  className="pill"
                  onClick={() => {
                    void saveApiKeyFromSettings().catch((err) => {
                      setApiKeyMessage(`Save failed: ${err?.message || err}`);
                    });
                  }}
                >
                  Save key
                </button>
                <button
                  className="pill"
                  onClick={() => {
                    void clearSavedApiKeyFromSettings().catch((err) => {
                      setApiKeyMessage(`Clear failed: ${err?.message || err}`);
                    });
                  }}
                >
                  Clear saved key
                </button>
              </div>
              {apiKeyMessage && <div className="modalNotice">{apiKeyMessage}</div>}
            </div>

            <div className="modalSection">
              <div className="modalTitle">About</div>
              <div>Built by Ahan Bhatt</div>
              <div>Contact: bhattahan@gmail.com</div>
              <div>Website: https://ahanbhatt.github.io/Personal-Website/</div>
            </div>

            <div className="modalSection">
              <div className="modalTitle">Responsible-use disclaimer</div>
              <div>This app is designed to assist people during meetings.</div>
              <div>It is not intended for unethical use.</div>
              <div>By using this app, you are solely responsible for your actions.</div>
              <div>The developer is not responsible for how users choose to use the app.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

