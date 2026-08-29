import { Database, SqlValue } from 'sql.js';

export function queryAll(db: Database, sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Record<string, SqlValue>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, SqlValue>);
  }
  stmt.free();
  return rows;
}

export function queryOne(db: Database, sql: string, params: SqlValue[] = []): Record<string, SqlValue> | null {
  const rows = queryAll(db, sql, params);
  return rows[0] ?? null;
}

export function run(db: Database, sql: string, params: SqlValue[] = []): void {
  db.run(sql, params);
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
