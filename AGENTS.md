# AI Meeting Assistance - Agent Guide (Windows)

This repo is an Electron desktop app + local Express server.

Goal:
- User selects a window/screen to mirror.
- User presses Capture once = start segment (include 2s pre-roll).
- User presses again = stop, transcribe captured audio, attach screenshot of selected source, and generate a detailed answer.
- Transcript should show in chat UI as the “user message” when no typed question is provided.
- User can optionally type a question; if typed, it overrides transcript-as-question.

## Quick commands
- Install: npm install
- Dev: npm run dev
  - Vite: http://localhost:5173
  - Server: http://localhost:8787
  - Electron launches automatically
- Build: npm run build

## Repo layout
- electron/
  - main.ts: BrowserWindow + IPC handlers (LIST_SOURCES, SCREENSHOT_SOURCE)
  - preload.ts: exposes window.bridge (listSources, screenshotSource)
  - dev-runner.cjs: dev entry for Electron main
- src/
  - App.tsx: selection + capture + ring buffer + /ask calls
  - components/: RightPane (picker+mirror), ChatPane, etc.
- server/
  - index.ts: Express endpoints /kb/init /kb/upload /ask
  - openai.ts: OpenAI client + model
  - kb.ts: vector store create + file uploads
  - transcribe.ts: audio dataURL → buffer → transcription

## Environment
- OPENAI_API_KEY required
- OPENAI_MODEL optional
- PORT optional (default 8787)

## Important implementation notes
- Windows audio capture is fragile for “window capture”; screen sources are more reliable.
- Do not hardcode MediaRecorder mimeType; pick supported mime types with MediaRecorder.isTypeSupported.
- Always guard: missing audio track, MediaRecorder start errors, tiny blobs, empty transcript.
- Screenshot is sent as raw base64 PNG bytes (no "data:image/png;base64," prefix unless explicitly added).

## Definition of done
- Capture works with no typed input: transcript appears as user message; assistant returns detailed answer.
- Typed input still works: typed text becomes user message; transcript is context.
- Errors are surfaced in UI (not silent).
- npm run dev works end-to-end on Windows.
