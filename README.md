# speech-api-server

Express API server that converts a script into Korean TTS audio with Google Cloud Text-to-Speech and returns a public MP3 URL.

## Endpoints

### `GET /health`

Returns a simple health check response.

```json
{
  "success": true,
  "status": "ok"
}
```

### `POST /generate-audio`

Creates or reuses an MP3 file for the provided script.

Request body:

```json
{
  "tts_script": "안녕하세요. 이 문장을 음성으로 변환합니다.",
  "place": "tour",
  "persona": "default",
  "voice": "ko-KR-Chirp3-HD-Charon",
  "speakingRate": 0.85
}
```

`script` is also accepted as an alias for `tts_script`.

Success response:

```json
{
  "success": true,
  "cached": false,
  "audio_url": "https://example.com/audio/tour_default_abc123.mp3",
  "file_name": "tour_default_abc123.mp3",
  "provider": "google-cloud-text-to-speech",
  "voice": "ko-KR-Chirp3-HD-Charon",
  "speakingRate": 0.85,
  "pitch_applied": false
}
```

## Environment Variables

- `PORT`: HTTP server port. Defaults to `3000`.
- `BASE_URL`: Public base URL used to build returned audio links.
- `GOOGLE_SERVICE_ACCOUNT_JSON`: Google service account JSON string. If omitted, the Google SDK default credentials are used.
- `API_KEY`: Optional API key. When set, requests to `POST /generate-audio` must include `x-api-key: <key>` or `Authorization: Bearer <key>`.
- `MAX_SCRIPT_LENGTH`: Optional script length limit. Defaults to `2000`.

## Run

```bash
npm install
npm start
```
