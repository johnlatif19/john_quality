/* ═══════════════════════════════════════════════════════════════
   JOHN_QUALITY — Backend server
   Railway + multer (disk) + Cloudinary + Firebase + FFmpeg (low-mem)
   ═══════════════════════════════════════════════════════════════ */

"use strict";

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const jwt = require("jsonwebtoken");
const { v2: cloudinary } = require("cloudinary");
const admin = require("firebase-admin");
const multer = require("multer");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const os = require("os");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

/* ── Config ─────────────────────────────────────────────────── */
const TOKEN_TTL_MS   = 5 * 60 * 1000;
const JOB_TTL_MS     = 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS  = 60 * 60 * 1000;
const SECRET         = process.env.JQ_SECRET || "john_quality_default_secret_change_me";
const ADMIN_SECRET   = process.env.ADMIN_SECRET || "admin_change_me";
const CF_FOLDER      = process.env.CLOUDINARY_FOLDER || "john_quality";
const ENCODER_TAG    = "JOHN_QUALITY - https://www.johnquality.xyz/ - v2.0";
const MAX_UPLOAD_MB  = 2000; // 2 GB

/* ── Firebase Admin init ────────────────────────────────────── */
let firebaseReady = false;
let db = null;
try {
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
    db = admin.firestore();
    firebaseReady = true;
    console.log("✓ Firebase Admin initialized");
  } else {
    console.warn("⚠  Firebase credentials missing — auth disabled");
  }
} catch (e) {
  console.error("✗ Firebase init failed:", e.message);
}

/* ── Cloudinary ─────────────────────────────────────────────── */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});
function cloudinaryReady() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

/* ── Multer (DISK storage — low memory) ─────────────────────── */
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) =>
    cb(null, "jq_upload_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex") + ".mp4"),
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

/* ── In-memory stores ───────────────────────────────────────── */
const jobs = new Map();
const jobLog = [];

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.expiresAt < now) jobs.delete(id);
}, 60_000);

/* ── Middleware ─────────────────────────────────────────────── */
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Patch-Token, X-Session, X-Filename, " +
    "X-Job-Id, X-Upload-Offset, X-Upload-Size, X-Upload-Part-Size, X-Upload-New, " +
    "X-Convert-H264, X-Engine, X-User-Key");
  res.setHeader("Access-Control-Expose-Headers", "X-Job-Id, Content-Range, X-Cloudinary-Url");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (!req.path.startsWith("/api/health")) {
      const ms = Date.now() - t0;
      console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

/* ── Token helpers ──────────────────────────────────────────── */
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expect = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
function requireToken(req, res, next) {
  const token = req.headers["x-patch-token"] || req.query.t || "";
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: "Token expired or invalid." });
  req.jqToken = payload;
  next();
}
function requireSession(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    const payload = jwt.verify(token, SECRET);
    if (!payload || !payload.uid) return res.status(401).json({ ok: false, error: "Not signed in." });
    req.session = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Session expired. Please sign in again." });
  }
}
function newId(len = 24) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

/* ── Health ─────────────────────────────────────────────────── */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    version: "2.0.0",
    engine: "JOHN_QUALITY v2.0",
    firebase: firebaseReady,
    cloudinary: cloudinaryReady(),
    maxUploadMB: MAX_UPLOAD_MB,
  });
});

/* ── FFmpeg check ───────────────────────────────────────────── */
app.get("/api/ffmpeg-check", async (req, res) => {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-version"]);
    res.json({ ok: true, version: stdout.split("\n")[0] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   AUTH — Google Sign-In via Firebase
   ═══════════════════════════════════════════════════════════════ */
app.post("/api/auth/google", express.json(), async (req, res) => {
  if (!firebaseReady) {
    return res.status(503).json({ ok: false, error: "Firebase not configured." });
  }
  const idToken = String((req.body && req.body.idToken) || "");
  if (!idToken) return res.status(400).json({ ok: false, error: "Missing idToken." });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email || "";
    const name = decoded.name || email.split("@")[0] || "User";
    const picture = decoded.picture || null;

    if (!email) return res.status(400).json({ ok: false, error: "No email in token." });

    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    const now = Date.now();

    if (!snap.exists) {
      await userRef.set({
        uid, email, name, picture,
        createdAt: now,
        lastLoginAt: now,
        patchesUsed: 0,
        tier: "premium",
      });
    } else {
      await userRef.update({ lastLoginAt: now, name, picture });
    }

    const sessionToken = jwt.sign(
      { uid, email, name, picture },
      SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      ok: true,
      sessionToken,
      user: { uid, email, name, picture, tier: "premium" },
    });
  } catch (e) {
    console.error("Google sign-in failed:", e);
    res.status(401).json({ ok: false, error: "Invalid Google token: " + e.message });
  }
});

app.get("/api/me", requireSession, async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.session.uid).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "User not found." });
    const u = snap.data();
    res.json({
      logged_in: true,
      uid: u.uid,
      email: u.email,
      username: u.name,
      name: u.name,
      picture: u.picture,
      tier: u.tier || "premium",
      patches_used: u.patchesUsed || 0,
      patches_limit: null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════════
   STATS
   ═══════════════════════════════════════════════════════════════ */
app.get("/api/stats", async (req, res) => {
  try {
    let totalUsers = 0;
    if (firebaseReady) {
      const usersSnap = await db.collection("users").count().get();
      totalUsers = usersSnap.data().count || 0;
    }
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const patchesToday = jobLog.filter((j) => j.ts > oneDayAgo && j.result === "ok").length;
    res.json({
      totalPatches: jobLog.filter((j) => j.result === "ok").length,
      totalUsers,
      patchesToday,
      usersUsed: totalUsers,
      active7d: totalUsers,
      daily: buildDailySeries(7),
      engine: {
        status: "ONLINE",
        uptime: humanUptime(),
        lastPatchAt: (jobLog.find((j) => j.result === "ok") || {}).ts || 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildDailySeries(days) {
  const out = [];
  const day = 24 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i--) {
    const from = Date.now() - (i + 1) * day;
    const to = Date.now() - i * day;
    const count = jobLog.filter((j) => j.ts > from && j.ts <= to && j.result === "ok").length;
    out.push({ label: new Date(to).toISOString().slice(5, 10), count });
  }
  return out;
}
function humanUptime() {
  const s = Math.floor(process.uptime());
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ═══════════════════════════════════════════════════════════════
   PATCHER
   ═══════════════════════════════════════════════════════════════ */

app.post("/api/authorize", requireSession, (req, res) => {
  const token = signToken({
    tier: "premium",
    userId: req.session.uid,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    nonce: newId(12),
  });
  res.json({ ok: true, token, tier: "premium", patches_used: 0, patches_limit: null });
});

app.post("/api/patch-rtx/job-record", requireToken, express.json(), async (req, res) => {
  const q = req.query || {};
  const entry = {
    ts: Date.now(),
    sizeMb: parseFloat(q.sizeMb) || 0,
    codec: String(q.codec || "").slice(0, 32),
    container: String(q.container || "").slice(0, 16),
    user: (req.jqToken && req.jqToken.userId) || "unknown",
    action: String(q.action || "").slice(0, 120),
    result: String(q.result || "ok").slice(0, 32),
    detail: String(q.detail || "").slice(0, 240),
  };
  jobLog.unshift(entry);
  if (jobLog.length > 500) jobLog.length = 500;

  if (firebaseReady && entry.result === "ok" && req.jqToken && req.jqToken.userId) {
    try {
      await db.collection("users").doc(req.jqToken.userId).update({
        patchesUsed: admin.firestore.FieldValue.increment(1),
      });
    } catch (e) { /* non-fatal */ }
  }

  res.json({ ok: true, used: 0, limit: null });
});

app.post("/api/patch-rtx/job-complete", requireToken, express.json(), (req, res) => {
  res.json({ ok: true });
});
app.post("/api/patch-rtx/local-use", requireToken, express.json(), (req, res) => {
  res.json({ ok: true, used: 0, limit: null });
});
app.post("/api/patch-rtx/local-release", requireToken, express.json(), (req, res) => {
  res.json({ ok: true });
});

/* ── Cloudinary upload helper ───────────────────────────────── */
function uploadToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    if (!cloudinaryReady()) return reject(new Error("Cloudinary not configured."));
    const base = path.basename(filename, path.extname(filename)).replace(/[^\w.-]/g, "_");
    const publicId = `${CF_FOLDER}/${base}_${Date.now()}_${newId(6)}`;
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "video", folder: CF_FOLDER, public_id: publicId, overwrite: false },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

/* ── Fetch a finished job ───────────────────────────────────── */
app.get("/api/patch-rtx/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found or expired." });
  res.setHeader("X-Job-Id", req.params.id);
  res.setHeader("X-Cloudinary-Url", job.url);
  return res.redirect(302, job.url);
});

app.get("/api/patch-rtx/latest-job", (req, res) => {
  const nm = String(req.query.nm || "");
  const sz = parseInt(req.query.sz || "0", 10);
  let best = null;
  for (const [id, j] of jobs) {
    if (j.expiresAt < Date.now()) continue;
    if (nm && j.name !== nm) continue;
    if (sz && j.size !== sz) continue;
    if (!best || j.finishedAt > best.finishedAt) best = { id, ...j };
  }
  if (!best) return res.status(404).json({ ok: false, error: "No matching job." });
  res.setHeader("X-Job-Id", best.id);
  res.setHeader("X-Cloudinary-Url", best.url);
  return res.redirect(302, best.url);
});

/* ═══════════════════════════════════════════════════════════════
   MAIN PATCH ENDPOINT — multipart (multer to disk)
   ═══════════════════════════════════════════════════════════════ */
app.post("/api/patch-rtx", requireToken, upload.single("file"), async (req, res) => {
  if (!req.file || !req.file.path) {
    return res.status(400).json({ ok: false, error: "No file received." });
  }
  const inPath = req.file.path;
  const filename = String(req.file.originalname || req.headers["x-filename"] || "input.mp4");

  console.log(`[patch-rtx] Received ${filename} (${(req.file.size / 1048576).toFixed(2)} MB)`);

  try {
    // 1) Patch the MP4 with FFmpeg (stream copy, low memory)
    const patched = await patchMp4FromPath(inPath);
    console.log(`[patch-rtx] Patched to ${(patched.length / 1048576).toFixed(2)} MB`);

    // 2) Try to upload the result to Cloudinary (non-fatal if it fails)
    let result = null;
    try {
      result = await uploadToCloudinary(patched, filename);
      const jobId = newId(24);
      jobs.set(jobId, {
        url: result.secure_url,
        publicId: result.public_id,
        name: filename,
        size: patched.length,
        expiresAt: Date.now() + JOB_TTL_MS,
        finishedAt: Date.now(),
      });
      res.setHeader("X-Job-Id", jobId);
      res.setHeader("X-Cloudinary-Url", result.secure_url);
      console.log(`[patch-rtx] Uploaded to Cloudinary: ${result.secure_url}`);
    } catch (e) {
      console.warn("[patch-rtx] Cloudinary upload failed, serving locally:", e.message);
    }

    // 3) Send the patched file directly to the browser
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(patched.length));
    res.end(patched);
  } catch (e) {
    console.error("[patch-rtx] failed:", e);
    res.status(500).json({ ok: false, error: e.message || "Patch failed." });
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) {}
  }
});

/* ═══════════════════════════════════════════════════════════════
   MP4 PATCHER — FFmpeg-based (low memory, streaming)
   ═══════════════════════════════════════════════════════════════ */

/* Patch a file that already exists on disk (from multer) */
async function patchMp4FromPath(inPath) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString("hex");
  const outPath = path.join(tmpDir, "jq_out_" + id + ".mp4");

  try {
    const inSize = fs.statSync(inPath).size;
    console.log(`[patchMp4FromPath] input: ${(inSize / 1048576).toFixed(2)} MB`);

    // Low-memory settings:
    //   -threads 1        : single thread — much lower peak RAM
    //   -c copy           : no re-encode, just remux
    //   -movflags +faststart : moov at front
    //   -maxbuffer 10 MB  : don't accumulate ffmpeg's stdout
    await execFileAsync("ffmpeg", [
      "-y",
      "-threads", "1",
      "-fflags", "+genpts",
      "-err_detect", "ignore_err",
      "-i", inPath,
      "-c", "copy",
      "-movflags", "+faststart",
      "-metadata", "encoder=" + ENCODER_TAG,
      "-metadata", "comment=Optimized by JOHN_QUALITY",
      outPath,
    ], {
      timeout: 600000,               // 10 minutes max
      maxBuffer: 10 * 1024 * 1024,   // 10 MB stdout buffer only
    });

    const stat = fs.statSync(outPath);
    console.log(`[patchMp4FromPath] output: ${(stat.size / 1048576).toFixed(2)} MB`);

    if (!stat.size || stat.size < 1024) {
      throw new Error("ffmpeg produced an empty output");
    }

    // Read output in 1 MB chunks to avoid a huge single allocation
    const chunks = [];
    const stream = fs.createReadStream(outPath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (e) {
    console.error("[patchMp4FromPath] ffmpeg failed:", e.message);
    throw new Error("Video optimization failed: " + (e.message || "unknown error"));
  } finally {
    try { fs.unlinkSync(outPath); } catch (e) {}
  }
}

/* Legacy in-memory version (kept for safety — not used by the endpoint) */
async function patchMp4(raw) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString("hex");
  const inPath = path.join(tmpDir, "jq_in_" + id + ".mp4");

  try {
    fs.writeFileSync(inPath, raw);
    raw = null;
    return await patchMp4FromPath(inPath);
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) {}
  }
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN
   ═══════════════════════════════════════════════════════════════ */
app.post("/api/admin/login", express.json(), (req, res) => {
  if (String((req.body && req.body.secret) || "") !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "Invalid admin secret." });
  }
  const token = jwt.sign({ admin: true }, SECRET, { expiresIn: "12h" });
  res.json({ ok: true, adminToken: token });
});

app.get("/api/admin/users", async (req, res) => {
  const auth = String(req.headers.authorization || "");
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(t, SECRET); } catch { return res.status(401).json({ error: "Unauthorized" }); }
  if (!firebaseReady) return res.json({ users: [], total: 0, pages: 1 });

  try {
    const snap = await db.collection("users").orderBy("lastLoginAt", "desc").limit(500).get();
    const users = [];
    snap.forEach((doc) => {
      const u = doc.data();
      users.push({
        uid: u.uid,
        username: u.name,
        email: u.email,
        tier: u.tier || "premium",
        today_patches: u.patchesUsed || 0,
        created_at: u.createdAt,
      });
    });
    res.json({ users, total: users.length, pages: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/jobs", (req, res) => {
  const auth = String(req.headers.authorization || "");
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(t, SECRET); } catch { return res.status(401).json({ error: "Unauthorized" }); }
  const cutoff = Date.now() - 5 * 60 * 1000;
  res.json({ ok: true, jobs: jobLog.filter((j) => j.ts > cutoff) });
});

/* ── Stubs ──────────────────────────────────────────────────── */
app.post("/api/chat", express.json(), (req, res) => {
  const msg = String((req.body && req.body.message) || "").trim();
  res.json({ reply: msg ? "Got your message." : "Ask me anything about the optimizer." });
});
app.post("/api/tiktok", express.json(), (req, res) => {
  res.status(503).json({ error: "TikTok analyzer not configured." });
});
app.get("/api/usage", (req, res) => {
  res.json({ ok: true, used: 0, limit: null });
});

/* ── Static frontend ────────────────────────────────────────── */
app.use(express.static(path.join(__dirname), {
  extensions: ["html"],
  setHeaders: (res, fp) => {
    if (fp.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    else if (/\.(js|css)$/.test(fp)) res.setHeader("Cache-Control", "public, max-age=3600");
  },
}));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ── Error handler ──────────────────────────────────────────── */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: `File too large (max ${MAX_UPLOAD_MB} MB).` });
  }
  res.status(500).json({ ok: false, error: err.message || "Internal server error" });
});

/* ── Boot ───────────────────────────────────────────────────── */
if (require.main === module || process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║     JOHN_QUALITY Backend v2.0                ║");
    console.log("║     Railway · Google · Firestore · Cloudinary ║");
    console.log("║     FFmpeg-based patcher (low-memory)        ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`  Port         : ${PORT}`);
    console.log(`  Public URL   : ${PUBLIC_BASE}`);
    console.log(`  Firebase     : ${firebaseReady ? "✓" : "✗"}`);
    console.log(`  Cloudinary   : ${cloudinaryReady() ? "✓" : "✗"}`);
    console.log(`  Max upload   : ${MAX_UPLOAD_MB} MB`);
    console.log("");

    execFileAsync("ffmpeg", ["-version"])
      .then((r) => console.log("  FFmpeg       : ✓ " + r.stdout.split("\n")[0]))
      .catch(() => console.warn("  FFmpeg       : ✗ NOT FOUND — install it via nixpacks.toml"));
  });
}

module.exports = app;
