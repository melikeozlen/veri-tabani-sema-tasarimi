export type DbmlObjectKind = 'function' | 'view' | 'procedure' | 'trigger';

export interface DbmlSqlObject {
  id: string;
  kind: DbmlObjectKind;
  schema?: string;
  name: string;
  fullName: string;
  sql: string;
  tableRef?: string;
}

const CREATE_OBJECT =
  /^\s*CREATE\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(PROCEDURE|PROC|FUNCTION|VIEW|TRIGGER)\b/i;

function classifyKeyword(keyword: string): DbmlObjectKind | null {
  const key = keyword.toLowerCase();
  if (key === 'view') return 'view';
  if (key === 'function') return 'function';
  if (key === 'proc' || key === 'procedure') return 'procedure';
  if (key === 'trigger') return 'trigger';
  return null;
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"').replace(/\]\]/g, ']');
  }
  return trimmed;
}

function parseObjectName(raw: string): { schema?: string; name: string } {
  let value = raw.trim().replace(/[,;]+$/, '').replace(/\(\s*\)$/, '');
  if (!value) return { name: 'unknown' };

  if (value.includes('.')) {
    const parts = value.split('.').map(unquoteIdentifier).filter(Boolean);
    if (parts.length >= 2) {
      return { schema: parts.slice(0, -1).join('.'), name: parts.at(-1)! };
    }
  }

  return { name: unquoteIdentifier(value) };
}

function objectId(kind: DbmlObjectKind, schema: string | undefined, name: string, index: number): string {
  const full = schema ? `${schema}.${name}` : name;
  return `${kind}:${full}:${index}`;
}

function parseCreateLineHeader(line: string): {
  kind: DbmlObjectKind;
  nameRaw: string;
  tableRef?: string;
} | null {
  const match = line.match(
    /^\s*CREATE\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(PROCEDURE|PROC|FUNCTION|VIEW|TRIGGER)\s+(.+)$/i,
  );
  if (!match) return null;

  const kind = classifyKeyword(match[1]);
  if (!kind) return null;

  let rest = match[2].trim();
  let tableRef: string | undefined;

  if (kind === 'trigger') {
    const onMatch = rest.match(/^(.+?)\s+ON\s+(.+?)(?:\s+(?:AFTER|INSTEAD\s+OF|FOR)\b|\s*$)/i);
    if (onMatch) {
      rest = onMatch[1].trim();
      tableRef = onMatch[2].trim().replace(/[,;]+$/, '');
    }
  } else {
    rest = rest.split(/\s+(?:AS|RETURNS|RETURN|WITH)\b/i)[0]?.trim() ?? rest;
  }

  rest = rest.replace(/[,;]+$/, '').trim();
  if (!rest) return null;

  return { kind, nameRaw: rest, tableRef };
}

function parseCreateStatements(source: string): DbmlSqlObject[] {
  const lines = source.split(/\r?\n/);
  const objects: DbmlSqlObject[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = parseCreateLineHeader(lines[index]);
    if (!header) {
      index += 1;
      continue;
    }

    const chunk = [lines[index]];
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (/^\s*GO\s*$/i.test(line)) {
        index += 1;
        break;
      }
      if (CREATE_OBJECT.test(line)) break;
      chunk.push(line);
      index += 1;
    }

    const sql = chunk.join('\n').trim();
    const { schema, name } = parseObjectName(header.nameRaw);
    const fullName = schema ? `${schema}.${name}` : name;
    objects.push({
      id: objectId(header.kind, schema, name, objects.length),
      kind: header.kind,
      schema,
      name,
      fullName,
      sql,
      tableRef: header.tableRef,
    });
  }

  return objects;
}

interface ObjectBlock {
  kind: DbmlObjectKind;
  name: string;
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

function extractObjectBlocks(source: string): ObjectBlock[] {
  const blocks: ObjectBlock[] = [];
  const pattern =
    /\b(View|Function|Procedure|Proc|Trigger)\s+("(?:\\.|[^"])+"|[\w.-]+)\s*\{/gim;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const keyword = match[1];
    const kind = classifyKeyword(keyword === 'Proc' ? 'procedure' : keyword);
    if (!kind) continue;

    const openingIndex = source.indexOf('{', match.index);
    const closingIndex = findClosingBrace(source, openingIndex);
    if (closingIndex < 0) break;

    blocks.push({
      kind,
      name: unquoteIdentifier(match[2]),
      body: source.slice(openingIndex + 1, closingIndex).trim(),
    });

    pattern.lastIndex = closingIndex + 1;
  }

  return blocks;
}

function blockToSql(kind: DbmlObjectKind, fullName: string, body: string): string {
  if (/^\s*CREATE\s+/i.test(body)) return body.trim();
  const keyword =
    kind === 'procedure' ? 'PROCEDURE' : kind === 'function' ? 'FUNCTION' : kind.toUpperCase();
  return `CREATE ${keyword} ${fullName}\n${body}`.trim();
}

function parseObjectBlocks(source: string): DbmlSqlObject[] {
  return extractObjectBlocks(source).map((block, index) => {
    const parts = block.name.includes('.') ? block.name.split('.') : [block.name];
    const name = parts.at(-1)!;
    const schema = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
    const fullName = schema ? `${schema}.${name}` : name;
    const sql = blockToSql(block.kind, fullName, block.body);

    return {
      id: objectId(block.kind, schema, name, index),
      kind: block.kind,
      schema,
      name,
      fullName,
      sql,
    };
  });
}

export function parseDbmlObjects(source: string): DbmlSqlObject[] {
  if (!source.trim()) return [];

  const fromCreates = parseCreateStatements(source);
  const fromBlocks = parseObjectBlocks(source);
  const merged = [...fromCreates, ...fromBlocks];
  const seen = new Set<string>();

  return merged.filter((item) => {
    const key = `${item.kind}:${item.fullName}:${item.sql.slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function filterSqlObjectsByKind(
  objects: DbmlSqlObject[],
  visibility: Record<DbmlObjectKind, boolean>,
): DbmlSqlObject[] {
  return objects.filter((item) => visibility[item.kind]);
}
