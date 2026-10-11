// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite, so the Worker's logic can be
// exercised without the Workers runtime. It mirrors the parts of the D1 API this project uses:
// prepare().bind().first()/all()/run(), batch() as one transaction, and meta.changes.
// It is a test aid, not a replacement for running against real D1.
import { DatabaseSync } from 'node:sqlite';

export function createD1(schemaSql, path = ':memory:') {
  const db = new DatabaseSync(path);
  if (schemaSql) db.exec(schemaSql);

  const check = (params) =>
    params.map((p) => {
      if (p === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    });

  class Stmt {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Stmt(this.sql, check(params));
    }
    _isRead() {
      return /^\s*(select|with|pragma)\b/i.test(this.sql);
    }
    _exec() {
      const st = db.prepare(this.sql);
      if (this._isRead()) {
        const results = st.all(...this.params).map((r) => ({ ...r }));
        return { success: true, results, meta: { changes: 0, rows_read: results.length } };
      }
      const r = st.run(...this.params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async first(col) {
      const st = db.prepare(this.sql);
      const row = st.get(...this.params);
      if (!row) return null;
      return col ? row[col] : { ...row };
    }
    async all() {
      return this._exec();
    }
    async run() {
      return this._exec();
    }
  }

  return {
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    exec: (sql) => db.exec(sql),
    raw: db
  };
}
