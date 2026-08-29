import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from './media.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Everything burned into the picture is English, including the disclosure label, which
// rides on every frame we broadcast — interstitial, replay and paid scene alike.
export const LABEL = 'AI-generated satire';

export const overlay = (text, replay = false) => {
  const safe = String(text).replace(/[\\':%]/g, ' ').slice(0, 180);
  const parts = [`drawtext=text='${LABEL}':fontcolor=white:fontsize=20:box=1:boxcolor=black@0.55:boxborderw=8:x=w-text_w-24:y=24`];
  if (safe) parts.push(`drawtext=text='${safe}':fontcolor=white:fontsize=25:box=1:boxcolor=black@0.60:boxborderw=12:x=(w-text_w)/2:y=h-62`);
  if (replay) parts.push("drawtext=text='REPLAY':fontcolor=white:fontsize=25:box=1:boxcolor=0xd14b3f@0.9:boxborderw=10:x=24:y=24");
  return parts.join(',');
};

/**
 * A single, permanently connected RTMP publisher.
 *
 * Publishing one ffmpeg process per clip tears the MediaMTX HLS muxer down at every
 * scene boundary (playlist 404s, segment numbering restarts). Instead one long-lived
 * ffmpeg reads an MPEG-TS FIFO and publishes forever, while short-lived encoders append
 * clip after clip into that FIFO. A file descriptor held open by this process keeps the
 * FIFO from ever reaching EOF between clips, so the publisher never disconnects.
 */
export async function createStage(cfg, logger = console) {
  await fs.mkdir(path.dirname(cfg.stageFifo), { recursive: true });
  await fs.rm(cfg.stageFifo, { force: true });
  await run('mkfifo', [cfg.stageFifo]);
  const pin = await fs.open(cfg.stageFifo, 'r+'); // keeps a writer AND a reader attached: no EOF, ever

  let stopped = false, publisher = null, timeline = 0, current = null;

  const spawnPublisher = () => {
    if (stopped) return;
    publisher = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-y', '-probesize', '32k', '-analyzeduration', '1000000',
      '-fflags', '+genpts', '-err_detect', 'ignore_err', '-f', 'mpegts', '-i', cfg.stageFifo, '-c', 'copy', '-f', 'flv', cfg.rtmpUrl],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    publisher.stderr.on('data', data => logger.error('stage publisher:', String(data).trim().slice(-500)));
    publisher.on('error', error => logger.error('stage publisher failed to start', error.message));
    publisher.on('exit', code => {
      publisher = null;
      if (stopped) return;
      logger.error(`stage publisher exited (${code}); reconnecting`);
      setTimeout(spawnPublisher, 500);
    });
  };
  spawnPublisher();

  return {
    get connected() { return Boolean(publisher); },
    get publisherPid() { return publisher?.pid ?? null; },
    async publish(file, { text = '', replay = false } = {}) {
      await fs.access(file);
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-re', '-i', file, '-vf', overlay(text, replay)];
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-r', '30', '-g', '60', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', '+resend_headers',
        '-output_ts_offset', timeline.toFixed(3), '-f', 'mpegts', cfg.stageFifo);
      const startedAt = Date.now();
      try {
        current = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        const child = current;
        await new Promise((resolve, reject) => {
          let stderr = '';
          child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
          child.on('error', reject);
          child.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`)));
        });
      } finally {
        current = null;
        // Advance the shared timeline by the wall time the clip actually occupied; -re
        // paces at native rate, so this keeps output timestamps strictly increasing
        // across clip boundaries without ever going backwards.
        timeline += Math.max(0.1, (Date.now() - startedAt) / 1000);
      }
    },
    async stop() {
      stopped = true;
      if (current) current.kill('SIGKILL');
      if (publisher) publisher.kill('SIGTERM');
      await sleep(50);
      await pin.close().catch(() => {});
      await fs.rm(cfg.stageFifo, { force: true }).catch(() => {});
    }
  };
}
