/**
 * Piper TTS Local Server
 *
 * Runs on http://127.0.0.1:7477 by default
 * POST /tts  { "text": "..." }  → audio/wav
 * GET  /health                  → 200 OK
 *
 * Requires:
 *   piper/piper.exe on Windows, or piper/piper on macOS/Linux
 *   piper/voices/<model>.onnx
 *   piper/voices/<model>.onnx.json
 */

const express = require("express");
const cors    = require("cors");
const fs      = require("fs/promises");
const { createReadStream } = require("fs");
const path    = require("path");
const crypto  = require("crypto");
const { spawn } = require("child_process");
const { version } = require("./package.json");

// ─── Config ───────────────────────────────────────────────────────────────────
const { PORT, HOST } = require("./config"); // shared with the tray so they agree
const MAX_CHARS  = 8000;        // reasonable limit per request
const TIMEOUT_MS = 60_000;      // kill Piper if it hangs

// Paths can be overridden for non-standard installs or macOS/Linux setups.
const DEFAULT_PIPER_BIN = process.platform === "win32"
  ? path.join(__dirname, "piper", "piper.exe")
  : path.join(__dirname, "piper", "piper");
const PIPER_BIN  = process.env.PIPER_BIN || DEFAULT_PIPER_BIN;
const VOICE_DIR  = process.env.VOICE_DIR || path.join(__dirname, "piper", "voices");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, "output");

// Default voice model (change to match your downloaded .onnx file)
const DEFAULT_VOICE = "en_US-ryan-high.onnx";

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();

function isAllowedOrigin(origin) {
  // CLI tools and same-process scripts usually do not send Origin. Browser pages do.
  if (!origin) return true;
  return origin.startsWith("chrome-extension://");
}

function enforceAllowedOrigin(req, res, next) {
  if (isAllowedOrigin(req.get("Origin"))) {
    next();
    return;
  }
  res.status(403).json({ error: "Origin not allowed by Piper TTS local server." });
}

const corsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"]
};
app.use(enforceAllowedOrigin);
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // explicit preflight for DELETE etc.
app.use(express.json({ limit: "1mb" }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version });
});

// ─── Validation Helpers ───────────────────────────────────────────────────────
function validateText(text) {
  if (!text || typeof text !== "string") {
    return "Missing or invalid 'text' field.";
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "Text must not be empty.";
  }
  if (trimmed.length > MAX_CHARS) {
    return `Text is too long (${trimmed.length} chars). Maximum is ${MAX_CHARS}.`;
  }
  return null; // valid
}

function isSafeVoiceFilename(name) {
  return (
    typeof name === "string" &&
    name === path.basename(name) &&
    name.endsWith(".onnx") &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

async function validateVoiceFile(name) {
  if (!isSafeVoiceFilename(name)) {
    return "Voice must be a .onnx filename.";
  }

  try {
    await fs.access(path.join(VOICE_DIR, name));
  } catch (_) {
    return `Voice model not found: ${name}`;
  }

  try {
    await fs.access(path.join(VOICE_DIR, name + ".json"));
  } catch (_) {
    return `Voice config not found: ${name}.json`;
  }

  return null;
}

// ─── Piper Runner ─────────────────────────────────────────────────────────────
// C10 fix: uses a `settled` flag so the timeout handler and the `close` event
// can both run without a second reject() call on an already-settled Promise.
//
// S1 fix: Piper reads text from stdin — there is no --input-file flag.
// Passing an unrecognised flag caused Piper to silently wait for stdin forever,
// hitting our 60 s timeout on every request. Also corrected --output-file →
// --output_file (underscore) to match Piper's actual CLI.
function runPiper({ text, outputPath, voiceModel }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--model",       path.join(VOICE_DIR, voiceModel),
      "--output_file", outputPath          // underscore, not hyphen
    ];

    let proc;
    try {
      // windowsHide stops piper.exe from popping a console window on each request.
      proc = spawn(PIPER_BIN, args, { windowsHide: true });
    } catch (err) {
      return reject(new Error(`Failed to spawn Piper: ${err.message}`));
    }

    // Feed text via stdin and close the pipe so Piper knows input is complete
    proc.stdin.write(text, "utf8");
    proc.stdin.end();

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    // C10: guard flag prevents double-settle when both timeout and close fire
    let settled = false;
    const settle = (fn, ...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    // Timeout guard
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle(reject, new Error("Piper process timed out."));
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle(resolve);
      } else {
        settle(reject, new Error(`Piper exited with code ${code}. Stderr: ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      settle(reject, new Error(`Piper process error: ${err.message}`));
    });
  });
}

// ─── POST /tts ────────────────────────────────────────────────────────────────
app.post("/tts", async (req, res) => {
  const text  = req.body?.text;
  const voice = (req.body?.voice && req.body.voice.trim()) || DEFAULT_VOICE;

  // Validate text
  const validationError = validateText(text);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const safeVoice = voice.trim();
  const voiceError = await validateVoiceFile(safeVoice);
  if (voiceError) {
    return res.status(400).json({ error: voiceError });
  }

  const cleanText  = text.trim();
  const id         = crypto.randomUUID();
  const outputPath = path.join(OUTPUT_DIR, `${id}.wav`);

  const cleanup = () => Promise.allSettled([
    fs.rm(outputPath, { force: true })
  ]);

  try {
    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Run Piper — text is passed via stdin (S1 fix)
    await runPiper({ text: cleanText, outputPath, voiceModel: safeVoice });

    // Stream the WAV back
    // S2 fix: replaced sendFile (broken on Windows with root:"/") with a plain
    // createReadStream pipe — works on all platforms without path quirks.
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");

    const stream = createReadStream(outputPath);

    stream.on("error", async (err) => {
      console.error("[/tts] stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream audio file." });
      }
      await cleanup();
    });

    stream.on("close", async () => {
      await cleanup();
    });

    stream.pipe(res);

  } catch (err) {
    await cleanup();

    console.error("[/tts] Error:", err.message);

    if (res.headersSent) return;

    // Give useful errors for common setup problems
    if (err.message.includes("spawn") || err.message.includes("ENOENT")) {
      return res.status(500).json({
        error: "Piper executable not found.",
        details: `Expected at: ${PIPER_BIN}`,
        hint: "Download Piper from https://github.com/rhasspy/piper/releases and place the executable in the piper/ folder, or set PIPER_BIN."
      });
    }

    res.status(500).json({
      error: "TTS generation failed.",
      details: err.message
    });
  }
});

// ─── GET /voices  (list available voice models + sizes) ──────────────────────
app.get("/voices", async (_req, res) => {
  try {
    const files = await fs.readdir(VOICE_DIR);
    const voices = files.filter(f => f.endsWith(".onnx"));

    // Stat each .onnx file for real on-disk size
    const sizes = {};
    await Promise.all(voices.map(async (f) => {
      try {
        const stat = await fs.stat(path.join(VOICE_DIR, f));
        sizes[f] = stat.size;
      } catch { sizes[f] = 0; }
    }));

    res.json({ voices, sizes, voiceDir: VOICE_DIR });
  } catch (_) {
    res.json({ voices: [], sizes: {}, voiceDir: VOICE_DIR });
  }
});

// ─── POST /voices/open-folder  (reveal voices directory in file manager) ──────
app.post("/voices/open-folder", (_req, res) => {
  const command =
    process.platform === "win32"  ? "explorer.exe" :
    process.platform === "darwin" ? "open" :
                                    "xdg-open";
  const child = spawn(command, [VOICE_DIR], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", (err) => {
    console.warn("[/voices/open-folder] Failed to open folder:", err.message);
  });
  child.unref();
  res.json({ ok: true });
});

// ─── DELETE /voices/:name  (remove an installed voice) ───────────────────────
app.delete("/voices/:name", async (req, res) => {
  const name = req.params.name;
  if (!isSafeVoiceFilename(name)) {
    return res.status(400).json({ error: "Voice name must end in .onnx" });
  }
  const onnxPath = path.join(VOICE_DIR, name);
  const jsonPath  = onnxPath + ".json";
  try {
    // allSettled ensures both files are always attempted regardless of whether
    // one fails, avoiding a partial delete. force:true suppresses ENOENT so a
    // missing sidecar is never an error. We then surface any real errors (e.g.
    // EPERM) explicitly rather than swallowing them as the old code did.
    const results = await Promise.allSettled([
      fs.rm(onnxPath, { force: true }),
      fs.rm(jsonPath, { force: true })
    ]);
    const errors = results
      .filter(r => r.status === "rejected")
      .map(r => r.reason?.message || String(r.reason));
    if (errors.length > 0) {
      return res.status(500).json({ error: "Delete failed: " + errors.join("; ") });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Startup: clean stale WAV files from a previous crashed session ───────────
async function cleanOutputDir() {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const files = await fs.readdir(OUTPUT_DIR);
    const wavs  = files.filter(f => f.endsWith(".wav"));
    await Promise.allSettled(
      wavs.map(f => fs.rm(path.join(OUTPUT_DIR, f), { force: true }))
    );
    if (wavs.length > 0) {
      console.log(`[startup] Cleaned ${wavs.length} stale WAV file(s).`);
    }
  } catch (_) {}
}

// ─── Start Server ─────────────────────────────────────────────────────────────
(async () => {
  await cleanOutputDir();
  app.listen(PORT, HOST, () => {
    console.log(`\n🔊 Piper TTS Local Server v${version}`);
    console.log(`   Running at http://${HOST}:${PORT}`);
    console.log(`   Health:  GET  http://${HOST}:${PORT}/health`);
    console.log(`   TTS:     POST http://${HOST}:${PORT}/tts`);
    console.log(`   Voices:  GET  http://${HOST}:${PORT}/voices`);
    console.log(`\n   Piper bin: ${PIPER_BIN}`);
    console.log(`   Voice dir: ${VOICE_DIR}`);
    console.log(`   Default voice: ${DEFAULT_VOICE}`);
    console.log(`\n   Press Ctrl+C to stop.\n`);
  });
})();
