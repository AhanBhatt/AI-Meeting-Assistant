# Troubleshooting

## Startup issues

### `Failed to fetch`
- Confirm backend is running: `Server on http://127.0.0.1:8787`
- Confirm renderer is running on `http://localhost:5173` (dev mode)
- Restart with `npm run dev`

### Vite port already in use (`5173`)
- The `predev` script attempts to kill stale Node listeners and briefly waits for ports to free.
- If still blocked, close old terminal/dev sessions and rerun `npm run dev`.

### Electron closes and all dev processes stop
- This is expected with `concurrently -k`: if Electron exits, Vite/server are terminated too.
- Relaunch with `npm run dev`.

## Capture/transcription issues

### `MediaRecorder failed to start`
- Screen sources are generally more reliable than per-window sources on Windows.
- Ensure the selected source has capturable system audio.

### No transcript produced
- Verify source has an audio track.
- Retry with full-screen source.
- Fallback WAV transcription runs when realtime transcript is unavailable.

### `Invalid file format` / `Audio file might be corrupted`
- Indicates malformed/empty fallback audio payload.
- Ensure capture ran long enough and audio was present.

## Streaming answer issues

### `Error: Request was aborted`
- Usually indicates stream interruption (window reload/close or network interruption).
- Keep the app open while answer is streaming.
- Retry once after restart.

### Stream stops mid-response
- Check backend logs for OpenAI/API errors.
- Verify API key is valid and has required scopes.

## Usage card/billing issues

### Usage unavailable with 403 errors
- Some billing endpoints require org-level permissions/scopes (for example `api.usage.read`).
- App falls back to local budget mode when live usage is unavailable.
