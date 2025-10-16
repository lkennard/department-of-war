// index.js
import express from 'express';
import { chromium } from 'playwright'; // runtime browser (not @playwright/test)

/* ======================= Config ======================= */

const app = express();
const PORT = process.env.PORT || 3000;

const UA =
  'VertaSignalsBot/1.0 (contact: logan@keepitrealty.org; purpose: regulatory-news-monitor)';
const RSS_URL =
  'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=10';

// spacing between contract page parses (ms)
const WAIT_MS = Number(process.env.WAIT_MS || 1500);
// max articles to ingest per /ingest call
const MAX_CONTRACTS = Number(process.env.MAX_CONTRACTS || 5);

// optional Supabase persistence
const SB_URL = process.env.SUPABASE_URL; // e.g. https://xxxx.supabase.co
const SB_KEY = process.env.SUPABASE_KEY; // service role or anon with insert
const SB_TABLE = process.env.SUPABASE_TABLE || 'news_events';

app.use(express.json());

// --- CORS (no extra dependency) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // lock down later if needed
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, apikey, prefer'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ======================= Browser management ======================= */

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    try {
      (await browserPromise).close();
    } catch {}
    browserPromise = null;
  }
}

/* ======================= Helpers ======================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with timeout
async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function extractTag(block, tag) {
  const cdataRegex = new RegExp(
    `<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`,
    'i',
  );
  const normalRegex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');

  const cdataMatch = block.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const normalMatch = block.match(normalRegex);
  if (normalMatch) return normalMatch[1].trim();

  return '';
}

function normalizeUrl(url) {
  try {
    let u = String(url || '').trim();
    u = u.replace(/^http:/i, 'https:');
    u = u.replace(/\/\/(www\.)?war\.gov\//i, '//www.defense.gov/');
    u = u.replace(/\/\/defense\.gov\//i, '//www.defense.gov/');
    return u;
  } catch {
    return url;
  }
}

function toISO(d) {
  const t = Date.parse(d || '');
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

function parseRss(xml) {
  if (!xml || !xml.includes('<item>')) return [];
  const items = [];
  const re = new RegExp('<item>([\\s\\S]*?)<\\/item>', 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, 'title');
    const pub = extractTag(block, 'pubDate');
    let link = normalizeUrl(extractTag(block, 'link'));
    if (link) items.push({ title, link, pub });
  }
  return items;
}

/** Heuristics to parse awards from the readable text of a contract page */
const SERVICES = [
  'ARMY',
  'NAVY',
  'AIR FORCE',
  'MARINE CORPS',
  'SPACE FORCE',
  'DEFENSE LOGISTICS AGENCY',
  'MISSILE DEFENSE AGENCY',
  'U.S. SPECIAL OPERATIONS COMMAND',
  'COAST GUARD',
  'DEFENSE HEALTH AGENCY',
  'DEFENSE INFORMATION SYSTEMS AGENCY',
  'WASHINGTON HEADQUARTERS SERVICES',
  'DEPARTMENT OF THE ARMY',
  'DEPARTMENT OF THE NAVY',
  'DEPARTMENT OF THE AIR FORCE',
  'DEPARTMENT OF DEFENSE',
];
const serviceRe = new RegExp(
  `^(?:${SERVICES.map((s) => s.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'i',
);

function parseAmount(s) {
  const m = s.match(/\$[\d,]+(?:\.\d+)?(?:\s*(million|billion))?/i);
  if (!m) return { amount: null, unit: null, text: null };
  let n = Number(
    m[0].replace(/[$,]/g, '').replace(/\s*(million|billion)/i, ''),
  );
  if (/billion/i.test(m[0])) n *= 1_000_000_000;
  else if (/million/i.test(m[0])) n *= 1_000_000;
  return { amount: n, unit: 'USD', text: m[0] };
}

function parseVendors(s) {
  const m = s.match(
    /^([\w\s&.,'/-]+?)(?:,|\s+of\s+|\s+for\s+|\s+\$|\s+has been|\s+is being)/i,
  );
  const v = m ? m[1].trim() : '';
  return v ? [v] : [];
}

function parseContractIds(s) {
  const ids = Array.from(
    s.matchAll(/\b[A-Z]{1,3}\w{1,10}-\d{2}-[A-Z]?\w{0,4}-?\w+\b/g),
  ).map((x) => x[0]);
  return ids;
}

function parseAwardsFromText(text, ctx) {
  const paras = String(text || '')
    .replace(/\r/g, '')
    .split(/\n{2,}/);
  let current = 'DEPARTMENT OF DEFENSE';
  const events = [];

  for (const p of paras) {
    const line = p.trim();
    if (!line || line.length < 40) continue;

    if (serviceRe.test(line.toUpperCase())) {
      current = line.toUpperCase().replace(/:$/, '');
      if (current === 'DLA') current = 'DEFENSE LOGISTICS AGENCY';
      continue;
    }

    if (/^editor[’']s note|^today[’']s department/i.test(line)) continue;

    const amt = parseAmount(line);
    const vendors = parseVendors(line);
    const cids = parseContractIds(line);

    events.push({
      source: 'dod_contracts',
      source_url: ctx.link,
      published_at: toISO(ctx.pub),
      title: `${current} contract award`,
      summary: line.slice(0, 280),
      body_text: line,
      agencies: ['Department of Defense', current],
      committees: [],
      vendors,
      tickers: [],
      ciks: [],
      bill_ids: [],
      reason_codes: ['CONTRACT_AWARD', 'DOD_PROCUREMENT'],
      amount: amt.amount,
      amount_unit: amt.unit,
      amount_text: amt.text,
      contract_id: cids[0] || null,
      assistance_listing: null,
      meta: { source_type: 'ingest', original_link: ctx.link, contract_ids: cids },
    });
  }

  return events;
}

async function saveToSupabase(rows) {
  if (!SB_URL || !SB_KEY || !rows?.length) {
    return { saved: 0, skipped: rows?.length || 0 };
  }

  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/${SB_TABLE}?on_conflict=source_url,contract_id`,
    {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        authorization: `Bearer ${SB_KEY}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    },
    30000
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${res.status}: ${t}`);
  }
  return { saved: rows.length, skipped: 0 };
}

/* ======================= Routes ======================= */

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'DoD Contract Scraper API (Playwright + rate limits)',
  });
});

/**
 * GET /contracts
 * Fetch RSS (no browser), return { title, link, pub }[]
 */
app.get('/contracts', async (_req, res) => {
  try {
    const rss = await fetchWithTimeout(
      RSS_URL,
      { headers: { 'user-agent': UA, accept: 'application/rss+xml' } },
      30000
    );
    const xml = await rss.text();
    const items = parseRss(xml);
    res.json({ success: true, count: items.length, contracts: items });
  } catch (error) {
    console.error('Error fetching RSS:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /contract-detail
 * { url } -> scrape readable text from a single article, with optional delayMs
 */
app.post('/contract-detail', async (req, res) => {
  let context;
  const delayMs = Number(req.query.delayMs || 0);

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL is required' });

    if (delayMs > 0) await sleep(delayMs);

    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    });

    const page = await context.newPage();

    // Block heavy resources
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);

    const content = await page.evaluate(() => {
      const el =
        document.querySelector('.article-content') ||
        document.querySelector('article') ||
        document.querySelector('.body-copy') ||
        document.querySelector('main') ||
        document.querySelector('.content') ||
        document.body;
      return el.innerText;
    });

    const title = await page.title();
    await context.close();

    res.json({ success: true, url, title, content: String(content || '').trim() });
  } catch (error) {
    if (context) {
      try { await context.close(); } catch {}
    }
    console.error('Error contract-detail:', error);
    res.status(500).json({ success: false, error: error.message, url: req.body?.url });
  }
});

/**
 * POST /ingest?limit=5&save=true
 */
app.post('/ingest', async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit || MAX_CONTRACTS), 20));
  const doSave = String(req.query.save || '').toLowerCase() === 'true';

  let context;
  const allEvents = [];

  try {
    // 1) RSS (no browser)
    const rssResp = await fetchWithTimeout(
      RSS_URL,
      { headers: { 'user-agent': UA, accept: 'application/rss+xml' } },
      30000
    );
    const xml = await rssResp.text();
    const items = parseRss(xml).slice(0, limit);

    const browser = await getBrowser();

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (i > 0) await sleep(WAIT_MS);

      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      });
      const page = await context.newPage();

      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'font', 'media'].includes(type)) return route.abort();
        route.continue();
      });

      try {
        await page.goto(it.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(800);

        const readable = await page.evaluate(() => {
          const el =
            document.querySelector('.article-content') ||
            document.querySelector('article') ||
            document.querySelector('.body-copy') ||
            document.querySelector('main') ||
            document.querySelector('.content') ||
            document.body;
          return el.innerText;
        });

        const events = parseAwardsFromText(readable, it);
        allEvents.push(...events);
      } catch (e) {
        console.error('Page fetch failed:', it.link, e.message);
      } finally {
        try { await context.close(); } catch {}
      }
    }

    // 3) Optional persistence
    let saved = 0;
    if (doSave && allEvents.length) {
      const r = await saveToSupabase(allEvents);
      saved = r.saved;
    }

    res.json({
      success: true,
      articles: items.length,
      events: allEvents.length,
      saved,
      sample: allEvents.slice(0, 3),
    });
  } catch (error) {
    if (context) {
      try { await context.close(); } catch {}
    }
    console.error('Error ingest:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ======================= Server startup & guards ======================= */

app.listen(PORT, () => {
  console.log(`DoD Contract Scraper listening on port ${PORT}`);
});

// Memory guard (Render hard limit protection)
setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > 400 * 1024 * 1024) {
    console.error(
      `Memory usage too high: ${(rss / 1024 / 1024).toFixed(1)}MB - restarting`,
    );
    process.exit(1);
  }
}, 30000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});
