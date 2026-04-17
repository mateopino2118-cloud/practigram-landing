const { VARIANT_MAP, DEFAULT_ACTIVE, DEFAULT_QUEUE } = require('./_variants');
const { query } = require('./_db');
const { detectSourceFromRedirect, configIdFor } = require('./_source');

// Thompson Sampling math
function betaSample(a, b) {
  const ga = gammaSample(Math.max(a, 0.001));
  const gb = gammaSample(Math.max(b, 0.001));
  return ga / (ga + gb);
}
function gammaSample(s) {
  if (s < 1) return gammaSample(s + 1) * Math.pow(Math.random(), 1 / s);
  const d = s - 1/3, c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do { x = randn(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function thompsonProbabilities(stats, iterations) {
  const wins = new Array(stats.length).fill(0);
  for (let sim = 0; sim < iterations; sim++) {
    let bestVal = -1, bestIdx = 0;
    for (let i = 0; i < stats.length; i++) {
      const sample = betaSample(stats[i].conv + 1, stats[i].imp - stats[i].conv + 1);
      if (sample > bestVal) { bestVal = sample; bestIdx = i; }
    }
    wins[bestIdx]++;
  }
  return wins.map(w => w / iterations * 100);
}

module.exports = async (req, res) => {
  // Detect traffic source (meta or youtube). Drives which config row and
  // which events slice the Thompson Sampling consumes so each source runs
  // an isolated experiment.
  const source = detectSourceFromRedirect(req);
  const configId = configIdFor(source);

  // Get config (1 query)
  const cfgResult = await query('SELECT data FROM config WHERE id = $1', [configId]);
  let config = { mode: 'warmup', warmupMin: 150, weights: {}, activeVariants: DEFAULT_ACTIVE, retiredVariants: [], queue: DEFAULT_QUEUE, autoRotate: false, rotationThreshold: 5, rotationMinImpressions: 150, rotationLog: [] };
  if (cfgResult && cfgResult.rows.length) {
    const d = cfgResult.rows[0].data;
    config = { ...config, ...(typeof d === 'string' ? JSON.parse(d) : d) };
  }

  const activeIds = config.activeVariants || DEFAULT_ACTIVE;
  const activeVariants = activeIds.map(id => VARIANT_MAP[id]).filter(Boolean);

  if (activeVariants.length === 0) {
    res.writeHead(302, { Location: '/v1-carta-ventas', 'Cache-Control': 'no-store' });
    return res.end();
  }

  // Get stats for active variants (1 query) — round-window first, falling back
  // to experimentStart checkpoint, falling back to lifetime. The round window
  // is what drives equitable distribution and rotation decisions. Historic
  // lifetime events stay in the DB and are surfaced separately by stats.js.
  const roundStart = config.roundStartedAt || config.experimentStart || null;
  let statsResult;
  if (roundStart) {
    statsResult = await query(`
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1) AND type IN ('impression', 'conversion') AND created_at >= $2::timestamptz AND source = $3
      GROUP BY variant, type
    `, [activeIds, roundStart, source]);
  } else {
    statsResult = await query(`
      SELECT variant, type, count(*) as cnt
      FROM events
      WHERE variant = ANY($1) AND type IN ('impression', 'conversion') AND source = $2
      GROUP BY variant, type
    `, [activeIds, source]);
  }

  const statsMap = {};
  if (statsResult) {
    for (const row of statsResult.rows) {
      if (!statsMap[row.variant]) statsMap[row.variant] = { imp: 0, conv: 0 };
      if (row.type === 'impression') statsMap[row.variant].imp = parseInt(row.cnt);
      else if (row.type === 'conversion') statsMap[row.variant].conv = parseInt(row.cnt);
    }
  }

  const stats = activeVariants.map(v => statsMap[v.id] || { imp: 0, conv: 0 });
  let bestIdx = Math.floor(Math.random() * activeVariants.length);

  if (statsResult) {
    if (config.mode === 'manual') {
      const weights = activeVariants.map(v => Math.max(0, parseFloat(config.weights[v.id]) || 0));
      const total = weights.reduce((s, w) => s + w, 0);
      if (total > 0) {
        let r = Math.random() * total;
        for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { bestIdx = i; break; } }
      }
    } else if (config.mode === 'thompson') {
      let bestVal = -1;
      for (let i = 0; i < activeVariants.length; i++) {
        const sample = betaSample(stats[i].conv + 1, stats[i].imp - stats[i].conv + 1);
        if (sample > bestVal) { bestVal = sample; bestIdx = i; }
      }
    } else {
      // Equitable mode (default, replaces warmup-mix): pure round-robin over
      // the current round window. Each visit goes to the active variant with
      // the fewest round impressions. This eliminates the Thompson-amplifies-
      // winner bias and ensures every variant gets equal sample within a round.
      let minImp = Infinity;
      const candidates = [];
      for (let i = 0; i < stats.length; i++) {
        if (stats[i].imp < minImp) { minImp = stats[i].imp; candidates.length = 0; candidates.push(i); }
        else if (stats[i].imp === minImp) { candidates.push(i); }
      }
      bestIdx = candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Auto-rotation check
    if (config.autoRotate && config.mode !== 'manual' && config.queue && config.queue.length > 0) {
      const minImpForRotation = config.rotationMinImpressions || 150;
      const allHaveEnoughData = stats.every(s => s.imp >= minImpForRotation);

      if (allHaveEnoughData) {
        const probs = thompsonProbabilities(stats, 1000);
        const sorted = probs.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p);
        // Champions/challengers model: protect top-N (default 2) from rotation.
        // Once all variants in the round have hit minImpForRotation, the worst
        // non-protected (challenger) gets retired and a new one enters from queue.
        // Champions only lose protection if a future round drops them out of top-N.
        const protectTopN = Math.min(
          activeVariants.length - 1,
          Math.max(1, parseInt(config.protectTopN) || 2)
        );
        const protectedIndices = new Set(sorted.slice(0, protectTopN).map(x => x.i));

        // Round-based: when all have reached minImp, always retire the worst
        // challenger (no threshold gate). This is the "tournament" model — every
        // round one challenger is replaced regardless of absolute Thompson prob.
        let worstIdx = -1, worstProb = Infinity;
        for (let i = 0; i < stats.length; i++) {
          if (protectedIndices.has(i)) continue;
          if (probs[i] < worstProb) { worstProb = probs[i]; worstIdx = i; }
        }

        if (worstIdx >= 0) {
          // Atomic: re-read config from DB, modify, save
          const freshResult = await query('SELECT data FROM config WHERE id = $1', [configId]);
          if (freshResult) {
            const freshRow = (freshResult.rows && freshResult.rows.length)
              ? (typeof freshResult.rows[0].data === 'string' ? JSON.parse(freshResult.rows[0].data) : freshResult.rows[0].data)
              : {};
            const fresh = { ...config, ...freshRow };
            const loserId = activeVariants[worstIdx].id;
            if (fresh.activeVariants.includes(loserId) && fresh.queue && fresh.queue.length > 0) {
              fresh.activeVariants = fresh.activeVariants.filter(v => v !== loserId);
              if (!fresh.retiredVariants) fresh.retiredVariants = [];
              fresh.retiredVariants.push(loserId);
              const replacement = fresh.queue.shift();
              fresh.activeVariants.push(replacement);
              // Start a new round: from now on, round-window stats start fresh
              // for ALL active variants (champions reset their round counter
              // too). Lifetime totals stay intact in the events table.
              const newRoundStart = new Date().toISOString();
              fresh.roundStartedAt = newRoundStart;
              if (!fresh.rotationLog) fresh.rotationLog = [];
              fresh.rotationLog.unshift({
                date: newRoundStart,
                action: 'auto-retire',
                variantOut: loserId,
                variantIn: replacement,
                reason: `Tournament round: worst challenger (Thompson ${worstProb.toFixed(1)}%, ${stats[worstIdx].imp} round imp). Champions protected: top ${protectTopN}. New round started.`
              });
              if (fresh.rotationLog.length > 50) fresh.rotationLog.length = 50;
              await query(
                `INSERT INTO config (id, data, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
                [configId, JSON.stringify(fresh)]
              );
            }
          }
        }
      }
    }
  }

  const chosen = activeVariants[bestIdx];
  // Preserve query string but drop the internal __src param (leaks source
  // tagging into the variant URL). Everything else (utm_*, fbclid, etc)
  // passes through unchanged.
  let qs = '';
  if (req.url.includes('?')) {
    const raw = req.url.split('?')[1];
    const params = new URLSearchParams(raw);
    params.delete('__src');
    qs = params.toString();
  }
  const dest = `/${chosen.file}${qs ? '?' + qs : ''}`;

  res.writeHead(302, {
    Location: dest,
    'Set-Cookie': [
      `ab_variant=${chosen.id}; Path=/; SameSite=Lax; Max-Age=86400`,
      `ab_source=${source}; Path=/; SameSite=Lax; Max-Age=2592000`
    ],
    'Cache-Control': 'no-store'
  });
  res.end();
};
