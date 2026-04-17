const { VALID_IDS, DEFAULT_ACTIVE, DEFAULT_QUEUE } = require('./_variants');
const { query } = require('./_db');
const { detectSourceFromQuery, configIdFor } = require('./_source');

const MAX_ACTIVE = 4;

const DEFAULTS = {
  mode: 'warmup',
  warmupMin: 150,
  weights: {},
  activeVariants: DEFAULT_ACTIVE,
  retiredVariants: [],
  queue: DEFAULT_QUEUE,
  autoRotate: true,
  rotationThreshold: 5,
  rotationMinImpressions: 500,
  protectTopN: 2,
  // ISO timestamp marking the start of the current tournament round.
  // Round-window impressions/conversions are computed from events created
  // after this timestamp. Lifetime totals (without this filter) are kept
  // separately so historical data is never lost.
  roundStartedAt: null,
  rotationLog: [],
  // ISO timestamp marking the start of the current experiment window.
  // Events before this timestamp are preserved in the DB but ignored by
  // Thompson Sampling and the default analytics view. Override per request
  // by passing explicit ?from=&to= URL params.
  experimentStart: null,
  experimentLog: []
};

async function getConfig(source) {
  const id = configIdFor(source);
  const r = await query('SELECT data FROM config WHERE id = $1', [id]);
  if (!r || !r.rows.length || !r.rows[0].data) return { ...DEFAULTS };
  const data = r.rows[0].data;
  return { ...DEFAULTS, ...(typeof data === 'string' ? JSON.parse(data) : data) };
}

async function saveConfig(source, config) {
  const id = configIdFor(source);
  await query(
    `INSERT INTO config (id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [id, JSON.stringify(config)]
  );
}

function addLog(config, action, details) {
  if (!config.rotationLog) config.rotationLog = [];
  config.rotationLog.unshift({ date: new Date().toISOString(), action, ...details });
  if (config.rotationLog.length > 50) config.rotationLog.length = 50;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Source determines which config row we read/write. 'all' is not valid
  // for config (mutations must target one experiment); fall back to 'meta'.
  const sourceRaw = detectSourceFromQuery(req, { allowAll: false });
  const source = sourceRaw === 'youtube' ? 'youtube' : 'meta';

  if (req.method === 'GET') {
    return res.status(200).json({ source, ...(await getConfig(source)) });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const config = await getConfig(source);

    // --- Action-based operations ---
    if (body.action === 'retire') {
      const id = body.variantId;
      if (!id || !config.activeVariants.includes(id)) return res.status(400).json({ error: 'variant not active' });
      config.activeVariants = config.activeVariants.filter(v => v !== id);
      if (!config.retiredVariants.includes(id)) config.retiredVariants.push(id);
      let replacedBy = null;
      if (config.queue.length > 0) { replacedBy = config.queue.shift(); config.activeVariants.push(replacedBy); }
      addLog(config, 'retire', { variantOut: id, variantIn: replacedBy, reason: body.reason || 'manual' });
      await saveConfig(source, config);
      return res.status(200).json(config);
    }

    if (body.action === 'activate') {
      const id = body.variantId;
      if (!id || !VALID_IDS.includes(id)) return res.status(400).json({ error: 'invalid variant' });
      if (config.activeVariants.includes(id)) return res.status(400).json({ error: 'already active' });
      if (config.activeVariants.length >= MAX_ACTIVE) return res.status(400).json({ error: `max ${MAX_ACTIVE} active variants` });
      config.queue = config.queue.filter(v => v !== id);
      config.retiredVariants = config.retiredVariants.filter(v => v !== id);
      config.activeVariants.push(id);
      addLog(config, 'activate', { variantIn: id, reason: 'manual' });
      await saveConfig(source, config);
      return res.status(200).json(config);
    }

    if (body.action === 'resetExperiment') {
      // Mark a checkpoint: from now on, Thompson + default analytics ignore
      // events before this moment. Historic events stay in the DB.
      const at = body.at && !isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : new Date().toISOString();
      const previous = config.experimentStart || null;
      config.experimentStart = at;
      if (!Array.isArray(config.experimentLog)) config.experimentLog = [];
      config.experimentLog.unshift({
        date: new Date().toISOString(),
        checkpoint: at,
        previous,
        reason: body.reason || 'manual'
      });
      if (config.experimentLog.length > 30) config.experimentLog.length = 30;
      addLog(config, 'resetExperiment', { checkpoint: at, previous, reason: body.reason || 'manual' });
      await saveConfig(source, config);
      return res.status(200).json(config);
    }

    if (body.action === 'clearExperimentStart') {
      const previous = config.experimentStart || null;
      config.experimentStart = null;
      if (!Array.isArray(config.experimentLog)) config.experimentLog = [];
      config.experimentLog.unshift({
        date: new Date().toISOString(),
        checkpoint: null,
        previous,
        reason: body.reason || 'cleared'
      });
      if (config.experimentLog.length > 30) config.experimentLog.length = 30;
      addLog(config, 'clearExperimentStart', { previous, reason: body.reason || 'manual' });
      await saveConfig(source, config);
      return res.status(200).json(config);
    }

    if (body.action === 'requeue') {
      const id = body.variantId;
      if (!id || !config.retiredVariants.includes(id)) return res.status(400).json({ error: 'variant not retired' });
      config.retiredVariants = config.retiredVariants.filter(v => v !== id);
      config.queue.push(id);
      addLog(config, 'requeue', { variantId: id, reason: 'manual' });
      await saveConfig(source, config);
      return res.status(200).json(config);
    }

    // --- Bulk variant list updates ---
    if (Array.isArray(body.activeVariants) && body.activeVariants.every(id => VALID_IDS.includes(id))) {
      config.activeVariants = body.activeVariants.slice(0, MAX_ACTIVE);
    }
    if (Array.isArray(body.retiredVariants) && body.retiredVariants.every(id => VALID_IDS.includes(id))) {
      config.retiredVariants = body.retiredVariants;
    }
    if (Array.isArray(body.queue) && body.queue.every(id => VALID_IDS.includes(id))) {
      config.queue = body.queue;
    }

    // --- Regular config updates ---
    if (['warmup', 'thompson', 'manual'].includes(body.mode)) config.mode = body.mode;
    if (typeof body.warmupMin === 'number' && body.warmupMin >= 0) config.warmupMin = Math.round(body.warmupMin);
    if (body.weights && typeof body.weights === 'object') config.weights = body.weights;
    if (typeof body.autoRotate === 'boolean') config.autoRotate = body.autoRotate;
    if (typeof body.rotationThreshold === 'number' && body.rotationThreshold >= 0) config.rotationThreshold = body.rotationThreshold;
    if (typeof body.rotationMinImpressions === 'number' && body.rotationMinImpressions >= 0) config.rotationMinImpressions = Math.round(body.rotationMinImpressions);
    if (typeof body.protectTopN === 'number' && body.protectTopN >= 1 && body.protectTopN <= 3) config.protectTopN = Math.round(body.protectTopN);
    if (body.roundStartedAt === null) config.roundStartedAt = null;
    else if (typeof body.roundStartedAt === 'string' && !isNaN(Date.parse(body.roundStartedAt))) config.roundStartedAt = new Date(body.roundStartedAt).toISOString();
    if (body.action === 'startNewRound') {
      config.roundStartedAt = new Date().toISOString();
      addLog(config, 'startNewRound', { at: config.roundStartedAt, reason: body.reason || 'manual' });
      await saveConfig(source, config);
      return res.status(200).json(config);
    }

    await saveConfig(source, config);
    return res.status(200).json(config);
  }

  return res.status(405).json({ error: 'GET or POST only' });
};

module.exports.MAX_ACTIVE = MAX_ACTIVE;
