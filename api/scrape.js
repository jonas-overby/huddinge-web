import fetch from "node-fetch"; // inbyggt i Node 18 via global fetch, men behåller import för tydlighet
import * as cheerio from "cheerio";

const BASE = "https://sammantraden.huddinge.se";
const SEARCH = `${BASE}/search`;
const DATE_RX = /\b(20\d{2})[-/.](\d{2})[-/.](\d{2})\b/;

function parseDate(text) {
  const m = DATE_RX.exec(text || "");
  if (!m) return null;
  const [_, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return isNaN(dt) ? null : dt;
}

function rowHtml(item) {
  const date = item.date ? item.date.toISOString().slice(0,10) : "—";
  const title = item.title || "—";
  const titleHtml = item.pageUrl
    ? `<a href="${item.pageUrl}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  const dl = item.downloadUrl
    ? ` · <a href="${item.downloadUrl}" target="_blank" rel="noopener">Ladda ner</a>`
    : "";
  return `<tr><td class="date-col">${date}</td><td>${titleHtml}${dl}</td></tr>`;
}

function escapeHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function fetchPage(q, page) {
  const url = `${SEARCH}?text=${encodeURIComponent(q)}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const html = await res.text();
  return cheerio.load(html);
}

function findCards($) {
  const cards = [];
  $("li,div").each((_, el) => {
    const nodeTxt = $(el).text() || "";
    if (DATE_RX.test(nodeTxt) && $(el).find("a[href]").length) {
      const t = nodeTxt.trim();
      if (t.length < 5000) cards.push($(el));
    }
  });
  return cards;
}

function extractCard($card) {
  // titel-länk: första <a> med text
  let title = "";
  let pageUrl = null;
  const aEls = $card.find("a[href]");
  for (let i = 0; i < aEls.length; i++) {
    const a = aEls.eq(i);
    const txt = (a.text() || "").trim();
    const href = a.attr("href") || "";
    if (txt && !href.startsWith("#")) {
      title = txt;
      pageUrl = new URL(href, BASE).toString();
      break;
    }
  }

  const raw = $card.text() || "";
  const date = parseDate(raw);

  // försök hitta PDF-/download-länk
  let downloadUrl = null;
  aEls.each((_, el) => {
    const h = aEls.eq(_).attr("href") || "";
    if (h.toLowerCase().endsWith(".pdf") || h.toLowerCase().includes("download")) {
      downloadUrl = new URL(h, BASE).toString();
      return false;
    }
  });

  return { title, pageUrl, downloadUrl, date };
}

function hasNextPage($) {
  let found = false;
  $("a[href]").each((_, a) => {
    const txt = ($(a).text() || "").toLowerCase();
    if (txt.includes("nästa") || txt.includes("next")) found = true;
  });
  if (found) return true;
  return $("ul.pagination li a[href]").length > 0;
}

function htmlDoc(rowsHtml, q, count) {
  const gen = new Date().toISOString().replace("T", " ").replace(".000Z", " UTC");
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Huddinge – sorterade sökresultat: ${escapeHtml(q)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 24px; }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  .meta { color:#555; margin-bottom:12px; }
  .buttons { margin:14px 0 22px; display:flex; gap:10px; flex-wrap:wrap; }
  .btn { display:inline-block; padding:10px 14px; border-radius:8px; text-decoration:none; border:1px solid #d0d7de; }
  .btn:hover { background:#f6f8fa; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 10px 8px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { text-align: left; }
  tr:hover td { background: #fafafa; }
  .date-col { width: 120px; white-space: nowrap; }
</style>
</head>
<body>
  <h1>Huddinge – sorterade sökresultat</h1>
  <div class="meta">Sökterm: <strong>${escapeHtml(q)}</strong> · Antal: ${count} · Genererad: ${gen}</div>

  <div class="buttons">
    <a id="refresh" class="btn" href="#">↻ Uppdatera nu</a>
  </div>

  <table>
    <thead><tr><th class="date-col">Datum</th><th>Titel &amp; länkar</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>

<script>
  document.getElementById('refresh').addEventListener('click', (e) => {
    e.preventDefault();
    const url = new URL(window.location.href);
    url.searchParams.set('t', Date.now()); // cache-bust
    window.location.href = url.toString();
  });
</script>

</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    const { searchParams } = new URL(req.url, "http://x");
    const q = searchParams.get("q") || "Solfagraskolan";

    let page = 1;
    const items = [];
    while (true) {
      const $ = await fetchPage(q, page);
      const cards = findCards($);
      for (const $card of cards) {
        const item = extractCard($card);
        if (item.title || item.pageUrl) items.push(item);
      }
      if (!hasNextPage($)) break;
      page += 1;
      if (page > 50) break; // skydd
    }

    const withDate = items.filter(x => x.date);
    const withoutDate = items.filter(x => !x.date);
    withDate.sort((a,b) => b.date - a.date);
    const sorted = [...withDate, ...withoutDate];

    const rows = sorted.map(rowHtml).join("");
    const html = htmlDoc(rows, q, sorted.length);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send(`<pre>${String(err)}</pre>`);
  }
}

