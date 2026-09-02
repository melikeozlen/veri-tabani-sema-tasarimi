import type { DbmlObjectKind, DbmlSqlObject } from './parseDbmlObjects';

export interface TableRefInfo {
  id: string;
  schema?: string;
  name: string;
  fullName: string;
}

export type TableObjectIndex = Map<string, Partial<Record<DbmlObjectKind, DbmlSqlObject[]>>>;

function normalizeRef(value: string): string {
  return value.replace(/[\[\]"']/g, '').trim();
}

export function resolveTableId(ref: string, tables: TableRefInfo[]): string | null {
  const normalized = normalizeRef(ref);
  if (!normalized) return null;

  const exact = tables.find(
    (table) => table.id === normalized || table.fullName === normalized,
  );
  if (exact) return exact.id;

  const bySuffix = tables.filter(
    (table) =>
      table.fullName.endsWith(`.${normalized}`) ||
      table.name.toLowerCase() === normalized.toLowerCase(),
  );
  return bySuffix.length === 1 ? bySuffix[0].id : null;
}

export function extractSqlTableRefs(sql: string): string[] {
  const refs = new Set<string>();
  const pattern =
    /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:(?<schema>[\w]+)\.)?(?<table>[\w]+)\b(?!\s*\()/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const schema = match.groups?.schema;
    const table = match.groups?.table;
    if (!table) continue;
    if (/^(select|where|on|as|inner|left|right|outer|cross|with|set|deleted|inserted)$/i.test(table)) {
      continue;
    }
    refs.add(schema ? `${schema}.${table}` : table);
  }

  return [...refs];
}

export function indexObjectsByTable(
  objects: DbmlSqlObject[],
  tables: TableRefInfo[],
  visibility: Record<DbmlObjectKind, boolean>,
): TableObjectIndex {
  const index: TableObjectIndex = new Map();

  function add(tableId: string, kind: DbmlObjectKind, object: DbmlSqlObject) {
    if (!visibility[kind]) return;
    if (!index.has(tableId)) index.set(tableId, {});
    const bucket = index.get(tableId)!;
    if (!bucket[kind]) bucket[kind] = [];
    if (!bucket[kind]!.some((item) => item.id === object.id)) {
      bucket[kind]!.push(object);
    }
  }

  for (const object of objects) {
    if (!visibility[object.kind]) continue;

    if (object.kind === 'trigger' && object.tableRef) {
      const tableId = resolveTableId(object.tableRef, tables);
      if (tableId) add(tableId, 'trigger', object);
      continue;
    }

    const refs = new Set<string>();
    if (object.tableRef) refs.add(object.tableRef);
    for (const ref of extractSqlTableRefs(object.sql)) refs.add(ref);

    for (const ref of refs) {
      const tableId = resolveTableId(ref, tables);
      if (tableId) add(tableId, object.kind, object);
    }
  }

  return index;
}

export function collectObjectTableRefs(object: DbmlSqlObject): string[] {
  const refs = new Set<string>();
  if (object.tableRef) refs.add(normalizeRef(object.tableRef));
  for (const ref of extractSqlTableRefs(object.sql)) refs.add(ref);
  return [...refs];
}

export function buildLinkedTableIdsByKind(
  objects: Partial<Record<DbmlObjectKind, DbmlSqlObject[]>> | undefined,
  tableRefs: TableRefInfo[],
): Partial<Record<DbmlObjectKind, string[]>> {
  if (!objects) return {};

  const result: Partial<Record<DbmlObjectKind, string[]>> = {};
  for (const [kind, items] of Object.entries(objects) as Array<[DbmlObjectKind, DbmlSqlObject[]]>) {
    if (!items?.length) continue;
    const ids = new Set<string>();
    for (const item of items) {
      for (const ref of collectObjectTableRefs(item)) {
        const tableId = resolveTableId(ref, tableRefs);
        if (tableId) ids.add(tableId);
      }
    }
    if (ids.size > 0) result[kind] = [...ids];
  }
  return result;
}

export function tableMatchesObjectSearch(
  objects: Partial<Record<DbmlObjectKind, DbmlSqlObject[]>> | undefined,
  normalizedSearch: string,
): boolean {
  if (!objects || normalizedSearch.length === 0) return false;
  const needle = normalizedSearch.toLocaleLowerCase('tr-TR');
  for (const list of Object.values(objects)) {
    if (!list) continue;
    for (const item of list) {
      if (
        `${item.fullName} ${item.tableRef ?? ''} ${item.kind}`
          .toLocaleLowerCase('tr-TR')
          .includes(needle)
      ) {
        return true;
      }
    }
  }
  return false;
}
