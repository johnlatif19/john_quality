/* ═══════════════════════════════════════════════════════════════
   JOHN_QUALITY — shared.js · all pages
   Talks to the local API (/api/*). Falls back to demo data when the
   server is unreachable (e.g. standalone files opened directly).
   Analytics = TikTok Analyzer (same tools/shapes as Zilem):
   Check / Best Time / Hashtags / Recap / Compare / Tag.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ── helpers ───────────────────────────────────────────────── */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const fmt = (n) => { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString("en-US") : "0"; };
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* JOHN_QUALITY: ALL TIERS UNLIMITED — every tier is Premium-equivalent. */
  const TIER_MAP = { member: ["Free", 0, "4K120", 120], booster: ["Booster", 0, "4K120", 120], donor: ["Premium", 0, "4K120", 120] };
  /* JOHN_QUALITY: NO file-size cap at all. */
  const PREMIUM_MAX_MB = 999999;
  /* Cloudflare refuses any single request body over 100 MB with a 413 AT THE
     EDGE, before the origin ever sees it. Kept as a transport limit only. */
  const CF_ONE_SHOT_MAX = 90 * 1024 * 1024;
  /* JOHN_QUALITY: NO daily upload limit at all. */
  const PATCH_LIMIT = { member: null, booster: null, donor: null };
  /* JOHN_QUALITY: NO resolution or FPS caps — everything is unlimited. */
  const TIER_RES = {
    member:  { resLong: 99999, resShort: 99999, maxFPS: 9999 },
    booster: { resLong: 99999, resShort: 99999, maxFPS: 9999, hiFPS: 9999, hiResLong: 99999, hiResShort: 99999 },
    donor:   { resLong: 99999, resShort: 99999, maxFPS: 9999 },
  };
  /* Accept both the local server shape ({user, admin}) and the Vercel/discord.ts
     shape ({logged_in, tier, limit_mb, display_name, avatar_url}). */
  function normalizeMe(j) {
    if (!j) return { user: null, admin: false };
    if (j.user) {
      const raw = j.user;
      let t = raw.tier;
      if (typeof t === "string") { const m = TIER_MAP[t] || TIER_MAP.member; t = { tier: t, tierLabel: m[0], tierMB: m[1], tierRes: m[2], tierFPS: m[3] }; }
      if (!t || typeof t !== "object") { const m = TIER_MAP.member; t = { tier: "member", tierLabel: m[0], tierMB: m[1], tierRes: m[2], tierFPS: m[3] }; }
      return { user: { username: raw.username || raw.display_name || "USER", display_name: raw.display_name, avatar: raw.avatar_url || raw.avatar || null, tier: t }, admin: !!j.admin };
    }
    if (!j.logged_in) return { user: null, admin: false };
    const t = j.tier || "member";
    const [label, mb, res, fps] = TIER_MAP[t] || TIER_MAP.member;
    return { user: { username: j.username || j.display_name || "USER", display_name: j.display_name, avatar: j.avatar_url || j.avatar || null, tier: { tier: t, tierLabel: label, tierMB: mb, tierRes: res, tierFPS: fps } }, admin: false };
  }


  /* Session-persistent cache: page switches re-run /api/stats and /api/health,
     so we cache the last good response and render instantly instead of
     showing a logged-out/loading state while waiting. /api/me is deliberately
     NOT cached — it's auth state, and a stale "logged out" cache entry would
     survive the OAuth round-trip (sessionStorage persists across navigation)
     and keep the UI logged out after a successful login. */
  const GET_CACHE = { "/api/stats": 60e3, "/api/health": 120e3 };
  function cacheRead(k) {
    try {
      const raw = sessionStorage.getItem("rtxcache:" + k);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }
  function cacheHit(k) {
    const e = cacheRead(k);
    return e && (Date.now() - e.t < GET_CACHE[k]) ? e.v : null;
  }
  function cacheStale(k) {
    const e = cacheRead(k);
    return e ? e.v : null;
  }
  function cacheWrite(k, v) {
    try { sessionStorage.setItem("rtxcache:" + k, JSON.stringify({ t: Date.now(), v })); } catch {}
  }

  async function api(path, opts) {
    const method = (opts && opts.method) || "GET";
    const cacheable = method === "GET" && !(opts && opts.cache === "no-store") && GET_CACHE[path];
    if (cacheable) { const hit = cacheHit(path); if (hit) return hit; }
    try {
      const r = await fetch(path, opts);
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const out = { ok: r.ok, status: r.status, json: await r.json() };
        if (cacheable && out.ok && out.json) cacheWrite(path, out);
        return out;
      }
      const out = { ok: r.ok, status: r.status, blob: await r.blob(), headers: r.headers };
      if (cacheable && out.ok) cacheWrite(path, out);
      return out;
    } catch (e) {
      if (cacheable) { const stale = cacheStale(path); if (stale) return stale; }
      return null;
    }
  }

  /* ── shared UI ──────────────────────────────────────────────── */
  function initReveal() {
    const els = $$(".reveal");
    if (!("IntersectionObserver" in window)) return els.forEach((e) => e.classList.add("in"));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.1 });
    els.forEach((e) => io.observe(e));
  }
  function countUp(node, target, dur) {
    const start = performance.now();
    (function tick(now) {
      const p = Math.min(1, (now - start) / (dur || 1200));
      node.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 4))));
      if (p < 1) requestAnimationFrame(tick);
    })(start);
  }
  function setUsagePill(user) {
    const pill = $("#nav-usage");
    if (!pill) return;
    // JOHN_QUALITY: everything is Unlimited — no daily counters shown.
    pill.innerHTML = "<b>Unlimited</b>";
  }
  function renderAuth(user, devMode) {
    const login = $("#btn-login"), dev = $("#btn-dev"), logout = $("#btn-logout"), chip = $("#nav-user");
    const useDev = !!(dev && devMode && !API_DISCORD);
    if (logout) {
      logout.style.display = user ? "inline-flex" : "none";
      logout.onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "/"; };
    }
    if (user) {
      if (login) login.style.display = "none";
      if (dev) dev.style.display = "none";
      if (chip) {
        chip.style.display = "inline-flex";
        chip.innerHTML =
          (user.avatar ? '<img class="nav-avatar" src="' + esc(user.avatar) + '" alt=""/>' : "") +
          '<span class="nav-user-name" id="nav-user-name"></span>' +
          '<span class="nav-user-tier" id="nav-user-tier"></span>';
        $("#nav-user-name").textContent = user.username || "USER";
        $("#nav-user-tier").textContent = ((user.tier && user.tier.tierLabel) || "Guest").toUpperCase();
      }
    } else {
      if (login) login.style.display = "none";
      if (dev) dev.style.display = "none";
      if (chip) chip.style.display = "none";
    }
    const hl = $("#hero-login");
    if (hl) {
      if (user) { hl.style.display = "none"; hl.innerHTML = ""; }
      else {
        hl.style.display = "";
        if (useDev) {
          hl.innerHTML = '<button class="btn btn-discord" id="devLoginBtn">Dev Login</button>';
          const d = $("#devLoginBtn");
          if (d) d.onclick = async () => { const r = await api("/api/login/dev", { method: "POST" }); if (r && r.ok) location.reload(); };
        } else {
          hl.innerHTML =
            '<div class="login-choices">' +
            '<a class="btn btn-discord" href="/login" data-login>' + DISCORD_SVG + 'Login with Discord</a>' +
            '<button class="btn btn-tg" type="button" id="hero-login-tg">' + TELEGRAM_SVG + 'Login with Telegram</button>' +
            '</div>';
          startTelegramLogin($("#hero-login-tg"));
        }
      }
    }
    const bn = $("#bn-login");
    if (bn) {
      if (user) {
        bn.style.display = "none";
        bn.classList.remove("active");
      } else {
        bn.style.display = "flex";
        bn.innerHTML = DISCORD_SVG + "<span>Login</span>";
        bn.setAttribute("data-login", "");
        bn.setAttribute("data-discord", "");
        bn.href = "#/login";
        bn.classList.remove("active");
      }
    }
    if (bn) {
      let bnTg = $("#bn-login-tg");
      if (!bnTg) {
        bn.insertAdjacentHTML("afterend",
          '<a class="bn-item bn-item-tg" id="bn-login-tg" href="#" role="button"><span>Login</span></a>');
        bnTg = $("#bn-login-tg");
      }
      if (bnTg) {
        const tgVisible = !user;
        bnTg.style.display = tgVisible ? "flex" : "none";
        if (tgVisible) {
          bnTg.innerHTML = TELEGRAM_SVG + "<span>Login</span>";
          if (!bnTg.dataset.wired) { bnTg.dataset.wired = "1"; startTelegramLogin(bnTg); }
        }
      }
    }
    const bnLo = $("#bn-logout");
    if (bnLo) {
      bnLo.style.display = user ? "flex" : "none";
      bnLo.onclick = async (ev) => { ev.preventDefault(); await api("/api/logout", { method: "POST" }); clearCachedAuth(); location.href = "/"; };
    }
    setUsagePill(user);
  }

  function initDashboard() {
    const cmp = $("#cmp");
    if (cmp) initCompare(cmp);
    initCompareVideo();

    loadAuthState().then((user) => {
      renderAuth(user, AUTH_DEV);
      if (user) { renderTier(user.tier, user.username, AUTH_ME_RAW); }
      else {
        const chip = $("#welcome-chip");
        if (chip) { chip.style.display = "none"; }
      }
    });

    const loadStats = () => {
      api("/api/stats?_t=" + Date.now()).then((r) => {
        if (r && r.ok) renderStats(r.json);
        else renderStats(null);
      });
    };
    loadStats();
    setInterval(loadStats, 15000);

    const dt = $("#hero-date");
    if (dt) dt.textContent = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  function renderStats(s) {
    if (!s) {
      [["#kpi-patches", "—"], ["#kpi-users", "—"], ["#kpi-today", "—"]].forEach(([sel, v]) => {
        const n = $(sel); if (n) n.textContent = v;
      });
      if ($("#kpi-today-foot")) $("#kpi-today-foot").textContent = "—";
      if ($("#eng-dot")) $("#eng-dot").classList.remove("off");
      if ($("#eng-text")) { $("#eng-text").textContent = "ONLINE"; $("#eng-text").style.color = ""; }
      if ($("#eng-version")) $("#eng-version").textContent = "JOHN_QUALITY ENGINE v2.0";
      if ($("#eng-uptime")) $("#eng-uptime").textContent = "UPTIME —";
      if ($("#eng-last")) $("#eng-last").textContent = "LAST OPTIMIZATION —";
      return;
    }
    const kpis = [["#kpi-patches", s.totalPatches], ["#kpi-users", s.totalUsers], ["#kpi-today", s.patchesToday]];
    kpis.forEach(([sel, v]) => {
      const node = $(sel);
      if (!node) return;
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { countUp(node, v, 1300); io.disconnect(); } }), { threshold: 0.3 });
      io.observe(node);
    });
    const weekTotal = (s.daily || []).reduce((a, d) => a + (d.count || 0), 0);
    if ($("#kpi-today-foot")) $("#kpi-today-foot").textContent = fmt(weekTotal) + " LAST 7 DAYS";
    if ($("#kpi-users-foot")) {
      const used = (s.usersUsed != null) ? s.usersUsed : "—";
      const act = (s.active7d != null) ? s.active7d : "—";
      $("#kpi-users-foot").textContent = used + " USED TOOLS · " + act + " ACTIVE 7D";
    }
    const eng = s.engine || {};
    if ($("#eng-dot")) $("#eng-dot").classList.remove("off");
    if ($("#eng-text")) { $("#eng-text").textContent = "ONLINE"; $("#eng-text").style.color = ""; }
    if ($("#eng-version")) $("#eng-version").textContent = "JOHN_QUALITY ENGINE v2.0";
    if ($("#eng-uptime")) $("#eng-uptime").textContent = "UPTIME " + (eng.uptime || "—");
    if ($("#eng-last")) {
      const t = eng.lastPatchAt || s.lastPatchAt;
      $("#eng-last").textContent = "LAST OPTIMIZATION " + (t ? timeAgo(t) : "NEVER");
    }
  }

  function renderTier(t, username, me) {
    // JOHN_QUALITY: every tier is shown as the unlimited Premium tier.
    if ($("#tier-user")) $("#tier-user").textContent = username || "USER";
    if ($("#tier-name2")) $("#tier-name2").textContent = "PREMIUM";
    if ($("#tier-mb")) $("#tier-mb").textContent = "Unlimited";
    if ($("#tier-res")) $("#tier-res").textContent = "4K";
    if ($("#tier-fps")) $("#tier-fps").textContent = "120 FPS";
    const pbText = $("#pb-text"), pbSub = $("#pb-sub"), pbFill = $("#pb-fill");
    if (pbText && pbSub && pbFill) {
      pbText.textContent = "Unlimited";
      pbSub.textContent = "All features unlocked";
      pbFill.style.setProperty("--w", "100%");
    }
  }

  /* ── Tier CTAs ──────────────────────────────── */
  const TIER_CTA_LABEL = { member: "Join server", booster: "Join server", donor: "Join" };
  const CTA_TIER = { "join server": "member", "boost server": "booster", "donate": "donor", "join": "donor" };
  function renderTierCtas(tierKey) {
    $$(".tier-btn").forEach((b) => {
      if (!b.dataset.baseLabel) b.dataset.baseLabel = (b.textContent || "").trim();
      const card = b.closest("[data-tier]");
      const key = (card && card.dataset.tier) || CTA_TIER[b.dataset.baseLabel.toLowerCase()] || null;
      if (!key) return;
      const mine = !!tierKey && key === tierKey;
      b.textContent = mine ? "Activated" : b.dataset.baseLabel;
      b.classList.toggle("activated", mine);
      if (mine) { b.setAttribute("aria-disabled", "true"); b.setAttribute("tabindex", "-1"); }
      else { b.removeAttribute("aria-disabled"); b.removeAttribute("tabindex"); }
    });
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "S AGO";
    if (s < 3600) return Math.floor(s / 60) + "M AGO";
    if (s < 86400) return Math.floor(s / 3600) + "H AGO";
    return Math.floor(s / 86400) + "D AGO";
  }

  function initCompare(cmp) {
    const handle = $("#cmp-hand");
    const setPos = (p) => { p = Math.max(0, Math.min(100, p)); cmp.style.setProperty("--pos", p + "%"); if (handle) handle.setAttribute("aria-valuenow", Math.round(p)); };
    const move = (e) => { const r = cmp.getBoundingClientRect(); setPos(((e.clientX - r.left) / r.width) * 100); };
    let dragging = false;
    cmp.addEventListener("pointerdown", (e) => { dragging = true; cmp.classList.add("dragging"); cmp.setPointerCapture(e.pointerId); move(e); });
    cmp.addEventListener("pointermove", (e) => { if (dragging) move(e); });
    ["pointerup", "pointercancel"].forEach((ev) => cmp.addEventListener(ev, () => { dragging = false; cmp.classList.remove("dragging"); }));
    if (handle) handle.addEventListener("keydown", (e) => {
      const cur = parseFloat(cmp.style.getPropertyValue("--pos")) || 50;
      if (e.key === "ArrowLeft") setPos(cur - 2);
      if (e.key === "ArrowRight") setPos(cur + 2);
    });
  }

  function initCompareVideo() {
    const va = $("#vid-a"), vb = $("#vid-b");
    if (!va || !vb) return;
    const hq = (window.RTX && window.RTX.VIDEO_HQ) || "";
    const lq = (window.RTX && window.RTX.VIDEO_LQ) || "";
    if (!hq || !lq) return;

    function fail(v) { v.classList.remove("on"); }
    va.preload = "auto";
    vb.preload = "auto";
    va.src = lq;
    vb.src = hq;
    va.classList.add("on");
    vb.classList.add("on");
    va.addEventListener("error", () => fail(va));
    vb.addEventListener("error", () => fail(vb));

    let started = false, raf = 0;

    function tryStart() {
      if (started || va.readyState < 1 || vb.readyState < 1) return;
      started = true;
      try { va.currentTime = 0; vb.currentTime = 0; } catch (e) {}
      va.play().catch(() => {});
      vb.play().catch(() => {});
      raf = requestAnimationFrame(tick);
    }
    va.addEventListener("loadedmetadata", tryStart);
    vb.addEventListener("loadedmetadata", tryStart);

    function tick() {
      const dt = va.currentTime - vb.currentTime;
      if (Math.abs(dt) > 0.12) {
        if (dt > 0) {
          if (vb.paused && !vb.ended) va.pause();
          else vb.currentTime = va.currentTime;
        } else {
          if (va.paused && !va.ended) vb.pause();
          else va.currentTime = vb.currentTime;
        }
      } else {
        if (va.paused && !vb.paused && !va.ended) va.play().catch(() => {});
        if (vb.paused && !va.paused && !vb.ended) vb.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    }
  }

  function readVideoMeta(file) {
    return new Promise((resolve) => {
      let settled = false;
      let codec = "";
      let elMeta = null;
      const finish = (m) => { if (!settled) { settled = true; resolve(m); } };
      (async () => {
        try {
          const head = new Uint8Array(await file.slice(0, SCAN_HEAD).arrayBuffer());
          const has = (b, t) => {
            const c0 = t.charCodeAt(0), c1 = t.charCodeAt(1), c2 = t.charCodeAt(2), c3 = t.charCodeAt(3);
            for (let i = 0; i + 4 <= b.length; i++) {
              if (b[i] !== c0 || b[i + 1] !== c1 || b[i + 2] !== c2 || b[i + 3] !== c3) continue;
              return true;
            }
            return false;
          };
          if (has(head, "hvc1") || has(head, "hev1")) codec = "hevc";
          else if (has(head, "avc1")) codec = "avc1";
          if (!codec && file.size > SCAN_HEAD) {
            const tail = new Uint8Array(await file.slice(Math.max(0, file.size - SCAN_TAIL), file.size).arrayBuffer());
            if (has(tail, "hvc1") || has(tail, "hev1")) codec = "hevc";
            else if (has(tail, "avc1")) codec = "avc1";
          }
        } catch (e) {}
      })();

      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.src = url;
      const dropUrl = () => { try { URL.revokeObjectURL(url); } catch (e) {} };
      vid.onloadedmetadata = () => {
        const w = vid.videoWidth, h = vid.videoHeight;
        const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 0;
        if (w > 0 && h > 0) elMeta = { w, h, dur, fps: 0, codec };
        dropUrl();
      };
      vid.onerror = () => { dropUrl(); };

      const safety = setTimeout(() => finish(elMeta), 12000);

      parseMP4Boxes(file).then((m) => {
        clearTimeout(safety);
        if (m && (m.w > 0 || m.fps > 0 || m.dur > 0)) {
          if (!(m.dur > 0) && elMeta && elMeta.dur > 0) m.dur = elMeta.dur;
          if (!(m.w > 0) && elMeta) { m.w = elMeta.w; m.h = elMeta.h; }
          finish({ w: m.w, h: m.h, dur: m.dur, fps: m.fps, codec });
        } else {
          finish(elMeta);
        }
      });
    });
  }

  const SCAN_HEAD = 1024 * 1024;
  const SCAN_TAIL = 1024 * 1024;

  async function parseMP4Boxes(file) {
    const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const t4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

    const boxList = (b, start, end) => {
      const out = [];
      let p = start;
      while (p + 8 <= end) {
        let sz = u32(b, p), hs = 8;
        if (sz === 1) { if (p + 16 > end) break; sz = u32(b, p + 12); hs = 16; }
        if (sz === 0) sz = end - p;
        if (sz < hs || p + sz > end) break;
        out.push({ t: t4(b, p + 4), s: p + hs, e: p + sz });
        p += sz;
      }
      return out;
    };
    const findBox = (list, t) => list.find((x) => x.t === t);
    const scanBox = (b, type) => {
      const c0 = type.charCodeAt(0), c1 = type.charCodeAt(1), c2 = type.charCodeAt(2), c3 = type.charCodeAt(3);
      for (let i = 4; i + 4 <= b.length; i++) {
        if (b[i] !== c0 || b[i + 1] !== c1 || b[i + 2] !== c2 || b[i + 3] !== c3) continue;
        const sz = u32(b, i - 4);
        if (sz >= 8 && i - 4 + sz <= b.length) return i - 4;
      }
      return -1;
    };

    const head = new Uint8Array(await file.slice(0, SCAN_HEAD).arrayBuffer());
    if (head.length < 8) return null;
    const meta = { w: 0, h: 0, fps: 0, dur: 0 };

    const extract = (b) => {
      const moovStart = scanBox(b, "moov");
      if (moovStart < 0) return false;
      const moovBoxes = boxList(b, moovStart + 8, b.length);
      for (const trak of moovBoxes.filter((x) => x.t === "trak")) {
        const tb = boxList(b, trak.s, trak.e);
        const mdia = findBox(tb, "mdia");
        if (!mdia) continue;
        const mb = boxList(b, mdia.s, mdia.e);
        const minf = findBox(mb, "minf");
        if (!minf) continue;
        const minfb = boxList(b, minf.s, minf.e);
        if (!findBox(minfb, "vmhd")) continue;
        const tkhd = findBox(tb, "tkhd");
        if (tkhd) {
          const ver = b[tkhd.s];
          const wOff = tkhd.s + (ver === 1 ? 88 : 76);
          if (wOff + 8 <= b.length) { meta.w = u32(b, wOff) >>> 16; meta.h = u32(b, wOff + 4) >>> 16; }
        }
        const mdhd = findBox(mb, "mdhd");
        const stbl = findBox(minfb, "stbl");
        if (mdhd && stbl) {
          const ver = b[mdhd.s];
          const ts = u32(b, mdhd.s + (ver === 1 ? 20 : 12));
          if (ts > 0) {
            if (ver === 1) {
              const hi = u32(b, mdhd.s + 24), lo = u32(b, mdhd.s + 28);
              meta.dur = (hi * 4294967296 + lo) / ts;
            } else {
              meta.dur = u32(b, mdhd.s + 16) / ts;
            }
            const stts = findBox(boxList(b, stbl.s, stbl.e), "stts");
            if (stts && stts.s + 16 <= b.length) {
              const count = u32(b, stts.s + 4);
              if (count > 0) {
                const base = stts.s + 8;
                const max = Math.min(count, Math.floor((b.length - base) / 8));
                let sumF = 0, sumT = 0;
                for (let i = 0; i < max; i++) {
                  const c2 = u32(b, base + i * 8);
                  const d2 = u32(b, base + i * 8 + 4);
                  sumF += c2;
                  sumT += c2 * d2;
                }
                const f = sumT > 0 ? sumF / (sumT / ts) : 0;
                if (f >= 1 && f <= 240) meta.fps = Math.round(f);
              }
            }
          }
        }
        break;
      }
      return meta.w > 0 || meta.fps > 0 || meta.dur > 0;
    };

    if (extract(head)) return meta;
    if (file.size > SCAN_HEAD) {
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - SCAN_TAIL), file.size).arrayBuffer());
      if (extract(tail)) return meta;
    }
    return null;
  }

  function procLog(msg, cls) {
    const log = $("#procLog");
    if (!log) return;
    const line = document.createElement("div");
    line.className = "log-line" + (cls ? " " + cls : "");
    line.textContent = "> " + msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function procLogDl(msg) {
    const log = $("#procLog");
    if (!log) return;
    const kids = log.children;
    let line = null;
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k && k.dataset && k.dataset.dl === "1") { line = k; break; }
    }
    if (!line) {
      line = document.createElement("div");
      line.className = "log-line hi";
      line.dataset.dl = "1";
      log.appendChild(line);
    }
    line.textContent = "> " + msg;
    log.scrollTop = log.scrollHeight;
  }

  function fmtBytes(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
    return n + " B";
  }
  function fmtSpeed(bps) {
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
    return (bps / 1024).toFixed(0) + " KB/s";
  }
  function fmtEta(secs) {
    if (!Number.isFinite(secs) || secs <= 0) return "";
    return secs >= 60 ? Math.ceil(secs / 60) + "m" : Math.ceil(secs) + "s";
  }

  function rtxNewJobKey() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  }

  function initPatcher() {
    const input = $("#fileInput"), zone = $("#dropZone"), runBtn = $("#runBtn"), dlBtn = $("#dlBtn"), clearBtn = $("#clearBtn");
    const againBtn = $("#againBtn");
    const AGAIN_LABEL = againBtn ? againBtn.textContent : "";
    if (!input || !zone) return;

    // JOHN_QUALITY: tier caps are unlimited; limitMB is 0 = unlimited.
    let file = null, objectUrl = null, timers = [], abortCtrl = null, activeXhr = null, jobKey = "", limitMB = 0, tierLabel = "PREMIUM", apiLive = true, devMode = false, loggedIn = null, patchedName = "", tierKey = "donor", discordId = "", lastScan = null, lastHealth = "", probeBlocked = "";
    const UPLOAD_MAX = 45;
    const DL_FROM = 80;
    let finalizeTimer = null;
    let animBand = DL_FROM - 1;
    let dlFloor = null;
    let lastFileHevc = false, slowMsgShown1 = false, slowMsgShown2 = false;
    function stopFinalizeAnim() { if (finalizeTimer) { clearInterval(finalizeTimer); finalizeTimer = null; } }

    let _ceil = 0, _ceilHard = 0, _ceilTimer = null, _pinnedAt = 0;
    function rtxCeil(v) { try { if (typeof v === "number") { if (v > _ceil) _ceil = v; if (v > _ceilHard) _ceilHard = v; } } catch (e) {} }
    function rtxCeilReset(v) { const n = typeof v === "number" ? v : 0; _ceil = n; _ceilHard = n; _pinnedAt = 0; }
    function rtxCeilStage(cap) { try { if (typeof cap === "number" && cap > _ceilHard) _ceilHard = cap; } catch (e) {} }
    function rtxCeilStop() { if (_ceilTimer) { clearInterval(_ceilTimer); _ceilTimer = null; } }
    function rtxCeilStart() {
      if (_ceilTimer) return;
      _ceilTimer = setInterval(function () {
        try {
          if (_ceil < _ceilHard) _ceil = Math.min(_ceilHard, _ceil + 0.03);
          if (_ceil >= _ceilHard && _ceilHard >= 79 && _ceilHard < 96) {
            if (!_pinnedAt) _pinnedAt = Date.now();
            else if (Date.now() - _pinnedAt > 4000) _ceil = _ceilHard = Math.min(96, _ceil + 0.02);
          } else if (_ceil < _ceilHard) { _pinnedAt = 0; }
          const cur = parseFloat($("#progressFill").style.width) || 0;
          if (cur >= _ceil - 0.1) return;
          const next = Math.min(_ceil - 0.05, cur + 0.06);
          if (!(next > cur)) return;
          if (next > _barHigh) _barHigh = next;
          $("#progressFill").style.width = next + "%";
          $("#progressPct").textContent = next.toFixed(1) + "%";
        } catch (e) {}
      }, 60);
    }
    function rtxCreepStart(from) {
      let p = typeof from === "number" ? from : 80;
      return setInterval(function () {
        p = Math.min(97, p + 0.45);
        rtxBar(p);
      }, 60);
    }
    async function rtxRemux(blob, name, t0, t1) {
      const lo = (typeof t0 === "number") ? t0 : 15;
      const hi = (typeof t1 === "number") ? t1 : 60;
      if (!window.RTXLocalConvert || !window.RTXLocalConvert.remux) {
        throw new Error("the local remuxer did not load");
      }
      let out = await window.RTXLocalConvert.remux(
        blob,
        function (m) { procLog(m, "mut"); },
        function (p) { rtxBar(lo + Math.round(p * (hi - lo)), "Optimizing…"); },
        name
      );
      if (!out || !out.size) throw new Error("the remux produced nothing");
      out = await rtxItsScale(out, hi, hi + 8);
      return out;
    }

    async function rtxItsScale(blob, t0, t1) {
      let on = false;
      try { on = localStorage.getItem("rtx_engine") === "ffmpeg"; } catch (e) { on = false; }
      if (!on) return blob;
      if (!window.RTXLocalConvert || !window.RTXLocalConvert.itsScale) return blob;
      try {
        const _fps = (lastScan && lastScan.fps) ? lastScan.fps : 0;
        return await window.RTXLocalConvert.itsScale(blob, function (p) {
          rtxBar(t0 + Math.round(p * (t1 - t0)), "Scaling frame rate…");
        }, _fps);
      } catch (e) {
        return blob;
      }
    }

    let _barHigh = 0;
    function rtxBar(pct, label) {
      try {
        let p = Math.max(0, Math.min(100, Math.round(pct)));
        if (p === 0) _barHigh = 0;
        if (p < _barHigh) p = _barHigh;
        _barHigh = p;
        rtxCeil(p);
        $("#progressFill").style.width = p + "%";
        $("#progressPct").textContent = p + "%";
        if (label) $("#progressStage").textContent = label;
      } catch (e) {}
    }
    function dlProgress(loaded, total) {
      stopFinalizeAnim();
      rtxCeilStop();
      const now = parseFloat($("#progressFill").style.width) || UPLOAD_MAX;
      if (dlFloor === null) dlFloor = Math.max(UPLOAD_MAX, Math.min(DL_FROM, now));
      const pct = dlFloor + (loaded / total) * (100 - dlFloor);
      return Math.max(now, Math.min(100, pct));
    }
    function startFinalizeAnim(band) {
      stopFinalizeAnim();
      rtxCeilStop();
      animBand = typeof band === "number" ? band : DL_FROM - 1;
      if (animBand > DL_FROM - 0.2) animBand = DL_FROM - 0.2;
      let pct = Math.max(UPLOAD_MAX, parseFloat($("#progressFill").style.width) || UPLOAD_MAX);
      if (pct >= animBand) pct = Math.max(UPLOAD_MAX, animBand - 0.1);
      slowMsgShown1 = false;
      finalizeTimer = setInterval(() => {
         animBand = Math.min(DL_FROM - 0.2, animBand + 0.035);
         pct = Math.min(animBand - 0.05, pct + Math.max(0.045, (animBand - pct) * 0.07));
        if (pct >= 55.5 && !slowMsgShown1) {
          slowMsgShown1 = true;
          procLog(lastFileHevc ? "Optimizing your H265 (HEVC) file — applying the TikTok-safe settings. Tip: H.264 files process faster."
                               : "Optimizing your file — applying the TikTok-safe settings. Tip: H.264 files process the fastest.", "hi");
        }
        if (pct > _barHigh) _barHigh = pct;
        $("#progressFill").style.width = pct + "%";
        $("#progressPct").textContent = pct.toFixed(1) + "%";
      }, 60);
    }

    loadAuthState().then((user) => {
      const me = AUTH_ME_RAW;
      apiLive = API_DISCORD;
      devMode = AUTH_DEV;
      renderAuth(user, AUTH_DEV);
      loggedIn = user ? true : false;
      if (user) {
        tierKey = user.tier.tier;
        discordId = (me && me.discord_id) || "";
        // JOHN_QUALITY: every tier is unlimited — limitMB 0 disables all caps.
        limitMB = 0;
        tierLabel = "PREMIUM";
        setLimit(0);
        setUsagePill(user);
        const lbl = $("#usage-tier-label"), cnt = $("#usage-count"), av = $("#usage-avatar");
        if (lbl) lbl.textContent = user.username;
        if (cnt) cnt.textContent = "Unlimited";
        if (av) {
          if (user.avatar) av.innerHTML = '<img src="' + esc(user.avatar) + '" alt=""/>';
          else av.textContent = (user.username || "U")[0].toUpperCase();
        }
      }
    });

    setInterval(() => {
      if (loggedIn !== true) return;
      api("/api/me").then((m) => {
        const me = m && m.json;
        syncAuthFromMe(me);
      }).catch(() => {});
    }, 45000);

    const scan = { size: $("#sv-size"), res: $("#sv-res"), dur: $("#sv-dur"), health: $("#sv-health") };
    const gateState = { over: false, meta: null, caps: {} };
    function applyGateFromBox() {
      // JOHN_QUALITY: nothing blocks the Optimize button — everything is unlimited.
      runBtn.disabled = false;
      scan.health.textContent = "READY TO OPTIMIZE";
      scan.health.style.color = "var(--green)";
    }
    const setLimit = (used) => {
      // JOHN_QUALITY: always unlimited.
      $("#limitFill").style.width = "100%";
      $("#limitText").textContent = "Unlimited · PREMIUM";
    };

    function resetTimers() { timers.forEach(clearTimeout); timers = []; }
    function resetUI() {
      probeBlocked = "";
      stopWarm();
      resetTimers();
      stopFinalizeAnim();
      rtxCeilStop();
      rtxCeilReset(0);
      $("#processingView").style.display = "none";
      $("#dropZoneWrap").style.display = "";
      $("#scanView").classList.remove("show");
      $("#progressFill").style.width = "0";
      $("#progressPct").textContent = "0%";
      _barHigh = 0;
      dlFloor = null;
      window.__rtxCounted = false;
      $("#progressStage").textContent = "Processing…";
      $("#procStatus").textContent = "JOHN_QUALITY ENGINE v2.0";
      $("#cancelBtn").style.display = "";
      $("#dropZone").style.display = "";
      runBtn.style.display = "";
      runBtn.disabled = false;
      dlBtn.style.display = "none"; dlBtn.disabled = true;
      clearBtn.style.display = "none";
      if (againBtn) againBtn.style.display = "none";
      setLimit(0);
    }

    zone.addEventListener("click", () => {
      if (loggedIn === false) { requireLogin(); return; }
      input.click();
    });
    input.addEventListener("change", async () => {
      if (loggedIn === false) { requireLogin(); input.value = ""; return; }
      if (loggedIn === null) {
        const user = await loadAuthState();
        if (!user) { requireLogin(); input.value = ""; return; }
      }
      if (input.files[0]) handleFile(input.files[0]);
    });
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); }));
    zone.addEventListener("drop", async (e) => {
      if (loggedIn === false) { requireLogin(); return; }
      if (loggedIn === null) {
        const user = await loadAuthState();
        if (!user) { requireLogin(); return; }
      }
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

  function handleFile(f) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    file = f;
    objectUrl = URL.createObjectURL(f);
    const sizeMB = f.size / (1024 * 1024);
      scan.size.textContent = sizeMB.toFixed(1) + " MB";
      scan.res.textContent = "SCANNING…"; scan.dur.textContent = "SCANNING…";
      scan.health.textContent = "SCANNING…"; scan.health.style.color = "var(--text-3)";
      setLimit(sizeMB);
      $("#scanView").classList.add("show");
      probeBlocked = "";
      // JOHN_QUALITY: no size cap — always enabled.
      runBtn.disabled = false;

      // Probe for track validity only (no audio/video track still blocked)
      try {
        if (window.RTXLocal && window.RTXLocal.probe) {
          window.RTXLocal.probe(f).then(function (pr) {
            if (!pr || pr.ok) return;
            const _why = String(pr.reason || "");
            if (/No audio track|No video track/i.test(_why)) {
              probeBlocked = _why;
              runBtn.disabled = true;
              scan.health.textContent = /No audio track/i.test(_why) ? "NO SOUND TRACK" : "NO VIDEO TRACK";
              scan.health.style.color = "var(--red)";
              lastHealth = scan.health.textContent;
              procLog("Cannot optimize this file - " + _why, "err");
            } else {
              procLog("This file will need converting first: " + _why, "mut");
            }
          }).catch(function () {});
        }
      } catch (e) {}

      // Resolution / duration / FPS scan — informational only now.
      lastScan = null; lastHealth = "";
      readVideoMeta(f).then((meta) => {
        lastScan = meta || null;
        if (!meta) {
          scan.res.textContent = "UNKNOWN"; scan.dur.textContent = "UNKNOWN";
          scan.health.textContent = "READY TO OPTIMIZE"; scan.health.style.color = "var(--green)";
          lastHealth = "READY TO OPTIMIZE";
          return;
        }
        if (meta.w > 0 && meta.h > 0) {
          scan.res.textContent = meta.w + "×" + meta.h + (meta.codec === "hevc" ? " · H265 (HEVC)" : "");
        } else scan.res.textContent = "UNKNOWN";
        if (meta.codec === "hevc") {
          procLog("H265 (HEVC) detected. Optimising now. Tip: H.264 files are recommended.", "ok");
        }
        if (meta.dur > 0) scan.dur.textContent = Math.floor(meta.dur / 60) + ":" + String(Math.floor(meta.dur % 60)).padStart(2, "0");
        else scan.dur.textContent = "UNKNOWN";

        // JOHN_QUALITY: no res/fps caps. Only a missing track blocks the run.
        const blocked = !!probeBlocked;
        runBtn.disabled = blocked;
        gateState.over = false; gateState.meta = meta; gateState.caps = {};
        if (blocked) {
          scan.health.textContent = "CANNOT OPTIMIZE";
          scan.health.style.color = "var(--red)";
        } else {
          scan.health.textContent = "READY TO OPTIMIZE"; scan.health.style.color = "var(--green)";
          lastHealth = scan.health.textContent;
        }
      });
    }

    function sniffVideoCodec(file) {
      return new Promise((resolve) => {
        const markers = { avc1: "h264", avc3: "h264", avc4: "h264", hvc1: "hevc", hev1: "hevc", hev2: "hevc" };
        const reader = file.stream().getReader();
        const dec = new TextDecoder("latin1");
        let tail = "";
        function done(codec) { try { reader.cancel(); } catch (e) {} resolve(codec); }
        (function next() {
          reader.read().then(({ done: fin, value }) => {
            if (fin) { resolve(null); return; }
            const s = tail + dec.decode(value, { stream: true });
            let best = null; let bestIdx = 1e18;
            for (const m in markers) {
              const i = s.indexOf(m);
              if (i !== -1 && i < bestIdx) { bestIdx = i; best = markers[m]; }
            }
            if (best) { done(best); return; }
            tail = s.slice(-8);
            next();
          }).catch(() => resolve(null));
        })();
      });
    }

    function stopWarm() {}

    runBtn.addEventListener("click", async () => {
      if (loggedIn === false) { requireLogin(); return; }
      if (loggedIn === null) {
        const user = await loadAuthState();
        if (!user) { requireLogin(); return; }
      }
      if (!file) { input.click(); return; }
      // JOHN_QUALITY: no size caps at all — every file is accepted.
      const _h264Box = document.getElementById("h264Convert");
      if (_h264Box && _h264Box.checked) {
        try {
          const sniffed = await sniffVideoCodec(file);
          if (sniffed === "h264") {
            procLog("Your file is H.264 - please untick 'Convert H265 (HEVC) to H.264' and try again. (Process not started.)");
            alert("Your file is H.264 - please untick 'Convert H265 (HEVC) to H.264' and try again.");
            return;
          }
        } catch (e) {}
      }
      resetTimers();
      abortCtrl = new AbortController();
      const myCtrl = abortCtrl;
      const isDead = () => myCtrl.signal.aborted || myCtrl !== abortCtrl;
      jobKey = rtxNewJobKey();
      window.__rtxBusy = true;
      rtxCeilReset(0);
      rtxCeilStage(UPLOAD_MAX);
      rtxCeilStart();
      activeXhr = null;
      $("#dropZoneWrap").style.display = "none";
      $("#processingView").style.display = "block";
      $("#progressFill").style.width = "0";
      $("#progressPct").textContent = "0%";
      _barHigh = 0;
      dlFloor = null;
      $("#progressStage").textContent = "Checking daily usage…";
      $("#procStatus").textContent = "JOHN_QUALITY Engine v2 · CLOUD";
      dlBtn.disabled = true;

      const plog = $("#procLog");
      if (plog) plog.innerHTML = "";
      procLog("JOHN_QUALITY — Optimizer v2", "hi");
      procLog("File: " + file.name + " (" + fmtBytes(file.size) + ")", "pur");
      procLog("Tier: PREMIUM · Unlimited", "pur");
      if (lastScan) {
        procLog(
          "Scan: " + (lastScan.w > 0 ? lastScan.w + "×" + lastScan.h : "unknown res") +
          " · " + (lastScan.fps > 0 ? lastScan.fps + " fps" : "fps?") +
          " · " + (lastScan.dur > 0 ? Math.floor(lastScan.dur / 60) + "m" + Math.floor(lastScan.dur % 60) + "s" : "dur?") +
          " · " + (lastScan.codec || "?") +
          " · " + (lastHealth || "—"),
          "pur"
        );
      }

      timers.push(setTimeout(async () => {
        try {
          $("#progressStage").textContent = "Checking daily usage…";
          const auth = await api("/api/authorize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (isDead()) throw new Error("aborted");
          if (!auth || !auth.ok || !auth.json || auth.json.ok !== true) {
            const msg = (auth && auth.json && auth.json.error) || "Authorization failed — try again.";
            procLog("Blocked: " + msg, "err");
            $("#procStatus").textContent = "Error";
            $("#progressStage").textContent = msg;
            timers.push(setTimeout(() => resetUI(), 5000));
            return;
          }
          const tk = auth.json;
          $("#progressFill").style.width = "1%";
          $("#progressPct").textContent = "1%";
          procLog("Auth: OK [premium]", "ok");

          $("#progressStage").textContent = "Optimizing…";
          procLog("Connecting to the optimizer service…", "pur");
          const _hevcUpload = await clientDetectHEVC(file);
          lastFileHevc = !!_hevcUpload;
          const fd = new FormData();
          if (_hevcUpload) {
            fd.append("vhevc", "1");
            procLog("H265 (HEVC) detected. Optimising now. Tip: H.264 files are recommended.", "ok");
          }
          const _h264Box = document.getElementById("h264Convert");
          if (_h264Box && _h264Box.checked) {
            fd.append("h264", "1");
            procLog("H265 (HEVC) → H.264 conversion requested.", "ok");
          }
          try {
            if (localStorage.getItem("john_quality_engine") === "ffmpeg" || localStorage.getItem("rtx_engine") === "ffmpeg") fd.append("engine", "ffmpeg");
          } catch (e) {}
          fd.append("patcher", "main");
          fd.append("file", file, file.name);
          const PATCH_API = (window.RTX && window.RTX.PATCH_API_URL) || "";
          const patchUrl = PATCH_API
            ? PATCH_API.replace(/\/+$/, "") + "/api/patch-rtx"
            : "/api/patch-rtx";
          const tkId = String(tk.token || "").split(":")[1] || "";
          const safeName = file.name.replace(/[^\x20-\x7E]/g, "_");

          async function resumeDownload(id) {
            try {
              return await new Promise((resolve, reject) => {
                const gx = new XMLHttpRequest();
                gx.open("GET", patchUrl + "/job/" + id);
                gx.responseType = "blob";
                gx.setRequestHeader("X-Patch-Token", tk.token);
                if (tkId) gx.setRequestHeader("X-Discord-Id", tkId);
                gx.onload = () => {
                  if (gx.status >= 200 && gx.status < 300) resolve(gx.response);
                  else reject(new Error("resume failed"));
                };
                gx.onerror = () => reject(new Error("resume network"));
                gx.onabort = () => reject(new Error("resume aborted"));
                gx.onprogress = (ev) => {
                  if (ev.lengthComputable && ev.total > 0) {
                    const pct = dlProgress(ev.loaded, ev.total);
                    $("#progressFill").style.width = pct + "%";
                    $("#progressPct").textContent = pct.toFixed(1) + "%";
                    $("#progressStage").textContent = "Downloading " + fmtBytes(ev.loaded) + " / " + fmtBytes(ev.total);
                  }
                };
                if (!finalizeTimer) startFinalizeAnim();
                gx.send();
              });
            } catch (e) { return null; }
          }

          const RTX_PART_TRIES = 6;
          const RTX_PART_STALL_MS = 30000;
          function rtxEngineFfmpeg() {
    try { return localStorage.getItem("john_quality_engine") === "ffmpeg" || localStorage.getItem("rtx_engine") === "ffmpeg"; } catch (e) { return false; }
          }
          function rtxWantsH264() {
            const b = document.getElementById("h264Convert");
            return !!(b && b.checked);
          }
          function rtxMintToken() {
            return api("/api/authorize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }).then(function (r) {
              const d = r && r.json;
              return d && d.ok && d.token ? d.token : null;
            }).catch(function () { return null; });
          }
          const SLOT_CHECK_TIMEOUT_MS = 12000;
          const SLOT_CHECK_TRIES = 3;
          function rtxSlotAttempt(token, discordId, jobKey) {
            return new Promise(function (resolve) {
              try {
                const x = new XMLHttpRequest();
                x.open("POST", patchUrl + "/local-use");
                x.setRequestHeader("X-Patch-Token", token);
                if (discordId) x.setRequestHeader("X-Discord-Id", discordId);
                if (jobKey) x.setRequestHeader("X-Job-Key", jobKey);
                x.setRequestHeader("Content-Type", "application/json");
                x.onload = function () {
                  let d = {};
                  try { d = JSON.parse(x.responseText || "{}"); } catch (e) {}
                  if (x.status >= 200 && x.status < 300 && d.ok) {
                    window.__rtxCounted = true;
                    return resolve({ ok: true, used: d.used, limit: d.limit === undefined ? null : d.limit });
                  }
                  resolve({ ok: true, used: null, limit: null });
                };
                x.onerror = function () { resolve({ ok: true, used: null, limit: null }); };
                x.ontimeout = function () { resolve({ ok: true, used: null, limit: null }); };
                x.timeout = SLOT_CHECK_TIMEOUT_MS;
                x.send("{}");
              } catch (e) { resolve({ ok: true, used: null, limit: null }); }
            });
          }
          function rtxLocalUse(token, discordId, jobKey) {
            return (async function () {
              for (let a = 1; a <= SLOT_CHECK_TRIES; a++) {
                const r = await rtxSlotAttempt(token, discordId, jobKey);
                if (r && r.ok) return r;
                if (a < SLOT_CHECK_TRIES) await new Promise(function (z) { setTimeout(z, 800 * a); });
              }
              return { ok: true, used: null, limit: null };
            })();
          }
          function rtxLocalRelease(token, discordId) {
            window.__rtxCounted = false;
            try {
              const x = new XMLHttpRequest();
              x.open("POST", patchUrl + "/local-release");
              x.setRequestHeader("X-Patch-Token", token);
              if (discordId) x.setRequestHeader("X-Discord-Id", discordId);
              x.setRequestHeader("Content-Type", "application/json");
              x.send("{}");
            } catch (e) {}
          }

          function rtxPart(id, token, offset, total, blob, first) {
            return new Promise(function (resolve, reject) {
              const x = new XMLHttpRequest();
              activeXhr = x;
              x.open("POST", patchUrl + "/up/" + id);
              x.setRequestHeader("X-Patch-Token", token);
              if (tkId) x.setRequestHeader("X-Discord-Id", tkId);
              x.setRequestHeader("X-Upload-Offset", String(offset));
              x.setRequestHeader("X-Upload-Size", String(total));
              x.setRequestHeader("X-Filename", safeName);
              x.setRequestHeader("Content-Type", "application/octet-stream");
              if (first && rtxWantsH264()) x.setRequestHeader("X-Convert-H264", "1");
              let stallTimer = null;
              function disarmStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
              function armStall() {
                disarmStall();
                stallTimer = setTimeout(function () { try { x.abort(); } catch (e) {} }, RTX_PART_STALL_MS);
              }
              x.upload.onprogress = function (ev) {
                armStall();
                if (!ev.lengthComputable) return;
                const sent = Math.min(total, offset + ev.loaded);
                const pct = Math.min(UPLOAD_MAX, 1 + Math.round((sent / total) * (UPLOAD_MAX - 1)));
                $("#progressFill").style.width = pct + "%";
                $("#progressPct").textContent = Math.round(pct) + "%";
                $("#progressStage").textContent = "Uploading " + fmtBytes(sent) + " / " + fmtBytes(total);
              };
              x.onload = function () {
                disarmStall();
                activeXhr = null;
                if (x.status >= 200 && x.status < 300) {
                  let d = {};
                  try { d = JSON.parse(x.responseText || "{}"); } catch (e) {}
                  resolve(d);
                  return;
                }
                if (x.status === 401) { reject({ tokenStale: true, status: 401 }); return; }
                let d = {};
                try { d = JSON.parse(x.responseText || "{}"); } catch (e) {}
                reject({ status: x.status, text: d.error || ("HTTP " + x.status), received: d.received });
              };
              x.onerror = function () { disarmStall(); activeXhr = null; reject({ dropped: true }); };
              x.onabort = function () { disarmStall(); activeXhr = null; reject({ dropped: true }); };
              x.send(blob);
              armStall();
            });
          }
          function rtxOffsetOnServer(id, token) {
            return new Promise(function (resolve) {
              const x = new XMLHttpRequest();
              x.open("GET", patchUrl + "/up/" + id);
              x.setRequestHeader("X-Patch-Token", token);
              if (tkId) x.setRequestHeader("X-Discord-Id", tkId);
              x.onload = function () {
                try {
                  const d = JSON.parse(x.responseText || "{}");
                  resolve(typeof d.received === "number" ? d.received : null);
                } catch (e) { resolve(null); }
              };
              x.onerror = function () { resolve(null); };
              x.onabort = function () { resolve(null); };
              x.send();
            });
          }
          const RTX_PART_SIZE_P = 8 * 1024 * 1024;
          const RTX_PARTS_IN_FLIGHT = 3;
          function rtxPartParallel(id, token, offset, total, partSize, blob, isNew, isFresh, onLive) {
            return new Promise(function (resolve, reject) {
              const x = new XMLHttpRequest();
              activeXhr = x;
              x.open("POST", patchUrl + "/up/" + id);
              x.setRequestHeader("X-Patch-Token", token);
              if (tkId) x.setRequestHeader("X-Discord-Id", tkId);
              x.setRequestHeader("X-Upload-Offset", String(offset));
              x.setRequestHeader("X-Upload-Size", String(total));
              x.setRequestHeader("X-Upload-Part-Size", String(partSize));
              if (isFresh) x.setRequestHeader("X-Upload-New", "1");
              x.setRequestHeader("X-Filename", safeName);
              x.setRequestHeader("Content-Type", "application/octet-stream");
              if (isNew && rtxWantsH264()) x.setRequestHeader("X-Convert-H264", "1");
              let stallTimer = null;
              function disarmStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
              function armStall() {
                disarmStall();
                stallTimer = setTimeout(function () { try { x.abort(); } catch (e) {} }, RTX_PART_STALL_MS);
              }
              x.upload.onprogress = function (ev) {
                armStall();
                if (ev.lengthComputable) onLive(offset, ev.loaded);
              };
              x.onload = function () {
                disarmStall();
                activeXhr = null;
                onLive(offset, 0);
                let d = {};
                try { d = JSON.parse(x.responseText || "{}"); } catch (e) {}
                if (x.status >= 200 && x.status < 300) { resolve(d); return; }
                if (x.status === 401) { reject({ tokenStale: true, status: 401 }); return; }
                reject({ status: x.status, text: d.error || ("HTTP " + x.status), received: d.received });
              };
              x.onerror = function () { disarmStall(); activeXhr = null; onLive(offset, 0); reject({ dropped: true }); };
              x.onabort = function () { disarmStall(); activeXhr = null; onLive(offset, 0); reject({ dropped: true }); };
              x.send(blob);
              armStall();
            });
          }
          function rtxServerParts(id, token) {
            return new Promise(function (resolve) {
              const x = new XMLHttpRequest();
              x.open("GET", patchUrl + "/up/" + id);
              x.setRequestHeader("X-Patch-Token", token);
              if (tkId) x.setRequestHeader("X-Discord-Id", tkId);
              x.onload = function () {
                try {
                  const d = JSON.parse(x.responseText || "{}");
                  if (!d || d.ok !== true) { resolve(null); return; }
                  resolve({
                    received: d.received,
                    size: d.size,
                    partSize: d.partSize || 0,
                    parts: Array.isArray(d.parts) ? d.parts : null,
                  });
                } catch (e) { resolve(null); }
              };
              x.onerror = function () { resolve(null); };
              x.onabort = function () { resolve(null); };
              x.send();
            });
          }
          async function rtxUploadParallel() {
            const id = (function () {
              const a = new Uint8Array(8);
              (window.crypto || window.msCrypto).getRandomValues(a);
              let s = "";
              for (let i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2);
              return s;
            })();
            let token = tk.token;
            const total = file.size;
            const partSize = RTX_PART_SIZE_P;
            const totalParts = Math.ceil(total / partSize);
            const NO_PROGRESS_BUDGET_MS = 60000;
            let lastProgressAt = Date.now();
            const doneSet = new Set();
            let fresh = true;
            let workers = RTX_PARTS_IN_FLIGHT;
            let stalling = 0;

            const srv = await rtxServerParts(id, token);
            if (srv && srv.parts && srv.partSize === partSize) {
              for (const i of srv.parts) if (i >= 0 && i < totalParts) doneSet.add(i);
              if (doneSet.size > 0) fresh = false;
            }

            const live = new Map();
            let highWater = 0;
            function paint() {
              let sent = 0;
              doneSet.forEach(function (i) { sent += Math.min(partSize, total - i * partSize); });
              live.forEach(function (v) { sent += v; });
              if (sent > highWater) highWater = sent;
              const pct = Math.min(UPLOAD_MAX, 1 + Math.round((highWater / total) * (UPLOAD_MAX - 1)));
              $("#progressFill").style.width = pct + "%";
              $("#progressPct").textContent = Math.round(pct) + "%";
              $("#progressStage").textContent = "Uploading " + fmtBytes(highWater) + " / " + fmtBytes(total);
            }
            function onLive(offset, loaded) { live.set(offset, loaded); paint(); }

            async function sendOne(index) {
              const offset = index * partSize;
              let tries = 0;
              while (true) {
                if (isDead()) throw new Error("aborted");
                const blob = file.slice(offset, Math.min(offset + partSize, total));
                tries++;
                try {
                  const d = await rtxPartParallel(id, token, offset, total, partSize, blob,
                    doneSet.size === 0 && index === 0, fresh, onLive);
                  if (!(d && typeof d.part === "number")) {
                    const e = new Error("no-part-mode");
                    e.noPartMode = true;
                    throw e;
                  }
                  live.delete(offset);
                  doneSet.add(index);
                  lastProgressAt = Date.now();
                  paint();
                  return;
                } catch (e) {
                  live.delete(offset);
                  paint();
                  if (isDead()) throw new Error("aborted");
                  if (e && e.message === "aborted") throw e;
                  if (e && e.noPartMode) throw e;
                  if (e && e.tokenStale) {
                    const freshTok = await rtxMintToken();
                    if (freshTok) { token = freshTok; tries = 0; continue; }
                  }
                  if (e && e.status && e.status !== 409 && !e.dropped) {
                    const err = new Error(e.text || ("Upload refused (" + e.status + ")"));
                    err.status = e.status;
                    err.partsDone = doneSet.size;
                    throw err;
                  }
                  if (Date.now() - lastProgressAt > NO_PROGRESS_BUDGET_MS) {
                    const err = new Error("Your connection was down for " +
                      Math.round(NO_PROGRESS_BUDGET_MS / 1000) +
                      "s and the upload could not move. Nothing was used - try again when the signal is stronger.");
                    err.partsDone = doneSet.size;
                    throw err;
                  }
                  if (tries >= RTX_PART_TRIES) {
                    const err = new Error("Your connection keeps dropping (" +
                      fmtBytes(doneSet.size * partSize) + " of " + fmtBytes(total) +
                      " sent). Nothing was used up — press again and it carries on from where it stopped.");
                    err.partsDone = doneSet.size;
                    throw err;
                  }
                  stalling++;
                  if (stalling >= 2 && workers > 1) { workers--; stalling = 0; }
                  procLog("Connection dropped at " + fmtBytes(doneSet.size * partSize) + " of " + fmtBytes(total) + " — resuming from there…", "warn");
                  $("#progressStage").textContent = "Reconnecting… " + fmtBytes(doneSet.size * partSize) + " / " + fmtBytes(total);
                  await new Promise(function (r) { setTimeout(r, 1200 * tries); });
                }
              }
            }

            const pending = [];
            for (let i = 0; i < totalParts; i++) if (!doneSet.has(i)) pending.push(i);
            paint();

            let fatal = null;
            const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            async function worker(slot) {
              while (!fatal) {
                if (isDead()) { fatal = fatal || new Error("aborted"); return; }
                if (slot >= workers) {
                  if (pending.length === 0) return;
                  await sleep(200);
                  continue;
                }
                const next = pending.shift();
                if (next === undefined) return;
                try { await sendOne(next); }
                catch (e) { fatal = fatal || e; return; }
              }
            }
            const pool = [];
            const slots = Math.max(1, Math.min(RTX_PARTS_IN_FLIGHT, pending.length));
            for (let w = 0; w < slots; w++) pool.push(worker(w));
            await Promise.all(pool);
            if (fatal) throw fatal;

            const finTok = await rtxMintToken();
            return await rtxFinish(id, finTok || token);
          }
          function rtxFetchJob(id, token) {
            return new Promise(function (resolve) {
              let tries = 0;
              const attempt = function () {
                tries++;
                const x = new XMLHttpRequest();
                x.open("GET", patchUrl + "/job/" + id);
                x.responseType = "blob";
                x.setRequestHeader("X-Patch-Token", token);
                if (tkId) x.setRequestHeader("X-Discord-Id", tkId);
                x.onload = function () {
                  if (x.status >= 200 && x.status < 300 && x.response && x.response.size) {
                    resolve(x.response);
                    return;
                  }
                  if ((x.status === 404 || x.status === 410) && tries < 120) {
                    setTimeout(attempt, 5000);
                    return;
                  }
                  resolve(null);
                };
                x.onerror = function () {
                  if (tries < 120) { setTimeout(attempt, 5000); return; }
                  resolve(null);
                };
                x.send();
              };
              attempt();
            });
          }

          function rtxFetchFinished(token, match) {
            return new Promise(function (resolve) {
              const WINDOW = 2 * 1024 * 1024;
              const parts = [];
              let total = 0;
              const qs = (match && (match.name || match.size))
                ? "?nm=" + encodeURIComponent(match.name || "") + "&sz=" + encodeURIComponent(match.size || 0)
                : "";

              const get = function (start, end, cb) {
                const x = new XMLHttpRequest();
                x.open("GET", patchUrl + "/latest-job" + qs);
                x.responseType = "blob";
                x.setRequestHeader("X-Patch-Token", token);
                if (tkId) x.setRequestHeader("X-Discord-Id", tkId);
                if (typeof start === "number") {
                  x.setRequestHeader("Range", "bytes=" + start + "-" + end);
                }
                x.onload = function () {
                  if (x.status >= 200 && x.status < 300) {
                    const jh = x.getResponseHeader("X-Job-Id");
                    if (jh) window.__rtxJob = { id: jh, token: token };
                    cb(null, x);
                    return;
                  }
                  cb(x.status, null);
                };
                x.onerror = function () { cb("network", null); };
                x.send();
              };

              const windowed = function () {
                let start = 0;
                let fails = 0;
                const step = function () {
                  get(start, start + WINDOW - 1, function (err, x) {
                    if (err === 404 || err === 410 || err === 429) { resolve(null); return; }
                    if (err || !x || !x.response) {
                      fails++;
                      if (fails > 6) { resolve(null); return; }
                      setTimeout(step, 800 * fails);
                      return;
                    }
                    const b = x.response;
                    if (!total) {
                      const cr = x.getResponseHeader("Content-Range");
                      const mm = cr && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr.trim());
                      total = mm ? Number(mm[3]) : b.size;
                    }
                    if (!b.size) {
                      fails++;
                      if (fails > 6) { resolve(null); return; }
                      setTimeout(step, 800 * fails);
                      return;
                    }
                    parts.push(b);
                    start += b.size;
                    fails = 0;
                    if (start >= total) { resolve(new Blob(parts)); return; }
                    step();
                  });
                };
                step();
              };

              const once = function (attempt) {
                get(undefined, undefined, function (err, x) {
                  if (err === 404 || err === 410) { resolve(null); return; }
                  if (!err && x && x.response && x.response.size) { resolve(x.response); return; }
                  if (attempt < 3) { setTimeout(function () { once(attempt + 1); }, 2000 * attempt); return; }
                  windowed();
                });
              };

              once(1);
            });
          }
          function rtxFinish(id, token, _retried) {
            return new Promise(function (resolve, reject) {
              const x = new XMLHttpRequest();
              activeXhr = x;
              x.open("POST", patchUrl + "/up/" + id + "/finish");
              x.responseType = "blob";
              x.setRequestHeader("X-Patch-Token", token);
              if (tkId) x.setRequestHeader("X-Discord-Id", tkId);
              x.setRequestHeader("Content-Type", "application/json");
              if (rtxEngineFfmpeg()) x.setRequestHeader("X-Engine", "ffmpeg");
              if (rtxWantsH264()) x.setRequestHeader("X-Convert-H264", "1");
              x.upload.onload = function () {
                $("#progressStage").textContent = "Optimizing…";
                startFinalizeAnim();
              };
              x.onprogress = function (ev) {
                if (!(ev.lengthComputable && ev.total > 0)) return;
                const pct = dlProgress(ev.loaded, ev.total);
                $("#progressFill").style.width = pct + "%";
                $("#progressPct").textContent = pct.toFixed(1) + "%";
                $("#progressStage").textContent = "Downloading " + fmtBytes(ev.loaded) + " / " + fmtBytes(ev.total);
              };
              x.onload = function () {
                activeXhr = null;
                if (x.status >= 200 && x.status < 300) {
                  window.__rtxCounted = true;
                  resolve(x.response); return;
                }
                if (x.status === 401 && !_retried) {
                  rtxMintToken().then(function (fresh) {
                    if (!fresh) { reject(new Error("Patch token expired.")); return; }
                    rtxFinish(id, fresh, true).then(resolve, reject);
                  }).catch(function () { reject(new Error("Patch token expired.")); });
                  return;
                }
                if (x.status === 524 || x.status === 502 || x.status === 503 || x.status === 504) {
                  stopFinalizeAnim();
                  procLog("The edge timed out - fetching your finished file (no re-upload, no extra quota)...", "warn");
                  $("#progressStage").textContent = "Edge timed out - fetching your finished file...";
                  rtxFetchJob(id, token).then(function (b) {
                    if (b) { resolve(b); return; }
                    reject(new Error("Your file was patched, but it could not be collected yet. Press again in a moment - it will be fetched without re-uploading or using another patch."));
                  });
                  return;
                }

                const fail = function (msg) {
                  const err = new Error(msg || ("Optimization failed (" + x.status + ")"));
                  err.status = x.status;
                  reject(err);
                };
                const body = x.response;
                if (body instanceof Blob) {
                  body.text().then(function (t) {
                    let msg = "", code = "";
                    try { const j = JSON.parse(t); if (j && j.error) msg = j.error; if (j && j.code) code = j.code; } catch (e) {}
                    if (code === "encode_locally") { resolve({ __rtxLocal: true }); return; }
                    fail(msg);
                  }).catch(function () { fail(); });
                  return;
                }
                fail();
              };
              x.onerror = function () {
                activeXhr = null;
                stopFinalizeAnim();
                procLog("The download dropped — fetching your finished file again (no re-upload, no extra quota)…", "warn");
                $("#progressStage").textContent = "Connection dropped — refetching the finished file…";
                rtxFetchFinished(token).then(function (b) {
                  if (b) { resolve(b); return; }
                  reject(new Error("Your file was patched, but the connection to the optimizer dropped while it was coming back. Press again in a moment — it will be fetched without re-uploading or using another patch."));
                });
              };
              x.onabort = function () { activeXhr = null; reject(new Error("aborted")); };
              x.send("{}");
            });
          }
          async function rtxUploadResumable() {
            const id = (function () {
              const a = new Uint8Array(8);
              (window.crypto || window.msCrypto).getRandomValues(a);
              let s = "";
              for (let i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2);
              return s;
            })();
            let token = tk.token;
            let offset = 0;
            let parts = 0;
            const total = file.size;
            const RTX_NO_PROGRESS_BUDGET_MS = 60000;
            let lastProgressAt = Date.now();
            while (offset < total) {
              const RTX_PART_MAX = 8 * 1024 * 1024;
              let done = false;
              let tries = 0;
              while (!done) {
                const blob = file.slice(offset, Math.min(offset + RTX_PART_MAX, total));
                tries++;
                try {
                  const d = await rtxPart(id, token, offset, total, blob, parts === 0);
                  const got = d && typeof d.received === "number" ? d.received : offset + blob.size;
                  offset = got > offset ? got : offset + blob.size;
                  parts++;
                  done = true;
                  lastProgressAt = Date.now();
                } catch (e) {
                  if (isDead()) throw new Error("aborted");
                  if (e && e.message === "aborted") throw e;
                  if (e && e.tokenStale) {
                    const fresh = await rtxMintToken();
                    if (fresh) { token = fresh; tries = 0; continue; }
                  }
                  if (e && e.status && e.status !== 409 && !e.dropped) {
                    const err = new Error(e.text || ("Upload refused (" + e.status + ")"));
                    err.status = e.status;
                    err.partsDone = parts;
                    throw err;
                  }
                  if (e && typeof e.received === "number") offset = e.received;
                  else {
                    const truth = await rtxOffsetOnServer(id, token);
                    if (typeof truth === "number") offset = truth;
                  }
                  if (Date.now() - lastProgressAt > RTX_NO_PROGRESS_BUDGET_MS) {
                    const err = new Error("Your connection was down for " +
                      Math.round(RTX_NO_PROGRESS_BUDGET_MS / 1000) +
                      "s and the upload could not move. Nothing was used - try again when the signal is stronger.");
                    err.partsDone = parts;
                    throw err;
                  }
                  if (tries >= RTX_PART_TRIES) {
                    const err = new Error("Your connection keeps dropping (" + fmtBytes(offset) + " of " + fmtBytes(total) + " sent). Nothing was used up — press again and it carries on from where it stopped.");
                    err.partsDone = parts;
                    throw err;
                  }
                  procLog("Connection dropped at " + fmtBytes(offset) + " of " + fmtBytes(total) + " — resuming from there…", "warn");
                  $("#progressStage").textContent = "Reconnecting… " + fmtBytes(offset) + " / " + fmtBytes(total);
                  await new Promise(function (r) { setTimeout(r, 1200 * tries); });
                }
              }
            }
            const freshTok = await rtxMintToken();
            return await rtxFinish(id, freshTok || token);
          }

          let outBuf = null;
          let jobId = null;

          try {
            if (isDead()) throw new Error("aborted");
            const existing = await rtxFetchFinished(tk.token, { name: safeName, size: file.size });
            if (existing && existing.size) {
               $("#progressStage").textContent = "Fetching your finished video…";
               outBuf = existing;
               window.__rtxCounted = true;
            }
          } catch (e) {
            if (e && e.message === "aborted") throw e;
          }

          let rtxLocalOn = true;
          try { localStorage.removeItem("rtxLocal"); } catch (e) {}
            const _rtxConvert = rtxWantsH264();

            if (outBuf === null && _rtxConvert && window.RTXLocal) {
              let _localSlot = false;
              try {
                const _slot2 = await rtxLocalUse(tk.token, tkId, jobKey);
                _localSlot = true;
                if (!window.RTXLocalConvert) throw new Error("the local encoder is unavailable");
                window.__rtxJobAction = "H.265 to H.264 encode (device)";
              rtxCeilStage(79);
              const _conv = await window.RTXLocalConvert.encode(
                  file,
                  function (m) { procLog(m, "mut"); },
                  function (p) { if (isDead()) return; rtxBar(20 + Math.round(p * 55), "Converting to H.264…");
                  }
                );
                rtxBar(80, "Optimizing…");
                const _lr2 = await window.RTXLocal.patch(await rtxRemux(_conv, file.name, 82, 88), function () {});
                outBuf = _lr2 && _lr2.blob && _lr2.blob.size ? _lr2.blob : null;
                if (!outBuf) throw new Error("local patch produced nothing");
                try { window.__rtxOutBlob = outBuf; } catch (e3) {}
                (function revealLocalButtons() {
                  var n = 0;
                  var t = setInterval(function () {
                    n++;
                    try {
                      var d = document.getElementById("dlBtn");
                      var a = document.getElementById("againBtn");
                      if (d && d.style.display === "none") { d.style.display = ""; d.disabled = false; }
                      if (a && a.style.display === "none") a.style.display = "";
                    } catch (e3) {}
                    if (n >= 24) clearInterval(t);
                  }, 250);
                })();
              } catch (e2) {
                if (_localSlot) { try { rtxLocalRelease(tk.token, tkId); } catch (e3) {} }
                procLog("Local encode failed: " + (e2 && e2.message ? e2.message : e2), "err");
                $("#procStatus").textContent = "Encoding failed";
                $("#progressStage").textContent = (e2 && e2.message ? e2.message : "Could not encode this file.");
                if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
                file = null; input.value = "";
                timers.push(setTimeout(() => resetUI(), 8000));
                return;
              }
            }

            if (outBuf === null && rtxLocalOn && !_rtxConvert) {
            if (!window.RTXLocal) {
              throw new Error("The in-browser optimizer did not load. Reload the page and try again - your video was not uploaded anywhere.");
            }
            let _slotHeld = false;
            try {
              const _slot = await rtxLocalUse(tk.token, tkId, jobKey);
              _slotHeld = true;
              const _lr = await window.RTXLocal.patch(await rtxRemux(file, file.name), function () {});
              outBuf = _lr && _lr.blob && _lr.blob.size ? _lr.blob : null;
              if (!outBuf) throw new Error("local patch produced nothing");
              try { window.__rtxOutBlob = outBuf; } catch (e) {}
              (function revealLocalButtons() {
                var n = 0;
                var t = setInterval(function () {
                  n++;
                  try {
                    var d = document.getElementById("dlBtn");
                    var a = document.getElementById("againBtn");
                    if (d && d.style.display === "none") { d.style.display = ""; d.disabled = false; }
                    if (a && a.style.display === "none") a.style.display = "";
                  } catch (e) {}
                  if (n >= 24) clearInterval(t);
                }, 250);
              })();
            } catch (e) {
              if (e && e.message === "aborted") {
                if (_slotHeld) { try { rtxLocalRelease(tk.token, tkId); } catch (e2) {} }
                throw e;
              }
              const _refusal = String((e && e.message) || e);
              if (/No audio track|No video track/i.test(_refusal)) {
                if (_slotHeld) { try { rtxLocalRelease(tk.token, tkId); } catch (e3) {} }
                procLog("Cannot optimize this file: " + _refusal, "err");
                $("#procStatus").textContent = "Cannot optimize this file";
                $("#progressStage").textContent = /No audio track/i.test(_refusal)
                  ? "This video has no sound track, so it cannot be optimized."
                  : "This video has no video track, so it cannot be optimized.";
                if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
                file = null; input.value = "";
                timers.push(setTimeout(() => resetUI(), 8000));
                return;
              }
              try {
                if (!window.RTXLocalConvert) throw new Error("the local encoder is unavailable");
                window.__rtxJobAction = "H.265 to H.264 encode (device)";
                rtxCeilStage(79);
                const _rconv = await window.RTXLocalConvert.encode(
                  file,
                  function (m) { procLog(m, "mut"); },
                  function (p) { if (isDead()) return; rtxBar(20 + Math.round(p * 55), "Converting to H.264…");
                  }
                );
                rtxBar(80, "Optimizing…");
                let _rlr;
                try {
                _rlr = await window.RTXLocal.patch(await rtxItsScale(_rconv, 80, 88), function () {});
                } catch (ePatch) {
                  throw new Error("the encode finished, but the encoded file could not be patched: "
                    + ((ePatch && ePatch.message) || ePatch));
                }
                outBuf = _rlr && _rlr.blob && _rlr.blob.size ? _rlr.blob : null;
                if (!outBuf) throw new Error("the local encoder produced nothing");
                try { window.__rtxOutBlob = outBuf; } catch (e3) {}
                (function revealLocalButtons() {
                  var n = 0;
                  var t = setInterval(function () {
                    n++;
                    try {
                      var d = document.getElementById("dlBtn");
                      var a = document.getElementById("againBtn");
                      if (d && d.style.display === "none") { d.style.display = ""; d.disabled = false; }
                      if (a && a.style.display === "none") a.style.display = "";
                    } catch (e3) {}
                    if (n >= 24) clearInterval(t);
                  }, 250);
                })();
              } catch (e2) {
                if (_slotHeld) { try { rtxLocalRelease(tk.token, tkId); } catch (e3) {} }
                try { console.error("[john_quality] job failed:", e2); } catch (e3) {}
                procLog("Could not finish this file on your device. Please try again.", "err");
                $("#procStatus").textContent = "Could not finish";
                $("#progressStage").textContent = "Could not finish this file on your device. Please try again.";
                if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
                file = null; input.value = "";
                timers.push(setTimeout(() => resetUI(), 8000));
                return;
              }
            }
          }

          if (outBuf === null) {
            throw new Error("This file could not be optimized on your device. Nothing was uploaded to the server.");
          }

          if (outBuf && outBuf.__rtxLocal) {
            outBuf = null;
            if (!rtxLocalOn) {
              throw new Error("This file needs re-encoding, and local encoding is switched off in this browser (local=0). Remove that flag and try again.");
            }
            if (!window.RTXLocal || !window.RTXLocalConvert) {
              throw new Error("This file needs re-encoding. Open this page in Chrome or Edge so it can be done on your device.");
            }
            let _hs = false;
            try {
              const _slot = await rtxLocalUse(tk.token, tkId, jobKey);
              _hs = true;
               window.__rtxJobAction = "H.265 to H.264 encode (device)";
              rtxCeilStage(79);
              const _conv = await window.RTXLocalConvert.encode(
                file,
                function (m) { procLog(m, "mut"); },
                 function (p) { if (isDead()) return; rtxBar(20 + Math.round(p * 55), "Converting to H.264…"); }
              );
              rtxBar(80, "Optimizing…");
              const _creep = rtxCreepStart(80);
              const _lr = await window.RTXLocal.patch(await rtxItsScale(_conv, 80, 88), function () {}).finally(function () { clearInterval(_creep); });
              outBuf = _lr && _lr.blob && _lr.blob.size ? _lr.blob : null;
              if (!outBuf) throw new Error("local patch produced nothing");
              try { window.__rtxOutBlob = outBuf; } catch (e) {}
            } catch (e2) {
              if (_hs) { try { rtxLocalRelease(tk.token, tkId); } catch (e3) {} }
              throw e2;
            }
          }

          if (!(outBuf instanceof Blob)) throw new Error("Empty response from optimizer server.");
          stopFinalizeAnim();

          $("#progressFill").style.width = "100%";
          $("#progressPct").textContent = "100%";
          $("#progressStage").textContent = "Download complete — saving your file…";
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (isDead()) throw new Error("aborted");

          window.__rtxBusy = false;
          const blob = outBuf;

          // ── RECORD THE JOB ──────────────────────────────────────────
          try {
            const _raw = String((lastScan && lastScan.codec) || "").toLowerCase();
            const _sc = /^(avc1|avc3|h264|x264)$/.test(_raw) ? "h264"
                      : /^(hvc1|hev1|hevc|h265|x265)$/.test(_raw) ? "hevc"
                      : _raw;
            const _action = window.__rtxJobAction || (_rtxConvert
              ? "H.265 to H.264 encode (device)"
              : ("Remuxed (" + (_sc === "hevc" ? "HEVC" : "H.264") + ")"));
            const _qs = new URLSearchParams({
              sizeMb: String(Math.round((blob.size / 1048576) * 100) / 100),
              codec: (_sc || "h264").slice(0, 16),
              container: "mov",
              action: _action.slice(0, 80),
              result: "ok",
            });
            await Promise.race([
              fetch("/api/patch-rtx/job-record?" + _qs.toString(), {
                method: "POST", headers: { "X-Patch-Token": tk.token },
              }).catch(function () {}),
              new Promise(function (r) { setTimeout(r, 2500); }),
            ]);
          } catch (e) {}

          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(blob);
          try { window.__rtxOutBlob = blob; } catch (e) {}
          patchedName = "john-quality-optimized-" + Math.random().toString(16).slice(2, 6) + ".mp4";
          $("#progressFill").style.width = "100%";
          $("#progressPct").textContent = "100%";
          $("#dropZoneWrap").style.display = "none";
          $("#processingView").style.display = "block";
          $("#cancelBtn").style.display = "none";
          $("#progressStage").textContent = "Optimization complete. The video has bypassed TikTok compression";
          $("#procStatus").textContent = "Done — click Download";
          procLog("Output: " + patchedName + " (" + fmtBytes(blob.size) + ")", "ok");

          var _ffmpegEngine = false;
          try { _ffmpegEngine = localStorage.getItem("john_quality_engine") === "ffmpeg" || localStorage.getItem("rtx_engine") === "ffmpeg"; } catch (e) {}
          if (_ffmpegEngine) {
            procLog("Note: Don't worry if the video lags locally. It will play smooth once uploaded to TikTok.", "warn");
          }
          window.__rtxDoneAt = Date.now();
          if (againBtn) { againBtn.style.display = ""; againBtn.textContent = AGAIN_LABEL; }
          try { dlBtn.style.display = ""; dlBtn.disabled = false; dlBtn.classList.add("pulse"); dlBtn.scrollIntoView({ behavior: "smooth", block: "center" }); }
          catch (e) {}
        } catch (e) {
          stopFinalizeAnim();
          if (isDead()) {
            procLog("Optimization cancelled.", "warn");
            window.__rtxBusy = false;
            rtxCeilStop();
            resetUI();
            return;
          }
          if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
          file = null; input.value = ""; patchedName = "";
          procLog("Error: " + ((e && e.message) || "optimization failed"), "err");
          $("#procStatus").textContent = "Error";
          window.__rtxBusy = false;
          const _rtxErrMsg = (e && e.message) || "optimization failed";

          try {
            const _eq = new URLSearchParams({
              sizeMb: (file && file.size)
                ? String(Math.round((file.size / 1048576) * 100) / 100)
                : "0",
              codec: String((lastScan && lastScan.codec) || "").toLowerCase().slice(0, 16),
              container: (function () {
                const m = String((file && file.name) || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
                return m ? m[1] : "mov";
              })(),
              action: (typeof rtxWantsH264 === "function" && rtxWantsH264())
                ? "H.265 to H.264 encode (device)"
                : "Remuxed (device)",
              result: "error",
              detail: String(_rtxErrMsg).slice(0, 200),
            });
            await Promise.race([
              fetch("/api/patch-rtx/job-record?" + _eq.toString(), {
                method: "POST", headers: { "X-Patch-Token": (tk && tk.token) || "" },
              }).catch(function () {}),
              new Promise(function (r) { setTimeout(r, 2000); }),
            ]);
          } catch (e2) {}
          let _rtxStage = _rtxErrMsg + " - try another file";
          if (/token expired/i.test(_rtxErrMsg)) {
            _rtxStage = "Session timed out - press Optimize again and it continues from where it stopped.";
          }
          $("#progressStage").textContent = _rtxStage;
          $("#cancelBtn").style.display = "none";
          dlBtn.style.display = "none"; dlBtn.disabled = true;
          if (againBtn) { againBtn.textContent = "Try Again"; againBtn.style.display = ""; }
        }
      }, 300));
    });

    $("#cancelBtn").addEventListener("click", () => {
      if (abortCtrl) abortCtrl.abort();
      if (activeXhr) activeXhr.abort();
      try { if (window.RTXLocalConvert && window.RTXLocalConvert.reset) window.RTXLocalConvert.reset(); } catch (e) {}
      window.__rtxBusy = false;
      rtxCeilStop();
      resetTimers();
      $("#procStatus").textContent = "Aborted";
      $("#progressStage").textContent = "Cancelled";
      timers.push(setTimeout(() => resetUI(), 800));
    });
    const _isAppleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const _directDownloadUrl = () => {
      const j = window.__rtxJob || {};
      const age = Date.now() - (window.__rtxDoneAt || 0);
       if (!j.id || !j.token || age > 14 * 60 * 1000) return "";
      const base = ((window.RTX && window.RTX.PATCH_API_URL) || "").replace(/\/+$/, "");
      return base + "/api/patch-rtx/job/" + encodeURIComponent(j.id) + "?t=" + encodeURIComponent(j.token);
    };
    const doDownload = () => {
      const name = patchedName || ("optimized-" + (file ? file.name.replace(/\.[^.]+$/, "") : "video") + ".mp4");

      if (_isAppleTouch) {
        const ob = window.__rtxOutBlob;
        if (ob && navigator.canShare) {
          try {
            const f = new File([ob], name, { type: ob.type || "video/mp4" });
            if (navigator.canShare({ files: [f] })) {
              navigator.share({ files: [f] }).catch(function () {});
              return;
            }
          } catch (e) {}
        }
        if (ob && objectUrl) { try { window.open(objectUrl, "_blank"); return; } catch (e) {} }
        const direct = _directDownloadUrl();
        if (!direct) return;
        const da = document.createElement("a");
        da.href = direct; da.rel = "noopener";
        document.body.appendChild(da); da.click(); da.remove();
        return;
      }

      if (!objectUrl) return;
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    };
    dlBtn.addEventListener("click", doDownload);
    $("#clearBtn").addEventListener("click", () => { file = null; input.value = ""; resetUI(); });
    if (againBtn) againBtn.addEventListener("click", () => {
      if (window.__rtx && typeof window.__rtx.resetForNewRun === "function") {
        window.__rtx.resetForNewRun();
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null; window.__rtxOutBlob = null; file = null; input.value = ""; patchedName = "";
      resetUI();
      const drop = $("#dropZoneWrap");
      if (drop) { drop.style.display = ""; drop.scrollIntoView({ behavior: "smooth", block: "center" }); }
    });
    resetUI();
  }

  /* ── ANALYTICS — TikTok Analyzer (single video, like Zilem) ── */
  function initAnalytics() {
    const input = $("#ttUrlInput"), btn = $("#ttAnalyzeBtn");
    const loading = $("#ttLoading"), errEl = $("#ttError"), res = $("#ttResult");
    if (!input || !btn) return;

    function showErr(msg) {
      loading.classList.remove("show");
      res.classList.remove("show");
      errEl.textContent = msg;
      errEl.classList.add("show");
    }
    function setBtn(analyzing) {
      btn.disabled = analyzing;
      btn.innerHTML = analyzing
        ? '<div class="tt-spinner" style="width:14px;height:14px;border-color:rgba(8,8,8,.18);border-top-color:#080808;margin:0;"></div>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Analyze';
    }

    async function analyze() {
      const url = input.value.trim();
      if (!url) { showErr("Paste a TikTok URL first."); return; }
      if (!url.includes("tiktok.com")) { showErr("That doesn't look like a TikTok URL."); return; }
      setBtn(true);
      loading.classList.add("show");
      errEl.classList.remove("show");
      res.classList.remove("show");
      const post = (payload) => api("/api/tiktok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      let d = null, errMsg = "", status = 0, settled = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await post({ url });
        if (!r || !r.json) { status = 0; errMsg = ""; break; }
        status = r.status;
        d = r.json;
        if (d.error || !r.ok) { errMsg = d.error || ("HTTP " + r.status); break; }
        settled = d;
        if (d.engine_verified !== false) break;
        if (attempt === 0) await new Promise((done) => setTimeout(done, 1500));
      }

      loading.classList.remove("show");
      setBtn(false);
      if (settled) { render(settled); return; }
      if (errMsg) { showErr("Error: " + errMsg); return; }
      showErr("Server unreachable — start the server for live analysis.");
    }

    function render(d) {
      const note = $("#ttDemoNote");
      if (d._demo) {
        note.style.display = "";
        note.innerHTML = "<i></i>DEMO DATA — " + esc(d._reason || "live source unavailable");
      } else {
        note.style.display = "none";
      }

      const avatar = $("#ttAvatar");
      if (d.avatar) { avatar.src = d.avatar; avatar.style.display = ""; }
      else avatar.style.display = "none";
      $("#ttAuthorName").textContent = d.nickname || d.author || "—";
      $("#ttHandle").textContent = d.author ? "@" + d.author : "—";
      const verEl = $("#ttVerified");
      verEl.style.display = d.verified ? "inline-flex" : "none";
      const badge = $("#ttAccountBadge");
      badge.className = "tt-account-badge " + (d.account_status === "private" ? "private" : "public");
      badge.textContent = d.status || (d.account_status === "private" ? "PRIVATE" : "PUBLIC");
      $("#ttRegion").textContent = d.sigi_region || d.region || "";

      $("#ttDuration").textContent = d.duration || "—";
      const setMeta = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      setMeta("ttCodec", d.codec || "—");
      setMeta("ttShadowBan", (d.shadow_ban === undefined || d.shadow_ban === null) ? "—" : String(d.shadow_ban));
      $("#ttUploadedAt").textContent = d.uploaded_at || "—";

      $("#ttTitle").textContent = d.title || "—";
      $("#ttHashtags").textContent = d.hashtags || "";

      const catEl = $("#ttCategories");
      if (catEl) {
        const cats = Array.isArray(d.categories) ? d.categories : [];
        if (cats.length) {
          catEl.innerHTML = cats.map(c => '<span class="tt-cat-chip">' + c + "</span>").join("");
          catEl.style.display = "flex";
        } else {
          catEl.innerHTML = "";
          catEl.style.display = "none";
        }
      }

      const s = d.stats || {};
      $("#st-views").textContent = s.views || "—";
      $("#st-likes").textContent = s.likes || "—";
      $("#st-comments").textContent = s.comments || "—";
      $("#st-shares").textContent = s.shares || "—";

      $("#tech-res").textContent = d.web_quality || d.resolution || "—";
      $("#tech-fps").textContent = d.fps
        ? d.fps + " fps" + (d.fps_note ? " " + String(d.fps_note).toLowerCase() : "")
        : "—";
      $("#tech-engine").textContent = d.engine || "—";
      const bitrateEl = $("#tech-bitrate");
      if (bitrateEl) {
        const br = d.top_bitrate;
        bitrateEl.textContent = br != null ? (Number(br) >= 1 ? Number(br).toFixed(1) + " Mbps" : (Number(br) * 1000).toFixed(0) + " Kbps") : "—";
      }
      $("#tech-size").textContent = d.file_size_mb ? d.file_size_mb + " MB" : "—";
      const statusEl = $("#tech-status");
      const isPrivate = d.account_status === "private";
      statusEl.textContent = isPrivate ? "Private" : "Public";
      statusEl.style.color = isPrivate ? "var(--red)" : "var(--green)";

      const dl = $("#ttVideoBtn");
      const dlUrl = d.download_url || d.video_url;
      if (dlUrl) {
        dl.href = dlUrl;
        const _shortSide = function (s) {
          const m = String(s || "").match(/^(\d+)x(\d+)$/);
          return m ? Math.min(parseInt(m[1], 10), parseInt(m[2], 10)) : 0;
        };
        const _dlSide = _shortSide(d.download_dimensions);
        const _upSide = _shortSide(d.original_dimensions);
        const _dlCapped = _dlSide > 0 && _upSide > 0 && _dlSide < _upSide;
        const _dlSuffix = String(d.download_source || "") === "original"
          ? " \u00b7 original"
          : (_dlCapped ? " \u00b7 highest available" : "");
        const dlq = d.download_quality
          ? " (" + String(d.download_quality).toUpperCase() + _dlSuffix + ")"
          : "";
        if (dl.lastChild && dl.lastChild.nodeType === 3) {
          dl.lastChild.nodeValue = " Download HD Video" + dlq + " ";
        }
        dl.style.display = "flex";
      } else dl.style.display = "none";

      res.classList.add("show");
    }

    btn.addEventListener("click", analyze);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });
  }

  /* ── ADMIN (works on local server AND Vercel) ══════════════ */
  let admPage = 1, admPer = 50;
  function initAdmin() {
    const form = $("#admin-login-form"), panel = $("#admin-panel");
    function showPanel() {
      if (form) form.style.display = "none";
      if (panel) panel.style.display = "";
      initJobsPanel();
      loadUsers();
      loadJobs();
    }
    async function tryLoadUsers() {
      const r = await api("/api/admin/users");
      return !!(r && r.ok);
    }
    tryLoadUsers().then((ok) => { if (ok) showPanel(); else if (form) form.style.display = ""; });

    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await api("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: $("#admin-secret").value }) });
      if (r && r.ok) showPanel();
      else { const err = $("#admin-error"); if (err) err.textContent = "Invalid admin secret"; }
    });
    const lo = $("#admin-logout"), rf = $("#admin-refresh");
    if (lo) lo.addEventListener("click", async () => { await api("/api/admin/logout", { method: "POST" }); location.reload(); });
    if (rf) rf.addEventListener("click", loadUsers);
    const si = $("#admin-search");
    if (si) {
      let t = null;
      si.addEventListener("input", () => { clearTimeout(t); admPage = 1; t = setTimeout(loadUsers, 300); });
    }
    const ra = $("#admin-reset-all");
    if (ra) ra.addEventListener("click", async () => {
      if (!confirm("Reset usage for ALL users? This clears everyone's daily + patcher counters.")) return;
      ra.disabled = true;
      const label = ra.textContent;
      ra.textContent = "Resetting\u2026";
      const r = await api("/api/admin/reset-usage-all", { method: "POST" });
      ra.disabled = false;
      ra.textContent = label;
      if (!r) { alert("Reset failed: no response from the server."); return; }
      if (r.status === 401 || r.status === 403) {
        alert("Reset failed: your admin session has expired.\n\nReload this page, log in with the admin secret again, then press Reset All Usage.");
        return;
      }
      if (!r.ok) {
        alert("Reset failed (HTTP " + r.status + "): " + ((r.json && (r.json.error || r.json.message)) || "unknown error"));
        return;
      }
      const n = (r.json && typeof r.json.cleared === "number") ? r.json.cleared : 0;
      alert("Usage reset for all users. Cleared " + n + " record(s).");
      loadUsers();
    });
  }


  async function clientDetectHEVC(f) {
    try {
      if (!f || f.size < 4096) return false;
      const read = (s, e) => new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(new Uint8Array(fr.result));
        fr.onerror = () => res(new Uint8Array(0));
        fr.readAsArrayBuffer(f.slice(Math.max(0, s), e));
      });
      const toStr = (a) => {
        let s2 = ""; const CH = 8192;
        for (let i = 0; i < a.length; i += CH) s2 += String.fromCharCode.apply(null, a.subarray(i, Math.min(i + CH, a.length)));
        return s2;
      };
      const head = await read(0, Math.min(f.size, 4194304));
      const tail = await read(Math.max(0, f.size - 2621440), f.size);
      const hay = toStr(head) + toStr(tail);
      const hevc = hay.indexOf("hvc1") >= 0 || hay.indexOf("hev1") >= 0 || hay.indexOf("V_MPEGH/ISO/HEVC") >= 0;
      if (hevc && window.console) console.log("H265 (HEVC) detected (client) — remuxed locally; GPU only starts if an encode is needed");
      return hevc;
    } catch (e) { return false; }
  }
  /* ── Admin: recent jobs (last hour, auto-cleared server-side) ─── */
  let _jobsTimer = null;
  function _jobEsc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function _jobSize(mb) {
    mb = Number(mb) || 0;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
  }
  function initJobsPanel() {
    const panel = $("#admin-panel");
    if (!panel || document.getElementById("admin-jobs-wrap")) return;
    const wrap = el("div", "", "");
    wrap.id = "admin-jobs-wrap";
    wrap.style.cssText = "margin-top:26px;border-top:1px solid rgba(255,255,255,.08);padding-top:16px;";
    const head = el("div", "", "");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;";
    const title = el("h3", "", "");
    title.style.cssText = "margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.1em;opacity:.75;";
    title.textContent = "Recent jobs — last 5 minutes";
    const refresh = el("button", "btn btn-clear", "");
    refresh.textContent = "Refresh jobs";
    refresh.addEventListener("click", loadJobs);
    head.appendChild(title);
    head.appendChild(refresh);
    wrap.appendChild(head);
    const tw = el("div", "admin-table-wrap", "");
    tw.innerHTML = '<table class="admin-table"><thead><tr><th>Time (UTC)</th><th>Size</th><th>Codec</th><th>Container</th><th>User</th><th>Job</th><th>Result</th></tr></thead><tbody id="admin-jobs-tbody"></tbody></table>';
    wrap.appendChild(tw);
    const cap = el("div", "", "");
    cap.id = "admin-jobs-cap";
    cap.style.cssText = "font-size:11px;opacity:.55;margin:0 0 6px;";
    cap.textContent = "loading...";
    wrap.insertBefore(cap, tw);
    const note = el("p", "", "");
    note.style.cssText = "font-size:11px;opacity:.45;margin:8px 0 0;";
    note.textContent = "Shown: last 5 minutes. No GPU resources are used for this list.";
    wrap.appendChild(note);
    panel.appendChild(wrap);
    if (_jobsTimer) clearInterval(_jobsTimer);
    _jobsTimer = setInterval(() => {
      const p = $("#admin-panel");
      if (p && p.style.display !== "none") loadJobs();
    }, 10000);
  }
  async function loadJobs() {
    const tb = $("#admin-jobs-tbody");
    if (!tb) return;
    try {
      const r = await api("/api/admin/jobs", { cache: "no-store" });
      const body = (r && r.json) || r || {};
      const jobs = Array.isArray(body.jobs) ? body.jobs : [];
      const cap = document.getElementById("admin-jobs-cap");
      if (cap) cap.textContent = "refreshed " + new Date().toISOString().slice(11, 19) + " UTC | " + jobs.length + " job(s) in last 5 min";
      if (!r || !r.ok) {
        tb.innerHTML = '<tr><td colspan="7" style="opacity:.5">Jobs unavailable.</td></tr>';
        return;
      }
      if (!jobs.length) {
        tb.innerHTML = '<tr><td colspan="7" style="opacity:.5">No jobs in the last 5 minutes yet. Do a patch and it appears here within seconds.</td></tr>';
        return;
      }
      tb.innerHTML = jobs.slice().reverse().map((j) => {
        const t = j.ts ? new Date(j.ts).toISOString().slice(11, 19) : "-";
        const bad = j.result && j.result !== "ok";
        return '<tr><td>' + t + '</td><td>' + _jobSize(j.sizeMb) + '</td><td>' + _jobEsc(j.codec || "-") + '</td><td>' + _jobEsc(j.container || "-") + '</td><td>' + _jobEsc(j.user || "-") + '</td><td>' + _jobEsc(j.action || "-") + '</td><td style="color:' + (bad ? "#ff5c7c" : "#3ecf8e") + '">' + _jobEsc(bad ? (j.detail || j.result) : "done") + '</td></tr>';
      }).join("");
    } catch (e) {
      tb.innerHTML = '<tr><td colspan="7" style="opacity:.5">Failed to load jobs.</td></tr>';
    }
  }

  function ensurePager(pages, total) {
    const tbody = $("#admin-tbody");
    if (!tbody) return;
    let pg = $("#admin-pager");
    if (!pg) {
      pg = el("div", "", "");
      pg.id = "admin-pager";
      pg.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;";
      const table = tbody.closest ? tbody.closest("table") : null;
      const host = table && table.parentNode ? table.parentNode : (tbody.parentNode || document.body);
      host.insertBefore(pg, table ? table.nextSibling : tbody.nextSibling);
    }
    pg.innerHTML = "";
    const mk = (label, fn, dis) => { const b = el("button", "btn btn-clear btn-xs", label); if (dis) b.disabled = true; else b.addEventListener("click", fn); return b; };
    pg.appendChild(mk("\u2039 Prev", () => { if (admPage > 1) { admPage--; loadUsers(); } }, admPage <= 1));
    const info = el("span", "dim", "Page " + admPage + " / " + pages + " \u00b7 " + total + " users");
    pg.appendChild(info);
    pg.appendChild(mk("Next \u203a", () => { if (admPage < pages) { admPage++; loadUsers(); } }, admPage >= pages));
    const sel = el("select", "admin-tier-select", [[25, "25 / page"], [50, "50 / page"], [100, "100 / page"]]
      .map(function (o) { return "<option value=\"" + o[0] + "\"" + (admPer === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join(""));
    sel.addEventListener("change", function () { admPer = parseInt(sel.value, 10) || 50; admPage = 1; loadUsers(); });
    pg.appendChild(sel);
  }

  async function loadUsers() {
    const tbody = $("#admin-tbody");
    const q = ($("#admin-search") && $("#admin-search").value.trim()) || "";
    const pf = ($("#admin-platform") && $("#admin-platform").value) || "";
    const params = new URLSearchParams({ page: String(admPage), per_page: String(admPer) });
    if (q) params.set("q", q);
    if (pf) {
      params.set("platform", pf);
      params.set("per_page", "5000");
    }
    const sp = $("#admin-platform");
    if (sp && !sp.__wired) { sp.__wired = true; sp.addEventListener("change", () => { admPage = 1; loadUsers(); }); }
    const r = await api("/api/admin/users?" + params.toString(), { cache: "no-store" });
    if (!r || !r.ok) { if (tbody) tbody.innerHTML = '<tr><td colspan="5">Not authorized</td></tr>'; return; }
    const data = r.json || {};
    try {
    const users = Array.isArray(data) ? data : (data.users || []);
    const total = data.total != null ? data.total : users.length;
    const pages = data.pages != null ? data.pages : 1;
    if (admPage > pages) { admPage = Math.max(1, pages); return loadUsers(); }
    if ($("#admin-count")) {
      if (total === 0) $("#admin-count").textContent = "0 users";
      else if (total > admPer) $("#admin-count").textContent = total + " users \u2014 showing " + ((admPage - 1) * admPer + 1) + "\u2013" + Math.min(total, admPage * admPer);
      else $("#admin-count").textContent = total + " users";
    }
    if (tbody) {
      tbody.innerHTML = "";
      users.forEach((u) => {
        const tr = el("tr", "");
        const tierNames = ["member", "booster", "donor"];
        const sel = el("select", "admin-tier-select",
          tierNames.map((t) => `<option value="${t}" ${(u.tier_override || u.tier) === t ? "selected" : ""}>${({member:"Free",booster:"Booster",donor:"Premium"})[t]}</option>`).join("") +
          `<option value="" ${!(u.tier_override || u.tier) ? "selected" : ""}>auto</option>`);
        sel.addEventListener("change", async () => {
          await api("/api/admin/tier", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ discord_id: u.discord_id, tier: sel.value || null }) });
          loadUsers();
        });
        tr.appendChild(el("td", "", "<b>" + esc(u.username) + "</b><br><span class='dim'>" + esc(u.discord_id) + "</span>"));
        tr.appendChild(el("td", "mono", "Unlimited"));
        tr.appendChild(el("td", "", sel.outerHTML));
        tr.appendChild(el("td", "mono dim", new Date(u.created_at).toLocaleDateString()));
        const td = el("td", "", "");
        const del = el("button", "btn btn-clear btn-xs", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Delete');
        del.addEventListener("click", async () => {
          if (!confirm("Delete " + u.username + "?")) return;
          await api("/api/admin/user/" + encodeURIComponent(u.discord_id), { method: "DELETE" });
          loadUsers();
        });
        const reset = el("button", "btn btn-clear btn-xs", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Reset usage');
        reset.addEventListener("click", async () => {
          if (!confirm("Reset optimization usage for " + u.username + "?")) return;
          const _label = reset.innerHTML;
          reset.disabled = true;
          reset.textContent = "Resetting\u2026";
          const r = await api("/api/admin/reset-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ discord_id: u.discord_id }) });
          reset.disabled = false;
          reset.innerHTML = _label;
          if (!r) { alert("Reset failed: no response from the server."); return; }
          if (r.status === 401 || r.status === 403) {
            alert("Reset failed: your admin session has expired.\n\nReload this page, log in with the admin secret again, then try once more.");
            return;
          }
          if (!r.ok) {
            alert("Reset failed (HTTP " + r.status + "): " + ((r.json && (r.json.error || r.json.message)) || "unknown error"));
            return;
          }
          loadUsers();
        });
        td.appendChild(reset);
        td.appendChild(del);
        tr.appendChild(td);
        tbody.appendChild(tr);
      });
    }
    ensurePager(pages, total);
    } catch (err) {
      console.error("loadUsers failed:", err);
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="color:#ef4444">Failed to load users: ' + (err && err.message ? err.message : err) + '</td></tr>';
    }
  }

  /* ── TIERS page ══════════════════════════════════════════════ */
  function ensureTierChoices(user) {
    const b = $("#tier-cta");
    if (!b) return;

    let row = (b.parentElement && b.parentElement.classList.contains("tier-cta-row"))
      ? b.parentElement : null;
    if (!row) {
      row = document.createElement("div");
      row.className = "tier-cta-row";
      b.insertAdjacentElement("beforebegin", row);
      row.appendChild(b);
    }

    let tg = $("#tier-cta-tg");
    if (!tg) {
      tg = document.createElement("button");
      tg.type = "button";
      tg.id = "tier-cta-tg";
      tg.className = "tier-cta-tg";
      tg.innerHTML = TELEGRAM_SVG + "Login with Telegram";
      row.appendChild(tg);
      startTelegramLogin(tg);
    }
    tg.style.display = user ? "none" : "";
  }

  function initTiers() {
    api("/api/health").then((h) => { API_DISCORD = !!(h && h.json && h.json.discordConfigured); });
    api("/api/me").then((m) => {
      const { user } = normalizeMe(m && m.json);
      renderAuth(user, false);
      ensureTierChoices(user);
      if (user && user.tier) {
        $$('.view[data-view="tiers"] .tier-card').forEach((c) => c.classList.toggle("mine", c.dataset.tier === user.tier.tier));
        const b = $("#tier-cta");
        if (b) { b.textContent = "Premium — Active"; b.classList.add("active"); }
      }
    });
  }

  /* ── Discord logo + login popup ────────────────────────────── */
  const DISCORD_SVG = '<svg class="dl-logo" viewBox="0 0 127.14 96.36" aria-hidden="true"><path fill="currentColor" d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0 105.89 105.89 0 0 0 19.39 8.09C2.79 32.65-1.71 56.6.54 80.21h0A105.73 105.73 0 0 0 32.71 96.36a77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1A105.25 105.25 0 0 0 126.6 80.22h0C129.24 52.84 122.09 29.11 107.7 8.07ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53 48.84 65.69 42.45 65.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.45-12.74S96.23 46 96.12 53 91.08 65.69 84.69 65.69Z"/></svg>';
  const TELEGRAM_SVG = '<svg class="dl-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>';
  document.querySelectorAll("[data-discord]").forEach((el) => {
    if (!el.querySelector(".dl-logo")) el.insertAdjacentHTML("afterbegin", DISCORD_SVG);
  });

  let API_DISCORD = true;
  function openLogin() {
    const ret = (location.pathname || "/") + (location.search || "");
    location.href = "/api/discord?action=login&return=" + encodeURIComponent(ret);
  }
  function showLoginChoiceOverlay() {
    let ov = document.getElementById("login-choice-modal");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "login-choice-modal";
      ov.className = "login-modal";
      ov.innerHTML =
        '<div class="login-modal-card" role="dialog" aria-modal="true" aria-label="Sign in">' +
          '<button class="login-modal-x" type="button" aria-label="Close">&times;</button>' +
          '<h2 class="login-modal-title">Sign in to optimize</h2>' +
          '<p class="login-modal-sub">Choose how you want to sign in.</p>' +
          '<a class="btn btn-discord" id="modal-dc" href="#">' + DISCORD_SVG + 'Login with Discord</a>' +
          '<button class="btn btn-tg" type="button" id="modal-tg">' + TELEGRAM_SVG + 'Login with Telegram</button>' +
        '</div>';
      document.body.appendChild(ov);
      ov.addEventListener("click", (e) => { if (e.target === ov) closeLoginChoiceOverlay(); });
      ov.querySelector(".login-modal-x").addEventListener("click", closeLoginChoiceOverlay);
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeLoginChoiceOverlay();
      });
      ov.querySelector("#modal-dc").addEventListener("click", function (e) {
        e.preventDefault();
        const ret = (location.pathname || "/") + (location.search || "");
        location.href = "/api/discord?action=login&return=" + encodeURIComponent(ret);
      });
      startTelegramLogin(ov.querySelector("#modal-tg"));
    }
    ov.classList.add("show");
    return true;
  }

  function closeLoginChoiceOverlay() {
    const ov = document.getElementById("login-choice-modal");
    if (ov) ov.classList.remove("show");
  }

  function requireLogin() {
    try {
      showLoginChoiceOverlay();
    } catch (err) {
      openLogin();
    }
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("#btn-login, [data-login]");
    if (t) { e.preventDefault(); openLogin(); }
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest(".tier-btn");
    if (!b) return;
    if (AUTH_USER) return;
    if (!authConfirmedSignedOut()) return;
    if (b.classList.contains("activated")) return;
    e.preventDefault();
    requireLogin();
  });

  /* ── SPA router ── */
  const VIEWS = ["dashboard", "patcher", "analytics", "tiers", "howto", "admin", "login"];
  const INIT = {};

  function currentView() {
    const h = (location.hash || "").replace(/^#\/?/, "").split("?")[0].split("/")[0];
    if (h && VIEWS.includes(h)) return h;
    const p = (location.pathname || "/").replace(/^\/+/, "").split("/")[0];
    return VIEWS.includes(p) ? p : "dashboard";
  }

  function pathFor(view) { return view === "dashboard" ? "/" : "/" + view; }

  function navigate(path, replace) {
    try { (replace ? history.replaceState : history.pushState).call(history, {}, "", path); }
    catch { location.href = path; return; }
    showView(currentView());
  }

  function isRouteHref(href) {
    if (!href || /^(https?:)?\/\//.test(href) || href.startsWith("/api/") || href.startsWith("#")) return false;
    const seg = href.replace(/^\/+/, "").split(/[?#]/)[0].split("/")[0];
    return href === "/" || VIEWS.includes(seg);
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("data-discord-link") || a.hasAttribute("data-login")) return;
    const href = a.getAttribute("href");
    if (!isRouteHref(href)) return;
    const view = href === "/" ? "dashboard" : href.replace(/^\/+/, "").split(/[?#]/)[0].split("/")[0];
    a.href = pathFor(view);
  });

  function showView(name) {
    if (!VIEWS.includes(name)) name = "dashboard";
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
    $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
    document.body.dataset.page = name;

    if (!INIT[name]) {
      INIT[name] = true;
      if (name === "dashboard") initDashboard();
      if (name === "patcher") initPatcher();
      if (name === "analytics") initAnalytics();
      if (name === "admin") initAdmin();
      if (name === "tiers") initTiers();
      if (name === "login") initLoginView();
    }
    initReveal();
    window.scrollTo(0, 0);
  }

  function initLoginView() {
    if ((location.search || "").indexOf("tg_join=1") !== -1) return;
    api("/api/me").then((m) => {
      const { user } = normalizeMe(m && m.json);
      if (user) { location.replace("/"); return; }
      showLoginChoice();
    });
  }

  var TG_BOT_ID = 8904316195;
  var tgWidgetLoading = false;

  function telegramStockWidget(slot) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.setAttribute("data-telegram-login", "JOHN_QUALITYBot");
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "10");
    s.setAttribute("data-userpic", "false");
    s.setAttribute("data-lang", "en");
    s.setAttribute("data-auth-url", "https://www.johnquality.xyz/api/auth/telegram");
    slot.appendChild(s);
  }

  function showLoginChoice() {
    const card = document.querySelector(".login-card");
    if (!card) { location.replace("/api/discord?action=login"); return; }
    card.classList.add("login-choice");
    card.innerHTML =
      '<h1 id="login-title">Sign in</h1>' +
      '<a class="btn" id="login-go" href="/api/discord?action=login">Login with Discord</a>' +
      '<a class="btn" id="tg-login-go" href="#" role="button">Login with Telegram</a>' +
      '<div id="tg-login-slot" class="login-tg-slot" hidden></div>';

    const tgBtn = card.querySelector("#tg-login-go");
    const slot = card.querySelector("#tg-login-slot");
    if (!tgBtn || !slot) return;
    startTelegramLogin(tgBtn, slot);
  }

  function startTelegramLogin(tgBtn, slot) {
    if (!tgBtn) return;
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "login-tg-slot";
      slot.hidden = true;
      tgBtn.insertAdjacentElement("afterend", slot);
    }

    let tgDeep = null;
    api("/api/tg/start", { cache: "no-store" }).then((r) => {
      const d = r && r.json;
      if (d && d.ok && d.url && d.nonce) tgDeep = d;
    });

    function useStockWidget() {
      tgBtn.hidden = true;
      slot.hidden = false;
      if (!slot.childNodes.length) telegramStockWidget(slot);
    }

    if (!tgWidgetLoading) {
      tgWidgetLoading = true;
      const loader = document.createElement("script");
      loader.async = true;
      loader.src = "https://telegram.org/js/telegram-widget.js?22";
      loader.onerror = useStockWidget;
      loader.onload = function () {
        if (!(window.Telegram && window.Telegram.Login && window.Telegram.Login.auth)) useStockWidget();
      };
      document.head.appendChild(loader);
    }

    tgBtn.addEventListener("click", function (e) {
      e.preventDefault();
      if (tgDeep) {
        tgAuthPark(tgDeep.nonce);
   const win = window.open(tgDeep.url, "_blank");
        if (win) { tgDeepPoll(tgDeep.nonce); return; }
        tgAuthPark(tgDeep.nonce);
        location.href = tgDeep.url;
        return;
      }
      if (!(window.Telegram && window.Telegram.Login && window.Telegram.Login.auth)) { useStockWidget(); return; }
      window.Telegram.Login.auth({ bot_id: TG_BOT_ID, request_access: false, lang: "en" }, function (user) {
        if (!user || !user.hash) return;
        location.href = "/api/auth/telegram?" + new URLSearchParams(user).toString();
      });
    });
  }

  window.addEventListener("popstate", () => showView(currentView()));

  const LOGIN_ERROR_MSG = {
    not_in_server:        "You must be in the Discord server to log in.",
    not_in_channel:       "You're not in our Telegram channel yet — join it first, then log in again.",
    telegram_failed:      "Telegram login failed or expired — please try again.",
    join_declined:        'You un-checked "Join server" on the Discord screen. Log in again and leave it checked so we can add you to the server.',
    join_failed:          "We could not add you to the Discord server right now (is it full?). Please try again, or join manually below.",
    invalid_state:        "Login session expired — please try again.",
    missing_params:       "Login session expired — please try again.",
    token_exchange_failed: "Discord authorization failed — please try again.",
    user_fetch_failed:    "Could not load your Discord profile — please try again.",
    oauth_failed:         "Login failed — please try again.",
    access_denied:        "You cancelled the Discord login. Click below when you are ready.",
  };
  function showLoginErrorBanner() {
    const code = new URLSearchParams(location.search).get("login_error");
    if (!code) return;
    const msg = LOGIN_ERROR_MSG[code] || "Login failed — please try again.";
    const box = el("div", "", "");
    box.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#7c3aed;color:#fff;padding:12px 18px;font:600 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.4);";
    let links = '<a href="/api/discord?action=login" style="color:#fff;font-weight:800;text-decoration:underline;margin-left:10px;white-space:nowrap;">Log in again</a>';
    if (code === "not_in_channel" && window.RTX && window.RTX.TELEGRAM_INVITE) {
      links += '<a href="' + esc(window.RTX.TELEGRAM_INVITE) + '" target="_blank" rel="noopener" style="color:#fff;font-weight:800;text-decoration:underline;margin-left:12px;white-space:nowrap;">Join Telegram channel</a>';
      if (window.RTX.TELEGRAM_BOT) {
        links += '<a href="' + esc(window.RTX.TELEGRAM_BOT) + '" target="_blank" rel="noopener" style="color:#fff;font-weight:800;text-decoration:underline;margin-left:12px;white-space:nowrap;">Open @JOHN_QUALITYBot</a>';
      }
    }
    if ((code === "not_in_server" || code === "join_failed") && window.RTX && window.RTX.DISCORD_INVITE) {
      links += '<a href="' + esc(window.RTX.DISCORD_INVITE) + '" target="_blank" rel="noopener" style="color:#fff;font-weight:800;text-decoration:underline;margin-left:12px;white-space:nowrap;">Join server</a>';
    }
    box.innerHTML = "<span>" + esc(msg) + "</span>" + links +
      '<button type="button" aria-label="Dismiss" style="margin-left:12px;background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;vertical-align:middle;">&times;</button>';
    document.body.prepend(box);
    box.querySelector("button").addEventListener("click", () => {
      box.remove();
      try { history.replaceState({}, "", location.pathname); } catch {}
    });
  }

  window.RTX = window.RTX || {};
  window.RTX.TELEGRAM_INVITE = window.RTX.TELEGRAM_INVITE || "https://t.me/JOHN_QUALITYYT";
  window.RTX.TELEGRAM_CHANNEL = "@JOHN_QUALITYYT";
  window.RTX.TELEGRAM_BOT = window.RTX.TELEGRAM_BOT || "https://t.me/JOHN_QUALITYBot?start=site";
  window.RTX.TELEGRAM_BOT_HANDLE = window.RTX.TELEGRAM_BOT_HANDLE || "@JOHN_QUALITYBot";

  (function forwardTelegramLogin() {
    try {
      const q = location.search || "";
      if (q.indexOf("hash=") === -1 || q.indexOf("auth_date=") === -1) return;
      if (q.indexOf("tg_join=1") !== -1) return;
      location.replace("/api/auth/telegram" + q);
    } catch (e) {}
  })();

  function telegramJoinPoll(params) {
    const clear = () => { try { sessionStorage.removeItem("rtx_tg_pending"); } catch (e) {} };
    let tries = 0;
    const tick = () => {
      if (tries++ > 150) { clear(); return; }
      fetch("/api/tg/status?" + params, { credentials: "include" })
        .then((r) => r.json())
        .then((j) => {
          if (j && j.member) { clear(); location.replace("/api/auth/telegram?" + params); return; }
          setTimeout(tick, 4000);
        })
        .catch(() => setTimeout(tick, 4000));
    };
    setTimeout(tick, 2000);
  }

  function showTelegramJoin(params) {
    const card = document.querySelector(".login-card");
    if (!card) { location.replace("/api/auth/telegram?" + params); return; }
    const bot = (window.RTX && window.RTX.TELEGRAM_BOT) || "https://t.me/JOHN_QUALITYBot?start=welcome";
    const handle = (window.RTX && window.RTX.TELEGRAM_BOT_HANDLE) || "@JOHN_QUALITYBot";
    try { sessionStorage.setItem("rtx_tg_pending", params); } catch (e) {}
    card.classList.add("login-choice");
    card.innerHTML =
      '<h1 id="login-title">Taking you to Telegram&hellip;</h1>' +
      '<p id="login-msg" style="opacity:.8;font-size:13px">Press <b>Start</b> in the bot and join the channel &mdash; this page signs you in as soon as you do.</p>' +
      '<a class="btn" id="tg-open-bot" href="' + esc(bot) + '" target="_blank" rel="noopener" hidden>Open ' + esc(handle) + '</a>';
    const openBtn = card.querySelector("#tg-open-bot");
    let win = null;
    try { win = window.open(bot, "_blank"); } catch (e) {}
    if (!win && openBtn) {
      openBtn.hidden = false;
      const t = card.querySelector("#login-title");
      const m = card.querySelector("#login-msg");
      if (t) t.textContent = "Open Telegram to finish";
      if (m) m.innerHTML = "Telegram did not open by itself. Tap the button &mdash; the bot opens in a <b>new tab</b> and this page stays here, signing you in the moment you join the channel.";
    }
    telegramJoinPoll(params);
  }

  (function telegramJoinScreen() {
    try {
      const q = location.search || "";
      if (q.indexOf("tg_join=1") === -1) return;
      const params = q.replace(/^\?/, "").split("&")
        .filter((kv) => kv.indexOf("tg_join=") !== 0).join("&");
      const start = () => showTelegramJoin(params);
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    } catch (e) {}
  })();

  (function resumeTelegramJoin() {
    try {
      const params = sessionStorage.getItem("rtx_tg_pending");
      if (!params) return;
      if ((location.search || "").indexOf("tg_join=1") !== -1) return;
       telegramJoinPoll(params);
     } catch (e) {}
   })();

   const TG_AUTH_KEY = "rtx_tg_auth";
   const TG_AUTH_TTL_MS = 30 * 60 * 1000;
   let tgAuthGen = 0;

   function tgAuthPark(nonce) {
     try { localStorage.setItem(TG_AUTH_KEY, JSON.stringify({ nonce: nonce, ts: Date.now() })); } catch (e) {}
   }

   function tgAuthClear() {
     try { localStorage.removeItem(TG_AUTH_KEY); } catch (e) {}
   }

   function tgAuthPending() {
     try {
       const raw = localStorage.getItem(TG_AUTH_KEY);
       if (!raw) return null;
       const v = JSON.parse(raw);
       if (!v || !v.nonce) { tgAuthClear(); return null; }
       if (Date.now() - (v.ts || 0) > TG_AUTH_TTL_MS) { tgAuthClear(); return null; }
       return v.nonce;
     } catch (e) { tgAuthClear(); return null; }
   }

   function tgDeepPoll(nonce) {
     const gen = ++tgAuthGen;
     tgAuthPark(nonce);
     let tries = 0;
     const tick = () => {
       if (gen !== tgAuthGen) return;
       if (tries++ >= 300) { tgAuthClear(); return; }
       api("/api/tg/poll?nonce=" + encodeURIComponent(nonce), { cache: "no-store" }).then((r) => {
         const d = r && r.json;
         if (d && d.ok === false) { tgAuthClear(); return; }
         if (d && d.confirmed && d.member) { tgAuthClear(); location.replace(d.redirect || "/patcher"); return; }
         setTimeout(tick, 2000);
       });
     };
     setTimeout(tick, 1500);
   }

  let tgLinkDeep = null;
  (function telegramLoginLinks() {
    try {
      api("/api/tg/start", { cache: "no-store" }).then((r) => {
        const d = r && r.json;
        if (d && d.ok && d.url && d.nonce) tgLinkDeep = d;
      });
    } catch (e) {}
    document.addEventListener("click", function (e) {
      const t = e.target;
      const link = t && t.closest ? t.closest("[data-tg-login]") : null;
      if (!link) return;
      e.preventDefault();
      if (!tgLinkDeep) {
        location.href = link.getAttribute("href") || "https://t.me/JOHN_QUALITYBot";
        return;
      }
      tgAuthPark(tgLinkDeep.nonce);
      const win = window.open(tgLinkDeep.url, "_blank");
      if (win) { tgDeepPoll(tgLinkDeep.nonce); return; }
      location.href = tgLinkDeep.url;
    });
  })();

  (function resumeTelegramDeep() {
    try {
      if ((location.search || "").indexOf("tg_join=1") !== -1) return;
      const nonce = tgAuthPending();
      if (nonce) tgDeepPoll(nonce);
    } catch (e) {}
  })();

  function initBestTimes() {
    const btn = document.getElementById("btCheckBtn");
    if (!btn) return;
    const input = document.getElementById("btUsername");
    const loading = document.getElementById("btLoading");
    const err = document.getElementById("btError");
    const out = document.getElementById("btResult");
    const showErr = (m) => { if (err) { err.textContent = m; err.style.display = "block"; } };
    const run = async () => {
      const u = ((input && input.value) || "").trim().replace(/^@/, "");
      if (!u) { showErr("Enter a TikTok username first."); return; }
      if (err) { err.style.display = "none"; err.textContent = ""; }
      if (out) out.style.display = "none";
      if (loading) loading.style.display = "flex";
      try {
        const r = await fetch("/api/besttime", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: u }),
        });
        const d = await r.json();
        if (loading) loading.style.display = "none";
        if (!d || d.error) { showErr((d && d.error) || "Couldn't look up that profile."); return; }
        if (!d.has_data) { showErr("Not enough public videos yet to estimate your best times."); return; }
        renderBestTimes(d);
      } catch (e) {
        if (loading) loading.style.display = "none";
        showErr("Something went wrong — please try again.");
      }
    };
    btn.addEventListener("click", run);
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  }

  function renderBestTimes(d) {
    const out = document.getElementById("btResult");
    if (!out) return;
    const win = d.windows || [];
    const conf = d.confident ? "high confidence" : "low confidence";
    let html = '<div style="font-size:12px;color:var(--text-3);margin-bottom:12px">Based on '
      + (d.sample_size || 0) + " recent video" + ((d.sample_size === 1) ? "" : "s")
      + " · " + conf + "</div>";
    win.forEach((w) => {
      const pct = Math.min(100, Math.max(5, Number(w.avg_engagement_rate) * 4));
      html += '<div style="margin-bottom:12px">'
        + '<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;margin-bottom:5px">'
        + "<span>" + esc(w.label) + "</span>"
        + '<span style="font-weight:700;white-space:nowrap">' + w.avg_engagement_rate + "%</span>"
        + "</div>"
        + '<div style="height:7px;border-radius:4px;background:rgba(255,255,255,.08)">'
        + '<div style="height:7px;border-radius:4px;width:' + pct + '%;background:var(--purple,#8b5cf6)"></div>'
        + "</div></div>";
    });
    out.innerHTML = html;
    out.style.display = "block";
  }

  let AUTH_STATE = null;
  let AUTH_USER = null;
  let AUTH_DEV = false;
  let AUTH_ME_RAW = null;
  let AUTH_RESOLVED = false;
  const AUTH_LS_KEY = "johnquality:last";

  function authConfirmedSignedOut() { return AUTH_RESOLVED && !AUTH_USER; }

  function readCachedAuth() {
    try { const raw = localStorage.getItem(AUTH_LS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  function writeCachedAuth(user) {
    try {
      if (user) localStorage.setItem(AUTH_LS_KEY, JSON.stringify(user));
      else localStorage.removeItem(AUTH_LS_KEY);
    } catch {}
  }
  function clearCachedAuth() { writeCachedAuth(null); }

  function applyAuthState(user, devMode) {
    AUTH_USER = user;
    AUTH_DEV = !!devMode;
    renderAuth(user, devMode);
    renderTierCtas(user && user.tier && user.tier.tier);
  }
  function loadAuthState() {
    if (AUTH_STATE) return AUTH_STATE;
    if (!AUTH_USER) { const c = readCachedAuth(); if (c) applyAuthState(c, false); }
    const meP = api("/api/me");
    const healthP = api("/api/health");
    AUTH_STATE = meP.then((m) => {
      AUTH_ME_RAW = (m && m.json) || null;
      const { user } = normalizeMe(m && m.json);
      return healthP.then((h) => {
        API_DISCORD = !!(h && h.json && h.json.discordConfigured);
        applyAuthState(user, !!(h && h.json && h.json.devMode));
        writeCachedAuth(user);
        AUTH_RESOLVED = true;
        return user;
      });
    }).catch(() => { AUTH_RESOLVED = true; return null; });
    return AUTH_STATE;
  }
  function syncAuthFromMe(json) {
    const { user } = normalizeMe(json);
    const next = (user && user.tier && user.tier.tier) || null;
    const prev = (AUTH_USER && AUTH_USER.tier && AUTH_USER.tier.tier) || null;
    if (next !== prev) applyAuthState(user, AUTH_DEV);
    return user;
  }

  function boot() {
    try {
      const stale = ["/api/me"];
      stale.forEach((k) => sessionStorage.removeItem("rtxcache:" + k));
    } catch {}
    initReveal();
    showLoginErrorBanner();
    initBestTimes();
    loadAuthState();
    const v = window.__VIEW__ || currentView();
    if (location.hash) {
      try { history.replaceState({}, "", pathFor(v) + (location.search || "")); } catch {}
    }
    showView(v);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/* ═══════════════════════════════════════════════════════════════
   Payment badges — injected into the footer of every page.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var G = {
    google: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>',
    crypto: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style="overflow:visible"><path d="M16 8a6 6 0 1 0 0 8" stroke="#F7931A" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M10 4v4M13 4v4M10 16v4M13 16v4" stroke="#F7931A" stroke-width="2" stroke-linecap="round"/></svg>',
    bank: '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 2.5 2 8.5h20L12 2.5z" fill="#1a1a1a"/><rect x="6.5" y="10.5" width="2.2" height="7" fill="#1a1a1a"/><rect x="10.9" y="10.5" width="2.2" height="7" fill="#1a1a1a"/><rect x="15.3" y="10.5" width="2.2" height="7" fill="#1a1a1a"/><rect x="3.5" y="17.5" width="17" height="2.6" rx="0.8" fill="#1a1a1a"/></svg>'
  };

  var IMG = "assets/payments/";

  var BADGES = [
    ["Visa", '<span class="pv-visa">VISA</span>'],
    ["Mastercard", '<img class="pv-img" src="' + IMG + 'mastercard.jpg" alt="Mastercard">'],
    ["PayPal", '<span class="pv-paypal"><b class="c1">Pay</b><b class="c2">Pal</b></span>'],
    ["Apple Pay", '<img class="pv-img" src="' + IMG + 'apple-pay.jpg" alt="Apple Pay">'],
    ["Google Pay", G.google + "<b>Pay</b>"],
    ["Amazon Pay", '<img class="pv-img" src="' + IMG + 'amazon-pay.jpg" alt="Amazon Pay">'],
    ["Crypto", G.crypto + "<b>CRYPTO</b>"],
    ["Revolut", '<b class="pv-revolut">Revolut</b>'],
    ["Wise", '<img class="pv-img" src="' + IMG + 'wise.jpg" alt="Wise">'],
    ["Remitly", '<img class="pv-img" src="' + IMG + 'remitly.jpg" alt="Remitly">'],
    ["Bank transfer", G.bank + "<b>Bank transfer</b>"]
  ];

  function injectPayments() {
    var footer = document.querySelector(".site-footer");
    if (!footer || document.querySelector(".footer-payments")) return;
    var box = document.createElement("div");
    box.className = "footer-payments";
    var h = document.createElement("h4");
    h.textContent = "We accept";
    var row = document.createElement("div");
    row.className = "pay-badges";
    BADGES.forEach(function (b) {
      var s = document.createElement("span");
      s.className = "pay-badge";
      s.title = b[0];
      s.setAttribute("aria-label", b[0]);
      s.innerHTML = b[1];
      row.appendChild(s);
    });
    box.appendChild(h);
    box.appendChild(row);
    var bottom = footer.querySelector(".footer-bottom");
    footer.insertBefore(box, bottom);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectPayments);
  else injectPayments();
})();

/* Giveaway countdown. */
(function () {
  const start = () => {
    const els = Array.from(document.querySelectorAll("[data-giveaway-ends]"));
    if (!els.length) return;
    const pad = (n) => (n < 10 ? "0" : "") + n;
    const paint = () => {
      const now = Date.now();
      els.forEach((el) => {
        const secs = Math.floor((Date.parse(el.getAttribute("data-giveaway-ends")) - now) / 1000);
        if (!Number.isFinite(secs) || secs <= 0) { el.textContent = "ended"; return; }
        el.textContent = pad(Math.floor(secs / 3600)) + ":" +
                         pad(Math.floor((secs % 3600) / 60)) + ":" + pad(secs % 60);
      });
    };
    paint();
    setInterval(paint, 1000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();


/* ── STALE-TAB GUARD ────────────────────────────────────────────────────────── */
(function () {
  try {
    var here = (document.currentScript && document.currentScript.src) || "";
    var mine = (here.match(/shared\.js\?v=(\d+)/) || [])[1];
    if (!mine) return;
    function check() {
      if (window.__rtxBusy) return;
      fetch(location.pathname, { cache: "no-store" })
        .then(function (r) { return r.text(); })
        .then(function (t) {
          var m = t.match(/shared\.js\?v=(\d+)/);
          if (m && Number(m[1]) !== Number(mine)) location.reload();
        })
        .catch(function () {});
    }
    setTimeout(check, 10000);
    setInterval(check, 60000);
  } catch (e) { /* a version check must never break the page */ }
})();
