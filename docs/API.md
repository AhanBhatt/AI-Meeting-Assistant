# Local Server API

Base: `http://localhost:8787`

## POST /kb/init
Ensures vector store exists.

Response:
```json
{ "vectorStoreId": "string" }
```

## POST /kb/upload (multipart/form-data)
Field: `files` (multi)

Response:
```json
{ "ok": true, "count": 2, "files": [] }
```

## GET /kb/files
Lists uploaded persistent files.

## DELETE /kb/file/:vectorStoreFileId
Removes a persistent file from local mapping/vector store.

## POST /rt/start
Starts realtime transcription session.

## POST /rt/append
Appends PCM chunks to realtime session.

## POST /rt/stop
Finalizes realtime transcript.

## POST /rt/cancel
Cancels realtime session.

## POST /ask (JSON mode)
Request body:
```json
{
  "typedQuestion": "optional",
  "transcript": "optional",
  "audioDataUrl": "optional",
  "screenshotBase64Png": "optional",
  "useFiles": true
}
```

Response:
```json
{
  "transcript": "string",
  "answerText": "string"
}
```

## POST /ask?stream=1 (SSE mode)
Headers:
- `Accept: text/event-stream`
- `Content-Type: application/json`

Request body is the same as JSON mode.

SSE events:
- `event: transcript` with `{ "transcript": "..." }`
- `event: delta` with `{ "delta": "..." }`
- `event: done` with `{ "transcript": "...", "answerText": "..." }`
- `event: error` with `{ "error": "..." }`

## Error shape
```json
{ "error": "message" }
```
