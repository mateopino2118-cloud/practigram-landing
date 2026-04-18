const { query } = require('./_db');

// One-shot reset endpoint — delete after use.
// Call: POST /api/reset  with header  x-reset-key: practigram-reset-2026
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = req.headers['x-reset-key'] || '';
  if (key !== 'practigram-reset-2026') return res.status(403).json({ error: 'forbidden' });

  const result = await query('TRUNCATE TABLE events RESTART IDENTITY');
  if (!result) return res.status(500).json({ ok: false, reason: 'db_error' });

  return res.status(200).json({ ok: true, message: 'events table truncated' });
};
