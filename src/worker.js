import fs from 'node:fs/promises';
import { createClock } from './clock.js';

/**
 * Durable reconciler for everything that moves money.
 *
 * The Stripe webhook only records "this session is paid" and returns. All work after
 * that point lives in the database, so a restart, OOM kill or deploy in the middle of
 * moderation or generation cannot orphan a paid scene: the loop below picks any scene
 * back up whose owner stopped heartbeating, and retries refunds until they succeed.
 */
export function startWorker({ db, cfg, pipeline, logger = console }) {
  const clock = createClock();
  let stopped = false;
  const loops = [];

  const processing = async () => {
    while (!stopped) {
      let claimed = null;
      try {
        claimed = await db.claimSceneForProcessing(cfg.staleMs);
        if (claimed) {
          logger.log(`worker: ${claimed.resumed ? 'resuming' : 'processing'} scene ${claimed.scene.id}`);
          if (claimed.resumed) await pipeline.resume(claimed.scene);
          else await pipeline.process(claimed.scene);
        }
      } catch (error) {
        logger.error('worker processing failed', { scene_id: claimed?.scene?.id, error: error.message });
      }
      if (!claimed) await clock.sleep(cfg.workerPollMs);
    }
  };

  const refunds = async () => {
    while (!stopped) {
      let scene = null;
      try {
        scene = await db.claimRefundPending(cfg.refundBackoffMs);
        if (scene) {
          const settled = await pipeline.retryRefund(scene);
          if (settled) logger.log(`worker: refund settled for scene ${scene.id}`);
        }
      } catch (error) {
        logger.error('worker refund loop failed', { scene_id: scene?.id, error: error.message });
      }
      if (!scene) await clock.sleep(cfg.workerPollMs);
    }
  };

  const retention = async () => {
    while (!stopped) {
      try {
        for (const scene of await db.listExpiredVideos(cfg.retentionDays, 5)) {
          await fs.rm(scene.video_path, { force: true });
          await db.forgetVideo(scene.id);
          logger.log(`worker: pruned expired video for scene ${scene.id}`);
        }
      } catch (error) { logger.error('worker retention failed', error.message); }
      await clock.sleep(3600000);
    }
  };

  for (const loop of [processing, refunds, retention]) {
    loops.push(loop().catch(error => logger.error('worker loop stopped', error)));
  }
  return async () => { stopped = true; clock.cancel(); await Promise.allSettled(loops); };
}

// One reconciler pass, used by tests and by anything that wants a synchronous sweep.
export async function reconcileOnce({ db, cfg, pipeline }) {
  await db.recoverStalePlaying(cfg.staleMs);
  const claimed = await db.claimSceneForProcessing(cfg.staleMs);
  if (claimed) {
    if (claimed.resumed) await pipeline.resume(claimed.scene);
    else await pipeline.process(claimed.scene);
  }
  const pending = await db.claimRefundPending(0);
  if (pending) await pipeline.retryRefund(pending);
  return { claimed: claimed?.scene || null, refunded: pending || null };
}
