# Signal Brief — Market Intelligence Dashboard

A static dashboard, refreshed twice daily (6:00 AM and 1:00 PM Eastern) by a
GitHub Actions cron that calls Claude with the `web_search` tool and commits
the fresh briefing as JSON. Deployed on Vercel.

## How it works

```
GitHub Actions cron  →  node scripts/generate.mjs
                        ↓
                        Anthropic API + web_search
                        ↓
                        public/briefing.json  (committed back to repo)
                        ↓
                        Vercel redeploys on push
                        ↓
                        Your public URL serves the updated dashboard
```

The browser never sees your API key. It only fetches `/briefing.json` from your
own domain.

## One-time setup

### 1. Get an Anthropic API key

https://console.anthropic.com/ → *Settings → API Keys → Create Key*.
Copy the `sk-ant-...` value. Make sure the workspace has access to web search
(it's on by default for most accounts).

### 2. Push this folder to a new GitHub repo

```bash
cd market-briefing
git init
git add .
git commit -m "initial commit"
gh repo create signal-brief --public --source=. --push
# or, without gh:
#   create the repo on github.com, then:
#   git remote add origin git@github.com:YOUR_USER/signal-brief.git
#   git branch -M main
#   git push -u origin main
```

### 3. Add the API key as a GitHub secret

Repo → *Settings → Secrets and variables → Actions → New repository secret*

- **Name:** `ANTHROPIC_API_KEY`
- **Value:** your `sk-ant-...` key

### 4. Trigger the first run manually

Repo → *Actions → refresh-briefing → Run workflow*.
Leave the "force" input as `true` so it bypasses the timezone gate for the first
run. After ~30 seconds, `public/briefing.json` will be updated and committed.

### 5. Deploy to Vercel

1. Go to https://vercel.com/new
2. Import the GitHub repo
3. Framework preset: **Other** (Vercel auto-detects `vercel.json`)
4. Click **Deploy**

You'll get a URL like `https://signal-brief.vercel.app`. Every time the cron
commits a new briefing, Vercel redeploys automatically.

(Netlify, Cloudflare Pages, and GitHub Pages all work identically — point them
at the `public/` folder.)

## Local development

```bash
# Generate a briefing locally (requires ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=sk-ant-...
npm run generate:force   # bypasses the TZ check

# Serve the dashboard locally
cd public && python3 -m http.server 8080
# open http://localhost:8080
```

## Schedule details

GitHub Actions cron only speaks UTC, and the US switches between EDT (UTC-4)
and EST (UTC-5). The workflow fires 4 times a day to cover both offsets:

| Cron (UTC) | EDT (Mar-Nov) | EST (Nov-Mar) |
|---|---|---|
| 10:00 | 06:00 ✓ | 05:00 |
| 11:00 | 07:00 | 06:00 ✓ |
| 17:00 | 13:00 ✓ | 12:00 |
| 18:00 | 14:00 | 13:00 ✓ |

`scripts/generate.mjs` checks `America/New_York` local hour and exits early
unless it's 6 or 13. Net effect: exactly two runs per day, always at the right
local time, regardless of DST.

## Files

| Path | What it does |
|---|---|
| `scripts/generate.mjs` | Calls Claude with `web_search`, writes `public/briefing.json` |
| `.github/workflows/refresh.yml` | Cron + commit-on-change |
| `public/index.html` | The dashboard |
| `public/briefing.json` | The latest briefing (overwritten by the cron) |
| `vercel.json` | Tells Vercel to serve `public/` |

## Troubleshooting

**"briefing.json not found"** on the live site — the first cron run hasn't
committed yet. Go to *Actions → refresh-briefing → Run workflow* to trigger it.

**API 401** — the `ANTHROPIC_API_KEY` secret isn't set or is invalid.

**Workflow runs but doesn't commit** — the TZ gate skipped it (expected 3 out
of 4 runs). Use the "Run workflow" button with `force=true` to generate on
demand.

**Parse errors in the logs** — Claude occasionally wraps the JSON in prose or
fences despite the system prompt; the extractor handles both, but if it fails
the raw output is logged in the Actions run.
