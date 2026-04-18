const { query } = require('./_db');

// One-shot reset endpoint — delete after use.
// Full truncate:      POST /api/reset                    header x-reset-key: practigram-reset-2026
// Delete before date: POST /api/reset?before=2026-04-18  (Argentina TZ — deletes everything before midnight of that date)
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = req.headers['x-reset-key'] || '';
  if (key !== 'practigram-reset-2026') return res.status(403).json({ error: 'forbidden' });

  const before = (req.query && req.query.before) || null;
  let result, message;
  if (before) {
    // DELETE events strictly before midnight of `before` date in Argentina time
    result = await query(
      `DELETE FROM events WHERE created_at < ($1::date AT TIME ZONE 'America/Argentina/Buenos_Aires')`,
      [before]
    );
    message = `deleted events before ${before} (Argentina TZ)`;
  } else {
    result = await query('TRUNCATE TABLE events RESTART IDENTITY');
    message = 'events table truncated';
  }
  if (!result) return res.status(500).json({ ok: false, reason: 'db_error' });

  return res.status(200).json({ ok: true, message });
};
