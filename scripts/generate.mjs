// scripts/generate.mjs
// Runs on a schedule. Calls Claude with the web_search server tool to produce a
// fresh market briefing, then writes public/briefing.json for the static site.
//
// Requires: ANTHROPIC_API_KEY in the environment.
// Node 18+ (for native fetch).

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../public/briefing.json");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

// ---- Optional: gate on local Eastern time so DST doesn't drift the briefing.
// GitHub Actions cron only speaks UTC. We trigger the workflow 4 times a day
// (covering both EDT and EST offsets) and only actually generate when the
// current America/New_York hour is 6 or 13. Set SKIP_TZ_CHECK=1 to bypass.
if (!process.env.SKIP_TZ_CHECK) {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
  if (etHour !== 6 && etHour !== 13) {
    console.log(`Skipping: current ET hour is ${etHour}, not 6 or 13.`);
    process.exit(0);
  }
}

const MODEL = "claude-sonnet-4-5-20250929";

const SYSTEM = `You are a senior market analyst writing a twice-daily intelligence briefing focused on NEWS EVENTS that move stock and crypto markets.

Use the web_search tool aggressively to find the latest news from the past ~12 hours. Prioritize, in order:
1. Fed / central bank actions, rate decisions, FOMC minutes, Powell/ECB/BOJ remarks
2. Macro data releases (CPI, PCE, jobs, GDP, PMI) and how markets reacted
3. Earnings beats/misses from market-moving names (mega-cap tech, banks, crypto-adjacent)
4. Crypto-specific catalysts: ETF flows, regulatory actions (SEC/CFTC), major protocol events, exchange news, whale moves, stablecoin issues
5. Geopolitical or policy shocks with clear market impact (tariffs, sanctions, oil supply)
6. Company-specific news (M&A, guidance cuts, product launches) with clear ticker impact

Cite at least 4 distinct sources from reputable financial press (Bloomberg, Reuters, WSJ, FT, CoinDesk, The Block, CNBC).

Return your answer as a SINGLE JSON object, with NO markdown fences and NO prose outside the JSON. Shape:
{
  "summary": "2-3 short paragraphs, ~180 words total, plain prose — no bullets. Focus on what happened in the news and why it matters for markets today.",
  "signals": [
    { "type": "bullish" | "bearish" | "neutral", "title": "specific news event as headline", "desc": "one sentence: what happened and the likely market impact", "asset": "stocks|crypto|macro|commodities|fx" }
  ],
  "tickers": [
    { "symbol": "SPY", "price": "524.10", "change_pct": "+0.42" }
  ],
  "verdict": "one-sentence overall outlook for today's session",
  "sentiment": "bullish" | "bearish" | "mixed",
  "sources": ["https://..."]
}

Rules:
- Include exactly 5 signals. Each signal MUST be tied to a specific recent news event, not a generic observation.
- Mix of signal types should reflect the actual news flow (don't force balance if news is one-sided).
- Include tickers for: SPY, QQQ, BTC, ETH, GOLD, OIL, DXY — latest intraday or last close.
- "change_pct" must include the sign (e.g. "+0.42" or "-1.10").
- Escape any quotes inside strings. No trailing commas.`;

const body = {
  model: MODEL,
  max_tokens: 4000,
  system: SYSTEM,
  tools: [
    { type: "web_search_20250305", name: "web_search", max_uses: 6 },
  ],
  messages: [
    {
      role: "user",
      content:
        "Produce today's market briefing. Use web_search for fresh data. Return only the JSON object.",
    },
  ],
};

console.log(`Calling ${MODEL}…`);
const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  const text = await res.text();
  console.error(`API ${res.status}: ${text}`);
  process.exit(1);
}

const data = await res.json();

// Extract only the final text blocks. When web_search is in play, the response
// also contains server_tool_use and web_search_tool_result blocks — skip those.
const rawText = (data.content || [])
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("")
  .trim();

if (!rawText) {
  console.error("No text block in response. stop_reason:", data.stop_reason);
  console.error(JSON.stringify(data).slice(0, 1000));
  process.exit(1);
}

// Defensive JSON extraction — strip code fences, find outermost {...}.
function extractJson(s) {
  const noFence = s.replace(/```json|```/gi, "").trim();
  const match = noFence.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in model output");
  return JSON.parse(match[0]);
}

let parsed;
try {
  parsed = extractJson(rawText);
} catch (e) {
  console.error("Failed to parse model JSON:", e.message);
  console.error("Raw text was:\n", rawText.slice(0, 1500));
  process.exit(1);
}

// Collect source URLs from web_search_tool_result blocks as a fallback.
if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
  const urls = [];
  for (const block of data.content || []) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === "web_search_result" && r.url) urls.push(r.url);
      }
    }
  }
  parsed.sources = [...new Set(urls)].slice(0, 10);
}

// ---- Attach Fear & Greed indices ---------------------------------------
// Both calls are best-effort: a failure on either leaves the field null and
// the dashboard simply hides that gauge.
parsed.fear_greed = await fetchFearGreed();

parsed.generated_at = new Date().toISOString();
parsed.model = MODEL;

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(parsed, null, 2) + "\n");
console.log(`Wrote ${OUT_PATH}`);
console.log(`  signals: ${parsed.signals?.length ?? 0}`);
console.log(`  tickers: ${parsed.tickers?.length ?? 0}`);
console.log(`  sources: ${parsed.sources?.length ?? 0}`);
console.log(`  fear_greed.stocks: ${parsed.fear_greed?.stocks ? parsed.fear_greed.stocks.value + ' (' + parsed.fear_greed.stocks.label + ')' : 'unavailable'}`);
console.log(`  fear_greed.crypto: ${parsed.fear_greed?.crypto ? parsed.fear_greed.crypto.value + ' (' + parsed.fear_greed.crypto.label + ')' : 'unavailable'}`);

// ---- Fear & Greed fetchers ---------------------------------------------
async function fetchFearGreed() {
  const [stocks, crypto] = await Promise.all([
    fetchCnnFearGreed().catch((e) => {
      console.warn("CNN F&G failed:", e.message);
      return null;
    }),
    fetchCryptoFearGreed().catch((e) => {
      console.warn("Crypto F&G failed:", e.message);
      return null;
    }),
  ]);
  return { stocks, crypto };
}

async function fetchCnnFearGreed() {
  // CNN's Fear & Greed endpoint is undocumented but widely relied on.
  // Requires a real-looking User-Agent or it 418s.
  const res = await fetch(
    "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const fg = data.fear_and_greed;
  if (!fg || typeof fg.score !== "number") {
    throw new Error("Unexpected CNN payload shape");
  }
  return {
    value: Math.round(fg.score),
    label: titleCase(String(fg.rating || "")),
    previous_close:
      typeof fg.previous_close === "number"
        ? Math.round(fg.previous_close)
        : null,
    updated: fg.timestamp || null,
  };
}

async function fetchCryptoFearGreed() {
  const res = await fetch("https://api.alternative.me/fng/?limit=1");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const d = data?.data?.[0];
  if (!d) throw new Error("Unexpected Alt.me payload shape");
  return {
    value: Number(d.value),
    label: d.value_classification,
    updated: d.timestamp
      ? new Date(Number(d.timestamp) * 1000).toISOString()
      : null,
  };
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
