import { toFile } from "openai";
import { getClient } from "./openai";

// simplest: single in-memory KB for now
// in production: persist per-user
export let vectorStoreId: string | null = null;

export type KbStoredFile = {
  vectorStoreFileId: string;
  openaiFileId: string;
  name: string;
};

const storedFiles: KbStoredFile[] = [];

export async function ensureVectorStore() {
  if (vectorStoreId) return vectorStoreId;
  const client = getClient();
  const vs = await client.vectorStores.create({ name: "user-kb" });
  vectorStoreId = vs.id;
  return vectorStoreId;
}

export async function addFilesToVectorStore(
  files: { buffer: Buffer; originalname: string; mimetype: string }[]
): Promise<KbStoredFile[]> {
  const vsId = await ensureVectorStore();
  const client = getClient();
  const added: KbStoredFile[] = [];

  for (const f of files) {
    const file = await toFile(f.buffer, f.originalname || "upload.bin", {
      type: f.mimetype || "application/octet-stream"
    });

    const uploaded = await client.files.create({
      file,
      purpose: "assistants"
    });

    const vsFile = await client.vectorStores.files.create(vsId, { file_id: uploaded.id });
    const row: KbStoredFile = {
      vectorStoreFileId: vsFile.id,
      openaiFileId: uploaded.id,
      name: f.originalname || uploaded.filename || "upload.bin"
    };
    storedFiles.push(row);
    added.push(row);
  }

  return added;
}

export function listVectorStoreFiles(): KbStoredFile[] {
  return [...storedFiles];
}

export async function removeVectorStoreFile(vectorStoreFileId: string): Promise<boolean> {
  const vsId = await ensureVectorStore();
  const client = getClient();
  const idx = storedFiles.findIndex((f) => f.vectorStoreFileId === vectorStoreFileId);
  if (idx < 0) return false;

  const file = storedFiles[idx];
  await client.vectorStores.files.del(vsId, file.vectorStoreFileId);
  await client.files.del(file.openaiFileId);
  storedFiles.splice(idx, 1);
  return true;
}
