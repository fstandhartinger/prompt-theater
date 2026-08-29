import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createStage, overlay } from '../src/stage.js';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const makeClip = async (file, seconds, colour) => {
  await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
};

const lastVideoDts = async file => {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v',
    '-show_entries', 'packet=dts_time', '-of', 'csv=p=0', file], { maxBuffer: 1 << 26 });
  const values = stdout.split('\n').map(Number).filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
};

/**
 * Finding 4: one ffmpeg process per clip means the RTMP publisher disconnects at every
 * scene boundary, which destroys the HLS muxer and restarts segment numbering.
 */
test('the stage keeps one publisher alive across clip boundaries', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-theater-stage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clipA = path.join(dir, 'a.mp4'), clipB = path.join(dir, 'b.mp4'), out = path.join(dir, 'out.flv');
  await makeClip(clipA, 2, 'red');
  await makeClip(clipB, 2, 'blue');

  const cfg = { stageFifo: path.join(dir, 'stage.ts'), rtmpUrl: out };
  const stage = await createStage(cfg, { error() {}, log() {} });
  try {
    await stage.publish(clipA, { text: 'first scene' });
    const pidAfterFirst = stage.publisherPid;
    assert.ok(pidAfterFirst, 'publisher must be running after the first clip');
    await stage.publish(clipB, { text: 'second scene', replay: true });
    assert.equal(stage.publisherPid, pidAfterFirst, 'publisher must survive the clip boundary');
    await sleep(300);
  } finally { await stage.stop(); }

  // A restarting publisher would rewrite timestamps from zero for every clip; a
  // continuous one keeps them increasing across the boundary.
  const dts = await lastVideoDts(out);
  assert.ok(dts > 3, `expected a continuous timeline beyond the first clip, last dts was ${dts}`);
});

test('the stage refuses to publish a missing file instead of dying', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-theater-stage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = { stageFifo: path.join(dir, 'stage.ts'), rtmpUrl: path.join(dir, 'out.flv') };
  const stage = await createStage(cfg, { error() {}, log() {} });
  try {
    await assert.rejects(() => stage.publish(path.join(dir, 'missing.mp4')), /ENOENT/);
    const clip = path.join(dir, 'ok.mp4');
    await makeClip(clip, 2, 'green');
    await stage.publish(clip);
  } finally { await stage.stop(); }
});

test('overlay text cannot escape the drawtext filter', () => {
  const filter = overlay("a':drawbox=c=red%{pts}\\ ", false);
  assert.ok(!/[\\':%]/.test(filter.slice(filter.indexOf("text='") + 6, filter.indexOf("':fontcolor"))));
  assert.match(filter, /^drawtext=text='/);
});
