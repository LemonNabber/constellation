/* ==========================================================
   Constellation — an Are.na-powered moodboard + graph tool
   API docs: https://dev.are.na/documentation
   No API key required for the public read/search endpoints.
   ========================================================== */

const API_BASE = "https://api.are.na/v2";       // public read/search — no key needed
const API_V3_BASE = "https://api.are.na/v3";    // used only once the user connects their account
const STORAGE_KEY = "constellation-board-v1";

// Register a free OAuth application at https://www.are.na/oauth/applications
// and paste its Client ID below. This is a *public* client ID (used with PKCE,
// no client secret), so it is safe to commit — see the README for setup steps.
const ARENA_CLIENT_ID = "YOUR_ARENA_CLIENT_ID_HERE";

let board = loadBoard();          // array of pinned card objects
let currentBlocks = [];           // normalized cards from the last-opened channel

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

/* ---------------- Are.na API ---------------- */

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
}

function disconnectArena() {
  sessionStorage.removeItem("arena_access_token");
  sessionStorage.removeItem("arena_me");
  document.getElementById("connect-btn").style.display = "block";
  document.getElementById("connected-box").style.display = "none";
  document.getElementById("my-channels-section").style.display = "none";
  document.getElementById("my-channels-list").innerHTML = "";
}

document.getElementById("connect-btn").addEventListener("click", connectArena);
document.getElementById("disconnect-btn").addEventListener("click", disconnectArena);

/* ---- listing + loading the connected user's own channels (v3 API) ---- */

async function loadMyChannels() {
  const token = getArenaToken();
  const me = JSON.parse(sessionStorage.getItem("arena_me") || "null");
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
    renderMyChannels(data.data || []);
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
    const badge = ch.visibility !== "public" ? `<span class="visibility-badge">${ch.visibility}</span>` : "";
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

function normalizeV3Block(block, sourceChannel, sourceChannelTitle, channelUrl) {
  const image = block.image?.medium?.src || block.image?.large?.src || block.image?.small?.src || null;
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

/* ---------------- rendering: search results ---------------- */

function renderChannelResults(channels) {
  const box = document.getElementById("channel-results");
  box.innerHTML = "";
  channels.forEach(ch => {
    const btn = document.createElement("button");
    btn.className = "channel-item";
    btn.innerHTML = `
      <span class="channel-item__title">${escapeHtml(ch.title || ch.slug)}</span>
      <span class="channel-item__meta">${ch.length} blocks · @${ch.user?.slug || "unknown"}</span>
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
      media = `<img src="${card.image}" loading="lazy" alt="">`;
    }

    let body = "";
    if (card.type === "Text" && card.text) {
      body += `<p class="card__text">${escapeHtml(card.text)}</p>`;
    }

    const tagsHtml = card.tags?.length
      ? `<div class="tags-row">${card.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";

    el.innerHTML = `
      <span class="card__serial">${card.type}</span>
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
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/* ---------------- pin / unpin ---------------- */

function pinCard(card) {
  if (board.some(b => b.id === card.id)) return;
  board.push({ ...card });
  saveBoard();
  renderBoard();
  renderGraph();
}

function unpinCard(id) {
  board = board.filter(b => b.id !== id);
  saveBoard();
  renderBoard();
  renderGraph();
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

/* ---------------- graph view ---------------- */

function buildGraphData() {
  const nodes = board.map(b => ({ ...b }));
  const links = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const aTags = (a.tags || []).map(t => t.toLowerCase());
      const bTags = (b.tags || []).map(t => t.toLowerCase());
      const shared = aTags.filter(t => bTags.includes(t));
      if (shared.length) {
        links.push({ source: a.id, target: b.id, kind: "tag", label: shared.join(", ") });
      } else if (a.sourceChannel && a.sourceChannel === b.sourceChannel) {
        links.push({ source: a.id, target: b.id, kind: "source", label: a.sourceChannelTitle });
      }
    }
  }
  return { nodes, links };
}

let simulation = null;

function renderGraph() {
  const svg = d3.select("#graph-svg");
  svg.selectAll("*").remove();
  const emptyMsg = document.getElementById("graph-empty");

  const { nodes, links } = buildGraphData();
  emptyMsg.classList.toggle("is-visible", nodes.length < 2);
  if (nodes.length < 2) return;

  const wrap = document.querySelector(".graph-wrap");
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;

  const g = svg.append("g");

  svg.call(d3.zoom().scaleExtent([0.4, 3]).on("zoom", (event) => {
    g.attr("transform", event.transform);
  }));

  const linkSel = g.selectAll("line")
    .data(links)
    .join("line")
    .attr("class", d => "link" + (d.kind === "source" ? " link--source" : ""))
    .attr("stroke-width", 1.4);

  const nodeSel = g.selectAll("g.node")
    .data(nodes)
    .join("g")
    .attr("class", "node")
    .call(drag());

  const colorForType = t => t === "Image" ? "#3C5A5B" : t === "Text" ? "#A6423D" : "#8B877D";

  nodeSel.append("circle")
    .attr("r", 10)
    .attr("fill", d => colorForType(d.type))
    .on("click", (event, d) => {
      event.stopPropagation();
      focusNode(d.id, nodeSel, linkSel);
      openDetail(d.id);
    });

  nodeSel.append("text")
    .attr("x", 14)
    .attr("y", 4)
    .text(d => d.title.length > 26 ? d.title.slice(0, 26) + "…" : d.title);

  svg.on("click", () => clearFocus(nodeSel, linkSel));

  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(90).strength(0.5))
    .force("charge", d3.forceManyBody().strength(-220))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide(34))
    .on("tick", () => {
      linkSel
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
    });

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

/* ---------------- detail / annotate panel ---------------- */

function openDetail(id) {
  const card = board.find(b => b.id === id);
  if (!card) return;

  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  content.innerHTML = `
    ${card.image ? `<img src="${card.image}" alt="">` : ""}
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
  };
  tagInput.addEventListener("change", commit);
  noteInput.addEventListener("change", commit);

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
  if (view === "graph") renderGraph();
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
  renderBoard();
  renderGraph();
});

/* ---------------- init ---------------- */

renderBoard();
refreshBoardCount();

(async function initArenaConnection() {
  await handleOAuthRedirect();          // in case we just came back from are.na/oauth/authorize
  if (getArenaToken()) {
    const me = JSON.parse(sessionStorage.getItem("arena_me") || "null");
    if (me) {
      showConnectedUI(me.name);
      await loadMyChannels();
    } else {
      await loadArenaProfile();
    }
  }
})();