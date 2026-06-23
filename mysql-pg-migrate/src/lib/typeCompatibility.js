const TOP_50_MYSQL_POSTGRESQL_BIDIRECTIONAL_TYPES = Object.freeze({
  boolean: { mysql: 'BOOLEAN / BOOL', postgresql: 'BOOLEAN', postgresql_to_mysql: 'BOOLEAN / TINYINT(1)', compatibility: 'conditional', condition: 'Safe if MySQL values are only 0, 1, or NULL.' },
  bit: { mysql: 'BIT(M)', postgresql: 'BIT(M)', postgresql_to_mysql: 'BIT(M)', compatibility: 'constrained', condition: 'For MySQL round trip, keep M between 1 and 64.' },
  tinyint: { mysql: 'TINYINT', postgresql: 'SMALLINT', postgresql_to_mysql: 'TINYINT', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN -128 AND 127.' },
  tinyint_unsigned: { mysql: 'TINYINT UNSIGNED', postgresql: 'SMALLINT', postgresql_to_mysql: 'TINYINT UNSIGNED', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN 0 AND 255.' },
  smallint: { mysql: 'SMALLINT', postgresql: 'SMALLINT', postgresql_to_mysql: 'SMALLINT', compatibility: 'direct', condition: null },
  smallint_unsigned: { mysql: 'SMALLINT UNSIGNED', postgresql: 'INTEGER', postgresql_to_mysql: 'SMALLINT UNSIGNED', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN 0 AND 65535.' },
  mediumint: { mysql: 'MEDIUMINT', postgresql: 'INTEGER', postgresql_to_mysql: 'MEDIUMINT', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN -8388608 AND 8388607.' },
  mediumint_unsigned: { mysql: 'MEDIUMINT UNSIGNED', postgresql: 'INTEGER', postgresql_to_mysql: 'MEDIUMINT UNSIGNED', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN 0 AND 16777215.' },
  int: { mysql: 'INT / INTEGER', postgresql: 'INTEGER', postgresql_to_mysql: 'INT / INTEGER', compatibility: 'direct', condition: null },
  int_unsigned: { mysql: 'INT UNSIGNED / INTEGER UNSIGNED', postgresql: 'BIGINT', postgresql_to_mysql: 'INT UNSIGNED', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN 0 AND 4294967295.' },
  bigint: { mysql: 'BIGINT', postgresql: 'BIGINT', postgresql_to_mysql: 'BIGINT', compatibility: 'direct', condition: null },
  bigint_unsigned: { mysql: 'BIGINT UNSIGNED', postgresql: 'NUMERIC(20,0)', postgresql_to_mysql: 'BIGINT UNSIGNED', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN 0 AND 18446744073709551615.' },
  decimal: { mysql: 'DECIMAL(p,s)', postgresql: 'NUMERIC(p,s)', postgresql_to_mysql: 'DECIMAL(p,s)', compatibility: 'direct', condition: 'Keep precision and scale within MySQL-supported limits for reverse migration.' },
  decimal_unsigned: { mysql: 'DECIMAL(p,s) UNSIGNED', postgresql: 'NUMERIC(p,s)', postgresql_to_mysql: 'DECIMAL(p,s) UNSIGNED', compatibility: 'constrained', condition: 'Add CHECK value >= 0.' },
  numeric: { mysql: 'NUMERIC(p,s)', postgresql: 'NUMERIC(p,s)', postgresql_to_mysql: 'NUMERIC(p,s)', compatibility: 'direct', condition: 'Keep precision and scale within MySQL-supported limits for reverse migration.' },
  float: { mysql: 'FLOAT', postgresql: 'REAL', postgresql_to_mysql: 'FLOAT', compatibility: 'direct', condition: 'Approximate floating-point values may not be bit-for-bit identical.' },
  float_precision: { mysql: 'FLOAT(p)', postgresql: 'REAL or DOUBLE PRECISION', postgresql_to_mysql: 'FLOAT(p)', compatibility: 'conditional', condition: 'Use REAL for lower precision; use DOUBLE PRECISION when MySQL FLOAT(p) resolves to DOUBLE.' },
  double: { mysql: 'DOUBLE / DOUBLE PRECISION', postgresql: 'DOUBLE PRECISION', postgresql_to_mysql: 'DOUBLE', compatibility: 'direct', condition: 'Approximate floating-point values may not be bit-for-bit identical.' },
  real: { mysql: 'REAL', postgresql: 'DOUBLE PRECISION', postgresql_to_mysql: 'REAL / DOUBLE', compatibility: 'conditional', condition: 'MySQL commonly treats REAL as DOUBLE PRECISION unless REAL_AS_FLOAT mode is enabled.' },
  date: { mysql: 'DATE', postgresql: 'DATE', postgresql_to_mysql: 'DATE', compatibility: 'direct', condition: "Clean MySQL zero dates like '0000-00-00' before loading into PostgreSQL." },
  datetime: { mysql: 'DATETIME', postgresql: 'TIMESTAMP WITHOUT TIME ZONE', postgresql_to_mysql: 'DATETIME', compatibility: 'direct', condition: 'Best match for timezone-neutral date-time values.' },
  datetime_fsp: { mysql: 'DATETIME(fsp)', postgresql: 'TIMESTAMP(fsp) WITHOUT TIME ZONE', postgresql_to_mysql: 'DATETIME(fsp)', compatibility: 'direct', condition: 'Keep fsp between 0 and 6 for MySQL compatibility.' },
  timestamp: { mysql: 'TIMESTAMP', postgresql: 'TIMESTAMP WITH TIME ZONE', postgresql_to_mysql: 'TIMESTAMP', compatibility: 'conditional', condition: 'Safe when treating values as instants in time; verify MySQL TIMESTAMP range.' },
  timestamp_fsp: { mysql: 'TIMESTAMP(fsp)', postgresql: 'TIMESTAMP(fsp) WITH TIME ZONE', postgresql_to_mysql: 'TIMESTAMP(fsp)', compatibility: 'conditional', condition: 'Keep fsp between 0 and 6 and verify MySQL TIMESTAMP range.' },
  time_clock: { mysql: 'TIME', postgresql: 'TIME WITHOUT TIME ZONE', postgresql_to_mysql: 'TIME', compatibility: 'conditional', condition: 'Use only when MySQL TIME represents clock time, not elapsed duration.' },
  time_duration: { mysql: 'TIME', postgresql: 'INTERVAL', postgresql_to_mysql: 'TIME', compatibility: 'conditional', condition: 'Use for elapsed durations; reverse only if values fit MySQL TIME range.' },
  year: { mysql: 'YEAR', postgresql: 'SMALLINT', postgresql_to_mysql: 'YEAR', compatibility: 'constrained', condition: 'Add CHECK value BETWEEN 1901 AND 2155, or allow 0 if your MySQL data uses it.' },
  char: { mysql: 'CHAR(n)', postgresql: 'CHAR(n)', postgresql_to_mysql: 'CHAR(n)', compatibility: 'direct', condition: 'Check collation and trailing-space behavior if comparisons must match exactly.' },
  varchar: { mysql: 'VARCHAR(n)', postgresql: 'VARCHAR(n)', postgresql_to_mysql: 'VARCHAR(n)', compatibility: 'direct', condition: 'Preserve n for round-trip DDL compatibility.' },
  tinytext: { mysql: 'TINYTEXT', postgresql: 'TEXT', postgresql_to_mysql: 'TINYTEXT', compatibility: 'constrained', condition: 'Add length check if reverse migration must preserve TINYTEXT limit.' },
  text: { mysql: 'TEXT', postgresql: 'TEXT', postgresql_to_mysql: 'TEXT', compatibility: 'direct', condition: "Value-compatible if data fits both engines' size limits." },
  mediumtext: { mysql: 'MEDIUMTEXT', postgresql: 'TEXT', postgresql_to_mysql: 'MEDIUMTEXT', compatibility: 'conditional', condition: 'Value-compatible if data fits PostgreSQL TEXT limits.' },
  longtext: { mysql: 'LONGTEXT', postgresql: 'TEXT', postgresql_to_mysql: 'LONGTEXT', compatibility: 'conditional', condition: 'Value-compatible if data fits PostgreSQL TEXT limits.' },
  binary: { mysql: 'BINARY(n)', postgresql: 'BYTEA', postgresql_to_mysql: 'BINARY(n)', compatibility: 'constrained', condition: 'Add CHECK octet_length(value) = n.' },
  varbinary: { mysql: 'VARBINARY(n)', postgresql: 'BYTEA', postgresql_to_mysql: 'VARBINARY(n)', compatibility: 'constrained', condition: 'Add CHECK octet_length(value) <= n.' },
  tinyblob: { mysql: 'TINYBLOB', postgresql: 'BYTEA', postgresql_to_mysql: 'TINYBLOB', compatibility: 'constrained', condition: 'Add byte-length check if reverse migration must preserve TINYBLOB limit.' },
  blob: { mysql: 'BLOB', postgresql: 'BYTEA', postgresql_to_mysql: 'BLOB', compatibility: 'direct', condition: "Value-compatible if binary data fits both engines' size limits." },
  mediumblob: { mysql: 'MEDIUMBLOB', postgresql: 'BYTEA', postgresql_to_mysql: 'MEDIUMBLOB', compatibility: 'conditional', condition: 'Value-compatible if data fits PostgreSQL BYTEA limits.' },
  longblob: { mysql: 'LONGBLOB', postgresql: 'BYTEA', postgresql_to_mysql: 'LONGBLOB', compatibility: 'conditional', condition: 'Value-compatible if data fits PostgreSQL BYTEA limits.' },
  json: { mysql: 'JSON', postgresql: 'JSONB', postgresql_to_mysql: 'JSON', compatibility: 'conditional', condition: 'Use JSONB for query/index performance; use PostgreSQL JSON if textual preservation matters.' },
  enum: { mysql: "ENUM('a','b',...)", postgresql: 'TEXT CHECK (value IN (...))', postgresql_to_mysql: "ENUM('a','b',...)", compatibility: 'constrained', condition: 'Can also use PostgreSQL ENUM, but TEXT + CHECK is easier for bidirectional migrations.' },
  set: { mysql: "SET('a','b',...)", postgresql: 'TEXT[]', postgresql_to_mysql: "SET('a','b',...)", compatibility: 'conditional', condition: 'No exact native equivalent; safe only if array values are constrained to the original SET labels.' },
  geometry: { mysql: 'GEOMETRY', postgresql: 'GEOMETRY', postgresql_to_mysql: 'GEOMETRY', compatibility: 'extension', condition: 'Requires PostGIS on PostgreSQL side; preserve SRID.' },
  point: { mysql: 'POINT', postgresql: 'GEOMETRY(POINT, srid)', postgresql_to_mysql: 'POINT', compatibility: 'extension', condition: 'Requires PostGIS; preserve SRID.' },
  linestring: { mysql: 'LINESTRING', postgresql: 'GEOMETRY(LINESTRING, srid)', postgresql_to_mysql: 'LINESTRING', compatibility: 'extension', condition: 'Requires PostGIS; preserve SRID.' },
  polygon: { mysql: 'POLYGON', postgresql: 'GEOMETRY(POLYGON, srid)', postgresql_to_mysql: 'POLYGON', compatibility: 'extension', condition: 'Requires PostGIS; preserve SRID.' },
  multipoint: { mysql: 'MULTIPOINT', postgresql: 'GEOMETRY(MULTIPOINT, srid)', postgresql_to_mysql: 'MULTIPOINT', compatibility: 'extension', condition: 'Requires PostGIS; preserve SRID.' },
  multilinestring: { mysql: 'MULTILINESTRING', postgresql: 'GEOMETRY(MULTILINESTRING, srid)', postgresql_to_mysql: 'MULTILINESTRING', compatibility: 'extension', condition: 'Requires PostGIS; preserve SRID.' },
  multipolygon: { mysql: 'MULTIPOLYGON', postgresql: 'GEOMETRY(MULTIPOLYGON, srid)', postgresql_to_mysql: 'MULTIPOLYGON', compatibility: 'extension', condition: 'Requires PostGIS; preserve SRID.' },
  geometrycollection: { mysql: 'GEOMETRYCOLLECTION', postgresql: 'GEOMETRY(GEOMETRYCOLLECTION, srid)', postgresql_to_mysql: 'GEOMETRYCOLLECTION', compatibility: 'extension', condition: 'Requires PostGIS; preserve SRID.' },
});

function clean(input) {
  return String(input || '').toLowerCase().replace(/`|"/g, '').replace(/\s+/g, ' ').trim();
}

function parseFirstParam(raw) {
  const match = clean(raw).match(/\((\d+)/);
  return match ? Number(match[1]) : null;
}

function parsePrecisionScale(raw) {
  const match = clean(raw).match(/\((\d+)\s*,\s*(\d+)\)/);
  return match ? { precision: Number(match[1]), scale: Number(match[2]) } : { precision: null, scale: null };
}

function formatWithOptionalPrecision(base, precision) {
  return precision == null ? base : `${base}(${precision})`;
}

function formatNumeric(precision, scale) {
  return precision == null || scale == null ? 'numeric' : `numeric(${precision},${scale})`;
}

function inferMysqlTypeKey(column = {}) {
  const dataType = clean(column.dataType || column.DATA_TYPE || '');
  const fullType = clean(column.fullType || column.columnType || dataType);
  const unsigned = /\bunsigned\b/.test(fullType);
  const fsp = parseFirstParam(fullType);

  if (/tinyint\s*\(\s*1\s*\)/.test(fullType) || dataType === 'boolean' || dataType === 'bool') return 'boolean';
  if (dataType === 'bit') return 'bit';
  if (dataType === 'tinyint') return unsigned ? 'tinyint_unsigned' : 'tinyint';
  if (dataType === 'smallint') return unsigned ? 'smallint_unsigned' : 'smallint';
  if (dataType === 'mediumint') return unsigned ? 'mediumint_unsigned' : 'mediumint';
  if (['int', 'integer'].includes(dataType)) return unsigned ? 'int_unsigned' : 'int';
  if (dataType === 'bigint') return unsigned ? 'bigint_unsigned' : 'bigint';
  if (dataType === 'decimal') return unsigned ? 'decimal_unsigned' : 'decimal';
  if (dataType === 'numeric') return 'numeric';
  if (dataType === 'float') return fsp == null ? 'float' : 'float_precision';
  if (['double', 'double precision'].includes(dataType)) return 'double';
  if (dataType === 'real') return 'real';
  if (dataType === 'date') return 'date';
  if (dataType === 'datetime') return fsp == null ? 'datetime' : 'datetime_fsp';
  if (dataType === 'timestamp') return fsp == null ? 'timestamp' : 'timestamp_fsp';
  if (dataType === 'time') return 'time_clock';
  if (dataType === 'year') return 'year';
  if (dataType === 'char') return 'char';
  if (dataType === 'varchar') return 'varchar';
  if (['tinytext', 'text', 'mediumtext', 'longtext'].includes(dataType)) return dataType;
  if (dataType === 'binary') return 'binary';
  if (dataType === 'varbinary') return 'varbinary';
  if (['tinyblob', 'blob', 'mediumblob', 'longblob'].includes(dataType)) return dataType;
  if (dataType === 'json') return 'json';
  if (dataType === 'enum') return 'enum';
  if (dataType === 'set') return 'set';
  if (['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection'].includes(dataType)) return dataType;
  return null;
}

function mapMysqlColumnToPostgres(column = {}) {
  const key = inferMysqlTypeKey(column);
  const fullType = clean(column.fullType || column.columnType || column.dataType || '');
  const entry = key ? TOP_50_MYSQL_POSTGRESQL_BIDIRECTIONAL_TYPES[key] : null;
  const length = parseFirstParam(fullType);
  const { precision, scale } = parsePrecisionScale(fullType);
  let pgType = 'text';
  let checkRecommendation = null;

  switch (key) {
    case 'boolean': pgType = 'boolean'; break;
    case 'bit': pgType = formatWithOptionalPrecision('bit', length); break;
    case 'tinyint': pgType = 'smallint'; checkRecommendation = 'CHECK (value BETWEEN -128 AND 127)'; break;
    case 'tinyint_unsigned': pgType = 'smallint'; checkRecommendation = 'CHECK (value BETWEEN 0 AND 255)'; break;
    case 'smallint': pgType = 'smallint'; break;
    case 'smallint_unsigned': pgType = 'integer'; checkRecommendation = 'CHECK (value BETWEEN 0 AND 65535)'; break;
    case 'mediumint': pgType = 'integer'; checkRecommendation = 'CHECK (value BETWEEN -8388608 AND 8388607)'; break;
    case 'mediumint_unsigned': pgType = 'integer'; checkRecommendation = 'CHECK (value BETWEEN 0 AND 16777215)'; break;
    case 'int': pgType = 'integer'; break;
    case 'int_unsigned': pgType = 'bigint'; checkRecommendation = 'CHECK (value BETWEEN 0 AND 4294967295)'; break;
    case 'bigint': pgType = 'bigint'; break;
    case 'bigint_unsigned': pgType = 'numeric(20,0)'; checkRecommendation = 'CHECK (value BETWEEN 0 AND 18446744073709551615)'; break;
    case 'decimal':
    case 'numeric': pgType = formatNumeric(precision, scale); break;
    case 'decimal_unsigned': pgType = formatNumeric(precision, scale); checkRecommendation = 'CHECK (value >= 0)'; break;
    case 'float': pgType = 'real'; break;
    case 'float_precision': pgType = length != null && length > 24 ? 'double precision' : 'real'; break;
    case 'double':
    case 'real': pgType = 'double precision'; break;
    case 'date': pgType = 'date'; break;
    case 'datetime': pgType = 'timestamp without time zone'; break;
    case 'datetime_fsp': pgType = `${formatWithOptionalPrecision('timestamp', length)} without time zone`; break;
    case 'timestamp': pgType = 'timestamp with time zone'; break;
    case 'timestamp_fsp': pgType = `${formatWithOptionalPrecision('timestamp', length)} with time zone`; break;
    case 'time_clock': pgType = 'time without time zone'; break;
    case 'year': pgType = 'smallint'; checkRecommendation = 'CHECK (value BETWEEN 1901 AND 2155)'; break;
    case 'char': pgType = formatWithOptionalPrecision('char', length); break;
    case 'varchar': pgType = formatWithOptionalPrecision('varchar', length); break;
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext': pgType = 'text'; break;
    case 'binary':
    case 'varbinary':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob': pgType = 'bytea'; break;
    case 'json': pgType = 'jsonb'; break;
    case 'enum': pgType = 'text'; break;
    case 'set': pgType = 'text[]'; break;
    case 'geometry': pgType = 'geometry'; break;
    case 'point': pgType = 'geometry(point)'; break;
    case 'linestring': pgType = 'geometry(linestring)'; break;
    case 'polygon': pgType = 'geometry(polygon)'; break;
    case 'multipoint': pgType = 'geometry(multipoint)'; break;
    case 'multilinestring': pgType = 'geometry(multilinestring)'; break;
    case 'multipolygon': pgType = 'geometry(multipolygon)'; break;
    case 'geometrycollection': pgType = 'geometry(geometrycollection)'; break;
    default: pgType = 'text'; break;
  }

  return {
    name: column.name,
    sourceType: column.fullType || column.dataType || null,
    sourceTypeKey: key || 'unknown',
    pgType,
    nullable: column.nullable !== false,
    identity: Boolean(column.autoIncrement),
    generated: Boolean(column.generated),
    compatibilityClass: entry?.compatibility || 'conditional',
    compatibilityCondition: entry?.condition || 'Unknown/source-specific type; review manually.',
    checkRecommendation,
  };
}

function parsePostgresType(input) {
  const raw = clean(input);
  const length = parseFirstParam(raw);
  const { precision, scale } = parsePrecisionScale(raw);

  if (!raw) return { family: '', raw, length, precision, scale };
  if (/^character varying|^varchar/.test(raw)) return { family: 'varchar', raw, length, precision, scale };
  if (/^character\b|^char\b/.test(raw)) return { family: 'char', raw, length, precision, scale };
  if (['integer', 'int', 'int4'].includes(raw)) return { family: 'integer', raw, length, precision, scale };
  if (['bigint', 'int8'].includes(raw)) return { family: 'bigint', raw, length, precision, scale };
  if (['smallint', 'int2'].includes(raw)) return { family: 'smallint', raw, length, precision, scale };
  if (/^numeric|^decimal/.test(raw)) return { family: 'numeric', raw, length, precision, scale };
  if (['real', 'float4'].includes(raw)) return { family: 'real', raw, length, precision, scale };
  if (raw === 'double precision' || raw === 'float8') return { family: 'double precision', raw, length, precision, scale };
  if (['boolean', 'bool'].includes(raw)) return { family: 'boolean', raw, length, precision, scale };
  if (/^timestamp/.test(raw) && /with time zone|timestamptz/.test(raw)) return { family: 'timestamptz', raw, length, precision, scale };
  if (raw === 'timestamptz') return { family: 'timestamptz', raw, length, precision, scale };
  if (/^timestamp/.test(raw)) return { family: 'timestamp', raw, length, precision, scale };
  if (/^time/.test(raw)) return { family: 'time', raw, length, precision, scale };
  if (raw === 'interval') return { family: 'interval', raw, length, precision, scale };
  if (raw === 'date') return { family: 'date', raw, length, precision, scale };
  if (/^bit/.test(raw)) return { family: 'bit', raw, length, precision, scale };
  if (raw === 'text') return { family: 'text', raw, length, precision, scale };
  if (raw === 'bytea') return { family: 'bytea', raw, length, precision, scale };
  if (raw === 'json' || raw === 'jsonb') return { family: raw, raw, length, precision, scale };
  if (raw === 'text[]' || raw === '_text') return { family: 'text[]', raw, length, precision, scale };
  if (/^geometry/.test(raw)) return { family: 'geometry', raw, length, precision, scale };
  return { family: raw, raw, length, precision, scale };
}

function integerRank(family) {
  return { smallint: 1, integer: 2, bigint: 3, numeric: 4 }[family] || 0;
}

function precisionCompatible(expected, target) {
  if (expected.precision == null || expected.scale == null) return target.family === 'numeric';
  if (target.precision == null || target.scale == null) return target.family === 'numeric';
  return target.precision >= expected.precision && target.scale >= expected.scale;
}

function postgresTypeCanStore(expectedType, targetType) {
  const expected = parsePostgresType(expectedType);
  const target = parsePostgresType(targetType);
  const reviewReasons = [];
  if (!target.family) return { ok: false, reviewReasons, expected, target };

  if (expected.family === target.family) {
    if (['varchar', 'char', 'bit'].includes(expected.family) && expected.length != null && target.length != null && target.length < expected.length) {
      return { ok: false, reviewReasons, expected, target };
    }
    if (expected.family === 'numeric' && !precisionCompatible(expected, target)) {
      return { ok: false, reviewReasons, expected, target };
    }
    return { ok: true, reviewReasons, expected, target };
  }

  if (integerRank(expected.family) && integerRank(target.family) >= integerRank(expected.family)) {
    if (target.family !== expected.family) reviewReasons.push('target_integer_type_is_wider_than_source_mapping');
    return { ok: true, reviewReasons, expected, target };
  }
  if (expected.family === 'varchar' && target.family === 'text') {
    reviewReasons.push('target_text_is_value_safe_but_not_strict_round_trip_varchar');
    return { ok: true, reviewReasons, expected, target };
  }
  if (expected.family === 'char' && ['varchar', 'text'].includes(target.family)) {
    reviewReasons.push('char_trailing_space_semantics_review');
    return { ok: true, reviewReasons, expected, target };
  }
  if (expected.family === 'jsonb' && target.family === 'json') {
    reviewReasons.push('postgres_json_preserves_text_more_than_jsonb_but_indexing_differs');
    return { ok: true, reviewReasons, expected, target };
  }
  if (expected.family === 'timestamp' && target.family === 'timestamptz') {
    reviewReasons.push('datetime_to_timestamptz_changes_timezone_semantics');
    return { ok: true, reviewReasons, expected, target };
  }
  if (expected.family === 'timestamptz' && target.family === 'timestamp') {
    reviewReasons.push('timestamp_instant_loaded_into_timezone_neutral_column');
    return { ok: true, reviewReasons, expected, target };
  }
  if (expected.family === 'real' && target.family === 'double precision') {
    reviewReasons.push('target_float_type_is_wider_than_source_mapping');
    return { ok: true, reviewReasons, expected, target };
  }
  return { ok: false, reviewReasons, expected, target };
}

function compareMysqlToPostgresColumn(sourceColumn = {}, targetColumn = {}) {
  const proposed = mapMysqlColumnToPostgres(sourceColumn);
  const targetType = targetColumn?.fullType || targetColumn?.dataType || '';
  const typeCheck = postgresTypeCanStore(proposed.pgType, targetType);
  const nullableCompatible = targetColumn?.nullable !== false || proposed.nullable === false;
  const reviewReasons = [...typeCheck.reviewReasons];
  if (proposed.compatibilityClass !== 'direct' && proposed.compatibilityCondition) {
    reviewReasons.push(proposed.compatibilityCondition);
  }
  if (proposed.checkRecommendation) {
    reviewReasons.push(`Optional strict round-trip constraint: ${proposed.checkRecommendation}`);
  }

  return {
    compatible: typeCheck.ok && nullableCompatible,
    compatibleType: typeCheck.ok,
    nullableCompatible,
    compatibilityClass: proposed.compatibilityClass,
    compatibilityCondition: proposed.compatibilityCondition,
    reviewReasons,
    sourceTypeKey: proposed.sourceTypeKey,
    proposedType: proposed.pgType,
    targetType: targetType || null,
    normalizedSourceType: typeCheck.expected.raw,
    normalizedTargetType: typeCheck.target.raw,
    sourceNullable: proposed.nullable,
    targetNullable: targetColumn?.nullable ?? null,
    checkRecommendation: proposed.checkRecommendation,
  };
}

function classifyTypeCompatibility(sourceColumn, targetColumn) {
  if (!targetColumn || !(targetColumn.fullType || targetColumn.dataType)) return { status: 'blocker', message: 'missing_target_column' };
  const comparison = compareMysqlToPostgresColumn(sourceColumn, targetColumn);
  if (!comparison.compatible) {
    return { status: 'incompatible', message: `source ${comparison.proposedType} -> target ${comparison.targetType}`, comparison };
  }
  if (comparison.compatibilityClass === 'direct' && !comparison.reviewReasons.length) {
    return { status: 'compatible', message: 'direct_type', comparison };
  }
  return {
    status: 'risky',
    message: `${comparison.compatibilityClass || 'review'}: ${(comparison.reviewReasons || []).join(' • ') || comparison.compatibilityCondition || 'review recommended'}`,
    comparison,
  };
}

module.exports = {
  TOP_50_MYSQL_POSTGRESQL_BIDIRECTIONAL_TYPES,
  inferMysqlTypeKey,
  mapMysqlColumnToPostgres,
  compareMysqlToPostgresColumn,
  classifyTypeCompatibility,
  parsePostgresType,
};