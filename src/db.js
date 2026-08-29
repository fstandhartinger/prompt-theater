import pg from 'pg';
const { Pool } = pg;

export function createDb(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    pool,
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scenes (
          id serial PRIMARY KEY, prompt text NOT NULL, prompt_display text NOT NULL,
          status text NOT NULL CHECK (status IN ('awaiting_payment','moderating','rejected','queued','generating','failed','ready','playing','played')),
          stripe_session_id text UNIQUE, amount_cents int NOT NULL, refund_id text,
          fal_request_id text, video_path text, error text,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), played_at timestamptz
        );
        CREATE TABLE IF NOT EXISTS spend_log (id serial PRIMARY KEY, day date NOT NULL, cents int NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id serial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb);
        CREATE INDEX IF NOT EXISTS scenes_status_created_idx ON scenes(status, created_at);
        CREATE INDEX IF NOT EXISTS spend_log_day_idx ON spend_log(day);
      `);
      const recovered = await pool.query("UPDATE scenes SET status='ready',updated_at=now() WHERE status='playing' AND video_path IS NOT NULL RETURNING id");
      for (const row of recovered.rows) await pool.query('INSERT INTO events(kind,detail) VALUES($1,$2)', ['scene.recovered', JSON.stringify({ scene_id: row.id, from: 'playing', to: 'ready' })]);
    },
    async transition(id, status, detail = {}, extra = {}) {
      const allowed = new Set(['error','refund_id','fal_request_id','video_path','played_at']);
      const entries = Object.entries(extra).filter(([key]) => allowed.has(key));
      const values = [status, id];
      const sets = ['status=$1', 'updated_at=now()'];
      entries.forEach(([key, value], index) => { values.push(value); sets.push(`${key}=$${index + 3}`); });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE scenes SET ${sets.join(',')} WHERE id=$2 RETURNING *`, values);
        await client.query('INSERT INTO events(kind,detail) VALUES($1,$2)', ['scene.status', JSON.stringify({ scene_id: id, status, ...detail })]);
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
    async reserveSpend(sceneId, cents, capCents) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('prompt-theater-daily-spend'))");
        const { rows } = await client.query('SELECT COALESCE(sum(cents),0)::int total FROM spend_log WHERE day=CURRENT_DATE');
        if (rows[0].total + cents > capCents) { await client.query('ROLLBACK'); return false; }
        await client.query('INSERT INTO spend_log(day,cents) VALUES(CURRENT_DATE,$1)', [cents]);
        await client.query('INSERT INTO events(kind,detail) VALUES($1,$2)', ['spend.reserved', JSON.stringify({ scene_id: sceneId, cents })]);
        await client.query('COMMIT'); return true;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
    close: () => pool.end()
  };
}

export const withinSpendCap = (spentCents, nextCents, capCents) => spentCents + nextCents <= capCents;
