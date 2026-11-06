// A throwaway Postgres for the database tests, shaped like Supabase:
//   roles anon / authenticated / service_role (service_role bypasses RLS),
//   a non-superuser `postgres` that owns everything the migration creates,
//   and an `auth` schema with users and auth.uid() reading the JWT claims
//   the way Supabase does (request.jwt.claims).
//
// Uses TEST_DATABASE_URL when set (a superuser connection to an empty
// database, e.g. a CI service container); otherwise starts a private cluster
// with the local initdb/pg_ctl (Homebrew or the PostgreSQL installer).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../supabase/migrations');

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout || r.error}`);
  return r.stdout;
};

const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role postgres login nosuperuser createrole;
  grant anon, authenticated, service_role to postgres;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role, postgres;
  grant select, references on auth.users to postgres;
  grant execute on function auth.uid() to public;
  grant all on schema public to postgres;
  alter schema public owner to postgres;
  grant create on database postgres to postgres;
`;

export async function startDb() {
  let cluster = null;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preppilot-pg-'));
    const port = await freePort();
    run('initdb', ['-D', dir, '-U', 'supa_admin', '--auth=trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', dir, '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', path.join(dir, 'log'), '-w', 'start']);
    cluster = { dir, port };
    adminUrl = `postgres://supa_admin@127.0.0.1:${port}/postgres`;
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  const stopCluster = () => {
    if (!cluster) return;
    spawnSync('pg_ctl', ['-D', cluster.dir, '-m', 'immediate', 'stop'], { encoding: 'utf8' });
    fs.rmSync(cluster.dir, { recursive: true, force: true });
  };
  try {
    await admin.connect();
    await admin.query(SUPABASE_SHIM);
    // The migration runs as `postgres`, as it does on Supabase.
    await admin.query('set role postgres');
    for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
      try {
        await admin.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      } catch (e) {
        throw new Error(`${f}: ${e.message}${e.position ? ` (at character ${e.position})` : ''}`);
      }
    }
    await admin.query('reset role');
  } catch (e) {
    await admin.end().catch(() => {});
    stopCluster();
    throw e;
  }

  const db = {
    admin,
    /** Runs fn inside a transaction as a dashboard user (auth.uid() = userId). */
    async asUser(userId, fn) { return db.asRole('authenticated', { sub: userId, role: 'authenticated' }, fn); },
    /** Runs fn as the Edge Function's service role. */
    async asService(fn) { return db.asRole('service_role', { role: 'service_role' }, fn); },
    async asRole(role, claims, fn) {
      await admin.query('begin');
      try {
        await admin.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await admin.query(`set local role ${role}`);
        const out = await fn((sql, params) => admin.query(sql, params));
        await admin.query('commit');
        return out;
      } catch (e) {
        await admin.query('rollback');
        throw e;
      }
    },
    async stop() {
      await admin.end();
      stopCluster();
    },
  };
  return db;
}
