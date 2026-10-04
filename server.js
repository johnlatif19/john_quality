/* ═══════════════════════════════════════════════════════════════
   JOHN_QUALITY — Backend (Google Auth + Firestore + Cloudinary)
   
   Auth flow:
   1. User clicks "Sign in with Google" on the website
   2. Firebase Client SDK gets an ID token from Google
   3. Client sends the ID token to POST /api/auth/google
   4. Server verifies the token with Firebase Admin
   5. Server creates/finds the user in Firestore, returns a session JWT
   6. Client stores the JWT and uses it in X-Patch-Token for API calls
   ═══════════════════════════════════════════════════════════════ */

"use strict";

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const jwt = require("jsonwebtoken");
const { v2: cloudinary } = require("cloudinary");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

/* ── Config ─────────────────────────────────────────────────── */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_TTL_MS   = 5 * 60 * 1000;            // 5 minutes
const JOB_TTL_MS     = 24 * 60 * 60 * 1000;      // 24 hours
const UPLOAD_TTL_MS  = 60 * 60 * 1000;           // 1 hour
const SECRET         = process.env.JQ_SECRET || "john_quality_default_secret_change_me";
const ADMIN_SECRET   = process.env.ADMIN_SECRET || "admin_change_me";
const CF_FOLDER      = process.env.CLOUDINARY_FOLDER || "john_quality";

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
        // Fix escaped newlines from .env
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

/* ── In-memory stores ───────────────────────────────────────── */
const uploads = new Map();
const jobs = new Map();
const jobLog = [];

setInterval(() => {
  const now = Date.now();
  for (const [id, u] of uploads) if (u.expiresAt < now) uploads.delete(id);
  for (const [id, j] of jobs)    if (j.expiresAt < now) jobs.delete(id);
}, 60_000);

/* ── Middleware ─────────────────────────────────────────────── */
app.use(express.json({ limit: "1mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "60mb" }));

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
  });
});

/* ═══════════════════════════════════════════════════════════════
   AUTH — Google Sign-In via Firebase
   ═══════════════════════════════════════════════════════════════ */

/* POST /api/auth/google
   Body: { idToken: "..." }
   Verifies the Firebase ID token, upserts the user in Firestore,
   returns a 30-day session JWT. */
app.post("/api/auth/google", async (req, res) => {
  if (!firebaseReady) {
    return res.status(503).json({ ok: false, error: "Firebase not configured on the server." });
  }
  const idToken = String((req.body && req.body.idToken) || "");
  if (!idToken) return res.status(400).json({ ok: false, error: "Missing idToken." });

  try {
    // Verify the Firebase ID token
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email || "";
    const name = decoded.name || email.split("@")[0] || "User";
    const picture = decoded.picture || null;

    if (!email) {
      return res.status(400).json({ ok: false, error: "Google account has no email." });
    }

    // Upsert the user in Firestore
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    const now = Date.now();

    if (!snap.exists) {
      await userRef.set({
        uid,
        email,
        name,
        picture,
        createdAt: now,
        lastLoginAt: now,
        patchesUsed: 0,
        tier: "premium", // everyone is premium
      });
    } else {
      await userRef.update({
        lastLoginAt: now,
        name,
        picture,
      });
    }

    // Issue a 30-day session JWT
    const sessionToken = jwt.sign(
      { uid, email, name, picture },
      SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      ok: true,
      sessionToken,
      user: {
        uid,
        email,
        name,
        picture,
        tier: "premium",
      },
    });
  } catch (e) {
    console.error("Google sign-in failed:", e);
    res.status(401).json({ ok: false, error: "Invalid Google token: " + e.message });
  }
});

/* GET /api/me — returns the current user from the session JWT */
app.get("/api/me", requireSession, async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.session.uid).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "User not found." });
    }
    const u = snap.data();
    res.json({
      logged_in: true,
      uid: u.uid,
      email: u.email,
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

/* POST /api/auth/logout */
app.post("/api/auth/logout", (req, res) => {
  // Client just drops the JWT. Nothing to do server-side.
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
        lastPatchAt: jobLog.find((j) => j.result === "ok")?.ts || 0,
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
  return `${Math.floor(process.uptime() / 60)}m`;
}

/* ═══════════════════════════════════════════════════════════════
   PATCHER — mint tokens, accept uploads, upload to Cloudinary
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

app.post("/api/patch-rtx/job-record", requireToken, async (req, res) => {
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

  // Bump the user's patchesUsed counter in Firestore
  if (firebaseReady && entry.result === "ok" && req.jqToken && req.jqToken.userId) {
    try {
      await db.collection("users").doc(req.jqToken.userId).update({
        patchesUsed: admin.firestore.FieldValue.increment(1),
      });
    } catch (e) { /* non-fatal */ }
  }

  res.json({ ok: true, used: 0, limit: null });
});

app.post("/api/patch-rtx/job-complete", requireToken, (req, res) => {
  res.json({ ok: true });
});
app.post("/api/patch-rtx/local-use", requireToken, (req, res) => {
  res.json({ ok: true, used: 0, limit: null });
});
app.post("/api/patch-rtx/local-release", requireToken, (req, res) => {
  res.json({ ok: true });
});

/* ── Cloudinary upload ──────────────────────────────────────── */
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
    if (!isNew && offset > 0) return res.status(409).json({ ok: false, error: "Upload session not found.", received: 0 });
    up = { size: total, name: filename, chunks: new Map(), received: 0, expiresAt: Date.now() + UPLOAD_TTL_MS };
    uploads.set(id, up);
  }
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
  if (buf.length === 0) return res.status(400).json({ ok: false, error: "Empty chunk." });
  up.chunks.set(offset, buf);
  up.received = Array.from(up.chunks.values()).reduce((s, b) => s + b.length, 0);
  up.expiresAt = Date.now() + UPLOAD_TTL_MS;

  const partIndex = partSize > 0 ? Math.floor(offset / partSize) : 0;
  res.json({ ok: true, received: up.received, size: up.size, part: partIndex });
});

app.get("/api/patch-rtx/up/:id", requireToken, (req, res) => {
  const up = uploads.get(req.params.id);
  if (!up) return res.json({ ok: true, received: 0, size: 0, partSize: 0, parts: [] });
  res.json({ ok: true, received: up.received, size: up.size, partSize: 0, parts: [] });
});

/* ── Finish: assemble + patch + upload to Cloudinary ───────── */
app.post("/api/patch-rtx/up/:id/finish", requireToken, async (req, res) => {
  const up = uploads.get(req.params.id);
  if (!up) return res.status(410).json({ ok: false, error: "Upload expired." });

  const sorted = Array.from(up.chunks.entries()).sort((a, b) => a[0] - b[0]);
  const assembled = Buffer.concat(sorted.map(([, b]) => b));

  try {
    const patched = patchMp4(assembled);
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
    res.json({ ok: true, jobId, url: result.secure_url, publicId: result.public_id, size: patched.length });
  } catch (e) {
    console.error("finish failed:", e);
    res.status(500).json({ ok: false, error: e.message || "Patch or upload failed." });
  }
});

/* ── Single-shot upload ─────────────────────────────────────── */
app.post("/api/patch-rtx", requireToken, async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  if (raw.length === 0) return res.status(400).json({ ok: false, error: "Empty request body." });
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
    res.json({ ok: true, jobId, url: result.secure_url, publicId: result.public_id, size: patched.length });
  } catch (e) {
    console.error("patch failed:", e);
    res.status(500).json({ ok: false, error: e.message || "Patch or upload failed." });
  }
});

/* ═══════════════════════════════════════════════════════════════
   MP4 PATCHER (same as before)
   ═══════════════════════════════════════════════════════════════ */
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

function readU32(b, o) { return b.readUInt32BE(o); }
function readName(b, o) { return b.toString("latin1", o + 4, o + 8); }
function scanTopBoxes(raw) {
  const out = []; let i = 0;
  while (i + 8 <= raw.length) {
    let size = readU32(raw, i); const name = readName(raw, i); let hl = 8;
    if (size === 1) { if (i + 16 > raw.length) break; size = Number(raw.readBigUInt64BE(i + 8)); hl = 16; }
    else if (size === 0) size = raw.length - i;
    if (size < hl || i + size > raw.length) break;
    out.push({ name, offset: i, size, headerLen: hl }); i += size;
  }
  return out;
}
function parseBoxes(data) {
  const boxes = []; let i = 0;
  while (i + 8 <= data.length) {
    let size = readU32(data, i); const name = readName(data, i); let hl = 8;
    if (size === 1) { if (i + 16 > data.length) break; size = Number(data.readBigUInt64BE(i + 8)); hl = 16; }
    else if (size === 0) size = data.length - i;
    if (size < hl || i + size > data.length) break;
    const body = data.subarray(i + hl, i + size);
    if (CONTAINERS.has(name)) boxes.push({ name, children: parseBoxes(body), data: null });
    else boxes.push({ name, children: [], data: Buffer.from(body) });
    i += size;
  }
  return boxes;
}
function buildBoxes(boxes) {
  const chunks = [];
  for (const b of boxes) {
    const body = b.children.length ? buildBoxes(b.children) : b.data || Buffer.alloc(0);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(body.length + 8, 0); h.write(b.name, 4, "latin1");
    chunks.push(h, body);
  }
  return Buffer.concat(chunks);
}
function findBoxes(boxes, name) {
  const out = [];
  for (const b of boxes) { if (b.name === name) out.push(b); if (b.children.length) out.push(...findBoxes(b.children, name)); }
  return out;
}
function handlerOf(trak) {
  const h = findBoxes(trak.children || [], "hdlr")[0];
  return (h && h.data && h.data.length >= 12) ? h.data.toString("latin1", 8, 12) : null;
}
function setDurationUnknown(data) {
  if (!data || data.length < 4) return data;
  const v = data[0];
  if (v === 0 && data.length >= 100) {
    const out = Buffer.alloc(data.length + 12); out[0] = 1;
    data.copy(out, 1, 1, 4); data.copy(out, 8, 4, 8); data.copy(out, 16, 8, 12); data.copy(out, 20, 12, 16);
    for (let j = 0; j < 8; j++) out[24 + j] = 0xFF;
    data.copy(out, 32, 20); return out;
  }
  if (v === 1 && data.length >= 112) {
    const out = Buffer.from(data);
    for (let j = 0; j < 8; j++) out[24 + j] = 0xFF;
    return out;
  }
  return data;
}
function applyWatermark(moovBoxes, videoTrak) {
  for (let i = moovBoxes.length - 1; i >= 0; i--) if (moovBoxes[i].name === "udta") moovBoxes.splice(i, 1);
  const tagBytes = Buffer.from(ENCODER_TAG, "utf8");
  const dp = Buffer.alloc(8 + tagBytes.length + 1);
  dp.writeUInt32BE(1, 0); dp.writeUInt32BE(0, 4); tagBytes.copy(dp, 8);
  const atom = (n, p) => { const h = Buffer.alloc(8); h.writeUInt32BE(p.length + 8, 0); h.write(n, 4, "latin1"); return Buffer.concat([h, p]); };
  const dataBox = atom("data", dp);
  const ctooBox = atom("\xA9too", dataBox);
  const ilstBox = atom("ilst", ctooBox);
  const hdlrP = Buffer.alloc(25); hdlrP.write("mdir", 8, "latin1");
  const hdlrBox = atom("hdlr", hdlrP);
  const metaBox = atom("meta", Buffer.concat([Buffer.alloc(4), hdlrBox, ilstBox]));
  const idx = videoTrak.children.findIndex((c) => c.name === "udta");
  const udta = { name: "udta", children: [], data: metaBox };
  if (idx >= 0) videoTrak.children[idx] = udta; else videoTrak.children.push(udta);
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN
   ═══════════════════════════════════════════════════════════════ */
app.post("/api/admin/login", (req, res) => {
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
app.post("/api/chat", (req, res) => {
  const msg = String((req.body && req.body.message) || "").trim();
  res.json({ reply: msg ? "Got your message." : "Ask me anything about the optimizer." });
});
app.post("/api/tiktok", (req, res) => {
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
  res.status(500).json({ ok: false, error: err.message || "Internal server error" });
});

/* ── Boot ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     JOHN_QUALITY Backend v2.0                ║");
  console.log("║     Google Auth · Firestore · Cloudinary     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Port         : ${PORT}`);
  console.log(`  Public URL   : ${PUBLIC_BASE}`);
  console.log(`  Firebase     : ${firebaseReady ? "✓" : "✗"}`);
  console.log(`  Cloudinary   : ${cloudinaryReady() ? "✓" : "✗"}`);
  console.log("");
});

module.exports = app;
