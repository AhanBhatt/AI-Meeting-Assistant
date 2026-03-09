# Local Server API

Base: http://localhost:8787

## POST /kb/init
Ensures vector store exists.
Response: { vectorStoreId: string }

## POST /kb/upload  (multipart/form-data)
Field: files (multi)
Response: { ok: true, count: number }

## POST /ask (application/json)
Body:
{
  typedQuestion?: string,
  audioDataUrl: string,
  screenshotBase64Png: string
}

Response:
{
  transcript: string,
  answerText: string
}

Errors:
{ error: string }