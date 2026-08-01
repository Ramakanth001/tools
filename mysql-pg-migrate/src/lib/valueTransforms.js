const vm = require('node:vm');
const { resolveTransformPreset } = require('./transformCatalog');
const { repairMojibake } = require('./mojibakeRepair');

const MAX_EXPRESSION_LENGTH = 1000;
const DENIED_EXPRESSION_TOKENS = [
  'constructor',
  '__proto__',
  'prototype',
  'Function',
  'eval',
  'require',
  'import',
  'process',
  'global',
  'globalThis',
  'module',
  'exports',
  'child_process',
  'WebAssembly',
  'Reflect',
  'Proxy',
];

function assertSafeExpression(expression) {
  const text = String(expression || '');
  if (text.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`);
  }
  for (const token of DENIED_EXPRESSION_TOKENS) {
    const pattern = new RegExp(`(^|[^\\w$])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`);
    if (pattern.test(text)) {
      throw new Error(`Expression uses unsupported token: ${token}`);
    }
  }
  return text;
}

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
  const safeExpression = assertSafeExpression(expression);
  const script = new vm.Script(`(${safeExpression})`);
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

function applyTransform({ value, transform, sourceRow, lookupResolver }) {
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
    case 'lookup_table': {
      if (typeof lookupResolver !== 'function') throw new Error('lookup_table transform requires lookup resolver context');
      const outcome = lookupResolver({ config, sourceRow, value });
      if (outcome?.found) return outcome.value;
      const missing = String(config.missing || 'reject');
      if (missing === 'default') return Object.prototype.hasOwnProperty.call(config, 'defaultValue') ? config.defaultValue : null;
      if (missing === 'null') return null;
      const localColumn = config.localColumn || 'source value';
      const localValue = sourceRow?.[localColumn] ?? value;
      throw new Error(`Lookup value not found for ${config.table || 'lookup table'}.${config.lookupColumn || 'lookup column'} = ${localValue}`);
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
          return applyTransform({ value, transform: branch?.then || { type: 'direct', config: {} }, sourceRow, lookupResolver });
        }
      }
      if (branchlessValue(config.otherwise)) {
        return applyTransform({ value, transform: config.otherwise, sourceRow, lookupResolver });
      }
      return value;
    }
    case 'mojibake_repair': {
      if (value == null) return null;
      const mode = String(config.mode || 'auto');
      return repairMojibake(String(value), { mode });
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

function transformRow({ row, tableMapping, lookupResolver }) {
  if (!shouldIncludeRow({ row, tableMapping })) return null;
  const output = {};
  for (const mapping of tableMapping.columnMappings || []) {
    if (mapping.enabled === false) continue;
    if (mapping.targetColumnMode === 'ignore') continue;
    if (!mapping.targetColumn) continue;
    const rawValue = row?.[mapping.sourceColumn];
    const rule = normalizeTransform(mapping.transform);
    const transform = rule.type === 'lookup_table' && !rule.config?.localColumn
      ? { ...rule, config: { ...(rule.config || {}), localColumn: mapping.sourceColumn } }
      : mapping.transform;
    output[mapping.targetColumn] = applyTransform({ value: rawValue, transform, sourceRow: row, lookupResolver });
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
      if (branch?.then) validateTransformRule(branch.then, sample);
    }
    if (rule.config?.otherwise) validateTransformRule(rule.config.otherwise, sample);
  }
  if (rule.type === 'lookup_table') {
    const config = rule.config || {};
    for (const key of ['table', 'lookupColumn', 'valueColumn']) {
      if (!String(config[key] || '').trim()) throw new Error(`lookup_table transform requires config.${key}`);
    }
  }
  if (rule.config?.when) {
    runExpression(String(rule.config.when), { value: sample.value, sourceRow: sample.row || {}, config: rule.config || {} });
  }
  return { ok: true, type: rule.type };
}

function supportedTransformTypes() {
  return ['direct', 'string', 'number', 'boolean', 'json', 'date', 'datetime', 'constant', 'null', 'template', 'lookup', 'lookup_table', 'expression', 'concat', 'coalesce', 'conditional', 'mojibake_repair'];
}

module.exports = { applyTransform, transformRow, supportedTransformTypes, shouldIncludeRow, validateTransformRule, normalizeTransform, assertSafeExpression };
