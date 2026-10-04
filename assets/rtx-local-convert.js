/* JOHN_QUALITY — local HEVC -> H.264 conversion.
 *
 * Loaded as an ES MODULE (type="module") because the 0.12 loader only works
 * that way. It runs entirely on the member's own machine: nothing is uploaded
 * anywhere, and the patch server never sees a byte of it.
 *
 * TWO engines, tried in this order:
 *   1. THIS DEVICE'S OWN GPU  — WebCodecs, in rtx-gpu-local.js.
 *   2. THIS DEVICE'S CPU      — ffmpeg.wasm, below.
 */

// SELF is the folder both engines live in; HERE is the ffmpeg.wasm payload.
const SELF = new URL("./", import.meta.url).href;
const HERE = SELF + "ffmpeg/";
const CORE_JS = HERE + "core/ffmpeg-core.js";
const CORE_WASM = HERE + "core/ffmpeg-core.wasm";

let _pending = null;
let _ff = null;
let _gen = 0;

function ready(note) {
  if (_ff) return Promise.resolve(_ff);
  if (_pending) return _pending;
  _pending = (async () => {
    const mod = await import(HERE + "esm/index.js");
    const FFmpeg = mod.FFmpeg || (mod.default && mod.default.FFmpeg);
    if (!FFmpeg) throw new Error("the local encoder did not load");

    const ff = new FFmpeg();
    try { ff.on("log", () => {}); } catch (e) {}
    try {
      await ff.load({ coreURL: CORE_JS, wasmURL: CORE_WASM });
    } catch (e) {
      let d;
      try { d = (e && e.message) ? e.message : JSON.stringify(e); } catch (x) { d = String(e); }
      throw new Error("the local encoder could not start" + (d && d !== "undefined" ? ": " + d : ""));
    }
    _ff = ff;
    return ff;
  })();
  return _pending;
}

/* ── engine 1: this device's GPU, loaded only if it can be used ──────────── */
let _gpuMod = null;
function gpuModule() {
  if (_gpuMod) return _gpuMod;
  _gpuMod = import(SELF + "rtx-gpu-local.js?v=20")
    .then(function () { return window.RTXLocalGpu || null; })
    .catch(function () { return null; });
  return _gpuMod;
}

/**
 * JOHN_QUALITY: bitrate cap is UNLIMITED.
 * Returns a 100 Mbps ceiling for every file — no distinction between 4K and 1080p.
 */
async function bitrateCapFor(blob) {
  return new Promise(function (res) {
    var done = false;
    function fin(cap, w, h) { if (!done) { done = true; res({ cap: cap, w: w || 0, h: h || 0 }); } }
    try {
      var v = document.createElement("video");
      v.preload = "metadata"; v.muted = true;
      var u = URL.createObjectURL(blob);
      v.onloadedmetadata = function () {
        var h = v.videoHeight || 0, w = v.videoWidth || 0;
        // JOHN_QUALITY: no bitrate cap — 100 Mbps ceiling for every file.
        fin(100000000, w, h);
        try { URL.revokeObjectURL(u); } catch (e) {}
      };
      v.onerror = function () { fin(100000000, 0, 0); try { URL.revokeObjectURL(u); } catch (e) {} };
      setTimeout(function () { fin(100000000, 0, 0); }, 4000);
      v.src = u;
    } catch (e) { fin(100000000, 0, 0); }
  });
}

async function encode(blob, note, pct) {
  note = note || function () {};
  const gen = _gen;
  const dead = () => gen !== _gen;
  const info = await bitrateCapFor(blob);
  const capBps = info.cap;
  // 4K detection is kept only to decide whether the wasm fallback is safe —
  // it no longer influences the bitrate cap (which is unlimited now).
  const is4K = info.h >= 2000 || info.w >= 3500;
  try {
    const gpu = await gpuModule();
    if (gpu && (await gpu.probe())) {
      const out = await gpu.encode(blob, function () {}, pct, dead);
      const finalBps = (gpu.last && gpu.last.finalBps) || 0;
      if (!(finalBps > capBps * 1.05)) return out;
      if (is4K) return out;
    }
  } catch (e) {
    if (is4K) {
      throw new Error("4K could not be converted by this device's hardware encoder (" +
        String((e && e.message) || "encoder failed") +
        "). Nothing was uploaded and no upload was counted.");
    }
  }
  if (is4K) {
    throw new Error("This device has no hardware H.264 encoder for 4K, so a 4K file cannot be converted here. Nothing was uploaded and no upload was counted.");
  }
  return encodeCpu(blob, note, pct, capBps, dead);
}

/**
 * The CPU engine (ffmpeg.wasm).
 * JOHN_QUALITY: no hard maxrate — the encoder runs at CRF 20 with a 100 Mbps
 * ceiling to keep the file compatible without throttling quality.
 */
async function encodeCpu(blob, note, pct, capBps, dead) {
  if (dead && dead()) throw new Error("aborted");
  const ff = await ready(note);
  let onProg = null;
  if (pct) {
    onProg = (e) => {
      try { pct(Math.max(0, Math.min(1, (e && e.progress) || 0))); } catch (x) {}
    };
    try { ff.on("progress", onProg); } catch (e) {}
  }
  try {
    await ff.writeFile("rtx_in.mp4", new Uint8Array(await blob.arrayBuffer()));
    const code = await ff.exec([
      "-y", "-nostdin",
      "-fflags", "+genpts+igndts", "-err_detect", "ignore_err",
      "-i", "rtx_in.mp4",
      "-map", "0:v:0", "-map", "0:a?",
      "-map", "-0:d", "-map", "-0:t",
      "-sn", "-dn", "-map_metadata", "-1",
      "-c:v", "libx264", "-preset", "fast", "-crf", "20",
      "-g", "12", "-bf", "0",
      // JOHN_QUALITY: 100 Mbps ceiling — effectively unlimited for real-world
      // files, but keeps the MP4 muxer happy.
      "-maxrate", "100000k", "-bufsize", "100000k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-c:a", "aac",
      "rtx_out.mp4"
    ]);
    if (code !== 0) throw new Error("the local encoder could not convert this file");
    const data = await ff.readFile("rtx_out.mp4");
    if (!data || !data.length) throw new Error("the local encoder produced an empty file");
    return new Blob([data.buffer ? data.buffer : data], { type: "video/mp4" });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/memory|alloc|out of bounds|OOM|Cannot enlarge/i.test(m)) {
      throw new Error("this file is too large to encode on this device — try again when the GPU encoder is available");
    }
    throw (e instanceof Error ? e : new Error(m));
  } finally {
    if (onProg) { try { ff.off("progress", onProg); } catch (e) {} }
    try { await ff.deleteFile("rtx_in.mp4"); } catch (e) {}
    try { await ff.deleteFile("rtx_out.mp4"); } catch (e) {}
  }
}

/* Read the audio codec name from ffmpeg's own input banner. */
async function audioCodecName(ff, inputPath) {
  let captured = "";
  const onLog = (d) => {
    try { captured += (d && d.message) ? String(d.message) : String(d); } catch (e) {}
  };
  try { ff.on("log", onLog); } catch (e) {}
  try { await ff.exec(["-i", inputPath]); } catch (e) {}
  try { ff.off("log", onLog); } catch (e) {}
  const m = /Stream\s+#\d+:\d+[^\n]*?Audio:\s*([A-Za-z0-9_]+)/.exec(captured);
  return m ? m[1] : "";
}

/**
 * REMUX. The remux LADDER: attempt 1 is the plain stream copy, attempts 2+
 * are the tolerant variants.
 */
async function remux(blob, note, pct, name) {
  const ff = await ready(note);
  const IN_NAME = (String(name || "")
    .replace(/^.*[\\/]/, "")
    .replace(/[^A-Za-z0-9._ ()-]/g, "_")
    .trim()) || "input.mp4";
  const OUT_NAME = "remux_" + (IN_NAME.replace(/\.[^.]*$/, "") || "input") + ".mp4";
  let onProg = null;
  let _probing = false;
  if (pct) {
    onProg = (e) => {
      if (_probing) return;
      try { pct(Math.max(0, Math.min(1, (e && e.progress) || 0))); } catch (x) {}
    };
    try { ff.on("progress", onProg); } catch (e) {}
  }
  try {
    await ff.writeFile(IN_NAME, new Uint8Array(await blob.arrayBuffer()));
    const REMUX_TIMEOUT_MS = 120000;
    const ENH = ["-fflags", "+genpts+igndts", "-err_detect", "ignore_err"];
    const attempts = [
      { pre: [], tail: ["-c", "copy"] },
      { pre: ENH, tail: ["-c", "copy"] },
      { pre: ENH, tail: ["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"] },
      { pre: ENH, tail: ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k"] },
      { pre: ENH, tail: ["-map", "0:v:0", "-map", "0:a:1?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k"] },
    ];
    let data = null;
    for (let ai = 0; ai < attempts.length && !data; ai++) {
      const at = attempts[ai];
      const args = ["-y"].concat(at.pre).concat(["-i", IN_NAME]).concat(at.tail).concat(["-movflags", "+faststart", OUT_NAME]);
      let ok = false;
      try {
        ok = (await ff.exec(args, REMUX_TIMEOUT_MS)) === 0;
      } catch (e) {
        ok = false;
      }
      if (ok) {
        try {
          const d = await ff.readFile(OUT_NAME);
          if (d && d.length) data = d;
        } catch (e) {
          data = null;
        }
      }
      try { await ff.deleteFile(OUT_NAME); } catch (e) {}
    }
    if (!data) {
      let acodec = "";
      try {
        _probing = true;
        acodec = await audioCodecName(ff, IN_NAME);
      } catch (e) {
        acodec = "";
      } finally {
        _probing = false;
      }
      if (/^pcm_|^adpcm_/.test(acodec)) {
        const pcmArgs = ["-y"]
          .concat(ENH)
          .concat(["-i", IN_NAME])
          .concat(["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k"])
          .concat(["-movflags", "+faststart", OUT_NAME]);
        let pcmOk = false;
        try {
          pcmOk = (await ff.exec(pcmArgs, REMUX_TIMEOUT_MS)) === 0;
        } catch (e) {
          pcmOk = false;
        }
        if (pcmOk) {
          try {
            const d = await ff.readFile(OUT_NAME);
            if (d && d.length) data = d;
          } catch (e) {
            data = null;
          }
        }
        try { await ff.deleteFile(OUT_NAME); } catch (e) {}
      }
    }
    if (!data) {
      if (onProg) { try { ff.off("progress", onProg); } catch (e) {} onProg = null; }
      const enc = await encode(blob, note, pct);
      if (!enc || !enc.size) {
        throw new Error("this file could not be remuxed or encoded on this device");
      }
      return enc;
    }
    return new Blob([data.buffer ? data.buffer : data], { type: "video/mp4" });
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/memory|alloc|out of bounds|OOM|Cannot enlarge/i.test(m)) {
      throw new Error("this file is too large to remux on this device");
    }
    throw (e instanceof Error ? e : new Error(m));
  } finally {
    if (onProg) { try { ff.off("progress", onProg); } catch (e) {} }
    try { await ff.deleteFile(IN_NAME); } catch (e) {}
    try { await ff.deleteFile(OUT_NAME); } catch (e) {}
  }
}

/**
 * JOHN_QUALITY ENGINE (with FFMPEG) — the -itsscale pre-pass.
 */
async function itsScale(blob, pct, fpsHint) {
  const fps = Number(fpsHint) || 0;
  const factor = fps >= 100 ? 4 : (fps >= 45 ? 2 : 0);
  if (!factor) return blob;
  const ff = await ready();
  const IN = "rtx_its_in.mp4", OUT = "rtx_its_out.mp4";
  try {
    await ff.writeFile(IN, new Uint8Array(await blob.arrayBuffer()));
    let onProg = null;
    if (pct) {
      onProg = (e) => {
        try { pct(Math.max(0, Math.min(1, (e && e.progress) || 0))); } catch (x) {}
      };
      try { ff.on("progress", onProg); } catch (e) {}
    }
    let code = 1;
    try {
      code = await ff.exec(["-y", "-nostdin", "-itsscale", String(factor),
        "-i", IN, "-c:v", "copy", "-c:a", "copy", OUT]);
    } finally {
      if (onProg) { try { ff.off("progress", onProg); } catch (e) {} }
    }
    if (code !== 0) return blob;
    const d = await ff.readFile(OUT);
    if (!d || !d.length) return blob;
    return new Blob([d], { type: "video/mp4" });
  } catch (e) {
    return blob;
  } finally {
    try { await ff.deleteFile(IN); } catch (e) {}
    try { await ff.deleteFile(OUT); } catch (e) {}
  }
}

/* Drop the shared engine. */
function reset() {
  _gen++;
  try { if (_ff && typeof _ff.terminate === "function") _ff.terminate(); } catch (e) {}
  _ff = null;
  _pending = null;
}
window.RTXLocalConvert = { encode, remux, itsScale, reset };
