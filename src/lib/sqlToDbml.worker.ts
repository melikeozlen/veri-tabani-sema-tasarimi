import {
  detectSqlDialect,
  formatSqlImportError,
  sqlToDbml,
  type SqlImportDialect,
} from './sqlToDbml';

export type SqlWorkerRequest = {
  id: number;
  sql: string;
};

export type SqlWorkerResponse =
  | { id: number; type: 'detected'; dialect: SqlImportDialect }
  | { id: number; type: 'done'; dbml: string; dialect: SqlImportDialect }
  | { id: number; type: 'error'; message: string };

self.onmessage = (event: MessageEvent<SqlWorkerRequest>) => {
  const { id, sql } = event.data;
  try {
    const guessed = detectSqlDialect(sql);
    const detected: SqlWorkerResponse = { id, type: 'detected', dialect: guessed };
    self.postMessage(detected);

    const result = sqlToDbml(sql, 'auto');
    const done: SqlWorkerResponse = {
      id,
      type: 'done',
      dbml: result.dbml,
      dialect: result.dialect,
    };
    self.postMessage(done);
  } catch (error) {
    const failed: SqlWorkerResponse = {
      id,
      type: 'error',
      message: formatSqlImportError(error),
    };
    self.postMessage(failed);
  }
};
