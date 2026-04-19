function redactConnectionString(cs) {
  const s = String(cs || '');
  if (!s) return s;
  return s.replace(/(mysql(?:\+[^:]+)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi, '$1***$3');
}

module.exports = { redactConnectionString };