const vm = require('node:vm');
const { resolveTransformPreset } = require('./transformCatalog');

function normalizeBoolean(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const input = String(value).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(input)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(input)) return false;
  throw new Error(`Cannot coerce value to boolean: ${value}`);
}

function normalizeNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`Cannot coerce value to number: ${value}`);
  return num;
}

function normalizeJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

function normalizeDateLike(value, mode) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Cannot coerce value to ${mode}: ${value}`);
  if (mode === 'date') return d.toISOString().slice(0, 10);
  return d.toISOString();
}

function createExpressionSandbox({ value, sourceRow, config }) {
  return {
    value,
    row: sourceRow,
    sourceRow,
    config,
    Math,
    Number,
    String,
    Boolean,
    Date,
    JSON,
    Array,
    Object,
  };
}

function runExpression(expression, context) {
  const script = new vm.Script(`(${expression})`);
  return script.runInNewContext(createExpressionSandbox(context), { timeout: 250 });
}

function evaluateCondition(condition, context) {
  if (condition == null || condition === '') return true;
  return Boolean(runExpression(String(condition), context));
}

function normalizeTransform(transform) {
  const presetRule = transform?.preset ? resolveTransformPreset(transform.preset) : null;
  const baseRule = presetRule ? { ...presetRule, config: { ...(presetRule.config || {}), ...(transform?.config || {}) } } : (transform || { type: 'direct', config: {} });
  return {
    ...baseRule,
    type: String(baseRule.type || 'direct'),
    config: baseRule.config || {},
  };
}

function branchlessValue(value) {
  return value && typeof value === 'object';
}

function applyTransform({ value, transform, sourceRow }) {
  const rule = normalizeTransform(transform);
  const type = String(rule.type || 'direct');
  const config = rule.config || {};
  const context = { value, sourceRow, config };

  if (!evaluateCondition(config.when, context)) {
    if (Object.prototype.hasOwnProperty.call(config, 'fallbackValue')) return config.fallbackValue;
    return value;
  }

  switch (type) {
    case 'direct':
      return value;
    case 'string':
      return value == null ? null : String(value);
    case 'number':
      return normalizeNumber(value);
    case 'boolean':
      return normalizeBoolean(value);
    case 'json':
      return normalizeJson(value);
    case 'date':
      return normalizeDateLike(value, 'date');
    case 'datetime':
      return normalizeDateLike(value, 'datetime');
    case 'constant':
      return Object.prototype.hasOwnProperty.call(config, 'value') ? config.value : null;
    case 'null':
      return null;
    case 'template': {
      const tpl = String(config.template || '');
      return tpl.replace(/\{\{\s*([\w$.-]+)\s*\}\}/g, (_, key) => {
        const v = sourceRow?.[key];
        return v == null ? '' : String(v);
      });
    }
    case 'lookup': {
      const lookup = config.values || {};
      const fallback = Object.prototype.hasOwnProperty.call(config, 'defaultValue') ? config.defaultValue : value;
      return Object.prototype.hasOwnProperty.call(lookup, String(value)) ? lookup[String(value)] : fallback;
    }
    case 'expression': {
      const expression = String(config.expression || 'value');
      return runExpression(expression, context);
    }
    case 'concat': {
      const fields = Array.isArray(config.fields) ? config.fields : [];
      const delimiter = String(config.delimiter || '');
      return fields.map((field) => sourceRow?.[field]).filter((item) => item != null && item !== '').join(delimiter) || null;
    }
    case 'coalesce': {
      const fields = Array.isArray(config.fields) ? config.fields : [];
      for (const field of fields) {
        const candidate = sourceRow?.[field];
        if (candidate != null && candidate !== '') return candidate;
      }
      return value;
    }
    case 'conditional': {
      const branches = Array.isArray(config.branches) ? config.branches : [];
      for (const branch of branches) {
        if (evaluateCondition(branch?.when, context)) {
          return applyTransform({ value, transform: branch?.then || { type: 'direct', config: {} }, sourceRow });
        }
      }
      if (branchlessValue(config.otherwise)) {
        return applyTransform({ value, transform: config.otherwise, sourceRow });
      }
      return value;
    }
    default:
      throw new Error(`Unsupported transform type: ${type}`);
  }
}

function shouldIncludeRow({ row, tableMapping }) {
  const filter = tableMapping?.rowFilter;
  if (!filter?.enabled) return true;
  const expression = String(filter.expression || '').trim();
  if (!expression) return true;
  return Boolean(runExpression(expression, { value: row, sourceRow: row, config: filter.config || {} }));
}

function transformRow({ row, tableMapping }) {
  if (!shouldIncludeRow({ row, tableMapping })) return null;
  const output = {};
  for (const mapping of tableMapping.columnMappings || []) {
    if (mapping.enabled === false) continue;
    if (mapping.targetColumnMode === 'ignore') continue;
    if (!mapping.targetColumn) continue;
    const rawValue = row?.[mapping.sourceColumn];
    output[mapping.targetColumn] = applyTransform({ value: rawValue, transform: mapping.transform, sourceRow: row });
  }
  return output;
}

function validateTransformRule(transform, sample = {}) {
  const rule = normalizeTransform(transform);
  if (rule.type === 'expression') {
    runExpression(String(rule.config?.expression || 'value'), { value: sample.value, sourceRow: sample.row || {}, config: rule.config || {} });
  }
  if (rule.type === 'conditional') {
    for (const branch of rule.config?.branches || []) {
      if (branch?.when) runExpression(String(branch.when), { value: sample.value, sourceRow: sample.row || {}, config: branch || {} });
    }
  }
  if (rule.config?.when) {
    runExpression(String(rule.config.when), { value: sample.value, sourceRow: sample.row || {}, config: rule.config || {} });
  }
  return { ok: true, type: rule.type };
}

function supportedTransformTypes() {
  return ['direct', 'string', 'number', 'boolean', 'json', 'date', 'datetime', 'constant', 'null', 'template', 'lookup', 'expression', 'concat', 'coalesce', 'conditional'];
}

module.exports = { applyTransform, transformRow, supportedTransformTypes, shouldIncludeRow, validateTransformRule, normalizeTransform };