import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
let cluster = null;

const findBinDir = async () => {
  for (const candidate of ['/usr/lib/postgresql', '/usr/pgsql', '/usr/local/pgsql']) {
    let versions;
    try { versions = await fs.readdir(candidate); } catch { continue; }
    for (const version of versions.sort((a, b) => Number(b) - Number(a))) {
      const bin = path.join(candidate, version, 'bin');
      try { await fs.access(path.join(bin, 'initdb')); return bin; } catch {}
    }
  }
  try { const { stdout } = await exec('which', ['initdb']); return path.dirname(stdout.trim()); } catch {}
  return null;
};

/**
 * A real Postgres for the tests that guard money and recovery paths. Uses
 * TEST_DATABASE_URL when provided (CI / container), otherwise boots a throwaway
 * cluster on a unix socket. These tests are never skipped: without a database they fail.
 */
export async function testDatabaseUrl() {
  const provided = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (provided) return provided;
  if (cluster) return cluster.url;
  const bin = await findBinDir();
  if (!bin) throw new Error('No Postgres available. Set TEST_DATABASE_URL or install the postgresql server binaries.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-theater-pg-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await fs.mkdir(socket);
  await exec(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync'], { maxBuffer: 1 << 24 });
  await exec(path.join(bin, 'pg_ctl'), ['-D', data, '-w', '-l', path.join(root, 'postgres.log'), '-o',
    `-k ${socket} -c listen_addresses='' -c fsync=off -c full_page_writes=off -c synchronous_commit=off`, 'start'],
    { maxBuffer: 1 << 24 });
  cluster = { root, data, bin, url: `postgres://postgres@/postgres?host=${socket}` };
  return cluster.url;
}

export async function stopTestDatabase() {
  if (!cluster) return;
  const { bin, data, root } = cluster; cluster = null;
  try { await exec(path.join(bin, 'pg_ctl'), ['-D', data, '-w', '-m', 'immediate', 'stop']); } catch {}
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

export async function resetSchema(db) {
  await db.pool.query('TRUNCATE scenes, spend_log, events RESTART IDENTITY');
}
