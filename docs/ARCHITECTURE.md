# Architecture

## Dev processes
- Vite (5173): React renderer UI
- Express (8787): transcription + vector store + OpenAI calls
- Electron main: desktopCapturer + IPC + BrowserWindow

## Window/screen selection & screenshot
- Renderer calls window.bridge.listSources() to display available sources.
- Renderer calls window.bridge.screenshotSource(id) to fetch PNG bytes for the selected source.
- Electron main uses desktopCapturer.getSources() and returns thumbnails.

## Audio capture model (ring buffer + segment)
- A MediaRecorder runs continuously against the selected desktop stream.
- A ring buffer stores the last ~2s of chunks (pre-roll).
- On Capture start: segment = ring buffer contents.
- While capturing: append chunks to segment.
- On stop: build audioBlob from segment → convert to dataURL → send to server.

## Request to server
POST /ask with:
- typedQuestion (optional)
- audioDataUrl (data:audio/...;base64,...)
- screenshotBase64Png (raw base64)

Server:
- transcribeAudioDataUrl(audioDataUrl)
- ensureVectorStore()
- Responses API call with file_search tool attached to vector store
- returns transcript + answerText