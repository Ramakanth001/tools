function redactConnectionString(cs) {
  const s = String(cs || '');
  if (!s) return s;

  // Redact user:pass@ in postgres URLs.
  // postgresql://user:pass@host/db -> postgresql://user:***@host/db
  return s.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi, '$1***$3');
}

module.exports = { redactConnectionString };
