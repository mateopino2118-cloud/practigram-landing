// Shared helper: build a WHERE clause + params for filtering events by date.
//
// Priority:
//   1. If explicit `from` AND `to` are provided (URL params), use them — full
//      override, ignores experimentStart. Lets the analytics UI compare any
//      arbitrary window including pre-experiment data.
//   2. Otherwise, if `experimentStart` is set in config (ISO timestamp), apply
//      it as a lower bound. Historic events are preserved in the DB but the
//      live Thompson + default analytics view sees only post-checkpoint data.
//   3. Otherwise, no date filter (look at full history).
//
// Always returns a fragment that starts with " AND ..." or "" so callers can
// concatenate it after their first WHERE condition, plus the params array
// they should append (already offset).
//
// Usage:
//   const { fragment, params } = buildEventDateFilter({ from, to, experimentStart, startParamIndex: 2 });
//   const sql = `SELECT ... WHERE variant = ANY($1) ${fragment} GROUP BY ...`;
//   const allParams = [variantIds, ...params];

const TZ = 'America/Argentina/Buenos_Aires';

function buildEventDateFilter({ from, to, experimentStart, startParamIndex = 1 }) {
  if (from && to) {
    return {
      fragment: ` AND created_at >= ($${startParamIndex}::date AT TIME ZONE '${TZ}') AND created_at < (($${startParamIndex + 1}::date + interval '1 day') AT TIME ZONE '${TZ}')`,
      params: [from, to]
    };
  }
  if (experimentStart) {
    return {
      fragment: ` AND created_at >= $${startParamIndex}::timestamptz`,
      params: [experimentStart]
    };
  }
  return { fragment: '', params: [] };
}

// Same idea but for queries that have NO other WHERE clause yet — returns a
// full WHERE fragment instead of an AND fragment.
function buildEventDateWhere({ from, to, experimentStart, startParamIndex = 1 }) {
  if (from && to) {
    return {
      fragment: ` WHERE created_at >= ($${startParamIndex}::date AT TIME ZONE '${TZ}') AND created_at < (($${startParamIndex + 1}::date + interval '1 day') AT TIME ZONE '${TZ}')`,
      params: [from, to]
    };
  }
  if (experimentStart) {
    return {
      fragment: ` WHERE created_at >= $${startParamIndex}::timestamptz`,
      params: [experimentStart]
    };
  }
  return { fragment: '', params: [] };
}

module.exports = { buildEventDateFilter, buildEventDateWhere, TZ };
