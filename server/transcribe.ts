import { toFile } from "openai";
import { getClient } from "./openai";

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL");
  const mime = match[1];
  const b64 = match[2];
  return { buffer: Buffer.from(b64, "base64"), mime };
}

function normalizeAudioMime(mime: string): string {
  const base = (mime || "").split(";")[0].trim().toLowerCase();
  if (base === "audio/mpga") return "audio/mpeg";
  if (base === "audio/mp3") return "audio/mpeg";
  if (base === "audio/x-m4a") return "audio/m4a";
  if (base.startsWith("audio/")) return base;
  return "audio/webm";
}

function extForMime(mime: string): string {
  if (mime === "audio/mpeg") return ".mp3";
  if (mime === "audio/wav") return ".wav";
  if (mime === "audio/ogg") return ".ogg";
  if (mime === "audio/mp4" || mime === "audio/m4a") return ".m4a";
  if (mime === "audio/flac") return ".flac";
  return ".webm";
}

export async function transcribeAudioDataUrl(audioDataUrl: string): Promise<string> {
  const { buffer, mime } = dataUrlToBuffer(audioDataUrl);
  if (!buffer || buffer.length < 1024) {
    throw new Error("Captured audio is too small to transcribe.");
  }

  const safeMime = normalizeAudioMime(mime || "audio/webm");
  const ext = extForMime(safeMime);
  const file = await toFile(buffer, `capture${ext}`, { type: safeMime });
  const client = getClient();
  console.log(`[transcribe] mime=${safeMime} bytes=${buffer.length}`);

  let lastErr: unknown = null;
  for (const model of ["gpt-4o-mini-transcribe", "whisper-1"] as const) {
    try {
      const tr = await client.audio.transcriptions.create({
        file,
        model
      });
      return (tr as any).text || "";
    } catch (err) {
      console.error(`[transcribe] ${model} failed`, err);
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
