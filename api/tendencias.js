const { ALL_VARIANTS } = require('./_variants');
const { query } = require('./_db');
const { detectSourceFromQuery, configIdFor } = require('./_source');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { from, to } = req.query || {};
  const source = detectSourceFromQuery(req, { allowAll: true });
  const isAll = source === 'all';

  // Get config for experimentStart (per source)
  let config = { experimentStart: null };
  if (isAll) {
    const [r1, r2] = await Promise.all([
      query('SELECT data FROM config WHERE id = 1'),
      query('SELECT data FROM config WHERE id = 2'),
    ]);
    const parse = (r) => (r && r.rows.length) ? (typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data) : {};
    const c1 = parse(r1), c2 = parse(r2);
    config.experimentStart = c1.experimentStart || c2.experimentStart || null;
  } else {
    const cfgResult = await query('SELECT data FROM config WHERE id = $1', [configIdFor(source)]);
    if (cfgResult && cfgResult.rows.length) {
      const d = cfgResult.rows[0].data;
      config = { ...config, ...(typeof d === 'string' ? JSON.parse(d) : d) };
    }
  }
  const expStart = config.experimentStart || null;

  // Daily totals across ALL variants (1 query)
  // Use Argentina timezone (UTC-3) for grouping by day
  // Filter priority: explicit from/to overrides experimentStart.
  const TZ = 'America/Argentina/Buenos_Aires';
  let dailyQuery, dailyParams;
  if (from && to) {
    dailyQuery = `
      SELECT (created_at AT TIME ZONE '${TZ}')::date as day, type, count(*) as cnt
      FROM events
      WHERE created_at >= ($1::date AT TIME ZONE '${TZ}') AND created_at < (($2::date + interval '1 day') AT TIME ZONE '${TZ}')${isAll ? '' : ' AND source = $3'}
      GROUP BY day, type ORDER BY day`;
    dailyParams = isAll ? [from, to] : [from, to, source];
  } else if (expStart) {
    dailyQuery = `
      SELECT (created_at AT TIME ZONE '${TZ}')::date as day, type, count(*) as cnt
      FROM events
      WHERE created_at >= $1::timestamptz${isAll ? '' : ' AND source = $2'}
      GROUP BY day, type ORDER BY day`;
    dailyParams = isAll ? [expStart] : [expStart, source];
  } else {
    dailyQuery = `
      SELECT (created_at AT TIME ZONE '${TZ}')::date as day, type, count(*) as cnt
      FROM events${isAll ? '' : ' WHERE source = $1'}
      GROUP BY day, type ORDER BY day`;
    dailyParams = isAll ? [] : [source];
  }
  const result = await query(dailyQuery, dailyParams);

  const dailyMap = {};
  if (result) {
    for (const row of result.rows) {
      const d = row.day.toISOString().slice(0, 10);
      if (!dailyMap[d]) dailyMap[d] = { date: d, impressions: 0, conversions: 0, qualified: 0, whatsapp: 0 };
      const c = parseInt(row.cnt);
      if (row.type === 'impression') dailyMap[d].impressions = c;
      else if (row.type === 'conversion') dailyMap[d].conversions = c;
      else if (row.type === 'qualified') dailyMap[d].qualified = c;
      else if (row.type === 'whatsapp') dailyMap[d].whatsapp = c;
    }
  }

  const daily = Object.values(dailyMap).filter(d => d.impressions > 0).sort((a, b) => a.date.localeCompare(b.date));

  // Calculate running averages and trend
  let totalImp = 0, totalConv = 0, totalQual = 0, totalWa = 0;
  const enriched = daily.map((d, i) => {
    totalImp += d.impressions; totalConv += d.conversions; totalQual += d.qualified; totalWa += d.whatsapp;
    const cr = d.impressions > 0 ? (d.conversions / d.impressions * 100) : 0;
    const qr = d.conversions > 0 ? (d.qualified / d.conversions * 100) : 0;
    const cumulativeCR = totalImp > 0 ? (totalConv / totalImp * 100) : 0;
    return { ...d, conversionRate: cr, qualifiedRate: qr, cumulativeConversionRate: cumulativeCR };
  });

  // Trend: compare first half avg vs second half avg conversion
  let trend = 'stable';
  if (enriched.length >= 4) {
    const mid = Math.floor(enriched.length / 2);
    const firstHalf = enriched.slice(0, mid);
    const secondHalf = enriched.slice(mid);
    const avgFirst = firstHalf.reduce((s, d) => s + d.conversionRate, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, d) => s + d.conversionRate, 0) / secondHalf.length;
    if (avgSecond > avgFirst * 1.05) trend = 'up';
    else if (avgSecond < avgFirst * 0.95) trend = 'down';
  }

  return res.status(200).json({
    source,
    daily: enriched,
    totals: { impressions: totalImp, conversions: totalConv, qualified: totalQual, whatsapp: totalWa },
    averages: {
      impressions: daily.length > 0 ? Math.round(totalImp / daily.length) : 0,
      conversions: daily.length > 0 ? Math.round(totalConv / daily.length) : 0,
      conversionRate: totalImp > 0 ? (totalConv / totalImp * 100) : 0
    },
    trend,
    days: daily.length,
    filtered: !!(from && to),
    experimentStart: expStart,
    experimentFiltered: !(from && to) && !!expStart,
    updatedAt: new Date().toISOString()
  });
};
