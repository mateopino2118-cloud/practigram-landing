// Per-variant detail endpoint: returns metadata + daily series filtered by variant.
// Mirrors api/tendencias.js but adds `WHERE variant = $X`.
const { ALL_VARIANTS, VARIANT_MAP, VALID_IDS } = require('./_variants');
const { query } = require('./_db');
const { detectSourceFromQuery, configIdFor } = require('./_source');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, from, to } = req.query || {};
  if (!id || !VALID_IDS.includes(id)) {
    return res.status(400).json({ error: 'invalid or missing variant id' });
  }
  const meta = VARIANT_MAP[id];
  const source = detectSourceFromQuery(req, { allowAll: true });
  const isAll = source === 'all';

  // Resolve config (per source; merge for 'all') for status + experimentStart.
  const DEFAULTS = { activeVariants: [], retiredVariants: [], queue: [], experimentStart: null };
  let config;
  if (isAll) {
    const [r1, r2] = await Promise.all([
      query('SELECT data FROM config WHERE id = 1'),
      query('SELECT data FROM config WHERE id = 2'),
    ]);
    const parse = (r) => (r && r.rows.length) ? (typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data) : {};
    const c1 = { ...DEFAULTS, ...parse(r1) };
    const c2 = { ...DEFAULTS, ...parse(r2) };
    config = {
      activeVariants: Array.from(new Set([...(c1.activeVariants || []), ...(c2.activeVariants || [])])),
      retiredVariants: Array.from(new Set([...(c1.retiredVariants || []), ...(c2.retiredVariants || [])])),
      experimentStart: c1.experimentStart || c2.experimentStart || null,
    };
  } else {
    const cfgResult = await query('SELECT data FROM config WHERE id = $1', [configIdFor(source)]);
    config = { ...DEFAULTS };
    if (cfgResult && cfgResult.rows.length) {
      const d = cfgResult.rows[0].data;
      config = { ...config, ...(typeof d === 'string' ? JSON.parse(d) : d) };
    }
  }
  const expStart = config.experimentStart || null;
  let status = 'queue';
  if ((config.activeVariants || []).includes(id)) status = 'active';
  else if ((config.retiredVariants || []).includes(id)) status = 'retired';

  // Daily series for THIS variant only (1 query, all event types).
  const TZ = 'America/Argentina/Buenos_Aires';
  let dailyQuery, dailyParams;
  if (from && to) {
    dailyQuery = `
      SELECT (created_at AT TIME ZONE '${TZ}')::date as day, type, count(*) as cnt
      FROM events
      WHERE variant = $1
        AND created_at >= ($2::date AT TIME ZONE '${TZ}')
        AND created_at < (($3::date + interval '1 day') AT TIME ZONE '${TZ}')${isAll ? '' : ' AND source = $4'}
      GROUP BY day, type ORDER BY day`;
    dailyParams = isAll ? [id, from, to] : [id, from, to, source];
  } else if (expStart) {
    dailyQuery = `
      SELECT (created_at AT TIME ZONE '${TZ}')::date as day, type, count(*) as cnt
      FROM events
      WHERE variant = $1 AND created_at >= $2::timestamptz${isAll ? '' : ' AND source = $3'}
      GROUP BY day, type ORDER BY day`;
    dailyParams = isAll ? [id, expStart] : [id, expStart, source];
  } else {
    dailyQuery = `
      SELECT (created_at AT TIME ZONE '${TZ}')::date as day, type, count(*) as cnt
      FROM events
      WHERE variant = $1${isAll ? '' : ' AND source = $2'}
      GROUP BY day, type ORDER BY day`;
    dailyParams = isAll ? [id] : [id, source];
  }
  const result = await query(dailyQuery, dailyParams);

  // Group rows by day, all event types in one row.
  const dailyMap = {};
  if (result) {
    for (const row of result.rows) {
      const d = row.day.toISOString().slice(0, 10);
      if (!dailyMap[d]) dailyMap[d] = {
        date: d, impressions: 0, conversions: 0, qualified: 0, whatsapp: 0,
        quizStart: 0, quizComplete: 0, formStart: 0,
        exitShown: 0, exitRecovered: 0, exitDismissed: 0,
      };
      const c = parseInt(row.cnt);
      const t = row.type;
      if (t === 'impression') dailyMap[d].impressions = c;
      else if (t === 'conversion') dailyMap[d].conversions = c;
      else if (t === 'qualified') dailyMap[d].qualified = c;
      else if (t === 'whatsapp') dailyMap[d].whatsapp = c;
      else if (t === 'quiz_start') dailyMap[d].quizStart = c;
      else if (t === 'quiz_complete') dailyMap[d].quizComplete = c;
      else if (t === 'form_start') dailyMap[d].formStart = c;
      else if (t === 'exit_popup_shown') dailyMap[d].exitShown = c;
      else if (t === 'exit_popup_recovered') dailyMap[d].exitRecovered = c;
      else if (t === 'exit_popup_dismissed') dailyMap[d].exitDismissed = c;
    }
  }

  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // Totals + per-day rates + cumulative.
  let totalImp = 0, totalConv = 0, totalQual = 0, totalWa = 0;
  let totalQuizStart = 0, totalQuizComplete = 0, totalFormStart = 0;
  let totalExitShown = 0, totalExitRecovered = 0;
  const enriched = daily.map((d) => {
    totalImp += d.impressions; totalConv += d.conversions; totalQual += d.qualified; totalWa += d.whatsapp;
    totalQuizStart += d.quizStart; totalQuizComplete += d.quizComplete; totalFormStart += d.formStart;
    totalExitShown += d.exitShown; totalExitRecovered += d.exitRecovered;
    const cr = d.impressions > 0 ? (d.conversions / d.impressions * 100) : 0;
    const qr = d.conversions > 0 ? (d.qualified / d.conversions * 100) : 0;
    const cumulativeCR = totalImp > 0 ? (totalConv / totalImp * 100) : 0;
    return { ...d, conversionRate: cr, qualifiedRate: qr, cumulativeConversionRate: cumulativeCR };
  });

  return res.status(200).json({
    id,
    name: meta.name,
    file: meta.file,
    status,
    source,
    daily: enriched,
    totals: {
      impressions: totalImp,
      conversions: totalConv,
      qualified: totalQual,
      whatsapp: totalWa,
      quizStart: totalQuizStart,
      quizComplete: totalQuizComplete,
      formStart: totalFormStart,
      exitShown: totalExitShown,
      exitRecovered: totalExitRecovered,
    },
    rates: {
      conversionRate: totalImp > 0 ? (totalConv / totalImp * 100) : null,
      qualifiedRate: totalConv > 0 ? (totalQual / totalConv * 100) : null,
      whatsappRate: totalConv > 0 ? (totalWa / totalConv * 100) : null,
      quizCompleteRate: totalQuizStart > 0 ? (totalQuizComplete / totalQuizStart * 100) : null,
      exitRecoveryRate: totalExitShown > 0 ? (totalExitRecovered / totalExitShown * 100) : null,
    },
    days: daily.length,
    filtered: !!(from && to),
    experimentStart: expStart,
    experimentFiltered: !(from && to) && !!expStart,
    updatedAt: new Date().toISOString()
  });
};
