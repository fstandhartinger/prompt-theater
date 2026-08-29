import fs from 'node:fs/promises';
import { run, ensureInterstitial } from './media.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const overlay = (text, replay = false) => {
  const safe = text.replace(/[\\':%]/g, ' ').slice(0, 180);
  const parts = [`drawtext=text='${safe}':fontcolor=white:fontsize=25:box=1:boxcolor=black@0.60:boxborderw=12:x=(w-text_w)/2:y=h-62`];
  if (replay) parts.push("drawtext=text='REPLAY':fontcolor=white:fontsize=25:box=1:boxcolor=0xd14b3f@0.9:boxborderw=10:x=24:y=24");
  return parts.join(',');
};

export async function publishClip(file, cfg, text = '', replay = false) {
  const args = ['-re','-probesize','32k','-analyzeduration','0','-i',file];
  if (text || replay) args.push('-vf', overlay(text, replay));
  args.push('-c:v','libx264','-preset','veryfast','-tune','zerolatency','-pix_fmt','yuv420p','-r','30','-g','60','-c:a','aac','-ar','48000','-ac','2','-f','flv',cfg.rtmpUrl);
  await run('ffmpeg', args);
}

export function startCompositor(db, cfg, logger = console) {
  let stopped = false;
  const loop = async () => {
    await ensureInterstitial(cfg);
    while (!stopped) {
      try {
        const client = await db.pool.connect(); let scene;
        try {
          await client.query('BEGIN');
          const result = await client.query("SELECT * FROM scenes WHERE status='ready' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1");
          scene = result.rows[0];
          if (scene) {
            await client.query("UPDATE scenes SET status='playing',updated_at=now() WHERE id=$1", [scene.id]);
            await client.query('INSERT INTO events(kind,detail) VALUES($1,$2)', ['scene.status', JSON.stringify({ scene_id: scene.id, status: 'playing' })]);
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        if (scene) {
          await publishClip(scene.video_path, cfg, scene.prompt_display, false);
          await db.transition(scene.id, 'played', {}, { played_at: new Date() });
          continue;
        }
        await publishClip(cfg.interstitial, cfg);
        const { rows } = await db.pool.query("SELECT * FROM scenes WHERE status='played' AND video_path IS NOT NULL ORDER BY played_at DESC LIMIT 5");
        for (const replay of rows.reverse()) {
          try { await fs.access(replay.video_path); await publishClip(replay.video_path, cfg, replay.prompt_display, true); } catch (error) { logger.error('replay failed', error.message); }
        }
      } catch (error) { logger.error('compositor iteration failed', error.message); await sleep(1000); }
    }
  };
  loop().catch(error => logger.error('compositor stopped', error));
  return () => { stopped = true; };
}
