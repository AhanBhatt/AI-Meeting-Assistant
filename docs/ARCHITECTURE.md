# Architecture

## Runtime components
- Electron main process: window lifecycle, desktop source capture, screenshot IPC, global shortcut, sticky-note popups
- React renderer: chat UI, capture controls, file upload UX, streaming answer rendering
- Express backend: realtime transcription endpoints, knowledge-base endpoints, OpenAI request orchestration

## Dev processes
- Vite (`5173`): renderer hot-reload dev server
- Express (`8787`): local API server
- Electron: desktop shell loading renderer + preload bridge

## Capture and transcript flow
1. User selects a source (screen/window) from Electron desktop sources.
2. Renderer keeps a rolling 2s pre-roll audio ring buffer.
3. Capture start:
- starts realtime transcription session (`/rt/start`)
- pushes buffered + live PCM chunks (`/rt/append`)
4. Capture stop:
- finalizes realtime transcript (`/rt/stop`)
- if transcript missing, builds WAV fallback and sends `audioDataUrl`

## Ask/answer flow
Renderer sends `POST /ask` with optional:
- `typedQuestion`
- `transcript`
- `audioDataUrl` (fallback)
- `screenshotBase64Png`
- `useFiles`

Server:
- ensures a transcript exists (provided transcript preferred; fallback transcription if needed)
- applies file-search logic (always-use toggle / heuristics)
- builds Responses API input with source priority:
  1. transcript primary
  2. uploaded files contextual
  3. screenshot secondary

## Streaming answer path
- Renderer requests `POST /ask?stream=1` with `Accept: text/event-stream`
- Server streams SSE events:
  - `transcript`
  - `delta` (incremental answer text)
  - `done` (final transcript + answer)
  - `error`
- UI appends deltas live into the assistant bubble

## Non-stream fallback path
- `POST /ask` without stream parameters returns JSON:
  - `transcript`
  - `answerText`
