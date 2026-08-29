import fs from 'node:fs/promises';
import path from 'node:path';
import Stripe from 'stripe';
import { fal } from '@fal-ai/client';
import { moderatePrompt } from './moderation.js';
import { makeFake, normalize } from './media.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createPipeline({ db, cfg, stripe = cfg.stripeKey ? new Stripe(cfg.stripeKey) : null, moderator = moderatePrompt, logger = console }) {
  // Keeps updated_at fresh while this process owns the scene, so the reconciler in
  // worker.js can tell "still working" apart from "crashed mid-generation".
  const withHeartbeat = async (id, work) => {
    const timer = setInterval(() => { db.heartbeat(id).catch(() => {}); }, cfg.heartbeatMs);
    if (timer.unref) timer.unref();
    try { return await work(); } finally { clearInterval(timer); }
  };

  // Performs the actual Stripe refund. Never swallows its error: the caller records the
  // failure and the worker retries until refund_id is set.
  const settleRefund = async scene => {
    if (scene.refund_id) return scene;
    if (!stripe || !scene.stripe_session_id) {
      return db.dropRefund(scene.id, 'No payment provider configured; nothing was charged.');
    }
    const session = await stripe.checkout.sessions.retrieve(scene.stripe_session_id);
    if (!session.payment_intent) {
      return db.dropRefund(scene.id, 'Checkout session has no payment intent; nothing was charged.');
    }
    const refund = await stripe.refunds.create(
      { payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id, reason: 'requested_by_customer' },
      { idempotencyKey: `refund-scene-${scene.id}` }
    );
    return db.settleRefund(scene.id, refund.id);
  };

  // Retry entry point used by the worker.
  const retryRefund = async scene => {
    try { return await settleRefund(scene); }
    catch (error) {
      await db.recordRefundFailure(scene.id, error.message);
      logger.error('refund attempt failed', { scene_id: scene.id, error: error.message });
      return null;
    }
  };

  // The customer's money is owed the moment we decide not to deliver. Persist that debt
  // FIRST, then try to pay it; a failing Stripe call only delays the refund, never loses it.
  const requestRefund = async (scene, status, reason, extra = {}) => {
    const updated = await db.transition(scene.id, status, { reason }, { error: reason, refund_needed: true, ...extra });
    await retryRefund(updated);
    return updated;
  };

  const falWait = async (scene, requestId) => {
    const deadline = Date.now() + cfg.falTimeoutMs;
    while (true) {
      if (Date.now() > deadline) throw new Error(`fal generation timed out after ${Math.round(cfg.falTimeoutMs / 1000)}s`);
      const status = await fal.queue.status(cfg.falModel, { requestId, logs: false });
      if (status.status === 'COMPLETED') break;
      if (status.status !== 'IN_QUEUE' && status.status !== 'IN_PROGRESS') throw new Error(`fal request failed validation or generation: ${JSON.stringify(status)}`);
      await sleep(cfg.falPollMs);
    }
    const result = await fal.queue.result(cfg.falModel, { requestId });
    const url = result?.data?.video?.url || result?.data?.video_url || result?.video?.url;
    if (!url) throw new Error('fal completed without a video URL');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`video download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  };

  // resume=true means we are re-attaching to work a previous process started.
  const generate = async (scene, { resume = false } = {}) => {
    const attempts = (scene.generate_attempts || 0) + 1;
    if (attempts > cfg.maxGenerateAttempts) {
      return requestRefund(scene, 'failed', `Generation failed after ${attempts - 1} attempts.`);
    }
    const costCents = Math.ceil(cfg.sceneSeconds * 8);
    if (!await db.reserveSpend(scene.id, costCents, Math.round(cfg.maxDailySpendUsd * 100))) {
      return requestRefund(scene, 'failed', 'Daily generation spend cap reached.');
    }
    await fs.mkdir(cfg.scenesDir, { recursive: true });
    const raw = path.join(cfg.scenesDir, `${scene.id}.raw.mp4`), final = path.join(cfg.scenesDir, `${scene.id}.mp4`);
    try {
      await withHeartbeat(scene.id, async () => {
        if (cfg.falFake) {
          await db.transition(scene.id, 'generating', { fake: true, attempt: attempts }, { fal_request_id: `fake-${scene.id}`, generate_attempts: attempts });
          await makeFake(scene.prompt, raw, cfg.sceneSeconds);
        } else {
          fal.config({ credentials: cfg.falKey });
          let requestId = resume ? scene.fal_request_id : null;
          if (requestId) {
            await db.transition(scene.id, 'generating', { attempt: attempts, reattached: true }, { generate_attempts: attempts });
          } else {
            const submitted = await fal.queue.submit(cfg.falModel, { input: { prompt: scene.prompt, duration: cfg.sceneSeconds, resolution: '768P', aspect_ratio: '16:9' } });
            requestId = submitted.request_id;
            await db.transition(scene.id, 'generating', { attempt: attempts }, { fal_request_id: requestId, generate_attempts: attempts });
          }
          await fs.writeFile(raw, await falWait(scene, requestId));
        }
        await normalize(raw, final);
        await fs.rm(raw, { force: true });
        await db.transition(scene.id, 'ready', {}, { video_path: final });
      });
    } catch (error) {
      await fs.rm(raw, { force: true });
      await requestRefund({ ...scene, generate_attempts: attempts }, 'failed', error.message);
    }
  };

  return {
    async process(scene) {
      const verdict = await withHeartbeat(scene.id, () => moderator(scene.prompt, cfg));
      if (!verdict.allow) return requestRefund(scene, 'rejected', `Rejected: ${verdict.reason}`);
      const queued = await db.transition(scene.id, 'queued', { moderation: verdict.reason });
      return generate(queued);
    },
    // A scene found stranded in 'generating': pick the fal request back up if we have one.
    async resume(scene) {
      if (scene.fal_request_id && !cfg.falFake && !String(scene.fal_request_id).startsWith('fake-')) {
        return generate(scene, { resume: true });
      }
      return generate(scene);
    },
    requestRefund, retryRefund, settleRefund
  };
}
