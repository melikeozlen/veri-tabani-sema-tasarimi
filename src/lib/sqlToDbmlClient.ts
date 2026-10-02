import type { SqlImportDialect } from './sqlToDbml';
import type { SqlWorkerRequest, SqlWorkerResponse } from './sqlToDbml.worker';

type ConvertOptions = {
  onDetected?: (dialect: SqlImportDialect) => void;
  signal?: AbortSignal;
};

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./sqlToDbml.worker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return worker;
}

function resetWorker() {
  worker?.terminate();
  worker = null;
}

export function convertSqlInWorker(
  sql: string,
  options: ConvertOptions = {},
): Promise<{ dbml: string; dialect: SqlImportDialect }> {
  const id = nextId++;
  const active = getWorker();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      active.removeEventListener('message', onMessage);
      active.removeEventListener('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('SQL dönüşümü iptal edildi.'));
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      resetWorker();
      reject(new Error(event.message || 'SQL worker hatası'));
    };

    const onMessage = (event: MessageEvent<SqlWorkerResponse>) => {
      const data = event.data;
      if (!data || data.id !== id) return;

      if (data.type === 'detected') {
        options.onDetected?.(data.dialect);
        return;
      }

      cleanup();
      if (data.type === 'done') {
        resolve({ dbml: data.dbml, dialect: data.dialect });
        return;
      }
      reject(new Error(data.message));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });
    active.addEventListener('message', onMessage);
    active.addEventListener('error', onError);

    const request: SqlWorkerRequest = { id, sql };
    active.postMessage(request);
  });
}
