/* RTX Fury — AI chat widget (site assistant). */
(function () {
  if (window.__rtxChatLoaded) return;
  window.__rtxChatLoaded = true;

  var API = "/api/chat";
  var STORE_KEY = "rtx_chat_hist_v6";
  var MAX_STORE = 30;   // messages kept in localStorage
  var SEND_HIST = 10;   // history sent to the API
  var hist = [];
  try { hist = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch (e) { hist = []; }
  // Sanitize stale history: drop any assistant reply that talks about
  // Premium/Booster but is missing the Discord invite link (old buggy
  // replies). Keeps the link-less replies from ever being shown again.
  hist = hist.filter(function (m) {
    // Drop stale assistant replies that mention Discord/premium/booster but
    // are missing the invite link (old buggy replies).
    if (m && m.role === "assistant" && /premium|booster|donor|discord/i.test(m.content) && !/discord\.gg/.test(m.content)) return false;
    return true;
  });
  if (hist.length) { try { localStorage.setItem(STORE_KEY, JSON.stringify(hist)); } catch (e) {} }

  var style = document.createElement("style");
  style.textContent =
    "#rtxchat-wrap{position:fixed;right:18px;bottom:18px;z-index:9999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}" +
    "#rtxchat-btn{display:flex;align-items:center;gap:9px;background:#16a34a;color:#fff;border:0;border-radius:999px;padding:15px 24px;cursor:pointer;box-shadow:0 8px 28px rgba(22,163,74,.5);font-size:15px;font-weight:600;transition:transform .15s}" +
    "#rtxchat-btn:hover{transform:translateY(-2px)}" +
    "#rtxchat-btn svg{width:22px;height:22px;fill:#fff}" +
    "#rtxchat-panel{display:none;position:fixed;right:18px;bottom:84px;width:380px;max-width:calc(100vw - 36px);height:540px;max-height:calc(100vh - 120px);background:#0d1117;border:1px solid #21262d;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);flex-direction:column;overflow:hidden}" +
    "#rtxchat-panel.open{display:flex}" +
    "#rtxchat-head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#161b22;border-bottom:1px solid #21262d}" +
    "#rtxchat-head .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb950}" +
    "#rtxchat-head .t{flex:1}" +
    "#rtxchat-head .t b{display:block;color:#e6edf3;font-size:14px}" +
    "#rtxchat-head .t span{color:#8b949e;font-size:11px}" +
    "#rtxchat-clear{background:0;border:0;color:#8b949e;font-size:11px;cursor:pointer;padding:4px 6px;border-radius:6px}" +
    "#rtxchat-clear:hover{color:#e6edf3;background:#21262d}" +
    "#rtxchat-close{background:0;border:0;color:#8b949e;font-size:18px;cursor:pointer;padding:2px 8px;border-radius:6px;line-height:1}" +
    "#rtxchat-close:hover{color:#e6edf3;background:#21262d}" +
    "#rtxchat-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}" +
    ".rtxchat-m{max-width:85%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;color:#e6edf3}" +
    ".rtxchat-m.user{align-self:flex-end;background:#1f6feb;border-bottom-right-radius:4px}" +
    ".rtxchat-m.ai{align-self:flex-start;background:#161b22;border:1px solid #21262d;border-bottom-left-radius:4px}" +
    ".rtxchat-m.err{align-self:flex-start;background:#3d1d1d;border:1px solid #5c2a2a;color:#ffb3b3}" +
    "#rtxchat-msgs a{color:#58a6ff;text-decoration:underline;word-break:break-all}" +
    ".rtxchat-faqs{display:flex;flex-direction:column;gap:7px;align-self:flex-start;width:100%;margin-top:2px}" +
    ".rtxchat-suggest{display:flex;flex-direction:column;gap:7px;align-self:flex-start;width:100%;margin-top:2px}" +
    ".rtxchat-chip{background:#161b22;color:#58a6ff;border:1px solid #30363d;border-radius:10px;padding:9px 12px;font-size:12.5px;text-align:left;cursor:pointer;font-family:inherit;transition:border-color .12s, background .12s}" +
    ".rtxchat-chip:hover{background:#21262d;border-color:#58a6ff}" +
    ".rtxchat-typing{display:inline-flex;gap:4px;padding:12px}" +
    ".rtxchat-typing i{width:7px;height:7px;border-radius:50%;background:#8b949e;animation:rtxblink 1.2s infinite}" +
    ".rtxchat-typing i:nth-child(2){animation-delay:.2s}.rtxchat-typing i:nth-child(3){animation-delay:.4s}" +
    "@keyframes rtxblink{0%,80%,100%{opacity:.25}40%{opacity:1}}" +
    "#rtxchat-inputrow{display:flex;gap:8px;padding:10px 12px;background:#161b22;border-top:1px solid #21262d}" +
    "#rtxchat-in{flex:1;resize:none;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:8px 10px;font-size:16px;font-family:inherit;max-height:96px;outline:0}" +
    "#rtxchat-in:focus{border-color:#3fb950}" +
    "#rtxchat-send{background:#238636;color:#fff;border:0;border-radius:8px;padding:0 16px;font-size:13.5px;font-weight:600;cursor:pointer}" +
    "#rtxchat-send:disabled{opacity:.5;cursor:default}" +
    "@media(max-width:700px){#rtxchat-wrap{right:12px;bottom:calc(72px + env(safe-area-inset-bottom, 0px) + 12px)}" +
    "#rtxchat-btn{padding:12px 20px;border-radius:999px}" +
    "#rtxchat-btn svg{width:20px;height:20px}" +
    "#rtxchat-panel{right:12px;left:12px;width:auto;bottom:calc(72px + env(safe-area-inset-bottom, 0px) + 76px);height:min(520px, calc(100vh - 170px))}}";

  document.head.appendChild(style);

  var host = document.createElement("div");
  host.id = "rtxchat-wrap";
  host.innerHTML =
    '<div id="rtxchat-panel" role="dialog" aria-label="RTX Fury assistant">' +
    '  <div id="rtxchat-head"><span class="dot"></span><div class="t"><b>RTX Fury Assistant</b><span>AI support · answers instantly</span></div>' +
    '    <button id="rtxchat-clear" title="Clear conversation">Clear</button>' +
    '    <button id="rtxchat-close" title="Close">&#10005;</button></div>' +
    '  <div id="rtxchat-msgs"></div>' +
    '  <div id="rtxchat-inputrow"><textarea id="rtxchat-in" rows="1" placeholder="Ask about the patcher, tiers, uploads…"></textarea>' +
    '    <button id="rtxchat-send">Send</button></div>' +
    '</div>' +
    '<button id="rtxchat-btn" aria-label="Open chat"><svg viewBox="0 0 24 24"><path d="M12 3C6.48 3 2 6.94 2 11.8c0 2.6 1.3 4.94 3.4 6.5L5 22l4.2-2.2c.9.2 1.85.34 2.8.34 5.52 0 10-3.94 10-8.8S17.52 3 12 3z"/></svg><span class="rtxchat-label">Chat</span></button>';

  document.body.appendChild(host);

  var panel = document.getElementById("rtxchat-panel");
  var msgs = document.getElementById("rtxchat-msgs");
  var input = document.getElementById("rtxchat-in");
  var sendBtn = document.getElementById("rtxchat-send");
  var btn = document.getElementById("rtxchat-btn");
  var busy = false;

  function bubble(role, text) {
    var m = document.createElement("div");
    m.className = "rtxchat-m " + (role === "user" ? "user" : (role === "err" ? "err" : "ai"));
    // Plain text only - URLs render as normal visible text (no hyperlinks).
    m.textContent = String(text);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(hist.slice(-MAX_STORE))); } catch (e) {}
  }

  var FAQS = [
    "What does the RTX Engine Optimizer actually do?",
    "TikTok still compressed my video. Why?",
    "What formats work best?",
    "What's the recommended bitrate?",
    "How do I upload TikTok videos with 4K quality?",
    "How do I upload TikTok videos without compression?"
  ];

  function renderOpeningFaqs() {
    var old = document.getElementById("rtxchat-faqs");
    if (old) old.remove();
    var wrap = document.createElement("div");
    wrap.className = "rtxchat-faqs";
    wrap.id = "rtxchat-faqs";
    FAQS.forEach(function (q) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rtxchat-chip";
      b.textContent = q;
      b.addEventListener("click", function () {
        input.value = q;
        send();
      });
      wrap.appendChild(b);
    });
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function welcome() {
    if (!hist.length && !msgs.children.length) {
      bubble("ai", "👋 Hey! I'm the RTX Fury assistant. Ask me anything, or tap a question below:");
    }
    renderOpeningFaqs(); // ALWAYS show the FAQ questions on every open, even with history
  }

  btn.addEventListener("click", function () {
    var open = panel.classList.toggle("open");
    btn.style.display = open ? "none" : "flex";
    if (open) { welcome(); input.focus(); }
  });
  document.getElementById("rtxchat-close").addEventListener("click", function () {
    panel.classList.remove("open");
    btn.style.display = "flex";
  });
  document.getElementById("rtxchat-clear").addEventListener("click", function () {
    hist = [];
    save();
    msgs.innerHTML = "";
    welcome();
  });

  function askedQuestions() {
    var asked = {};
    hist.forEach(function (m) {
      if (m && m.role === "user") {
        var n = m.content.toLowerCase();
        FAQS.forEach(function (q) {
          if (n.indexOf(q.toLowerCase()) !== -1) asked[q] = true;
        });
      }
    });
    return asked;
  }

  function renderSuggestions() {
    var asked = askedQuestions();
    var pool = FAQS.filter(function (q) { return !asked[q]; });
    var picks = pool.length ? pool.slice(0, 4) : FAQS.slice(0, 4);
    var wrap = document.createElement("div");
    wrap.className = "rtxchat-suggest";
    picks.forEach(function (q) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rtxchat-chip";
      b.textContent = q;
      b.addEventListener("click", function () {
        input.value = q;
        send();
      });
      wrap.appendChild(b);
    });
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function send() {
    var text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    var olds = msgs.querySelectorAll(".rtxchat-suggest");
    for (var i = 0; i < olds.length; i++) olds[i].remove();
    hist.push({ role: "user", content: text });
    bubble("user", text);
    var faqBox = document.getElementById("rtxchat-faqs");
    if (faqBox) faqBox.remove();
    input.value = "";
    input.style.height = "auto";
    var typing = document.createElement("div");
    typing.className = "rtxchat-typing";
    typing.innerHTML = "<i></i><i></i><i></i>";
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: hist.slice(-SEND_HIST) })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        typing.remove();
        if (res.ok && res.j.reply) {
          hist.push({ role: "assistant", content: res.j.reply });
          bubble("ai", res.j.reply);
          renderSuggestions();
        } else {
          bubble("err", (res.j && res.j.error) || "Something went wrong. Try again.");
        }
        save();
      })
      .catch(function () {
        typing.remove();
        bubble("err", "Network error — could not reach the chat service. Try again.");
      })
      .finally(function () {
        busy = false;
        sendBtn.disabled = false;
        input.focus();
      });
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 96) + "px";
  });
})();
