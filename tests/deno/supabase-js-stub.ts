/*
 * supabase-js-stub — بديل محلي لـ https://esm.sh/@supabase/supabase-js@2
 * ------------------------------------------------------------
 * يُستخدم حصراً في الاختبار التشغيلي (tests/deno/send-push-runtime.test.ts)
 * عبر خريطة الاستيراد (import-map.json) لتشغيل دالة send-push الحقيقية بلا
 * شبكة ولا مشروع Supabase. يدعم فقط سطح API الذي تستخدمه الدالة:
 *   from().select().eq()/.in()/.or() → await → { data, error }
 *   from().select()…().maybeSingle() → { data, error }
 *   from().update(values).eq()…     → { data, error }  (يُسجَّل في __STUB_CALLS__)
 *   from().delete().eq()…           → { data, error }  (يُسجَّل في __STUB_CALLS__)
 *   auth.getUser(jwt)               → { data: { user }, error }
 * البيانات من __STUB_DB__ والمكالمات إلى __STUB_CALLS__ (يضبطهما الاختبار).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const DB: Record<string, Row[]> = (globalThis as any).__STUB_DB__ || {};
const CALLS: any[] = (globalThis as any).__STUB_CALLS__ || [];

class Query {
  table: string;
  filters: Array<[string, string, any]> = [];

  constructor(table: string) {
    this.table = table;
  }

  select(_cols?: string): Query {
    return this;
  }

  eq(col: string, val: any): Query {
    this.filters.push([col, "eq", val]);
    return this;
  }

  in(col: string, vals: any[]): Query {
    this.filters.push([col, "in", vals]);
    return this;
  }

  or(expr: string): Query {
    this.filters.push(["__or__", "or", expr]);
    return this;
  }

  update(values: Row): Query {
    CALLS.push({ kind: "update", table: this.table, values, filters: this.filters });
    return this;
  }

  delete(): Query {
    CALLS.push({ kind: "delete", table: this.table, filters: this.filters });
    return this;
  }

  private rows(): Row[] {
    CALLS.push({ kind: "select", table: this.table, filters: this.filters });
    let rows = DB[this.table] || [];
    for (const [col, op, val] of this.filters) {
      if (op === "eq") rows = rows.filter((r) => String(r[col]) === String(val));
      else if (op === "in") {
        const wanted = (val as any[]).map(String);
        rows = rows.filter((r) => wanted.includes(String(r[col])));
      } else if (op === "or" && this.table === "profiles") {
        rows = rows.filter((r) => r.is_admin === true || r.is_super_admin === true);
      }
    }
    return rows;
  }

  maybeSingle() {
    const rows = this.rows();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then<T>(
    onFulfilled?: (value: { data: Row[]; error: null }) => T,
    onRejected?: (reason: unknown) => T,
  ): Promise<T> {
    const result = { data: this.rows(), error: null };
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }
}

export function createClient(_url: string, _key: string, _options?: Record<string, unknown>): any {
  return {
    from: (table: string) => new Query(table),
    auth: {
      async getUser(jwt?: string) {
        const users: Record<string, Row> = (globalThis as any).__STUB_USERS__ || {};
        if (jwt && users[jwt]) return { data: { user: users[jwt] }, error: null };
        return { data: { user: null }, error: { message: "invalid jwt" } };
      },
    },
  };
}
