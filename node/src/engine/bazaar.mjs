import { Json } from './settlement/json.mjs'

export const DRAFT = 'https://json-schema.org/draft/2020-12/schema'
export const EXTENSION_LIMIT = 4096
export const HEADER_LIMIT = 12288
export const ANY_RESULT = { description: 'the tool result as JSON' }
const DEPTH = 8

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isCount = (v) => Number.isInteger(v) && v > 0

export function example(schema, depth = 0) {
  if (!isObject(schema) || depth > DEPTH) return null
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0]
  if (Object.hasOwn(schema, 'default')) return schema.default
  if (Object.hasOwn(schema, 'const')) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  let type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== 'null') ?? 'null') : schema.type
  if (type === undefined && isObject(schema.properties)) type = 'object'
  switch (type) {
    case 'object': {
      const props = isObject(schema.properties) ? schema.properties : {}
      const out = {}
      for (const k of Array.isArray(schema.required) ? schema.required : []) if (typeof k === 'string') out[k] = example(props[k], depth + 1)
      return out
    }
    case 'array': return Array.from({ length: isCount(schema.minItems) ? Math.min(schema.minItems, DEPTH) : 0 }, () => example(schema.items, depth + 1))
    case 'string': return 'x'.repeat(isCount(schema.minLength) ? Math.min(schema.minLength, 64) : 0)
    case 'integer': return isNumber(schema.minimum) ? Math.ceil(schema.minimum) : isNumber(schema.exclusiveMinimum) ? Math.floor(schema.exclusiveMinimum) + 1 : 0
    case 'number': return isNumber(schema.minimum) ? schema.minimum : isNumber(schema.exclusiveMinimum) ? schema.exclusiveMinimum + 1 : 0
    case 'boolean': return false
    default: return null
  }
}

const output = (outputSchema) => ({
  type: 'object',
  properties: { type: { type: 'string' }, example: isObject(outputSchema) ? { type: 'object', ...outputSchema } : ANY_RESULT },
  required: ['type'],
})

export function bazaar(tool, via = 'http') {
  if (!isObject(tool) || !isObject(tool.inputSchema)) return null
  const input = via === 'mcp'
    ? {
        info: { type: 'mcp', toolName: String(tool.name ?? ''), transport: 'streamable-http', inputSchema: tool.inputSchema },
        schema: {
          type: 'object',
          properties: { type: { type: 'string', const: 'mcp' }, toolName: { type: 'string' }, transport: { type: 'string', enum: ['streamable-http'] }, inputSchema: { type: 'object' } },
          required: ['type', 'toolName', 'inputSchema'],
          additionalProperties: false,
        },
      }
    : {
        info: { type: 'http', method: 'POST', bodyType: 'json', body: example(tool.inputSchema) },
        schema: {
          type: 'object',
          properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['POST'] }, bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] }, body: tool.inputSchema },
          required: ['type', 'method', 'bodyType', 'body'],
          additionalProperties: false,
        },
      }
  return {
    bazaar: {
      info: { input: input.info, output: { type: 'json' } },
      schema: { $schema: DRAFT, type: 'object', properties: { input: input.schema, output: output(tool.outputSchema) }, required: ['input'] },
    },
  }
}

const bytes = (v) => Buffer.byteLength(Json.encode(v), 'utf8')

export function forHeader(doc, size = (d) => Json.base64(d).length) {
  const ext = isObject(doc?.extensions) ? doc.extensions : null
  if (!ext || !Object.hasOwn(ext, 'bazaar')) return doc
  if (bytes(ext.bazaar) <= EXTENSION_LIMIT && size(doc) <= HEADER_LIMIT) return doc
  const { bazaar: _dropped, ...rest } = ext
  const out = { ...doc, extensions: rest }
  if (!Object.keys(rest).length) delete out.extensions
  return out
}
