import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { assertStrictSubset, toStrictJsonSchema } from '../../lib/meta/strict-schema';

type SchemaNode = Record<string, unknown>;

function isPlainObject(v: unknown): v is SchemaNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Collect every object node (properties-carrying) in the schema tree.
function objectNodes(node: unknown, out: SchemaNode[] = []): SchemaNode[] {
  if (Array.isArray(node)) {
    node.forEach((child) => objectNodes(child, out));
    return out;
  }
  if (!isPlainObject(node)) return out;
  if ('properties' in node) out.push(node);
  for (const value of Object.values(node)) {
    if (isPlainObject(value) || Array.isArray(value)) objectNodes(value, out);
  }
  return out;
}

// The shape pipeline callers will send: nested objects, arrays of objects,
// nullable fields, optional fields, enums.
const Realistic = z.object({
  title: z.string(),
  due_local: z.string().nullable(),
  kind: z.enum(['assignment', 'test', 'reading']),
  confidence: z.number().min(0).max(1),
  items: z.array(
    z.object({
      text: z.string(),
      page: z.number().int().nullable(),
      done: z.boolean().optional(),
    }),
  ),
  meta: z.object({
    note: z.string().optional(),
    flag: z.boolean(),
  }),
});

describe('toStrictJsonSchema', () => {
  test('output of a realistic schema passes assertStrictSubset', () => {
    const out = toStrictJsonSchema(Realistic);
    expect(() => assertStrictSubset(out)).not.toThrow();
  });

  test('strips $schema and forces additionalProperties:false plus full required everywhere', () => {
    const out = toStrictJsonSchema(Realistic);
    expect('$schema' in out).toBe(false);
    for (const node of objectNodes(out)) {
      expect(node.additionalProperties).toBe(false);
      const props = Object.keys(node.properties as SchemaNode);
      expect(node.required).toEqual(props);
    }
  });

  test('zod .optional() properties become nullable and required', () => {
    const out = toStrictJsonSchema(Realistic) as {
      properties: { meta: { properties: { note: SchemaNode }; required: string[] } };
    };
    const note = out.properties.meta.properties.note;
    const types = Array.isArray(note.type) ? note.type : [note.type];
    expect(types).toContain('null');
    expect(out.properties.meta.required).toContain('note');
  });

  test('zod .nullable() properties keep null and are required', () => {
    const out = toStrictJsonSchema(Realistic) as {
      properties: { due_local: SchemaNode; items: { items: { properties: { page: SchemaNode } } } };
      required: string[];
    };
    expect(JSON.stringify(out.properties.due_local)).toContain('null');
    expect(out.required).toContain('due_local');
    expect(JSON.stringify(out.properties.items.items.properties.page)).toContain('null');
  });

  test('keeps enum and array-of-object structure', () => {
    const out = toStrictJsonSchema(Realistic) as {
      properties: {
        kind: { type: string; enum: string[] };
        items: { type: string; items: SchemaNode };
      };
    };
    expect(out.properties.kind.enum).toEqual(['assignment', 'test', 'reading']);
    expect(out.properties.items.type).toBe('array');
    expect('properties' in out.properties.items.items).toBe(true);
  });
});

describe('assertStrictSubset', () => {
  const goodLeaf = { type: 'string' };

  function nest(depth: number): SchemaNode {
    let node: SchemaNode = {
      type: 'object',
      additionalProperties: false,
      properties: { leaf: goodLeaf },
      required: ['leaf'],
    };
    for (let i = 1; i < depth; i++) {
      node = {
        type: 'object',
        additionalProperties: false,
        properties: { child: node },
        required: ['child'],
      };
    }
    return node;
  }

  test('accepts a good schema, including anyOf below the root', () => {
    expect(() =>
      assertStrictSubset({
        type: 'object',
        additionalProperties: false,
        properties: {
          p: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['p'],
      }),
    ).not.toThrow();
  });

  test('rejects a non-object root', () => {
    expect(() => assertStrictSubset('nope')).toThrow(/plain object/);
    expect(() => assertStrictSubset([1, 2])).toThrow(/plain object/);
    expect(() => assertStrictSubset({ type: 'string' })).toThrow(/type "object"/);
  });

  test('rejects anyOf at the root', () => {
    expect(() =>
      assertStrictSubset({ anyOf: [{ type: 'object', additionalProperties: false, properties: {}, required: [] }] }),
    ).toThrow(/\$: root must be a plain object; "anyOf"/);
  });

  test('rejects missing additionalProperties:false', () => {
    expect(() =>
      assertStrictSubset({ type: 'object', properties: { a: goodLeaf }, required: ['a'] }),
    ).toThrow(/additionalProperties/);
  });

  test('rejects a property missing from required', () => {
    expect(() =>
      assertStrictSubset({
        type: 'object',
        additionalProperties: false,
        properties: { a: goodLeaf, b: goodLeaf },
        required: ['a'],
      }),
    ).toThrow(/\$\.b: property is not listed in "required"/);
  });

  test('rejects allOf and oneOf anywhere', () => {
    const withAllOf = {
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          allOf: [{ type: 'object', properties: {}, required: [] }],
          properties: {},
          required: [],
        },
      },
      required: ['nested'],
    };
    expect(() => assertStrictSubset(withAllOf)).toThrow(/\$\.nested.*"allOf"/);
    const withOneOf = {
      type: 'object',
      additionalProperties: false,
      properties: { p: { oneOf: [goodLeaf, { type: 'null' }] } },
      required: ['p'],
    };
    expect(() => assertStrictSubset(withOneOf)).toThrow(/"oneOf"/);
  });

  test('rejects recursive $ref cycles', () => {
    const recursive = {
      $defs: {
        node: {
          type: 'object',
          additionalProperties: false,
          properties: { child: { $ref: '#/$defs/node' } },
          required: ['child'],
        },
      },
      type: 'object',
      additionalProperties: false,
      properties: { root: { $ref: '#/$defs/node' } },
      required: ['root'],
    };
    expect(() => assertStrictSubset(recursive)).toThrow(/recursive \$ref/);
  });

  test('rejects nesting deeper than 10 but accepts exactly 10', () => {
    expect(() => assertStrictSubset(nest(10))).not.toThrow();
    expect(() => assertStrictSubset(nest(11))).toThrow(/depth 11 exceeds/);
  });

  test('lists every violation with paths in one error', () => {
    try {
      assertStrictSubset({
        type: 'object',
        properties: { a: { type: 'object', properties: { x: goodLeaf }, required: [] } },
        required: ['a'],
      });
      throw new Error('expected assertStrictSubset to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('additionalProperties');
      expect(message).toContain('$.a.x');
    }
  });
});
