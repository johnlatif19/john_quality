/* ═══════════════════════════════════════════════════════════════
   JOHN_QUALITY — Backend server
   Cloudinary storage · No-login · Unlimited · .env driven
   
   Endpoints:
     GET  /api/health
     GET  /api/me
     GET  /api/stats
     POST /api/authorize                → mint a patch token
     POST /api/patch-rtx                → single-shot upload + patch
     POST /api/patch-rtx/up/:id         → chunked upload part
     GET  /api/patch-rtx/up/:id         → chunk status
     POST /api/patch-rtx/up/:id/finish  → assemble + patch + upload
     GET  /api/patch-rtx/job/:id        → return a finished file
     GET  /api/patch-rtx/latest-job     → most recent matching job
     POST /api/patch-rtx/job-record
     POST /api/patch-rtx/job-complete
     POST /api/patch-rtx/local-use
     POST /api/patch-rtx/local-release
     GET  /api/admin/users
     GET  /api/admin/jobs
     POST /api/admin/login
     POST /api/chat
     POST /api/tiktok
   ═══════════════════════════════════════════════════════════════ */

"use strict";

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { v2: cloudinary } = require("cloudinary");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

/* ── Config from .env ───────────────────────────────────────── */
const TOKEN_TTL_MS   = 5 * 60 * 1000;      // 5 minutes
const JOB_TTL_MS     = 24 * 60 * 60 * 1000; // 24 hours (Cloudinary persists)
const UPLOAD_TTL_MS  = 60 * 60 * 1000;      // 1 hour in-memory chunk session
const SECRET         = process.env.JQ_SECRET || "john_quality_default_secret_change_me";
const ADMIN_SECRET   = process.env.ADMIN_SECRET || "admin_change_me";
const CF_FOLDER      = process.env.CLOUDINARY_FOLDER || "john_quality";

/* ── Cloudinary setup ───────────────────────────────────────── */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

function cloudinaryReady() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

/* ── In-memory stores (chunks + metadata) ───────────────────── */
// Chunks are short-lived (transient uploads). Finished files live on Cloudinary.
const uploads = new Map();      // uploadId → { chunks: Map, size, name, received, expiresAt }
const jobs = new Map();         // jobId → { url, publicId, name, size, expiresAt, finishedAt }
const jobLog = [];              // recent job records
const stats = {
  totalPatches: 0,
  totalUsers: 1,
  patchesToday: 0,
  startedAt: Date.now(),
  lastPatchAt: 0,
};

/* Cleanup of stale in-memory entries */
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of uploads) if (u.expiresAt < now) uploads.delete(id);
  for (const [id, j] of jobs)    if (j.expiresAt < now) jobs.delete(id);
}, 60_000);

/* ── Middleware ─────────────────────────────────────────────── */
app.use(express.json({ limit: "1mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "60mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, X-Patch-Token, X-Discord-Id, X-Filename, X-Job-Key, X-Job-Id, " +
    "X-Upload-Offset, X-Upload-Size, X-Upload-Part-Size, X-Upload-New, X-Convert-H264, " +
    "X-Engine, X-User-Key, Authorization");
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
    uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
    cloudinary: cloudinaryReady(),
    discordConfigured: false,
    devMode: false,
  });
});

/* ── /api/me — always Premium guest ─────────────────────────── */
app.get("/api/me", (req, res) => {
  res.json({
    logged_in: true,
    username: "GUEST",
    display_name: "Guest",
    tier: "donor",
    tierLabel: "Premium",
    avatar_url: null,
    patches_used: 0,
    patches_limit: null,
    discord_id: "guest",
  });
});

/* ── /api/stats ─────────────────────────────────────────────── */
app.get("/api/stats", (req, res) => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  stats.patchesToday = jobLog.filter((j) => j.ts > oneDayAgo && j.result === "ok").length;
  res.json({
    totalPatches: stats.totalPatches,
    totalUsers: stats.totalUsers,
    patchesToday: stats.patchesToday,
    usersUsed: stats.totalUsers,
    active7d: stats.totalUsers,
    daily: buildDailySeries(7),
    engine: {
      status: "ONLINE",
      uptime: humanUptime(stats.startedAt),
      lastPatchAt: stats.lastPatchAt,
    },
  });
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
function humanUptime(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ── /api/authorize ─────────────────────────────────────────── */
app.post("/api/authorize", (req, res) => {
  const token = signToken({
    tier: "donor",
    userId: "guest",
    expiresAt: Date.now() + TOKEN_TTL_MS,
    nonce: newId(12),
  });
  res.json({
    ok: true,
    token,
    tier: "donor",
    patches_used: 0,
    patches_limit: null,
  });
});

/* ── Job bookkeeping ────────────────────────────────────────── */
app.post("/api/patch-rtx/job-record", requireToken, (req, res) => {
  const q = req.query || {};
  const entry = {
    ts: Date.now(),
    sizeMb: parseFloat(q.sizeMb) || 0,
    codec: String(q.codec || "").slice(0, 32),
    container: String(q.container || "").slice(0, 16),
    user: (req.jqToken && req.jqToken.userId) || "guest",
    action: String(q.action || "").slice(0, 120),
    result: String(q.result || "ok").slice(0, 32),
    detail: String(q.detail || "").slice(0, 240),
  };
  jobLog.unshift(entry);
  if (jobLog.length > 500) jobLog.length = 500;
  if (entry.result === "ok") {
    stats.totalPatches++;
    stats.lastPatchAt = entry.ts;
  }
  res.json({ ok: true, used: 0, limit: null });
});

app.post("/api/patch-rtx/job-complete", requireToken, (req, res) => {
  res.json({ ok: true, used: 0, limit: null });
});

/* ── Daily-slot endpoints — always OK ───────────────────────── */
app.post("/api/patch-rtx/local-use", requireToken, (req, res) => {
  res.json({ ok: true, used: 0, limit: null });
});
app.post("/api/patch-rtx/local-release", requireToken, (req, res) => {
  res.json({ ok: true });
});

/* ── Cloudinary upload helper ───────────────────────────────── */
function uploadToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    if (!cloudinaryReady()) {
      return reject(new Error("Cloudinary is not configured. Check your .env file."));
    }
    const publicId = `${CF_FOLDER}/${path.basename(filename, path.extname(filename))}_${Date.now()}_${newId(6)}`;
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        folder: CF_FOLDER,
        public_id: publicId,
        overwrite: false,
        // Keep the file as-is; no transformation
        type: "upload",
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
}

/* ── Fetch a finished job (redirect to Cloudinary) ──────────── */
app.get("/api/patch-rtx/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found or expired." });
  // Redirect the browser straight to the Cloudinary URL
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

/* ── Chunked upload ─────────────────────────────────────────── */
app.post("/api/patch-rtx/up/:id", requireToken, (req, res) => {
  const id = req.params.id;
  const offset = parseInt(req.headers["x-upload-offset"] || "0", 10);
  const total = parseInt(req.headers["x-upload-size"] || "0", 10);
  const partSize = parseInt(req.headers["x-upload-part-size"] || "0", 10);
  const filename = String(req.headers["x-filename"] || "input.mp4");
  const isNew = req.headers["x-upload-new"] === "1";

  let up = uploads.get(id);
  if (!up) {
    if (!isNew && offset > 0) {
      return res.status(409).json({ ok: false, error: "Upload session not found.", received: 0 });
    }
    up = {
      size: total,
      name: filename,
      chunks: new Map(),
      received: 0,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
    };
    uploads.set(id, up);
  }

  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
  if (buf.length === 0) return res.status(400).json({ ok: false, error: "Empty chunk." });

  up.chunks.set(offset, buf);
  up.received = Array.from(up.chunks.values()).reduce((s, b) => s + b.length, 0);
  up.expiresAt = Date.now() + UPLOAD_TTL_MS;

  const partIndex = partSize > 0 ? Math.floor(offset / partSize) : 0;
  res.json({
    ok: true,
    received: up.received,
    size: up.size,
    part: partIndex,
    parts: Array.from(up.chunks.keys()).map((o) => Math.floor(o / (partSize || buf.length || 1))),
  });
});

app.get("/api/patch-rtx/up/:id", requireToken, (req, res) => {
  const up = uploads.get(req.params.id);
  if (!up) return res.json({ ok: true, received: 0, size: 0, partSize: 0, parts: [] });
  res.json({
    ok: true,
    received: up.received,
    size: up.size,
    partSize: 0,
    parts: [],
  });
});

/* ── Finish: assemble + patch + Cloudinary upload ──────────── */
app.post("/api/patch-rtx/up/:id/finish", requireToken, async (req, res) => {
  const up = uploads.get(req.params.id);
  if (!up) return res.status(410).json({ ok: false, error: "Upload expired." });

  // Assemble chunks in offset order
  const sorted = Array.from(up.chunks.entries()).sort((a, b) => a[0] - b[0]);
  const parts = [];
  for (const [, buf] of sorted) parts.push(buf);
  const assembled = Buffer.concat(parts);

  try {
    const patched = patchMp4(assembled);

    // Upload to Cloudinary
    const result = await uploadToCloudinary(patched, up.name);
    const jobId = newId(24);
    jobs.set(jobId, {
      url: result.secure_url,
      publicId: result.public_id,
      name: up.name,
      size: up.size,
      expiresAt: Date.now() + JOB_TTL_MS,
      finishedAt: Date.now(),
    });
    uploads.delete(req.params.id);

    res.setHeader("X-Job-Id", jobId);
    res.setHeader("X-Cloudinary-Url", result.secure_url);
    res.json({
      ok: true,
      jobId,
      url: result.secure_url,
      publicId: result.public_id,
      size: patched.length,
    });
  } catch (e) {
    console.error("finish failed:", e);
    res.status(500).json({ ok: false, error: e.message || "Patch or upload failed." });
  }
});

/* ── Single-shot upload + patch ─────────────────────────────── */
app.post("/api/patch-rtx", requireToken, async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  if (raw.length === 0) {
    return res.status(400).json({ ok: false, error: "Empty request body." });
  }
  try {
    const patched = patchMp4(raw);
    const filename = String(req.headers["x-filename"] || "input.mp4");
    const result = await uploadToCloudinary(patched, filename);
    const jobId = newId(24);
    jobs.set(jobId, {
      url: result.secure_url,
      publicId: result.public_id,
      name: filename,
      size: raw.length,
      expiresAt: Date.now() + JOB_TTL_MS,
      finishedAt: Date.now(),
    });
    res.setHeader("X-Job-Id", jobId);
    res.setHeader("X-Cloudinary-Url", result.secure_url);
    res.json({
      ok: true,
      jobId,
      url: result.secure_url,
      publicId: result.public_id,
      size: patched.length,
    });
  } catch (e) {
    console.error("patch failed:", e);
    res.status(500).json({ ok: false, error: e.message || "Patch or upload failed." });
  }
});

/* ── MP4 patcher (box-level) ────────────────────────────────── */
const ENCODER_TAG = "JOHN_QUALITY - https://www.johnquality.xyz/ - v2.0";
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

function patchMp4(raw) {
  const top = scanTopBoxes(raw);
  if (!top.length) throw new Error("Not a valid MP4.");

  const moov = top.find((b) => b.name === "moov");
  if (!moov) throw new Error("No 'moov' box found.");

  const moovBody = raw.subarray(moov.offset + moov.headerLen, moov.offset + moov.size);
  const boxes = parseBoxes(moovBody);

  const traks = findBoxes(boxes, "trak");
  const videoTrak = traks.find((t) => handlerOf(t) === "vide");
  const audioTrak = traks.find((t) => handlerOf(t) === "soun");
  if (!videoTrak) throw new Error("No video track found.");
  if (!audioTrak) throw new Error("No audio track found.");

  applyWatermark(boxes, videoTrak);

  const mvhd = findBoxes(boxes, "mvhd")[0];
  if (mvhd && mvhd.data) mvhd.data = setDurationUnknown(mvhd.data);

  audioTrak.children = audioTrak.children.filter((c) => c.name !== "edts");

  const newMoovBody = buildBoxes(boxes);
  const newMoovHeader = Buffer.alloc(8);
  newMoovHeader.writeUInt32BE(newMoovBody.length + 8, 0);
  newMoovHeader.write("moov", 4, "latin1");

  const before = raw.subarray(0, moov.offset);
  const after = raw.subarray(moov.offset + moov.size);
  return Buffer.concat([before, newMoovHeader, newMoovBody, after]);
}

function readU32(buf, off) { return buf.readUInt32BE(off); }
function readName(buf, off) { return buf.toString("latin1", off + 4, off + 8); }

function scanTopBoxes(raw) {
  const out = [];
  let i = 0;
  while (i + 8 <= raw.length) {
    let size = readU32(raw, i);
    const name = readName(raw, i);
    let headerLen = 8;
    if (size === 1) {
      if (i + 16 > raw.length) break;
      size = Number(raw.readBigUInt64BE(i + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = raw.length - i;
    }
    if (size < headerLen || i + size > raw.length) break;
    out.push({ name, offset: i, size, headerLen });
    i += size;
  }
  return out;
}

function parseBoxes(data) {
  const boxes = [];
  let i = 0;
  while (i + 8 <= data.length) {
    let size = readU32(data, i);
    const name = readName(data, i);
    let headerLen = 8;
    if (size === 1) {
      if (i + 16 > data.length) break;
      size = Number(data.readBigUInt64BE(i + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = data.length - i;
    }
    if (size < headerLen || i + size > data.length) break;
    const body = data.subarray(i + headerLen, i + size);
    if (CONTAINERS.has(name)) {
      boxes.push({ name, children: parseBoxes(body), data: null });
    } else {
      boxes.push({ name, children: [], data: Buffer.from(body) });
    }
    i += size;
  }
  return boxes;
}

function buildBoxes(boxes) {
  const chunks = [];
  for (const b of boxes) {
    const body = b.children.length ? buildBoxes(b.children) : b.data || Buffer.alloc(0);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8, 0);
    header.write(b.name, 4, "latin1");
    chunks.push(header, body);
  }
  return Buffer.concat(chunks);
}

function findBoxes(boxes, name) {
  const out = [];
  for (const b of boxes) {
    if (b.name === name) out.push(b);
    if (b.children.length) out.push(...findBoxes(b.children, name));
  }
  return out;
}

function handlerOf(trak) {
  const h = findBoxes(trak.children || [], "hdlr")[0];
  if (!h || !h.data || h.data.length < 12) return null;
  return h.data.toString("latin1", 8, 12);
}

function setDurationUnknown(data) {
  if (!data || data.length < 4) return data;
  const version = data[0];
  if (version === 0 && data.length >= 100) {
    const out = Buffer.alloc(data.length + 12);
    out[0] = 1;
    data.copy(out, 1, 1, 4);
    data.copy(out, 8, 4, 8);
    data.copy(out, 16, 8, 12);
    data.copy(out, 20, 12, 16);
    for (let j = 0; j < 8; j++) out[24 + j] = 0xFF;
    data.copy(out, 32, 20);
    return out;
  }
  if (version === 1 && data.length >= 112) {
    const out = Buffer.from(data);
    for (let j = 0; j < 8; j++) out[24 + j] = 0xFF;
    return out;
  }
  return data;
}

function applyWatermark(moovBoxes, videoTrak) {
  for (let i = moovBoxes.length - 1; i >= 0; i--) {
    if (moovBoxes[i].name === "udta") moovBoxes.splice(i, 1);
  }
  const tagBytes = Buffer.from(ENCODER_TAG, "utf8");
  const dataPayload = Buffer.alloc(8 + tagBytes.length + 1);
  dataPayload.writeUInt32BE(1, 0);
  dataPayload.writeUInt32BE(0, 4);
  tagBytes.copy(dataPayload, 8);

  const atom = (name, payload) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8, 0);
    header.write(name, 4, "latin1");
    return Buffer.concat([header, payload]);
  };
  const dataBox = atom("data", dataPayload);
  const ctooBox = atom("\xA9too", dataBox);
  const ilstBox = atom("ilst", ctooBox);
  const hdlrPayload = Buffer.alloc(25);
  hdlrPayload.write("mdir", 8, "latin1");
  const hdlrBox = atom("hdlr", hdlrPayload);
  const metaBox = atom("meta", Buffer.concat([Buffer.alloc(4), hdlrBox, ilstBox]));

  const udtaIdx = videoTrak.children.findIndex((c) => c.name === "udta");
  const udta = { name: "udta", children: [], data: metaBox };
  if (udtaIdx >= 0) videoTrak.children[udtaIdx] = udta;
  else videoTrak.children.push(udta);
}

/* ── Admin ──────────────────────────────────────────────────── */
app.post("/api/admin/login", (req, res) => {
  const { secret } = req.body || {};
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "Invalid admin secret." });
  }
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/admin/users", (req, res) => {
  res.json({ users: [], total: 0, pages: 1 });
});

app.get("/api/admin/jobs", (req, res) => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const recent = jobLog.filter((j) => j.ts > cutoff);
  res.json({ ok: true, jobs: recent });
});

/* ── Chat stub ──────────────────────────────────────────────── */
app.post("/api/chat", (req, res) => {
  const msg = String((req.body && req.body.message) || "").trim();
  res.json({
    reply: "JOHN_QUALITY assistant: " + (msg
      ? "I got your message — check the FAQ or try again in a moment."
      : "Ask me anything about the optimizer, formats, or bitrate recommendations."),
  });
});

/* ── TikTok analyzer stub ───────────────────────────────────── */
app.post("/api/tiktok", (req, res) => {
  res.status(503).json({ error: "TikTok analyzer not configured." });
});

/* ── Usage endpoints ────────────────────────────────────────── */
app.get("/api/usage", (req, res) => {
  res.json({ ok: true, used: 0, limit: null });
});

/* ── Static frontend ────────────────────────────────────────── */
app.use(express.static(path.join(__dirname), {
  extensions: ["html"],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    else if (/\.(js|css)$/.test(filePath)) res.setHeader("Cache-Control", "public, max-age=3600");
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
  res.status(500).json({ ok: false, error: err.message || "Internal server error" });
});

/* ── Boot ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║        JOHN_QUALITY Backend v2.0             ║");
  console.log("║        Cloudinary · No-Login · Unlimited     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Listening on port    : ${PORT}`);
  console.log(`  Public base URL      : ${PUBLIC_BASE}`);
  console.log(`  Cloudinary configured: ${cloudinaryReady() ? "✓" : "✗ (check .env)"}`);
  console.log(`  Cloudinary folder    : ${CF_FOLDER}`);
  console.log("");
  if (!cloudinaryReady()) {
    console.warn("⚠  WARNING: Cloudinary credentials missing from .env");
    console.warn("   Uploads will fail until CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,");
    console.warn("   and CLOUDINARY_API_SECRET are set.");
  }
});

module.exports = app;
