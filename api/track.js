const https = require('https');
const { VALID_IDS } = require('./_variants');
const { query } = require('./_db');
const { VALID_SOURCES, parseCookie } = require('./_source');

// ── Meta Conversions API ──────────────────────────────────────────────────────
const PIXEL_ID   = '880791860253272';
const CAPI_TOKEN = process.env.META_CAPI_TOKEN || '';

// Map internal event types → Meta standard events
const CAPI_EVENT_MAP = {
  impression: 'PageView',
  conversion: 'CompleteRegistration',
};

function capiSend(eventName, req, eventId) {
  if (!CAPI_TOKEN) return;                    // token not set → skip silently
  const ip  = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || '';
  const ua  = (req.headers['user-agent'] || '').slice(0, 512);
  const fbp = parseCookie(req.headers && req.headers.cookie, '_fbp') || undefined;
  const fbc = parseCookie(req.headers && req.headers.cookie, '_fbc') || undefined;
  if (!eventId) eventId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const userData = {};
  if (ip)  userData.client_ip_address = ip;
  if (ua)  userData.client_user_agent = ua;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const payload = JSON.stringify({
    data: [{
      event_name:       eventName,
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         eventId,
      action_source:    'website',
      user_data:        userData,
    }],
  });

  const path = `/v19.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`;
  const reqOpts = {
    hostname: 'graph.facebook.com',
    method:   'POST',
    path,
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };
  // fire-and-forget — never blocks the response to the browser
  try {
    const r = https.request(reqOpts);
    r.on('error', () => {});
    r.write(payload);
    r.end();
  } catch (_) { /* noop */ }
}

// Parse a User-Agent string into a coarse device class. Cheap regex —
// no library, never throws. Returns 'mobile' | 'tablet' | 'desktop'.
function parseDevice(ua) {
  if (!ua || typeof ua !== 'string') return null;
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Hour 0..23 in Argentina time. Used to power the panel "by hour" heatmap
// without having to convert TZ at query time.
function hourArgentina() {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: 'numeric',
      hour12: false,
    });
    const h = parseInt(fmt.format(new Date()), 10);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? h : null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { type, variant, value, eventId } = req.body || {};
  if (!variant || !VALID_IDS.includes(variant)) return res.status(400).json({ error: 'invalid variant' });
  // Base types + bucketed variants for the mobile timing A/B test. Buckets:
  // control (50%), 500/1000/2000/3000 ms (12.5% c/u). Bucketing lets stats.js
  // split conversiones por timing del exit popup sin tocar el schema (sólo
  // suffix). Allowed bucketed types: impression, conversion, qualified +
  // exit_popup_(shown|recovered|dismissed).
  const BASE_TYPES = ['impression', 'conversion', 'qualified', 'whatsapp', 'quiz_start', 'quiz_complete', 'form_start', 'exit_popup_shown', 'exit_popup_recovered', 'exit_popup_dismissed'];
  const BUCKET_RE = /^(impression|conversion|qualified|exit_popup_(shown|recovered|dismissed))_b(500|1000|1550|2000|control)$/;
  // Dwell: ms exactos en la landing. El valor va en `value_int`. Sufijo:
  // _c = convirtió (envió el form), _u = se fue sin convertir.
  const DWELL_RE = /^dwell_(c|u)$/;
  if (!BASE_TYPES.includes(type) && !BUCKET_RE.test(type) && !DWELL_RE.test(type)) return res.status(400).json({ error: 'invalid type' });
  // Clamp value a un int razonable (0..2h) para no aceptar basura.
  let valueInt = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    valueInt = Math.max(0, Math.min(Math.round(value), 7200000));
  }

  // Source is detected server-side from the ab_source cookie set by
  // /api/redirect. Zero variant HTML changes required.
  const cookieSrc = parseCookie(req.headers && req.headers.cookie, 'ab_source');
  const source = VALID_SOURCES.includes(cookieSrc) ? cookieSrc : 'meta';

  // Dimensions added in migration 002. Captured server-side from request
  // headers — variant pages don't need to send anything new. All three are
  // nullable: parsing failures fall back to NULL and the row still inserts.
  const device = parseDevice(req.headers && req.headers['user-agent']);
  const country = (req.headers && (req.headers['x-vercel-ip-country'] || req.headers['X-Vercel-IP-Country'])) || null;
  const hourLocal = hourArgentina();

  const result = await query(
    'INSERT INTO events (variant, type, source, device, country, hour_local, value_int) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [variant, type, source, device, country, hourLocal, valueInt]
  );
  if (!result) return res.status(200).json({ ok: false, reason: 'db_error' });

  // Fire CAPI for PageView (impression) and Lead (conversion) — fire-and-forget
  const capiEvent = CAPI_EVENT_MAP[type];
  if (capiEvent) capiSend(capiEvent, req, eventId || undefined);

  return res.status(200).json({ ok: true });
};
