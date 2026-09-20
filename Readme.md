# Constellation

A small web app that pulls moodboard material from [Are.na](https://www.are.na) — the collaborative image/link/note-collecting platform — and lets you curate it into your own board, annotate each piece with tags and notes, and see how your saved pieces connect to each other as a force-directed graph (Obsidian-style), instead of Are.na's own flat channel view.

**[Live demo →] (https://lemonnabber.github.io/constellation/)**

## How it works

1. **Search** — type a topic into the search box. This calls Are.na's public search endpoint to find channels (curated collections) matching your query.
2. **Browse** — click a channel to load its contents (images, text notes, links) into a Pinterest-style masonry grid.
3. **Pin** — click **+ pin** on anything you like to save it to *your board* (kept in your browser's `localStorage`, not sent anywhere).
4. **Annotate** — open a pinned card and add your own tags and notes.
5. **Graph** — switch to the Graph view to see your board rendered as a node graph: cards automatically link to each other when they share a tag or came from the same Are.na channel, and you can drag nodes, zoom, and click a node to inspect/annotate it.
6. **(Optional) Connect your Are.na account** — click **Connect Are.na account** in the sidebar to sign in with Are.na itself. Once connected, your own channels (including private ones) appear under "Your channels," and you can pull them into the board/graph exactly like public search results.

### Setting up the "Connect your account" feature

This step is optional — public search/browse works with zero setup. To enable login:

1. Go to [are.na/oauth/applications](https://www.are.na/oauth/applications) and create a new application.
2. Set its **redirect URI** to wherever you're running this app — e.g. `http://localhost:8000/` while testing locally, and your GitHub Pages URL (e.g. `https://yourname.github.io/constellation/`) once deployed. (Are.na apps can usually list more than one redirect URI — add both.)
3. Copy the generated **Client ID** and paste it into the `ARENA_CLIENT_ID` constant near the top of `app.js`.

This uses the **OAuth2 Authorization Code flow with PKCE**, which is specifically designed for client-side apps: there's no client *secret* involved at all, only a public Client ID, so it's safe to commit to the repo. The app generates a one-time code challenge, sends you to are.na to approve access, and exchanges the returned code for an access token directly from the browser. The token is kept in `sessionStorage` only (cleared when you close the tab) — it is never sent anywhere except `api.are.na`.

## About the API call

This project calls the **official Are.na REST API v2** (`https://api.are.na/v2`) directly from client-side JavaScript using the browser's built-in `fetch()` — no libraries or SDK needed. Two endpoints are used: `GET /search/channels?q=<query>` returns an array of matching channel objects (title, slug, block count, owner); `GET /channels/<slug>?per=60` returns a channel's metadata plus a `contents` array of up to 60 "blocks," each block being an object with a `class` field (`Image`, `Text`, `Link`, etc.) and, depending on type, an `image.display.url`, `content`/`content_html`, or `source.url` field. All responses are plain JSON. **No API key is required** for these read/search endpoints, which is why this app can run entirely as a static site with no backend and no secrets to protect.

The optional "Connect your Are.na account" feature calls Are.na's newer **v3 API** instead, using the OAuth2 **Authorization Code + PKCE** flow (`POST https://api.are.na/v3/oauth/token`, `GET /v3/me`, `GET /v3/users/{slug}/contents?type=Channel`, `GET /v3/channels/{id}/contents`), with the resulting per-user access token sent as an `Authorization: Bearer` header. PKCE exists precisely for apps like this one — there is no client secret to protect, only a public Client ID, which is why this can safely run as pure client-side JavaScript with no backend. This is a nice contrast to typical keyed APIs: if you needed a *secret*-based key instead (e.g. Are.na's personal access tokens for scripted/back-end use), you would store that token in an environment variable or a local, git-ignored config file and call it from a small backend, never from browser JavaScript, since anything in client-side JS is visible to any visitor via dev tools.

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
- Are.na's unified full-text search (`/v3/search`) requires a Premium Are.na subscription, so the public "search channels" box intentionally uses the older, free `/v2/search/channels` endpoint instead. The "Your channels" list (once connected) uses `/v3/users/{slug}/contents`, which isn't Premium-gated.
- The OAuth connection is kept in `sessionStorage`, so you'll need to reconnect if you close the tab — this was a deliberate choice to avoid a never-expiring access token sitting in `localStorage` indefinitely.
