#!/usr/bin/env node
/**
 * Local Jira DC helpers for Cursor:
 * - list / get Tempo Structure metadata
 * - read forest (hierarchy) for a structureId
 * - load Structure attribute values (key, summary, status, …)
 * - convenience board dump as nested tree (+ optional file)
 *
 * Auth/host: same as @atlassian-dc-mcp/jira (proxy localhost:8444 + keychain token).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENV_FILE = join(homedir(), '.atlassian-dc-mcp', 'jira.env');
const KEYCHAIN_SERVICE = 'atlassian-dc-mcp';
const KEYCHAIN_ACCOUNT = 'jira-token';

const DEFAULT_ATTRIBUTES = [
  { id: 'key', format: 'text' },
  { id: 'summary', format: 'text' },
  { id: 'status', format: 'text' },
  { id: 'issuetype', format: 'text' },
];

/** Max rows per /value request (Structure can be heavy on large forests). */
const VALUE_BATCH_SIZE = 400;

const GENERATOR_TYPE_SUFFIX = ':type-generator';
const LOOP_MARKER_TYPE_SUFFIX = ':type-loop-marker';

function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function resolveHost() {
  const fromEnv = process.env.JIRA_HOST?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const fromFile = loadEnvFile().JIRA_HOST?.trim();
  if (fromFile) return fromFile.replace(/\/$/, '');
  throw new Error('JIRA_HOST is not set (env or ~/.atlassian-dc-mcp/jira.env)');
}

function resolveToken() {
  if (process.env.JIRA_API_TOKEN?.trim()) {
    return process.env.JIRA_API_TOKEN.trim();
  }
  const fromFile = loadEnvFile().JIRA_API_TOKEN?.trim();
  if (fromFile) return fromFile;
  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { encoding: 'utf8', timeout: 5000 },
      ).trim();
    } catch {
      // fall through
    }
  }
  throw new Error(
    'JIRA_API_TOKEN is not set (env, jira.env, or macOS keychain atlassian-dc-mcp/jira-token)',
  );
}

async function jiraApi(method, path, body) {
  const host = resolveHost();
  const token = resolveToken();
  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' && (data?.message || data?.errorMessages || data?.error)
        ? data.message ||
          (Array.isArray(data.errorMessages) ? data.errorMessages.join('; ') : data.errorMessages) ||
          data.error
        : text.slice(0, 500);
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

function forestSpecFromArgs({ structureId, forestSpec }) {
  if (forestSpec && typeof forestSpec === 'object') {
    return forestSpec;
  }
  if (structureId == null) {
    throw new Error('Provide structureId or forestSpec');
  }
  return { structureId: Number(structureId) };
}

/**
 * Parse Structure forest formula.
 * Each component: `rowId:depth:itemIdentity`
 * itemIdentity: issue id (`14707`) or typed (`5/240`, `4/356`, `type//string`).
 */
function parseForestFormula(formula, itemTypes = {}) {
  if (!formula || typeof formula !== 'string') return [];
  const rows = [];
  for (const part of formula.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(-?\d+):(\d+):(.+)$/);
    if (!m) {
      rows.push({ raw: trimmed, parseError: true });
      continue;
    }
    const rowId = Number(m[1]);
    const depth = Number(m[2]);
    const itemRaw = m[3];
    const row = { rowId, depth, itemRaw };

    const typedSlash = itemRaw.match(/^(\d+)\/(\d+)$/);
    const typedString = itemRaw.match(/^(\d+)\/\/(.+)$/);
    const typedMixed = itemRaw.match(/^(\d+)\/(.+)$/);
    if (typedSlash) {
      const typeId = typedSlash[1];
      row.itemTypeId = typeId;
      row.itemType = itemTypes[typeId] || null;
      row.itemLongId = Number(typedSlash[2]);
    } else if (typedString) {
      const typeId = typedString[1];
      row.itemTypeId = typeId;
      row.itemType = itemTypes[typeId] || null;
      row.itemStringId = typedString[2];
    } else if (typedMixed && !/^\d+$/.test(itemRaw)) {
      const typeId = typedMixed[1];
      row.itemTypeId = typeId;
      row.itemType = itemTypes[typeId] || null;
      row.itemLongId = /^\d+$/.test(typedMixed[2]) ? Number(typedMixed[2]) : undefined;
      row.itemStringId = /^\d+$/.test(typedMixed[2]) ? undefined : typedMixed[2];
    } else if (/^\d+$/.test(itemRaw)) {
      row.issueId = Number(itemRaw);
      row.itemType = 'issue';
    } else {
      row.itemType = 'unknown';
    }

    rows.push(row);
  }
  return rows;
}

function isGeneratorOrLoop(row) {
  const t = row.itemType || '';
  return t.endsWith(GENERATOR_TYPE_SUFFIX) || t.endsWith(LOOP_MARKER_TYPE_SUFFIX);
}

function buildTree(rows, { includeGenerators = true } = {}) {
  const roots = [];
  const stack = []; // { node, depth }
  for (const row of rows) {
    if (!includeGenerators && isGeneratorOrLoop(row)) continue;
    if (row.parseError) continue;
    const node = { ...row, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= row.depth) {
      stack.pop();
    }
    if (!stack.length) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, depth: row.depth });
  }
  return roots;
}

function normalizeAttributes(attributes) {
  if (!attributes || !attributes.length) return DEFAULT_ATTRIBUTES.map((a) => ({ ...a }));
  return attributes.map((a) => {
    if (typeof a === 'string') return { id: a, format: 'text' };
    return {
      id: a.id,
      format: a.format || 'text',
      ...(a.params ? { params: a.params } : {}),
    };
  });
}

function attributeKey(attr) {
  return JSON.stringify({ id: attr.id, format: attr.format || 'text', params: attr.params || null });
}

/**
 * Flatten Structure /value response matrices into { [rowId]: { [attrId]: value } }.
 */
function mergeValueMatrices(responses, attributes) {
  const byRow = {};
  for (const resp of responses || []) {
    const rowIds = resp.rows || [];
    for (const block of resp.data || []) {
      const attr = block.attribute || {};
      const attrId = attr.id || attributeKey(attr);
      const values = block.values || [];
      for (let i = 0; i < rowIds.length; i++) {
        const rowId = rowIds[i];
        if (!byRow[rowId]) byRow[rowId] = {};
        byRow[rowId][attrId] = values[i] ?? null;
      }
    }
  }
  // Prefer short attr ids from request order when present
  for (const rowId of Object.keys(byRow)) {
    const vals = byRow[rowId];
    for (const attr of attributes) {
      if (vals[attr.id] === undefined) {
        const k = attributeKey(attr);
        if (vals[k] !== undefined) {
          vals[attr.id] = vals[k];
          delete vals[k];
        }
      }
    }
  }
  return byRow;
}

async function listStructures({ name, withOwner = false, withPermissions = false, archived = false, limit } = {}) {
  const qs = new URLSearchParams();
  if (name) qs.set('name', name);
  if (withOwner) qs.set('withOwner', 'true');
  if (withPermissions) qs.set('withPermissions', 'true');
  if (archived) qs.set('archived', 'true');
  if (limit != null) qs.set('limit', String(limit));
  const q = qs.toString();
  const data = await jiraApi('GET', `/rest/structure/2.0/structure${q ? `?${q}` : ''}`);
  const structures = data?.structures || data || [];
  return {
    count: Array.isArray(structures) ? structures.length : 0,
    structures,
  };
}

async function getStructure(structureId, { withOwner = true, withPermissions = false } = {}) {
  const qs = new URLSearchParams();
  if (withOwner) qs.set('withOwner', 'true');
  if (withPermissions) qs.set('withPermissions', 'true');
  const q = qs.toString();
  return jiraApi('GET', `/rest/structure/2.0/structure/${structureId}${q ? `?${q}` : ''}`);
}

async function getForestLatest(forestSpec) {
  return jiraApi('POST', '/rest/structure/2.0/forest/latest', forestSpec);
}

async function getAttributeValues({ forestSpec, rows, attributes }) {
  const attrs = normalizeAttributes(attributes);
  const allResponses = [];
  for (let i = 0; i < rows.length; i += VALUE_BATCH_SIZE) {
    const batch = rows.slice(i, i + VALUE_BATCH_SIZE);
    const data = await jiraApi('POST', '/rest/structure/2.0/value', {
      requests: [
        {
          forestSpec,
          rows: batch,
          attributes: attrs,
        },
      ],
    });
    allResponses.push(...(data?.responses || []));
  }
  return {
    attributes: attrs,
    byRow: mergeValueMatrices(allResponses, attrs),
    rawResponseCount: allResponses.length,
  };
}

function attachValuesToRows(rows, byRow) {
  return rows.map((r) => {
    if (r.parseError) return r;
    return {
      ...r,
      values: byRow[r.rowId] || {},
    };
  });
}

function attachValuesToTree(nodes, byRow) {
  return nodes.map((n) => ({
    ...n,
    values: byRow[n.rowId] || {},
    children: attachValuesToTree(n.children || [], byRow),
  }));
}

async function getBoard({
  structureId,
  forestSpec,
  attributes,
  includeGenerators = true,
  flat = false,
}) {
  const spec = forestSpecFromArgs({ structureId, forestSpec });
  const forest = await getForestLatest(spec);
  const itemTypes = forest.itemTypes || {};
  const rows = parseForestFormula(forest.formula, itemTypes);
  const filtered = includeGenerators ? rows : rows.filter((r) => !isGeneratorOrLoop(r));
  const rowIds = filtered.filter((r) => !r.parseError).map((r) => r.rowId);
  const attrs = normalizeAttributes(attributes);
  const { byRow } = await getAttributeValues({
    forestSpec: spec,
    rows: rowIds,
    attributes: attrs,
  });

  const meta = {
    structureId: spec.structureId ?? structureId ?? null,
    forestSpec: forest.spec || spec,
    version: forest.version,
    itemTypes,
    rowCount: filtered.length,
    attributes: attrs,
  };

  if (flat) {
    return {
      ...meta,
      rows: attachValuesToRows(filtered, byRow),
    };
  }

  const tree = attachValuesToTree(buildTree(filtered, { includeGenerators: true }), byRow);
  return {
    ...meta,
    tree,
  };
}

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function fail(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  };
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const attributeSchema = z.union([
  z.string(),
  z.object({
    id: z.string(),
    format: z.string().optional(),
    params: z.record(z.any()).optional(),
  }),
]);

const server = new McpServer({
  name: 'jira-dc-advops-mcp',
  version: '1.0.0',
});

server.tool(
  'structure_list',
  'List Tempo Structure boards visible to the user (GET /rest/structure/2.0/structure). Optional name substring filter. structureId from StructureBoard.jspa?s=ID.',
  {
    name: z.string().optional().describe('Case-insensitive substring filter on structure name'),
    withOwner: z.boolean().optional().describe('Include owner (default false)'),
    withPermissions: z.boolean().optional().describe('Include permission rules (default false)'),
    archived: z.boolean().optional().describe('Include archived structures (default false)'),
    limit: z.number().optional().describe('Max structures to return'),
  },
  { title: 'List Structure boards', ...readOnly },
  async (args) => {
    try {
      return ok(await listStructures(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'structure_get',
  'Get Tempo Structure metadata by id (name, description, owner). Does not include hierarchy — use structure_getForest / structure_getBoard.',
  {
    structureId: z.number().describe('Structure id from StructureBoard.jspa?s=…, e.g. 182'),
    withOwner: z.boolean().optional().describe('Include owner (default true)'),
    withPermissions: z.boolean().optional().describe('Include permission rules (default false)'),
  },
  { title: 'Get Structure metadata', ...readOnly },
  async ({ structureId, withOwner, withPermissions }) => {
    try {
      return ok(
        await getStructure(structureId, {
          withOwner: withOwner !== false,
          withPermissions: Boolean(withPermissions),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'structure_getForest',
  'Read Structure forest (hierarchy) via POST /rest/structure/2.0/forest/latest. Returns formula + parsed flat rows (rowId, depth, issueId / itemType). Prefer structure_getBoard for keys/summaries.',
  {
    structureId: z.number().optional().describe('Structure id, e.g. 182'),
    forestSpec: z
      .record(z.any())
      .optional()
      .describe('Raw RestForestSpec JSON if you need transforms/sQuery; overrides structureId'),
    includeGenerators: z
      .boolean()
      .optional()
      .describe('Include generator / loop-marker rows (default true)'),
  },
  { title: 'Get Structure forest', ...readOnly },
  async ({ structureId, forestSpec, includeGenerators }) => {
    try {
      const spec = forestSpecFromArgs({ structureId, forestSpec });
      const forest = await getForestLatest(spec);
      const itemTypes = forest.itemTypes || {};
      let rows = parseForestFormula(forest.formula, itemTypes);
      if (includeGenerators === false) {
        rows = rows.filter((r) => !isGeneratorOrLoop(r));
      }
      return ok({
        spec: forest.spec || spec,
        version: forest.version,
        itemTypes,
        formulaLength: forest.formula?.length ?? 0,
        rowCount: rows.length,
        rows,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'structure_getValues',
  'Load Structure attribute values for row ids (POST /rest/structure/2.0/value). Get row ids from structure_getForest. Default attributes: key, summary, status, issuetype.',
  {
    structureId: z.number().optional().describe('Structure id, e.g. 182'),
    forestSpec: z.record(z.any()).optional().describe('Raw RestForestSpec; overrides structureId'),
    rows: z.array(z.number()).min(1).describe('Row ids from forest formula'),
    attributes: z
      .array(attributeSchema)
      .optional()
      .describe('Attribute specs; string shorthand = {id, format:"text"}'),
  },
  { title: 'Get Structure attribute values', ...readOnly },
  async ({ structureId, forestSpec, rows, attributes }) => {
    try {
      const spec = forestSpecFromArgs({ structureId, forestSpec });
      const result = await getAttributeValues({
        forestSpec: spec,
        rows,
        attributes,
      });
      return ok({
        forestSpec: spec,
        rowCount: rows.length,
        attributes: result.attributes,
        byRow: result.byRow,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'structure_getBoard',
  'Fast path: read a Structure Board as nested tree with key/summary/status/issuetype (forest + values). Example: structureId=182 from StructureBoard.jspa?s=182. Use structure_getBoardToFile for large boards.',
  {
    structureId: z.number().optional().describe('Structure id, e.g. 182'),
    forestSpec: z.record(z.any()).optional().describe('Raw RestForestSpec; overrides structureId'),
    attributes: z
      .array(attributeSchema)
      .optional()
      .describe('Override default attributes (key, summary, status, issuetype)'),
    includeGenerators: z
      .boolean()
      .optional()
      .describe('Include generator / loop-marker rows (default true)'),
    flat: z
      .boolean()
      .optional()
      .describe('If true, return flat rows with values instead of nested tree'),
  },
  { title: 'Get Structure Board tree', ...readOnly },
  async (args) => {
    try {
      return ok(await getBoard(args));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  'structure_getBoardToFile',
  'Same as structure_getBoard but writes JSON to a local file (for large boards). Returns path + meta without stuffing the full tree into chat.',
  {
    structureId: z.number().optional().describe('Structure id, e.g. 182'),
    forestSpec: z.record(z.any()).optional().describe('Raw RestForestSpec; overrides structureId'),
    filePath: z.string().describe('Absolute path to write board JSON'),
    attributes: z.array(attributeSchema).optional(),
    includeGenerators: z.boolean().optional(),
    flat: z.boolean().optional(),
  },
  { title: 'Dump Structure Board to file', ...readOnly },
  async ({ filePath, ...args }) => {
    try {
      const board = await getBoard(args);
      mkdirSync(dirname(filePath), { recursive: true });
      const text = JSON.stringify(board, null, 2);
      writeFileSync(filePath, text, 'utf8');
      return ok({
        filePath,
        bytes: Buffer.byteLength(text, 'utf8'),
        structureId: board.structureId,
        rowCount: board.rowCount,
        attributes: board.attributes,
        flat: Boolean(args.flat),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
