import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import PQueue from 'p-queue';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---- rate-limit + serialize scraping work ----
const queue = new PQueue({
  concurrency: 1,         // one job at a time
  interval: 60_000,       // window = 1 minute
  intervalCap: 30         // up to 30 jobs / minute
});

// ---- one shared browser across requests ----
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
  }
  return browserPromise;
}
async function closeBrowser() {
  if (browserPromise) {
    try { (await browserPromise).close(); } catch {}
    browserPromise = null;
  }
}

// ---- helpers ----
function extractTag(block, tag) {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  return (block.match(cdata)?.[1] || block.match(plain)?.[1] || '').trim();
}
function normalizeUrl(url = '') {
  return String(url)
    .replace(/^http:/i, 'https:')
    .replace(/\/\/(www\.)?war\.gov\//i, '//www.defense.gov/')
    .replace(/\/\/defense\.gov\//i, '//www.defense.gov/');
}

// ---- routes ----
app.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'DoD Contract Scraper API (Playwright + rate limits)' });
});

// fast RSS list (no browser needed)
app.get('/contracts', async (_req, res) => {
  try {
    const rss = await fetch(
      'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=10',
      { headers: { 'User-Agent': 'GovSignalBot/1.0' } }
    ).then(r => r.text());

    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = re.exec(rss)) !== null) {
      const block = m[1];
      items.push({
        title: extractTag(block, 'title'),
        link: normalizeUrl(extractTag(block, 'link')),
        pubDate: extractTag(block, 'pubDate')
      });
    }
    res.json({ success: true, count: items.length, contracts: items });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// Playwright detail (serialized + rate-limited)
app.post('/contract-detail', async (req, res) => {
  const url = normalizeUrl(req.body?.url || '');
  if (!url) return res.status(400).json({ success: false, error: 'url is required' });

  try {
    const result = await queue.add(async () => {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      });
      const page = await ctx.newPage();

      // skip heavy resources
      await page.route('**/*', route => {
        const rt = route.request().resourceType();
        if (['image', 'font', 'media'].includes(rt)) return route.abort();
        route.continue();
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(1500);

      const content = await page.evaluate(() => {
        const el =
          document.querySelector('.article-content') ||
          document.querySelector('article') ||
          document.querySelector('.body-copy') ||
          document.querySelector('main') ||
          document.body;
        return el.innerText || '';
      });
      const title = await page.title();

      await ctx.close();
      return { title, content: content.trim() };
    });

    res.json({ success: true, url, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err?.message || err), url });
  }
});

// graceful shutdown
process.on('SIGTERM', () => closeBrowser().finally(() => process.exit(0)));
process.on('SIGINT',  () => closeBrowser().finally(() => process.exit(0)));

app.listen(PORT, () => console.log(`API listening on ${PORT}`));
