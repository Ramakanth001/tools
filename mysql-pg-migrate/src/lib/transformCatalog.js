const TRANSFORM_PRESETS = {
  trim_string: { type: 'expression', config: { expression: 'value == null ? null : String(value).trim()' } },
  lower_email: { type: 'expression', config: { expression: 'value == null ? null : String(value).trim().toLowerCase()' } },
  upper_code: { type: 'expression', config: { expression: 'value == null ? null : String(value).trim().toUpperCase()' } },
  boolean_flag: { type: 'boolean', config: {} },
  json_parse: { type: 'json', config: {} },
  full_name: { type: 'concat', config: { fields: ['first_name', 'last_name'], delimiter: ' ' } },
  keep_when_present: { type: 'conditional', config: { branches: [{ when: 'value != null && value !== ""', then: { type: 'direct', config: {} } }], otherwise: { type: 'null', config: {} } } },
};

function listTransformPresets() {
  return Object.entries(TRANSFORM_PRESETS).map(([name, rule]) => ({
    name,
    label: name.replace(/_/g, ' '),
    description: describePreset(name, rule),
    rule,
  }));
}

function describePreset(name, rule) {
  if (name === 'trim_string') return 'Trim surrounding whitespace';
  if (name === 'lower_email') return 'Normalize email values to lowercase';
  if (name === 'upper_code') return 'Normalize codes to uppercase';
  if (name === 'boolean_flag') return 'Convert common boolean-like inputs';
  if (name === 'json_parse') return 'Parse JSON string inputs';
  if (name === 'full_name') return 'Concatenate first_name and last_name';
  if (name === 'keep_when_present') return 'Keep value only when present; otherwise null';
  return `Preset for ${rule.type}`;
}

function resolveTransformPreset(name) {
  return TRANSFORM_PRESETS[name] || null;
}

module.exports = { listTransformPresets, resolveTransformPreset };