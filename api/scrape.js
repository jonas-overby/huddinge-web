// /api/scrape.js  – generisk sökning, ingen extern dependency

const BASE = "https://sammantraden.huddinge.se";
const SEARCH = `${BASE}/search`;
const DATE_RX = /\b(20\d{2})[-/.](\d{2})[-/.](\d{2})\b/g;
const A_TAG_RX = /<a\s+[^>]*href\s*=\s*"(.*?)"[^>]*>([\s\S]*?)<\/a>/gi;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateOne(s) {
  const m = /\b(20\d{2})[-/.](\d{2})[-/.](\d{2})\b/.exec(s || "");
  if (!m) return null;
  const [_, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return isNaN(dt) ? null : dt;
}

// Hämtar en sida med psize=1000 & pindex=...
async function fetchPage(q, index) {
  const url =
    `${SEARCH}?text=${encodeURIComponent(q)}` +
    `&psize=1000&pindex=${index}`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return await res.text();
}

// Plocka ut kandidater runt varje datum: titel, sidlänk, ev. pdf-länk
function extractItemsFromHtml(html) {
  const items = [];
  const text = html;

  let m;
  while ((m = DATE_RX.exec(text)) !== null) {
    const dateStr = m[0];
    const pos = m.index;

    const start = Math.max(0, pos - 2000);
    const end = Math.min(text.length, pos + 2000);
    const windowHtml = text.slice(start, end);

    const anchors = [];
    let am;
    while ((am = A_TAG_RX.exec(windowHtml)) !== null) {
      const href = am[1] || "";
      const inner = am[2] || "";
      const txt = stripTags(inner);
      anchors.push({ href, txt });
    }

    let title = "";
    let pageUrl = null;
    for (const a of anchors) {
      if (!a.txt) continue;
      if (a.href.startsWith("#")) continue;
      if (/ladda\s*ner/i.test(a.txt)) continue;
      title = a.txt;
      try {
        pageUrl = new URL(a.href, BASE).toString();
      } catch {
        pageUrl = null;
      }
      if (title && pageUrl) break;
    }

    let downloadUrl = null;
    for (const a of anchors) {
      const h = (a.href || "").toLowerCase();
      if (h.endsWith(".pdf") || h.includes("download")) {
        try {
          downloadUrl = new URL(a.href, BASE).toString();
        } catch {}
        if (downloadUrl) break;
      }
    }

    const date = parseDateOne(dateStr);

    if (title || pageUrl || date) {
      items.push({ title, pageUrl, downloadUrl, date, _pos: pos });
    }
  }

  const uniq = [];
  const seen = new Set();
  for (const it of items) {
    const key = `${it.title}__${it.pageUrl || ""}__${it.date ? it.date.toISOString() : ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(it);
    }
  }
  return uniq;
}

function monthLabel(date) {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "Maj", "Jun",
    "Jul", "Aug", "Sep", "Okt", "Nov", "Dec",
  ];
  const y = date.getUTCFullYear();
  const m = months[date.getUTCMonth()] || "";
  return `${m} ${y}`;
}

// Bygger HTML med sökformulär + rubrik per månad
function buildHtmlByMonth(items, q) {
  const gen = new Date().toISOString().replace("T", " ").replace(".000Z", " UTC");
  const hasQuery = q && q.trim() !== "";

  let sections = "";
  let currentYM = null;
  let openTable = false;

  for (const it of items) {
    const d = it.date;
    const ym = d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : "utan-datum";

    if (ym !== currentYM) {
      if (openTable) {
        sections += "</tbody></table>\n";
        openTable = false;
      }
      currentYM = ym;

      if (d) {
        sections += `<h2 class="month-heading">${esc(monthLabel(d))}</h2>\n`;
      } else {
        sections += `<h2 class="month-heading">Utan datum</h2>\n`;
      }

      sections += `<table class="month-table">
<thead><tr><th class="date-col">Datum</th><th>Titel &amp; länkar</th></tr></thead>
<tbody>
`;
      openTable = true;
    }

    const dateStr = it.date ? it.date.toISOString().slice(0, 10) : "—";
    const title = it.title || "—";
    const titleHtml = it.pageUrl
      ? `<a href="${it.pageUrl}" target="_blank" rel="noopener">${esc(title)}</a>`
      : esc(title);
    const dl = it.downloadUrl
      ? ` · <a href="${it.downloadUrl}" target="_blank" rel="noopener">Ladda ner</a>`
      : "";

    sections += `<tr><td class="date-col">${dateStr}</td><td>${titleHtml}${dl}</td></tr>\n`;
  }

  if (openTable) sections += "</tbody></table>\n";

  let metaLine;
  if (!hasQuery) {
    metaLine = "Ingen sökterm angiven. Skriv en sökterm ovan och tryck <strong>Sök</strong>.";
  } else {
    metaLine = `Sökterm: <strong>${esc(q)}</strong> · Antal: ${items.length} · Genererad: ${gen}`;
  }

  const titleText = hasQuery ? `Huddinge – ${esc(q)}` : "Huddinge – sökning";

  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titleText}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 24px; }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  h2.month-heading { margin: 24px 0 8px; font-size: 1.1rem; }
  .meta { color:#555; margin-bottom:12px; }
  .buttons { margin:14px 0 22px; display:flex; gap:10px; flex-wrap:wrap; }
  .btn { display:inline-block; padding:8px 12px; border-radius:8px; text-decoration:none; border:1px solid #d0d7de; font-size:0.9rem; }
  .btn:hover { background:#f6f8fa; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 8px 6px; border-bottom: 1px solid #e5e5e5; vertical-align: top; font-size: 0.9rem; }
  th { text-align: left; }
  tr:hover td { background: #fafafa; }
  .date-col { width: 110px; white-space: nowrap; }
  .search-form { margin: 12px 0 10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .search-input { padding:6px 8px; border-radius:6px; border:1px solid #d0d7de; min-width:220px; }
  .search-submit { padding:7px 13px; border-radius:6px; border:1px solid #0969da; background:#0969da; color:white; cursor:pointer; font-size:0.9rem; }
  .search-submit:hover { background:#0550ae; }
</style>
</head>
<body>
  <h1>Huddinge – sorterade sökresultat</h1>

  <form class="search-form" method="GET">
    <label for="q">Sökterm:</label>
    <input id="q" class="search-input" type="text" name="q"
           placeholder="t.ex. Solfagraskolan, Inomhushall"
           value="${esc(q || "")}">
    <button class="search-submit" type="submit">Sök</button>
  </form>

  <div class="meta">${metaLine}</div>

  <div class="buttons">
    <a id="refresh" class="btn" href="#">↻ Uppdatera nu</a>
  </div>

  ${sections}

<script>
  document.getElementById('refresh').addEventListener('click', (e) => {
    e.preventDefault();
    const u = new URL(window.location.href);
    // behåll q, men bumpa 't' för cache-bust
    u.searchParams.set('t', Date.now());
    window.location.href = u.toString();
  });
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const rawQ = url.searchParams.get("q") || "";
    const q = rawQ.trim();

    // Om ingen sökterm: visa bara sidan med sökfält, inga resultat
    if (!q) {
      const html = buildHtmlByMonth([], "");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
      return;
    }

    const items = [];
    const seenKeys = new Set();

    // Paginerar över pindex = 1,2,3,... med psize=1000
    for (let idx = 1; idx <= 50; idx++) {
      const html = await fetchPage(q, idx);
      const pageItems = extractItemsFromHtml(html);
      if (pageItems.length === 0) break;

      for (const it of pageItems) {
        const key = `${it.title}__${it.pageUrl || ""}__${it.date ? it.date.toISOString() : ""}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          items.push(it);
        }
      }
      if (pageItems.length < 1000) break;
    }

    const withDate = items.filter(x => !!x.date).sort((a, b) => b.date - a.date);
    const withoutDate = items.filter(x => !x.date);
    const sorted = [...withDate, ...withoutDate];

    const html = buildHtmlByMonth(sorted, q);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    res
      .status(500)
      .send(
        `<pre>${(err && err.stack) ? esc(err.stack) : esc(String(err))}</pre>`
      );
  }
}
