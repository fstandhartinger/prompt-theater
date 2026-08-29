import pg from 'pg';
const { Pool } = pg;

export const SCENE_STATUSES = [
  'awaiting_payment', 'abandoned', 'paid', 'moderating', 'rejected',
  'queued', 'generating', 'failed', 'ready', 'playing', 'played'
];

// Statuses a visitor is allowed to see on the public feed. Everything before
// 'ready' is unpaid or unmoderated user text and must never be published.
export const PUBLIC_STATUSES = ['ready', 'playing', 'played'];

const ms = index => `($${index}::bigint * interval '1 millisecond')`;

export function createDb(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl });
  const event = (client, kind, detail) =>
    client.query('INSERT INTO events(kind,detail) VALUES($1,$2)', [kind, JSON.stringify(detail)]);

  const inTransaction = async work => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };

  return {
    pool,
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scenes (
          id serial PRIMARY KEY, prompt text NOT NULL, prompt_display text NOT NULL,
          status text NOT NULL,
          stripe_session_id text UNIQUE, amount_cents int NOT NULL, refund_id text,
          fal_request_id text, video_path text, error text,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), played_at timestamptz
        );
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS refund_needed boolean NOT NULL DEFAULT false;
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS refund_attempts int NOT NULL DEFAULT 0;
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS refund_last_attempt_at timestamptz;
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS refund_error text;
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS generate_attempts int NOT NULL DEFAULT 0;
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS play_attempts int NOT NULL DEFAULT 0;
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS customer_email text;
        ALTER TABLE scenes ADD COLUMN IF NOT EXISTS paid_at timestamptz;
        ALTER TABLE scenes DROP CONSTRAINT IF EXISTS scenes_status_check;
        ALTER TABLE scenes ADD CONSTRAINT scenes_status_check
          CHECK (status IN (${SCENE_STATUSES.map(s => `'${s}'`).join(',')}));
        CREATE TABLE IF NOT EXISTS spend_log (id serial PRIMARY KEY, day date NOT NULL, cents int NOT NULL);
        ALTER TABLE spend_log ADD COLUMN IF NOT EXISTS scene_id int;
        CREATE UNIQUE INDEX IF NOT EXISTS spend_log_scene_idx ON spend_log(scene_id) WHERE scene_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS events (id serial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb);
        CREATE INDEX IF NOT EXISTS scenes_status_created_idx ON scenes(status, created_at);
        CREATE INDEX IF NOT EXISTS scenes_refund_idx ON scenes(refund_needed, refund_id);
        CREATE INDEX IF NOT EXISTS scenes_session_idx ON scenes(stripe_session_id);
        CREATE INDEX IF NOT EXISTS spend_log_day_idx ON spend_log(day);
      `);
    },

    async transition(id, status, detail = {}, extra = {}) {
      const allowed = new Set(['error', 'refund_id', 'refund_needed', 'refund_error', 'fal_request_id',
        'video_path', 'played_at', 'generate_attempts', 'play_attempts', 'customer_email']);
      const entries = Object.entries(extra).filter(([key]) => allowed.has(key));
      const values = [status, id];
      const sets = ['status=$1', 'updated_at=now()'];
      entries.forEach(([key, value], index) => { values.push(value); sets.push(`${key}=$${index + 3}`); });
      return inTransaction(async client => {
        const result = await client.query(`UPDATE scenes SET ${sets.join(',')} WHERE id=$2 RETURNING *`, values);
        await event(client, 'scene.status', { scene_id: id, status, ...detail });
        return result.rows[0];
      });
    },

    // Proof of life for whichever process currently owns the scene. Without it the
    // reconciler below would tear work away from a healthy worker.
    async heartbeat(id) {
      await pool.query('UPDATE scenes SET updated_at=now() WHERE id=$1', [id]);
    },

    // Idempotent per scene: a retried generation must never book the budget twice.
    async reserveSpend(sceneId, cents, capCents) {
      return inTransaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('prompt-theater-daily-spend'))");
        if (sceneId != null) {
          const seen = await client.query('SELECT 1 FROM spend_log WHERE scene_id=$1', [sceneId]);
          if (seen.rows[0]) return true;
        }
        const { rows } = await client.query('SELECT COALESCE(sum(cents),0)::int total FROM spend_log WHERE day=CURRENT_DATE');
        if (rows[0].total + cents > capCents) return false;
        await client.query('INSERT INTO spend_log(day,cents,scene_id) VALUES(CURRENT_DATE,$1,$2)', [cents, sceneId]);
        await event(client, 'spend.reserved', { scene_id: sceneId, cents });
        return true;
      });
    },

    async spentToday() {
      const { rows } = await pool.query('SELECT COALESCE(sum(cents),0)::int total FROM spend_log WHERE day=CURRENT_DATE');
      return rows[0].total;
    },

    async createScene({ prompt, display, sessionId, amountCents }) {
      return inTransaction(async client => {
        const result = await client.query(
          "INSERT INTO scenes(prompt,prompt_display,status,stripe_session_id,amount_cents) VALUES($1,$2,'awaiting_payment',$3,$4) RETURNING *",
          [prompt, display, sessionId, amountCents]);
        await event(client, 'scene.created', { scene_id: result.rows[0].id });
        return result.rows[0];
      });
    },

    // Atomic payment gate: only an unpaid scene with the exact expected amount flips to
    // 'paid', and only once, no matter how often Stripe redelivers the event.
    async markSessionPaid(sessionId, amountTotal, customerEmail = null) {
      return inTransaction(async client => {
        const result = await client.query(
          `UPDATE scenes SET status='paid',paid_at=now(),updated_at=now(),customer_email=COALESCE($3,customer_email)
           WHERE stripe_session_id=$1 AND status='awaiting_payment' AND amount_cents=$2 RETURNING *`,
          [sessionId, amountTotal, customerEmail]);
        if (result.rows[0]) await event(client, 'scene.status', { scene_id: result.rows[0].id, status: 'paid' });
        return result.rows[0] || null;
      });
    },

    async abandonSession(sessionId, reason) {
      return inTransaction(async client => {
        const result = await client.query(
          `UPDATE scenes SET status='abandoned',error=$2,updated_at=now()
           WHERE stripe_session_id=$1 AND status='awaiting_payment' RETURNING *`, [sessionId, reason]);
        if (result.rows[0]) await event(client, 'scene.status', { scene_id: result.rows[0].id, status: 'abandoned', reason });
        return result.rows[0] || null;
      });
    },

    async getSceneBySession(sessionId) {
      const { rows } = await pool.query('SELECT * FROM scenes WHERE stripe_session_id=$1', [sessionId]);
      return rows[0] || null;
    },

    async getScene(id) {
      const { rows } = await pool.query('SELECT * FROM scenes WHERE id=$1', [id]);
      return rows[0] || null;
    },

    // Claims the next scene that owes the customer work: freshly paid, or stranded in an
    // intermediate state by a crash/deploy. Returns { scene, resumed }.
    async claimSceneForProcessing(staleMs) {
      return inTransaction(async client => {
        const { rows } = await client.query(
          `SELECT * FROM scenes
           WHERE status='paid'
              OR (status IN ('moderating','queued','generating') AND updated_at < now() - ${ms(1)})
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`, [staleMs]);
        const scene = rows[0];
        if (!scene) return null;
        const resumed = scene.status === 'generating';
        const next = resumed ? 'generating' : 'moderating';
        const updated = await client.query(
          'UPDATE scenes SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [scene.id, next]);
        if (scene.status !== 'paid') {
          await event(client, 'scene.recovered', { scene_id: scene.id, from: scene.status, to: next });
        } else {
          await event(client, 'scene.status', { scene_id: scene.id, status: next });
        }
        return { scene: updated.rows[0], resumed };
      });
    },

    // A scene stuck in 'playing' means the compositor that owned it died mid-broadcast.
    async recoverStalePlaying(staleMs) {
      return inTransaction(async client => {
        const { rows } = await client.query(
          `UPDATE scenes SET status='ready',updated_at=now()
           WHERE status='playing' AND video_path IS NOT NULL AND updated_at < now() - ${ms(1)} RETURNING id`, [staleMs]);
        for (const row of rows) await event(client, 'scene.recovered', { scene_id: row.id, from: 'playing', to: 'ready' });
        return rows.map(row => row.id);
      });
    },

    async claimReadyScene() {
      return inTransaction(async client => {
        const { rows } = await client.query(
          "SELECT * FROM scenes WHERE status='ready' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1");
        if (!rows[0]) return null;
        const updated = await client.query(
          "UPDATE scenes SET status='playing',updated_at=now() WHERE id=$1 RETURNING *", [rows[0].id]);
        await event(client, 'scene.status', { scene_id: rows[0].id, status: 'playing' });
        return updated.rows[0];
      });
    },

    // Money the customer is owed. Retried with backoff until refund_id is set.
    async claimRefundPending(backoffMs) {
      return inTransaction(async client => {
        const { rows } = await client.query(
          `SELECT * FROM scenes
           WHERE refund_needed AND refund_id IS NULL
             AND (refund_last_attempt_at IS NULL OR refund_last_attempt_at < now() - ${ms(1)})
           ORDER BY refund_attempts, updated_at FOR UPDATE SKIP LOCKED LIMIT 1`, [backoffMs]);
        if (!rows[0]) return null;
        const updated = await client.query(
          'UPDATE scenes SET refund_attempts=refund_attempts+1,refund_last_attempt_at=now() WHERE id=$1 RETURNING *',
          [rows[0].id]);
        return updated.rows[0];
      });
    },

    async settleRefund(id, refundId) {
      return inTransaction(async client => {
        const result = await client.query(
          'UPDATE scenes SET refund_id=$2,refund_needed=false,refund_error=NULL,updated_at=now() WHERE id=$1 RETURNING *',
          [id, refundId]);
        await event(client, 'refund.settled', { scene_id: id, refund_id: refundId });
        return result.rows[0];
      });
    },

    // Nothing was ever charged (no payment provider / no payment intent): stop retrying,
    // but keep the reason on the row so it is auditable.
    async dropRefund(id, reason) {
      return inTransaction(async client => {
        const result = await client.query(
          'UPDATE scenes SET refund_needed=false,refund_error=$2,updated_at=now() WHERE id=$1 RETURNING *', [id, reason]);
        await event(client, 'refund.dropped', { scene_id: id, reason });
        return result.rows[0];
      });
    },

    async recordRefundFailure(id, message) {
      await pool.query('UPDATE scenes SET refund_error=$2 WHERE id=$1', [id, message]);
      await pool.query('INSERT INTO events(kind,detail) VALUES($1,$2)',
        ['refund.failed', JSON.stringify({ scene_id: id, error: message })]);
    },

    async countUnsettledRefunds() {
      const { rows } = await pool.query(
        'SELECT count(*)::int n FROM scenes WHERE refund_needed AND refund_id IS NULL');
      return rows[0].n;
    },

    async listPublicScenes(limit = 20) {
      const { rows } = await pool.query(
        `SELECT * FROM scenes WHERE status = ANY($1) ORDER BY created_at DESC LIMIT $2`, [PUBLIC_STATUSES, limit]);
      return rows;
    },

    async listReplayCandidates(limit = 5) {
      const { rows } = await pool.query(
        "SELECT * FROM scenes WHERE status='played' AND video_path IS NOT NULL ORDER BY played_at DESC LIMIT $1", [limit]);
      return rows;
    },

    async countScenesToday() {
      const { rows } = await pool.query(
        "SELECT count(*)::int n FROM scenes WHERE created_at::date=CURRENT_DATE AND status = ANY($1)", [PUBLIC_STATUSES]);
      return rows[0].n;
    },

    async countReady() {
      const { rows } = await pool.query("SELECT count(*)::int n FROM scenes WHERE status='ready'");
      return rows[0].n;
    },

    async listExpiredVideos(retentionDays, keepRecent) {
      const { rows } = await pool.query(
        `SELECT * FROM scenes
         WHERE status='played' AND video_path IS NOT NULL AND played_at < now() - ($1::int * interval '1 day')
           AND id NOT IN (SELECT id FROM scenes WHERE status='played' AND video_path IS NOT NULL ORDER BY played_at DESC LIMIT $2)
         LIMIT 50`, [retentionDays, keepRecent]);
      return rows;
    },

    async forgetVideo(id) {
      await pool.query('UPDATE scenes SET video_path=NULL WHERE id=$1', [id]);
    },

    async ping() { await pool.query('SELECT 1'); },

    // Session-scoped advisory lock on a dedicated connection: exactly one process in the
    // whole deployment may hold it, which is what keeps a single RTMP publisher alive.
    async acquireLock(name) {
      const client = await pool.connect();
      try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [name]);
        if (!rows[0].ok) { client.release(); return null; }
      } catch (error) { client.release(); throw error; }
      return {
        async release() {
          try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]); } catch {}
          finally { client.release(); }
        }
      };
    },

    close: () => pool.end()
  };
}
