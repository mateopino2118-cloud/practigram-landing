const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API handlers (same (req, res) signature as Vercel serverless) ────────────
const redirect   = require('./api/redirect');
const track      = require('./api/track');
const stats      = require('./api/stats');
const config     = require('./api/config');
const variante   = require('./api/variante');
const funnel     = require('./api/funnel');
const ranking    = require('./api/ranking');
const pivot      = require('./api/pivot');
const tendencias = require('./api/tendencias');
const dimensions = require('./api/dimensions');

// ── Entry-point routes (replaces vercel.json rewrites) ───────────────────────
// GET /  → Thompson Sampling redirect to a variant
app.get('/', redirect);

// GET /yt → same redirect but tagged as YouTube source (?__src=youtube)
app.get('/yt', (req, res) => {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  params.set('__src', 'youtube');
  req.url = '/?' + params.toString();
  redirect(req, res);
});

// ── API routes ────────────────────────────────────────────────────────────────
app.all('/api/redirect',   redirect);
app.all('/api/track',      track);
app.all('/api/stats',      stats);
app.all('/api/config',     config);
app.all('/api/variante',   variante);
app.all('/api/funnel',     funnel);
app.all('/api/ranking',    ranking);
app.all('/api/pivot',      pivot);
app.all('/api/tendencias', tendencias);
app.all('/api/dimensions', dimensions);

// ── Static files ──────────────────────────────────────────────────────────────
// extensions:['html'] replicates Vercel's cleanUrls:true
// → /v1-carta-ventas  serves  v1-carta-ventas.html  (no .html in URL needed)
// index:false  porque GET / lo maneja el redirect handler, no index.html
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: false,
}));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Practigram Landing → http://localhost:${PORT}`);
});
