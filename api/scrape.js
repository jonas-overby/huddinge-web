// /api/scrape.js – generisk sökning, grupperad per månad, robustare länk- och datumlogik

const BASE = "https://sammantraden.huddinge.se";
const SEARCH = `${BASE}/search`;

// YYYY-MM-DD (tillåter även / och . som separators)
const DATE_RX_GLOBAL = /\b(20\d{2})[-/.](\d{2})[-/.](\d{2})\b/g;

// matchar <a ... href="..." ...>...</a> ELLER href='...'
const ANCHOR_RX = /<a\b[^>]*href\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

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

function parseDateOneFromString(s) {
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

/**
 * Ny robust logik:
 *  - iterera över alla <a href="...">…</a> i HTML
 *  - filtrera bort uppenbara navigationslänkar
 *  - ta ett fönster runt varje länk och hitta närmaste datum i just det fönstret
 */
function extractItemsFromHtml(html) {
  const items = [];

  let match;
  while ((match = ANCHOR_RX.exec(html)) !== null) {
    const href = match[2] || "";
    const innerHtml = match[3] || "";
    const text = stripTags(innerHtml);
    const idx = match.index;

    if (!text) continue;
    if (href.startsWith("#")) continue;

    const lowerText = text.toLowerCase();
    // hoppa över uppenbar navigation / knappar
    if (
      lowerText.includes("nästa") ||
      lowerText.includes("föregående") ||
      lowerText.includes("previous") ||
      lowerText.includes("next")
    ) {
      continue;
    }
    if (lowerText.includes("ladda ner")) continue;

    // ta ett fönster runt länken
    const span = 800;
    const start = Math.max(0, idx - span);
    const end = Math.min(html.length, idx + span);
    const windowHtml = html.slice(start, end);

    // leta datum i fönstret, välj närmaste
    const dateRe = new RegExp(DATE_RX_GLOBAL.source, "g");
    let dMatch;
    let bestDelta = Infinity;
    let bestDate = null;

    while ((dMatch = dateRe.exec(windowHtml)) !== null) {
      const dateStr = dMatch[0];
      const datePosInWindow = dMatch.index;
      const datePosInFull = start + datePosInWindow;
      const delta = Math.abs(datePosInFull - idx);
      const dt = parseDateOneFromString(dateStr);
      if (dt && delta < bestDelta) {
        bestDelta = delta;
        bestDate = dt;
      }
    }

    // bygg absolut URL
    let pageUrl = null;
    try {
      pageUrl = new URL(href, BASE).toString();
    } catch {
      pageUrl = null;
    }

    const downloadUrl = pageUrl; // oftast samma som titellänk

    items.push({
      title: text,
      pageUrl,
      downloadUrl,
      date: bestDate,
      _pos: idx,
    });
  }

  // rensa dubbletter (titel + url + datum)
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

    if (!q) {
      const html = buildHtmlByMonth([], "");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
      return;
    }

    const items = [];
    const seenKeys = new Set();

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
