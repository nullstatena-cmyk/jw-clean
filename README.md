# J.W. Cleaning Services — site + intake

Static site on GitHub Pages, with a Cloudflare Worker as the always-up intake
queue and a home dashboard that pulls from it.

```
visitor ──▶ GitHub Pages (static)
               │  POST /submit
               ▼
          Cloudflare Worker ──▶ D1  (row written 'unsent' immediately)
               │                     │
               │ push               │ pulled on recovery
               ▼                     ▼
        Toledo dashboard ◀── GET /pending ─── POST /ack ──▶ 'sent'
```

The point of the shape: **the queue lives at the edge, not in this repo.**
Writing submissions into a git repo would need a write token, and every byte
of JavaScript on a static site is public — the token would be readable by
anyone who opened View Source. D1 gives the same durable `unsent` → `sent`
behaviour with somewhere that can actually accept writes and is never down.

---

## Layout

```
index.html            home
services.html         scope, limits, how a job runs
pricing.html          planning ranges
reviews.html          references + moderated review form
contact.html          bid request form
agreement.html        service terms (draft — needs counsel)
assets/css/styles.css single stylesheet
assets/js/site.js     nav
assets/js/form.js     submit + browser-side outbox
worker/               Cloudflare Worker, D1 schema, config
.nojekyll             stops Pages running Jekyll over the files
```

Pages were generated from a small build script during authoring, but the HTML
in this repo is the source of truth now — edit it directly.

---

## Deploy the site

1. Push to a repo, then **Settings → Pages → Deploy from branch → `main` / root**.
2. For a custom domain, add a `CNAME` file containing the bare domain, and
   point DNS at GitHub Pages. Register the domain in the **business's** name.

Nothing to build. It is flat HTML and CSS.

---

## Deploy the Worker

```bash
cd worker
npm install -g wrangler
wrangler login

wrangler d1 create jw-cleaning
# paste the returned database_id into wrangler.toml

wrangler d1 execute jw-cleaning --remote --file=./schema.sql
wrangler secret put SYNC_TOKEN        # long random string, save in the password manager
wrangler deploy
```

Then set the endpoint on the site. In each page that loads `form.js`, add this
line **before** the script tag:

```html
<script>window.JW_ENDPOINT = 'https://jw-cleaning-intake.<subdomain>.workers.dev/submit';</script>
```

Until that is set, the form saves submissions to the visitor's browser and says
so plainly rather than pretending to send.

Tighten `Access-Control-Allow-Origin` in `worker/src/index.js` from `*` to the
real domain once it is live.

---

## Home dashboard (Toledo)

Expose it with a Cloudflare Tunnel — outbound only, no port forwarding, no home
IP in DNS:

```bash
cloudflared tunnel create jw-dashboard
cloudflared tunnel route dns jw-dashboard dashboard.jwcleaning.com
cloudflared tunnel run --url http://localhost:8787 jw-dashboard
```

The dashboard needs three things:

- `POST /intake` — accepts a pushed submission, checks the `Bearer` token
  matches `SYNC_TOKEN`, stores it, returns `200`. Returning non-200 leaves the
  row `unsent`, which is the correct behaviour.
- A poll loop — every 30s, `GET /pending` with the same bearer token, store
  what comes back, then `POST /ack` with the ids. This is what drains the
  backlog after downtime.
- A view — list, filter by kind, approve or reject reviews.

**Acknowledge only after a successful write.** Acking first and crashing loses
the lead permanently.

---

## Failure behaviour

| What breaks | What happens |
|---|---|
| Toledo box off | Rows sit `unsent` in D1. Cron retries every 5 min. Drained on return. |
| Tunnel drops | Same. |
| Worker down | Cloudflare's problem, effectively never. |
| Visitor loses signal mid-submit | Held in their browser, retried on next visit. |
| Everything on your end is dead | Read `/all` with the sync token, or open D1 in the Cloudflare dashboard. |

That last row is the important one: **the business can read its own leads
without you.** Give the operator the Cloudflare login on day one.

---

## Before launch

- [ ] Replace phone and email placeholders — they appear in every footer
- [ ] Set `window.JW_ENDPOINT`
- [ ] Lock CORS to the real domain
- [ ] Review `agreement.html` before anyone signs it
- [ ] Add the operator as a repo collaborator and Cloudflare account member
- [ ] Shared password manager for both logins

The site deliberately makes no claims about insurance, licensing, or business
registration. If any of that changes, add it back — but only once it is true
and documented, since it is the first thing a management company verifies.
