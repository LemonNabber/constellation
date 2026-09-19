/* ==========================================================
   Constellation — an Are.na-powered moodboard + graph tool
   API docs: https://dev.are.na/documentation
   No API key required for the public read/search endpoints.
   ========================================================== */

const API_BASE = "https://api.are.na/v2";
const STORAGE_KEY = "constellation-board-v1";

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