import path from 'node:path';

const int = (name, fallback) => {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const bool = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
};

export function config() {
  const dataDir = process.env.DATA_DIR || '/data';
  const hlsBase = (process.env.HLS_INTERNAL_BASE || 'http://127.0.0.1:8888').replace(/\/$/, '');
  return {
    port: int('PORT', 3000), databaseUrl: process.env.DATABASE_URL,
    falKey: process.env.FAL_KEY || '', falModel: process.env.FAL_MODEL || 'minimax/h3-max/text-to-video',
    stripeKey: process.env.STRIPE_SECRET_KEY || '', webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    priceCents: int('STRIPE_PRICE_USD', 400), automaticTax: bool('STRIPE_AUTOMATIC_TAX', true),
    publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
    sceneSeconds: int('SCENE_SECONDS', 15), maxDailySpendUsd: Number(process.env.MAX_DAILY_SPEND_USD || 20),
    openrouterKey: process.env.OPENROUTER_API_KEY || '', moderationModel: process.env.MODERATION_MODEL || 'z-ai/glm-5.3-flash',
    moderationFake: bool('MODERATION_FAKE', false), moderationTimeoutMs: int('MODERATION_TIMEOUT_MS', 15000),
    falTimeoutMs: int('FAL_TIMEOUT_MS', 600000), falPollMs: int('FAL_POLL_MS', 5000),
    dataDir, scenesDir: path.join(dataDir, 'scenes'), interstitial: path.join(dataDir, 'interstitial.mp4'),
    stageFifo: process.env.STAGE_FIFO || path.join(dataDir, 'stage.ts'),
    falFake: bool('FAL_FAKE', false), compositor: process.env.COMPOSITOR !== '0', worker: process.env.WORKER !== '0',
    rtmpUrl: process.env.RTMP_INGEST_URL || 'rtmp://127.0.0.1:1935/stream',
    hlsBase, hlsUrl: process.env.HLS_INTERNAL_URL || `${hlsBase}/stream/index.m3u8`,
    // Reconciliation: a scene whose owning process has not touched it for staleMs is
    // considered abandoned and is picked up again. Owners heartbeat every heartbeatMs.
    staleMs: int('STALE_MS', 120000), heartbeatMs: int('HEARTBEAT_MS', 15000),
    workerPollMs: int('WORKER_POLL_MS', 1000), refundBackoffMs: int('REFUND_BACKOFF_MS', 30000),
    maxGenerateAttempts: int('MAX_GENERATE_ATTEMPTS', 3), maxPlayAttempts: int('MAX_PLAY_ATTEMPTS', 3),
    checkoutRateLimit: int('CHECKOUT_RATE_LIMIT', 5), checkoutRateWindowMs: int('CHECKOUT_RATE_WINDOW_MS', 600000),
    retentionDays: int('RETENTION_DAYS', 30), errorTtlMs: int('ERROR_TTL_MS', 60000),
    trustProxy: process.env.TRUST_PROXY || '1'
  };
}

// Fail fast instead of silently shipping an open moderation gate (see moderation.js).
export function assertConfig(cfg) {
  if (!cfg.openrouterKey && !cfg.moderationFake) {
    throw new Error('OPENROUTER_API_KEY is required. Set MODERATION_FAKE=1 only for local development.');
  }
}
