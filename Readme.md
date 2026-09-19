# Constellation

A small web app that pulls moodboard material from [Are.na](https://www.are.na) — the collaborative image/link/note-collecting platform — and lets you curate it into your own board, annotate each piece with tags and notes, and see how your saved pieces connect to each other as a force-directed graph (Obsidian-style), instead of Are.na's own flat channel view.

**[Live demo →](#)** *(add your GitHub Pages link here once deployed)*

## How it works

1. **Search** — type a topic into the search box. This calls Are.na's public search endpoint to find channels (curated collections) matching your query.
2. **Browse** — click a channel to load its contents (images, text notes, links) into a Pinterest-style masonry grid.
3. **Pin** — click **+ pin** on anything you like to save it to *your board* (kept in your browser's `localStorage`, not sent anywhere).
4. **Annotate** — open a pinned card and add your own tags and notes.
5. **Graph** — switch to the Graph view to see your board rendered as a node graph: cards automatically link to each other when they share a tag or came from the same Are.na channel, and you can drag nodes, zoom, and click a node to inspect/annotate it.

## About the API call

This project calls the **official Are.na REST API v2** (`https://api.are.na/v2`) directly from client-side JavaScript using the browser's built-in `fetch()` — no libraries or SDK needed. Two endpoints are used: `GET /search/channels?q=<query>` returns an array of matching channel objects (title, slug, block count, owner); `GET /channels/<slug>?per=60` returns a channel's metadata plus a `contents` array of up to 60 "blocks," each block being an object with a `class` field (`Image`, `Text`, `Link`, etc.) and, depending on type, an `image.display.url`, `content`/`content_html`, or `source.url` field. All responses are plain JSON. **No API key is required** for these read/search endpoints, which is why this app can run entirely as a static site with no backend and no secrets to protect.

If you ever extend this to endpoints that *do* require authentication (posting new blocks, reading private channels), Are.na issues personal access tokens at [dev.are.na](http://dev.are.na) — you would store that token in an environment variable or a local, git-ignored config file and call it from a small backend, never from browser JavaScript, since anything in client-side JS is visible to any visitor via dev tools.

## Running it

No build step or install required.

```
git clone <this-repo-url>
cd constellation
```

Then just open `index.html` in a browser, **or**, for the most reliable results (some browsers restrict `fetch` on `file://` pages), serve it locally:

```
python3 -m http.server 8000
```

...and visit `http://localhost:8000`.

To deploy it live, push this folder to a GitHub repo and enable **GitHub Pages** (Settings → Pages → deploy from branch) — since no key is needed, it's safe to run entirely client-side.

## Files

- `index.html` — page structure
- `style.css` — visual design (index-card / research-desk aesthetic)
- `app.js` — all logic: Are.na API calls, board state (localStorage), masonry rendering, and the D3 force-graph
- `prompt_log.md` — AI-assistance notes for this assignment

## Notes / known limits

- Only public Are.na channels are searchable (no auth = no private channels).
- Are.na's search endpoint returns channels, not a global block search, so you browse a channel's contents rather than searching individual images directly — this mirrors how Are.na itself works.
- Graph connections are intentionally simple (shared tag or shared source channel) so the logic stays transparent and inspectable — feel free to extend it.