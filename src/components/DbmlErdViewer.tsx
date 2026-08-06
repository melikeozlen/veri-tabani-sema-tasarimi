import ELK from 'elkjs/lib/elk.bundled.js';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
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
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './dbml-erd.css';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

// -----------------------------------------------------------------------------
// DBML model types
// -----------------------------------------------------------------------------

type Cardinality = '1' | 'N';
type RelationOperator = '>' | '<' | '-' | '<>';

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
  fields: DbmlField[];
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
  relations: DbmlRelation[];
  warnings: string[];
}

interface TableNodeData extends Record<string, unknown> {
  table: DbmlTable;
  foreignKeyFields: string[];
  dimmed: boolean;
  searchTerm: string;
}

type TableFlowNode = Node<TableNodeData, 'dbmlTable'>;

interface RelationEdgeData extends Record<string, unknown> {
  sourceCardinality: Cardinality;
  targetCardinality: Cardinality;
  label: string;
  sourceLabel: string;
  targetLabel: string;
  dimmed: boolean;
  highlighted: boolean;
}

type RelationFlowEdge = Edge<RelationEdgeData, 'dbmlRelation'>;

export interface DbmlSource {
  id: string;
  name: string;
  label: string;
  content: string;
}

export interface DbmlErdViewerProps {
  sources: DbmlSource[];
  initialSourceId?: string;
  title?: string;
  height?: string | number;
  className?: string;
}

interface SchemaGroup {
  schema: string;
  tables: DbmlTable[];
}

// -----------------------------------------------------------------------------
// Lightweight DBML parser
// Supports the constructs used by the supplied CRM model:
// Table, Enum, table notes, field settings, standalone Ref and inline ref.
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
  kind: 'Table' | 'Enum';
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
  const pattern = /\b(Table|Enum)\s+("(?:\\.|[^"])+"|[\w.-]+)(?:\s+as\s+("(?:\\.|[^"])+"|[\w.-]+))?\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const openingIndex = source.indexOf('{', match.index);
    const closingIndex = findClosingBrace(source, openingIndex);
    if (closingIndex < 0) break;

    blocks.push({
      kind: match[1] as 'Table' | 'Enum',
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
  const enumMap = new Map(enums.map((item) => [item.name, item.values]));
  const tables = blocks.filter((block) => block.kind === 'Table').map(parseTable);
  for (const table of tables) {
    for (const field of table.fields) {
      const enumValues = enumMap.get(field.type);
      if (enumValues) field.enumValues = enumValues;
    }
  }
  const warnings: string[] = [];
  const rawRelations: Array<{
    left: RefEndpoint;
    right: RefEndpoint;
    operator: RelationOperator;
  }> = [];

  const refLinePattern = /^\s*Ref(?:\s+(?:"(?:\\.|[^"])+"|[\w.-]+))?\s*:\s*(.+)$/gim;
  let refMatch: RegExpExecArray | null;

  while ((refMatch = refLinePattern.exec(cleanSource)) !== null) {
    const expression = refMatch[1].trim();
    const relationMatch = expression.match(/^(.+?)\s+(<>|>|<|-)\s+(.+?)(?:\s+\[[^\]]*\])?\s*$/);

    if (!relationMatch) {
      warnings.push(`İlişki okunamadı: ${expression}`);
      continue;
    }

    const left = splitEndpoint(relationMatch[1]);
    const right = splitEndpoint(relationMatch[3]);
    if (!left || !right) {
      warnings.push(`Bileşik veya geçersiz ilişki atlandı: ${expression}`);
      continue;
    }

    rawRelations.push({
      left,
      right,
      operator: relationMatch[2] as RelationOperator,
    });
  }

  for (const table of tables) {
    for (const field of table.fields) {
      if (!field.settings.inlineRef) continue;

      const inlineMatch = field.settings.inlineRef.match(/^(<>|>|<|-)\s+(.+)$/);
      if (!inlineMatch) {
        warnings.push(`Inline ref okunamadı: ${table.fullName}.${field.name}`);
        continue;
      }

      const right = splitEndpoint(inlineMatch[2]);
      if (!right) {
        warnings.push(`Inline ref hedefi okunamadı: ${field.settings.inlineRef}`);
        continue;
      }

      rawRelations.push({
        left: { table: table.fullName, field: field.name },
        operator: inlineMatch[1] as RelationOperator,
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

  return { tables, enums, relations, warnings };
}

// -----------------------------------------------------------------------------
// React Flow custom node and edge
// -----------------------------------------------------------------------------

function badgeClass(kind: 'pk' | 'fk' | 'nn' | 'uq' | 'ai'): string {
  return `dbml-badge dbml-badge--${kind}`;
}

const TableNode = memo(function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { table, foreignKeyFields, dimmed, searchTerm } = data;
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase('tr-TR');

  return (
    <article className={`dbml-table-node${dimmed ? ' is-dimmed' : ''}`}>
      <header className="dbml-table-node__header">
        <div className="dbml-table-node__heading">
          {table.schema && <div className="dbml-table-node__schema">{table.schema}</div>}
          <div className="dbml-table-node__title-row">
            <div className="dbml-table-node__title">{table.name}</div>
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
          </div>
        </div>
        <span className="dbml-table-node__count">{table.fields.length}</span>
      </header>

      <div className="dbml-table-node__fields">
        {table.fields.map((field) => {
          const isForeignKey = foreignKeyFields.includes(field.name);
          const isMatch =
            normalizedSearch.length > 0 &&
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
              </div>

              <div className="dbml-field__name">{field.name}</div>
              <div
                className="dbml-field__type"
                title={field.enumValues ? `${field.type}: ${field.enumValues.join(', ')}` : undefined}
              >
                {field.type}
              </div>

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
    offset: 24,
  });

  const distance = Math.max(Math.hypot(targetX - sourceX, targetY - sourceY), 1);
  const unitX = (targetX - sourceX) / distance;
  const unitY = (targetY - sourceY) / distance;
  const sourceBadgeX = sourceX + unitX * 24;
  const sourceBadgeY = sourceY + unitY * 24;
  const targetBadgeX = targetX - unitX * 24;
  const targetBadgeY = targetY - unitY * 24;
  const dimmed = data?.dimmed ?? false;
  const highlighted = data?.highlighted ?? false;
  const active = selected || highlighted;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={28}
        className={`dbml-relation-edge${active ? ' is-highlighted' : ''}${dimmed ? ' is-dimmed' : ''}`}
      />

      <EdgeLabelRenderer>
        <span
          className={`dbml-cardinality${dimmed ? ' is-dimmed' : ''}${active ? ' is-highlighted' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${sourceBadgeX}px, ${sourceBadgeY}px)` }}
        >
          {data?.sourceCardinality}
        </span>
        <span
          className={`dbml-cardinality${dimmed ? ' is-dimmed' : ''}${active ? ' is-highlighted' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${targetBadgeX}px, ${targetBadgeY}px)` }}
        >
          {data?.targetCardinality}
        </span>

        {active && (
          <div
            className="dbml-relation-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <div className="dbml-relation-label__from">{data?.sourceLabel ?? data?.label}</div>
            <div className="dbml-relation-label__to">→ {data?.targetLabel}</div>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});

const nodeTypes = { dbmlTable: TableNode };
const edgeTypes = { dbmlRelation: RelationEdge };

function ThemeIcon({ mode }: { mode: 'light' | 'dark' }) {
  if (mode === 'light') {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 2.5v2.2M12 19.3v2.2M4.5 12H2.3M21.7 12h-2.2M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M18.5 14.2A7.2 7.2 0 0 1 9.8 5.5 7.6 7.6 0 1 0 18.5 14.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// ELK auto layout
// -----------------------------------------------------------------------------

const elk = new ELK();
const NODE_WIDTH = 360;
const HEADER_HEIGHT = 52;
const FIELD_HEIGHT = 36;

function nodeHeight(table: DbmlTable): number {
  return HEADER_HEIGHT + table.fields.length * FIELD_HEIGHT;
}

function groupTablesBySchema(tables: DbmlTable[]): SchemaGroup[] {
  const groups = new Map<string, DbmlTable[]>();

  for (const table of tables) {
    const schema = table.schema ?? '(şemasız)';
    const current = groups.get(schema);
    if (current) current.push(table);
    else groups.set(schema, [table]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'tr'))
    .map(([schema, schemaTables]) => ({
      schema,
      tables: [...schemaTables].sort((left, right) => left.name.localeCompare(right.name, 'tr')),
    }));
}

async function buildFlowGraph(parsed: ParseResult): Promise<{
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
      sourceLabel: `${relation.source.table}.${relation.source.field}`,
      targetLabel: `${relation.target.table}.${relation.target.field}`,
      dimmed: false,
      highlighted: false,
    },
  }));

  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.spacing.nodeNodeBetweenLayers': '180',
      'elk.spacing.nodeNode': '90',
      'elk.spacing.edgeNode': '32',
      'elk.padding': '[top=70,left=70,bottom=70,right=70]',
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
    },
  }));

  return { nodes, edges };
}

// -----------------------------------------------------------------------------
// Viewer
// -----------------------------------------------------------------------------

function matchesSearch(table: DbmlTable, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;

  const haystack = [
    table.schema ?? '',
    table.name,
    table.fullName,
    table.note ?? '',
    ...table.fields.flatMap((field) => [field.name, field.type]),
  ]
    .join(' ')
    .toLocaleLowerCase('tr-TR');

  return haystack.includes(normalizedSearch);
}

function matchingColumns(table: DbmlTable, normalizedSearch: string): string[] {
  if (!normalizedSearch) return [];
  return table.fields
    .filter((field) =>
      `${field.name} ${field.type}`.toLocaleLowerCase('tr-TR').includes(normalizedSearch),
    )
    .map((field) => field.name);
}

function DbmlErdViewerContent({
  sources,
  initialSourceId,
  title = 'DBML Veri Modeli',
  height = '100%',
  className = '',
}: DbmlErdViewerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedSources, setUploadedSources] = useState<DbmlSource[]>([]);
  const allSources = useMemo(() => {
    const merged = [...sources];
    for (const uploaded of uploadedSources) {
      if (!merged.some((item) => item.id === uploaded.id)) merged.push(uploaded);
    }
    return merged;
  }, [sources, uploadedSources]);

  const [activeSourceId, setActiveSourceId] = useState(
    () => initialSourceId ?? sources[0]?.id ?? uploadedSources[0]?.id ?? '',
  );
  const activeSource = allSources.find((item) => item.id === activeSourceId) ?? allSources[0];
  const dbml = activeSource?.content ?? '';

  const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationFlowEdge>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [enumCount, setEnumCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [hoveredTableId, setHoveredTableId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [collapsedSchemas, setCollapsedSchemas] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = window.localStorage.getItem('dbml-erd-theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const marqueeActiveRef = useRef(false);
  const { fitView, fitBounds, screenToFlowPosition } = useReactFlow<TableFlowNode, RelationFlowEdge>();

  useEffect(() => {
    window.localStorage.setItem('dbml-erd-theme', theme);
    document.documentElement.dataset.theme = theme;
    document.body.style.background = theme === 'light' ? '#f4f5f7' : '#0f1419';
  }, [theme]);

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

        const graph = await buildFlowGraph(parsed);
        if (cancelled) return;

        setWarnings(parsed.warnings);
        setEnumCount(parsed.enums.length);
        setNodes(graph.nodes);
        setEdges(graph.edges);
        setSelectedTable(null);
        setHoveredTableId(null);
        setHoveredEdgeId(null);
        setSearchTerm('');
        setCollapsedSchemas(new Set());

        window.requestAnimationFrame(() => {
          fitView({ padding: 0.12, duration: 500, maxZoom: 1 });
        });
      } catch (caughtError) {
        if (cancelled) return;
        setError(caughtError instanceof Error ? caughtError.message : 'DBML render edilirken hata oluştu.');
        setEnumCount(0);
        setNodes([]);
        setEdges([]);
      }
    }

    void renderDbml();
    return () => {
      cancelled = true;
    };
  }, [dbml, fitView, layoutVersion, setEdges, setNodes]);

  const schemaGroups = useMemo(
    () => groupTablesBySchema(nodes.map((node) => node.data.table)),
    [nodes],
  );

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase('tr-TR');

  const filteredSchemaGroups = useMemo(() => {
    if (!normalizedSearch) return schemaGroups;

    return schemaGroups
      .map((group) => {
        const schemaMatch = group.schema.toLocaleLowerCase('tr-TR').includes(normalizedSearch);
        return {
          ...group,
          tables: schemaMatch
            ? group.tables
            : group.tables.filter((table) => matchesSearch(table, normalizedSearch)),
        };
      })
      .filter((group) => group.tables.length > 0);
  }, [normalizedSearch, schemaGroups]);

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
    if (hoveredEdgeId) {
      const edge = edges.find((item) => item.id === hoveredEdgeId);
      if (edge) return new Set<string>([edge.source, edge.target]);
    }

    if (!hoveredTableId) return new Set<string>();
    const ids = new Set<string>([hoveredTableId]);
    for (const edge of edges) {
      if (edge.source === hoveredTableId) ids.add(edge.target);
      if (edge.target === hoveredTableId) ids.add(edge.source);
    }
    return ids;
  }, [edges, hoveredEdgeId, hoveredTableId]);

  const visibleNodes = useMemo(() => {
    return nodes.map((node) => {
      const searchMismatch = normalizedSearch.length > 0 && !matchesSearch(node.data.table, normalizedSearch);
      const relationMismatch = selectedTable !== null && !connectedTableIds.has(node.id);
      const hoverActive = hoveredTableId !== null || hoveredEdgeId !== null;
      const hoverDim = hoverActive && !selectedTable && !hoverConnectedIds.has(node.id);

      return {
        ...node,
        data: {
          ...node.data,
          dimmed: searchMismatch || relationMismatch || hoverDim,
          searchTerm,
        },
      };
    });
  }, [
    connectedTableIds,
    hoverConnectedIds,
    hoveredEdgeId,
    hoveredTableId,
    nodes,
    normalizedSearch,
    searchTerm,
    selectedTable,
  ]);

  const visibleEdges = useMemo(() => {
    return edges.map((edge) => {
      const relationMismatch =
        selectedTable !== null && edge.source !== selectedTable && edge.target !== selectedTable;
      const sourceNode = visibleNodes.find((node) => node.id === edge.source);
      const targetNode = visibleNodes.find((node) => node.id === edge.target);
      const searchDimmed = Boolean(sourceNode?.data.dimmed && targetNode?.data.dimmed);
      const highlighted =
        hoveredEdgeId === edge.id ||
        (hoveredTableId !== null &&
          (edge.source === hoveredTableId || edge.target === hoveredTableId)) ||
        (selectedTable !== null &&
          (edge.source === selectedTable || edge.target === selectedTable));

      return {
        ...edge,
        zIndex: highlighted ? 8 : 1,
        data: {
          ...edge.data!,
          dimmed: relationMismatch || (searchDimmed && !highlighted),
          highlighted,
        },
      };
    });
  }, [edges, hoveredEdgeId, hoveredTableId, selectedTable, visibleNodes]);

  const focusTables = useCallback(
    (tableIds: string[]) => {
      const matchingNodes = visibleNodes.filter((node) => tableIds.includes(node.id));
      if (matchingNodes.length > 0) {
        fitView({ nodes: matchingNodes, padding: 0.35, duration: 450, maxZoom: 1.25 });
      }
    },
    [fitView, visibleNodes],
  );

  function focusSearchResult() {
    const matchingNodes = visibleNodes.filter((node) => !node.data.dimmed);
    if (matchingNodes.length > 0) {
      fitView({ nodes: matchingNodes, padding: 0.35, duration: 450, maxZoom: 1.25 });
    }
  }

  function selectAndFocusTable(tableId: string) {
    setSelectedTable(tableId);
    focusTables([tableId]);
  }

  function toggleSchema(schema: string) {
    setCollapsedSchemas((current) => {
      const next = new Set(current);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      const id = `upload:${file.name}:${Date.now()}`;
      const source: DbmlSource = {
        id,
        name: file.name,
        label: file.name.replace(/\.dbml$/i, ''),
        content,
      };
      setUploadedSources((current) => [source, ...current]);
      setActiveSourceId(id);
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  return (
    <section
      className={`dbml-erd-viewer ${leftOpen ? 'is-left-open' : ''} ${rightOpen ? 'is-right-open' : ''} ${className}`.trim()}
      data-theme={theme}
      style={{ height }}
      aria-label={title}
    >
      <aside className={`dbml-side dbml-side--left${leftOpen ? ' is-open' : ''}`}>
        <div className="dbml-side__header">
          <div>
            <div className="dbml-side__eyebrow">Kaynak</div>
            <h2>.dbml dosyaları</h2>
          </div>
          <button type="button" className="dbml-icon-button" onClick={() => setLeftOpen(false)} aria-label="Sol menüyü kapat">
            ←
          </button>
        </div>

        <div className="dbml-side__body">
          <div className="dbml-theme-toggle" role="group" aria-label="Tema">
            <button
              type="button"
              className={`dbml-theme-toggle__button${theme === 'light' ? ' is-active' : ''}`}
              onClick={() => setTheme('light')}
              aria-label="Açık tema"
              title="Açık tema"
            >
              <ThemeIcon mode="light" />
            </button>
            <button
              type="button"
              className={`dbml-theme-toggle__button${theme === 'dark' ? ' is-active' : ''}`}
              onClick={() => setTheme('dark')}
              aria-label="Koyu tema"
              title="Koyu tema"
            >
              <ThemeIcon mode="dark" />
            </button>
          </div>

          <button type="button" className="dbml-side__upload" onClick={() => fileInputRef.current?.click()}>
            Dosya yükle
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dbml,text/plain"
            hidden
            onChange={handleUpload}
          />

          <ul className="dbml-file-list">
            {allSources.map((source) => (
              <li key={source.id}>
                <button
                  type="button"
                  className={`dbml-file-list__item${source.id === activeSource?.id ? ' is-active' : ''}`}
                  onClick={() => setActiveSourceId(source.id)}
                >
                  <span className="dbml-file-list__name">{source.name}</span>
                  <span className="dbml-file-list__meta">{source.label}</span>
                </button>
              </li>
            ))}
            {allSources.length === 0 && (
              <li className="dbml-side__empty">Henüz .dbml yok. Dosya yükleyin.</li>
            )}
          </ul>
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
          onNodeClick={(_, node) => setSelectedTable((current) => (current === node.id ? null : node.id))}
          onNodeMouseEnter={(_, node) => setHoveredTableId(node.id)}
          onNodeMouseLeave={() => setHoveredTableId(null)}
          onEdgeMouseEnter={(_, edge) => setHoveredEdgeId(edge.id)}
          onEdgeMouseLeave={() => setHoveredEdgeId(null)}
          onPaneClick={() => {
            setSelectedTable(null);
            setHoveredEdgeId(null);
          }}
          onMouseDown={(event) => {
            const target = event.target as HTMLElement;
            if (event.button !== 0) return;
            if (!target.classList.contains('react-flow__pane')) return;
            marqueeActiveRef.current = true;
            marqueeStartRef.current = { x: event.clientX, y: event.clientY };
            setMarquee({ left: event.clientX, top: event.clientY, width: 0, height: 0 });
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          minZoom={0.05}
          maxZoom={3}
          panOnScroll
          panOnDrag={[1, 2]}
          selectionOnDrag={false}
          onlyRenderVisibleElements
          fitView
          className="is-marquee-mode"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color={theme === 'light' ? '#c8cdd3' : '#3a4554'}
          />
          <MiniMap pannable zoomable position="bottom-right" nodeStrokeWidth={2} />
          <Controls position="bottom-left" showInteractive={false} />

          <Panel position="top-center" className="dbml-toolbar nodrag nopan">
            <div className="dbml-toolbar__title">
              <span className="dbml-toolbar__eyebrow">ER diyagramı</span>
              <h1>{title}</h1>
              {activeSource && <span className="dbml-toolbar__file">{activeSource.name}</span>}
            </div>

            <div className="dbml-toolbar__actions">
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
            <span><b>1</b> Tek</span>
            <span><b>N</b> Çok</span>
            <span className="dbml-legend__hint">Boş alanda sürükle: zoom · Scroll: kaydır</span>
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

          <div className="dbml-side__stats">
            <div>
              <strong>{schemaGroups.length}</strong>
              <span>şema</span>
            </div>
            <div>
              <strong>{nodes.length}</strong>
              <span>tablo</span>
            </div>
            <div>
              <strong>{edges.length}</strong>
              <span>ilişki</span>
            </div>
            <div>
              <strong>{enumCount}</strong>
              <span>enum</span>
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="dbml-side__warning" title={warnings.join('\n')}>
              {warnings.length} uyarı
            </div>
          )}

          <div className="dbml-schema-tree">
            {filteredSchemaGroups.map((group) => {
              const collapsed = collapsedSchemas.has(group.schema) && !normalizedSearch;
              const originalCount =
                schemaGroups.find((item) => item.schema === group.schema)?.tables.length ?? group.tables.length;

              return (
                <section className="dbml-schema-group" key={group.schema}>
                  <button
                    type="button"
                    className="dbml-schema-group__header"
                    onClick={() => toggleSchema(group.schema)}
                  >
                    <span className="dbml-schema-group__chevron">{collapsed ? '▸' : '▾'}</span>
                    <span className="dbml-schema-group__name">{group.schema}</span>
                    <span className="dbml-schema-group__count">{originalCount}</span>
                  </button>

                  {!collapsed && (
                    <ul className="dbml-schema-group__tables">
                      {group.tables.map((table) => {
                        const columns = matchingColumns(table, normalizedSearch);
                        return (
                          <li key={table.id}>
                            <button
                              type="button"
                              className={`dbml-schema-group__table${selectedTable === table.id ? ' is-active' : ''}`}
                              onClick={() => selectAndFocusTable(table.id)}
                            >
                              <span>{table.name}</span>
                              <span>{table.fields.length}</span>
                            </button>
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

            {filteredSchemaGroups.length === 0 && (
              <div className="dbml-side__empty">Eşleşen şema/tablo yok.</div>
            )}
          </div>
        </div>
      </aside>
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
