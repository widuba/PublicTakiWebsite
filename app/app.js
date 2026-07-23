/* Taki web — standalone chat client for the Taki server.
   No framework, no phone-app code: identity + reset-epoch handshake, chat with
   history and conversation context, minimal markdown rendering. */
(function () {
  "use strict";

  var API_BASE = "https://takiaiserver.onrender.com";
  var LS_AUTH = "taki-web-auth-v1";
  var LS_EPOCH = "taki-web-reset-epoch";
  var LS_CHATS = "taki-web-chats-v1";
  var LS_ACTIVE = "taki-web-active-chat";

  // ---- State ----
  var chats = load(LS_CHATS, []);
  var activeId = localStorage.getItem(LS_ACTIVE) || "";
  // Chatting requires a verified Apple/Google account: { identity, email, name }.
  // The identity is the server-verified stable account id — free monthly credits
  // attach to it, so clearing this storage just means signing in again.
  var auth = load(LS_AUTH, null);
  var sending = false;

  // ---- Elements ----
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), main = $("main"), messagesEl = $("messages"), scrollEl = $("scroll");
  var input = $("input"), sendBtn = $("sendBtn"), composer = $("composer");
  var historyEl = $("history"), footMeta = $("footMeta"), topbarTitle = $("topbarTitle");
  var gate = $("gate"), gateError = $("gateError"), accountEl = $("account"), accountEmail = $("accountEmail");

  // ================= Networking =================

  function resetEpoch() { return localStorage.getItem(LS_EPOCH) || "0"; }

  function apiFetch(path, options) {
    options = options || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    headers["X-Taki-Reset-Epoch"] = resetEpoch();
    return fetch(API_BASE + path, Object.assign({}, options, { headers: headers }));
  }

  // Learn the server's current reset generation so requests aren't rejected.
  function syncResetEpoch() {
    return fetch(API_BASE + "/health", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (h) {
        var epoch = Math.floor(Number((h && h.resetEpoch) || 0));
        if (epoch > 0) localStorage.setItem(LS_EPOCH, String(epoch));
      })
      .catch(function () { /* offline — the chat call will surface it */ });
  }

  // ================= Sign-in (required to chat) =================

  function setAuth(next) {
    auth = next;
    if (next) save(LS_AUTH, next);
    else { try { localStorage.removeItem(LS_AUTH); } catch (e) {} }
    renderAuth();
  }

  function renderAuth() {
    gate.hidden = Boolean(auth);
    accountEl.hidden = !auth;
    if (auth) accountEmail.textContent = auth.email || auth.name || "Signed in";
    updateSendState();
  }

  function showGateError(message) {
    gateError.textContent = message;
    gateError.hidden = false;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = function () { reject(new Error("failed " + src)); };
      document.head.appendChild(s);
    });
  }

  function completeSignIn(path, idToken, button) {
    gateError.hidden = true;
    return apiFetch(path, { method: "POST", body: JSON.stringify({ idToken: idToken }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.identity) {
          showGateError(res.data.error || "Sign-in didn't go through. Please try again.");
          return;
        }
        setAuth({ identity: res.data.identity, email: res.data.email || "", name: res.data.name || "" });
        if (res.data.credits) renderCredits(res.data.credits);
        input.focus();
      })
      .catch(function () { showGateError("Couldn't reach Taki to verify the sign-in. Check your connection."); });
  }

  // Providers come from the server (client ids are public; config lives in env).
  function initSignIn() {
    apiFetch("/api/web/auth/config").then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
      if (!cfg || (!cfg.google && !cfg.apple)) {
        showGateError("Sign-in isn't available yet. Please try again later.");
        return;
      }
      if (cfg.google) {
        loadScript("https://accounts.google.com/gsi/client").then(function () {
          var mount = $("googleSignIn");
          mount.hidden = false;
          window.google.accounts.id.initialize({
            client_id: cfg.google.clientId,
            callback: function (resp) { completeSignIn("/api/web/auth/google", resp.credential); }
          });
          window.google.accounts.id.renderButton(mount, {
            theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "filled_black" : "outline",
            size: "large", shape: "pill", text: "continue_with", width: 300
          });
        }).catch(function () { /* Google SDK unreachable — Apple may still work */ });
      }
      if (cfg.apple) {
        loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js").then(function () {
          var btn = $("appleSignIn");
          btn.hidden = false;
          window.AppleID.auth.init({
            clientId: cfg.apple.servicesId,
            scope: "name email",
            redirectURI: window.location.origin + "/app/",
            usePopup: true
          });
          btn.addEventListener("click", function () {
            window.AppleID.auth.signIn().then(function (resp) {
              var token = resp && resp.authorization && resp.authorization.id_token;
              if (token) completeSignIn("/api/web/auth/apple", token);
              else showGateError("Apple didn't return a sign-in token. Please try again.");
            }).catch(function () { /* user closed the popup */ });
          });
        }).catch(function () { /* Apple SDK unreachable */ });
      }
    }).catch(function () { showGateError("Couldn't load sign-in options. Check your connection and refresh."); });
  }

  function signOut() {
    setAuth(null);
    footMeta.textContent = "";
    initSignIn();
  }

  function refreshCredits() {
    if (!auth) return;
    apiFetch("/api/credits?deviceId=" + encodeURIComponent(auth.identity))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { if (c) renderCredits(c); })
      .catch(function () {});
  }

  function askAssistant(text, historyForContext) {
    var tz;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = undefined; }
    var context = JSON.stringify({
      chatMessages: historyForContext.slice(-24).map(function (m) {
        return { role: m.role, text: m.content };
      })
    });
    var body = {
      message: text,
      context: context,
      timeZone: tz,
      deviceId: auth ? auth.identity : "",
      // A light default persona so replies read naturally; the app owns real personalization.
      profile: { personality: "friendly", personaIntensity: 5, responseLength: "balanced", emoji: "some" },
      voiceMode: false
    };
    return apiFetch("/api/assistant", { method: "POST", body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { status: r.status, ok: r.ok, data: data };
        });
      });
  }

  // ================= Chat model =================

  function activeChat() {
    for (var i = 0; i < chats.length; i++) if (chats[i].id === activeId) return chats[i];
    return null;
  }
  function persist() {
    save(LS_CHATS, chats);
    localStorage.setItem(LS_ACTIVE, activeId);
  }
  function newChat() {
    activeId = "";
    render();
    input.focus();
    closeSidebar();
  }
  function openChat(id) {
    activeId = id;
    persist();
    render();
    closeSidebar();
  }
  function deleteChat(id) {
    chats = chats.filter(function (c) { return c.id !== id; });
    if (activeId === id) activeId = "";
    persist();
    render();
  }
  function titleFrom(text) {
    var t = text.trim().replace(/\s+/g, " ");
    return t.length > 40 ? t.slice(0, 40) + "…" : t;
  }

  // ================= Rendering =================

  function render() {
    renderHistory();
    var chat = activeChat();
    if (!chat || !chat.messages.length) {
      main.classList.add("is-empty");
      messagesEl.innerHTML = "";
      topbarTitle.textContent = "Taki";
    } else {
      main.classList.remove("is-empty");
      topbarTitle.textContent = chat.title || "Taki";
      renderMessages(chat);
    }
    updateSendState();
  }

  function renderHistory() {
    historyEl.innerHTML = "";
    if (!chats.length) {
      var empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No conversations yet.";
      historyEl.appendChild(empty);
      return;
    }
    chats.forEach(function (c) {
      var item = document.createElement("button");
      item.className = "history-item" + (c.id === activeId ? " active" : "");
      item.type = "button";
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = c.title || "New chat";
      item.appendChild(label);
      var del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.setAttribute("aria-label", "Delete conversation");
      del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.addEventListener("click", function (e) { e.stopPropagation(); deleteChat(c.id); });
      item.appendChild(del);
      item.addEventListener("click", function () { openChat(c.id); });
      historyEl.appendChild(item);
    });
  }

  function renderMessages(chat) {
    messagesEl.innerHTML = "";
    chat.messages.forEach(function (m) { messagesEl.appendChild(messageNode(m)); });
    scrollToBottom();
  }

  function messageNode(m) {
    var row = document.createElement("div");
    row.className = "row " + m.role;
    if (m.role === "user") {
      var b = document.createElement("div");
      b.className = "bubble-user";
      b.textContent = m.content;
      row.appendChild(b);
    } else {
      var wrap = document.createElement("div");
      wrap.className = "assistant-wrap";
      var av = document.createElement("div");
      av.className = "avatar";
      var body = document.createElement("div");
      body.className = "assistant-body";
      if (m.pending) {
        body.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
      } else if (m.error) {
        body.innerHTML = '<div class="notice error"></div>';
        body.querySelector(".notice").textContent = m.content;
      } else {
        body.innerHTML = renderMarkdown(m.content);
        if (m.sources && m.sources.length) body.appendChild(sourcesNode(m.sources));
      }
      wrap.appendChild(av);
      wrap.appendChild(body);
      row.appendChild(wrap);
    }
    return row;
  }

  function sourcesNode(sources) {
    var wrap = document.createElement("div");
    wrap.className = "sources";
    sources.slice(0, 5).forEach(function (s) {
      var url = typeof s === "string" ? s : (s && (s.url || s.link)) || "";
      if (!url) return;
      var a = document.createElement("a");
      a.className = "source-pill";
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      var label = (typeof s === "object" && (s.title || s.name)) || hostOf(url);
      a.textContent = label;
      wrap.appendChild(a);
    });
    return wrap;
  }

  function renderCredits(c) {
    if (!c || typeof c.balance !== "number") return;
    var plan = c.tier === "pro" ? "Pro" : c.tier === "plus_voice" ? "Plus Voice" : c.tier === "plus" ? "Plus" : "free · 250/month";
    footMeta.textContent = c.balance.toLocaleString() + " credits · " + plan;
  }

  function scrollToBottom() { scrollEl.scrollTop = scrollEl.scrollHeight; }

  // ================= Sending =================

  function updateSendState() { sendBtn.disabled = sending || !auth || !input.value.trim(); }

  function submit() {
    var text = input.value.trim();
    if (!text || sending) return;
    if (!auth) { gate.hidden = false; return; }

    var chat = activeChat();
    if (!chat) {
      chat = { id: "c" + Date.now() + Math.random().toString(36).slice(2, 6), title: titleFrom(text), messages: [] };
      chats.unshift(chat);
      activeId = chat.id;
    }
    if (!chat.title || chat.title === "New chat") chat.title = titleFrom(text);

    chat.messages.push({ role: "user", content: text });
    var pending = { role: "assistant", content: "", pending: true };
    chat.messages.push(pending);
    input.value = "";
    autoGrow();
    sending = true;
    persist();
    render();

    var contextHistory = chat.messages.filter(function (m) { return !m.pending; });
    askAssistant(text, contextHistory).then(function (res) {
      finishPending(chat, pending, res);
    }).catch(function () {
      finishPending(chat, pending, { status: 0, ok: false, data: {} });
    });
  }

  function finishPending(chat, pending, res) {
    sending = false;
    var data = res.data || {};
    pending.pending = false;

    if (res.status === 401) {
      // The server no longer recognizes this account (e.g. a full reset).
      // Re-verifying with the provider restores it — same identity, same credits.
      pending.error = true;
      pending.content = "Please sign in again to keep chatting.";
      setAuth(null);
      initSignIn();
    } else if (res.status === 428 || data.code === "reset_required") {
      // Server was reset — adopt the new generation and ask the user to retry.
      if (data.resetEpoch) localStorage.setItem(LS_EPOCH, String(data.resetEpoch));
      pending.error = true;
      pending.content = "Taki was just updated. Please send that again.";
    } else if (data.usageBlocked) {
      pending.error = true;
      pending.content = "You've used your free credits for now. They refresh monthly — or get the iOS app for more.";
    } else if (data.serviceUnavailable) {
      pending.error = true;
      pending.content = data.spokenText || "Taki is temporarily unavailable. Please try again shortly.";
    } else if (!res.ok && !data.spokenText) {
      pending.error = true;
      pending.content = res.status === 0
        ? "Couldn't reach Taki. Check your connection and try again."
        : "Something went wrong. Please try again.";
    } else {
      pending.content = (data.spokenText || data.text || "").trim() || "…";
      var srcs = Array.isArray(data.sources) ? data.sources : null;
      if (srcs && srcs.length) pending.sources = srcs;
    }

    persist();
    render();
    refreshCredits();
  }

  // ================= Markdown (minimal, safe) =================

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, function (_, c) { return "<code>" + c + "</code>"; })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }
  function renderMarkdown(raw) {
    var text = escapeHtml(String(raw || ""));
    var out = [];
    var lines = text.split("\n");
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push("<pre><code>" + code.join("\n") + "</code></pre>");
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          ul.push("<li>" + inline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>"); i++;
        }
        out.push("<ul>" + ul.join("") + "</ul>");
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          ol.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>"); i++;
        }
        out.push("<ol>" + ol.join("") + "</ol>");
        continue;
      }
      if (line.trim() === "") { i++; continue; }
      var para = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !/^(```|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push("<p>" + inline(para.join("<br>")) + "</p>");
    }
    return out.join("");
  }

  // ================= Helpers =================

  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return url; } }
  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function autoGrow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; }
  function openSidebar() { app.classList.add("sidebar-open"); }
  function closeSidebar() { app.classList.remove("sidebar-open"); }

  // ================= Events =================

  composer.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  input.addEventListener("input", function () { autoGrow(); updateSendState(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $("newChat").addEventListener("click", newChat);
  $("menuBtn").addEventListener("click", openSidebar);
  $("sidebarClose").addEventListener("click", closeSidebar);
  $("scrim").addEventListener("click", closeSidebar);
  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (chip) {
    chip.addEventListener("click", function () { input.value = chip.textContent; autoGrow(); updateSendState(); submit(); });
  });

  $("signOut").addEventListener("click", signOut);

  // ================= Boot =================

  render();
  renderAuth();
  syncResetEpoch().then(function () {
    if (auth) refreshCredits();
    else initSignIn();
  });
  if (auth) input.focus();
})();
