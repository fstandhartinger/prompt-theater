import fs from 'node:fs/promises';
import { ensureInterstitial } from './media.js';
import { createStage } from './stage.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const COMPOSITOR_LOCK = 'prompt-theater-compositor';

export function startCompositor({ db, cfg, pipeline, logger = console, stageFactory = createStage }) {
  let stopped = false, stage = null, lock = null;

  const withHeartbeat = async (id, work) => {
    const timer = setInterval(() => { db.heartbeat(id).catch(() => {}); }, cfg.heartbeatMs);
    if (timer.unref) timer.unref();
    try { return await work(); } finally { clearInterval(timer); }
  };

  const playScene = async scene => {
    const attempts = (scene.play_attempts || 0) + 1;
    try {
      await withHeartbeat(scene.id, () => stage.publish(scene.video_path, { text: scene.prompt_display }));
    } catch (error) {
      // A paid scene must never be left on 'playing'. Put it back in line, and if the
      // clip is simply unplayable, stop trying and refund.
      logger.error('scene playback failed', { scene_id: scene.id, attempt: attempts, error: error.message });
      if (attempts >= cfg.maxPlayAttempts) {
        await pipeline.requestRefund({ ...scene, play_attempts: attempts }, 'failed',
          `Playback failed after ${attempts} attempts: ${error.message}`, { play_attempts: attempts });
      } else {
        await db.transition(scene.id, 'ready', { playback_error: error.message },
          { play_attempts: attempts, error: error.message });
      }
      await sleep(1000);
      return;
    }
    await db.transition(scene.id, 'played', {}, { played_at: new Date(), play_attempts: attempts });
  };

  const loop = async () => {
    // Exactly one compositor per deployment may hold the stage; a second publisher would
    // be kicked off the RTMP path by MediaMTX and strand its scene mid-broadcast.
    while (!stopped && !lock) {
      lock = await db.acquireLock(COMPOSITOR_LOCK);
      if (!lock) { logger.error('compositor: stage lock held by another instance; standing by'); await sleep(5000); }
    }
    if (stopped) return;
    logger.log('compositor: stage lock acquired');
    await ensureInterstitial(cfg);
    stage = await stageFactory(cfg, logger);
    while (!stopped) {
      try {
        await db.recoverStalePlaying(cfg.staleMs);
        const scene = await db.claimReadyScene();
        if (scene) { await playScene(scene); continue; }
        await stage.publish(cfg.interstitial);
        for (const replay of (await db.listReplayCandidates(5)).reverse()) {
          try { await fs.access(replay.video_path); await stage.publish(replay.video_path, { text: replay.prompt_display, replay: true }); }
          catch (error) { logger.error('replay failed', error.message); }
        }
      } catch (error) {
        logger.error('compositor iteration failed', error.message);
        await sleep(1000);
      }
    }
  };

  loop().catch(error => logger.error('compositor stopped', error));
  return async () => {
    stopped = true;
    if (stage) await stage.stop();
    if (lock) await lock.release();
  };
}
