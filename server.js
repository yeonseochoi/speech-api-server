const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const textToSpeech = require("@google-cloud/text-to-speech");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const audioDir = path.join(__dirname, "public", "audio");

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

function getBaseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
}

app.post("/generate-audio", async (req, res) => {
  try {
    const {
      place = "tour",
      persona = "default",
      tts_script,
      voice = "ko-KR-Chirp3-HD-Charon",
      speakingRate = 0.85
    } = req.body;

    if (!tts_script || typeof tts_script !== "string") {
      return res.status(400).json({
        success: false,
        error: "tts_script is required"
      });
    }

    if (tts_script.length > 2000) {
      return res.status(400).json({
        success: false,
        error: "tts_script must be under 2000 characters"
      });
    }

    const hash = crypto
      .createHash("md5")
      .update(tts_script + voice + speakingRate)
      .digest("hex");

    const safePlace = String(place).replace(/[^a-zA-Z0-9가-힣]/g, "_");
    const safePersona = String(persona).replace(/[^a-zA-Z0-9가-힣]/g, "_");

    const fileName = `${safePlace}_${safePersona}_${hash}.mp3`;
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
        speakingRate,
        pitch_applied: false
      });
    }

    const audioConfig = {
      audioEncoding: "MP3",
      speakingRate: Number(speakingRate)
    };

    console.log("TTS request audioConfig:", audioConfig);

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

    ensureAudioDir();
    fs.writeFileSync(filePath, response.audioContent, "binary");

    return res.json({
      success: true,
      cached: false,
      audio_url: audioUrl,
      file_name: fileName,
      provider: "google-cloud-text-to-speech",
      voice,
      speakingRate,
      pitch_applied: false
    });
  } catch (error) {
    console.error("TTS generation error:", error);

    return res.status(500).json({
      success: false,
      error: "Audio generation failed",
      detail: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`TTS server running on port ${PORT}`);
});
