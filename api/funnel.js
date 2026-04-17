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

  // Get config for status (per source; for 'all' merge both)
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
  const activeSet = new Set(config.activeVariants || []);
  const retiredSet = new Set(config.retiredVariants || []);
  const expStart = config.experimentStart || null;

  // Per-variant funnel stats (1 query) — explicit from/to overrides experimentStart.
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
      FROM events WHERE variant = ANY($1) AND created_at >= $2::timestamptz${isAll ? '' : ' AND source = $3'}
      GROUP BY variant, type`;
    statsParams = isAll ? [allIds, expStart] : [allIds, expStart, source];
  } else {
    statsQuery = `
      SELECT variant, type, count(*) as cnt
      FROM events WHERE variant = ANY($1)${isAll ? '' : ' AND source = $2'}
      GROUP BY variant, type`;
    statsParams = isAll ? [allIds] : [allIds, source];
  }
  const result = await query(statsQuery, statsParams);

  const empty = () => ({ imp: 0, conv: 0, qual: 0, wa: 0, qs: 0, qc: 0, fs: 0, exShown: 0, exRec: 0, exDis: 0 });
  const varStats = {};
  if (result) {
    for (const row of result.rows) {
      if (!varStats[row.variant]) varStats[row.variant] = empty();
      const c = parseInt(row.cnt);
      const t = row.type;
      if (t === 'impression') varStats[row.variant].imp = c;
      else if (t === 'conversion') varStats[row.variant].conv = c;
      else if (t === 'qualified') varStats[row.variant].qual = c;
      else if (t === 'whatsapp') varStats[row.variant].wa = c;
      else if (t === 'quiz_start') varStats[row.variant].qs = c;
      else if (t === 'quiz_complete') varStats[row.variant].qc = c;
      else if (t === 'form_start') varStats[row.variant].fs = c;
      else if (t === 'exit_popup_shown') varStats[row.variant].exShown = c;
      else if (t === 'exit_popup_recovered') varStats[row.variant].exRec = c;
      else if (t === 'exit_popup_dismissed') varStats[row.variant].exDis = c;
    }
  }

  // Build funnel per variant
  let totalImp = 0, totalConv = 0, totalQual = 0, totalWa = 0;
  let totalQs = 0, totalQc = 0, totalFs = 0, totalExShown = 0, totalExRec = 0;
  const funnels = ALL_VARIANTS.map(v => {
    const s = varStats[v.id] || empty();
    totalImp += s.imp; totalConv += s.conv; totalQual += s.qual; totalWa += s.wa;
    totalQs += s.qs; totalQc += s.qc; totalFs += s.fs;
    totalExShown += s.exShown; totalExRec += s.exRec;
    let status = 'queue';
    if (activeSet.has(v.id)) status = 'active';
    else if (retiredSet.has(v.id)) status = 'retired';
    return {
      id: v.id, name: v.name, file: v.file, status,
      impressions: s.imp,
      conversions: s.conv,
      qualified: s.qual,
      whatsapp: s.wa,
      quizStart: s.qs,
      quizComplete: s.qc,
      formStart: s.fs,
      exitShown: s.exShown,
      exitRecovered: s.exRec,
      // Funnel rates
      visitToReg: s.imp > 0 ? (s.conv / s.imp * 100) : null,
      regToQual: s.conv > 0 ? (s.qual / s.conv * 100) : null,
      regToWA: s.conv > 0 ? (s.wa / s.conv * 100) : null,
      visitToWA: s.imp > 0 ? (s.wa / s.imp * 100) : null,
      // Quiz / form / exit rates (null when no events of that type — variant doesn't use that feature)
      quizCompleteRate: s.qs > 0 ? (s.qc / s.qs * 100) : null,
      formStartRate: s.imp > 0 && s.fs > 0 ? (s.fs / s.imp * 100) : null,
      exitRecoveryRate: s.exShown > 0 ? (s.exRec / s.exShown * 100) : null
    };
  }).filter(f => f.impressions > 0);

  // Global funnel
  const globalFunnel = {
    impressions: totalImp,
    conversions: totalConv,
    qualified: totalQual,
    whatsapp: totalWa,
    quizStart: totalQs,
    quizComplete: totalQc,
    formStart: totalFs,
    exitShown: totalExShown,
    exitRecovered: totalExRec,
    visitToReg: totalImp > 0 ? (totalConv / totalImp * 100) : 0,
    regToQual: totalConv > 0 ? (totalQual / totalConv * 100) : 0,
    regToWA: totalConv > 0 ? (totalWa / totalConv * 100) : 0,
    visitToWA: totalImp > 0 ? (totalWa / totalImp * 100) : 0,
    // Quiz / form / exit popup global rates
    quizCompleteRate: totalQs > 0 ? (totalQc / totalQs * 100) : null,
    exitRecoveryRate: totalExShown > 0 ? (totalExRec / totalExShown * 100) : null,
    // Drop rates
    dropVisitToReg: totalImp > 0 ? ((totalImp - totalConv) / totalImp * 100) : 0,
    dropRegToQual: totalConv > 0 ? ((totalConv - totalQual) / totalConv * 100) : 0,
    dropRegToWA: totalConv > 0 ? ((totalConv - totalWa) / totalConv * 100) : 0
  };

  return res.status(200).json({
    source,
    globalFunnel,
    funnels: funnels.sort((a, b) => (b.visitToReg || 0) - (a.visitToReg || 0)),
    filtered: !!(from && to),
    experimentStart: expStart,
    experimentFiltered: !(from && to) && !!expStart,
    updatedAt: new Date().toISOString()
  });
};
