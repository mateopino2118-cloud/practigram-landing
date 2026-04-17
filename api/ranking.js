const { ALL_VARIANTS, VARIANT_MAP } = require('./_variants');
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
  const allIds = ALL_VARIANTS.map(v => v.id);

  // Get config (per source; merge for 'all')
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

  // Stats for ALL variants (1 query)
  // Filter priority: explicit from/to overrides experimentStart.
  let statsQuery, statsParams;
  if (from && to) {
    statsQuery = `
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1) AND created_at >= ($2::date AT TIME ZONE 'America/Argentina/Buenos_Aires') AND created_at < (($3::date + interval '1 day') AT TIME ZONE 'America/Argentina/Buenos_Aires')${isAll ? '' : ' AND source = $4'}
      GROUP BY variant, type`;
    statsParams = isAll ? [allIds, from, to] : [allIds, from, to, source];
  } else if (expStart) {
    statsQuery = `
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1) AND created_at >= $2::timestamptz${isAll ? '' : ' AND source = $3'}
      GROUP BY variant, type`;
    statsParams = isAll ? [allIds, expStart] : [allIds, expStart, source];
  } else {
    statsQuery = `
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1)${isAll ? '' : ' AND source = $2'}
      GROUP BY variant, type`;
    statsParams = isAll ? [allIds] : [allIds, source];
  }
  const statsResult = await query(statsQuery, statsParams);

  const varStats = {};
  if (statsResult) {
    for (const row of statsResult.rows) {
      if (!varStats[row.variant]) varStats[row.variant] = { imp: 0, conv: 0, qual: 0, wa: 0 };
      const c = parseInt(row.cnt);
      if (row.type === 'impression') varStats[row.variant].imp = c;
      else if (row.type === 'conversion') varStats[row.variant].conv = c;
      else if (row.type === 'qualified') varStats[row.variant].qual = c;
      else if (row.type === 'whatsapp') varStats[row.variant].wa = c;
    }
  }

  // Build full ranking
  const activeSet = new Set(config.activeVariants || []);
  const retiredSet = new Set(config.retiredVariants || []);

  const ranking = ALL_VARIANTS.map(v => {
    const s = varStats[v.id] || { imp: 0, conv: 0, qual: 0, wa: 0 };
    let status = 'queue';
    if (activeSet.has(v.id)) status = 'active';
    else if (retiredSet.has(v.id)) status = 'retired';
    return {
      id: v.id, name: v.name, file: v.file, status,
      impressions: s.imp, conversions: s.conv, qualified: s.qual, whatsapp: s.wa,
      conversionRate: s.imp > 0 ? (s.conv / s.imp * 100) : null,
      qualifiedRate: s.conv > 0 ? (s.qual / s.conv * 100) : null,
      whatsappRate: s.conv > 0 ? (s.wa / s.conv * 100) : null
    };
  });

  // Totals
  let totalImp = 0, totalConv = 0, totalQual = 0, totalWa = 0;
  for (const r of ranking) {
    totalImp += r.impressions; totalConv += r.conversions; totalQual += r.qualified; totalWa += r.whatsapp;
  }

  return res.status(200).json({
    source,
    ranking,
    totals: { impressions: totalImp, conversions: totalConv, qualified: totalQual, whatsapp: totalWa },
    filtered: !!(from && to),
    experimentStart: expStart,
    experimentFiltered: !(from && to) && !!expStart,
    updatedAt: new Date().toISOString()
  });
};
