import ELK from 'elkjs/lib/elk.bundled.js';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  ControlButton,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './dbml-erd.css';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, startTransition, type ChangeEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { isGoogleDriveConfigured, pickAndLoadGoogleDriveFile } from '../lib/googleDrive';
import { loadPersistedSession, savePersistedSession } from '../lib/sourcePersistence';

// -----------------------------------------------------------------------------
// DBML model types
// -----------------------------------------------------------------------------

type Cardinality = '1' | 'N';
type RelationOperator = '>' | '<' | '-' | '<>';
type SearchScope = 'schema' | 'table' | 'column';

/** DBML ilişki operatörlerini normalize eder (?> / <? / -< vb. dahil). */
function normalizeRelationOperator(raw: string): RelationOperator | null {
  const op = raw.trim();
  if (op === '<>' || op === '><') return '<>';
  if (op === '>' || op === '?>' || op === '->') return '>';
  if (op === '<' || op === '<?' || op === '<-') return '<';
  if (op === '-' || op === '--') return '-';
  // -< one-to-many, >- many-to-one (dbdiagram short forms)
  if (op === '-<' || op === '-o<' || op === '-*') return '<';
  if (op === '>-' || op === '>o-' || op === '*-') return '>';
  return null;
}

const RELATION_OPERATOR_PATTERN = '<>|<\\?|\\?>|><|-<|>-|-o<|>o-|-\\*|\\*-|->|<-|--|>|<|-';

const ALL_SEARCH_SCOPES: SearchScope[] = ['schema', 'table', 'column'];

type SearchScopeFilter = SearchScope | 'all';

const SEARCH_SCOPE_OPTIONS: Array<{ id: SearchScopeFilter; label: string }> = [
  { id: 'all', label: 'Tümü' },
  { id: 'schema', label: 'Şema adı' },
  { id: 'table', label: 'Tablo adı' },
  { id: 'column', label: 'Kolon adı' },
];

function scopesFromFilter(filter: SearchScopeFilter): SearchScope[] {
  return filter === 'all' ? [...ALL_SEARCH_SCOPES] : [filter];
}

interface FieldSettings {
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  increment: boolean;
  defaultValue?: string;
  note?: string;
  inlineRef?: string;
}

interface DbmlField {
  name: string;
  type: string;
  settings: FieldSettings;
  enumValues?: string[];
}

interface DbmlEnum {
  name: string;
  values: string[];
}

interface DbmlTable {
  id: string;
  name: string;
  schema?: string;
  alias?: string;
  fullName: string;
  note?: string;
  tableGroup?: string;
  fields: DbmlField[];
}

interface DbmlTableGroup {
  name: string;
  members: string[];
}

interface RefEndpoint {
  table: string;
  field: string;
}

interface DbmlRelation {
  id: string;
  left: RefEndpoint;
  right: RefEndpoint;
  operator: RelationOperator;
  source: RefEndpoint;
  target: RefEndpoint;
  sourceCardinality: Cardinality;
  targetCardinality: Cardinality;
}

interface ParseResult {
  tables: DbmlTable[];
  enums: DbmlEnum[];
  tableGroups: DbmlTableGroup[];
  relations: DbmlRelation[];
  warnings: string[];
}

interface TableNodeData extends Record<string, unknown> {
  table: DbmlTable;
  foreignKeyFields: string[];
  dimmed: boolean;
  searchTerm: string;
  searchScopes: SearchScope[];
  headerColor: string;
  onOpenTableData?: (tableId: string) => void;
}

type TableFlowNode = Node<TableNodeData, 'dbmlTable'>;

interface RelationEdgeData extends Record<string, unknown> {
  sourceCardinality: Cardinality;
  targetCardinality: Cardinality;
  label: string;
  sourceTable: string;
  targetTable: string;
  sourceField: string;
  targetField: string;
  dimmed: boolean;
  highlighted: boolean;
  infoVisible?: boolean;
  infoPointer?: XYPosition | null;
  showEdgeInfo?: boolean;
  onFocusTable?: (tableId: string) => void;
}

type RelationFlowEdge = Edge<RelationEdgeData, 'dbmlRelation'>;

export interface DbmlSource {
  id: string;
  name: string;
  label: string;
  content: string;
  kind?: 'local' | 'upload' | 'link' | 'drive';
  url?: string;
}

export interface DbmlErdViewerProps {
  sources: DbmlSource[];
  initialSourceId?: string;
  title?: string;
  height?: string | number;
  className?: string;
}

interface NavigatorGroup {
  id: string;
  name: string;
  color: string;
  tables: DbmlTable[];
}

// -----------------------------------------------------------------------------
// Lightweight DBML parser
// Supports the constructs used by the supplied  model:
// Table, Enum, TableGroup, table notes, field settings, standalone Ref and inline ref.
// -----------------------------------------------------------------------------

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripComments(source: string): string {
  let result = '';
  let index = 0;
  let quote: '"' | "'" | '`' | null = null;
  let tripleQuote = false;

  while (index < source.length) {
    if (!quote && source.startsWith("'''", index)) {
      tripleQuote = !tripleQuote;
      result += "'''";
      index += 3;
      continue;
    }

    const char = source[index];
    const next = source[index + 1];

    if (!tripleQuote && (char === '"' || char === "'" || char === '`')) {
      if (quote === char && source[index - 1] !== '\\') quote = null;
      else if (!quote) quote = char;

      result += char;
      index += 1;
      continue;
    }

    if (!quote && !tripleQuote && char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (!quote && !tripleQuote && char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !source.startsWith('*/', index)) index += 1;
      index += 2;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

interface NamedBlock {
  kind: 'Table' | 'Enum' | 'TableGroup';
  name: string;
  alias?: string;
  body: string;
}

function findClosingBrace(source: string, openingIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let tripleQuote = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    if (!quote && source.startsWith("'''", index)) {
      tripleQuote = !tripleQuote;
      index += 2;
      continue;
    }

    const char = source[index];

    if (!tripleQuote && (char === '"' || char === "'" || char === '`')) {
      if (quote === char && source[index - 1] !== '\\') quote = null;
      else if (!quote) quote = char;
      continue;
    }

    if (quote || tripleQuote) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function extractNamedBlocks(source: string): NamedBlock[] {
  const blocks: NamedBlock[] = [];
  const pattern =
    /\b(TableGroup|Table|Enum)\s+("(?:\\.|[^"])+"|[\w.-]+)(?:\s+as\s+("(?:\\.|[^"])+"|[\w.-]+))?\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const openingIndex = source.indexOf('{', match.index);
    const closingIndex = findClosingBrace(source, openingIndex);
    if (closingIndex < 0) break;

    blocks.push({
      kind: match[1] as 'TableGroup' | 'Table' | 'Enum',
      name: unquote(match[2]),
      alias: match[3] ? unquote(match[3]) : undefined,
      body: source.slice(openingIndex + 1, closingIndex),
    });

    pattern.lastIndex = closingIndex + 1;
  }

  return blocks;
}

function splitQualifiedName(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== '\\') quote = !quote;

    if (char === '.' && !quote) {
      parts.push(unquote(current));
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) parts.push(unquote(current));
  return parts;
}

function splitEndpoint(value: string): RefEndpoint | null {
  const cleaned = value
    .trim()
    .replace(/^\(/, '')
    .replace(/\)$/, '')
    .replace(/\s*\[[\s\S]*$/, '')
    .trim();

  if (cleaned.includes(',')) return null;

  const parts = splitQualifiedName(cleaned);
  if (parts.length < 2) return null;

  return {
    table: parts.slice(0, -1).join('.'),
    field: parts.at(-1)!,
  };
}

function findTopLevelBracket(value: string): number {
  let quote: '"' | "'" | '`' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' || char === "'" || char === '`') {
      if (quote === char && value[index - 1] !== '\\') quote = null;
      else if (!quote) quote = char;
    }
    if (!quote && char === '[') return index;
  }

  return -1;
}

function splitSettings(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | null = null;
  let parenthesisDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === '"' || char === "'" || char === '`') {
      if (quote === char && value[index - 1] !== '\\') quote = null;
      else if (!quote) quote = char;
    }

    if (!quote) {
      if (char === '(') parenthesisDepth += 1;
      if (char === ')') parenthesisDepth -= 1;
    }

    if (char === ',' && !quote && parenthesisDepth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) items.push(current.trim());
  return items;
}

function readFirstIdentifier(value: string): { identifier: string; rest: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('"')) {
    let index = 1;
    while (index < trimmed.length) {
      if (trimmed[index] === '"' && trimmed[index - 1] !== '\\') break;
      index += 1;
    }
    return {
      identifier: unquote(trimmed.slice(0, index + 1)),
      rest: trimmed.slice(index + 1).trim(),
    };
  }

  const match = trimmed.match(/^(\S+)\s*(.*)$/);
  if (!match) return null;
  return { identifier: match[1], rest: match[2] };
}

function parseFieldSettings(rawSettings: string): FieldSettings {
  const settings: FieldSettings = {
    primaryKey: false,
    notNull: false,
    unique: false,
    increment: false,
  };

  for (const rawItem of splitSettings(rawSettings)) {
    const item = rawItem.trim();
    const lower = item.toLowerCase();

    if (lower === 'pk' || lower === 'primary key') settings.primaryKey = true;
    else if (lower === 'not null') settings.notNull = true;
    else if (lower === 'unique') settings.unique = true;
    else if (lower === 'increment') settings.increment = true;
    else if (lower.startsWith('default:')) {
      settings.defaultValue = item.slice(item.indexOf(':') + 1).trim();
    } else if (lower.startsWith('note:')) {
      settings.note = unquote(item.slice(item.indexOf(':') + 1).trim());
    } else if (lower.startsWith('ref:')) {
      settings.inlineRef = item.slice(item.indexOf(':') + 1).trim();
    }
  }

  return settings;
}

function extractTableNote(body: string): string | undefined {
  const triple = body.match(/^\s*Note\s*:\s*'''([\s\S]*?)'''/im);
  if (triple) return triple[1].trim();

  const single = body.match(/^\s*Note\s*:\s*'((?:\\'|[^'])*)'/im);
  if (single) return single[1].replace(/\\'/g, "'").trim();

  const double = body.match(/^\s*Note\s*:\s*"((?:\\"|[^"])*)"/im);
  if (double) return double[1].replace(/\\"/g, '"').trim();

  return undefined;
}

function removeNestedSections(body: string): string {
  const lines = body.split(/\r?\n/);
  const output: string[] = [];
  let skipDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (skipDepth === 0 && /^(indexes|index)\s*\{/i.test(trimmed)) {
      skipDepth = 1;
      continue;
    }

    if (skipDepth > 0) {
      skipDepth += (line.match(/\{/g) ?? []).length;
      skipDepth -= (line.match(/\}/g) ?? []).length;
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

function parseEnum(block: NamedBlock): DbmlEnum {
  const values: string[] = [];

  for (const rawLine of block.body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^Note\s*:/i.test(line)) continue;

    const bracketIndex = findTopLevelBracket(line);
    const definition = (bracketIndex >= 0 ? line.slice(0, bracketIndex) : line).trim();
    const identifier = readFirstIdentifier(definition);
    if (identifier?.identifier) values.push(identifier.identifier);
  }

  return { name: block.name, values };
}

function resolveEnumValues(type: string, enums: DbmlEnum[]): string[] | undefined {
  const normalized = type.trim().replace(/\[\]\s*$/, '');
  if (!normalized) return undefined;

  const exact = enums.find((item) => item.name === normalized);
  if (exact) return exact.values;

  const suffixMatches = enums.filter(
    (item) => item.name.endsWith(`.${normalized}`) || item.name === normalized,
  );
  if (suffixMatches.length === 1) return suffixMatches[0].values;

  const byShortName = enums.filter((item) => {
    const short = item.name.includes('.') ? item.name.slice(item.name.lastIndexOf('.') + 1) : item.name;
    return short === normalized;
  });
  return byShortName.length === 1 ? byShortName[0].values : undefined;
}

function parseTable(block: NamedBlock): DbmlTable {
  const qualified = splitQualifiedName(block.name);
  const tableName = qualified.at(-1)!;
  const schema = qualified.length > 1 ? qualified.slice(0, -1).join('.') : undefined;
  const fullName = schema ? `${schema}.${tableName}` : tableName;
  const bodyWithoutNestedSections = removeNestedSections(block.body);
  const bodyForFields = bodyWithoutNestedSections
    .replace(/^\s*Note\s*:\s*'''[\s\S]*?'''/gim, '')
    .replace(/^\s*Note\s*:\s*'((?:\\'|[^'])*)'\s*$/gim, '')
    .replace(/^\s*Note\s*:\s*"((?:\\"|[^"])*)"\s*$/gim, '');
  const fields: DbmlField[] = [];

  for (const rawLine of bodyForFields.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line || /^Note\s*:/i.test(line) || line.startsWith("'''")) continue;

    const bracketIndex = findTopLevelBracket(line);
    const definition = (bracketIndex >= 0 ? line.slice(0, bracketIndex) : line).trim();
    const settingsText =
      bracketIndex >= 0
        ? line.slice(bracketIndex + 1, line.lastIndexOf(']') >= 0 ? line.lastIndexOf(']') : undefined)
        : '';

    const identifier = readFirstIdentifier(definition);
    if (!identifier || !identifier.rest) continue;

    fields.push({
      name: identifier.identifier,
      type: identifier.rest,
      settings: parseFieldSettings(settingsText),
    });
  }

  return {
    id: fullName,
    name: tableName,
    schema,
    alias: block.alias,
    fullName,
    note: extractTableNote(block.body),
    fields,
  };
}

function resolveTableName(input: string, tables: DbmlTable[]): string | null {
  const normalized = input.trim();
  const exact = tables.find(
    (table) =>
      table.fullName === normalized ||
      table.name === normalized ||
      table.alias === normalized,
  );
  if (exact) return exact.id;

  const suffixMatches = tables.filter((table) => table.fullName.endsWith(`.${normalized}`));
  return suffixMatches.length === 1 ? suffixMatches[0].id : null;
}

function normalizeRelation(
  left: RefEndpoint,
  operator: RelationOperator,
  right: RefEndpoint,
  id: string,
): DbmlRelation {
  if (operator === '>') {
    return {
      id,
      left,
      right,
      operator,
      source: right,
      target: left,
      sourceCardinality: '1',
      targetCardinality: 'N',
    };
  }

  if (operator === '<') {
    return {
      id,
      left,
      right,
      operator,
      source: left,
      target: right,
      sourceCardinality: '1',
      targetCardinality: 'N',
    };
  }

  if (operator === '<>') {
    return {
      id,
      left,
      right,
      operator,
      source: left,
      target: right,
      sourceCardinality: 'N',
      targetCardinality: 'N',
    };
  }

  return {
    id,
    left,
    right,
    operator,
    source: left,
    target: right,
    sourceCardinality: '1',
    targetCardinality: '1',
  };
}

function parseDbml(source: string): ParseResult {
  const cleanSource = stripComments(source);
  const blocks = extractNamedBlocks(cleanSource);
  const enums = blocks.filter((block) => block.kind === 'Enum').map(parseEnum);
  const tables = blocks.filter((block) => block.kind === 'Table').map(parseTable);
  for (const table of tables) {
    for (const field of table.fields) {
      const enumValues = resolveEnumValues(field.type, enums);
      if (enumValues) field.enumValues = enumValues;
    }
  }

  const warnings: string[] = [];
  const tableGroups: DbmlTableGroup[] = [];

  for (const block of blocks.filter((item) => item.kind === 'TableGroup')) {
    const members: string[] = [];
    for (const rawLine of block.body.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || /^Note\s*:/i.test(line) || line.startsWith("'''")) continue;
      const identifier = readFirstIdentifier(line);
      if (!identifier) continue;
      const resolved = resolveTableName(identifier.identifier, tables);
      if (!resolved) {
        warnings.push(`TableGroup "${block.name}" içinde tablo bulunamadı: ${identifier.identifier}`);
        continue;
      }
      members.push(resolved);
      const table = tables.find((item) => item.id === resolved);
      if (table && !table.tableGroup) table.tableGroup = block.name;
    }
    tableGroups.push({ name: block.name, members });
  }

  const rawRelations: Array<{
    left: RefEndpoint;
    right: RefEndpoint;
    operator: RelationOperator;
  }> = [];

  const refLinePattern = /^\s*Ref(?:\s+(?:"(?:\\.|[^"])+"|[\w.-]+))?\s*:\s*(.+)$/gim;
  let refMatch: RegExpExecArray | null;

  while ((refMatch = refLinePattern.exec(cleanSource)) !== null) {
    const expression = refMatch[1].trim();
    const relationMatch = expression.match(
      new RegExp(`^(.+?)\\s+(${RELATION_OPERATOR_PATTERN})\\s+(.+?)(?:\\s+\\[[^\\]]*\\])?\\s*$`),
    );

    if (!relationMatch) {
      warnings.push(`İlişki okunamadı: ${expression}`);
      continue;
    }

    const operator = normalizeRelationOperator(relationMatch[2]);
    const left = splitEndpoint(relationMatch[1]);
    const right = splitEndpoint(relationMatch[3]);
    if (!operator || !left || !right) {
      warnings.push(`Bileşik veya geçersiz ilişki atlandı: ${expression}`);
      continue;
    }

    rawRelations.push({
      left,
      right,
      operator,
    });
  }

  for (const table of tables) {
    for (const field of table.fields) {
      if (!field.settings.inlineRef) continue;

      const inlineMatch = field.settings.inlineRef.match(
        new RegExp(`^(${RELATION_OPERATOR_PATTERN})\\s+(.+)$`),
      );
      if (!inlineMatch) {
        warnings.push(`Inline ref okunamadı: ${table.fullName}.${field.name}`);
        continue;
      }

      const operator = normalizeRelationOperator(inlineMatch[1]);
      const right = splitEndpoint(inlineMatch[2]);
      if (!operator || !right) {
        warnings.push(`Inline ref hedefi okunamadı: ${field.settings.inlineRef}`);
        continue;
      }

      rawRelations.push({
        left: { table: table.fullName, field: field.name },
        operator,
        right,
      });
    }
  }

  const relations: DbmlRelation[] = [];
  const seen = new Set<string>();

  rawRelations.forEach((rawRelation, index) => {
    const leftTable = resolveTableName(rawRelation.left.table, tables);
    const rightTable = resolveTableName(rawRelation.right.table, tables);

    if (!leftTable || !rightTable) {
      warnings.push(
        `Tablosu bulunamayan ilişki: ${rawRelation.left.table}.${rawRelation.left.field} ${rawRelation.operator} ${rawRelation.right.table}.${rawRelation.right.field}`,
      );
      return;
    }

    const left = { ...rawRelation.left, table: leftTable };
    const right = { ...rawRelation.right, table: rightTable };
    const leftFieldExists = tables
      .find((table) => table.id === leftTable)
      ?.fields.some((field) => field.name === left.field);
    const rightFieldExists = tables
      .find((table) => table.id === rightTable)
      ?.fields.some((field) => field.name === right.field);

    if (!leftFieldExists || !rightFieldExists) {
      warnings.push(
        `Kolonu bulunamayan ilişki: ${left.table}.${left.field} ${rawRelation.operator} ${right.table}.${right.field}`,
      );
      return;
    }

    const signature = `${left.table}.${left.field}${rawRelation.operator}${right.table}.${right.field}`;
    if (seen.has(signature)) return;
    seen.add(signature);

    relations.push(normalizeRelation(left, rawRelation.operator, right, `relation-${index}`));
  });

  return { tables, enums, tableGroups, relations, warnings };
}

// -----------------------------------------------------------------------------
// React Flow custom node and edge
// -----------------------------------------------------------------------------

function badgeClass(kind: 'pk' | 'fk' | 'nn' | 'uq' | 'ai' | 'enum'): string {
  return `dbml-badge dbml-badge--${kind}`;
}

function sampleValueForField(field: DbmlField, rowIndex: number): string {
  const type = field.type.toLocaleLowerCase('tr-TR');
  const name = field.name.toLocaleLowerCase('tr-TR');

  if (field.enumValues && field.enumValues.length > 0) {
    return field.enumValues[rowIndex % field.enumValues.length];
  }

  if (field.settings.primaryKey || name === 'id' || name.endsWith('_id')) {
    return String(rowIndex + 1);
  }

  if (/(bool|boolean)/.test(type)) return rowIndex % 2 === 0 ? 'true' : 'false';
  if (/(int|bigint|smallint|serial|numeric|decimal|float|double|real)/.test(type)) {
    return String((rowIndex + 1) * 10);
  }
  if (/(uuid)/.test(type)) {
    return `00000000-0000-4000-8000-00000000000${rowIndex}`;
  }
  if (/(timestamp|timestamptz|datetime|date)/.test(type)) {
    return rowIndex === 0 ? 'null' : `2024-0${(rowIndex % 9) + 1}-15`;
  }
  if (/(json|jsonb)/.test(type)) return '{"ok":true}';
  if (name.includes('email')) return `user${rowIndex + 1}@example.com`;
  if (name.includes('name') || name.includes('title')) {
    return ['Alice', 'Bob', 'Candice', 'David'][rowIndex % 4];
  }
  if (name.includes('status') || name.includes('role')) {
    return ['active', 'pending', 'archived', 'draft'][rowIndex % 4];
  }
  if (/(text|varchar|char|string|citext)/.test(type)) return `örnek_${rowIndex + 1}`;

  return rowIndex === 3 ? 'null' : `değer_${rowIndex + 1}`;
}

function buildSampleRows(table: DbmlTable, rowCount = 4): Array<Record<string, string>> {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const row: Record<string, string> = {};
    for (const field of table.fields) {
      row[field.name] = sampleValueForField(field, rowIndex);
    }
    return row;
  });
}

const TableNode = memo(function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { table, foreignKeyFields, dimmed, searchTerm, searchScopes, headerColor, onOpenTableData } = data;
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase('tr-TR');
  const highlightColumns = normalizedSearch.length > 0 && searchScopes.includes('column');
  const [copiedName, setCopiedName] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  async function copyTableName(event: MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(table.fullName);
      setCopiedName(true);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopiedName(false), 280);
    } catch {
      // Clipboard API yoksa sessizce geç.
    }
  }

  return (
    <article className={`dbml-table-node${dimmed ? ' is-dimmed' : ''}`}>
      <header
        className="dbml-table-node__header"
        style={{ ['--header-bg' as string]: headerColor, ['--header-fg' as string]: '#ffffff' }}
      >
        <div className="dbml-table-node__heading">
          {table.schema && <div className="dbml-table-node__schema">{table.schema}</div>}
          <div className="dbml-table-node__title-row">
            <button
              type="button"
              className={`dbml-table-node__title nodrag nopan${copiedName ? ' is-copied' : ''}`}
              title={`${table.fullName} — tıkla, kopyala`}
              aria-label={`${table.fullName} adını kopyala`}
              onClick={copyTableName}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {table.name}
            </button>
            {table.note && (
              <span className="dbml-note-icon" tabIndex={0} aria-label="Tablo notu">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M8 1.5A6.5 6.5 0 1 0 14.5 8 6.51 6.51 0 0 0 8 1.5Zm0 2.1a1.15 1.15 0 1 1-1.15 1.15A1.15 1.15 0 0 1 8 3.6Zm1.5 7.65h-3a.75.75 0 0 1 0-1.5h.75V8.1H6.75a.75.75 0 0 1 0-1.5H8.5a.75.75 0 0 1 .75.75v2.4h.25a.75.75 0 0 1 0 1.5Z"
                  />
                </svg>
                <span className="dbml-note-tooltip" role="tooltip">
                  {table.note}
                </span>
              </span>
            )}
            <button
              type="button"
              className="dbml-table-data-icon nodrag nopan"
              aria-label="Tablo verisini görüntüle"
              title="Tablo verisini görüntüle"
              onClick={(event) => {
                event.stopPropagation();
                onOpenTableData?.(table.id);
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M2 5.5h12M6 5.5v8" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </button>
          </div>
        </div>
        <span className="dbml-table-node__count">{table.fields.length}</span>
      </header>

      <div className="dbml-table-node__fields">
        {table.fields.map((field) => {
          const isForeignKey = foreignKeyFields.includes(field.name);
          const isMatch =
            highlightColumns &&
            `${field.name} ${field.type}`.toLocaleLowerCase('tr-TR').includes(normalizedSearch);

          return (
            <div
              className={`dbml-field${isMatch ? ' is-search-match' : ''}`}
              key={field.name}
              title={field.settings.note}
            >
              <Handle
                className="dbml-field__handle dbml-field__handle--left"
                id={`left:${field.name}`}
                type="target"
                position={Position.Left}
                isConnectable={false}
              />

              <div className="dbml-field__badges">
                {field.settings.primaryKey && <span className={badgeClass('pk')}>PK</span>}
                {isForeignKey && <span className={badgeClass('fk')}>FK</span>}
                {field.enumValues && field.enumValues.length > 0 && (
                  <span className={badgeClass('enum')} title={`${field.type}: ${field.enumValues.join(', ')}`}>
                    E
                  </span>
                )}
              </div>

              <div className="dbml-field__name">{field.name}</div>
              <div className="dbml-field__type">{field.type}</div>

              <div className="dbml-field__constraints">
                {field.settings.notNull && <span className={badgeClass('nn')}>NN</span>}
                {field.settings.unique && <span className={badgeClass('uq')}>UQ</span>}
                {field.settings.increment && <span className={badgeClass('ai')}>AI</span>}
              </div>

              <Handle
                className="dbml-field__handle dbml-field__handle--right"
                id={`right:${field.name}`}
                type="source"
                position={Position.Right}
                isConnectable={false}
              />
            </div>
          );
        })}
      </div>
    </article>
  );
});

function JunctionMarker({
  x,
  y,
  position,
  cardinality,
  active,
  dimmed,
}: {
  x: number;
  y: number;
  position: Position;
  cardinality: Cardinality;
  active: boolean;
  dimmed: boolean;
}) {
  const isMany = cardinality === 'N';
  const rotation =
    position === Position.Right ? 180 : position === Position.Top ? 90 : position === Position.Bottom ? -90 : 0;
  const labelOffset =
    position === Position.Left
      ? { x: -18, y: -16 }
      : position === Position.Right
        ? { x: 18, y: -16 }
        : position === Position.Top
          ? { x: 0, y: -22 }
          : { x: 0, y: 18 };

  return (
    <>
      <div
        className={`dbml-junction nodrag nopan${active ? ' is-highlighted' : ''}${dimmed ? ' is-dimmed' : ''}`}
        style={{
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotation}deg)`,
        }}
      >
        <svg className="dbml-junction__svg" viewBox="0 0 28 20" width="28" height="20" aria-hidden="true">
          {isMany ? (
            <>
              <path d="M2 10 H12" className="dbml-junction__stem" />
              <path d="M12 10 L22 3 M12 10 L22 10 M12 10 L22 17" className="dbml-junction__crow" />
              <circle cx="12" cy="10" r="3.2" className="dbml-junction__node" />
            </>
          ) : (
            <>
              <path d="M2 10 H18" className="dbml-junction__stem" />
              <path d="M18 4 V16" className="dbml-junction__one" />
              <circle cx="12" cy="10" r="3.2" className="dbml-junction__node" />
            </>
          )}
        </svg>
      </div>
      <span
        className={`dbml-junction__label nodrag nopan${active ? ' is-highlighted' : ''}${dimmed ? ' is-dimmed' : ''}`}
        style={{
          transform: `translate(-50%, -50%) translate(${x + labelOffset.x}px, ${y + labelOffset.y}px)`,
        }}
      >
        {isMany ? '0..*' : '1'}
      </span>
    </>
  );
}

function clampEdgeInfoAboveCursor(
  cursorFlow: XYPosition,
  size: { width: number; height: number },
  gap: number,
  flowToScreenPosition: (position: XYPosition) => XYPosition,
  screenToFlowPosition: (position: XYPosition) => XYPosition,
): { position: XYPosition; placeBelow: boolean } {
  const pane = document.querySelector('.dbml-canvas .react-flow') as HTMLElement | null;
  if (!pane) return { position: cursorFlow, placeBelow: false };

  const rect = pane.getBoundingClientRect();
  const pad = 12;
  const halfW = size.width / 2;
  const cursor = flowToScreenPosition(cursorFlow);

  const minX = rect.left + pad + halfW;
  const maxX = rect.right - pad - halfW;
  const x = minX > maxX ? (rect.left + rect.right) / 2 : Math.min(Math.max(cursor.x, minX), maxX);

  const spaceAbove = cursor.y - rect.top - pad;
  const spaceBelow = rect.bottom - cursor.y - pad;
  const need = size.height + gap;
  const placeBelow = spaceAbove < need && spaceBelow >= spaceAbove;

  return {
    position: screenToFlowPosition({ x, y: cursor.y }),
    placeBelow,
  };
}

const EDGE_INFO_GAP = 12;

const RelationEdge = memo(function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<RelationFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 18,
    offset: 28,
  });

  const dimmed = data?.dimmed ?? false;
  const highlighted = data?.highlighted ?? false;
  const active = selected || highlighted;
  const showInfo = Boolean(data) && data?.showEdgeInfo !== false && Boolean(data?.infoVisible);
  const sourceCardinality = data?.sourceCardinality ?? '1';
  const targetCardinality = data?.targetCardinality ?? 'N';
  const { flowToScreenPosition, screenToFlowPosition } = useReactFlow();
  const viewport = useViewport();
  const labelRef = useRef<HTMLDivElement>(null);
  const pointer = data?.infoPointer ?? null;
  const preferred = pointer ?? { x: labelX, y: labelY };
  const [infoPosition, setInfoPosition] = useState<XYPosition>(preferred);
  const [placeBelow, setPlaceBelow] = useState(false);

  useLayoutEffect(() => {
    if (!showInfo) {
      setInfoPosition(preferred);
      setPlaceBelow(false);
      return;
    }

    const rect = labelRef.current?.getBoundingClientRect();
    const width = rect?.width && rect.width > 0 ? rect.width : 260;
    const height = rect?.height && rect.height > 0 ? rect.height : 88;

    const next = clampEdgeInfoAboveCursor(
      preferred,
      { width, height },
      EDGE_INFO_GAP,
      flowToScreenPosition,
      screenToFlowPosition,
    );
    setInfoPosition(next.position);
    setPlaceBelow(next.placeBelow);
  }, [
    flowToScreenPosition,
    preferred.x,
    preferred.y,
    screenToFlowPosition,
    showInfo,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  function focusTable(tableId: string, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    data?.onFocusTable?.(tableId);
  }

  function keepPopupOpen(event: { stopPropagation: () => void }) {
    event.stopPropagation();
  }

  const infoTransform = placeBelow
    ? `translate(-50%, ${EDGE_INFO_GAP}px) translate(${infoPosition.x}px, ${infoPosition.y}px)`
    : `translate(-50%, calc(-100% - ${EDGE_INFO_GAP}px)) translate(${infoPosition.x}px, ${infoPosition.y}px)`;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={28}
        className={`dbml-relation-edge${active ? ' is-highlighted' : ''}${dimmed ? ' is-dimmed' : ''}`}
      />
      {active && !dimmed && (
        <path
          d={path}
          className="dbml-relation-edge__flow"
          fill="none"
          strokeLinecap="round"
        />
      )}

      <EdgeLabelRenderer>
        <JunctionMarker
          x={sourceX}
          y={sourceY}
          position={sourcePosition}
          cardinality={sourceCardinality}
          active={active}
          dimmed={dimmed}
        />
        <JunctionMarker
          x={targetX}
          y={targetY}
          position={targetPosition}
          cardinality={targetCardinality}
          active={active}
          dimmed={dimmed}
        />

        {showInfo && data && (
          <div
            ref={labelRef}
            className="dbml-relation-label nodrag nopan"
            style={{ transform: infoTransform }}
            onClick={keepPopupOpen}
            onMouseDown={keepPopupOpen}
            onPointerDown={keepPopupOpen}
          >
            <div className="dbml-relation-label__row">
              <span className="dbml-relation-label__role">Başlangıç</span>
              <button
                type="button"
                className="dbml-relation-label__table"
                onClick={(event) => focusTable(data.sourceTable, event)}
                title={`${data.sourceTable} tablosuna git`}
              >
                {data.sourceTable}
              </button>
              <span className="dbml-relation-label__field">.{data.sourceField}</span>
            </div>
            <div className="dbml-relation-label__row">
              <span className="dbml-relation-label__role">Bitiş</span>
              <button
                type="button"
                className="dbml-relation-label__table"
                onClick={(event) => focusTable(data.targetTable, event)}
                title={`${data.targetTable} tablosuna git`}
              >
                {data.targetTable}
              </button>
              <span className="dbml-relation-label__field">.{data.targetField}</span>
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});

const nodeTypes = { dbmlTable: TableNode };
const edgeTypes = { dbmlRelation: RelationEdge };

type ThemeId = 'corp-light' | 'corp-dark' | 'dark' | 'light' | 'night' | 'sea' | 'split';

const THEME_OPTIONS: Array<{
  id: ThemeId;
  label: string;
  scheme: 'dark' | 'light';
  corporate?: boolean;
  swatchBg: string;
  swatchAccent: string;
  dot: string;
}> = [
  { id: 'corp-light', label: 'Nötr Açık', scheme: 'light', corporate: true, swatchBg: '#f7f7f5', swatchAccent: '#3f3f3c', dot: '#b8b8b2' },
  { id: 'corp-dark', label: 'Nötr Koyu', scheme: 'dark', corporate: true, swatchBg: '#1c1c1b', swatchAccent: '#c8c8c2', dot: '#4a4a46' },
  { id: 'light', label: 'Slate Açık', scheme: 'light', swatchBg: '#fbfcfd', swatchAccent: '#315d86', dot: '#9aa8b8' },
  { id: 'dark', label: 'Slate Koyu', scheme: 'dark', swatchBg: '#0f1419', swatchAccent: '#3d8fd1', dot: '#3a4554' },
  { id: 'sea', label: 'Teal Açık', scheme: 'light', swatchBg: '#f3f8f7', swatchAccent: '#0f766e', dot: '#8fafa9' },
  { id: 'night', label: 'Indigo Gece', scheme: 'dark', swatchBg: '#0b1020', swatchAccent: '#5eead4', dot: '#3a4568' },
  { id: 'split', label: 'Studio', scheme: 'light', swatchBg: '#d9dee6', swatchAccent: '#434b5a', dot: '#a8b3c2' },
];

const THEME_META = Object.fromEntries(THEME_OPTIONS.map((item) => [item.id, item])) as Record<
  ThemeId,
  (typeof THEME_OPTIONS)[number]
>;

function isThemeId(value: string | null): value is ThemeId {
  return (
    value === 'corp-light' ||
    value === 'corp-dark' ||
    value === 'dark' ||
    value === 'light' ||
    value === 'night' ||
    value === 'sea' ||
    value === 'split'
  );
}

function isLightScheme(theme: ThemeId): boolean {
  return THEME_META[theme].scheme === 'light';
}

function isCorporateTheme(theme: ThemeId): boolean {
  return Boolean(THEME_META[theme].corporate);
}

// -----------------------------------------------------------------------------
// ELK auto layout
// -----------------------------------------------------------------------------

type LayoutDensity = 'normal' | 'horizontal' | 'vertical';

const LAYOUT_DENSITY_PRESETS: Record<
  LayoutDensity,
  {
    label: string;
    title: string;
    betweenLayers: number;
    nodeNode: number;
    edgeNode: number;
    padding: number;
  }
> = {
  normal: {
    label: 'Normal',
    title: 'Normal dizilim',
    betweenLayers: 180,
    nodeNode: 90,
    edgeNode: 32,
    padding: 70,
  },
  horizontal: {
    label: 'Yatay',
    title: 'Yatay açık',
    betweenLayers: 660,
    nodeNode: 90,
    edgeNode: 56,
    padding: 130,
  },
  vertical: {
    label: 'Dikey',
    title: 'Dikey açık',
    betweenLayers: 180,
    nodeNode: 200,
    edgeNode: 48,
    padding: 110,
  },
};

const LAYOUT_DENSITY_OPTIONS: LayoutDensity[] = ['normal', 'horizontal', 'vertical'];

const elk = new ELK();
const NODE_WIDTH = 360;
const HEADER_HEIGHT = 52;
const FIELD_HEIGHT = 36;

function nodeHeight(table: DbmlTable): number {
  return HEADER_HEIGHT + table.fields.length * FIELD_HEIGHT;
}

// Tablo başlığı renkleri — buradan değiştirilebilir.
// 1) TABLE_HEADER_PALETTE: şema/grup adına göre sırayla kullanılan varsayılan renkler
// 2) TABLE_HEADER_COLOR_BY_KEY: belirli şema veya TableGroup adına sabit renk (öncelikli)
const TABLE_HEADER_PALETTE = [
  '#315d86',
  '#059669',
  '#7c3aed',
  '#db2777',
  '#d97706',
  '#0891b2',
  '#dc2626',
  '#4f46e5',
  '#0d9488',
  '#ca8a04',
];

const CORP_HEADER_PALETTE = [
  '#4a4a46',
  '#5c5c56',
  '#3a3a36',
  '#6a6a64',
  '#454540',
  '#585852',
  '#3f3f3a',
  '#63635c',
];

const TABLE_HEADER_COLOR_BY_KEY: Record<string, string> = {
  // örn: org: '#2563eb',
  // örn: crm: '#7c3aed',
};

function colorForKey(key: string, corporate = false): string {
  const override = TABLE_HEADER_COLOR_BY_KEY[key];
  if (override) return override;

  const palette = corporate ? CORP_HEADER_PALETTE : TABLE_HEADER_PALETTE;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
}

function headerColorForTable(
  table: DbmlTable,
  groupBy: 'schema' | 'tableGroup',
  corporate = false,
): string {
  if (groupBy === 'tableGroup') {
    return colorForKey(table.tableGroup ?? '__ungrouped__', corporate);
  }
  return colorForKey(table.schema ?? '__noschema__', corporate);
}

function groupTablesBySchema(tables: DbmlTable[], corporate = false): NavigatorGroup[] {
  const groups = new Map<string, DbmlTable[]>();

  for (const table of tables) {
    const name = table.schema ?? '(şemasız)';
    const current = groups.get(name);
    if (current) current.push(table);
    else groups.set(name, [table]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'tr'))
    .map(([name, schemaTables]) => ({
      id: `schema:${name}`,
      name,
      color: colorForKey(name === '(şemasız)' ? '__noschema__' : name, corporate),
      tables: [...schemaTables].sort((left, right) => left.name.localeCompare(right.name, 'tr')),
    }));
}

function groupTablesByTableGroup(
  tables: DbmlTable[],
  tableGroups: DbmlTableGroup[],
  corporate = false,
): NavigatorGroup[] {
  const tableMap = new Map(tables.map((table) => [table.id, table]));
  const grouped = new Set<string>();
  const result: NavigatorGroup[] = [];

  for (const group of tableGroups) {
    const groupTables = group.members
      .map((id) => tableMap.get(id))
      .filter((table): table is DbmlTable => Boolean(table));
    for (const table of groupTables) grouped.add(table.id);
    result.push({
      id: `group:${group.name}`,
      name: group.name,
      color: colorForKey(group.name, corporate),
      tables: groupTables.sort((left, right) => left.name.localeCompare(right.name, 'tr')),
    });
  }

  const ungrouped = tables.filter((table) => !grouped.has(table.id));
  if (ungrouped.length > 0) {
    result.push({
      id: 'group:__ungrouped__',
      name: '(grupsuz)',
      color: colorForKey('__ungrouped__', corporate),
      tables: [...ungrouped].sort((left, right) => left.name.localeCompare(right.name, 'tr')),
    });
  }

  return result;
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="m12 3 8 4.5-8 4.5L4 7.5 12 3Zm0 9 8 4.5-8 4.5-8-4.5L12 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SchemaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <circle cx="12" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6" cy="18" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="18" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7.2v4.2M12 11.4 6.8 16M12 11.4l5.2 4.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M4 9.5h16M10 9.5V19" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function EyeIcon({ closed = false }: { closed?: boolean }) {
  if (closed) {
    return (
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path
          d="M3 3l18 18M10.6 10.7a2.2 2.2 0 0 0 3.1 3.1M9.4 5.4A10.8 10.8 0 0 1 12 5c5.2 0 9.2 3.4 10.5 7-.4 1.1-1.1 2.2-2 3.1M6.1 6.2C4.5 7.4 3.4 9 2.5 12c1.3 3.6 5.3 7 10.5 7 1.4 0 2.7-.2 3.9-.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M2.5 12C3.8 8.4 7.8 5 13 5s9.2 3.4 10.5 7c-1.3 3.6-5.3 7-10.5 7S3.8 15.6 2.5 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle cx="13" cy="12" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M4.5 7h15M9.5 7V5.8A1.3 1.3 0 0 1 10.8 4.5h2.4a1.3 1.3 0 0 1 1.3 1.3V7M8 10v7.2M12 10v7.2M16 10v7.2M6.5 7l.7 12.1a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4L17.5 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M4.5 16.7V19.5h2.8L17.7 9.1 15 6.4 4.5 16.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="m14.3 5.7 2.7 2.7 1.5-1.5a1.1 1.1 0 0 0 0-1.6l-1.1-1.1a1.1 1.1 0 0 0-1.6 0l-1.5 1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

async function buildFlowGraph(
  parsed: ParseResult,
  density: LayoutDensity = 'normal',
): Promise<{
  nodes: TableFlowNode[];
  edges: RelationFlowEdge[];
}> {
  const foreignKeysByTable = new Map<string, Set<string>>();
  for (const relation of parsed.relations) {
    const endpoints = [relation.left, relation.right];
    for (const endpoint of endpoints) {
      if (!foreignKeysByTable.has(endpoint.table)) foreignKeysByTable.set(endpoint.table, new Set());
    }

    if (relation.operator === '>') foreignKeysByTable.get(relation.left.table)?.add(relation.left.field);
    if (relation.operator === '<') foreignKeysByTable.get(relation.right.table)?.add(relation.right.field);
  }

  const edges: RelationFlowEdge[] = parsed.relations.map((relation) => ({
    id: relation.id,
    source: relation.source.table,
    target: relation.target.table,
    sourceHandle: `right:${relation.source.field}`,
    targetHandle: `left:${relation.target.field}`,
    type: 'dbmlRelation',
    data: {
      sourceCardinality: relation.sourceCardinality,
      targetCardinality: relation.targetCardinality,
      label: `${relation.source.table}.${relation.source.field} → ${relation.target.table}.${relation.target.field}`,
      sourceTable: relation.source.table,
      targetTable: relation.target.table,
      sourceField: relation.source.field,
      targetField: relation.target.field,
      dimmed: false,
      highlighted: false,
    },
  }));

  const spacing = LAYOUT_DENSITY_PRESETS[density];

  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing.betweenLayers),
      'elk.spacing.nodeNode': String(spacing.nodeNode),
      'elk.spacing.edgeNode': String(spacing.edgeNode),
      'elk.padding': `[top=${spacing.padding},left=${spacing.padding},bottom=${spacing.padding},right=${spacing.padding}]`,
    },
    children: parsed.tables.map((table) => ({
      id: table.id,
      width: NODE_WIDTH,
      height: nodeHeight(table),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  });

  const positions = new Map(
    (graph.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]),
  );

  const nodes: TableFlowNode[] = parsed.tables.map((table) => ({
    id: table.id,
    type: 'dbmlTable',
    position: positions.get(table.id) ?? { x: 0, y: 0 },
    data: {
      table,
      foreignKeyFields: [...(foreignKeysByTable.get(table.id) ?? [])],
      dimmed: false,
      searchTerm: '',
      searchScopes: ALL_SEARCH_SCOPES,
      headerColor: headerColorForTable(table, 'schema'),
    },
  }));

  return { nodes, edges };
}

// -----------------------------------------------------------------------------
// Viewer
// -----------------------------------------------------------------------------

function matchesSearch(
  table: DbmlTable,
  normalizedSearch: string,
  scopes: SearchScope[],
  groupName?: string,
): boolean {
  if (!normalizedSearch) return true;
  if (scopes.length === 0) return true;

  if (scopes.includes('schema')) {
    const schemaText = `${table.schema ?? ''} ${groupName ?? ''}`.toLocaleLowerCase('tr-TR');
    if (schemaText.includes(normalizedSearch)) return true;
  }

  if (scopes.includes('table')) {
    const tableText = `${table.name} ${table.fullName}`.toLocaleLowerCase('tr-TR');
    if (tableText.includes(normalizedSearch)) return true;
  }

  if (scopes.includes('column')) {
    const hasColumn = table.fields.some((field) =>
      `${field.name} ${field.type}`.toLocaleLowerCase('tr-TR').includes(normalizedSearch),
    );
    if (hasColumn) return true;
  }

  return false;
}

function matchingColumns(
  table: DbmlTable,
  normalizedSearch: string,
  scopes: SearchScope[],
): string[] {
  if (!normalizedSearch || !scopes.includes('column')) return [];

  return table.fields
    .filter((field) =>
      `${field.name} ${field.type}`.toLocaleLowerCase('tr-TR').includes(normalizedSearch),
    )
    .map((field) => field.name);
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    return name || 'kaynak.dbml';
  } catch {
    return 'kaynak.dbml';
  }
}

function isAllowedDbmlUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.dbml') || path.endsWith('.txt');
  } catch {
    return false;
  }
}

function sourceDisplayName(fileName: string): string {
  return fileName.replace(/\.(dbml|txt)$/i, '');
}

function DbmlErdViewerContent({
  sources,
  initialSourceId,
  title = 'DBML Veri Modeli',
  height = '100%',
  className = '',
}: DbmlErdViewerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [uploadedSources, setUploadedSources] = useState<DbmlSource[]>([]);
  const [sourceOverrides, setSourceOverrides] = useState<Record<string, string>>({});
  const [isEditingSource, setIsEditingSource] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);

  const allSources = useMemo(() => {
    const merged = [...sources];
    for (const uploaded of uploadedSources) {
      if (!merged.some((item) => item.id === uploaded.id)) merged.push(uploaded);
    }
    return merged.map((source) => ({
      ...source,
      content: sourceOverrides[source.id] ?? source.content,
    }));
  }, [sources, uploadedSources, sourceOverrides]);

  const [activeSourceId, setActiveSourceId] = useState(
    () => initialSourceId ?? sources[0]?.id ?? '',
  );
  const activeSource = allSources.find((item) => item.id === activeSourceId) ?? allSources[0];
  const dbml = activeSource?.content ?? '';
  const editingSource =
    allSources.find((item) => item.id === editingSourceId) ?? activeSource ?? null;

  const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationFlowEdge>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [enumCount, setEnumCount] = useState(0);
  const [tableGroups, setTableGroups] = useState<DbmlTableGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchScopeFilter, setSearchScopeFilter] = useState<SearchScopeFilter>('all');
  const searchScopes = useMemo(() => scopesFromFilter(searchScopeFilter), [searchScopeFilter]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [hoveredTableId, setHoveredTableId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [pinnedEdgeId, setPinnedEdgeId] = useState<string | null>(null);
  const [pinnedEdgePointer, setPinnedEdgePointer] = useState<XYPosition | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [layoutDensity, setLayoutDensity] = useState<LayoutDensity>(() => {
    if (typeof window === 'undefined') return 'normal';
    const saved = window.localStorage.getItem('dbml-erd-layout-density');
    if (saved === 'normal' || saved === 'horizontal' || saved === 'vertical') return saved;
    return 'normal';
  });
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightSideWidth, setRightSideWidth] = useState(() => {
    if (typeof window === 'undefined') return 280;
    const saved = Number(window.localStorage.getItem('dbml-erd-right-width'));
    if (Number.isFinite(saved)) return Math.min(560, Math.max(240, saved));
    return 280;
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [hiddenTableIds, setHiddenTableIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<'schema' | 'tableGroup'>('schema');
  const [groupByOpen, setGroupByOpen] = useState(false);
  const [showEdgeInfo, setShowEdgeInfo] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('dbml-erd-edge-info') !== '0';
  });
  const [dataModalTableId, setDataModalTableId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return 'corp-light';
    const saved = window.localStorage.getItem('dbml-erd-theme');
    if (isThemeId(saved)) return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'corp-dark' : 'corp-light';
  });
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [viewLocked, setViewLocked] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [driveLoading, setDriveLoading] = useState(false);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const marqueeActiveRef = useRef(false);
  const hoverClearTimerRef = useRef<number | null>(null);
  const skipFitViewRef = useRef(false);
  const viewerRef = useRef<HTMLElement | null>(null);
  const { fitView, fitBounds, screenToFlowPosition } = useReactFlow<TableFlowNode, RelationFlowEdge>();

  const cancelHoverClear = useCallback(() => {
    if (hoverClearTimerRef.current === null) return;
    window.clearTimeout(hoverClearTimerRef.current);
    hoverClearTimerRef.current = null;
  }, []);

  const scheduleHoverClear = useCallback(() => {
    cancelHoverClear();
    hoverClearTimerRef.current = window.setTimeout(() => {
      startTransition(() => {
        setHoveredEdgeId(null);
        setHoveredTableId(null);
      });
      hoverClearTimerRef.current = null;
    }, 320);
  }, [cancelHoverClear]);

  const hoverEdge = useCallback(
    (edgeId: string) => {
      cancelHoverClear();
      startTransition(() => {
        setHoveredTableId(null);
        setHoveredEdgeId((current) => (current === edgeId ? current : edgeId));
      });
    },
    [cancelHoverClear],
  );

  const hoverTable = useCallback(
    (tableId: string) => {
      cancelHoverClear();
      startTransition(() => {
        setHoveredEdgeId(null);
        setHoveredTableId((current) => (current === tableId ? current : tableId));
      });
    },
    [cancelHoverClear],
  );

  useEffect(() => () => cancelHoverClear(), [cancelHoverClear]);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      await viewerRef.current?.requestFullscreen();
    } catch {
      // Tarayıcı engellerse sessizce geç.
    }
  }

  useEffect(() => {
    window.localStorage.setItem('dbml-erd-layout-density', layoutDensity);
  }, [layoutDensity]);

  useEffect(() => {
    window.localStorage.setItem('dbml-erd-theme', theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.scheme = THEME_META[theme].scheme;
    document.body.style.background = THEME_META[theme].swatchBg;
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('dbml-erd-edge-info', showEdgeInfo ? '1' : '0');
  }, [showEdgeInfo]);

  useEffect(() => {
    window.localStorage.setItem('dbml-erd-right-width', String(rightSideWidth));
  }, [rightSideWidth]);

  const startRightResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = rightSideWidth;

      function onMove(moveEvent: PointerEvent) {
        const next = startWidth + (startX - moveEvent.clientX);
        setRightSideWidth(Math.min(560, Math.max(240, next)));
      }

      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('dbml-resizing-side');
      }

      document.body.classList.add('dbml-resizing-side');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [rightSideWidth],
  );

  useEffect(() => {
    let cancelled = false;

    void loadPersistedSession()
      .then((session) => {
        if (cancelled) return;
        setUploadedSources(session.uploadedSources);
        setSourceOverrides(session.sourceOverrides);
        if (session.activeSourceId) {
          setActiveSourceId(session.activeSourceId);
        } else if (!initialSourceId && session.uploadedSources[0]) {
          setActiveSourceId(session.uploadedSources[0].id);
        }
        setSessionReady(true);
      })
      .catch(() => {
        if (!cancelled) setSessionReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [initialSourceId]);

  useEffect(() => {
    if (!sessionReady) return;

    const persistable = uploadedSources.filter(
      (item): item is DbmlSource & { kind: 'upload' | 'link' | 'drive' } =>
        item.kind === 'upload' || item.kind === 'link' || item.kind === 'drive',
    );

    void savePersistedSession({
      uploadedSources: persistable,
      sourceOverrides,
      activeSourceId,
    }).catch(() => {
      setLinkError('Yüklenen dosyalar tarayıcıya kaydedilemedi.');
    });
  }, [activeSourceId, sessionReady, sourceOverrides, uploadedSources]);

  useEffect(() => {
    if (!sessionReady) return;
    if (allSources.length === 0) {
      if (activeSourceId) setActiveSourceId('');
      return;
    }
    if (!allSources.some((item) => item.id === activeSourceId)) {
      setActiveSourceId(allSources[0].id);
    }
  }, [activeSourceId, allSources, sessionReady]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (!marqueeActiveRef.current || !marqueeStartRef.current) return;
      const left = Math.min(marqueeStartRef.current.x, event.clientX);
      const top = Math.min(marqueeStartRef.current.y, event.clientY);
      const width = Math.abs(event.clientX - marqueeStartRef.current.x);
      const height = Math.abs(event.clientY - marqueeStartRef.current.y);
      setMarquee({ left, top, width, height });
    }

    function onPointerUp(event: PointerEvent) {
      if (!marqueeActiveRef.current || !marqueeStartRef.current) return;

      const left = Math.min(marqueeStartRef.current.x, event.clientX);
      const top = Math.min(marqueeStartRef.current.y, event.clientY);
      const width = Math.abs(event.clientX - marqueeStartRef.current.x);
      const height = Math.abs(event.clientY - marqueeStartRef.current.y);

      marqueeActiveRef.current = false;
      marqueeStartRef.current = null;
      setMarquee(null);

      if (width < 24 || height < 24) return;

      const start = screenToFlowPosition({ x: left, y: top });
      const end = screenToFlowPosition({ x: left + width, y: top + height });
      void fitBounds(
        {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        },
        { padding: 0.06, duration: 280 },
      );
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [fitBounds, screenToFlowPosition]);

  useEffect(() => {
    if (!activeSource && allSources[0]) {
      setActiveSourceId(allSources[0].id);
    }
  }, [activeSource, allSources]);

  useEffect(() => {
    let cancelled = false;

    async function renderDbml() {
      try {
        setError(null);
        if (!dbml.trim()) throw new Error('Gösterilecek bir .dbml kaynağı bulunamadı.');

        const parsed = parseDbml(dbml);
        if (parsed.tables.length === 0) throw new Error('DBML içinde render edilebilir bir Table bloğu bulunamadı.');

        const graph = await buildFlowGraph(parsed, layoutDensity);
        if (cancelled) return;

        setWarnings(parsed.warnings);
        setEnumCount(parsed.enums.length);
        setTableGroups(parsed.tableGroups);
        setNodes(graph.nodes);
        setEdges(graph.edges);

        const shouldFitView = !skipFitViewRef.current;
        skipFitViewRef.current = false;

        if (shouldFitView) {
          window.requestAnimationFrame(() => {
            fitView({ padding: 0.12, duration: 500, maxZoom: 1 });
          });
        }
      } catch (caughtError) {
        if (cancelled) return;
        setError(caughtError instanceof Error ? caughtError.message : 'DBML render edilirken hata oluştu.');
        setEnumCount(0);
        setTableGroups([]);
        setNodes([]);
        setEdges([]);
      }
    }

    void renderDbml();
    return () => {
      cancelled = true;
    };
  }, [dbml, fitView, layoutDensity, layoutVersion, setEdges, setNodes]);

  useEffect(() => {
    setSelectedTable(null);
    setHoveredTableId(null);
    setHoveredEdgeId(null);
    setPinnedEdgeId(null);
    setPinnedEdgePointer(null);
    setSearchTerm('');
    setSearchScopeFilter('all');
    setCollapsedGroups(new Set());
    setHiddenTableIds(new Set());
    setGroupByOpen(false);
    setDataModalTableId(null);
  }, [dbml]);

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase('tr-TR');

  const navigatorGroups = useMemo(() => {
    const tables = nodes.map((node) => node.data.table);
    const corporate = isCorporateTheme(theme);
    return groupBy === 'tableGroup'
      ? groupTablesByTableGroup(tables, tableGroups, corporate)
      : groupTablesBySchema(tables, corporate);
  }, [groupBy, nodes, tableGroups, theme]);

  const filteredNavigatorGroups = useMemo(() => {
    if (!normalizedSearch) return navigatorGroups;

    return navigatorGroups
      .map((group) => {
        const groupMatch =
          searchScopes.includes('schema') &&
          group.name.toLocaleLowerCase('tr-TR').includes(normalizedSearch);
        return {
          ...group,
          tables: groupMatch
            ? group.tables
            : group.tables.filter((table) =>
                matchesSearch(table, normalizedSearch, searchScopes, group.name),
              ),
        };
      })
      .filter((group) => group.tables.length > 0);
  }, [navigatorGroups, normalizedSearch, searchScopes]);

  const tableGroupNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of navigatorGroups) {
      for (const table of group.tables) {
        map.set(table.id, group.name);
      }
    }
    return map;
  }, [navigatorGroups]);

  const visibleTableCount = nodes.length - hiddenTableIds.size;

  const connectedTableIds = useMemo(() => {
    if (!selectedTable) return new Set<string>();
    const ids = new Set<string>([selectedTable]);
    for (const edge of edges) {
      if (edge.source === selectedTable) ids.add(edge.target);
      if (edge.target === selectedTable) ids.add(edge.source);
    }
    return ids;
  }, [edges, selectedTable]);

  const hoverConnectedIds = useMemo(() => {
    const focusEdgeId = pinnedEdgeId ?? hoveredEdgeId;
    if (focusEdgeId) {
      const edge = edges.find((item) => item.id === focusEdgeId);
      if (edge) return new Set<string>([edge.source, edge.target]);
    }

    if (!hoveredTableId) return new Set<string>();
    const ids = new Set<string>([hoveredTableId]);
    for (const edge of edges) {
      if (edge.source === hoveredTableId) ids.add(edge.target);
      if (edge.target === hoveredTableId) ids.add(edge.source);
    }
    return ids;
  }, [edges, hoveredEdgeId, hoveredTableId, pinnedEdgeId]);

  const openTableData = useCallback((tableId: string) => {
    setDataModalTableId(tableId);
  }, []);

  const dataModalTable = useMemo(() => {
    if (!dataModalTableId) return null;
    return nodes.find((node) => node.id === dataModalTableId)?.data ?? null;
  }, [dataModalTableId, nodes]);

  const dataModalRows = useMemo(() => {
    if (!dataModalTable) return [];
    return buildSampleRows(dataModalTable.table);
  }, [dataModalTable]);

  const visibleNodes = useMemo(() => {
    return nodes.map((node) => {
      const searchMismatch =
        normalizedSearch.length > 0 &&
        !matchesSearch(
          node.data.table,
          normalizedSearch,
          searchScopes,
          tableGroupNameById.get(node.id),
        );
      const relationMismatch = selectedTable !== null && !connectedTableIds.has(node.id);
      const hoverActive = hoveredTableId !== null || hoveredEdgeId !== null || pinnedEdgeId !== null;
      const hoverDim = hoverActive && !selectedTable && !hoverConnectedIds.has(node.id);
      const isHidden = hiddenTableIds.has(node.id);

      return {
        ...node,
        hidden: isHidden,
        data: {
          ...node.data,
          dimmed: searchMismatch || relationMismatch || hoverDim,
          searchTerm,
          searchScopes,
          headerColor: headerColorForTable(node.data.table, groupBy, isCorporateTheme(theme)),
          onOpenTableData: openTableData,
        },
      };
    });
  }, [
    connectedTableIds,
    groupBy,
    hiddenTableIds,
    hoverConnectedIds,
    hoveredEdgeId,
    hoveredTableId,
    nodes,
    normalizedSearch,
    openTableData,
    pinnedEdgeId,
    searchScopes,
    searchTerm,
    selectedTable,
    tableGroupNameById,
    theme,
  ]);

  function downloadSampleCsv() {
    if (!dataModalTable) return;
    const fields = dataModalTable.table.fields.map((field) => field.name);
    const lines = [
      fields.join(','),
      ...dataModalRows.map((row) =>
        fields
          .map((field) => {
            const value = row[field] ?? '';
            if (value.includes(',') || value.includes('"')) return `"${value.replaceAll('"', '""')}"`;
            return value;
          })
          .join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${dataModalTable.table.fullName.replaceAll('.', '_')}_ornek.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const focusTables = useCallback(
    (tableIds: string[]) => {
      const matchingNodes = visibleNodes.filter((node) => tableIds.includes(node.id));
      if (matchingNodes.length > 0) {
        fitView({ nodes: matchingNodes, padding: 0.35, duration: 450, maxZoom: 1.25 });
      }
    },
    [fitView, visibleNodes],
  );

  const selectAndFocusTable = useCallback(
    (tableId: string) => {
      setSelectedTable(tableId);
      setHoveredEdgeId(null);
      setPinnedEdgeId(null);
      setPinnedEdgePointer(null);
      focusTables([tableId]);
    },
    [focusTables],
  );

  const clearPinnedEdge = useCallback(() => {
    setPinnedEdgeId(null);
    setPinnedEdgePointer(null);
  }, []);

  const pinEdgeAtEvent = useCallback(
    (edgeId: string, event: { clientX: number; clientY: number }) => {
      setPinnedEdgeId(edgeId);
      setPinnedEdgePointer(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [screenToFlowPosition],
  );

  const visibleEdges = useMemo(() => {
    return edges.map((edge) => {
      const relationMismatch =
        selectedTable !== null && edge.source !== selectedTable && edge.target !== selectedTable;
      const sourceNode = visibleNodes.find((node) => node.id === edge.source);
      const targetNode = visibleNodes.find((node) => node.id === edge.target);
      const searchDimmed = Boolean(sourceNode?.data.dimmed && targetNode?.data.dimmed);
      const highlighted =
        pinnedEdgeId === edge.id ||
        hoveredEdgeId === edge.id ||
        (hoveredTableId !== null &&
          (edge.source === hoveredTableId || edge.target === hoveredTableId)) ||
        (selectedTable !== null &&
          (edge.source === selectedTable || edge.target === selectedTable));
      const infoVisible = pinnedEdgeId === edge.id;

      return {
        ...edge,
        zIndex: highlighted ? 8 : 1,
        data: {
          ...edge.data!,
          dimmed: relationMismatch || (searchDimmed && !highlighted),
          highlighted,
          infoVisible,
          infoPointer: infoVisible ? pinnedEdgePointer : null,
          showEdgeInfo,
          onFocusTable: selectAndFocusTable,
        },
      };
    });
  }, [
    edges,
    hoveredEdgeId,
    hoveredTableId,
    pinnedEdgeId,
    pinnedEdgePointer,
    selectAndFocusTable,
    selectedTable,
    showEdgeInfo,
    visibleNodes,
  ]);

  function focusSearchResult() {
    const matchingNodes = visibleNodes.filter((node) => !node.data.dimmed);
    if (matchingNodes.length > 0) {
      fitView({ nodes: matchingNodes, padding: 0.35, duration: 450, maxZoom: 1.25 });
    }
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function toggleTableVisibility(tableId: string) {
    setHiddenTableIds((current) => {
      const next = new Set(current);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }

  function toggleGroupVisibility(group: NavigatorGroup) {
    setHiddenTableIds((current) => {
      const next = new Set(current);
      const allHidden = group.tables.every((table) => next.has(table.id));
      for (const table of group.tables) {
        if (allHidden) next.delete(table.id);
        else next.add(table.id);
      }
      return next;
    });
  }

  function toggleAllVisibility() {
    setHiddenTableIds((current) => {
      if (current.size === 0) return new Set(nodes.map((node) => node.id));
      return new Set();
    });
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.dbml') && !lowerName.endsWith('.txt')) {
      setLinkError('Yalnızca .dbml veya .txt dosyaları yüklenebilir.');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      const id = `upload:${file.name}`;
      const source: DbmlSource = {
        id,
        name: file.name,
        label: sourceDisplayName(file.name),
        content,
        kind: 'upload',
      };
      setLinkError(null);
      setUploadedSources((current) => [source, ...current.filter((item) => item.id !== id)]);
      setActiveSourceId(id);
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  function handleExport() {
    if (!activeSource?.content.trim()) {
      setLinkError('Dışa aktarılacak bir kaynak yok.');
      return;
    }

    const rawName = activeSource.name || 'export.dbml';
    const fileName = /\.(dbml|txt)$/i.test(rawName) ? rawName : `${rawName}.dbml`;
    const blob = new Blob([activeSource.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    setLinkError(null);
  }

  async function handleOpenGoogleDrive() {
    if (!isGoogleDriveConfigured()) {
      setLinkError(
        'Google Drive ayarlı değil. Proje köküne .env ekleyip VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY ve VITE_GOOGLE_APP_ID doldurun (bkz. .env.example).',
      );
      return;
    }

    setDriveLoading(true);
    setLinkError(null);

    try {
      const file = await pickAndLoadGoogleDriveFile();
      if (!file) return;

      const id = `drive:${file.id}`;
      const source: DbmlSource = {
        id,
        name: file.name,
        label: sourceDisplayName(file.name),
        content: file.content,
        kind: 'drive',
        url: file.url,
      };

      setUploadedSources((current) => [source, ...current.filter((item) => item.id !== id)]);
      setActiveSourceId(id);
    } catch (caughtError) {
      setLinkError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Google Drive dosyası açılamadı.',
      );
    } finally {
      setDriveLoading(false);
    }
  }

  function handleRemoveSource(sourceId: string) {
    const removable = uploadedSources.find((item) => item.id === sourceId);
    if (!removable) return;

    const remainingUploads = uploadedSources.filter((item) => item.id !== sourceId);
    setUploadedSources(remainingUploads);
    setSourceOverrides((current) => {
      if (!(sourceId in current)) return current;
      const next = { ...current };
      delete next[sourceId];
      return next;
    });
    setLinkError(null);

    if (editingSourceId === sourceId) {
      setIsEditingSource(false);
      setEditingSourceId(null);
      setDraftContent('');
    }

    if (activeSourceId !== sourceId) return;

    const nextSource =
      sources.find((item) => item.id !== sourceId) ??
      remainingUploads[0] ??
      null;
    setActiveSourceId(nextSource?.id ?? '');
  }

  function openSourceEditor(sourceId: string) {
    const source = allSources.find((item) => item.id === sourceId);
    if (!source) return;
    setActiveSourceId(sourceId);
    setEditingSourceId(sourceId);
    setDraftContent(source.content);
    setIsEditingSource(true);
    setLeftOpen(true);
    setLinkError(null);
  }

  function cancelSourceEditor() {
    setIsEditingSource(false);
    setEditingSourceId(null);
    setDraftContent('');
  }

  function applySourceEditor() {
    if (!editingSourceId) return;

    const uploaded = uploadedSources.some((item) => item.id === editingSourceId);
    if (uploaded) {
      setUploadedSources((current) =>
        current.map((item) =>
          item.id === editingSourceId ? { ...item, content: draftContent } : item,
        ),
      );
      setSourceOverrides((current) => {
        if (!(editingSourceId in current)) return current;
        const next = { ...current };
        delete next[editingSourceId];
        return next;
      });
    } else {
      setSourceOverrides((current) => ({
        ...current,
        [editingSourceId]: draftContent,
      }));
    }

    setActiveSourceId(editingSourceId);
    setIsEditingSource(false);
    setEditingSourceId(null);
    setLinkError(null);
  }

  async function handleAddLink() {
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      setLinkError('Bir bağlantı yapıştırın.');
      return;
    }
    if (!isAllowedDbmlUrl(trimmed)) {
      setLinkError('Bağlantı http(s) olmalı ve .dbml veya .txt ile bitmeli.');
      return;
    }

    setLinkLoading(true);
    setLinkError(null);

    try {
      const response = await fetch(trimmed);
      if (!response.ok) {
        throw new Error(`Dosya alınamadı (${response.status}).`);
      }

      const content = await response.text();
      if (!content.trim()) {
        throw new Error('Bağlantıdaki dosya boş.');
      }

      const fileName = fileNameFromUrl(trimmed);
      const id = `link:${trimmed}`;
      const source: DbmlSource = {
        id,
        name: fileName,
        label: trimmed,
        content,
        kind: 'link',
        url: trimmed,
      };

      setUploadedSources((current) => [source, ...current.filter((item) => item.id !== id)]);
      setActiveSourceId(id);
      setLinkUrl('');
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : 'Bağlantı yüklenemedi. CORS engeli olabilir.';
      setLinkError(
        message.includes('Failed to fetch')
          ? 'Bağlantı yüklenemedi. Kaynak CORS’a izin vermiyor olabilir.'
          : message,
      );
    } finally {
      setLinkLoading(false);
    }
  }

  return (
    <section
      ref={viewerRef}
      className={`dbml-erd-viewer ${leftOpen ? 'is-left-open' : ''} ${rightOpen ? 'is-right-open' : ''}${isEditingSource ? ' is-editing-source' : ''}${isFullscreen ? ' is-fullscreen' : ''} ${className}`.trim()}
      data-theme={theme}
      data-scheme={THEME_META[theme].scheme}
      style={{ height, ['--right-side-width' as string]: `${rightSideWidth}px` }}
      aria-label={title}
    >
      <aside className={`dbml-side dbml-side--left${leftOpen ? ' is-open' : ''}`}>
        <div className="dbml-side__header">
          <div>
            <div className="dbml-side__eyebrow">{isEditingSource ? 'Düzenle' : 'Kaynak'}</div>
            <h2>
              {isEditingSource
                ? editingSource?.name ?? 'DBML'
                : '.dbml dosyaları'}
            </h2>
          </div>
          {isEditingSource ? (
            <div className="dbml-side__header-actions">
              <button type="button" className="dbml-icon-button" onClick={cancelSourceEditor} aria-label="Düzenlemeyi iptal et" title="İptal">
                ×
              </button>
            </div>
          ) : (
            <button type="button" className="dbml-icon-button" onClick={() => setLeftOpen(false)} aria-label="Sol menüyü kapat">
              ←
            </button>
          )}
        </div>

        <div className={`dbml-side__body${isEditingSource ? ' is-editor' : ''}`}>
          {isEditingSource ? (
            <>
              <div className="dbml-source-editor__toolbar">
                <span className="dbml-source-editor__hint">DBML metnini düzenleyin</span>
                <div className="dbml-source-editor__actions">
                  <button type="button" className="dbml-source-editor__button" onClick={cancelSourceEditor}>
                    İptal
                  </button>
                  <button
                    type="button"
                    className="dbml-source-editor__button dbml-source-editor__button--primary"
                    onClick={applySourceEditor}
                  >
                    Uygula
                  </button>
                </div>
              </div>
              <textarea
                className="dbml-source-editor__textarea"
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
                spellCheck={false}
                aria-label="DBML metin editörü"
              />
            </>
          ) : (
            <>
          <label className="dbml-theme-select">
            <span className="dbml-theme-select__label">Tema</span>
            <span className="dbml-theme-select__control">
              <span
                className="dbml-theme-select__swatch"
                style={
                  {
                    ['--swatch-bg' as string]: THEME_META[theme].swatchBg,
                    ['--swatch-accent' as string]: THEME_META[theme].swatchAccent,
                  }
                }
                aria-hidden="true"
              />
              <select
                value={theme}
                onChange={(event) => setTheme(event.target.value as ThemeId)}
                aria-label="Tema"
              >
                {THEME_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </span>
          </label>

          <div className="dbml-source-actions">
            <div className="dbml-source-actions__row">
              <button type="button" className="dbml-side__upload" onClick={() => fileInputRef.current?.click()}>
                Dosya yükle
              </button>
              <button
                type="button"
                className="dbml-side__export"
                onClick={handleExport}
                disabled={!activeSource?.content.trim()}
                title="Aktif kaynağı .dbml olarak indir"
              >
                Export
              </button>
            </div>
            <button
              type="button"
              className="dbml-side__drive"
              onClick={() => void handleOpenGoogleDrive()}
              disabled={driveLoading}
              title="Google hesabınla Drive’dan kısıtlı .dbml / .txt aç"
            >
              {driveLoading ? 'Google Drive…' : 'Google Drive'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".dbml,.txt,text/plain"
              hidden
              onChange={handleUpload}
            />

            <div className="dbml-link-form">
              <input
                value={linkUrl}
                onChange={(event) => {
                  setLinkUrl(event.target.value);
                  if (linkError) setLinkError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleAddLink();
                  }
                }}
                placeholder="https://.../dosya.dbml"
                aria-label="DBML veya TXT bağlantısı"
              />
              <button type="button" onClick={() => void handleAddLink()} disabled={linkLoading}>
                {linkLoading ? '...' : 'Ekle'}
              </button>
            </div>
            {linkError && <div className="dbml-link-form__error">{linkError}</div>}
          </div>

          <ul className="dbml-file-list">
            {allSources.map((source) => {
              const canRemove =
                source.kind === 'upload' || source.kind === 'link' || source.kind === 'drive';
              return (
                <li key={source.id} className="dbml-file-list__row">
                  <button
                    type="button"
                    className={`dbml-file-list__item${source.id === activeSource?.id ? ' is-active' : ''}`}
                    onClick={() => setActiveSourceId(source.id)}
                    title={source.url ?? source.name}
                  >
                    <span className="dbml-file-list__name">{source.name}</span>
                    <span className="dbml-file-list__meta">
                      {source.kind === 'link'
                        ? 'Bağlantı'
                        : source.kind === 'upload'
                          ? 'Yüklenen'
                          : source.kind === 'drive'
                            ? 'Google Drive'
                            : source.label}
                      {sourceOverrides[source.id] ? ' · düzenlendi' : ''}
                    </span>
                  </button>
                  <div className="dbml-file-list__actions">
                    <button
                      type="button"
                      className="dbml-file-list__edit"
                      onClick={() => openSourceEditor(source.id)}
                      title="Metni düzenle"
                      aria-label={`${source.name} metnini düzenle`}
                    >
                      <EditIcon />
                    </button>
                    {canRemove && (
                      <button
                        type="button"
                        className="dbml-file-list__delete"
                        onClick={() => handleRemoveSource(source.id)}
                        title="Kaynağı sil"
                        aria-label={`${source.name} kaynağını sil`}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {allSources.length === 0 && (
              <li className="dbml-side__empty">Henüz kaynak yok. Dosya yükleyin veya bağlantı ekleyin.</li>
            )}
          </ul>

          <div className="dbml-side__footer">
            <button
              type="button"
              className={`dbml-edge-info-toggle${showEdgeInfo ? ' is-on' : ''}`}
              role="switch"
              aria-checked={showEdgeInfo}
              onClick={() => setShowEdgeInfo((current) => !current)}
            >
              <span className="dbml-edge-info-toggle__text">
                <span className="dbml-edge-info-toggle__title">Çizgi bilgisi</span>
                <span className="dbml-edge-info-toggle__hint">
                  {showEdgeInfo ? 'Tıklayınca info açık' : 'Tıklayınca info kapalı'}
                </span>
              </span>
              <span className="dbml-edge-info-toggle__switch" aria-hidden="true">
                <span className="dbml-edge-info-toggle__knob" />
              </span>
            </button>
          </div>
            </>
          )}
        </div>
      </aside>

      <div className="dbml-canvas">
        {!leftOpen && (
          <button
            type="button"
            className="dbml-rail-toggle dbml-rail-toggle--left"
            onClick={() => setLeftOpen(true)}
            aria-label="Sol menüyü aç"
          >
            Dosyalar
          </button>
        )}

        {!rightOpen && (
          <button
            type="button"
            className="dbml-rail-toggle dbml-rail-toggle--right"
            onClick={() => setRightOpen(true)}
            aria-label="Sağ menüyü aç"
          >
            Gezgin
          </button>
        )}

        <ReactFlow
          nodes={visibleNodes}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => {
            clearPinnedEdge();
            setSelectedTable((current) => (current === node.id ? null : node.id));
          }}
          onNodeMouseEnter={(_, node) => hoverTable(node.id)}
          onNodeMouseLeave={() => scheduleHoverClear()}
          onEdgeClick={(event, edge) => {
            if (!showEdgeInfo) {
              clearPinnedEdge();
              return;
            }
            pinEdgeAtEvent(edge.id, event);
          }}
          onEdgeMouseEnter={(_event, edge) => hoverEdge(edge.id)}
          onEdgeMouseMove={(_event, edge) => hoverEdge(edge.id)}
          onEdgeMouseLeave={() => scheduleHoverClear()}
          onPaneClick={() => {
            cancelHoverClear();
            setHoveredEdgeId(null);
            setHoveredTableId(null);
            setSelectedTable(null);
            clearPinnedEdge();
          }}
          onMouseDown={(event) => {
            if (viewLocked) return;
            const target = event.target as HTMLElement;
            if (event.button !== 0) return;
            if (!target.classList.contains('react-flow__pane')) return;
            marqueeActiveRef.current = true;
            marqueeStartRef.current = { x: event.clientX, y: event.clientY };
            setMarquee({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
          }}
          nodesDraggable
          nodesConnectable={false}
          edgesReconnectable={false}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          minZoom={0.05}
          maxZoom={3}
          panOnScroll
          panOnDrag={viewLocked ? true : [1, 2]}
          selectionOnDrag={false}
          onlyRenderVisibleElements
          className={viewLocked ? 'is-pan-mode' : 'is-marquee-mode'}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={isLightScheme(theme) ? 16 : 22}
            size={isLightScheme(theme) ? 2 : 1}
            color={THEME_META[theme].dot}
          />
          <MiniMap pannable zoomable position="bottom-right" nodeStrokeWidth={2} />
          <Controls position="bottom-left" showInteractive={false} showFitView={false}>
            <ControlButton
              className={`dbml-fullscreen-button${isFullscreen ? ' is-fullscreen' : ''}`}
              onClick={() => {
                void toggleFullscreen();
              }}
              title={isFullscreen ? 'Tam ekrandan çık' : 'Tam ekran'}
              aria-label={isFullscreen ? 'Tam ekrandan çık' : 'Tam ekran'}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </ControlButton>
            <ControlButton
              className={`dbml-lock-button${viewLocked ? ' is-locked' : ''}`}
              onClick={() => {
                setViewLocked((current) => {
                  const next = !current;
                  if (next) {
                    marqueeActiveRef.current = false;
                    marqueeStartRef.current = null;
                    setMarquee(null);
                  }
                  return next;
                });
              }}
              title={viewLocked ? 'Kilidi aç — alan zoom' : 'Kilitle — sürükleyerek kaydır'}
              aria-label={viewLocked ? 'Görünüm kilidini aç' : 'Görünümü kilitle'}
            >
              {viewLocked ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M7 11V8a5 5 0 0 1 9.9-1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <rect
                    x="5"
                    y="11"
                    width="14"
                    height="10"
                    rx="2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M8 11V8a4 4 0 0 1 8 0v3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <rect
                    x="5"
                    y="11"
                    width="14"
                    height="10"
                    rx="2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                </svg>
              )}
            </ControlButton>
          </Controls>

          <Panel position="top-center" className="dbml-toolbar nodrag nopan">
            <div className="dbml-toolbar__title">
              <span className="dbml-toolbar__eyebrow">ER diyagramı</span>
              <h1>{title}</h1>
              {activeSource && <span className="dbml-toolbar__file">{activeSource.name}</span>}
            </div>

            <div className="dbml-toolbar__actions">
              <div className="dbml-density" role="group" aria-label="Yerleşim sıklığı">
                {LAYOUT_DENSITY_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`dbml-density__button${layoutDensity === option ? ' is-active' : ''}`}
                    aria-pressed={layoutDensity === option}
                    onClick={() => {
                      if (option === layoutDensity) return;
                      skipFitViewRef.current = true;
                      setLayoutDensity(option);
                    }}
                    title={LAYOUT_DENSITY_PRESETS[option].title}
                  >
                    {LAYOUT_DENSITY_PRESETS[option].label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="dbml-toolbar__button"
                onClick={() => fitView({ padding: 0.12, duration: 450, maxZoom: 1 })}
              >
                Tümü
              </button>
              <button type="button" className="dbml-toolbar__button" onClick={focusSearchResult}>
                Sonuca git
              </button>
              <button
                type="button"
                className="dbml-toolbar__button dbml-toolbar__button--primary"
                onClick={() => setLayoutVersion((version) => version + 1)}
              >
                Yerleştir
              </button>
            </div>
          </Panel>

          <Panel position="bottom-left" className="dbml-legend nodrag nopan">
            <span><b className="dbml-legend__dot dbml-legend__dot--pk" />PK</span>
            <span><b className="dbml-legend__dot dbml-legend__dot--fk" />FK</span>
            <span><b className="dbml-legend__dot dbml-legend__dot--enum" />E Enum</span>
            <span><b className="dbml-legend__dot dbml-legend__dot--ai" />AI Auto Increment</span>
            <span><b>1</b> Tek</span>
            <span><b>N</b> Çok</span>
            <span className="dbml-legend__hint">
              {viewLocked
                ? 'Kilitli: sürükleyerek kaydır'
                : 'Tabloyu sürükleyerek taşı · boş alanda zoom'}
            </span>
          </Panel>

          {error && <Panel position="top-center" className="dbml-error nodrag nopan">{error}</Panel>}
        </ReactFlow>

        {marquee && marquee.width > 0 && marquee.height > 0 && (
          <div
            className="dbml-marquee"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        )}
      </div>

      <aside className={`dbml-side dbml-side--right${rightOpen ? ' is-open' : ''}`}>
        {rightOpen && (
          <div
            className="dbml-side__resize-handle"
            onPointerDown={startRightResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Sağ menü genişliğini ayarla"
            title="Sürükleyerek genişlet"
          />
        )}
        <div className="dbml-side__header">
          <div>
            <div className="dbml-side__eyebrow">Gezgin</div>
            <h2>Şema & arama</h2>
          </div>
          <button type="button" className="dbml-icon-button" onClick={() => setRightOpen(false)} aria-label="Sağ menüyü kapat">
            →
          </button>
        </div>

        <div className="dbml-side__body">
          <label className="dbml-search-select">
            <span className="dbml-search-select__label">Filtre</span>
            <select
              value={searchScopeFilter}
              onChange={(event) => setSearchScopeFilter(event.target.value as SearchScopeFilter)}
              aria-label="Arama filtresi"
            >
              {SEARCH_SCOPE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="dbml-search">
            <span className="dbml-search__icon" aria-hidden="true">⌕</span>
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') focusSearchResult();
              }}
              placeholder="Şema, tablo veya kolon"
            />
            {searchTerm && (
              <button type="button" onClick={() => setSearchTerm('')} aria-label="Aramayı temizle">
                ×
              </button>
            )}
          </label>

          <div className="dbml-side__stats" aria-label="Özet">
            <span>
              <strong>{groupBy === 'schema' ? navigatorGroups.length : tableGroups.length}</strong>
              {groupBy === 'schema' ? 'şema' : 'grup'}
            </span>
            <span className="dbml-side__stats-sep" aria-hidden="true">·</span>
            <span>
              <strong>{visibleTableCount}/{nodes.length}</strong>
              tablo
            </span>
            <span className="dbml-side__stats-sep" aria-hidden="true">·</span>
            <span>
              <strong>{edges.length}</strong>
              ilişki
            </span>
            <span className="dbml-side__stats-sep" aria-hidden="true">·</span>
            <span>
              <strong>{enumCount}</strong>
              enum
            </span>
          </div>

          {warnings.length > 0 && (
            <div className="dbml-side__warning" title={warnings.join('\n')}>
              {warnings.length} uyarı
            </div>
          )}

          <div className="dbml-groupby">
            <div className="dbml-groupby__row">
              <button
                type="button"
                className="dbml-groupby__trigger"
                onClick={() => setGroupByOpen((open) => !open)}
                aria-expanded={groupByOpen}
              >
                <LayersIcon />
                <span>Gruplandır: {groupBy === 'schema' ? 'Şema' : 'Tablo Grubu'}</span>
                <span className="dbml-groupby__chevron">{groupByOpen ? '▴' : '▾'}</span>
              </button>
              <button
                type="button"
                className="dbml-visibility-button"
                onClick={toggleAllVisibility}
                title={hiddenTableIds.size === 0 ? 'Tümünü gizle' : 'Tümünü göster'}
                aria-label={hiddenTableIds.size === 0 ? 'Tümünü gizle' : 'Tümünü göster'}
              >
                <EyeIcon closed={hiddenTableIds.size > 0 && hiddenTableIds.size === nodes.length} />
              </button>
            </div>

            {groupByOpen && (
              <div className="dbml-groupby__menu" role="listbox">
                <button
                  type="button"
                  className={`dbml-groupby__option${groupBy === 'schema' ? ' is-active' : ''}`}
                  onClick={() => {
                    setGroupBy('schema');
                    setGroupByOpen(false);
                  }}
                >
                  <span>Şema</span>
                  {groupBy === 'schema' && <span className="dbml-groupby__check">✓</span>}
                </button>
                <button
                  type="button"
                  className={`dbml-groupby__option${groupBy === 'tableGroup' ? ' is-active' : ''}`}
                  onClick={() => {
                    setGroupBy('tableGroup');
                    setGroupByOpen(false);
                  }}
                >
                  <span>Tablo Grubu</span>
                  {groupBy === 'tableGroup' && <span className="dbml-groupby__check">✓</span>}
                </button>
              </div>
            )}
          </div>

          <div className="dbml-schema-tree">
            {filteredNavigatorGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.id) && !normalizedSearch;
              const visibleInGroup = group.tables.filter((table) => !hiddenTableIds.has(table.id)).length;
              const groupHidden = group.tables.length > 0 && visibleInGroup === 0;

              return (
                <section className="dbml-schema-group" key={group.id}>
                  <div className="dbml-schema-group__header-row">
                    <button
                      type="button"
                      className="dbml-schema-group__header"
                      onClick={() => toggleGroup(group.id)}
                    >
                      <span className="dbml-schema-group__chevron">{collapsed ? '▸' : '▾'}</span>
                      <span className="dbml-schema-group__icon" style={{ color: group.color }}>
                        <SchemaIcon />
                      </span>
                      <span className="dbml-schema-group__swatch" style={{ background: group.color }} />
                      <span className="dbml-schema-group__name">{group.name}</span>
                      <span className="dbml-schema-group__count">
                        {visibleInGroup}/{group.tables.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="dbml-visibility-button"
                      onClick={() => toggleGroupVisibility(group)}
                      title={groupHidden ? 'Grubu göster' : 'Grubu gizle'}
                      aria-label={groupHidden ? 'Grubu göster' : 'Grubu gizle'}
                    >
                      <EyeIcon closed={groupHidden} />
                    </button>
                  </div>

                  {!collapsed && (
                    <ul className="dbml-schema-group__tables">
                      {group.tables.map((table) => {
                        const columns = matchingColumns(table, normalizedSearch, searchScopes);
                        const isHidden = hiddenTableIds.has(table.id);
                        return (
                          <li key={table.id}>
                            <div className="dbml-schema-group__table-row">
                              <button
                                type="button"
                                className={`dbml-schema-group__table${selectedTable === table.id ? ' is-active' : ''}${isHidden ? ' is-hidden' : ''}`}
                                onClick={() => selectAndFocusTable(table.id)}
                              >
                                <span className="dbml-schema-group__table-icon">
                                  <TableIcon />
                                </span>
                                <span className="dbml-schema-group__table-name">{table.name}</span>
                              </button>
                              <button
                                type="button"
                                className="dbml-visibility-button"
                                onClick={() => toggleTableVisibility(table.id)}
                                title={isHidden ? 'Tabloyu göster' : 'Tabloyu gizle'}
                                aria-label={isHidden ? 'Tabloyu göster' : 'Tabloyu gizle'}
                              >
                                <EyeIcon closed={isHidden} />
                              </button>
                            </div>
                            {columns.length > 0 && (
                              <ul className="dbml-schema-group__columns">
                                {columns.map((column) => (
                                  <li key={column}>{column}</li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}

            {filteredNavigatorGroups.length === 0 && (
              <div className="dbml-side__empty">
                {groupBy === 'tableGroup' && tableGroups.length === 0
                  ? 'DBML içinde TableGroup yok.'
                  : 'Eşleşen şema/tablo yok.'}
              </div>
            )}
          </div>
        </div>
      </aside>

      {dataModalTable && (
        <div
          className="dbml-data-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${dataModalTable.table.fullName} veri örneği`}
          onClick={() => setDataModalTableId(null)}
        >
          <div className="dbml-data-modal__panel nodrag nopan" onClick={(event) => event.stopPropagation()}>
            <div className="dbml-data-modal__header">
              <div className="dbml-data-modal__title-wrap">
                <span className="dbml-data-modal__table-icon" aria-hidden="true">
                  <TableIcon />
                </span>
                <div>
                  <div className="dbml-data-modal__eyebrow">Tablo verisi</div>
                  <h3>{dataModalTable.table.fullName}</h3>
                </div>
                {dataModalTable.table.note && (
                  <span className="dbml-data-modal__note" title={dataModalTable.table.note}>
                    i
                  </span>
                )}
              </div>
              <div className="dbml-data-modal__actions">
                <button type="button" className="dbml-toolbar__button" onClick={downloadSampleCsv}>
                  İndir
                </button>
                <button
                  type="button"
                  className="dbml-toolbar__button"
                  onClick={() => setDataModalTableId(null)}
                  aria-label="Kapat"
                >
                  ×
                </button>
              </div>
            </div>

            <p className="dbml-data-modal__hint">
              Örnek satırlar alan tiplerinden üretilir; gerçek veritabanı bağlantısı yoktur.
            </p>

            <div className="dbml-data-modal__table-wrap">
              <table className="dbml-data-modal__table">
                <thead>
                  <tr>
                    <th>#</th>
                    {dataModalTable.table.fields.map((field) => {
                      const isFk = dataModalTable.foreignKeyFields.includes(field.name);
                      return (
                        <th key={field.name}>
                          <div className="dbml-data-modal__col">
                            <span className="dbml-data-modal__col-name">
                              {field.settings.primaryKey && <span className="dbml-badge dbml-badge--pk">PK</span>}
                              {isFk && <span className="dbml-badge dbml-badge--fk">FK</span>}
                              {field.name}
                            </span>
                            <span className="dbml-data-modal__col-type">{field.type}</span>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {dataModalRows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      <td>{rowIndex}</td>
                      {dataModalTable.table.fields.map((field) => {
                        const value = row[field.name];
                        return (
                          <td key={field.name} className={value === 'null' ? 'is-null' : undefined}>
                            {value}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function DbmlErdViewer(props: DbmlErdViewerProps) {
  return (
    <ReactFlowProvider>
      <DbmlErdViewerContent {...props} />
    </ReactFlowProvider>
  );
}
