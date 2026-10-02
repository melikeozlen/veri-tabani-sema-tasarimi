import { CompilerError, importer, type ImportFormat } from '@dbml/core';

export type SqlImportDialect = 'mysql' | 'postgres' | 'mssql';

export type SqlImportDialectChoice = SqlImportDialect | 'auto';

const DATABASE_TYPE: Record<SqlImportDialect, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  mssql: 'MSSQL',
};

export function detectSqlDialect(sql: string): SqlImportDialect {
  const text = sql.toLowerCase();
  let mysql = 0;
  let postgres = 0;
  let mssql = 0;

  if (/engine\s*=\s*\w+|auto_increment|`[^`]+`|tinyint\s*\(\s*1\s*\)|mediumtext|longblob|unsigned\b/.test(text)) {
    mysql += 2;
  }
  if (/bigserial|smallserial|\bserial\b|::\w+|nextval\s*\(|timestamptz|\bjsonb\b|create\s+type\b|uuid_generate/.test(text)) {
    postgres += 2;
  }
  if (/\bgo\b|identity\s*\(|nvarchar|uniqueidentifier|sysutcdatetime|\[dbo\]|datetime2/.test(text)) {
    mssql += 2;
  }

  if (mysql >= postgres && mysql >= mssql && mysql > 0) return 'mysql';
  if (postgres >= mssql && postgres > 0) return 'postgres';
  if (mssql > 0) return 'mssql';
  return 'postgres';
}

function withProjectHeader(dbml: string, dialect: SqlImportDialect): string {
  if (/^\s*Project\s+/im.test(dbml)) return dbml;
  return `Project imported {\n  database_type: '${DATABASE_TYPE[dialect]}'\n}\n\n${dbml}`;
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
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function sqlToDbml(
  sql: string,
  dialectChoice: SqlImportDialectChoice = 'auto',
): { dbml: string; dialect: SqlImportDialect } {
  const dialect = dialectChoice === 'auto' ? detectSqlDialect(sql) : dialectChoice;
  const format = dialect as ImportFormat;
  const converted = importer.import(sql, format, { includeRecords: true });
  return {
    dbml: withProjectHeader(converted.trim(), dialect),
    dialect,
  };
}

export function isSqlFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.sql');
}
