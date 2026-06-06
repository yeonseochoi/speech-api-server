const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const textToSpeech = require("@google-cloud/text-to-speech");
require("dotenv").config();

const app = express();

app.set("trust proxy", true);

app.use(cors());

function logEvent(level, event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...details
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  req.requestId = crypto.randomUUID();

  logEvent("info", "request:start", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    contentType: req.get("content-type"),
    contentLength: req.get("content-length")
  });

  res.on("finish", () => {
    logEvent("info", "request:finish", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  next();
});

app.use(express.json({ limit: "2mb" }));

app.use((error, req, res, next) => {
  if (error && error.type === "entity.parse.failed") {
    logEvent("error", "request:json_parse_failed", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      message: error.message
    });

    return res.status(400).json({
      success: false,
      error: "Invalid JSON body",
      request_id: req.requestId
    });
  }

  return next(error);
});

const audioDir = path.join(__dirname, "public", "audio");

function ensureAudioDir() {
  if (fs.existsSync(audioDir) && !fs.statSync(audioDir).isDirectory()) {
    throw new Error(`${audioDir} exists but is not a directory. Rename or delete that file, then restart the server.`);
  }

  fs.mkdirSync(audioDir, { recursive: true });
}

function toSafeFilePart(value) {
  return String(value).replace(/[^\p{L}\p{N}-]/gu, "_");
}

ensureAudioDir();

app.use("/audio", express.static(audioDir));

let client;

if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  client = new textToSpeech.TextToSpeechClient({
    credentials,
    projectId: credentials.project_id
  });
} else {
  client = new textToSpeech.TextToSpeechClient();
}

app.get("/", (req, res) => {
  res.send("TTS server is running");
});

function getBaseUrl(req) {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;

  return baseUrl.replace(/^http:\/\/(.+\.onrender\.com)$/i, "https://$1");
}

app.post("/generate-audio", async (req, res) => {
  try {
    let { place, persona, tts_script, voice, speakingRate, pitch } = req.body;

    if (req.body.value) {
      try {
        const parsed = JSON.parse(req.body.value);
        place        = parsed.place        || place;
        persona      = parsed.persona      || persona;
        tts_script   = parsed.tts_script   || req.body.value;
        voice        = parsed.voice        || voice;
        speakingRate = parsed.speakingRate || speakingRate;
        pitch        = parsed.pitch        !== undefined ? parsed.pitch : pitch;
      } catch (e) {
        tts_script = req.body.value;
      }
    }

    place        = place        || "tour";
    persona      = persona      || "default";
    voice        = voice        || "ko-KR-Chirp3-HD-Charon";
    speakingRate = speakingRate || 0.85;
    pitch        = pitch        !== undefined ? Number(pitch) : 0;

    logEvent("info", "tts:received", {
      requestId: req.requestId,
      place,
      persona,
      voice,
      speakingRate,
      pitch,
      bodyKeys: Object.keys(req.body),
      usedValueFallback: !req.body.tts_script && Boolean(req.body.value),
      scriptLength: typeof tts_script === "string" ? tts_script.length : null,
      hasScript: Boolean(tts_script)
    });

    if (!tts_script || typeof tts_script !== "string") {
      logEvent("warn", "tts:validation_failed", {
        requestId: req.requestId,
        reason: "missing_or_invalid_tts_script"
      });

      return res.status(400).json({
        success: false,
        error: "tts_script is required",
        request_id: req.requestId
      });
    }

    if (tts_script.length > 2000) {
      logEvent("warn", "tts:validation_failed", {
        requestId: req.requestId,
        reason: "tts_script_too_long",
        scriptLength: tts_script.length
      });

      return res.status(400).json({
        success: false,
        error: "tts_script must be under 2000 characters",
        request_id: req.requestId
      });
    }

    const hash = crypto
      .createHash("md5")
      .update(tts_script + voice + speakingRate + pitch)
      .digest("hex");

    const safePlace = toSafeFilePart(place);
    const safePersona = toSafeFilePart(persona);

    const fileName = `${safePlace}_${safePersona}_${hash}.mp3`;
    const filePath = path.join(audioDir, fileName);
    const audioUrl = `${getBaseUrl(req)}/audio/${encodeURIComponent(fileName)}`;

    if (fs.existsSync(filePath)) {
      logEvent("info", "tts:cache_hit", {
        requestId: req.requestId,
        fileName,
        audioUrl
      });

      return res.json({
        success: true,
        cached: true,
        audio_url: audioUrl,
        file_name: fileName,
        provider: "google-cloud-text-to-speech",
        voice,
        speakingRate,
        pitch_applied: !voice.includes("Chirp3") && pitch !== 0,
        pitch: voice.includes("Chirp3") ? null : pitch,
        request_id: req.requestId
      });
    }

    const audioConfig = {
      audioEncoding: "MP3",
      speakingRate: Number(speakingRate)
    };
    
    if (!voice.includes("Chirp3")) {
      audioConfig.pitch = Number(pitch);
    }

    logEvent("info", "tts:synthesize_start", {
      requestId: req.requestId,
      fileName,
      voice,
      audioConfig
    });

    const request = {
      input: {
        text: tts_script
      },
      voice: {
        languageCode: "ko-KR",
        name: voice
      },
      audioConfig
    };

    const [response] = await client.synthesizeSpeech(request);

    logEvent("info", "tts:synthesize_success", {
      requestId: req.requestId,
      audioContentBytes: response.audioContent ? response.audioContent.length : 0
    });

    ensureAudioDir();
    fs.writeFileSync(filePath, response.audioContent, "binary");

    logEvent("info", "tts:file_written", {
      requestId: req.requestId,
      fileName,
      audioUrl
    });

    return res.json({
      success: true,
      cached: false,
      audio_url: audioUrl,
      file_name: fileName,
      provider: "google-cloud-text-to-speech",
      voice,
      speakingRate,
      pitch_applied: !voice.includes("Chirp3") && pitch !== 0,
      pitch: voice.includes("Chirp3") ? null : pitch,
      request_id: req.requestId
    });
  } catch (error) {
    logEvent("error", "tts:generation_error", {
      requestId: req.requestId,
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: "Audio generation failed",
      detail: error.message,
      request_id: req.requestId
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logEvent("info", "server:started", {
    port: PORT,
    nodeEnv: process.env.NODE_ENV || "development"
  });
});
