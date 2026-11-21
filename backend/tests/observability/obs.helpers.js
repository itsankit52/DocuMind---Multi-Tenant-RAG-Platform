/**
 * Shared helpers for Step 13 observability tests (not a test suite itself).
 */

const { register } = require('../../src/observability/metrics');
const logger = require('../../src/observability/logger');

/** Sum of a metric's samples matching every given label (histograms: pass the sample name, e.g. foo_count). */
async function metricValue(name, labels = {}) {
  const family = name.replace(/_(count|sum|bucket)$/, '');
  const metric = register.getSingleMetric(family) || register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} not registered`);
  const { values } = await metric.get();
  return values
    .filter(v => (v.metricName || family) === name || (!v.metricName && family === name))
    .filter(v => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === String(val)))
    .reduce((sum, v) => sum + v.value, 0);
}

/** Capture structured log lines written while fn runs. */
async function captureLogs(fn, level = 'debug') {
  const lines = [];
  const previous = logger.getLevel();
  logger.configure({ level, write: (line) => lines.push(line) });
  try {
    await fn();
  } finally {
    logger.configure({ level: previous, write: (line) => process.stdout.write(`${line}\n`) });
  }
  return lines;
}

/** Validate Prometheus text exposition format line by line. Returns offending lines. */
function invalidExpositionLines(text) {
  const sample = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*",?)*\})? -?([0-9.e+-]+|NaN|\+Inf|-Inf)( [0-9]+)?$/;
  const comment = /^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]*( .*)?$/;
  return text.split('\n').filter(l => l.length > 0 && !comment.test(l) && !sample.test(l));
}

module.exports = { metricValue, captureLogs, invalidExpositionLines };
