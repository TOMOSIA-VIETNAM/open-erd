// Generic walker over the spec nodes in schema.js. Returns errors instead of
// throwing so one run reports every problem in a file.

const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function joinPath(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  const segment = SIMPLE_KEY.test(key) ? key : JSON.stringify(key);
  if (!path) return segment;
  return SIMPLE_KEY.test(key) ? `${path}.${key}` : `${path}[${segment}]`;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => Number.isInteger(v),
  array: Array.isArray,
  object: isPlainObject,
  map: isPlainObject,
};

export function validateNode(value, spec, path = '', errors = []) {
  const at = path || '(root)';
  if (!TYPE_CHECKS[spec.type](value)) {
    const expected = spec.type === 'map' ? 'mapping' : spec.type;
    errors.push({ path: at, message: `must be ${expected}, got ${describe(value)}` });
    return errors;
  }
  if (spec.oneOf && !spec.oneOf.includes(value)) {
    errors.push({ path: at, message: `must be one of ${spec.oneOf.join(' | ')}, got ${JSON.stringify(value)}` });
  }
  if (spec.pattern && !spec.pattern.test(value)) {
    errors.push({ path: at, message: `invalid value ${JSON.stringify(value)}, expected ${spec.hint}` });
  }
  if (spec.type === 'array') {
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      errors.push({ path: at, message: `must have at least ${spec.minItems} item(s)` });
    }
    value.forEach((item, i) => validateNode(item, spec.items, joinPath(path, i), errors));
  }
  if (spec.type === 'map') {
    for (const [key, item] of Object.entries(value)) {
      validateNode(item, spec.values, joinPath(path, key), errors);
    }
  }
  if (spec.type === 'object') {
    for (const [key, fieldSpec] of Object.entries(spec.fields)) {
      if (value[key] === undefined) {
        if (fieldSpec.required) errors.push({ path: joinPath(path, key), message: 'is required' });
      } else {
        validateNode(value[key], fieldSpec, joinPath(path, key), errors);
      }
    }
    for (const key of Object.keys(value)) {
      if (!(key in spec.fields)) errors.push({ path: joinPath(path, key), message: 'unknown field' });
    }
  }
  return errors;
}
