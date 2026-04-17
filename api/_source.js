// Source detection + per-source config I/O helper.
// "source" tags every event and config row so Meta and YouTube run as
// independent A/B experiments. Meta = id=1 (legacy), YouTube = id=2.

const { query } = require('./_db');

const VALID_SOURCES = ['meta', 'youtube'];
const CONFIG_ID = { meta: 1, youtube: 2 };

function parseCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// Detect source for a redirect request (entry point).
// Precedence: explicit ?__src query → ab_source cookie → default 'meta'.
function detectSourceFromRedirect(req) {
  let qsParam = null;
  try {
    const url = new URL(req.url, 'http://x');
    qsParam = url.searchParams.get('__src');
  } catch {}
  const cookieSrc = parseCookie(req.headers && req.headers.cookie, 'ab_source');
  const raw = qsParam || cookieSrc || 'meta';
  return VALID_SOURCES.includes(raw) ? raw : 'meta';
}

// Detect source for a tracking/analytics request.
// Precedence: ?source=X query → ab_source cookie → default 'meta'.
// Special value 'all' means "no filter" (only valid on analytics endpoints).
function detectSourceFromQuery(req, { allowAll = false } = {}) {
  const q = (req.query && req.query.source) || null;
  if (q === 'all' && allowAll) return 'all';
  if (VALID_SOURCES.includes(q)) return q;
  const cookieSrc = parseCookie(req.headers && req.headers.cookie, 'ab_source');
  if (VALID_SOURCES.includes(cookieSrc)) return cookieSrc;
  return 'meta';
}

function configIdFor(source) {
  return CONFIG_ID[source] || 1;
}

// Load the config row for a given source. Falls back to a shared set of
// DEFAULTS merged with whatever is in the row. Returns null if DB unreachable.
async function loadConfig(source, DEFAULTS) {
  const id = configIdFor(source);
  const r = await query('SELECT data FROM config WHERE id = $1', [id]);
  if (!r) return null;
  if (!r.rows.length) return { ...DEFAULTS };
  const d = r.rows[0].data;
  return { ...DEFAULTS, ...(typeof d === 'string' ? JSON.parse(d) : d) };
}

// Upsert a config row for a given source. Creates id=2 on first YouTube write.
async function saveConfig(source, config) {
  const id = configIdFor(source);
  return query(
    `INSERT INTO config (id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [id, JSON.stringify(config)]
  );
}

module.exports = {
  VALID_SOURCES,
  detectSourceFromRedirect,
  detectSourceFromQuery,
  configIdFor,
  loadConfig,
  saveConfig,
  parseCookie,
};
