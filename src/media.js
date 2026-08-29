import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stderr) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

export async function ensureInterstitial(cfg) {
  try { await fs.access(cfg.interstitial); return; } catch {}
  await fs.mkdir(cfg.dataDir, { recursive: true });
  await run('ffmpeg', ['-y','-f','lavfi','-i',`color=c=0x090b10:s=1280x720:r=30:d=${cfg.sceneSeconds}`,'-f','lavfi','-i',`anullsrc=r=48000:cl=stereo:d=${cfg.sceneSeconds}`,'-vf',"drawtext=text='PROMPT THEATER':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=(h-text_h)/2,drawtext=text='The next scene could be yours':fontcolor=0x9ca3af:fontsize=25:x=(w-text_w)/2:y=h/2+70",'-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-r','30','-g','60','-c:a','aac','-ar','48000','-ac','2','-shortest',cfg.interstitial]);
}

export async function makeFake(prompt, output, seconds) {
  const safe = prompt.replace(/[\\':%]/g, ' ').slice(0, 120);
  await run('ffmpeg', ['-y','-f','lavfi','-i',`testsrc2=s=1280x720:r=30:d=${seconds}`,'-f','lavfi','-i',`sine=frequency=220:sample_rate=48000:duration=${seconds}`,'-vf',`drawtext=text='${safe}':fontcolor=white:fontsize=30:box=1:boxcolor=black@0.65:boxborderw=16:x=(w-text_w)/2:y=h-100`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-r','30','-g','60','-c:a','aac','-ar','48000','-ac','2','-shortest',output]);
}

export async function normalize(input, output) {
  await run('ffmpeg', ['-y','-i',input,'-vf','scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30','-af','loudnorm=I=-16:TP=-1.5:LRA=11','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-r','30','-g','60','-c:a','aac','-ar','48000','-ac','2','-movflags','+faststart','-shortest',output]);
}
