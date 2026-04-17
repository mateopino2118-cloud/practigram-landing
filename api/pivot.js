// Pivot endpoint: variant × country (and variant × device).
// Returns matrices that the frontend pivots into a triangulation table:
//   "Which landing converts best in each country?"
//   "Which country converts best for each landing?"
//
// One query for the variant × (country, device) breakdown of impressions
// and conversions, scoped by source/date. Filters NULLs from pre-Fase-2 rows.
const { ALL_VARIANTS, VARIANT_MAP } = require('./_variants');
const { query } = require('./_db');
const { detectSourceFromQuery } = require('./_source');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { from, to } = req.query || {};
  const source = detectSourceFromQuery(req, { allowAll: true });
  const isAll = source === 'all';

  const TZ = 'America/Argentina/Buenos_Aires';
  const params = [];
  let dateClause = '';
  if (from && to) {
    params.push(from, to);
    dateClause = ` AND created_at >= ($${params.length - 1}::date AT TIME ZONE '${TZ}') AND created_at < (($${params.length}::date + interval '1 day') AT TIME ZONE '${TZ}')`;
  }
  let srcClause = '';
  if (!isAll) {
    params.push(source);
    srcClause = ` AND source = $${params.length}`;
  }

  // variant × country pivot
  const ctyResult = await query(
    `SELECT variant, country, type, count(*) AS cnt
     FROM events
     WHERE country IS NOT NULL AND type IN ('impression', 'conversion')${dateClause}${srcClause}
     GROUP BY variant, country, type`,
    params
  );

  // variant × device pivot
  const devResult = await query(
    `SELECT variant, device, type, count(*) AS cnt
     FROM events
     WHERE device IS NOT NULL AND type IN ('impression', 'conversion')${dateClause}${srcClause}
     GROUP BY variant, device, type`,
    params
  );

  // Pivot rows into nested map: { variant: { bucket: {imp, conv} } }
  function buildMatrix(result, bucketField) {
    const m = {};
    if (!result) return m;
    for (const row of result.rows) {
      const v = row.variant;
      const k = row[bucketField];
      if (!m[v]) m[v] = {};
      if (!m[v][k]) m[v][k] = { impressions: 0, conversions: 0 };
      const c = parseInt(row.cnt, 10);
      if (row.type === 'impression') m[v][k].impressions = c;
      else if (row.type === 'conversion') m[v][k].conversions = c;
    }
    return m;
  }

  const byCountry = buildMatrix(ctyResult, 'country');
  const byDevice  = buildMatrix(devResult, 'device');

  // Collect all unique countries and devices that appeared, sorted by total volume.
  function collectKeys(matrix) {
    const totals = {};
    for (const v in matrix) {
      for (const k in matrix[v]) {
        if (!totals[k]) totals[k] = 0;
        totals[k] += matrix[v][k].impressions;
      }
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }
  const countries = collectKeys(byCountry);
  const devices = collectKeys(byDevice);

  // Emit one row per variant that has ANY data, with a per-bucket cell array
  // and a total. Variants without data are skipped (not in matrix).
  function emitVariantRows(matrix, keys) {
    const variantIds = Object.keys(matrix);
    return variantIds.map(vid => {
      const meta = VARIANT_MAP[vid];
      const cells = keys.map(k => {
        const cell = matrix[vid][k] || { impressions: 0, conversions: 0 };
        return {
          key: k,
          impressions: cell.impressions,
          conversions: cell.conversions,
          conversionRate: cell.impressions > 0 ? (cell.conversions / cell.impressions * 100) : null,
        };
      });
      const totalImp = cells.reduce((s, c) => s + c.impressions, 0);
      const totalConv = cells.reduce((s, c) => s + c.conversions, 0);
      return {
        id: vid,
        name: meta ? meta.name : vid,
        cells,
        totalImpressions: totalImp,
        totalConversions: totalConv,
        totalConversionRate: totalImp > 0 ? (totalConv / totalImp * 100) : null,
      };
    }).filter(v => v.totalImpressions > 0)
      .sort((a, b) => (b.totalConversionRate || 0) - (a.totalConversionRate || 0));
  }

  return res.status(200).json({
    source,
    countries,
    devices,
    byCountry: emitVariantRows(byCountry, countries),
    byDevice: emitVariantRows(byDevice, devices),
    filtered: !!(from && to),
    updatedAt: new Date().toISOString(),
  });
};
