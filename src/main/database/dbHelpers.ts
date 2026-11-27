import { Database, SqlValue, toSqlParam } from './sqlite';

export type { SqlValue };

type Row = Record<string, string | number | bigint | Uint8Array | null>;

export function queryAll(db: Database, sql: string, params: SqlValue[] = []): Row[] {
  // node:sqlite rows have a null prototype; spread into plain objects.
  return db.prepare(sql).all(...params.map(toSqlParam)).map((row) => ({ ...row }));
}

export function queryOne(db: Database, sql: string, params: SqlValue[] = []): Row | null {
  const row = db.prepare(sql).get(...params.map(toSqlParam));
  return row ? { ...row } : null;
}

export function run(db: Database, sql: string, params: SqlValue[] = []): void {
  db.prepare(sql).run(...params.map(toSqlParam));
}

export function lastInsertId(db: Database): number {
  const row = queryOne(db, 'SELECT last_insert_rowid() AS id');
  return Number(row?.id ?? 0);
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

export function toInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}
