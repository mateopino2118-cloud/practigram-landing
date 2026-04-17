const { ALL_VARIANTS, VARIANT_MAP, DEFAULT_ACTIVE, DEFAULT_QUEUE } = require('./_variants');
const { query } = require('./_db');
const { detectSourceFromQuery, configIdFor } = require('./_source');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { from, to } = req.query || {};
  // Source filter: 'meta' | 'youtube' | 'all'. Defaults to 'meta' so any
  // legacy consumer still sees the Meta experiment unchanged.
  const source = detectSourceFromQuery(req, { allowAll: true });
  const isAll = source === 'all';

  // Load config. For 'all' we merge both sources so the panel can show a
  // combined view (active = union, queue = intersection, retired = union).
  const DEFAULTS = { mode: 'warmup', warmupMin: 150, weights: {}, activeVariants: DEFAULT_ACTIVE, retiredVariants: [], queue: DEFAULT_QUEUE, autoRotate: false, rotationThreshold: 5, rotationMinImpressions: 150, rotationLog: [], experimentStart: null };
  let config;
  if (isAll) {
    const [r1, r2] = await Promise.all([
      query('SELECT data FROM config WHERE id = 1'),
      query('SELECT data FROM config WHERE id = 2'),
    ]);
    const parse = (r) => {
      if (!r || !r.rows.length) return {};
      const d = r.rows[0].data;
      return typeof d === 'string' ? JSON.parse(d) : d;
    };
    const c1 = { ...DEFAULTS, ...parse(r1) };
    const c2 = { ...DEFAULTS, ...parse(r2) };
    config = {
      ...c1,
      activeVariants: Array.from(new Set([...(c1.activeVariants || []), ...(c2.activeVariants || [])])),
      retiredVariants: Array.from(new Set([...(c1.retiredVariants || []), ...(c2.retiredVariants || [])])),
      queue: (c1.queue || []).filter(v => (c2.queue || []).includes(v)),
      rotationLog: [...(c1.rotationLog || []), ...(c2.rotationLog || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
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

  const activeIds = config.activeVariants || DEFAULT_ACTIVE;
  const retiredIds = config.retiredVariants || [];
  const allTestedIds = [...activeIds, ...retiredIds];

  // Get variant totals — 1 query for all variants
  // Filter priority: explicit from/to (URL) overrides experimentStart (config).
  // When source !== 'all', add AND source = $N filter.
  const srcClause = isAll ? '' : ' AND source = $SRC';
  let varStatsQuery, varStatsParams;
  if (from && to) {
    varStatsQuery = `
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1) AND created_at >= ($2::date AT TIME ZONE 'America/Argentina/Buenos_Aires') AND created_at < (($3::date + interval '1 day') AT TIME ZONE 'America/Argentina/Buenos_Aires')${srcClause.replace('$SRC', '$4')}
      GROUP BY variant, type`;
    varStatsParams = isAll ? [allTestedIds, from, to] : [allTestedIds, from, to, source];
  } else if (expStart) {
    varStatsQuery = `
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1) AND created_at >= $2::timestamptz${srcClause.replace('$SRC', '$3')}
      GROUP BY variant, type`;
    varStatsParams = isAll ? [allTestedIds, expStart] : [allTestedIds, expStart, source];
  } else {
    varStatsQuery = `
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1)${srcClause.replace('$SRC', '$2')}
      GROUP BY variant, type`;
    varStatsParams = isAll ? [allTestedIds] : [allTestedIds, source];
  }
  const statsResult = await query(varStatsQuery, varStatsParams);

  const varStats = {};
  // Engagement aggregates (global, across all variants in current scope) — used by panel UI.
  let engQuizStart = 0, engQuizComplete = 0, engFormStart = 0;
  let engExitShown = 0, engExitRecovered = 0, engExitDismissed = 0;
  // Timing A/B test (mobile): buckets control + 500/1000/2000/3000 ms.
  // Métrica primaria: % de conversión global por bucket = conv / imp.
  // Métricas secundarias: % qualified, recovery rate del propio popup.
  const timingBuckets = {
    'control': { imp: 0, conv: 0, qual: 0, shown: 0, recovered: 0 },
    '500':     { imp: 0, conv: 0, qual: 0, shown: 0, recovered: 0 },
    '1000':    { imp: 0, conv: 0, qual: 0, shown: 0, recovered: 0 },
    '1550':    { imp: 0, conv: 0, qual: 0, shown: 0, recovered: 0 },
    '2000':    { imp: 0, conv: 0, qual: 0, shown: 0, recovered: 0 }
  };
  // Dwell time: lo consultamos aparte porque usamos aggregates nativos de
  // Postgres (PERCENTILE_CONT + width_bucket) para precisión en ms reales.
  if (statsResult) {
    for (const row of statsResult.rows) {
      if (!varStats[row.variant]) varStats[row.variant] = { imp: 0, conv: 0, qual: 0, wa: 0 };
      const s = varStats[row.variant];
      const c = parseInt(row.cnt);
      const t = row.type;
      if (t === 'impression') s.imp = c;
      else if (t === 'conversion') s.conv = c;
      else if (t === 'qualified') s.qual = c;
      else if (t === 'whatsapp') s.wa = c;
      else if (t === 'quiz_start') engQuizStart += c;
      else if (t === 'quiz_complete') engQuizComplete += c;
      else if (t === 'form_start') engFormStart += c;
      // Base + bucketed variants are dual-emitted by exit-popup.js. Counting
      // only the base type keeps the existing "exit popup recovery" card
      // consistent with its historical definition.
      else if (t === 'exit_popup_shown') engExitShown += c;
      else if (t === 'exit_popup_recovered') engExitRecovered += c;
      else if (t === 'exit_popup_dismissed') engExitDismissed += c;
      else {
        const m = /^(impression|conversion|qualified|exit_popup_(shown|recovered))_b(500|1000|1550|2000|control)$/.exec(t);
        if (m && timingBuckets[m[3]]) {
          const b = timingBuckets[m[3]];
          if      (m[1] === 'impression')          b.imp += c;
          else if (m[1] === 'conversion')          b.conv += c;
          else if (m[1] === 'qualified')           b.qual += c;
          else if (m[1] === 'exit_popup_shown')    b.shown += c;
          else if (m[1] === 'exit_popup_recovered') b.recovered += c;
        }
      }
    }
  }

  // Dwell time (ms reales): percentiles nativos de Postgres + histograma en
  // 20 bins finos para el card del panel. Usa el mismo filtro temporal que
  // varStats para consistencia con el rest del dashboard.
  const dwellWhere = (() => {
    const clauses = ["type IN ('dwell_c','dwell_u')", 'value_int IS NOT NULL'];
    const params = [];
    if (!isAll) { clauses.push(`source = $${params.length + 1}`); params.push(source); }
    if (from && to) {
      clauses.push(`created_at >= ($${params.length + 1}::date AT TIME ZONE 'America/Argentina/Buenos_Aires')`);
      params.push(from);
      clauses.push(`created_at <  (($${params.length + 1}::date + interval '1 day') AT TIME ZONE 'America/Argentina/Buenos_Aires')`);
      params.push(to);
    } else if (expStart) {
      clauses.push(`created_at >= $${params.length + 1}::timestamptz`);
      params.push(expStart);
    }
    return { sql: clauses.join(' AND '), params };
  })();
  const dwellPercentilesResult = await query(
    `SELECT type,
            count(*) AS n,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY value_int) AS p25,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY value_int) AS p50,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY value_int) AS p75,
            percentile_cont(0.90) WITHIN GROUP (ORDER BY value_int) AS p90,
            avg(value_int) AS mean
     FROM events WHERE ${dwellWhere.sql}
     GROUP BY type`,
    dwellWhere.params
  );
  // Histograma: 30 bins de 1 segundo (0-1s, 1-2s, ..., 29-30s) + un bin
  // catchall "30s+". Así podés leer directo "qué % de la gente se va en
  // cada segundo puntual" en vez de tener que mentalmente diferenciar
  // entre percentiles acumulativos.
  const dwellHistResult = await query(
    `SELECT type,
            LEAST(width_bucket(value_int, 0, 30000, 30), 31) AS bin,
            count(*) AS cnt
     FROM events WHERE ${dwellWhere.sql}
     GROUP BY type, bin
     ORDER BY type, bin`,
    dwellWhere.params
  );
  const dwellData = {
    converted:   { total: 0, mean: null, p25: null, p50: null, p75: null, p90: null, histogram: [] },
    unconverted: { total: 0, mean: null, p25: null, p50: null, p75: null, p90: null, histogram: [] }
  };
  if (dwellPercentilesResult) {
    for (const row of dwellPercentilesResult.rows) {
      const g = row.type === 'dwell_c' ? dwellData.converted : dwellData.unconverted;
      g.total = parseInt(row.n);
      g.mean  = row.mean !== null ? Math.round(parseFloat(row.mean)) : null;
      g.p25   = row.p25  !== null ? Math.round(parseFloat(row.p25))  : null;
      g.p50   = row.p50  !== null ? Math.round(parseFloat(row.p50))  : null;
      g.p75   = row.p75  !== null ? Math.round(parseFloat(row.p75))  : null;
      g.p90   = row.p90  !== null ? Math.round(parseFloat(row.p90))  : null;
    }
  }
  if (dwellHistResult) {
    // 31 bins: 1..30 = segundos 0-1s, 1-2s, ..., 29-30s; 31 = "30s+".
    const initBins = () => Array.from({ length: 31 }, (_, i) => {
      const lo = i * 1000, hi = (i + 1) * 1000;
      return {
        bin: i + 1,
        rangeMs: i < 30 ? [lo, hi] : [30000, null],
        label: i < 30 ? `${i}-${i + 1}s` : '30s+',
        count: 0,
        pct: 0
      };
    });
    dwellData.converted.histogram = initBins();
    dwellData.unconverted.histogram = initBins();
    for (const row of dwellHistResult.rows) {
      const g = row.type === 'dwell_c' ? dwellData.converted : dwellData.unconverted;
      const bin = parseInt(row.bin);
      if (bin >= 1 && bin <= 31) g.histogram[bin - 1].count = parseInt(row.cnt);
    }
    // Segundo pase: calcular el % de cada bin sobre el total del grupo.
    for (const k of ['converted', 'unconverted']) {
      const g = dwellData[k];
      if (g.total > 0) {
        for (const bin of g.histogram) bin.pct = bin.count / g.total * 100;
      }
    }
  }

  // Lifetime stats per variant — never filtered by date, but still scoped
  // to the source (unless 'all') so each experiment has its own "lifetime".
  const lifetimeResult = await query(
    isAll
      ? `SELECT variant, type, count(*) as cnt FROM events WHERE variant = ANY($1) GROUP BY variant, type`
      : `SELECT variant, type, count(*) as cnt FROM events WHERE variant = ANY($1) AND source = $2 GROUP BY variant, type`,
    isAll ? [allTestedIds] : [allTestedIds, source]
  );
  const lifetimeStats = {};
  if (lifetimeResult) {
    for (const row of lifetimeResult.rows) {
      if (!lifetimeStats[row.variant]) lifetimeStats[row.variant] = { imp: 0, conv: 0, qual: 0, wa: 0 };
      const s = lifetimeStats[row.variant];
      const c = parseInt(row.cnt);
      if (row.type === 'impression') s.imp = c;
      else if (row.type === 'conversion') s.conv = c;
      else if (row.type === 'qualified') s.qual = c;
      else if (row.type === 'whatsapp') s.wa = c;
    }
  }

  // Round-window stats per variant — events since roundStartedAt. This is what
  // the rotator uses to decide who gets traffic and who gets retired.
  const roundStart = config.roundStartedAt || null;
  const roundStats = {};
  if (roundStart) {
    const roundResult = await query(
      isAll
        ? `SELECT variant, type, count(*) as cnt FROM events WHERE variant = ANY($1) AND created_at >= $2::timestamptz AND type IN ('impression', 'conversion') GROUP BY variant, type`
        : `SELECT variant, type, count(*) as cnt FROM events WHERE variant = ANY($1) AND created_at >= $2::timestamptz AND type IN ('impression', 'conversion') AND source = $3 GROUP BY variant, type`,
      isAll ? [activeIds, roundStart] : [activeIds, roundStart, source]
    );
    if (roundResult) {
      for (const row of roundResult.rows) {
        if (!roundStats[row.variant]) roundStats[row.variant] = { imp: 0, conv: 0 };
        const s = roundStats[row.variant];
        const c = parseInt(row.cnt);
        if (row.type === 'impression') s.imp = c;
        else if (row.type === 'conversion') s.conv = c;
      }
    }
  }

  // Get daily breakdown — 1 query (Argentina timezone)
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
  const dailyResult = await query(dailyQuery, dailyParams);

  const dailyMap = {};
  if (dailyResult) {
    for (const row of dailyResult.rows) {
      const d = row.day.toISOString().slice(0, 10);
      if (!dailyMap[d]) dailyMap[d] = { date: d, impressions: 0, conversions: 0, qualified: 0, whatsapp: 0 };
      const c = parseInt(row.cnt);
      if (row.type === 'impression') dailyMap[d].impressions = c;
      else if (row.type === 'conversion') dailyMap[d].conversions = c;
      else if (row.type === 'qualified') dailyMap[d].qualified = c;
      else if (row.type === 'whatsapp') dailyMap[d].whatsapp = c;
    }
  }

  // Build variants arrays. Global totals come from dailyMap (all events in the
  // period) so panel/resumen/tendencias agree — previously we summed only
  // active+retired which diverged from the daily chart's own sum.
  let globalImp = 0, globalConv = 0, globalQual = 0, globalWa = 0;
  for (const d of Object.values(dailyMap)) {
    globalImp  += d.impressions;
    globalConv += d.conversions;
    globalQual += d.qualified;
    globalWa   += d.whatsapp;
  }
  const variants = activeIds.map(vid => {
    const vInfo = VARIANT_MAP[vid];
    const s = varStats[vid] || { imp: 0, conv: 0, qual: 0, wa: 0 };
    const lt = lifetimeStats[vid] || { imp: 0, conv: 0, qual: 0, wa: 0 };
    const rd = roundStats[vid] || { imp: 0, conv: 0 };
    return {
      id: vid, name: vInfo ? vInfo.name : vid, file: vInfo ? vInfo.file : vid,
      impressions: s.imp, conversions: s.conv, qualified: s.qual, whatsapp: s.wa,
      conversionRate: s.imp > 0 ? (s.conv / s.imp * 100) : 0,
      qualifiedRate: s.conv > 0 ? (s.qual / s.conv * 100) : 0,
      whatsappRate: s.conv > 0 ? (s.wa / s.conv * 100) : 0,
      lifetime: {
        impressions: lt.imp, conversions: lt.conv, qualified: lt.qual, whatsapp: lt.wa,
        conversionRate: lt.imp > 0 ? (lt.conv / lt.imp * 100) : 0
      },
      round: {
        impressions: rd.imp, conversions: rd.conv,
        conversionRate: rd.imp > 0 ? (rd.conv / rd.imp * 100) : 0
      }
    };
  });

  const retiredStats = retiredIds.map(vid => {
    const vInfo = VARIANT_MAP[vid];
    const s = varStats[vid] || { imp: 0, conv: 0, qual: 0, wa: 0 };
    const lt = lifetimeStats[vid] || { imp: 0, conv: 0, qual: 0, wa: 0 };
    return {
      id: vid, name: vInfo ? vInfo.name : vid, file: vInfo ? vInfo.file : vid,
      impressions: s.imp, conversions: s.conv, qualified: s.qual, whatsapp: s.wa,
      conversionRate: s.imp > 0 ? (s.conv / s.imp * 100) : 0,
      qualifiedRate: s.conv > 0 ? (s.qual / s.conv * 100) : 0,
      lifetime: {
        impressions: lt.imp, conversions: lt.conv,
        conversionRate: lt.imp > 0 ? (lt.conv / lt.imp * 100) : 0
      }
    };
  });

  // Thompson Sampling (Monte Carlo) — computed on ROUND-WINDOW stats so the
  // tournament ranking reflects the current round, not lifetime. This is what
  // determines who is champion vs challenger and who gets retired.
  const MIN_FOR_THOMPSON = 20;
  const eligible = variants.filter(v => v.round.impressions >= MIN_FOR_THOMPSON);
  const N = 10000;
  const wins = new Array(eligible.length).fill(0);
  if (eligible.length > 0) {
    for (let sim = 0; sim < N; sim++) {
      let bestVal = -1, bestIdx = 0;
      for (let i = 0; i < eligible.length; i++) {
        const a = eligible[i].round.conversions + 1;
        const b = eligible[i].round.impressions - eligible[i].round.conversions + 1;
        const sample = betaSample(a, b);
        if (sample > bestVal) { bestVal = sample; bestIdx = i; }
      }
      wins[bestIdx]++;
    }
  }
  const eligibleMap = {};
  for (let i = 0; i < eligible.length; i++) {
    eligibleMap[eligible[i].id] = (wins[i] / N * 100);
  }
  const rotationCandidates = [];
  for (let i = 0; i < variants.length; i++) {
    variants[i].thompsonProb = eligibleMap[variants[i].id] ?? null;
    if (variants[i].round.impressions >= (config.rotationMinImpressions || 500) && variants[i].thompsonProb !== null && variants[i].thompsonProb < (config.rotationThreshold || 5)) {
      rotationCandidates.push(variants[i].id);
    }
  }

  const warmupMin = config.warmupMin || 150;
  const warmupRemaining = variants.reduce((sum, v) => sum + Math.max(0, warmupMin - v.impressions), 0);
  const warmupComplete = variants.every(v => v.impressions >= warmupMin);

  const queueList = (config.queue || []).map(vid => {
    const vInfo = VARIANT_MAP[vid];
    return { id: vid, name: vInfo ? vInfo.name : vid, file: vInfo ? vInfo.file : vid };
  });

  return res.status(200).json({
    source,
    variants,
    totals: { impressions: globalImp, conversions: globalConv, qualified: globalQual, whatsapp: globalWa },
    daily: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)),
    dbConnected: !!(statsResult),
    filtered: !!(from && to),
    experimentStart: expStart,
    experimentFiltered: !(from && to) && !!expStart,
    config,
    warmup: { complete: warmupComplete, minImpressions: warmupMin, remaining: warmupRemaining },
    rotation: {
      activeVariants: activeIds,
      retiredVariants: retiredStats,
      queue: queueList,
      autoRotate: config.autoRotate || false,
      rotationThreshold: config.rotationThreshold || 5,
      rotationMinImpressions: config.rotationMinImpressions || 150,
      protectTopN: config.protectTopN || 2,
      roundStartedAt: config.roundStartedAt || null,
      candidates: rotationCandidates,
      log: (config.rotationLog || []).slice(0, 20)
    },
    allVariants: ALL_VARIANTS.map(v => ({ id: v.id, name: v.name, file: v.file })),
    engagement: {
      quizStart: engQuizStart,
      quizComplete: engQuizComplete,
      formStart: engFormStart,
      exitShown: engExitShown,
      exitRecovered: engExitRecovered,
      exitDismissed: engExitDismissed,
      quizCompleteRate: engQuizStart > 0 ? (engQuizComplete / engQuizStart * 100) : null,
      exitRecoveryRate: engExitShown > 0 ? (engExitRecovered / engExitShown * 100) : null,
      timingTest: Object.entries(timingBuckets).map(([bucket, v]) => ({
        bucket,
        impressions: v.imp,
        conversions: v.conv,
        qualified: v.qual,
        conversionRate: v.imp > 0 ? (v.conv / v.imp * 100) : null,
        qualifiedRate: v.imp > 0 ? (v.qual / v.imp * 100) : null,
        popupShown: v.shown,
        popupRecovered: v.recovered,
        popupRecoveryRate: v.shown > 0 ? (v.recovered / v.shown * 100) : null
      })),
      dwellTime: dwellData
    },
    updatedAt: new Date().toISOString()
  });
};

function betaSample(a, b) {
  if (a <= 0) a = 0.001; if (b <= 0) b = 0.001;
  const ga = gammaSample(a), gb = gammaSample(b);
  return ga / (ga + gb);
}
function gammaSample(shape) {
  if (shape < 1) return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1/3, c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do { x = randn(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
