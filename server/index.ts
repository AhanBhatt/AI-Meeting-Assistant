import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import {
  addFilesToVectorStore,
  ensureVectorStore,
  listVectorStoreFiles,
  removeVectorStoreFile,
  vectorStoreId
} from "./kb";
import {
  clearRuntimeApiKey,
  getApiKey,
  getApiKeySource,
  getClient,
  getModel,
  hasApiKey,
  setRuntimeApiKey
} from "./openai";
import {
  appendRealtimeAudio,
  cancelRealtimeTranscriptionSession,
  getRealtimeTranscript,
  startRealtimeTranscriptionSession,
  stopRealtimeTranscriptionSession
} from "./realtime";
import { transcribeAudioDataUrl } from "./transcribe";

type StartServerOptions = {
  port?: number;
  preferRandomPortOnBusy?: boolean;
};

type StartedServer = {
  app: express.Express;
  port: number;
  close: () => Promise<void>;
};

type UsageSummary = {
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

let usageCache:
  | {
      key: string;
      at: number;
      value: UsageSummary;
    }
  | null = null;

function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function monthLabelUtc(now = new Date()): string {
  return now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
}

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function budgetFromEnv(): number | null {
  const n = safeNum(process.env.OPENAI_MONTHLY_BUDGET_USD);
  if (n == null || n <= 0) return null;
  return n;
}

async function fetchJsonWithBearer(url: string, apiKey: string): Promise<any> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}${text ? `: ${text.slice(0, 220)}` : ""}`);
  }

  return resp.json();
}

async function fetchUsageFromOrgCosts(apiKey: string, now = new Date()): Promise<UsageSummary> {
  const monthStart = startOfUtcMonth(now);
  const nextMonthStart = startOfNextUtcMonth(now);
  const startTime = Math.floor(monthStart.getTime() / 1000);
  const endTime = Math.floor(Math.min(Date.now(), nextMonthStart.getTime()) / 1000);

  const data = await fetchJsonWithBearer(
    `https://api.openai.com/v1/organization/costs?start_time=${startTime}&end_time=${endTime}`,
    apiKey
  );

  const rows = Array.isArray(data?.data) ? data.data : [];
  let usedUsd = 0;
  for (const row of rows) {
    const amount = safeNum(row?.amount?.value ?? row?.amount?.usd);
    if (amount != null) usedUsd += amount;
  }

  const budgetUsd = budgetFromEnv();
  const remainingUsd = budgetUsd != null ? Math.max(0, budgetUsd - usedUsd) : null;
  const resetDays = Math.max(0, Math.ceil((nextMonthStart.getTime() - now.getTime()) / 86400000));

  return {
    monthLabel: monthLabelUtc(now),
    usedUsd,
    budgetUsd,
    remainingUsd,
    resetDays,
    currency: "USD",
    source: "openai-org-costs",
    budgetFromOpenAI: false,
    warning:
      budgetUsd == null
        ? "OpenAI org costs endpoint does not expose budget. Set OPENAI_MONTHLY_BUDGET_USD to compute remaining."
        : undefined
  };
}

function fallbackUsageSummary(warning: string, now = new Date()): UsageSummary {
  const budgetUsd = budgetFromEnv();
  const nextMonthStart = startOfNextUtcMonth(now);
  const resetDays = Math.max(0, Math.ceil((nextMonthStart.getTime() - now.getTime()) / 86400000));

  return {
    monthLabel: monthLabelUtc(now),
    usedUsd: 0,
    budgetUsd,
    remainingUsd: budgetUsd,
    resetDays,
    currency: "USD",
    source: "fallback-local",
    budgetFromOpenAI: false,
    warning
  };
}

function conciseUsagePermissionWarning(err: unknown): string {
  const text = String((err as any)?.message || err || "");
  if (/api\.usage\.read/i.test(text)) {
    return "Live account-wide usage is unavailable for this API key. Use an org key with `api.usage.read` scope.";
  }
  if (/session key/i.test(text) || /dashboard\/billing/i.test(text)) {
    return "Dashboard billing endpoints do not accept secret API keys. Using fallback budget view.";
  }
  return "Live usage is unavailable for this key right now. Using fallback budget view.";
}

async function loadUsageSummary(apiKey: string): Promise<UsageSummary> {
  const cached = usageCache;
  if (cached && cached.key === apiKey && Date.now() - cached.at < 45_000) {
    return cached.value;
  }

  let summary: UsageSummary = fallbackUsageSummary("Loading usage...");
  try {
    summary = await fetchUsageFromOrgCosts(apiKey);
  } catch (orgErr: any) {
    summary = fallbackUsageSummary(conciseUsagePermissionWarning(orgErr));
  }

  usageCache = { key: apiKey, at: Date.now(), value: summary };
  return summary;
}

function shouldUseFileSearch(text: string): boolean {
  return /(resume|background|experience|project|projects|worked on|internship|research|about yourself|about me|my work|my team|work history)/i.test(
    text || ""
  );
}

function wantsCoachingMode(typedQuestion: string): boolean {
  const text = String(typedQuestion || "").trim();
  if (!text) return false;

  return /(coach|coaching|feedback|critique|improve|improvement|mock interview|tips|what should i say|how should i answer|how can i answer|sample answer|answer draft|evaluate my answer|review my answer|rewrite my answer)/i.test(
    text
  );
}

function stripLeadingInstructionPreamble(text: string): string {
  let out = String(text || "");
  const patterns = [
    /^\s*(?:here'?s|this is)\s+(?:a\s+)?(?:strong|good|sample|suggested)\s+answer\s*[:\-]\s*/i,
    /^\s*(?:you\s+(?:can|could|should|may|might)\s+(?:say|answer|respond(?:\s+with)?)(?:\s+something\s+like)?|one\s+way\s+to\s+answer\s+is|a\s+(?:strong|good)\s+answer\s+would\s+be)\s*[:\-]?\s*/i,
    /^\s*(?:mention|highlight|explain\s+that|emphasize)\b[^:\n]{0,90}[:\-]\s*/i,
    /^\s*answer\s*[:\-]\s*/i
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = out.replace(pattern, "");
      if (next !== out) {
        out = next.trimStart();
        changed = true;
      }
    }
  }

  out = out.replace(/^"\s*([\s\S]*?)\s*"\s*$/i, "$1");
  return out.trim();
}

function enforceAnswerStyle(text: string, coachingMode: boolean): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "(no output)";
  if (coachingMode) return trimmed;

  const rewritten = stripLeadingInstructionPreamble(trimmed);
  return rewritten || trimmed;
}

function buildSystemPrompt(options: { coachingMode: boolean; useFileSearch: boolean }): string {
  const { coachingMode, useFileSearch } = options;

  if (coachingMode) {
    return (
      "You are an interview coach. The user explicitly requested coaching/feedback mode. " +
      "You may give advice, suggested phrasing, and improvements. " +
      "Be specific and practical, and keep the response concise but complete. " +
      "Use transcript as primary evidence, uploaded files when available, and screenshot as secondary evidence."
    );
  }

  return (
    "You are the candidate speaking in a live interview. " +
    "Respond in first person as the exact words I should say out loud right now. " +
    "Give the answer itself, not advice about the answer. " +
    "Never use coaching/meta phrasing such as: 'you can say', 'you should say', 'mention', 'highlight', 'explain that', 'a good answer would be'. " +
    "Do not label roles (no interviewer/interviewee tags). " +
    "Use natural spoken interview style, concise but strong, mostly paragraph form unless bullets are explicitly requested. " +
    "If transcript is messy, infer the likely question and answer directly in first person. " +
    "Do not output a partial or cut-off answer. " +
    "Treat transcript as primary source of truth. " +
    (useFileSearch
      ? "Use uploaded files to personalize resume/background/project answers. "
      : "Uploaded-file retrieval is disabled for this request, so do not assume file details. ") +
    "Treat screenshot as secondary evidence only."
  );
}

function buildContinuationPrompt(coachingMode: boolean): string {
  return coachingMode
    ? "Continue exactly where your last answer ended. Do not restart or repeat earlier sections. Finish with complete sentences."
    : "Continue exactly where your last answer ended in the same direct first-person speaking voice. Do not restart or repeat earlier sections. Do not switch to coaching/advice framing. Finish with complete spoken sentences.";
}

function wantsSseResponse(req: express.Request): boolean {
  const streamQuery = String(req.query.stream || "").trim().toLowerCase();
  if (streamQuery === "1" || streamQuery === "true" || streamQuery === "yes") {
    return true;
  }

  const accept = String(req.headers.accept || "");
  return accept.includes("text/event-stream");
}

function beginSse(res: express.Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function writeSse(res: express.Response, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createApiApp(): express.Express {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });

  app.use(
    cors({
      origin: true,
      credentials: false
    })
  );

  app.use(express.json({ limit: "50mb" }));

  app.get("/config/api-key/status", (_req, res) => {
    res.json({
      hasApiKey: hasApiKey(),
      source: getApiKeySource()
    });
  });

  app.get("/usage/summary", async (_req, res) => {
    try {
      const apiKey = getApiKey();
      if (!apiKey) {
        return res.status(400).json({ error: "OpenAI API key is missing. Add it in Settings." });
      }

      const summary = await loadUsageSummary(apiKey);
      res.json(summary);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/config/api-key", (req, res) => {
    const apiKey = String(req.body?.apiKey || "").trim();
    if (!apiKey) {
      return res.status(400).json({ error: "apiKey is required" });
    }

    setRuntimeApiKey(apiKey);
    res.json({
      ok: true,
      hasApiKey: hasApiKey(),
      source: getApiKeySource()
    });
  });

  app.delete("/config/api-key", (_req, res) => {
    clearRuntimeApiKey();
    res.json({
      ok: true,
      hasApiKey: hasApiKey(),
      source: getApiKeySource()
    });
  });

  app.post("/kb/init", async (_req, res) => {
    if (!hasApiKey()) {
      return res.status(400).json({ error: "OpenAI API key is missing. Add it in Settings." });
    }
    const id = await ensureVectorStore();
    res.json({ vectorStoreId: id });
  });

  app.post("/kb/upload", upload.array("files"), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    const added = await addFilesToVectorStore(
      files.map((f) => ({
        buffer: f.buffer,
        originalname: f.originalname,
        mimetype: f.mimetype
      }))
    );
    res.json({ ok: true, count: files.length, files: added });
  });

  app.get("/kb/files", async (_req, res) => {
    if (!hasApiKey()) {
      return res.json({ files: listVectorStoreFiles() });
    }
    await ensureVectorStore();
    res.json({ files: listVectorStoreFiles() });
  });

  app.delete("/kb/file/:vectorStoreFileId", async (req, res) => {
    const id = String(req.params.vectorStoreFileId || "");
    if (!id) return res.status(400).json({ error: "Missing vectorStoreFileId" });

    const removed = await removeVectorStoreFile(id);
    if (!removed) return res.status(404).json({ error: "File not found" });
    res.json({ ok: true });
  });

  app.post("/rt/start", async (_req, res) => {
    try {
      const sessionId = await startRealtimeTranscriptionSession();
      res.json({ sessionId });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/rt/append", async (req, res) => {
    try {
      const { sessionId, audioChunks } = req.body as {
        sessionId: string;
        audioChunks: string[];
      };

      if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
      if (!Array.isArray(audioChunks)) return res.status(400).json({ error: "Missing audioChunks" });

      await appendRealtimeAudio(sessionId, audioChunks);
      res.json({ ok: true, transcript: getRealtimeTranscript(sessionId) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/rt/stop", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId: string };
      if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

      const transcript = await stopRealtimeTranscriptionSession(sessionId);
      res.json({ transcript });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/rt/cancel", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId: string };
      if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

      await cancelRealtimeTranscriptionSession(sessionId);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/ask", async (req, res) => {
    try {
      const { typedQuestion, transcript: transcriptIn, audioDataUrl, screenshotBase64Png, useFiles } = req.body as {
        typedQuestion?: string;
        transcript?: string;
        audioDataUrl?: string;
        screenshotBase64Png?: string;
        useFiles?: boolean;
      };

      const typedTrimmed = typedQuestion?.trim() || "";
      if (!typedTrimmed && !transcriptIn && !audioDataUrl) {
        return res.status(400).json({ error: "Missing typedQuestion, transcript, or audioDataUrl" });
      }

      const transcript = transcriptIn?.trim() || (audioDataUrl ? await transcribeAudioDataUrl(audioDataUrl) : "");

      const finalPrompt =
        typedTrimmed.length > 0
          ? typedTrimmed
          : transcript.trim().length > 0
            ? transcript
            : "Extract the question(s) asked and draft the best possible answer.";
      const coachingMode = wantsCoachingMode(typedTrimmed);

      const kbFiles = listVectorStoreFiles();
      const hasKbFiles = kbFiles.length > 0;
      const kbFileNames = kbFiles.map((f) => f.name).slice(0, 20).join(", ");

      const keywordNeedsFiles = shouldUseFileSearch(`${typedQuestion || ""}\n${transcript || ""}`);
      const useFileSearch = hasKbFiles && (typeof useFiles === "boolean" ? useFiles : keywordNeedsFiles);
      const vsId = useFileSearch ? await ensureVectorStore() : null;

      const userContent: any[] = [
        {
          type: "input_text",
          text:
            "Source priority:\n" +
            "1) Transcript is primary and most important.\n" +
            (useFileSearch
              ? "2) Uploaded files are supporting context (resume/background/projects).\n"
              : "2) Uploaded files are disabled for this request to reduce latency.\n") +
            "3) Screenshot is secondary and should only be used when transcript lacks needed visual detail."
        },
        {
          type: "input_text",
          text: coachingMode
            ? "Mode: coach me (explicitly requested by user). Coaching and feedback are allowed."
            : "Mode: answer as me. Provide only the direct first-person answer I would speak."
        },
        { type: "input_text", text: `Transcript (captured segment):\n${transcript || "(no transcript)"}` },
        { type: "input_text", text: `User instruction (typed if provided, else transcript-as-question):\n${finalPrompt}` }
      ];

      if (hasKbFiles && useFileSearch) {
        userContent.push({
          type: "input_text",
          text: `Uploaded files available for context: ${kbFileNames || "(files uploaded)"}`
        });
      } else if (hasKbFiles && !useFileSearch) {
        userContent.push({
          type: "input_text",
          text: "Uploaded files exist but retrieval is disabled for this answer (lower-latency mode)."
        });
      }

      if (screenshotBase64Png) {
        userContent.push({
          type: "input_image",
          image_url: `data:image/png;base64,${screenshotBase64Png}`,
          detail: "low"
        });
      }

      const client = getClient();
      const model = getModel();

      const responseConfig: any = {
        model,
        max_output_tokens: 900,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: buildSystemPrompt({ coachingMode, useFileSearch })
              }
            ]
          },
          {
            role: "user",
            content: userContent
          }
        ],
        ...(useFileSearch && vsId
          ? {
              tools: [
                {
                  type: "file_search",
                  vector_store_ids: [vsId]
                }
              ]
            }
          : {})
      };

      if (wantsSseResponse(req)) {
        beginSse(res);
        writeSse(res, "transcript", { transcript });

        let answerText = "";
        let lastResponseId: string | null = null;
        let disconnected = false;

        req.on("aborted", () => {
          disconnected = true;
        });
        res.on("close", () => {
          if (!res.writableEnded) {
            disconnected = true;
          }
        });

        try {
          for (let i = 0; i < 3; i++) {
            if (disconnected || res.writableEnded) break;

            if (i > 0 && answerText.length > 0) {
              answerText += "\n";
              writeSse(res, "delta", { delta: "\n" });
            }

            const streamParams: any =
              i === 0
                ? responseConfig
                : {
                    model,
                    previous_response_id: lastResponseId,
                    max_output_tokens: 900,
                    input: [
                      {
                        role: "user",
                        content: [
                          {
                            type: "input_text",
                            text:
                              buildContinuationPrompt(coachingMode)
                          }
                        ]
                      }
                    ]
                  };

            const stream: any = client.responses.stream(streamParams);
            let emittedChunk = "";

            for await (const event of stream) {
              if (disconnected || res.writableEnded) break;

              if (event.type === "response.output_text.delta") {
                const delta = String(event.delta || "");
                if (!delta) continue;
                emittedChunk += delta;
                answerText += delta;
                writeSse(res, "delta", { delta });
              } else if (event.type === "response.refusal.delta") {
                const delta = String(event.delta || "");
                if (!delta) continue;
                emittedChunk += delta;
                answerText += delta;
                writeSse(res, "delta", { delta });
              }
            }

            if (disconnected || res.writableEnded) {
              break;
            }

            const finalResponse: any = await stream.finalResponse();
            const finalChunk = String(finalResponse?.output_text || "");
            lastResponseId = finalResponse?.id || lastResponseId;
            const incompleteReason = finalResponse?.incomplete_details?.reason;

            // If the SDK stream didn't emit every text fragment as deltas, send the missing suffix.
            if (!disconnected && !res.writableEnded && finalChunk && finalChunk !== emittedChunk) {
              const missingSuffix = finalChunk.startsWith(emittedChunk)
                ? finalChunk.slice(emittedChunk.length)
                : emittedChunk
                  ? `\n${finalChunk}`
                  : finalChunk;

              if (missingSuffix) {
                answerText += missingSuffix;
                writeSse(res, "delta", { delta: missingSuffix });
              }
            }

            if (incompleteReason !== "max_output_tokens" || !lastResponseId) {
              break;
            }
          }

          const finalAnswer = enforceAnswerStyle(answerText, coachingMode);
          if (!disconnected && !res.writableEnded) {
            if (answerText.trim().length === 0) {
              writeSse(res, "delta", { delta: finalAnswer });
            }
            writeSse(res, "done", {
              transcript,
              answerText: finalAnswer
            });
            res.end();
          }
          return;
        } catch (streamErr: any) {
          if (disconnected || res.writableEnded) {
            return;
          }
          if (!res.writableEnded) {
            writeSse(res, "error", { error: streamErr?.message || String(streamErr) });
            res.end();
          }
          return;
        }
      }

      let response = await client.responses.create(responseConfig);
      let answerText = response.output_text || "";
      let lastResponse: any = response;

      for (let i = 0; i < 2; i++) {
        const incompleteReason = lastResponse?.incomplete_details?.reason;
        if (incompleteReason !== "max_output_tokens") break;

        const continuation = await client.responses.create({
          model,
          previous_response_id: lastResponse.id,
          max_output_tokens: 900,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildContinuationPrompt(coachingMode)
                }
              ]
            }
          ]
        });

        const chunk = continuation.output_text || "";
        if (chunk) {
          answerText = answerText ? `${answerText.trimEnd()}\n${chunk.trimStart()}` : chunk;
        }
        lastResponse = continuation;
      }

      res.json({
        transcript,
        answerText: enforceAnswerStyle(answerText, coachingMode)
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return app;
}

async function listenOn(app: express.Express, port: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) return closeReject(err);
              closeResolve();
            });
          })
      });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const app = createApiApp();
  const requestedPort = Number(options.port ?? process.env.PORT ?? 8787);

  try {
    const started = await listenOn(app, requestedPort);
    console.log(`Server on http://127.0.0.1:${started.port}`);
    console.log(`Vector store: ${vectorStoreId || "(not created yet)"}`);
    return { app, port: started.port, close: started.close };
  } catch (err: any) {
    if (err?.code === "EADDRINUSE" && options.preferRandomPortOnBusy) {
      const started = await listenOn(app, 0);
      console.log(
        `Port ${requestedPort} is in use. Started backend on http://127.0.0.1:${started.port} instead.`
      );
      console.log(`Vector store: ${vectorStoreId || "(not created yet)"}`);
      return { app, port: started.port, close: started.close };
    }

    if (err?.code === "EADDRINUSE") {
      console.error(`Port ${requestedPort} is already in use. Stop the previous server process and retry.`);
    }
    throw err;
  }
}
