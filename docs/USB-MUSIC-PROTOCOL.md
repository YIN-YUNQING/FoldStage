# FoldStage USB Music & Model Protocol

FoldStage uses a lightweight HTTP + Server-Sent Events (SSE) protocol over USB via Android Debug Bridge (`adb reverse tcp:8772 tcp:8772`). Because the phone connects to `http://127.0.0.1:8772`, any desktop companion or third-party script on macOS, Windows, or Linux can feed music beats or serve models to FoldStage without Wi-Fi or cloud servers.

## 1. Transport

Run on the host computer while the Android device is connected via USB:

```bash
adb reverse tcp:8772 tcp:8772
```

(FoldStage Companion runs this automatically whenever an authorized Android device is detected.)

## 2. Endpoints (`http://127.0.0.1:8772`)

### `GET /v1/events` (SSE)
Long-lived event stream consumed by the FoldStage Android client.

Event types:
- `hello`:
  ```json
  {"type":"hello","server":"foldstage-companion","version":"1.0.0","modelsCount":3}
  ```
- `models_changed`: Notifies the phone to pull updated models from `GET /v1/models`.
  ```json
  {"type":"models_changed","count":3,"at":1732425600000}
  ```
- `music`: Real-time music beat & metadata packet (recommended ~4 Hz while playing).
  ```json
  {
    "type": "music",
    "playing": true,
    "title": "Song Title",
    "artist": "Artist Name",
    "album": "Album Name",
    "duration": 235.4,
    "elapsed": 42.1,
    "bpm": 128.0,
    "periodMs": 468.75,
    "beatRef": 1732425600120,
    "downbeatRef": 1732425598245,
    "conf": 0.92,
    "energy": 0.68,
    "outLatencyMs": 22.0,
    "art": "<optional base64 JPEG sent on track change>"
  }
  ```

### `POST /v1/music`
Open ingestion endpoint. Any external tool, plugin, or script can `POST` the same `music` JSON object above to `http://127.0.0.1:8772/v1/music` to drive the connected phone immediately.

Example:
```bash
curl -X POST http://127.0.0.1:8772/v1/music \
  -H "Content-Type: application/json" \
  -d '{"playing":true,"title":"My Track","artist":"DJ","duration":180,"elapsed":10,"bpm":128,"periodMs":468.75,"beatRef":1732425600000,"downbeatRef":1732425600000,"conf":0.95,"energy":0.75}'
```

### `GET /v1/models` & `GET /v1/models/:id/*`
Returns the list of imported Live2D models and serves individual model files so the Android app can mirror them into private local storage (`filesDir/models/`) for offline playback.

### `POST /v1/device-status`
Used by the Android client to report model sync progress back to the desktop Studio GUI.
