// Aggregations across the dimensions added in migration 002:
// hour_local, device, country. Returns 3 cuts in a single response so the
// panel only makes one request to power 3 cards.
//
// All queries filter `WHERE <dim> IS NOT NULL` so historical events from
// before migration 002 are silently excluded — they would otherwise show
// up as a giant "unknown" bucket and drown the real data.
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

  // Build common WHERE fragments. Date range optional, source optional.
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
  const baseWhere = `type IN ('impression', 'conversion')${dateClause}${srcClause}`;

  // Run the 3 cuts in parallel.
  const [hourRes, devRes, ctyRes] = await Promise.all([
    query(
      `SELECT hour_local AS bucket, type, count(*) AS cnt
       FROM events
       WHERE hour_local IS NOT NULL AND ${baseWhere}
       GROUP BY hour_local, type`,
      params
    ),
    query(
      `SELECT device AS bucket, type, count(*) AS cnt
       FROM events
       WHERE device IS NOT NULL AND ${baseWhere}
       GROUP BY device, type`,
      params
    ),
    query(
      `SELECT country AS bucket, type, count(*) AS cnt
       FROM events
       WHERE country IS NOT NULL AND ${baseWhere}
       GROUP BY country, type`,
      params
    ),
  ]);

  // Helper: pivot rows into [{key, impressions, conversions, conversionRate}].
  function pivot(result, sorter) {
    const map = {};
    if (result) {
      for (const row of result.rows) {
        const k = row.bucket;
        if (!map[k]) map[k] = { impressions: 0, conversions: 0 };
        const c = parseInt(row.cnt, 10);
        if (row.type === 'impression') map[k].impressions = c;
        else if (row.type === 'conversion') map[k].conversions = c;
      }
    }
    const rows = Object.entries(map).map(([key, v]) => ({
      key,
      impressions: v.impressions,
      conversions: v.conversions,
      conversionRate: v.impressions > 0 ? (v.conversions / v.impressions * 100) : null,
    }));
    rows.sort(sorter);
    return rows;
  }

  // Heatmap: 24 buckets, fill missing hours with zero so the chart is
  // continuous. Sort by hour ascending.
  const hourMap = {};
  if (hourRes) {
    for (const row of hourRes.rows) {
      const h = parseInt(row.bucket, 10);
      if (!hourMap[h]) hourMap[h] = { impressions: 0, conversions: 0 };
      const c = parseInt(row.cnt, 10);
      if (row.type === 'impression') hourMap[h].impressions = c;
      else if (row.type === 'conversion') hourMap[h].conversions = c;
    }
  }
  const heatmap = [];
  for (let h = 0; h < 24; h++) {
    const v = hourMap[h] || { impressions: 0, conversions: 0 };
    heatmap.push({
      hour: h,
      impressions: v.impressions,
      conversions: v.conversions,
      conversionRate: v.impressions > 0 ? (v.conversions / v.impressions * 100) : null,
    });
  }

  const devices = pivot(devRes, (a, b) => b.impressions - a.impressions);
  const countries = pivot(ctyRes, (a, b) => b.impressions - a.impressions);

  return res.status(200).json({
    source,
    heatmap,
    devices,
    countries,
    filtered: !!(from && to),
    updatedAt: new Date().toISOString(),
  });
};
