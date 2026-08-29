import fs from 'node:fs/promises';
import { ensureInterstitial } from './media.js';
import { createStage } from './stage.js';
import { createClock } from './clock.js';

export const COMPOSITOR_LOCK = 'prompt-theater-compositor';

export function startCompositor({ db, cfg, pipeline, logger = console, stageFactory = createStage }) {
  const clock = createClock();
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
      if (stopped) {
        // We killed the encoder ourselves while shutting down. That is not the clip's
        // fault, so it goes back in line without burning one of its attempts.
        await db.transition(scene.id, 'ready', { shutdown: true });
        return;
      }
      if (attempts >= cfg.maxPlayAttempts) {
        await pipeline.requestRefund({ ...scene, play_attempts: attempts }, 'failed',
          `Playback failed after ${attempts} attempts: ${error.message}`, { play_attempts: attempts });
      } else {
        await db.transition(scene.id, 'ready', { playback_error: error.message },
          { play_attempts: attempts, error: error.message });
      }
      await clock.sleep(1000);
      return;
    }
    await db.transition(scene.id, 'played', {}, { played_at: new Date(), play_attempts: attempts });
  };

  const loop = async () => {
    // Exactly one compositor per deployment may hold the stage; a second publisher would
    // be kicked off the RTMP path by MediaMTX and strand its scene mid-broadcast.
    while (!stopped && !lock) {
      lock = await db.acquireLock(COMPOSITOR_LOCK);
      if (!lock) { logger.error('compositor: stage lock held by another instance; standing by'); await clock.sleep(5000); }
    }
    // stop() may have landed while acquireLock or the stage were still starting up;
    // whatever we opened has to be closed here or it outlives the compositor.
    if (stopped) return;
    logger.log('compositor: stage lock acquired');
    await ensureInterstitial(cfg);
    const opened = await stageFactory(cfg, logger);
    if (stopped) { await opened.stop(); return; }
    stage = opened;
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
        await clock.sleep(1000);
      }
    }
  };

  const running = loop().catch(error => logger.error('compositor stopped', error));
  // Stopping must actually be finished when the returned promise resolves: kill the
  // encoder, let the loop unwind, then hand the stage lock to the next instance.
  return async () => {
    stopped = true;
    clock.cancel();
    if (stage) await stage.stop();
    await running;
    if (lock) { await lock.release(); lock = null; }
  };
}
