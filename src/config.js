import path from 'node:path';

const int = (name, fallback) => {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

export function config() {
  const dataDir = process.env.DATA_DIR || '/data';
  return {
    port: int('PORT', 3000), databaseUrl: process.env.DATABASE_URL,
    falKey: process.env.FAL_KEY || '', falModel: process.env.FAL_MODEL || 'minimax/h3-max/text-to-video',
    stripeKey: process.env.STRIPE_SECRET_KEY || '', webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    priceCents: int('STRIPE_PRICE_USD', 400), publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
    sceneSeconds: int('SCENE_SECONDS', 15), maxDailySpendUsd: Number(process.env.MAX_DAILY_SPEND_USD || 20),
    openrouterKey: process.env.OPENROUTER_API_KEY || '', moderationModel: process.env.MODERATION_MODEL || 'z-ai/glm-5.3-flash',
    dataDir, scenesDir: path.join(dataDir, 'scenes'), interstitial: path.join(dataDir, 'interstitial.mp4'),
    falFake: process.env.FAL_FAKE === '1', compositor: process.env.COMPOSITOR !== '0',
    rtmpUrl: process.env.RTMP_INGEST_URL || 'rtmp://127.0.0.1:1935/stream',
    hlsUrl: process.env.HLS_INTERNAL_URL || 'http://127.0.0.1:8888/stream/index.m3u8'
  };
}
