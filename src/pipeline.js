import fs from 'node:fs/promises';
import path from 'node:path';
import Stripe from 'stripe';
import { fal } from '@fal-ai/client';
import { moderatePrompt } from './moderation.js';
import { makeFake, normalize } from './media.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createPipeline({ db, cfg, stripe = cfg.stripeKey ? new Stripe(cfg.stripeKey) : null, moderator = moderatePrompt }) {
  const refund = async (scene, reason) => {
    let refundId = null;
    try {
      if (stripe && scene.stripe_session_id) {
        const session = await stripe.checkout.sessions.retrieve(scene.stripe_session_id);
        if (session.payment_intent) refundId = (await stripe.refunds.create({ payment_intent: session.payment_intent, reason: 'requested_by_customer' })).id;
      }
    } catch (error) { reason += ` Refund error: ${error.message}`; }
    await db.transition(scene.id, scene.status === 'moderating' ? 'rejected' : 'failed', { reason }, { error: reason, refund_id: refundId });
  };

  const generate = async scene => {
    const costCents = Math.ceil(cfg.sceneSeconds * 8);
    if (!await db.reserveSpend(scene.id, costCents, Math.round(cfg.maxDailySpendUsd * 100))) return refund(scene, 'Daily generation spend cap reached.');
    await fs.mkdir(cfg.scenesDir, { recursive: true });
    const raw = path.join(cfg.scenesDir, `${scene.id}.raw.mp4`), final = path.join(cfg.scenesDir, `${scene.id}.mp4`);
    try {
      if (cfg.falFake) {
        await db.transition(scene.id, 'generating', { fake: true }, { fal_request_id: `fake-${scene.id}` });
        await makeFake(scene.prompt, raw, cfg.sceneSeconds);
      } else {
        fal.config({ credentials: cfg.falKey });
        const submitted = await fal.queue.submit(cfg.falModel, { input: { prompt: scene.prompt, duration: cfg.sceneSeconds, resolution: '768P', aspect_ratio: '16:9' } });
        await db.transition(scene.id, 'generating', {}, { fal_request_id: submitted.request_id });
        const deadline = Date.now() + 600000;
        while (true) {
          if (Date.now() > deadline) throw new Error('fal generation timed out after 10 minutes');
          const status = await fal.queue.status(cfg.falModel, { requestId: submitted.request_id, logs: false });
          if (status.status === 'COMPLETED') break;
          if (status.status !== 'IN_QUEUE' && status.status !== 'IN_PROGRESS') throw new Error(`fal request failed validation or generation: ${JSON.stringify(status)}`);
          await sleep(5000);
        }
        const result = await fal.queue.result(cfg.falModel, { requestId: submitted.request_id });
        const url = result?.data?.video?.url || result?.data?.video_url || result?.video?.url;
        if (!url) throw new Error('fal completed without a video URL');
        const response = await fetch(url); if (!response.ok) throw new Error(`video download failed (${response.status})`);
        await fs.writeFile(raw, Buffer.from(await response.arrayBuffer()));
      }
      await normalize(raw, final); await fs.rm(raw, { force: true });
      await db.transition(scene.id, 'ready', {}, { video_path: final });
    } catch (error) { await fs.rm(raw, { force: true }); await refund({ ...scene, status: 'generating' }, error.message); }
  };

  return { async process(scene) {
    const verdict = await moderator(scene.prompt, cfg);
    if (!verdict.allow) return refund({ ...scene, status: 'moderating' }, verdict.reason);
    scene = await db.transition(scene.id, 'queued', { moderation: verdict.reason });
    return generate(scene);
  }, refund };
}
