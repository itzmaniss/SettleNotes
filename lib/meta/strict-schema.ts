import { z } from 'zod';

// Meta Model API structured output only accepts a strict JSON Schema subset
// (docs/meta-api/structured-output.md "Enforce strict mode"): root is a plain
// object, every object has additionalProperties:false, `required` lists EVERY
// key, no allOf/oneOf anywhere, anyOf only below the root, no recursive $ref
// cycles, max nesting depth 10.
//
// Card schemas should express optionality with .nullable(), not .optional():
// both are made required on the wire, but .optional() forces us to widen the
// property to a nullable variant here.

const MAX_DEPTH = 10;

type SchemaNode = Record<string, unknown>;

function isPlainObject(v: unknown): v is SchemaNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Widen a schema node so null becomes a valid value. Uses the same shapes zod
// itself emits for .nullable(): a "type" array, or anyOf with {type:'null'}
// when the node is already compound (anyOf is legal below the root).
function makeNullable(node: SchemaNode): SchemaNode {
  if (Array.isArray(node.type)) {
    if (node.type.includes('null')) return node;
    return { ...node, type: [...node.type, 'null'] };
  }
  if (typeof node.type === 'string') {
    return { ...node, type: [node.type, 'null'] };
  }
  if (Array.isArray(node.anyOf)) {
    return { ...node, anyOf: [...node.anyOf, { type: 'null' }] };
  }
  if ('enum' in node || 'const' in node) {
    const variant: SchemaNode = { ...node };
    const wrapper: SchemaNode = { ...node };
    delete wrapper.enum;
    delete wrapper.const;
    wrapper.anyOf = [variant, { type: 'null' }];
    return wrapper;
  }
  return { anyOf: [node, { type: 'null' }] };
}

// Recursively convert a zod-generated JSON Schema into the strict subset:
// strip $schema, force additionalProperties:false on every object, list every
// property in `required`, and turn previously-optional properties nullable.
function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!isPlainObject(node)) return node;

  const out: SchemaNode = { ...node };
  delete out.$schema;

  const originalRequired = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);

  if (isPlainObject(out.properties)) {
    const props = out.properties as Record<string, unknown>;
    const converted: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      let convertedProp = strictify(propSchema);
      if (!originalRequired.has(key) && isPlainObject(convertedProp)) {
        convertedProp = makeNullable(convertedProp);
      }
      converted[key] = convertedProp;
    }
    out.properties = converted;
    out.required = Object.keys(converted);
    // Records (z.record) emit additionalProperties as a schema instead of
    // properties; leave those alone, assertStrictSubset will reject them.
    if (out.additionalProperties === undefined || out.additionalProperties === true) {
      out.additionalProperties = false;
    }
  }

  for (const key of ['items', 'not', 'if', 'then', 'else', 'contains', 'propertyNames'] as const) {
    if (key in out) out[key] = strictify(out[key]);
  }
  for (const key of ['prefixItems', 'anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(strictify);
  }
  for (const key of ['$defs', 'definitions'] as const) {
    if (isPlainObject(out[key])) {
      const defs = out[key] as Record<string, unknown>;
      const convertedDefs: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(defs)) convertedDefs[name] = strictify(def);
      out[key] = convertedDefs;
    }
  }

  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema);
  return strictify(raw) as Record<string, unknown>;
}

function isComposite(node: SchemaNode): boolean {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  return types.includes('object') || types.includes('array') || 'properties' in node;
}

function resolveRef(root: SchemaNode, ref: string): SchemaNode | null {
  if (!ref.startsWith('#/')) return null;
  let target: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!isPlainObject(target)) return null;
    target = (target as Record<string, unknown>)[segment];
  }
  return isPlainObject(target) ? target : null;
}

// Walks the schema and collects one violation message (with JSON path) per
// broken rule. Follows $refs into $defs with cycle detection so recursive
// schemas are caught instead of looping forever.
export function assertStrictSubset(jsonSchema: unknown): void {
  const violations: string[] = [];

  if (!isPlainObject(jsonSchema)) {
    throw new Error('Schema violates the strict subset:\n- $: root must be a plain object schema');
  }
  const root: SchemaNode = jsonSchema;

  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'enum', 'not'] as const) {
    if (keyword in root) {
      violations.push(`$: root must be a plain object; "${keyword}" is not allowed at the root`);
    }
  }
  const rootTypes = Array.isArray(root.type) ? root.type : [root.type];
  if (!rootTypes.includes('object')) {
    violations.push('$: root must be an object schema (type "object")');
  }

  const seen = new Set<string>();

  function walk(node: unknown, path: string, depth: number, activeRefs: ReadonlySet<string>): void {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`, depth, activeRefs));
      return;
    }
    if (!isPlainObject(node)) return;

    const fingerprint = `${path}\u0000${JSON.stringify(node)}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (activeRefs.has(ref)) {
        violations.push(`${path}: recursive $ref "${ref}" is not supported`);
        return;
      }
      const target = resolveRef(root, ref);
      if (target) {
        const nextRefs = new Set(activeRefs);
        nextRefs.add(ref);
        walk(target, `${path} > ${ref}`, depth, nextRefs);
      }
      return;
    }

    for (const keyword of ['allOf', 'oneOf'] as const) {
      if (Array.isArray(node[keyword])) {
        violations.push(`${path}: "${keyword}" is not supported anywhere in the schema`);
      }
    }

    if (isComposite(node)) {
      if (depth > MAX_DEPTH) {
        violations.push(`${path}: nesting depth ${depth} exceeds the maximum of ${MAX_DEPTH}`);
      }
      if ('properties' in node) {
        if (node.additionalProperties !== false) {
          violations.push(`${path}: object must set "additionalProperties": false`);
        }
        const props = (node.properties ?? {}) as Record<string, unknown>;
        const required = Array.isArray(node.required) ? (node.required as string[]) : [];
        for (const key of Object.keys(props)) {
          if (!required.includes(key)) {
            violations.push(`${path}.${key}: property is not listed in "required"`);
          }
        }
        for (const [key, child] of Object.entries(props)) {
          walk(child, `${path}.${key}`, depth + 1, activeRefs);
        }
      } else if (node.type === 'array' || (Array.isArray(node.type) && node.type.includes('array'))) {
        if ('items' in node) walk(node.items, `${path}[*]`, depth + 1, activeRefs);
        if (Array.isArray(node.prefixItems)) {
          (node.prefixItems as unknown[]).forEach((child, i) => walk(child, `${path}[${i}]`, depth + 1, activeRefs));
        }
      }
    }

    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      if (Array.isArray(node[keyword])) {
        (node[keyword] as unknown[]).forEach((child, i) => walk(child, `${path}.${keyword}[${i}]`, depth, activeRefs));
      }
    }
    if ('not' in node) walk(node.not, `${path}.not`, depth, activeRefs);
    for (const key of ['$defs', 'definitions'] as const) {
      if (isPlainObject(node[key])) {
        for (const [name, def] of Object.entries(node[key] as Record<string, unknown>)) {
          walk(def, `${key}.${name}`, depth, activeRefs);
        }
      }
    }
  }

  walk(root, '$', 1, new Set<string>());

  if (violations.length > 0) {
    const unique = [...new Set(violations)];
    throw new Error(`Schema violates the strict subset:\n${unique.map((v) => `- ${v}`).join('\n')}`);
  }
}
