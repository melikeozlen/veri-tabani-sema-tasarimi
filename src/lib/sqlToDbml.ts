import { CompilerError, importer, type ImportFormat } from '@dbml/core';

export type SqlImportDialect = 'mysql' | 'postgres' | 'mssql';

export type SqlImportDialectChoice = SqlImportDialect | 'auto';

type ParserFormat = ImportFormat | 'mysqlLegacy';

const DATABASE_TYPE: Record<SqlImportDialect, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  mssql: 'MSSQL',
};

const LEGACY_FORMAT: Record<SqlImportDialect, ParserFormat> = {
  mysql: 'mysqlLegacy',
  postgres: 'postgresLegacy',
  mssql: 'mssqlLegacy',
};

const MODERN_FALLBACK_MAX_CHARS = 80_000;

const SCHEMA_BATCH_START =
  /^(CREATE\s+(OR\s+ALTER\s+)?TABLE|ALTER\s+TABLE|CREATE\s+TYPE)\b/i;

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*--[^\n]*$/gm, ' ');
}

function stripCurlyEscapes(sql: string): string {
  let prev = '';
  let text = sql;
  while (prev !== text) {
    prev = text;
    text = text.replace(/\{[^{}]*\}/g, ' ');
  }
  return text;
}

function hasGoBatches(sql: string): boolean {
  return /^\s*GO\s*;?\s*$/im.test(sql) || /\n\s*GO\s*;?\s*\n/i.test(sql);
}

function splitGoBatches(sql: string): string[] {
  return sql
    .split(/^\s*GO\s*;?\s*$/im)
    .map((batch) => batch.trim())
    .filter(Boolean);
}

function keepSchemaBatches(sql: string): string {
  return splitGoBatches(sql)
    .filter((batch) => SCHEMA_BATCH_START.test(batch))
    .join('\nGO\n');
}

/**
 * keyword + balanced (...) bloğunu siler (iç içe parantez destekli).
 */
function removeBalancedCalls(sql: string, keyword: RegExp): string {
  let text = sql;
  const flags = keyword.flags.includes('i') ? 'gi' : 'g';
  const re = new RegExp(`${keyword.source}\\s*\\(`, flags);
  for (;;) {
    re.lastIndex = 0;
    const match = re.exec(text);
    if (!match) break;
    const openIdx = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = openIdx; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    text = `${text.slice(0, match.index)}${text.slice(end + 1)}`;
  }
  return text;
}

/**
 * Legacy MSSQL parser'ın takıldığı ifadeleri sadeleştir.
 * DEFAULT (fn(...)), computed AS (...), WITH (...) index options vb.
 */
function simplifyMssqlDdl(sql: string): string {
  let text = sql;

  // Computed columns: col AS (expr) [PERSISTED]
  text = removeBalancedCalls(text, /(?:,\s*)?(?:\[[^\]]+\]|"[^"]+"|\w+)\s+AS/gi);
  text = text.replace(/\bPERSISTED\b/gi, '');

  // DEFAULT (complex expr) / DEFAULT fn(...)
  text = removeBalancedCalls(text, /\bDEFAULT/gi);
  text = text.replace(/\bDEFAULT\s+(?:N)?'(?:''|[^'])*'/gi, '');
  text = text.replace(/\bDEFAULT\s+(?:N)?"(?:""|[^"])*"/gi, '');
  text = text.replace(/\bDEFAULT\s+(?:NULL|TRUE|FALSE|\d+(?:\.\d+)?)/gi, '');

  // NOT FOR REPLICATION
  text = text.replace(/\bNOT\s+FOR\s+REPLICATION\b/gi, '');

  // CONSTRAINT ... WITH (PAD_INDEX = OFF, ...)
  text = removeBalancedCalls(text, /\bWITH/gi);

  // ON [PRIMARY] / TEXTIMAGE_ON [PRIMARY] filegroup
  text = text.replace(/\bTEXTIMAGE_ON\s+(?:\[[^\]]+\]|\w+)/gi, '');
  text = text.replace(/\bON\s+(?:\[[^\]]+\]|\w+)(?=\s*(?:;|$|GO|TEXTIMAGE_ON|WITH))/gi, '');

  // Trailing commas before ) from removals
  text = text.replace(/,(\s*)\)/g, '$1)');

  return text;
}

function stripNonSchemaStatements(sql: string): string {
  let text = sql;

  text = text.replace(
    /^\s*(EXEC(UTE)?)\b[\s\S]*?(?=^\s*GO\s*;?\s*$|;?\s*$)/gim,
    '\n',
  );

  text = text.replace(
    /\bCREATE\s+(OR\s+ALTER\s+)?(PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW|INDEX)\b[\s\S]*?(?=^\s*GO\s*;?\s*$|\bCREATE\s+(OR\s+ALTER\s+)?|\bALTER\s+TABLE\b|$)/gim,
    '\n',
  );

  text = text.replace(
    /^\s*(INSERT|UPDATE|DELETE|MERGE|PRINT|USE|SET|GRANT|REVOKE|DENY|BACKUP|RESTORE|TRUNCATE)\b[\s\S]*?(?=^\s*GO\s*;?\s*$|;?\s*$)/gim,
    '\n',
  );

  // Constraint enable/disable — yalnızca tek satır (sonraki FK ALTER'larını yutmasın)
  text = text.replace(
    /^\s*ALTER\s+TABLE\s+.+\s+(?:WITH\s+(?:NO)?CHECK\s+)?(?:NO)?CHECK\s+CONSTRAINT\s+\S+\s*;?\s*$/gim,
    '\n',
  );

  return text;
}

const SQL_OBJECT_START =
  /^\s*CREATE\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(PROC|PROCEDURE|FUNCTION|VIEW|TRIGGER)\b/i;

const MAX_SQL_OBJECTS = 400;
const MAX_SQL_OBJECTS_CHARS = 1_500_000;

function normalizeObjectSql(sql: string): string {
  return sql
    .trim()
    .replace(/\s*GO\s*;?\s*$/i, '')
    .trim();
}

/**
 * View / function / procedure / trigger tanımlarını çıkar.
 * DBML sonuna ham SQL olarak eklenir (sağ panel → Veritabanı nesneleri).
 */
export function extractSqlObjects(sql: string): string[] {
  const cleaned = stripCurlyEscapes(stripComments(sql.replace(/^\uFEFF/, '')));
  const objects: string[] = [];
  let totalChars = 0;

  function push(raw: string) {
    const text = normalizeObjectSql(raw);
    if (!text || !SQL_OBJECT_START.test(text)) return;
    if (objects.length >= MAX_SQL_OBJECTS) return;
    if (totalChars + text.length > MAX_SQL_OBJECTS_CHARS) return;
    objects.push(text);
    totalChars += text.length;
  }

  if (hasGoBatches(cleaned)) {
    for (const batch of splitGoBatches(cleaned)) {
      if (SQL_OBJECT_START.test(batch)) push(batch);
    }
    return objects;
  }

  const parts = cleaned.split(
    /(?=^\s*CREATE\s+(?:OR\s+(?:ALTER|REPLACE)\s+)?(?:PROC|PROCEDURE|FUNCTION|VIEW|TRIGGER)\b)/gim,
  );
  for (const part of parts) {
    const trimmed = part.trim();
    if (!SQL_OBJECT_START.test(trimmed)) continue;
    // Sonraki CREATE TABLE / ALTER TABLE'dan kes
    const cut = trimmed.search(
      /\n\s*(?:CREATE\s+(?:OR\s+ALTER\s+)?TABLE|ALTER\s+TABLE)\b/i,
    );
    push(cut >= 0 ? trimmed.slice(0, cut) : trimmed);
  }

  return objects;
}

function appendSqlObjects(dbml: string, objects: string[]): string {
  if (objects.length === 0) return dbml;
  const body = objects.join('\n\nGO\n\n');
  return `${dbml.trim()}\n\n// --- Veritabanı nesneleri (SQL import) ---\n\n${body}\n`;
}

function normalizeIdentToken(raw: string): string {
  return raw.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').trim();
}

function normalizeQualifiedName(raw: string): string {
  return raw
    .split('.')
    .map((part) => normalizeIdentToken(part.trim()))
    .filter(Boolean)
    .join('.');
}

function normalizeColumnList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => normalizeIdentToken(part.trim()))
    .filter(Boolean);
}

interface ExtractedFk {
  name?: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

const TABLE_IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|\w+)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|\w+))?`;

/**
 * SSMS dump'larındaki FK'leri regex ile çıkar.
 * Legacy parser WITH CHECK ADD CONSTRAINT bilgisini çoğu zaman sessizce atar.
 */
export function extractForeignKeys(sql: string): ExtractedFk[] {
  const fks: ExtractedFk[] = [];
  const seen = new Set<string>();

  function push(fk: ExtractedFk) {
    if (fk.fromColumns.length === 0 || fk.fromColumns.length !== fk.toColumns.length) return;
    const key = `${fk.fromTable}:${fk.fromColumns.join(',')}>${fk.toTable}:${fk.toColumns.join(',')}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    fks.push(fk);
  }

  const alterFk = new RegExp(
    String.raw`ALTER\s+TABLE\s+(${TABLE_IDENT})\s+(?:WITH\s+(?:NO)?CHECK\s+)?ADD\s+(?:CONSTRAINT\s+(${TABLE_IDENT})\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(${TABLE_IDENT})\s*\(([^)]+)\)`,
    'gi',
  );

  let match: RegExpExecArray | null;
  while ((match = alterFk.exec(sql)) !== null) {
    push({
      name: match[2] ? normalizeQualifiedName(match[2]) : undefined,
      fromTable: normalizeQualifiedName(match[1]),
      fromColumns: normalizeColumnList(match[3]),
      toTable: normalizeQualifiedName(match[4]),
      toColumns: normalizeColumnList(match[5]),
    });
  }

  // CREATE TABLE içi: CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...
  const inlineFk = new RegExp(
    String.raw`CONSTRAINT\s+(${TABLE_IDENT})\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(${TABLE_IDENT})\s*\(([^)]+)\)`,
    'gi',
  );
  while ((match = inlineFk.exec(sql)) !== null) {
    const ahead = sql.slice(Math.max(0, match.index - 2500), match.index);
    const tableMatch = [
      ...ahead.matchAll(
        new RegExp(String.raw`CREATE\s+TABLE\s+(${TABLE_IDENT})\s*\(`, 'gi'),
      ),
    ].pop();
    if (!tableMatch) continue;
    push({
      name: normalizeQualifiedName(match[1]),
      fromTable: normalizeQualifiedName(tableMatch[1]),
      fromColumns: normalizeColumnList(match[2]),
      toTable: normalizeQualifiedName(match[3]),
      toColumns: normalizeColumnList(match[4]),
    });
  }

  // Kolon seviyesi: user_id int REFERENCES dbo.users(id)
  const columnFk = new RegExp(
    String.raw`(?:\[[^\]]+\]|"[^"]+"|\w+)\s+[^\n,]*?\bREFERENCES\s+(${TABLE_IDENT})\s*\(([^)]+)\)`,
    'gi',
  );
  while ((match = columnFk.exec(sql)) !== null) {
    const lineStart = sql.lastIndexOf('\n', match.index) + 1;
    const prefix = sql.slice(lineStart, match.index);
    const colMatch = prefix.match(/(?:\[[^\]]+\]|"[^"]+"|\w+)\s*$/);
    if (!colMatch) continue;
    const ahead = sql.slice(Math.max(0, match.index - 2500), match.index);
    const tableMatch = [
      ...ahead.matchAll(
        new RegExp(String.raw`CREATE\s+TABLE\s+(${TABLE_IDENT})\s*\(`, 'gi'),
      ),
    ].pop();
    if (!tableMatch) continue;
    push({
      fromTable: normalizeQualifiedName(tableMatch[1]),
      fromColumns: [normalizeIdentToken(colMatch[0])],
      toTable: normalizeQualifiedName(match[1]),
      toColumns: normalizeColumnList(match[2]),
    });
  }

  return fks;
}

function fkNameToDbml(name: string | undefined): string {
  if (!name) return '';
  const cleaned = name.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned ? ` ${cleaned}` : '';
}

function appendExtractedRefs(dbml: string, fks: ExtractedFk[]): string {
  if (fks.length === 0) return dbml;

  const existing = new Set<string>();
  for (const match of dbml.matchAll(/Ref(?:\s+\w+)?\s*:\s*([^\n]+)/gi)) {
    existing.add(match[1].replace(/\s+/g, ' ').trim().toLowerCase());
  }

  const lines: string[] = [];
  for (const fk of fks) {
    for (let index = 0; index < fk.fromColumns.length; index += 1) {
      // 1 taraf (referenced) < N taraf (FK kolonunun olduğu tablo)
      const expr = `${fk.toTable}.${fk.toColumns[index]} < ${fk.fromTable}.${fk.fromColumns[index]}`;
      const key = expr.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      const nameSuffix = fk.fromColumns.length === 1 ? fkNameToDbml(fk.name) : '';
      lines.push(`Ref${nameSuffix}:${expr}`);
    }
  }

  if (lines.length === 0) return dbml;
  return `${dbml.trim()}\n\n${lines.join('\n')}\n`;
}

/** Legacy parser için FK sözdizimini sadeleştir; Ref'ler ayrıca regex ile eklenir. */
function normalizeForeignKeySyntax(sql: string): string {
  let text = sql;
  text = text.replace(/\bWITH\s+(NO)?CHECK\b/gi, '');
  text = text.replace(/FOREIGN\s+KEY\s*\(\s*/gi, 'FOREIGN KEY (');
  text = text.replace(/REFERENCES\s+([^\s(]+)\s*\(\s*/gi, 'REFERENCES $1 (');
  text = text.replace(/\bON\s+(DELETE|UPDATE)\s+(NO\s+ACTION|CASCADE|SET\s+NULL|SET\s+DEFAULT)/gi, '');

  // Önce tüm ALTER TABLE ... FOREIGN KEY batch'lerini sil
  text = text.replace(
    /^\s*ALTER\s+TABLE\s+.+\bFOREIGN\s+KEY\b[\s\S]*?(?=^\s*GO\s*;?\s*$|$)/gim,
    '\n',
  );

  // CREATE TABLE içi named FK — tablo parse'ını bozmasın
  text = text.replace(
    /,?\s*CONSTRAINT\s+(?:\[[^\]]+\]|"[^"]+"|\w+)\s+FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+(?:\[[^\]]+\]|"[^"]+"|\w+)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|\w+))?\s*\([^)]*\)/gi,
    '',
  );

  // Boş kalan ALTER ... ADD artıkları
  text = text.replace(/^\s*ALTER\s+TABLE\s+\S+(?:\s*\.\s*\S+)?\s+ADD\s*;?\s*$/gim, '\n');

  return text;
}

export function preprocessSqlForSchema(sql: string): string {
  let text = sql.replace(/^\uFEFF/, '');
  text = stripComments(text);
  text = stripCurlyEscapes(text);
  text = stripNonSchemaStatements(text);
  text = normalizeForeignKeySyntax(text);

  if (hasGoBatches(text)) {
    text = keepSchemaBatches(text);
  }

  text = simplifyMssqlDdl(text);
  text = text.replace(/(^\s*GO\s*;?\s*$\n?)+/gim, 'GO\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function detectSqlDialect(sql: string): SqlImportDialect {
  const sample = sql.length > 200_000 ? sql.slice(0, 200_000) : sql;
  const text = sample.toLowerCase();
  let mysql = 0;
  let postgres = 0;
  let mssql = 0;

  if (/engine\s*=\s*\w+|auto_increment|`[^`]+`|tinyint\s*\(\s*1\s*\)|mediumtext|longblob|unsigned\b/.test(text)) {
    mysql += 2;
  }
  if (/bigserial|smallserial|\bserial\b|::\w+|nextval\s*\(|timestamptz|\bjsonb\b|create\s+type\b|uuid_generate/.test(text)) {
    postgres += 2;
  }
  if (/^\s*go\s*;?\s*$/im.test(sample) || /\n\s*go\s*;?\s*\n/i.test(sample)) {
    mssql += 4;
  }
  if (/identity\s*\(|nvarchar|uniqueidentifier|sysutcdatetime|\[dbo\]|datetime2|create\s+or\s+alter\b/.test(text)) {
    mssql += 2;
  }

  if (mssql >= mysql && mssql >= postgres && mssql > 0) return 'mssql';
  if (mysql >= postgres && mysql > 0) return 'mysql';
  if (postgres > 0) return 'postgres';
  return 'postgres';
}

function withProjectHeader(dbml: string, dialect: SqlImportDialect): string {
  if (/^\s*Project\s+/im.test(dbml)) return dbml;
  return `Project imported {\n  database_type: '${DATABASE_TYPE[dialect]}'\n}\n\n${dbml}`;
}

/** Görüntüleyici için "dbo"."users" → dbo.users gibi sadeleştir. */
function normalizeDbmlIdentifiers(dbml: string): string {
  return dbml.replace(/"((?:\\.|[^"\\])*)"/g, (_, raw: string) => {
    const value = raw.replace(/\\"/g, '"');
    if (/^[A-Za-z_][\w]*$/.test(value)) return value;
    if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(value)) return value;
    return `"${raw}"`;
  });
}

function diagnosticMessage(diag: { message?: string; text?: string }): string {
  return diag.message || diag.text || 'Parse error';
}

export function formatSqlImportError(error: unknown): string {
  if (error instanceof CompilerError && Array.isArray(error.diags) && error.diags.length > 0) {
    return error.diags
      .slice(0, 3)
      .map((diag) => {
        const msg = diagnosticMessage(diag as { message?: string; text?: string });
        const line = diag.location?.start?.line;
        return line != null ? `L${line}: ${msg}` : msg;
      })
      .join(' · ');
  }
  if (error && typeof error === 'object' && 'type' in error && (error as { type?: string }).type === 'ParsimmonError') {
    const result = (error as {
      result?: { index?: { line?: number }; expected?: string[] };
    }).result;
    const line = result?.index?.line;
    const expected = result?.expected?.slice(0, 4).join(', ');
    if (line != null) {
      return expected
        ? `L${line}: Expected ${expected} but unexpected token found.`
        : `L${line}: SQL parse hatası`;
    }
  }
  if (error instanceof Error && error.message) {
    const match = /Expected ([^\n]+) but "([^"]+)" found/i.exec(error.message);
    if (match) return `Expected ${match[1]} but "${match[2]}" found.`;
    return error.message;
  }
  return String(error);
}

function looksLikeGoError(error: unknown): boolean {
  const text = formatSqlImportError(error).toLowerCase();
  return text.includes("'go'") || /\bgo\b/.test(text);
}

function withSilencedConsole<T>(fn: () => T): T {
  const error = console.error;
  const warn = console.warn;
  const log = console.log;
  console.error = () => undefined;
  console.warn = () => undefined;
  console.log = () => undefined;
  try {
    return fn();
  } finally {
    console.error = error;
    console.warn = warn;
    console.log = log;
  }
}

function importWithFormat(sql: string, format: ParserFormat): string {
  return withSilencedConsole(() =>
    importer.import(sql, format as ImportFormat, { includeRecords: false }),
  );
}

function tryImportOnce(sql: string, dialect: SqlImportDialect): string {
  try {
    return importWithFormat(sql, LEGACY_FORMAT[dialect]);
  } catch (legacyError) {
    if (sql.length > MODERN_FALLBACK_MAX_CHARS) throw legacyError;
    try {
      return importWithFormat(sql, dialect);
    } catch {
      throw legacyError;
    }
  }
}

/**
 * Tek batch başarısız olsa bile diğer tabloları kurtar.
 * Büyük SSMS dump'larında desteklenmeyen 1 ifade tüm import'u düşürmesin.
 */
function tryImportResilient(sql: string, dialect: SqlImportDialect): string {
  try {
    return tryImportOnce(sql, dialect);
  } catch (wholeError) {
    const batches = hasGoBatches(sql) ? splitGoBatches(sql) : splitCreateAlterChunks(sql);
    if (batches.length <= 1) throw wholeError;

    const parts: string[] = [];
    let ok = 0;
    for (const batch of batches) {
      if (!SCHEMA_BATCH_START.test(batch) && !/^(CREATE|ALTER)\b/i.test(batch)) continue;
      try {
        const dbml = tryImportOnce(batch, dialect).trim();
        if (dbml) {
          parts.push(dbml);
          ok += 1;
        }
      } catch {
        // Bu batch'i atla, devam et
      }
    }

    if (ok === 0) throw wholeError;
    return parts.join('\n\n');
  }
}

/** GO yoksa CREATE/ALTER bloklarını kabaca ayır. */
function splitCreateAlterChunks(sql: string): string[] {
  const chunks: string[] = [];
  const re = /(?=^\s*(?:CREATE\s+(?:OR\s+ALTER\s+)?TABLE|ALTER\s+TABLE)\b)/gim;
  const parts = sql.split(re).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (SCHEMA_BATCH_START.test(part)) chunks.push(part);
  }
  return chunks.length > 0 ? chunks : [sql];
}

function candidateDialects(preferred: SqlImportDialect, sql: string): SqlImportDialect[] {
  const list: SqlImportDialect[] = [preferred];
  if (preferred !== 'mssql' && (/\bgo\b/i.test(sql) || /\bnvarchar\b|\bidentity\s*\(/i.test(sql))) {
    list.push('mssql');
  }
  return list;
}

export const MAX_SQL_IMPORT_CHARS = 6_000_000;

/** SSMS dump'ları sıkça UTF-16 LE BOM ile gelir; FileReader UTF-8 sanırsa FK/tablo kaybı olur. */
export function decodeSqlBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/, '');
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/, '');
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  }

  const sample = Math.min(bytes.length, 4000);
  let nullOdd = 0;
  let nullEven = 0;
  for (let index = 0; index < sample; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) nullEven += 1;
    else nullOdd += 1;
  }
  if (nullOdd > sample * 0.25 && nullOdd > nullEven * 2) {
    return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/, '');
  }
  if (nullEven > sample * 0.25 && nullEven > nullOdd * 2) {
    return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/, '');
  }

  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

export function sqlToDbml(
  sql: string,
  dialectChoice: SqlImportDialectChoice = 'auto',
): { dbml: string; dialect: SqlImportDialect } {
  if (sql.length > MAX_SQL_IMPORT_CHARS) {
    throw new Error(
      `SQL dosyası çok büyük (${Math.round(sql.length / 1_000_000)} MB). En fazla ~${Math.round(MAX_SQL_IMPORT_CHARS / 1_000_000)} MB desteklenir.`,
    );
  }

  // FK'leri temizlemeden ÖNCE çıkar (CHECK CONSTRAINT strip vb. bozmasın)
  const cleanedSource = stripCurlyEscapes(stripComments(sql.replace(/^\uFEFF/, '')));
  const extractedFks = extractForeignKeys(cleanedSource);
  const extractedObjects = extractSqlObjects(cleanedSource);

  const prepared = preprocessSqlForSchema(sql);
  if (!prepared.trim()) {
    throw new Error('Şema bulunamadı. Dosyada CREATE TABLE / ALTER TABLE ifadesi olmalı.');
  }

  const preferred = dialectChoice === 'auto' ? detectSqlDialect(sql) : dialectChoice;
  const candidates = candidateDialects(preferred, prepared);

  let lastError: unknown;
  for (const dialect of candidates) {
    try {
      const converted = tryImportResilient(prepared, dialect);
      if (!converted.trim()) {
        throw new Error('DBML üretilemedi (boş çıktı).');
      }
      const normalized = normalizeDbmlIdentifiers(converted.trim());
      const withRefs = appendExtractedRefs(normalized, extractedFks);
      const withObjects = appendSqlObjects(withRefs, extractedObjects);
      return {
        dbml: withProjectHeader(withObjects, dialect),
        dialect,
      };
    } catch (error) {
      lastError = error;
      if (looksLikeGoError(error) && dialect !== 'mssql') continue;
      if (candidates.length > 1 && dialect !== candidates[candidates.length - 1]) continue;
      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(formatSqlImportError(lastError));
}

export function isSqlFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.sql');
}
