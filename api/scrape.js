// /api/scrape.js  (no external deps)
const BASE = "https://sammantraden.huddinge.se";
const SEARCH = `${BASE}/search`;

// YYYY-MM-DD (tillåter även / och . som separators)
const DATE_RX = /\b(20\d{2})[-/.](\d{2})[-/.](\d{2})\b/g;

const A_TAG_RX = /<a\s+[^>]*href\s*=\s*"(.*?)"[^>]*>([\s\S]*?)<\/a>/gi;

// Hjälp: enkel HTML-escaper för output
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseDateOne(s) {
  const m = /\b(20\d{2})[-/.](\d{2})[-/.](\d{2})\b/.exec(s || "");
  if (!m) return null;
  const [_, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return isNaN(dt) ? null : dt;
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Plocka ut kandidater runt varje datumträff och försök hitta vettig titel-länk
function extractItemsFromHtml(html) {
  const items = [];
  const text = html;

  // Hitta alla datumträffar + positioner
  let m;
  while ((m = DATE_RX.exec(text)) !== null) {
    const dateStr = m[0];
    const pos = m.index;

    // Ta ett fönster runt datumet (kan justeras)
    const start = Math.max(0, pos - 2000);
    const end = Math.min(text.length, pos + 2000);
    const windowHtml = text.slice(start, end);

    // Samla alla <a> i fönstret
    const anchors = [];
    let am;
    while ((am = A_TAG_RX.exec(windowHtml)) !== null) {
      const href = am[1] || "";
      const inner = am[2] || "";
      const txt = stripTags(inner);
      anchors.push({ href, txt });
    }

    // Heuristik: välj den FÖRSTA ankarlänken som ser ut som titel (inte tom, inte "#")
    let title = "";
    let pageUrl = null;
    for (const a of anchors) {
      if (!a.txt) continue;
      if (a.href.startsWith("#")) continue;
      // hoppa över rena "Ladda ner"-länkar som titel
      if (/ladda\s*ner/i.test(a.txt)) continue;
      title = a.txt;
      try {
        pageUrl = new URL(a.href, BASE).toString();
      } catch {
        pageUrl = null;
      }
      if (title && pageUrl) break;
    }

    // Leta separat efter en pdf-/download-länk i samma fönster
    let downloadUrl = null;
    for (const a of anchors) {
      const h = a.href.toLowerCase();
      if (h.endsWith(".pdf") || h.includes("download")) {
        try {
          downloadUrl = new URL(a.href, BASE).toString();
        } catch { /* ignore */ }
        if (downloadUrl) break;
      }
    }

    const date = parseDateOne(dateStr);

    // Lägg till kandidat om vi fick något vettigt
    if (title || pageUrl || date) {
      items.push({ title, pageUrl, downloadUrl, date, _pos: pos });
    }
  }

  // Rensa upp dubbletter (samma titel + datum)
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

// Enkel detektor för om det finns fler sidor (sök efter "Nästa" eller rel=next eller page=...)
function hasNextPage(html) {
  if (/rel=["']?next["']?/i.test(html)) return true;
  if (/>Nästa</i.test(html)) return true;
  // fallback: om det finns page=2,3,... länkar – vi använder enklare heuristik
  if (/[\?&]page=\d+/.test(html)) return true;
  return false;
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
  return await res.text();
}

function rowHtml(item) {
  const date = item.date ? item.date.toISOString().slice(0, 10) : "—";
  const title = item.title || "—";
  const titleHtml = item.pageUrl
    ? `<a href="${item.pageUrl}" target="_blank" rel="noopener">${esc(title)}</a>`
    : esc(title);
  const dl = item.downloadUrl
    ? ` · <a href="${item.downloadUrl}" target="_blank" rel="noopener">Ladda ner</a>`
    : "";
  return `<tr><td class="date-col">${date}</td><td>${titleHtml}${dl}</td></tr>`;
}

function htmlDoc(rowsHtml, q, count) {
  const gen = new Date().toISOString().replace("T", " ").replace(".000Z", " UTC");
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Huddinge – sorterade sökresultat: ${esc(q)}</title>
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
  <div class="meta">Sökterm: <strong>${esc(q)}</strong> · Antal: ${count} · Genererad: ${gen}</div>

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
    const u = new URL(window.location.href);
    u.searchParams.set('t', Date.now()); // cache-bust
    window.location.href = u.toString();
  });
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams.get("q") || "Solfagraskolan";

    let page = 1;
    const items = [];
    while (true) {
      const html = await fetchPage(q, page);
      const more = extractItemsFromHtml(html);
      items.push(...more);
      if (!hasNextPage(html)) break;
      page += 1;
      if (page > 50) break; // safety
    }

    // sortera: med datum (desc) först, sedan utan datum
    const withDate = items.filter(x => !!x.date).sort((a,b) => b.date - a.date);
    const withoutDate = items.filter(x => !x.date);
    const sorted = [...withDate, ...withoutDate];

    const rows = sorted.map(rowHtml).join("");
    const html = htmlDoc(rows, q, sorted.length);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send(
      `<pre>${(err && err.stack) ? esc(err.stack) : esc(String(err))}</pre>`
    );
  }
}
