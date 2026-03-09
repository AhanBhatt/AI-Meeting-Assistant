import OpenAI from "openai";

const initialEnvApiKey = (process.env.OPENAI_API_KEY || "").trim();
let runtimeApiKey = "";
let cachedKey = "";
let cachedClient: OpenAI | null = null;

export function getApiKey(): string {
  return (runtimeApiKey || initialEnvApiKey || "").trim();
}

export function getApiKeySource(): "env" | "app" | "none" {
  if (runtimeApiKey) return "app";
  if (initialEnvApiKey) return "env";
  return "none";
}

export function hasApiKey(): boolean {
  return getApiKey().length > 0;
}

export function setRuntimeApiKey(apiKey: string): void {
  runtimeApiKey = String(apiKey || "").trim();
}

export function clearRuntimeApiKey(): void {
  runtimeApiKey = "";
}

export function getModel(): string {
  return process.env.OPENAI_MODEL || "gpt-5.3-chat-latest";
}

export function getClient(): OpenAI {
  const key = getApiKey();
  if (!key) {
    throw new Error("OPENAI_API_KEY is missing. Add your key in Settings.");
  }

  if (cachedClient && cachedKey === key) {
    return cachedClient;
  }

  cachedClient = new OpenAI({ apiKey: key });
  cachedKey = key;
  return cachedClient;
}
