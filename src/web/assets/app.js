// SecChat web client — vanilla JS, no framework, no build step, no external requests
// (air-gapped: everything this file needs ships in these three files).
//
// Layout of this file:
//   1. Constants + state
//   2. DOM refs
//   3. Small DOM / formatting helpers (el() is the ONLY node constructor used anywhere below;
//      it sets text via textContent/createTextNode — never innerHTML — so server- or
//      user-supplied strings (message content, channel/agent names, grant reasons, tool ids…)
//      can never be interpreted as markup.)
//   4. Toasts + the name-prompt modal
//   5. fetchJson — the one place a bearer token is attached to a request
//   6. Per-channel state accessors (messages / transcript / classification)
//   7. Render functions (sidebar, header, coding strip, message list)
//   8. WebSocket manager (connect/subscribe/reconnect + event routing)
//   9. Actions (load channels, select a channel, send, create channel/agent, grant execute)
//  10. Auth (dev sign-in, session restore, logout)
//  11. Event wiring + init
//
// THE API CONTRACT this client was built against (see the task brief): GET /me; GET/POST
// /channels; GET/POST /channels/:id/messages; POST /agents; POST /sessions/:id/grant-execute;
// and a WS event stream of {message}/{assistant_delta}/{agent_output}/{tool_decision}/
// {session_ended} frames. Notably NOT in that contract (so NOT used here, even though a couple
// of them exist in the current backend source): GET /channels/:id/members, GET /agents, GET
// /sessions/:id, POST /sessions/:id/input. See the final report for what that means in practice
// (mainly: this client cannot forward chat text to a coding agent's runner, and can only tell an
// "assistant" agent channel apart from a "coding" agent channel once it has seen either an
// agent-authored chat message or a runner/session event for it).

(function () {
  "use strict";

  // ── 1. Constants + state ────────────────────────────────────────────────

  var STORAGE_KEY_TOKEN = "secchat.devToken";
  var USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function ApiError(message, status, body) {
    Error.call(this, message);
    this.name = "ApiError";
    this.message = message;
    this.status = status;
    this.body = body;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var state = {
    token: null,
    me: null, // { sub, groups }
    channels: [], // [{id, kind, name}], sidebar order
    selectedChannelId: null,

    channelMeta: new Map(), // channelId -> { agentKind?, agentId?, sessionId?, ended? }
    messagesByChannel: new Map(), // channelId -> Message[]
    renderedIdsByChannel: new Map(), // channelId -> Set<messageId> (dedupes POST-echo vs WS)
    transcriptByChannel: new Map(), // channelId -> entry[] (agent_output/tool_decision/system)

    agentIdToChannelId: new Map(),
    sessionIdToChannelId: new Map(),
    agentNames: new Map(), // agentId -> friendly name (known only when created this session)

    streaming: new Map(), // "channelId::agentId" -> { agentId, text, started, el, textEl }
  };

  // ── 2. DOM refs ──────────────────────────────────────────────────────────

  var loginScreen = document.getElementById("login-screen");
  var loginForm = document.getElementById("login-form");
  var loginUsernameInput = document.getElementById("login-username");
  var loginAdminInput = document.getElementById("login-admin");
  var loginSubmitBtn = document.getElementById("login-submit");
  var loginErrorEl = document.getElementById("login-error");

  var appScreen = document.getElementById("app-screen");
  var connIndicator = document.getElementById("conn-indicator");
  var connDot = document.getElementById("conn-dot");
  var connLabel = document.getElementById("conn-label");

  var userAvatarEl = document.getElementById("user-avatar");
  var userNameEl = document.getElementById("user-name");
  var userGroupsEl = document.getElementById("user-groups");
  var logoutBtn = document.getElementById("logout-btn");

  var newChannelBtn = document.getElementById("new-channel-btn");
  var newAssistantBtn = document.getElementById("new-assistant-btn");
  var newCodingBtn = document.getElementById("new-coding-btn");
  var channelListEl = document.getElementById("channel-list");

  var noChannelState = document.getElementById("no-channel-state");
  var channelView = document.getElementById("channel-view");

  var channelKindBadge = document.getElementById("channel-kind-badge");
  var channelNameEl = document.getElementById("channel-name");
  var channelIdLabel = document.getElementById("channel-id-label");

  var codingStripEl = document.getElementById("coding-strip");
  var sessionStatusLabel = document.getElementById("session-status-label");
  var grantExecuteBtn = document.getElementById("grant-execute-btn");
  var grantFlashEl = document.getElementById("grant-flash");

  var messagesEl = document.getElementById("messages");

  var composerForm = document.getElementById("composer-form");
  var composerInput = document.getElementById("composer-input");
  var composerSend = document.getElementById("composer-send");

  var modalOverlay = document.getElementById("modal-overlay");
  var modalTitle = document.getElementById("modal-title");
  var modalDesc = document.getElementById("modal-desc");
  var modalInput = document.getElementById("modal-input");
  var modalErrorEl = document.getElementById("modal-error");
  var modalCancel = document.getElementById("modal-cancel");
  var modalConfirm = document.getElementById("modal-confirm");

  var toastStack = document.getElementById("toast-stack");

  // ── 3. DOM / formatting helpers ─────────────────────────────────────────

  /** The only DOM-construction primitive used in this file. Text is always set via
   * textContent/createTextNode (never innerHTML), so any dynamic string — message content,
   * channel/agent names, grant reasons, tool ids — is always treated as plain text. */
  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === undefined || value === null || value === false) return;
        if (key === "class") node.className = value;
        else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
        else if (key.indexOf("on") === 0 && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var now = new Date();
    var time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === now.toDateString()) return time;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + time;
  }

  function initialOf(text) {
    var s = String(text || "").trim();
    for (var i = 0; i < s.length; i++) {
      if (/[a-zA-Z0-9]/.test(s[i])) return s[i].toUpperCase();
    }
    return "?";
  }

  /** A stable, deterministic color for an id/name — so the same user or agent always gets the
   * same avatar color, with no server-side avatar data or external asset needed. */
  function colorForId(id) {
    var s = String(id || "");
    var hash = 0;
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return "hsl(" + (hash % 360) + ", 42%, 40%)";
  }

  function avatarNode(idForColor, label) {
    return el("span", { class: "avatar", style: { backgroundColor: colorForId(idForColor) } }, initialOf(label));
  }

  /** Friendly agent name if we've learned one (only possible for agents this browser session
   * spawned, or ones classified from a chat message — see markChannelAgentKind); otherwise the
   * raw agent id, flagged `mono` per the "monospace for ids" design rule so it visibly reads as
   * an id rather than a name. */
  function resolveAgentLabel(agentId) {
    var name = state.agentNames.get(agentId);
    return name ? { text: name, mono: false } : { text: agentId, mono: true };
  }

  // ── 4. Toasts + the name-prompt modal ───────────────────────────────────

  function showToast(message, kind) {
    var toast = el("div", { class: "toast toast-" + (kind || "info") }, message);
    toastStack.appendChild(toast);
    setTimeout(function () {
      toast.classList.add("fade-out");
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }, 4200);
  }

  var modalResolve = null;

  /** Styled, self-contained replacement for window.prompt() — used for "name this
   * channel/assistant/coding agent". A native prompt() is avoided: it breaks the dark theme and
   * is unreliable (often suppressed or auto-dismissed) under automated/screenshot tooling. */
  function showPrompt(opts) {
    modalTitle.textContent = opts.title || "";
    if (opts.desc) {
      modalDesc.textContent = opts.desc;
      modalDesc.classList.remove("hidden");
    } else {
      modalDesc.textContent = "";
      modalDesc.classList.add("hidden");
    }
    modalInput.value = "";
    modalInput.placeholder = opts.placeholder || "";
    modalConfirm.textContent = opts.confirmLabel || "Create";
    hideModalError();
    modalOverlay.classList.remove("hidden");
    modalInput.focus();
    return new Promise(function (resolve) {
      modalResolve = resolve;
    });
  }

  function closeModal(result) {
    modalOverlay.classList.add("hidden");
    if (modalResolve) {
      var resolve = modalResolve;
      modalResolve = null;
      resolve(result);
    }
  }

  function handleModalConfirm() {
    var value = modalInput.value.trim();
    if (!value) {
      showModalError("A name is required.");
      return;
    }
    closeModal(value);
  }

  function showModalError(msg) {
    modalErrorEl.textContent = msg;
    modalErrorEl.classList.remove("hidden");
  }
  function hideModalError() {
    modalErrorEl.textContent = "";
    modalErrorEl.classList.add("hidden");
  }

  // ── 5. fetchJson ─────────────────────────────────────────────────────────

  /** The one place a bearer token gets attached to a request. Pass `token` explicitly only for
   * the pre-login /me check; every other call rides on state.token. Throws ApiError (with the
   * parsed body, when there was one) on any non-2xx response or network failure. */
  function fetchJson(path, options) {
    options = options || {};
    var token = "token" in options ? options.token : state.token;
    var headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;

    var fetchOpts = { method: options.method, body: options.body, headers: headers };

    return fetch(path, fetchOpts)
      .catch(function () {
        throw new ApiError("network error — is the server reachable?", 0, null);
      })
      .then(function (res) {
        return res.text().then(function (raw) {
          var body = null;
          if (raw) {
            try {
              body = JSON.parse(raw);
            } catch (e) {
              body = null;
            }
          }
          if (!res.ok) {
            var message = (body && typeof body.error === "string" && body.error) || res.status + " " + (res.statusText || "request failed");
            throw new ApiError(message, res.status, body);
          }
          return body;
        });
      });
  }

  // ── 6. Per-channel state accessors ──────────────────────────────────────

  function rememberChannel(channelId) {
    if (!state.messagesByChannel.has(channelId)) state.messagesByChannel.set(channelId, []);
    if (!state.renderedIdsByChannel.has(channelId)) state.renderedIdsByChannel.set(channelId, new Set());
    if (!state.transcriptByChannel.has(channelId)) state.transcriptByChannel.set(channelId, []);
    if (!state.channelMeta.has(channelId)) state.channelMeta.set(channelId, {});
  }
  function getMessages(channelId) { rememberChannel(channelId); return state.messagesByChannel.get(channelId); }
  function getRenderedIds(channelId) { rememberChannel(channelId); return state.renderedIdsByChannel.get(channelId); }
  function getTranscript(channelId) { rememberChannel(channelId); return state.transcriptByChannel.get(channelId); }
  function getChannelMeta(channelId) { rememberChannel(channelId); return state.channelMeta.get(channelId); }

  function hasActiveStreaming(channelId) {
    var keys = state.streaming.keys();
    var next = keys.next();
    while (!next.done) {
      if (next.value.indexOf(channelId + "::") === 0) return true;
      next = keys.next();
    }
    return false;
  }

  /** "coding" is sticky once learned (it's the more consequential classification — it gates the
   * execute strip); an "assistant" signal never downgrades a channel already known "coding". */
  function markChannelAgentKind(channelId, kind) {
    var meta = getChannelMeta(channelId);
    if (meta.agentKind === "coding" || meta.agentKind === kind) return;
    meta.agentKind = kind;
    renderSidebarChannelList();
    if (state.selectedChannelId === channelId) {
      renderChannelHeader();
      updateCodingStripState();
    }
  }

  function setChannelSessionId(channelId, sessionId) {
    var meta = getChannelMeta(channelId);
    if (meta.sessionId === sessionId) return;
    meta.sessionId = sessionId;
    if (state.selectedChannelId === channelId) updateCodingStripState();
  }

  function clearStreamingBubble(channelId, agentId) {
    var key = channelId + "::" + agentId;
    var bubble = state.streaming.get(key);
    if (!bubble) return;
    if (bubble.el && bubble.el.parentNode) bubble.el.parentNode.removeChild(bubble.el);
    state.streaming.delete(key);
  }

  // ── 7. Render functions ─────────────────────────────────────────────────

  function badgeInfoForChannel(channel, meta) {
    if (channel.kind === "dm") return { cls: "badge-dm", label: "dm", glyph: "@" };
    if (channel.kind === "human") return { cls: "badge-human", label: "channel", glyph: "#" };
    if (meta && meta.agentKind === "coding") return { cls: "badge-coding", label: "coding", glyph: "</>" };
    if (meta && meta.agentKind === "assistant") return { cls: "badge-assistant", label: "assistant", glyph: "✦" };
    return { cls: "badge-agent", label: "agent", glyph: "✦" };
  }

  function renderSidebarChannelList() {
    clearNode(channelListEl);
    if (state.channels.length === 0) {
      channelListEl.appendChild(el("div", { class: "channel-list-empty" }, "No channels yet — create one above."));
      return;
    }
    state.channels.forEach(function (channel) {
      var meta = getChannelMeta(channel.id);
      var info = badgeInfoForChannel(channel, meta);
      var isActive = channel.id === state.selectedChannelId;
      channelListEl.appendChild(
        el(
          "button",
          { class: "channel-item" + (isActive ? " active" : ""), type: "button", onClick: function () { selectChannel(channel.id); } },
          el("span", { class: "channel-item-glyph" }, info.glyph),
          el("span", { class: "channel-item-name" }, channel.name || "(unnamed)"),
          el("span", { class: "badge " + info.cls }, info.label)
        )
      );
    });
  }

  function renderChannelHeader() {
    var channelId = state.selectedChannelId;
    var channel = null;
    for (var i = 0; i < state.channels.length; i++) {
      if (state.channels[i].id === channelId) { channel = state.channels[i]; break; }
    }
    if (!channel) return;
    var meta = getChannelMeta(channelId);
    var info = badgeInfoForChannel(channel, meta);
    channelKindBadge.className = "badge " + info.cls;
    channelKindBadge.textContent = info.label;
    channelNameEl.textContent = channel.name || "(unnamed channel)";
    channelIdLabel.textContent = channelId;
  }

  function updateCodingStripState() {
    var channelId = state.selectedChannelId;
    var meta = channelId ? getChannelMeta(channelId) : null;
    var isCoding = !!(meta && meta.agentKind === "coding");
    codingStripEl.classList.toggle("hidden", !isCoding);
    if (!isCoding) return;

    var hasSession = !!meta.sessionId;
    grantExecuteBtn.disabled = !hasSession || !!meta.ended;
    grantExecuteBtn.title = meta.ended
      ? "This session has ended."
      : hasSession
        ? "Authorize one mutating tool call for this session."
        : "Session id for this coding agent isn't known in this browser session (it wasn't created here).";

    var statusText = meta.ended ? "session ended" : hasSession ? "session active" : "session id unknown";
    sessionStatusLabel.textContent = hasSession ? statusText + " · " + meta.sessionId.slice(0, 8) + "…" : statusText;
  }

  function createMessageNode(message) {
    var isAgent = message.authorType === "agent";
    var isMine = !isAgent && state.me && message.authorRef === state.me.sub;
    var isRedacted = message.content === undefined;

    var authorText, authorMono;
    if (isAgent) {
      var label = resolveAgentLabel(message.authorRef);
      authorText = label.text;
      authorMono = label.mono;
    } else {
      authorText = message.authorRef;
      authorMono = false;
    }

    var authorClasses = "msg-author" + (isMine ? " msg-author-you" : "") + (authorMono ? " mono" : "");
    var authorNode = el("span", { class: authorClasses }, authorText + (isMine ? " (you)" : ""));
    var timeNode = el("span", { class: "msg-time" }, formatTime(message.createdAt));
    var head = el("div", { class: "msg-head" }, authorNode, timeNode);

    var textNode = el("div", { class: "msg-text" }, isRedacted ? "[message redacted]" : message.content);
    var body = el("div", { class: "msg-body" }, head, textNode);
    var avatar = avatarNode(message.authorRef, isAgent ? authorText : message.authorRef);

    var rowClasses = "msg" + (isAgent ? " msg-agent" : "") + (isRedacted ? " msg-redacted" : "");
    return el("div", { class: rowClasses }, el("div", { class: "msg-avatar" }, avatar), body);
  }

  function createStreamingBubbleNode(agentId) {
    var label = resolveAgentLabel(agentId);
    var authorNode = el("span", { class: "msg-author" + (label.mono ? " mono" : "") }, label.text);
    var timeNode = el("span", { class: "msg-time" }, "now");
    var head = el("div", { class: "msg-head" }, authorNode, timeNode);
    var textNode = el("div", { class: "msg-text" }, el("span", { class: "typing-dots" }, el("span"), el("span"), el("span")));
    var body = el("div", { class: "msg-body" }, head, textNode);
    var avatar = avatarNode(agentId, label.text);
    var root = el("div", { class: "msg msg-agent msg-streaming" }, el("div", { class: "msg-avatar" }, avatar), body);
    return { el: root, textEl: textNode };
  }

  function createOutputNode(entry) {
    return el("div", { class: "entry-output" }, el("span", { class: "entry-output-label" }, "agent output"), entry.text);
  }

  function createDecisionNode(entry) {
    var cls = "entry-decision " + (entry.allow ? "entry-decision-allow" : "entry-decision-deny");
    return el(
      "div",
      { class: cls },
      el("span", { class: "pill " + (entry.allow ? "pill-ok" : "pill-bad") }, entry.allow ? "ALLOWED" : "DENIED"),
      el("span", { class: "entry-decision-tool mono" }, entry.tool || "unknown tool"),
      el("span", { class: "entry-decision-reason" }, entry.reason || "")
    );
  }

  function createSystemNode(text) {
    return el("div", { class: "entry-system" }, text);
  }

  function createEntryNode(entry) {
    if (entry.kind === "output") return createOutputNode(entry);
    if (entry.kind === "decision") return createDecisionNode(entry);
    return createSystemNode(entry.text);
  }

  function isScrolledNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }
  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function clearEmptyNotice() {
    var notice = messagesEl.querySelector(".messages-empty");
    if (notice) clearNode(messagesEl);
  }
  /** Runs `mutateFn` (an append, or a growing streaming bubble's text update) and keeps the view
   * pinned to the bottom ONLY if the user was already there — so a live update never yanks the
   * viewport out from under someone scrolled up reading history. */
  function withStickyScroll(mutateFn) {
    var wasNearBottom = isScrolledNearBottom();
    mutateFn();
    if (wasNearBottom) scrollMessagesToBottom();
  }
  function appendEntry(node) {
    clearEmptyNotice();
    withStickyScroll(function () { messagesEl.appendChild(node); });
  }

  function appendMessageNode(message) { appendEntry(createMessageNode(message)); }
  function appendOutputNode(entry) { appendEntry(createOutputNode(entry)); }
  function appendDecisionNode(entry) { appendEntry(createDecisionNode(entry)); }
  function appendSystemNode(text) { appendEntry(createSystemNode(text)); }

  /** Full rebuild of the message list for `channelId`: history (from the server) first, then
   * this session's runner-transcript entries in arrival order, then any still-live streaming
   * bubble. Only the relative order BETWEEN chat messages and transcript entries on a revisit
   * (leave-and-return within the same session) is approximate — see the report. */
  function renderMessagesFull(channelId) {
    clearNode(messagesEl);
    var messages = getMessages(channelId);
    var transcript = getTranscript(channelId);

    if (messages.length === 0 && transcript.length === 0 && !hasActiveStreaming(channelId)) {
      messagesEl.appendChild(el("div", { class: "messages-empty" }, "No messages yet — say hello."));
      return;
    }

    messages.forEach(function (m) { messagesEl.appendChild(createMessageNode(m)); });
    transcript.forEach(function (entry) { messagesEl.appendChild(createEntryNode(entry)); });

    state.streaming.forEach(function (bubble, key) {
      if (key.indexOf(channelId + "::") !== 0) return;
      var built = createStreamingBubbleNode(bubble.agentId);
      bubble.el = built.el;
      bubble.textEl = built.textEl;
      if (bubble.started && bubble.text) {
        clearNode(bubble.textEl);
        bubble.textEl.textContent = bubble.text;
      }
      messagesEl.appendChild(bubble.el);
    });

    scrollMessagesToBottom();
  }

  function syncComposerSendState() {
    composerSend.disabled = !composerInput.value.trim();
  }

  function showChannelViewSkeleton() {
    noChannelState.classList.add("hidden");
    channelView.classList.remove("hidden");
    clearNode(messagesEl);
    messagesEl.appendChild(el("div", { class: "messages-empty" }, "Loading…"));
    composerInput.value = "";
    syncComposerSendState();
  }

  function renderUserChip() {
    if (!state.me) return;
    userAvatarEl.textContent = initialOf(state.me.sub);
    userAvatarEl.style.backgroundColor = colorForId(state.me.sub);
    userNameEl.textContent = state.me.sub;
    var groups = state.me.groups || [];
    userGroupsEl.textContent = groups.length ? groups.join(", ") : "no groups";
  }

  // ── 8. WebSocket manager ────────────────────────────────────────────────

  var ws = {
    socket: null,
    subscribed: new Set(), // channelIds we intend to be subscribed to (resent on reconnect)
    manualClose: false,
    reconnectDelay: 1000,
    reconnectTimer: null,
  };

  function wsSetStatus(status) {
    connDot.className = "conn-dot" + (status === "connecting" ? " is-connecting" : status === "connected" ? " is-connected" : status === "down" ? " is-down" : "");
    var labels = { offline: "offline", connecting: "connecting…", connected: "live", down: "reconnecting…" };
    var text = labels[status] || status;
    connLabel.textContent = text;
    connIndicator.title = "Realtime connection: " + text;
  }

  function wsConnect() {
    if (!state.token) return;
    if (ws.socket && (ws.socket.readyState === WebSocket.OPEN || ws.socket.readyState === WebSocket.CONNECTING)) return;
    ws.manualClose = false;
    wsSetStatus("connecting");

    var proto = location.protocol === "https:" ? "wss" : "ws";
    var url = proto + "://" + location.host + "/?token=" + encodeURIComponent(state.token);

    var socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      wsSetStatus("down");
      scheduleReconnect();
      return;
    }
    ws.socket = socket;

    socket.addEventListener("open", function () {
      ws.reconnectDelay = 1000;
      wsSetStatus("connected");
      ws.subscribed.forEach(function (channelId) {
        socket.send(JSON.stringify({ type: "subscribe", channelId: channelId }));
      });
    });

    socket.addEventListener("message", function (evt) {
      var payload;
      try {
        payload = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      handleWsPayload(payload);
    });

    socket.addEventListener("close", function () {
      if (ws.socket === socket) ws.socket = null;
      wsSetStatus(ws.manualClose ? "offline" : "down");
      if (!ws.manualClose && state.token) scheduleReconnect();
    });

    socket.addEventListener("error", function () {
      // The "close" event follows every "error" for a browser WebSocket — nothing extra to do.
    });
  }

  function scheduleReconnect() {
    if (ws.reconnectTimer) return;
    ws.reconnectTimer = setTimeout(function () {
      ws.reconnectTimer = null;
      wsConnect();
    }, ws.reconnectDelay);
    ws.reconnectDelay = Math.min(ws.reconnectDelay * 1.6, 10000);
  }

  function wsSubscribe(channelId) {
    ws.subscribed.add(channelId);
    if (ws.socket && ws.socket.readyState === WebSocket.OPEN) {
      ws.socket.send(JSON.stringify({ type: "subscribe", channelId: channelId }));
    } else {
      wsConnect();
    }
  }

  function wsDisconnect() {
    ws.manualClose = true;
    if (ws.reconnectTimer) { clearTimeout(ws.reconnectTimer); ws.reconnectTimer = null; }
    if (ws.socket) {
      try { ws.socket.close(); } catch (e) { /* already closed */ }
      ws.socket = null;
    }
    ws.subscribed.clear();
    wsSetStatus("offline");
  }

  // Event payloads for everything except `message` carry NO channelId (the hub broadcasts the
  // payload verbatim; only Message rows happen to carry their own channelId field) — so these
  // resolve the target channel via ids we've learned, falling back to whichever channel is
  // currently open. See the file header / final report for what that means in practice.
  function resolveChannelForAgent(agentId) { return state.agentIdToChannelId.get(agentId) || state.selectedChannelId; }
  function resolveChannelForSession(sessionId) { return state.sessionIdToChannelId.get(sessionId) || state.selectedChannelId; }

  function handleWsPayload(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;
    switch (payload.type) {
      case "message": onMessageEvent(payload.message); break;
      case "assistant_delta": onAssistantDelta(payload); break;
      case "assistant_error": onAssistantError(payload); break;
      case "agent_output": onAgentOutput(payload); break;
      case "tool_decision": onToolDecision(payload); break;
      case "session_ended": onSessionEnded(payload); break;
      default: break; // forward-compatible: unknown event types are ignored, not an error
    }
  }

  function onMessageEvent(message) {
    if (!message || !message.channelId) return;
    var channelId = message.channelId;
    rememberChannel(channelId);

    if (message.authorType === "agent") {
      state.agentIdToChannelId.set(message.authorRef, channelId);
      // Only the assistant path ever persists a Message row for an agent (see file header) —
      // seeing one here is a reliable signal, even for a channel we didn't create ourselves.
      markChannelAgentKind(channelId, "assistant");
      clearStreamingBubble(channelId, message.authorRef);
    }

    var ids = getRenderedIds(channelId);
    if (ids.has(message.id)) return; // already shown (we render our own sends immediately)
    ids.add(message.id);
    getMessages(channelId).push(message);

    if (state.selectedChannelId === channelId) appendMessageNode(message);
    else renderSidebarChannelList(); // badge may need to flip agent -> assistant
  }

  function onAssistantDelta(payload) {
    var channelId = resolveChannelForAgent(payload.agentId);
    if (!channelId) return;
    rememberChannel(channelId);
    markChannelAgentKind(channelId, "assistant");
    state.agentIdToChannelId.set(payload.agentId, channelId);

    var key = channelId + "::" + payload.agentId;
    var bubble = state.streaming.get(key);
    var isSelected = state.selectedChannelId === channelId;
    if (!bubble) {
      bubble = { agentId: payload.agentId, text: "", started: false, el: null, textEl: null };
      state.streaming.set(key, bubble);
      if (isSelected) {
        var built = createStreamingBubbleNode(payload.agentId);
        bubble.el = built.el;
        bubble.textEl = built.textEl;
        appendEntry(bubble.el);
      }
    }
    bubble.text += payload.delta || "";
    if (isSelected && bubble.textEl) {
      withStickyScroll(function () {
        if (!bubble.started && bubble.text) {
          clearNode(bubble.textEl);
          bubble.started = true;
        }
        bubble.textEl.textContent = bubble.text;
      });
    }
  }

  function onAssistantError(payload) {
    var channelId = resolveChannelForAgent(payload.agentId);
    // clearStreamingBubble() already removes the bubble's DOM node directly (if it was rendered)
    // — no full re-render needed, and it's a no-op if there was never a bubble for this agent.
    if (channelId) clearStreamingBubble(channelId, payload.agentId);
    showToast("Assistant error: " + (payload.error || "unknown error"), "error");
  }

  function onAgentOutput(payload) {
    var channelId = resolveChannelForSession(payload.sessionId);
    if (!channelId) return;
    rememberChannel(channelId);
    markChannelAgentKind(channelId, "coding");
    if (payload.sessionId) { state.sessionIdToChannelId.set(payload.sessionId, channelId); setChannelSessionId(channelId, payload.sessionId); }

    var entry = { kind: "output", text: payload.text || "" };
    getTranscript(channelId).push(entry);
    if (state.selectedChannelId === channelId) appendOutputNode(entry);
  }

  function onToolDecision(payload) {
    var channelId = resolveChannelForSession(payload.sessionId);
    if (!channelId) return;
    rememberChannel(channelId);
    markChannelAgentKind(channelId, "coding");
    if (payload.sessionId) { state.sessionIdToChannelId.set(payload.sessionId, channelId); setChannelSessionId(channelId, payload.sessionId); }

    var entry = { kind: "decision", tool: payload.tool, allow: !!payload.allow, reason: payload.reason || "" };
    getTranscript(channelId).push(entry);
    if (state.selectedChannelId === channelId) appendDecisionNode(entry);
  }

  function onSessionEnded(payload) {
    var channelId = resolveChannelForSession(payload.sessionId);
    if (!channelId) return;
    rememberChannel(channelId);
    markChannelAgentKind(channelId, "coding");
    getChannelMeta(channelId).ended = true;

    var entry = { kind: "system", text: "Session ended" };
    getTranscript(channelId).push(entry);
    if (state.selectedChannelId === channelId) {
      appendSystemNode(entry.text);
      updateCodingStripState();
    }
  }

  // ── 9. Actions ───────────────────────────────────────────────────────────

  function loadChannels() {
    fetchJson("/channels")
      .then(function (channels) {
        state.channels = (channels || []).map(function (c) { return { id: c.id, kind: c.kind, name: c.name }; });
        state.channels.forEach(function (c) { rememberChannel(c.id); });
        renderSidebarChannelList();
      })
      .catch(function (err) {
        showToast("Failed to load channels: " + err.message, "error");
      });
  }

  function addChannelToSidebar(channel) {
    var exists = state.channels.some(function (c) { return c.id === channel.id; });
    if (!exists) state.channels.push({ id: channel.id, kind: channel.kind, name: channel.name });
    renderSidebarChannelList();
  }

  function selectChannel(channelId) {
    if (state.selectedChannelId === channelId) return;
    state.selectedChannelId = channelId;
    rememberChannel(channelId);
    renderSidebarChannelList();
    showChannelViewSkeleton();
    renderChannelHeader();
    updateCodingStripState();
    composerInput.focus();

    wsSubscribe(channelId);

    fetchJson("/channels/" + encodeURIComponent(channelId) + "/messages")
      .then(function (messages) {
        if (state.selectedChannelId !== channelId) return; // switched away while in flight
        var list = getMessages(channelId);
        list.length = 0;
        var ids = getRenderedIds(channelId);
        ids.clear();
        (messages || []).forEach(function (m) {
          list.push(m);
          ids.add(m.id);
          if (m.authorType === "agent") {
            state.agentIdToChannelId.set(m.authorRef, channelId);
            markChannelAgentKind(channelId, "assistant");
          }
        });
        renderMessagesFull(channelId);
        updateCodingStripState();
      })
      .catch(function (err) {
        if (state.selectedChannelId !== channelId) return;
        showToast("Failed to load messages: " + err.message, "error");
        clearNode(messagesEl);
        messagesEl.appendChild(el("div", { class: "messages-empty" }, "Couldn't load messages."));
      });
  }

  function handleComposerSubmit(evt) {
    evt.preventDefault();
    var channelId = state.selectedChannelId;
    if (!channelId) return;
    var text = composerInput.value.trim();
    if (!text) return;

    composerInput.disabled = true;
    composerSend.disabled = true;
    fetchJson("/channels/" + encodeURIComponent(channelId) + "/messages", {
      method: "POST",
      body: JSON.stringify({ content: text }),
    })
      .then(function (message) {
        var ids = getRenderedIds(channelId);
        if (!ids.has(message.id)) {
          ids.add(message.id);
          getMessages(channelId).push(message);
          if (state.selectedChannelId === channelId) appendMessageNode(message);
        }
        composerInput.value = "";
      })
      .catch(function (err) {
        showToast("Failed to send: " + err.message, "error");
      })
      .then(function () {
        composerInput.disabled = false;
        composerSend.disabled = false;
        syncComposerSendState();
        composerInput.focus();
      });
  }

  function handleNewChannel() {
    showPrompt({
      title: "New channel",
      desc: "You'll be added as its owner; invite others to it later.",
      placeholder: "e.g. project-alpha",
      confirmLabel: "Create channel",
    }).then(function (name) {
      if (name === null) return;
      fetchJson("/channels", { method: "POST", body: JSON.stringify({ name: name }) })
        .then(function (channel) {
          addChannelToSidebar(channel);
          selectChannel(channel.id);
        })
        .catch(function (err) {
          showToast("Failed to create channel: " + err.message, "error");
        });
    });
  }

  function handleNewAgent(kind) {
    var isCoding = kind === "coding";
    showPrompt({
      title: isCoding ? "New coding agent" : "New assistant",
      desc: isCoding
        ? "Runs in plan mode until you grant execute; only you (its owner) can authorize a mutating tool call."
        : "A model-backed assistant, owned by you — its model calls are billed and audited under your account.",
      placeholder: isCoding ? "e.g. build-bot" : "e.g. research-assistant",
      confirmLabel: "Create",
    }).then(function (name) {
      if (name === null) return;
      fetchJson("/agents", { method: "POST", body: JSON.stringify({ kind: kind, name: name }) })
        .then(function (result) {
          var agent = result.agent, channel = result.channel, session = result.session;
          rememberChannel(channel.id);
          state.agentNames.set(agent.id, agent.name || (isCoding ? "coding agent" : "assistant"));
          state.agentIdToChannelId.set(agent.id, channel.id);

          var meta = getChannelMeta(channel.id);
          meta.agentKind = agent.kind; // authoritative: we just created it ourselves
          meta.agentId = agent.id;
          if (session && session.id) {
            meta.sessionId = session.id;
            state.sessionIdToChannelId.set(session.id, channel.id);
            getTranscript(channel.id).push({ kind: "system", text: "Coding agent session started (" + session.id.slice(0, 8) + "…)" });
          }

          addChannelToSidebar(channel);
          selectChannel(channel.id);
        })
        .catch(function (err) {
          showToast("Failed to create " + (isCoding ? "coding agent" : "assistant") + ": " + err.message, "error");
        });
    });
  }

  var grantFlashTimer = null;
  function flashGrantResult(allow, reason) {
    grantFlashEl.className = "grant-flash hidden";
    void grantFlashEl.offsetWidth; // force reflow so the fade animation restarts on repeat clicks
    grantFlashEl.textContent = (allow ? "Granted — " : "Denied — ") + reason;
    grantFlashEl.classList.remove("hidden");
    grantFlashEl.classList.add(allow ? "allow" : "deny");
    if (grantFlashTimer) clearTimeout(grantFlashTimer);
    grantFlashTimer = setTimeout(function () { grantFlashEl.classList.add("hidden"); }, 3300);
  }

  function handleGrantExecute() {
    var channelId = state.selectedChannelId;
    var meta = channelId ? getChannelMeta(channelId) : null;
    var sessionId = meta && meta.sessionId;
    if (!sessionId) {
      showToast("Session id for this coding agent isn't known in this browser session.", "error");
      return;
    }
    grantExecuteBtn.disabled = true;
    fetchJson("/sessions/" + encodeURIComponent(sessionId) + "/grant-execute", {
      method: "POST",
      body: JSON.stringify({ scope: "once" }),
    })
      .then(function (decision) {
        // Only flash/re-sync if the user is still on this channel — they may have switched away
        // while the request was in flight (selectChannel() already re-syncs the strip on switch).
        if (state.selectedChannelId === channelId) flashGrantResult(true, decision.reason || "granted");
      })
      .catch(function (err) {
        if (err instanceof ApiError && err.body && typeof err.body.allow === "boolean") {
          if (state.selectedChannelId === channelId) flashGrantResult(err.body.allow, err.body.reason || "denied");
        } else {
          showToast("Grant execute failed: " + err.message, "error");
        }
      })
      .then(function () {
        if (state.selectedChannelId === channelId) updateCodingStripState(); // clears the disabled state
      });
  }

  // ── 10. Auth ─────────────────────────────────────────────────────────────

  function buildDevToken(username, isAdmin) {
    return "dev." + username + "." + (isAdmin ? "secchat-admins" : "");
  }

  function showLoginError(msg) {
    loginErrorEl.textContent = msg;
    loginErrorEl.classList.remove("hidden");
  }
  function hideLoginError() {
    loginErrorEl.textContent = "";
    loginErrorEl.classList.add("hidden");
  }

  function handleLoginSubmit(evt) {
    evt.preventDefault();
    hideLoginError();
    var username = loginUsernameInput.value.trim();
    var isAdmin = loginAdminInput.checked;

    if (!USERNAME_RE.test(username)) {
      showLoginError("Username must be 1–64 characters: letters, numbers, \"-\" or \"_\" (no dots or spaces).");
      return;
    }

    var token = buildDevToken(username, isAdmin);
    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = "Signing in…";
    fetchJson("/me", { token: token })
      .then(function (me) {
        state.token = token;
        state.me = me;
        try { sessionStorage.setItem(STORAGE_KEY_TOKEN, token); } catch (e) { /* private-mode storage denial: non-fatal */ }
        enterApp();
      })
      .catch(function (err) {
        showLoginError("Sign-in failed: " + err.message);
      })
      .then(function () {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = "Sign in (dev)";
      });
  }

  function restoreSession() {
    var token;
    try { token = sessionStorage.getItem(STORAGE_KEY_TOKEN); } catch (e) { token = null; }
    if (!token) { showLoginScreen(); return; }
    fetchJson("/me", { token: token })
      .then(function (me) {
        state.token = token;
        state.me = me;
        enterApp();
      })
      .catch(function () {
        try { sessionStorage.removeItem(STORAGE_KEY_TOKEN); } catch (e) { /* ignore */ }
        showLoginScreen();
      });
  }

  function enterApp() {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    renderUserChip();
    wsConnect();
    loadChannels();
  }

  function showLoginScreen() {
    appScreen.classList.add("hidden");
    loginScreen.classList.remove("hidden");
    loginUsernameInput.focus();
  }

  function handleLogout() {
    wsDisconnect();
    try { sessionStorage.removeItem(STORAGE_KEY_TOKEN); } catch (e) { /* ignore */ }

    state.token = null;
    state.me = null;
    state.channels = [];
    state.selectedChannelId = null;
    state.channelMeta.clear();
    state.messagesByChannel.clear();
    state.renderedIdsByChannel.clear();
    state.transcriptByChannel.clear();
    state.agentIdToChannelId.clear();
    state.sessionIdToChannelId.clear();
    state.agentNames.clear();
    state.streaming.clear();

    clearNode(channelListEl);
    clearNode(messagesEl);
    noChannelState.classList.remove("hidden");
    channelView.classList.add("hidden");
    loginForm.reset();
    showLoginScreen();
  }

  // ── 11. Event wiring + init ──────────────────────────────────────────────

  loginForm.addEventListener("submit", handleLoginSubmit);
  logoutBtn.addEventListener("click", handleLogout);

  newChannelBtn.addEventListener("click", handleNewChannel);
  newAssistantBtn.addEventListener("click", function () { handleNewAgent("assistant"); });
  newCodingBtn.addEventListener("click", function () { handleNewAgent("coding"); });

  composerForm.addEventListener("submit", handleComposerSubmit);
  composerInput.addEventListener("input", syncComposerSendState);
  // A text input inside a <form> already submits on Enter natively; this listener is a
  // defense-in-depth backstop (some embedded/automated browser contexts don't reliably fire
  // that native behavior) and routes through requestSubmit() so it's still one code path.
  composerInput.addEventListener("keydown", function (evt) {
    if (evt.key !== "Enter") return;
    evt.preventDefault();
    if (typeof composerForm.requestSubmit === "function") composerForm.requestSubmit();
    else handleComposerSubmit(evt);
  });
  grantExecuteBtn.addEventListener("click", handleGrantExecute);

  modalCancel.addEventListener("click", function () { closeModal(null); });
  modalConfirm.addEventListener("click", handleModalConfirm);
  modalInput.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter") { evt.preventDefault(); handleModalConfirm(); }
    else if (evt.key === "Escape") { evt.preventDefault(); closeModal(null); }
  });
  modalOverlay.addEventListener("mousedown", function (evt) {
    if (evt.target === modalOverlay) closeModal(null);
  });

  syncComposerSendState();
  wsSetStatus("offline");
  restoreSession();
})();
