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
 *  - ta ett fönster runt varje länk och hitta närmaste datum i just det fönstret*
