export type DdlDialect = 'postgres' | 'mssql';

export interface DdlFieldSettings {
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  increment: boolean;
  defaultValue?: string;
  note?: string;
}

export interface DdlField {
  name: string;
  type: string;
  settings: DdlFieldSettings;
  enumValues?: string[];
}

export interface DdlTable {
  id: string;
  name: string;
  schema?: string;
  fullName: string;
  note?: string;
  fields: DdlField[];
}

export interface DdlEnum {
  name: string;
  values: string[];
}

export interface DdlRef {
  table: string;
  field: string;
}

export interface DdlRelation {
  source: DdlRef;
  target: DdlRef;
  sourceCardinality: '1' | 'N';
  targetCardinality: '1' | 'N';
}

export interface DdlModel {
  tables: DdlTable[];
  enums: DdlEnum[];
  relations: DdlRelation[];
}

interface ParsedType {
  name: string;
  args: string;
  array: boolean;
}

const INTEGER_TYPES = new Set([
  'int',
  'integer',
  'bigint',
  'smallint',
  'tinyint',
  'serial',
  'bigserial',
  'smallserial',
]);

function parseDataType(raw: string): ParsedType {
  let core = raw.trim().replace(/\s+unsigned\b/gi, '').replace(/\s+zerofill\b/gi, '').trim();
  const array = /\[\]\s*$/.test(core);
  core = core.replace(/\[\]\s*$/, '').trim();
  const match = /^([^\s(]+)(\s*\([^)]*\))?/.exec(core);
  if (!match) return { name: core || 'text', args: '', array };
  return {
    name: match[1],
    args: (match[2] ?? '').replace(/\s+/g, ''),
    array,
  };
}

function quotePg(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteMs(identifier: string): string {
  return `[${identifier.replaceAll(']', ']]')}]`;
}

function qualify(schema: string | undefined, name: string, dialect: DdlDialect): string {
  const quote = dialect === 'postgres' ? quotePg : quoteMs;
  return schema ? `${quote(schema)}.${quote(name)}` : quote(name);
}

function splitQualified(name: string): { schema?: string; name: string } {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) return { name: trimmed };
  return { schema: trimmed.slice(0, dot), name: trimmed.slice(dot + 1) };
}

function sqlString(value: string, dialect: DdlDialect): string {
  if (dialect === 'mssql') {
    return `N'${value.replaceAll("'", "''")}'`;
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlComment(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `-- ${line}`)
    .join('\n');
}

function findEnum(field: DdlField, enums: DdlEnum[]): DdlEnum | undefined {
  const typeName = field.type.trim().replace(/\[\]\s*$/, '');
  if (!typeName) return undefined;

  const exact = enums.find((item) => item.name === typeName);
  if (exact) return exact;

  const suffix = enums.filter(
    (item) => item.name.endsWith(`.${typeName}`) || item.name === typeName,
  );
  if (suffix.length === 1) return suffix[0];

  if (field.enumValues && field.enumValues.length > 0) {
    const byValues = enums.find(
      (item) =>
        item.values.length === field.enumValues!.length &&
        item.values.every((value, index) => value === field.enumValues![index]),
    );
    if (byValues) return byValues;
  }

  return undefined;
}

function mapPostgresType(field: DdlField, enums: DdlEnum[]): { sql: string; isIdentity: boolean } {
  const matchedEnum = findEnum(field, enums);
  if (matchedEnum) {
    const parts = splitQualified(matchedEnum.name);
    return { sql: qualify(parts.schema, parts.name, 'postgres'), isIdentity: false };
  }

  const parsed = parseDataType(field.type);
  const key = parsed.name.toLowerCase();
  const identity = field.settings.increment && INTEGER_TYPES.has(key);
  let mapped: string;

  switch (key) {
    case 'int':
    case 'integer':
    case 'serial':
    case 'smallserial':
      mapped = 'integer';
      break;
    case 'bigint':
    case 'bigserial':
      mapped = 'bigint';
      break;
    case 'smallint':
    case 'tinyint':
      mapped = 'smallint';
      break;
    case 'float':
    case 'double':
    case 'double precision':
      mapped = 'double precision';
      break;
    case 'real':
      mapped = 'real';
      break;
    case 'bool':
    case 'boolean':
    case 'bit':
      mapped = 'boolean';
      break;
    case 'nvarchar':
    case 'varchar':
    case 'character varying':
      mapped = `varchar${parsed.args}`;
      break;
    case 'nchar':
    case 'char':
    case 'character':
      mapped = `char${parsed.args}`;
      break;
    case 'ntext':
    case 'longtext':
    case 'mediumtext':
    case 'text':
      mapped = 'text';
      break;
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
      mapped = 'timestamp';
      break;
    case 'timestamp':
      mapped = 'timestamp';
      break;
    case 'timestamptz':
      mapped = 'timestamptz';
      break;
    case 'date':
      mapped = 'date';
      break;
    case 'time':
      mapped = 'time';
      break;
    case 'uniqueidentifier':
    case 'uuid':
      mapped = 'uuid';
      break;
    case 'jsonb':
      mapped = 'jsonb';
      break;
    case 'json':
      mapped = 'json';
      break;
    case 'xml':
      mapped = 'xml';
      break;
    case 'blob':
    case 'bytea':
    case 'binary':
    case 'varbinary':
    case 'image':
      mapped = 'bytea';
      break;
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      mapped = `numeric${parsed.args}`;
      break;
    default:
      mapped = `${parsed.name}${parsed.args}`;
  }

  if (parsed.array) mapped += '[]';
  return { sql: mapped, isIdentity: identity };
}

function mapMssqlType(field: DdlField, enums: DdlEnum[]): { sql: string; isIdentity: boolean } {
  const matchedEnum = findEnum(field, enums);
  if (matchedEnum || (field.enumValues && field.enumValues.length > 0)) {
    const values = matchedEnum?.values ?? field.enumValues ?? [];
    const width = Math.max(64, ...values.map((value) => value.length));
    return { sql: `nvarchar(${Math.min(width, 4000)})`, isIdentity: false };
  }

  const parsed = parseDataType(field.type);
  const key = parsed.name.toLowerCase();
  const identity = field.settings.increment && INTEGER_TYPES.has(key);
  let mapped: string;

  switch (key) {
    case 'int':
    case 'integer':
    case 'serial':
    case 'smallserial':
      mapped = 'int';
      break;
    case 'bigint':
    case 'bigserial':
      mapped = 'bigint';
      break;
    case 'smallint':
      mapped = 'smallint';
      break;
    case 'tinyint':
      mapped = 'tinyint';
      break;
    case 'float':
    case 'double':
    case 'double precision':
    case 'real':
      mapped = 'float';
      break;
    case 'bool':
    case 'boolean':
    case 'bit':
      mapped = 'bit';
      break;
    case 'varchar':
      mapped = parsed.args ? `varchar${parsed.args}` : 'varchar(255)';
      break;
    case 'nvarchar':
      mapped = parsed.args ? `nvarchar${parsed.args}` : 'nvarchar(255)';
      break;
    case 'char':
      mapped = parsed.args ? `char${parsed.args}` : 'char(1)';
      break;
    case 'nchar':
      mapped = parsed.args ? `nchar${parsed.args}` : 'nchar(1)';
      break;
    case 'text':
    case 'ntext':
    case 'longtext':
    case 'mediumtext':
      mapped = 'nvarchar(max)';
      break;
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'timestamp':
      mapped = 'datetime2';
      break;
    case 'timestamptz':
      mapped = 'datetimeoffset';
      break;
    case 'date':
      mapped = 'date';
      break;
    case 'time':
      mapped = 'time';
      break;
    case 'uuid':
    case 'uniqueidentifier':
      mapped = 'uniqueidentifier';
      break;
    case 'json':
    case 'jsonb':
    case 'xml':
      mapped = 'nvarchar(max)';
      break;
    case 'blob':
    case 'bytea':
    case 'binary':
    case 'varbinary':
    case 'image':
      mapped = 'varbinary(max)';
      break;
    case 'decimal':
    case 'numeric':
      mapped = `decimal${parsed.args || '(18,2)'}`;
      break;
    case 'money':
      mapped = 'money';
      break;
    case 'smallmoney':
      mapped = 'smallmoney';
      break;
    default:
      mapped = parsed.args ? `${parsed.name}${parsed.args}` : parsed.name;
  }

  if (parsed.array) mapped = 'nvarchar(max)';
  return { sql: mapped, isIdentity: identity };
}

function inlineNote(note: string | undefined): string {
  if (!note) return '';
  return ` -- ${note.replace(/\s+/g, ' ').trim()}`;
}

function formatDefault(raw: string, dialect: DdlDialect): string | null {
  let value = raw.trim();
  if (!value) return null;

  if (value.startsWith('`') && value.endsWith('`') && value.length >= 2) {
    value = value.slice(1, -1).trim();
  }

  const lower = value.toLowerCase();

  if (lower === 'null') return 'NULL';
  if (lower === 'true' || lower === 'false') {
    if (dialect === 'mssql') return lower === 'true' ? '1' : '0';
    return lower === 'true' ? 'TRUE' : 'FALSE';
  }

  if (
    lower === 'now()' ||
    lower === 'now' ||
    lower === 'current_timestamp' ||
    lower === 'current_timestamp()' ||
    lower === 'getdate()'
  ) {
    return dialect === 'postgres' ? 'CURRENT_TIMESTAMP' : 'SYSUTCDATETIME()';
  }

  if (lower === 'current_date') {
    return dialect === 'postgres' ? 'CURRENT_DATE' : 'CAST(SYSUTCDATETIME() AS date)';
  }

  if (lower === 'gen_random_uuid()' || lower === 'uuid()' || lower === 'newid()') {
    return dialect === 'postgres' ? 'gen_random_uuid()' : 'NEWID()';
  }

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return sqlString(value.slice(1, -1).replaceAll('\\"', '"'), dialect);
  }

  return value;
}

function joinColumnLines(items: string[]): string {
  return items
    .map((item, index) => {
      if (index === items.length - 1) return item;
      const commentIndex = item.indexOf(' -- ');
      if (commentIndex >= 0) {
        return `${item.slice(0, commentIndex)},${item.slice(commentIndex)}`;
      }
      return `${item},`;
    })
    .join('\n');
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  const next = `${base}_${index}`;
  used.add(next);
  return next;
}

function tableById(tables: DdlTable[], id: string): DdlTable | undefined {
  return tables.find((table) => table.id === id || table.fullName === id || table.name === id);
}

function collectSchemas(model: DdlModel): string[] {
  const schemas = new Set<string>();
  for (const table of model.tables) {
    if (table.schema) schemas.add(table.schema);
  }
  for (const item of model.enums) {
    const parts = splitQualified(item.name);
    if (parts.schema) schemas.add(parts.schema);
  }
  return [...schemas];
}

function fkPair(relation: DdlRelation): { from: DdlRef; to: DdlRef } | null {
  if (relation.sourceCardinality === 'N' && relation.targetCardinality === 'N') return null;
  return { from: relation.target, to: relation.source };
}

function emitPostgres(model: DdlModel, sourceName?: string): string {
  const lines: string[] = [];
  const constraintNames = new Set<string>();
  lines.push('-- PostgreSQL DDL');
  if (sourceName) lines.push(`-- Source: ${sourceName}`);
  lines.push('');

  const schemas = collectSchemas(model).filter((schema) => schema.toLowerCase() !== 'public');
  for (const schema of schemas) {
    lines.push(`CREATE SCHEMA IF NOT EXISTS ${quotePg(schema)};`);
  }
  if (schemas.length > 0) lines.push('');

  for (const item of model.enums) {
    if (item.values.length === 0) continue;
    const parts = splitQualified(item.name);
    const values = item.values.map((value) => sqlString(value, 'postgres')).join(', ');
    lines.push(`CREATE TYPE ${qualify(parts.schema, parts.name, 'postgres')} AS ENUM (${values});`);
  }
  if (model.enums.some((item) => item.values.length > 0)) lines.push('');

  for (const table of model.tables) {
    if (table.fields.length === 0) {
      lines.push(`-- skipped (no columns): ${table.fullName}`);
      continue;
    }

    const tableName = qualify(table.schema, table.name, 'postgres');
    if (table.note) lines.push(sqlComment(table.note));
    lines.push(`CREATE TABLE ${tableName} (`);

    const columnSql: string[] = [];
    const pkFields = table.fields.filter((field) => field.settings.primaryKey);
    let identityUsed = false;

    for (const field of table.fields) {
      const mapped = mapPostgresType(field, model.enums);
      const parts = [`  ${quotePg(field.name)} ${mapped.sql}`];
      const useIdentity = mapped.isIdentity && !identityUsed;
      if (useIdentity) {
        parts.push('GENERATED BY DEFAULT AS IDENTITY');
        identityUsed = true;
      }
      if (field.settings.notNull || field.settings.primaryKey) parts.push('NOT NULL');
      if (field.settings.unique && !field.settings.primaryKey) parts.push('UNIQUE');
      if (field.settings.defaultValue !== undefined) {
        const def = formatDefault(field.settings.defaultValue, 'postgres');
        if (def !== null) parts.push(`DEFAULT ${def}`);
      }
      columnSql.push(`${parts.join(' ')}${inlineNote(field.settings.note)}`);
    }

    if (pkFields.length > 0) {
      const pkName = uniqueName(`${table.name}_pkey`, constraintNames);
      const cols = pkFields.map((field) => quotePg(field.name)).join(', ');
      columnSql.push(`  CONSTRAINT ${quotePg(pkName)} PRIMARY KEY (${cols})`);
    }

    lines.push(joinColumnLines(columnSql));
    lines.push(');');
    lines.push('');
  }

  for (const relation of model.relations) {
    const pair = fkPair(relation);
    if (!pair) continue;
    const fromTable = tableById(model.tables, pair.from.table);
    const toTable = tableById(model.tables, pair.to.table);
    if (!fromTable || !toTable) continue;

    const fkName = uniqueName(`${fromTable.name}_${pair.from.field}_fkey`, constraintNames);
    lines.push(
      `ALTER TABLE ${qualify(fromTable.schema, fromTable.name, 'postgres')}`,
      `  ADD CONSTRAINT ${quotePg(fkName)} FOREIGN KEY (${quotePg(pair.from.field)})`,
      `  REFERENCES ${qualify(toTable.schema, toTable.name, 'postgres')} (${quotePg(pair.to.field)});`,
      '',
    );
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function emitMssql(model: DdlModel, sourceName?: string): string {
  const lines: string[] = [];
  const constraintNames = new Set<string>();
  lines.push('-- MSSQL DDL');
  if (sourceName) lines.push(`-- Source: ${sourceName}`);
  lines.push('');

  const schemas = collectSchemas(model).filter((schema) => schema.toLowerCase() !== 'dbo');
  for (const schema of schemas) {
    lines.push(`IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'${schema.replaceAll("'", "''")}')`);
    lines.push(`  EXEC(N'CREATE SCHEMA ${quoteMs(schema)}');`);
  }
  if (schemas.length > 0) {
    lines.push('GO');
    lines.push('');
  }

  for (const table of model.tables) {
    if (table.fields.length === 0) {
      lines.push(`-- skipped (no columns): ${table.fullName}`);
      continue;
    }

    const tableName = qualify(table.schema, table.name, 'mssql');
    if (table.note) lines.push(sqlComment(table.note));
    lines.push(`CREATE TABLE ${tableName} (`);

    const columnSql: string[] = [];
    const pkFields = table.fields.filter((field) => field.settings.primaryKey);
    let identityUsed = false;

    for (const field of table.fields) {
      const mapped = mapMssqlType(field, model.enums);
      const matchedEnum = findEnum(field, model.enums);
      const enumValues = matchedEnum?.values ?? field.enumValues;
      const parts = [`  ${quoteMs(field.name)} ${mapped.sql}`];
      const useIdentity = mapped.isIdentity && !identityUsed;
      if (useIdentity) {
        parts.push('IDENTITY(1,1)');
        identityUsed = true;
      }
      if (field.settings.notNull || field.settings.primaryKey) parts.push('NOT NULL');
      else parts.push('NULL');
      if (field.settings.unique && !field.settings.primaryKey) parts.push('UNIQUE');
      if (field.settings.defaultValue !== undefined) {
        const def = formatDefault(field.settings.defaultValue, 'mssql');
        if (def !== null) {
          parts.push(
            `CONSTRAINT ${quoteMs(uniqueName(`DF_${table.name}_${field.name}`, constraintNames))} DEFAULT ${def}`,
          );
        }
      }
      columnSql.push(`${parts.join(' ')}${inlineNote(field.settings.note)}`);

      if (enumValues && enumValues.length > 0) {
        const ckName = uniqueName(`CK_${table.name}_${field.name}`, constraintNames);
        const list = enumValues.map((value) => sqlString(value, 'mssql')).join(', ');
        columnSql.push(
          `  CONSTRAINT ${quoteMs(ckName)} CHECK (${quoteMs(field.name)} IN (${list}))`,
        );
      }
    }

    if (pkFields.length > 0) {
      const pkName = uniqueName(`PK_${table.name}`, constraintNames);
      const cols = pkFields.map((field) => quoteMs(field.name)).join(', ');
      columnSql.push(`  CONSTRAINT ${quoteMs(pkName)} PRIMARY KEY (${cols})`);
    }

    lines.push(joinColumnLines(columnSql));
    lines.push(');');
    lines.push('GO');
    lines.push('');
  }

  const fkLines: string[] = [];
  for (const relation of model.relations) {
    const pair = fkPair(relation);
    if (!pair) continue;
    const fromTable = tableById(model.tables, pair.from.table);
    const toTable = tableById(model.tables, pair.to.table);
    if (!fromTable || !toTable) continue;

    const fkName = uniqueName(`FK_${fromTable.name}_${pair.from.field}`, constraintNames);
    fkLines.push(
      `ALTER TABLE ${qualify(fromTable.schema, fromTable.name, 'mssql')}`,
      `  ADD CONSTRAINT ${quoteMs(fkName)} FOREIGN KEY (${quoteMs(pair.from.field)})`,
      `  REFERENCES ${qualify(toTable.schema, toTable.name, 'mssql')} (${quoteMs(pair.to.field)});`,
    );
  }

  if (fkLines.length > 0) {
    lines.push(...fkLines);
    lines.push('GO');
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function dbmlModelToDdl(model: DdlModel, dialect: DdlDialect, sourceName?: string): string {
  return dialect === 'postgres' ? emitPostgres(model, sourceName) : emitMssql(model, sourceName);
}
