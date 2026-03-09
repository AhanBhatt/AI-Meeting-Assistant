# Troubleshooting

## Nothing shows in window picker
- preload bridge not loaded → window.bridge undefined
- ensure preload JS exists/loads and contextBridge is enabled

## MediaRecorder NotSupportedError
- Often due to unsupported mimeType or missing audio track
- Prefer screen sources
- Choose mimeType via MediaRecorder.isTypeSupported

## Invalid data URL (server)
- audioDataUrl missing/malformed (recorder never produced valid chunks)
- client should block /ask if blob is too small
- server should validate data URL pattern before decode

## Failed to fetch
- server crashed / not running
- confirm console prints: Server on http://localhost:8787