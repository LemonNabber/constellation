/* ==========================================================
   Constellation — an Are.na-powered moodboard + graph tool
   API docs: https://dev.are.na/documentation
   No API key required for the public read/search endpoints.
   ========================================================== */

const API_BASE = "https://api.are.na/v2";       // public read/search — no key needed
const API_V3_BASE = "https://api.are.na/v3";    // used only once the user connects their account
const STORAGE_KEY = "constellation-board-v1";
const GRAPHS_KEY = "constellation-graphs-v1";

// Register a free OAuth application at https://www.are.na/oauth/applications
// and paste its Client ID below. This is a *public* client ID (used with PKCE,
// no client secret), so it is safe to commit — see the README for setup steps.
const ARENA_CLIENT_ID = "qJCcHivRW1W7VohpUzXGN-R52gNdUut3Q5a2zMCA_NE";

/* ---- limits for "graph whole channels" ----
   Are.na's API guidelines ask apps not to bulk-enumerate channels, so whole-channel
   loading only ever runs when the user clicks Load, goes one page at a time with a
   pause between requests, can be stopped mid-way, and is capped per channel. */
const PAGE_SIZE = 100;                  // v3 maximum page size
const REQUEST_DELAY_MS = 400;           // pause between page requests (Are.na suggests 200–500ms)
const MAX_BLOCKS_PER_CHANNEL = 1000;    // safety cap; raise it if you need to, at your own risk
const DENSE_GRAPH_THRESHOLD = 120;      // above this many nodes, block labels show on hover only

let board = loadBoard();          // array of pinned card objects
let currentBlocks = [];           // normalized cards from the last-opened channel

let myChannels = [];              // the connected user's channels (lightweight refs)
let myChannelsHasMore = false;    // true when the account has more channels than we listed
const channelCache = new Map();   // channel id -> { blocks, childChannelIds, total, fetched, nextPage, complete, capped }
let activeLoad = null;            // AbortController while a channel load is running

const initialGraphs = loadGraphs();
let graphs = initialGraphs.graphs;            // [{ id, name, mode, pinIds, channels, account }]
let activeGraphId = initialGraphs.activeId;

/* ---------------- persistence ---------------- */

function loadBoard() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveBoard() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
  refreshBoardCount();
}

function refreshBoardCount() {
  document.getElementById("board-count").textContent = board.length;
}

/* ---------------- graphs: state + persistence ----------------
   A graph is a saved "view" of your material:
     mode "pins"     → draws the board pins listed in pinIds (null = every pin, live)
     mode "channels" → draws whole channels from the connected account (refs in `channels`)
   Only lightweight refs are saved — channel *contents* live in memory and are never
   written to localStorage, so private blocks aren't persisted by graphs. */

function newGraph(name, mode = "pins") {
  return {
    id: `g-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    mode,
    pinIds: null,
    channels: [],
    account: null
  };
}

function loadGraphs() {
  try {
    const saved = JSON.parse(localStorage.getItem(GRAPHS_KEY));
    if (saved && Array.isArray(saved.graphs) && saved.graphs.length) {
      const list = saved.graphs.map(g => ({
        ...newGraph(g.name || "Graph"),
        ...g,
        mode: g.mode === "channels" ? "channels" : "pins",
        pinIds: Array.isArray(g.pinIds) ? g.pinIds : null,
        channels: Array.isArray(g.channels) ? g.channels : []
      }));
      const activeId = list.some(g => g.id === saved.activeId) ? saved.activeId : list[0].id;
      return { graphs: list, activeId };
    }
  } catch { /* fall through to a fresh graph */ }
  const first = newGraph("Graph 1");
  return { graphs: [first], activeId: first.id };
}

function saveGraphs() {
  localStorage.setItem(GRAPHS_KEY, JSON.stringify({ activeId: activeGraphId, graphs }));
}

function getActiveGraph() {
  return graphs.find(g => g.id === activeGraphId) || graphs[0];
}

function selectedPins(graph) {
  if (graph.pinIds === null) return board;
  const ids = new Set(graph.pinIds);
  return board.filter(b => ids.has(b.id));
}

function pruneGraphPins() {
  const ids = new Set(board.map(b => b.id));
  graphs.forEach(g => { if (g.pinIds) g.pinIds = g.pinIds.filter(id => ids.has(id)); });
  saveGraphs();
}

/* ---------------- Are.na API (public v2) ---------------- */

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Are.na request failed (${res.status})`);
  return res.json();
}

async function searchChannels(query) {
  const url = `${API_BASE}/search/channels?q=${encodeURIComponent(query)}&per=15`;
  const data = await fetchJSON(url);
  return data.channels || [];
}

async function loadChannel(slug) {
  const url = `${API_BASE}/channels/${encodeURIComponent(slug)}?per=60`;
  const data = await fetchJSON(url);
  const channelUrl = data.user?.slug
    ? `https://www.are.na/${data.user.slug}/${data.slug}`
    : `https://www.are.na/channels/${data.slug}`;

  const cards = (data.contents || [])
    .filter(block => block.base_class === "Block") // skip nested sub-channels
    .map(block => normalizeBlock(block, data.slug, data.title, channelUrl));

  return { title: data.title, length: data.length, cards };
}

/* ==========================================================
   Connect Are.na account (OAuth2 + PKCE)
   Docs: https://www.are.na/developers/explore/authentication
   PKCE means no client secret is ever needed or stored — safe
   to run entirely from static, client-side JS.
   ========================================================== */

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

function currentRedirectUri() {
  return window.location.origin + window.location.pathname;
}

async function connectArena() {
  if (!ARENA_CLIENT_ID || ARENA_CLIENT_ID === "YOUR_ARENA_CLIENT_ID_HERE") {
    document.getElementById("connect-status").textContent =
      "Add your Are.na OAuth Client ID in app.js first (see README).";
    return;
  }
  const verifier = randomString(64);
  sessionStorage.setItem("arena_pkce_verifier", verifier);
  const challenge = base64UrlEncode(await sha256(verifier));
  const redirectUri = currentRedirectUri();

  const authUrl = `https://www.are.na/oauth/authorize?`
    + `client_id=${encodeURIComponent(ARENA_CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&response_type=code&scope=read`
    + `&code_challenge=${challenge}&code_challenge_method=S256`;

  window.location.href = authUrl;
}

async function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return;

  const verifier = sessionStorage.getItem("arena_pkce_verifier");
  const redirectUri = currentRedirectUri();
  // clean the ?code=... out of the URL either way, so a refresh doesn't re-trigger this
  window.history.replaceState({}, document.title, redirectUri);
  if (!verifier) return;

  try {
    const res = await fetch(`${API_V3_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ARENA_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
    });
    if (!res.ok) throw new Error("token exchange failed");
    const data = await res.json();
    sessionStorage.setItem("arena_access_token", data.access_token);
    sessionStorage.removeItem("arena_pkce_verifier");
    await loadArenaProfile();
  } catch (err) {
    document.getElementById("connect-status").textContent = "Connection failed — try again.";
  }
}

function getArenaToken() {
  return sessionStorage.getItem("arena_access_token");
}

function getArenaMe() {
  try {
    return JSON.parse(sessionStorage.getItem("arena_me") || "null");
  } catch {
    return null;
  }
}

function isArenaConnected() {
  return !!getArenaToken() && !!getArenaMe();
}

// A channel graph can only be drawn by the account it was built with.
function graphUsable(graph) {
  const me = getArenaMe();
  return isArenaConnected() && (!graph.account || graph.account === me.slug);
}

async function loadArenaProfile() {
  const token = getArenaToken();
  if (!token) return;
  const res = await fetch(`${API_V3_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    disconnectArena();
    return;
  }
  const me = await res.json();
  sessionStorage.setItem("arena_me", JSON.stringify({ slug: me.slug, name: me.name }));
  showConnectedUI(me.name);
  await loadMyChannels();
}

function showConnectedUI(name) {
  document.getElementById("connect-btn").style.display = "none";
  document.getElementById("connected-box").style.display = "block";
  document.getElementById("connected-name").textContent = name;
  renderGraphConfig();
}

function disconnectArena() {
  if (activeLoad) activeLoad.abort();
  sessionStorage.removeItem("arena_access_token");
  sessionStorage.removeItem("arena_me");
  // channel contents may be private — drop them from memory when the account disconnects
  channelCache.clear();
  myChannels = [];
  myChannelsHasMore = false;
  document.getElementById("connect-btn").style.display = "block";
  document.getElementById("connected-box").style.display = "none";
  document.getElementById("my-channels-section").style.display = "none";
  document.getElementById("my-channels-list").innerHTML = "";
  refreshGraphUI();
}

document.getElementById("connect-btn").addEventListener("click", connectArena);
document.getElementById("disconnect-btn").addEventListener("click", disconnectArena);

/* ---- listing + loading the connected user's own channels (v3 API) ---- */

function toChannelRef(ch) {
  return {
    id: ch.id,
    slug: ch.slug,
    title: ch.title || ch.slug || "Untitled channel",
    visibility: ch.visibility || "public",
    ownerSlug: ch.owner?.slug || getArenaMe()?.slug || "",
    itemCount: ch.counts?.contents ?? null
  };
}

async function loadMyChannels() {
  const token = getArenaToken();
  const me = getArenaMe();
  if (!token || !me) return;

  const section = document.getElementById("my-channels-section");
  const list = document.getElementById("my-channels-list");
  section.style.display = "block";
  list.innerHTML = `<p class="status">Loading your channels…</p>`;

  try {
    const url = `${API_V3_BASE}/users/${encodeURIComponent(me.slug)}/contents?type=Channel&per=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("failed to load channels");
    const data = await res.json();
    const raw = data.data || [];
    myChannels = raw.map(toChannelRef);
    myChannelsHasMore = !!data.meta?.has_more_pages;
    renderMyChannels(raw);
    refreshGraphUI();
  } catch (err) {
    list.innerHTML = `<p class="status is-error">Couldn't load your channels.</p>`;
  }
}

function renderMyChannels(channels) {
  const list = document.getElementById("my-channels-list");
  list.innerHTML = "";
  if (!channels.length) {
    list.innerHTML = `<p class="status">No channels found on your account yet.</p>`;
    return;
  }
  channels.forEach(ch => {
    const btn = document.createElement("button");
    btn.className = "channel-item";
    const badge = ch.visibility !== "public" ? `<span class="visibility-badge">${escapeHtml(ch.visibility)}</span>` : "";
    btn.innerHTML = `
      <span class="channel-item__title">${escapeHtml(ch.title)}</span>
      <span class="channel-item__meta">${ch.counts?.contents ?? 0} items${badge}</span>
    `;
    btn.addEventListener("click", () => openMyChannel(ch));
    list.appendChild(btn);
  });
}

async function openMyChannel(channel) {
  const token = getArenaToken();
  const status = document.getElementById("search-status");
  status.textContent = "Loading your channel…";
  status.classList.remove("is-error");
  try {
    const url = `${API_V3_BASE}/channels/${channel.id}/contents?per=100`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("failed to load channel contents");
    const data = await res.json();
    const channelUrl = `https://www.are.na/${channel.owner?.slug || ""}/${channel.slug}`;

    const cards = (data.data || [])
      .filter(item => item.base_type === "Block")
      .map(block => normalizeV3Block(block, channel.slug, channel.title, channelUrl));

    currentBlocks = cards;
    document.getElementById("channel-title").textContent = channel.title;
    document.getElementById("channel-sub").textContent = `${cards.length} blocks · your ${channel.visibility} channel`;
    renderBlockGrid(cards, document.getElementById("block-grid"), { pinnable: true });
    setView("results");
    status.textContent = "";
  } catch (err) {
    status.textContent = "Couldn't load that channel.";
    status.classList.add("is-error");
  }
}

function pickV3Image(image) {
  if (!image) return null;
  return image.medium?.src || image.large?.src || image.small?.src
      || image.src || image.original?.src || image.original?.url || null;
}

function normalizeV3Block(block, sourceChannel, sourceChannelTitle, channelUrl) {
  const image = pickV3Image(block.image);
  const text = block.type === "Text" ? (block.content?.plain || "")
             : block.type === "Link" ? (block.content?.plain || "")
             : "";
  const title = block.title || (text ? text.slice(0, 60) : "Untitled block");

  return {
    id: `v3-${block.id}`,
    type: block.type,
    title,
    image,
    text: text.slice(0, 400),
    linkUrl: block.source?.url || null,
    sourceChannel,
    sourceChannelTitle,
    sourceUrl: channelUrl,
    tags: [],
    notes: ""
  };
}

/* ---------------- normalize an Are.na block into a card ---------------- */

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeBlock(block, sourceChannel, sourceChannelTitle, channelUrl) {
  const image = block.image?.display?.url || block.image?.original?.url || null;
  const text = block.class === "Text" ? stripHtml(block.content_html || block.content) : "";
  const title = block.title || block.generated_title || (text ? text.slice(0, 60) : "Untitled block");

  return {
    id: String(block.id),
    type: block.class,               // Image, Text, Link, Media, Attachment
    title,
    image,
    text: text.slice(0, 400),
    linkUrl: block.source?.url || null,
    sourceChannel,
    sourceChannelTitle,
    sourceUrl: channelUrl,
    tags: [],
    notes: ""
  };
}

// The plain card fields we keep on the board (drops d3's x/y/vx bookkeeping).
function cleanCard(node) {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    image: node.image || null,
    text: node.text || "",
    linkUrl: node.linkUrl || null,
    sourceChannel: node.sourceChannel,
    sourceChannelTitle: node.sourceChannelTitle,
    sourceUrl: node.sourceUrl,
    tags: Array.isArray(node.tags) ? [...node.tags] : [],
    notes: node.notes || ""
  };
}

/* ---------------- rendering: search results ---------------- */

function renderChannelResults(channels) {
  const box = document.getElementById("channel-results");
  box.innerHTML = "";
  channels.forEach(ch => {
    const btn = document.createElement("button");
    btn.className = "channel-item";
    btn.innerHTML = `
      <span class="channel-item__title">${escapeHtml(ch.title || ch.slug)}</span>
      <span class="channel-item__meta">${ch.length} blocks · @${escapeHtml(ch.user?.slug || "unknown")}</span>
    `;
    btn.addEventListener("click", () => openChannel(ch.slug));
    box.appendChild(btn);
  });
}

async function openChannel(slug) {
  const status = document.getElementById("search-status");
  status.textContent = "Loading channel…";
  status.classList.remove("is-error");
  try {
    const { title, length, cards } = await loadChannel(slug);
    currentBlocks = cards;
    document.getElementById("channel-title").textContent = title;
    document.getElementById("channel-sub").textContent = `${length} blocks on are.na`;
    renderBlockGrid(cards, document.getElementById("block-grid"), { pinnable: true });
    setView("results");
    status.textContent = "";
  } catch (err) {
    status.textContent = "Couldn't load that channel — it may be private or renamed.";
    status.classList.add("is-error");
  }
}

/* ---------------- rendering: a grid of cards (shared by search + board) ---------------- */

function renderBlockGrid(cards, container, { pinnable }) {
  container.innerHTML = "";
  cards.forEach((card, i) => {
    const isPinned = board.some(b => b.id === card.id);
    const el = document.createElement("div");
    el.className = "card";

    let media = "";
    if (card.image) {
      media = `<img src="${escapeHtml(card.image)}" loading="lazy" alt="">`;
    }

    let body = "";
    if (card.type === "Text" && card.text) {
      body += `<p class="card__text">${escapeHtml(card.text)}</p>`;
    }

    const tagsHtml = card.tags?.length
      ? `<div class="tags-row">${card.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";

    el.innerHTML = `
      <span class="card__serial">${escapeHtml(card.type)}</span>
      ${media}
      <div class="card__body">
        <p class="card__title">${escapeHtml(card.title)}</p>
        ${body}
        <p class="card__meta">from “${escapeHtml(card.sourceChannelTitle || card.sourceChannel)}”</p>
        ${tagsHtml}
        <div class="card__actions"></div>
      </div>
    `;

    const actions = el.querySelector(".card__actions");

    if (pinnable) {
      const pinBtn = document.createElement("button");
      pinBtn.className = "pin-btn";
      pinBtn.textContent = isPinned ? "pinned ✓" : "+ pin";
      pinBtn.disabled = isPinned;
      pinBtn.addEventListener("click", () => {
        pinCard(card);
        pinBtn.textContent = "pinned ✓";
        pinBtn.disabled = true;
      });
      actions.appendChild(pinBtn);
    } else {
      const unpinBtn = document.createElement("button");
      unpinBtn.className = "unpin-btn";
      unpinBtn.textContent = "unpin";
      unpinBtn.addEventListener("click", () => unpinCard(card.id));
      actions.appendChild(unpinBtn);

      const annotateBtn = document.createElement("button");
      annotateBtn.className = "open-btn";
      annotateBtn.textContent = "annotate";
      annotateBtn.addEventListener("click", () => openDetail(card.id));
      actions.appendChild(annotateBtn);
    }

    if (card.sourceUrl) {
      const openBtn = document.createElement("a");
      openBtn.className = "open-btn";
      openBtn.textContent = "view on are.na";
      openBtn.href = card.sourceUrl;
      openBtn.target = "_blank";
      openBtn.rel = "noopener";
      actions.appendChild(openBtn);
    }

    container.appendChild(el);
  });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------- pin / unpin ---------------- */

function pinCard(card) {
  if (board.some(b => b.id === card.id)) return;
  board.push(cleanCard(card));
  saveBoard();
  renderBoard();
  refreshGraphUI();
}

function unpinCard(id) {
  board = board.filter(b => b.id !== id);
  saveBoard();
  pruneGraphPins();
  renderBoard();
  refreshGraphUI();
  // reflect the change back in the currently-displayed search grid, if present
  renderBlockGrid(currentBlocks, document.getElementById("block-grid"), { pinnable: true });
}

/* ---------------- board view ---------------- */

function renderBoard() {
  const grid = document.getElementById("board-grid");
  const empty = document.getElementById("board-empty");
  renderBlockGrid(board, grid, { pinnable: false });
  empty.classList.toggle("is-visible", board.length === 0);
  refreshBoardCount();
}

/* ==========================================================
   Graphs
   ========================================================== */

function refreshGraphUI() {
  renderGraphTabs();
  renderGraphConfig();
  renderGraph();
}

/* ---------------- graph tabs (one per saved graph) ---------------- */

function renderGraphTabs() {
  const bar = document.getElementById("graph-tabs");
  bar.innerHTML = "";
  graphs.forEach(g => {
    const isActive = g.id === activeGraphId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-tab" + (isActive ? " is-active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.innerHTML = `<span>${escapeHtml(g.name)}</span><span class="graph-tab__mode">${g.mode === "channels" ? "channels" : "pins"}</span>`;
    btn.addEventListener("click", () => switchGraph(g.id));
    bar.appendChild(btn);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "graph-tab graph-tab--new";
  add.textContent = "+ New graph";
  add.addEventListener("click", createGraph);
  bar.appendChild(add);
}

function switchGraph(id) {
  if (id === activeGraphId) return;
  activeGraphId = id;
  saveGraphs();
  // each graph starts from a fresh pan/zoom
  d3.select("#graph-svg").call(zoomBehavior.transform, d3.zoomIdentity);
  setGraphStatus("");
  refreshGraphUI();
}

function createGraph() {
  let n = graphs.length + 1;
  while (graphs.some(g => g.name === `Graph ${n}`)) n++;
  const g = newGraph(`Graph ${n}`);
  graphs.push(g);
  switchGraph(g.id);
}

function deleteActiveGraph() {
  if (graphs.length < 2) return;
  const graph = getActiveGraph();
  if (!confirm(`Delete “${graph.name}”? Your pinned cards aren't affected.`)) return;
  graphs = graphs.filter(g => g.id !== graph.id);
  activeGraphId = graphs[0].id;
  saveGraphs();
  d3.select("#graph-svg").call(zoomBehavior.transform, d3.zoomIdentity);
  setGraphStatus("");
  refreshGraphUI();
}

function setGraphMode(mode) {
  const graph = getActiveGraph();
  if (graph.mode === mode) return;
  if (mode === "channels" && !isArenaConnected()) return;
  graph.mode = mode;
  saveGraphs();
  setGraphStatus("");
  refreshGraphUI();
}

function setGraphStatus(message, isError = false) {
  const el = document.getElementById("graph-source-status");
  el.textContent = message;
  el.classList.toggle("is-error", !!isError && !!message);
}

/* ---------------- graph settings panel ---------------- */

function renderGraphConfig() {
  const graph = getActiveGraph();
  const connected = isArenaConnected();

  const nameInput = document.getElementById("graph-name");
  if (document.activeElement !== nameInput) nameInput.value = graph.name;
  document.getElementById("graph-delete").disabled = graphs.length < 2;

  const pinsBtn = document.getElementById("mode-pins");
  const channelsBtn = document.getElementById("mode-channels");
  pinsBtn.classList.toggle("is-active", graph.mode === "pins");
  channelsBtn.classList.toggle("is-active", graph.mode === "channels");
  pinsBtn.setAttribute("aria-pressed", graph.mode === "pins");
  channelsBtn.setAttribute("aria-pressed", graph.mode === "channels");
  channelsBtn.disabled = !connected && graph.mode !== "channels";
  channelsBtn.title = channelsBtn.disabled ? "Connect your Are.na account to graph whole channels" : "";

  const list = document.getElementById("graph-source-list");
  const actions = document.getElementById("graph-source-actions");
  list.innerHTML = "";
  actions.innerHTML = "";

  if (graph.mode === "pins") {
    renderPinPicker(graph, list, actions);
  } else {
    renderChannelPicker(graph, list);
    renderChannelActions();
  }
}

/* ---- pins mode: choose which board pins to draw ---- */

function pinHintText(graph) {
  const connected = isArenaConnected();
  const base = `${selectedPins(graph).length} of ${board.length} pins in this graph.`;
  return connected ? base : `${base} Connect Are.na to also graph whole channels.`;
}

function renderPinPicker(graph, list, actions) {
  const hint = document.getElementById("mode-hint");
  hint.textContent = pinHintText(graph);

  if (!board.length) {
    list.innerHTML = `<p class="status">Nothing pinned yet. Pin cards from a channel, then pick them here.</p>`;
    return;
  }

  const selected = graph.pinIds === null ? null : new Set(graph.pinIds);
  board.forEach(card => {
    const row = document.createElement("label");
    row.className = "source-row";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !selected || selected.has(card.id);
    box.addEventListener("change", () => togglePinInGraph(graph, card.id, box.checked));
    row.appendChild(box);

    if (card.image) {
      const img = document.createElement("img");
      img.src = card.image;
      img.alt = "";
      img.loading = "lazy";
      row.appendChild(img);
    }

    const main = document.createElement("span");
    main.className = "source-row__main";
    main.innerHTML = `
      <span class="source-row__title">${escapeHtml(card.title)}</span>
      <span class="source-row__meta">${escapeHtml(card.type)}${card.tags?.length ? ` · ${escapeHtml(card.tags.join(", "))}` : ""}</span>
    `;
    row.appendChild(main);
    list.appendChild(row);
  });

  const all = document.createElement("button");
  all.type = "button";
  all.className = "ghost-btn";
  all.textContent = "Select all";
  all.addEventListener("click", () => { graph.pinIds = null; saveGraphs(); renderGraphConfig(); renderGraph(); });

  const none = document.createElement("button");
  none.type = "button";
  none.className = "ghost-btn";
  none.textContent = "Select none";
  none.addEventListener("click", () => { graph.pinIds = []; saveGraphs(); renderGraphConfig(); renderGraph(); });

  actions.append(all, none);
}

function togglePinInGraph(graph, id, on) {
  const set = new Set(graph.pinIds === null ? board.map(b => b.id) : graph.pinIds);
  if (on) set.add(id); else set.delete(id);
  graph.pinIds = [...set];
  saveGraphs();
  document.getElementById("mode-hint").textContent = pinHintText(graph);
  renderGraph();
}

/* ---- channels mode: choose whole channels from the connected account ---- */

function channelStatusText(id) {
  const entry = channelCache.get(id);
  if (!entry) return "not loaded";
  const shown = entry.blocks.length.toLocaleString();
  if (entry.capped) return `first ${shown} shown`;
  if (entry.complete) return `${shown} blocks loaded`;
  return `${shown} loaded so far`;
}

function updateChannelStatusLabels() {
  document.querySelectorAll("[data-status-for]").forEach(el => {
    el.textContent = channelStatusText(Number(el.dataset.statusFor));
  });
}

function channelRow(graph, ref, { readonly = false } = {}) {
  const row = document.createElement(readonly ? "div" : "label");
  row.className = "source-row" + (readonly ? " source-row--static" : "");

  if (!readonly) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = graph.channels.some(c => c.id === ref.id);
    box.addEventListener("change", () => toggleChannelInGraph(graph, ref, box.checked));
    row.appendChild(box);
  }

  const badge = ref.visibility && ref.visibility !== "public"
    ? `<span class="visibility-badge">${escapeHtml(ref.visibility)}</span>` : "";
  const count = ref.itemCount != null ? `${ref.itemCount} items` : "";
  const main = document.createElement("span");
  main.className = "source-row__main";
  main.innerHTML = `
    <span class="source-row__title">${escapeHtml(ref.title)}</span>
    <span class="source-row__meta">${count}${badge}${count || badge ? " · " : ""}<span data-status-for="${Number(ref.id)}">${channelStatusText(ref.id)}</span></span>
  `;
  row.appendChild(main);
  return row;
}

function renderChannelPicker(graph, list) {
  const hint = document.getElementById("mode-hint");

  if (!graphUsable(graph)) {
    hint.textContent = isArenaConnected()
      ? "This graph was set up with a different Are.na account."
      : "Connect your Are.na account (left sidebar) to load this graph.";
    graph.channels.forEach(ref => list.appendChild(channelRow(graph, ref, { readonly: true })));
    return;
  }

  const all = [...myChannels];
  graph.channels.forEach(ref => { if (!all.some(c => c.id === ref.id)) all.push(ref); });

  if (!all.length) {
    list.innerHTML = `<p class="status">No channels loaded yet.</p>`;
    return;
  }
  all.forEach(ref => list.appendChild(channelRow(graph, ref)));

  if (myChannelsHasMore) {
    const note = document.createElement("p");
    note.className = "status";
    note.textContent = "Showing your first 100 channels.";
    list.appendChild(note);
  }
}

function toggleChannelInGraph(graph, ref, on) {
  if (on) {
    if (!graph.channels.some(c => c.id === ref.id)) graph.channels.push(ref);
    graph.account = getArenaMe()?.slug || graph.account;
  } else {
    graph.channels = graph.channels.filter(c => c.id !== ref.id);
  }
  saveGraphs();
  renderChannelActions();
  renderGraph();
}

function renderChannelActions() {
  const graph = getActiveGraph();
  const box = document.getElementById("graph-source-actions");
  const hint = document.getElementById("mode-hint");
  box.innerHTML = "";
  if (graph.mode !== "channels" || !graphUsable(graph)) return;

  const pending = graph.channels.filter(ref => !channelCache.get(ref.id)?.complete);
  const loaded = graph.channels.length - pending.length;
  hint.textContent = graph.channels.length
    ? `${graph.channels.length} selected, ${loaded} loaded.`
    : "Pick the channels you want to graph in full.";

  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "primary-btn";
  loadBtn.textContent = activeLoad
    ? "Loading…"
    : !graph.channels.length
      ? "Select channels to load"
      : pending.length
        ? `Load ${pending.length} channel${pending.length === 1 ? "" : "s"}`
        : "All selected channels loaded";
  loadBtn.disabled = !!activeLoad || pending.length === 0;
  loadBtn.addEventListener("click", () => loadGraphChannels(graph));
  box.appendChild(loadBtn);

  if (loaded > 0 && !activeLoad) {
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "ghost-btn";
    reload.textContent = "Reload from Are.na";
    reload.addEventListener("click", () => loadGraphChannels(graph, { reload: true }));
    box.appendChild(reload);
  }

  const note = document.createElement("p");
  note.className = "status";
  note.textContent = `Loads ${PAGE_SIZE} blocks at a time, up to ${MAX_BLOCKS_PER_CHANNEL.toLocaleString()} per channel. Nothing loads until you click.`;
  box.appendChild(note);
}

/* ---- loading whole channels: sequential, throttled, stoppable ---- */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function showProgress(text) {
  document.getElementById("graph-progress").hidden = false;
  document.getElementById("graph-progress-text").textContent = text;
}

function hideProgress() {
  document.getElementById("graph-progress").hidden = true;
}

async function loadChannelPages(ref, signal) {
  const token = getArenaToken();
  if (!token) throw new Error("Not connected to Are.na.");

  let entry = channelCache.get(ref.id);
  if (!entry) {
    entry = { blocks: [], childChannelIds: [], total: null, fetched: 0, nextPage: 1, complete: false, capped: false };
    channelCache.set(ref.id, entry);
  }
  const channelUrl = ref.ownerSlug
    ? `https://www.are.na/${ref.ownerSlug}/${ref.slug}`
    : `https://www.are.na/channels/${ref.slug}`;

  while (!entry.complete) {
    const of = entry.total ? ` of ${entry.total.toLocaleString()}` : "";
    showProgress(`Loading “${ref.title}”: ${entry.fetched.toLocaleString()}${of} items`);

    const url = `${API_V3_BASE}/channels/${ref.id}/contents?per=${PAGE_SIZE}&page=${entry.nextPage}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });

    if (res.status === 401) {
      disconnectArena();
      throw new Error("Your Are.na session expired. Reconnect to continue.");
    }
    if (res.status === 429) {
      const reset = Number(res.headers.get("X-RateLimit-Reset"));
      const wait = reset ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 60;
      const err = new Error(`Are.na rate limit reached. Wait about ${wait}s, then load again. Your progress is kept.`);
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Are.na request failed (${res.status})`);

    const data = await res.json();
    const items = data.data || [];
    items.forEach(item => {
      if (item.base_type === "Block") {
        entry.blocks.push(normalizeV3Block(item, ref.slug, ref.title, channelUrl));
      } else if (item.type === "Channel") {
        entry.childChannelIds.push(item.id);   // sub-channels become links between channel nodes
      }
    });
    entry.fetched += items.length;

    const meta = data.meta || {};
    if (Number.isFinite(meta.total_count)) entry.total = meta.total_count;

    if (meta.has_more_pages) {
      entry.nextPage = meta.next_page || entry.nextPage + 1;
      if (entry.blocks.length >= MAX_BLOCKS_PER_CHANNEL) {
        entry.capped = true;
        entry.complete = true;
      }
    } else {
      entry.complete = true;
    }

    updateChannelStatusLabels();
    if (getActiveGraph().mode === "channels") renderGraph();   // draw what we have so far
    if (!entry.complete) await sleep(REQUEST_DELAY_MS, signal);
  }
}

async function loadGraphChannels(graph, { reload = false } = {}) {
  if (activeLoad || !graphUsable(graph)) return;
  const targets = graph.channels.filter(ref => reload || !channelCache.get(ref.id)?.complete);
  if (!targets.length) return;
  if (reload) targets.forEach(ref => channelCache.delete(ref.id));

  activeLoad = new AbortController();
  const { signal } = activeLoad;
  setGraphStatus("");
  renderChannelActions();

  const errors = [];
  for (const ref of targets) {
    if (signal.aborted) break;
    try {
      await loadChannelPages(ref, signal);
    } catch (err) {
      if (err.name === "AbortError") break;
      errors.push(`${ref.title}: ${err.message}`);
      if (err.rateLimited) break;
    }
  }

  const wasStopped = signal.aborted;
  activeLoad = null;
  hideProgress();
  updateChannelStatusLabels();
  renderChannelActions();
  renderGraph();
  if (errors.length) setGraphStatus(errors.join(" "), true);
  else if (wasStopped) setGraphStatus("Stopped. Load again to pick up where you left off.");
}

/* ---------------- graph data ---------------- */

function tagSet(node) {
  return new Set((node.tags || []).map(t => t.toLowerCase()));
}

function buildPinGraphData(graph) {
  const nodes = selectedPins(graph).map(b => ({ ...b, kind: "block" }));
  const links = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const bTags = tagSet(b);
      const shared = [...tagSet(a)].filter(t => bTags.has(t));
      if (shared.length) {
        links.push({ source: a.id, target: b.id, kind: "tag", label: shared.join(", ") });
      } else if (a.sourceChannel && a.sourceChannel === b.sourceChannel) {
        links.push({ source: a.id, target: b.id, kind: "source", label: a.sourceChannelTitle });
      }
    }
  }
  return { nodes, links };
}

// Channels become hub nodes; every block links to the channel(s) it sits in, so a block
// shared by two selected channels bridges them. Blocks you've pinned + tagged also link
// to each other by shared tag, and a sub-channel links to its parent if both are selected.
function buildChannelGraphData(graph) {
  const nodes = [];
  const links = [];
  if (!graphUsable(graph)) return { nodes, links };

  const boardById = new Map(board.map(b => [b.id, b]));
  const blockNodes = new Map();
  const selectedIds = new Set(graph.channels.map(c => c.id));
  const hubId = id => `channel-${id}`;

  graph.channels.forEach(ref => {
    const entry = channelCache.get(ref.id);
    nodes.push({
      id: hubId(ref.id),
      kind: "channel",
      type: "Channel",
      title: ref.title,
      tags: [],
      blockCount: entry ? entry.blocks.length : 0
    });
    if (!entry) return;

    entry.blocks.forEach(card => {
      let node = blockNodes.get(card.id);
      if (!node) {
        const pinned = boardById.get(card.id);
        node = { ...card, kind: "block", pinned: !!pinned, tags: pinned ? pinned.tags : [], notes: pinned ? pinned.notes : "" };
        blockNodes.set(card.id, node);
        nodes.push(node);
      }
      links.push({ source: hubId(ref.id), target: card.id, kind: "member" });
    });

    entry.childChannelIds.forEach(childId => {
      if (childId !== ref.id && selectedIds.has(childId)) {
        links.push({ source: hubId(ref.id), target: hubId(childId), kind: "nested" });
      }
    });
  });

  const byTag = new Map();
  blockNodes.forEach(n => {
    tagSet(n).forEach(t => {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(n);
    });
  });
  const tagLinks = new Map();
  byTag.forEach((group, tag) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = `${group[i].id}|${group[j].id}`;
        const existing = tagLinks.get(key);
        if (existing) existing.label += `, ${tag}`;
        else tagLinks.set(key, { source: group[i].id, target: group[j].id, kind: "tag", label: tag });
      }
    }
  });
  links.push(...tagLinks.values());

  return { nodes, links };
}

function buildGraphData(graph) {
  return graph.mode === "channels" ? buildChannelGraphData(graph) : buildPinGraphData(graph);
}

function graphEmptyMessage(graph, nodes) {
  if (graph.mode === "channels") {
    if (!isArenaConnected()) return "Connect your Are.na account to draw this graph.";
    if (!graphUsable(graph)) return "This graph was set up with a different Are.na account.";
    if (!graph.channels.length) return "Select one or more of your channels, then load them.";
    if (graph.channels.every(ref => !channelCache.has(ref.id))) return "Load the selected channels to draw them.";
    return null;
  }
  if (nodes.length >= 2) return null;
  return board.length < 2
    ? "Pin at least two cards and give them matching tags to see connections form."
    : "Select at least two pins in the panel to draw this graph.";
}

/* ---------------- graph rendering ---------------- */

let simulation = null;
let graphLayer = null;
let renderedGraphId = null;
const lastPositions = new Map();   // `${graphId}:${nodeId}` -> { x, y }, so re-renders don't scramble the layout

const zoomBehavior = d3.zoom().scaleExtent([0.2, 3]).on("zoom", (event) => {
  if (graphLayer) graphLayer.attr("transform", event.transform);
});

function snapshotPositions() {
  if (!simulation || !renderedGraphId) return;
  simulation.nodes().forEach(n => {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
      lastPositions.set(`${renderedGraphId}:${n.id}`, { x: n.x, y: n.y });
    }
  });
}

function renderGraph() {
  // the graph needs real dimensions, so only draw while its view is showing
  if (!document.getElementById("view-graph").classList.contains("is-active")) return;

  snapshotPositions();
  if (simulation) { simulation.stop(); simulation = null; }

  const graph = getActiveGraph();
  const svg = d3.select("#graph-svg");
  svg.selectAll("*").remove();

  const { nodes, links } = buildGraphData(graph);
  const message = graphEmptyMessage(graph, nodes);
  const emptyEl = document.getElementById("graph-empty");
  emptyEl.textContent = message || "";
  emptyEl.classList.toggle("is-visible", !!message);
  if (message) return;

  const wrap = document.querySelector(".graph-wrap");
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  const channelMode = graph.mode === "channels";
  const dense = nodes.length > DENSE_GRAPH_THRESHOLD;
  svg.classed("is-dense", dense);
  renderedGraphId = graph.id;

  let restored = 0;
  nodes.forEach(n => {
    const p = lastPositions.get(`${graph.id}:${n.id}`);
    if (p) { n.x = p.x; n.y = p.y; restored++; }
  });

  const radiusOf = d => d.kind === "channel" ? 16 : channelMode ? 7 : 10;
  const colorForType = d => d.kind === "channel" ? "#1C1B19"
    : d.type === "Image" ? "#3C5A5B"
    : d.type === "Text" ? "#A6423D"
    : "#8B877D";

  svg.call(zoomBehavior);
  const g = svg.append("g");
  graphLayer = g;
  g.attr("transform", d3.zoomTransform(svg.node()));

  const linkSel = g.selectAll("line")
    .data(links)
    .join("line")
    .attr("class", d => `link link--${d.kind}`)
    .attr("stroke-width", 1.4);

  const nodeSel = g.selectAll("g.node")
    .data(nodes)
    .join("g")
    .attr("class", d => `node node--${d.kind}${d.pinned ? " node--pinned" : ""}`)
    .call(drag());

  nodeSel.append("title").text(d => d.title);

  nodeSel.append("circle")
    .attr("r", radiusOf)
    .attr("fill", colorForType)
    .on("click", (event, d) => {
      event.stopPropagation();
      focusNode(d.id, nodeSel, linkSel);
      if (d.kind === "block") openDetail(d.id, d);
    });

  nodeSel.append("text")
    .attr("x", d => radiusOf(d) + 4)
    .attr("y", 4)
    .text(d => d.title.length > 26 ? d.title.slice(0, 26) + "…" : d.title);

  svg.on("click", () => clearFocus(nodeSel, linkSel));

  const linkForce = d3.forceLink(links).id(d => d.id)
    .distance(d => d.kind === "member" ? (dense ? 30 : 55) : d.kind === "nested" ? 150 : 90);
  if (!channelMode) linkForce.strength(0.5);

  simulation = d3.forceSimulation(nodes)
    .force("link", linkForce)
    .force("charge", d3.forceManyBody().strength(d =>
      d.kind === "channel" ? -400 : channelMode ? (dense ? -25 : -60) : -220))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("x", d3.forceX(width / 2).strength(0.04))
    .force("y", d3.forceY(height / 2).strength(0.04))
    .force("collide", d3.forceCollide(d => radiusOf(d) + (channelMode ? 4 : 24)))
    .on("tick", () => {
      linkSel
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
    });

  // when most nodes already have a position (e.g. another page just loaded), settle gently
  if (restored > nodes.length / 2) simulation.alpha(0.3);

  function drag() {
    return d3.drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.25).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }
}

function focusNode(id, nodeSel, linkSel) {
  const connected = new Set([id]);
  linkSel.each(function (d) {
    if (d.source.id === id) connected.add(d.target.id);
    if (d.target.id === id) connected.add(d.source.id);
  });
  nodeSel.classed("is-dim", d => !connected.has(d.id));
  linkSel.classed("is-dim", d => d.source.id !== id && d.target.id !== id);
}

function clearFocus(nodeSel, linkSel) {
  nodeSel.classed("is-dim", false);
  linkSel.classed("is-dim", false);
}

/* ---------------- graph panel wiring ---------------- */

document.getElementById("mode-pins").addEventListener("click", () => setGraphMode("pins"));
document.getElementById("mode-channels").addEventListener("click", () => setGraphMode("channels"));
document.getElementById("graph-delete").addEventListener("click", deleteActiveGraph);
document.getElementById("graph-progress-stop").addEventListener("click", () => { if (activeLoad) activeLoad.abort(); });
document.getElementById("graph-name").addEventListener("change", (e) => {
  const graph = getActiveGraph();
  graph.name = e.target.value.trim() || graph.name;
  e.target.value = graph.name;
  saveGraphs();
  renderGraphTabs();
});

/* ---------------- detail / annotate panel ---------------- */

function openDetail(id, fallbackNode) {
  const card = board.find(b => b.id === id);
  if (!card) {
    if (fallbackNode) openPreview(fallbackNode);
    return;
  }

  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  content.innerHTML = `
    ${card.image ? `<img src="${escapeHtml(card.image)}" alt="">` : ""}
    <h3>${escapeHtml(card.title)}</h3>
    <p class="muted">${escapeHtml(card.type)} · from "${escapeHtml(card.sourceChannelTitle || card.sourceChannel)}"</p>
    <div class="field">
      <label for="tag-input">Tags (comma separated)</label>
      <input id="tag-input" type="text" value="${escapeHtml((card.tags || []).join(", "))}" placeholder="e.g. texture, cold, reference">
    </div>
    <div class="field">
      <label for="note-input">Your notes</label>
      <textarea id="note-input" placeholder="Why did you save this? What does it connect to?">${escapeHtml(card.notes || "")}</textarea>
    </div>
  `;

  const tagInput = content.querySelector("#tag-input");
  const noteInput = content.querySelector("#note-input");

  const commit = () => {
    card.tags = tagInput.value.split(",").map(t => t.trim()).filter(Boolean);
    card.notes = noteInput.value;
    saveBoard();
    renderBoard();
    renderGraph();
    renderGraphConfig();
  };
  tagInput.addEventListener("change", commit);
  noteInput.addEventListener("change", commit);

  panel.classList.add("is-open");
}

// A block from a channel graph that isn't on the board yet: show it, and offer to pin it
// (tags and notes belong to pinned cards).
function openPreview(node) {
  const card = cleanCard(node);
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  content.innerHTML = `
    ${card.image ? `<img src="${escapeHtml(card.image)}" alt="">` : ""}
    <h3>${escapeHtml(card.title)}</h3>
    <p class="muted">${escapeHtml(card.type)} · from "${escapeHtml(card.sourceChannelTitle || card.sourceChannel)}"</p>
    ${card.text ? `<p class="card__text">${escapeHtml(card.text)}</p>` : ""}
    <p class="muted">This block isn't on your board yet. Pin it to add tags and notes.</p>
    <div class="detail-actions">
      <button id="detail-pin" class="pin-btn" type="button">+ pin to board</button>
      ${card.sourceUrl ? `<a class="open-btn" href="${escapeHtml(card.sourceUrl)}" target="_blank" rel="noopener">view on are.na</a>` : ""}
    </div>
  `;

  content.querySelector("#detail-pin").addEventListener("click", () => {
    pinCard(card);
    openDetail(card.id);
  });

  panel.classList.add("is-open");
}

document.getElementById("detail-close").addEventListener("click", () => {
  document.getElementById("detail-panel").classList.remove("is-open");
});

/* ---------------- view switching ---------------- */

function setView(view) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("is-active"));
  document.querySelectorAll(".board-nav__item").forEach(b => b.classList.remove("is-active"));
  document.getElementById(`view-${view}`).classList.add("is-active");
  document.getElementById(`nav-${view}`).classList.add("is-active");
  if (view === "graph") refreshGraphUI();
}

document.getElementById("nav-results").addEventListener("click", () => setView("results"));
document.getElementById("nav-board").addEventListener("click", () => setView("board"));
document.getElementById("nav-graph").addEventListener("click", () => setView("graph"));

/* ---------------- search form ---------------- */

document.getElementById("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = document.getElementById("search-input").value.trim();
  if (!query) return;
  const status = document.getElementById("search-status");
  status.textContent = "Searching are.na…";
  status.classList.remove("is-error");
  try {
    const channels = await searchChannels(query);
    renderChannelResults(channels);
    status.textContent = channels.length ? `${channels.length} channels found` : "No channels found — try a broader term.";
  } catch (err) {
    status.textContent = "Search failed. Are.na may be unreachable right now.";
    status.classList.add("is-error");
  }
});

/* ---------------- export / clear ---------------- */

document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(board, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "constellation-board.json";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("clear-btn").addEventListener("click", () => {
  if (!confirm("Remove all pinned cards from your board?")) return;
  board = [];
  saveBoard();
  pruneGraphPins();
  renderBoard();
  refreshGraphUI();
});

/* ---------------- init ---------------- */

renderBoard();
refreshBoardCount();
refreshGraphUI();

(async function initArenaConnection() {
  await handleOAuthRedirect();          // in case we just came back from are.na/oauth/authorize
  if (getArenaToken()) {
    const me = getArenaMe();
    if (me) {
      showConnectedUI(me.name);
      await loadMyChannels();
    } else {
      await loadArenaProfile();
    }
  }
})();