/** Compact CPI histories while preserving per-observation source attribution. */
export function periodRank(value) {
  const period = String(value || ''), month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period), quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (month) return Number(month[1]) * 12 + Number(month[2]) - 1;
  if (quarter) return Number(quarter[1]) * 12 + Number(quarter[2]) * 3 - 1;
  return -1;
}

export function latestByPeriod(...points) { return points.filter(Boolean).sort((a, b) => periodRank(b.period) - periodRank(a.period))[0] || null; }

function sourceIdentity(source) {
  return JSON.stringify(['publisher', 'dataset', 'title', 'measure', 'url', 'sourceNote', 'sourceOrganization'].map(key => source?.[key] || ''));
}

export function compactHistory(prior, refreshed, inheritedSource, inheritedSources, frequency) {
  const sources = [], sourceIndexes = new Map(), points = new Map();
  const addSource = value => {
    if (!value || typeof value !== 'object') return -1;
    const key = sourceIdentity(value);
    if (sourceIndexes.has(key)) {
      const index = sourceIndexes.get(key); sources[index] = value; return index;
    }
    const index = sources.push(value) - 1; sourceIndexes.set(key, index); return index;
  };
  const catalog = Array.isArray(inheritedSources) ? inheritedSources : [];
  catalog.forEach(addSource);
  const resolveSource = point => point?.source || (Number.isInteger(point?.sourceId) ? catalog[point.sourceId] : null) || inheritedSource || null;
  for (const point of [...(prior || []), ...(refreshed || [])]) {
    const validPeriod = frequency === 'quarterly' ? /^\d{4}-Q[1-4]$/.test(point?.period || '') : /^\d{4}-(0[1-9]|1[0-2])$/.test(point?.period || '');
    if (!validPeriod || !Number.isFinite(point.value)) continue;
    const source = resolveSource(point), sourceId = addSource(source);
    if (sourceId < 0 || !sources[sourceId]?.url) continue;
    points.set(point.period, { point, sourceId });
  }
  const defaultSource = (refreshed || []).map(point => point?.source).filter(Boolean).at(-1) || inheritedSource || sources.at(-1) || null;
  const defaultSourceId = defaultSource ? addSource(defaultSource) : -1;
  const history = [...points.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, entry]) => {
    const point = entry.point, output = { period, value: point.value, frequency };
    if (point.releaseDate) output.releaseDate = point.releaseDate;
    if (sources.length > 1 && entry.sourceId !== defaultSourceId) output.sourceId = entry.sourceId;
    return output;
  });
  return { history, source: defaultSource, sources: sources.length > 1 ? sources : null };
}
