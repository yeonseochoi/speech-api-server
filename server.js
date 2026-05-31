const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const textToSpeech = require("@google-cloud/text-to-speech");
require("dotenv").config();

const app = express();

app.set("trust proxy", true);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const audioDir = path.join(__dirname, "public", "audio");
const DEFAULT_VOICE = "ko-KR-Chirp3-HD-Charon";
const DEFAULT_SPEAKING_RATE = 0.85;
const configuredMaxScriptLength = Number(process.env.MAX_SCRIPT_LENGTH || 2000);
const MAX_SCRIPT_LENGTH = Number.isFinite(configuredMaxScriptLength) && configuredMaxScriptLength > 0
  ? configuredMaxScriptLength
  : 2000;
const MIN_SPEAKING_RATE = 0.25;
const MAX_SPEAKING_RATE = 4;

function ensureAudioDir() {
  if (fs.existsSync(audioDir) && !fs.statSync(audioDir).isDirectory()) {
    throw new Error(`${audioDir} exists but is not a directory. Rename or delete that file, then restart the server.`);
  }

  fs.mkdirSync(audioDir, { recursive: true });
}

ensureAudioDir();

app.use("/audio", express.static(audioDir));

let client;

if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  client = new textToSpeech.TextToSpeechClient({
    credentials,
    projectId: credentials.project_id,
  });
} else {
  client = new textToSpeech.TextToSpeechClient();
}

app.get("/", (req, res) => {
  res.send("TTS server is running");
});

app.get("/health", (req, res) => {
  res.json({ success: true, status: "ok" });
});

function getBaseUrl(req) {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;

  return baseUrl.replace(/^http:\/\/(.+\.onrender\.com)$/i, "https://$1");
}

function getApiKey(req) {
  const authHeader = req.get("authorization") || "";

  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  return req.get("x-api-key");
}

function requireApiKey(req, res, next) {
  if (!process.env.API_KEY) {
    return next();
  }

  if (getApiKey(req) !== process.env.API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  return next();
}

function sanitizeFilePart(value, fallback) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  return cleaned || fallback;
}

function parseSpeakingRate(value) {
  const rate = Number(value);

  if (!Number.isFinite(rate) || rate < MIN_SPEAKING_RATE || rate > MAX_SPEAKING_RATE) {
    return null;
  }

  return rate;
}

function getErrorDetail(error) {
  if (process.env.NODE_ENV === "production") {
    return undefined;
  }

  return error.message;
}

app.post("/generate-audio", requireApiKey, async (req, res) => {
  try {
    const {
      place = "tour",
      persona = "default",
      voice = DEFAULT_VOICE,
      speakingRate = DEFAULT_SPEAKING_RATE
    } = req.body;
    const rawScript = req.body.tts_script || req.body.script;
    const ttsScript = typeof rawScript === "string" ? rawScript.trim() : "";

    if (!ttsScript) {
      return res.status(400).json({
        success: false,
        error: "tts_script is required"
      });
    }

    if (ttsScript.length > MAX_SCRIPT_LENGTH) {
      return res.status(400).json({
        success: false,
        error: `tts_script must be under ${MAX_SCRIPT_LENGTH} characters`
      });
    }

    if (typeof voice !== "string" || !voice.startsWith("ko-KR-")) {
      return res.status(400).json({
        success: false,
        error: "voice must be a Korean Google TTS voice name"
      });
    }

    const parsedSpeakingRate = parseSpeakingRate(speakingRate);

    if (parsedSpeakingRate === null) {
      return res.status(400).json({
        success: false,
        error: `speakingRate must be a number between ${MIN_SPEAKING_RATE} and ${MAX_SPEAKING_RATE}`
      });
    }

    const hash = crypto
      .createHash("sha256")
      .update(`${ttsScript}:${voice}:${parsedSpeakingRate}`)
      .digest("hex");

    const safePlace = sanitizeFilePart(place, "tour");
    const safePersona = sanitizeFilePart(persona, "default");
    const fileName = `${safePlace}_${safePersona}_${hash.slice(0, 24)}.mp3`;
    const filePath = path.join(audioDir, fileName);
    const audioUrl = `${getBaseUrl(req)}/audio/${encodeURIComponent(fileName)}`;

    if (fs.existsSync(filePath)) {
      return res.json({
        success: true,
        cached: true,
        audio_url: audioUrl,
        file_name: fileName,
        provider: "google-cloud-text-to-speech",
        voice,
        speakingRate: parsedSpeakingRate,
        pitch_applied: false
      });
    }

    const audioConfig = {
      audioEncoding: "MP3",
      speakingRate: parsedSpeakingRate
    };

    console.log("TTS request audioConfig:", audioConfig);

    const request = {
      input: {
        text: ttsScript
      },
      voice: {
        languageCode: "ko-KR",
        name: voice
      },
      audioConfig
    };

    const [response] = await client.synthesizeSpeech(request);

    ensureAudioDir();
    await fsp.writeFile(filePath, response.audioContent);

    return res.json({
      success: true,
      cached: false,
      audio_url: audioUrl,
      file_name: fileName,
      provider: "google-cloud-text-to-speech",
      voice,
      speakingRate: parsedSpeakingRate,
      pitch_applied: false
    });
  } catch (error) {
    console.error("TTS generation error:", error);

    const body = {
      success: false,
      error: "Audio generation failed"
    };
    const detail = getErrorDetail(error);

    if (detail) {
      body.detail = detail;
    }

    return res.status(500).json(body);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TTS server running on port ${PORT}`);
});
