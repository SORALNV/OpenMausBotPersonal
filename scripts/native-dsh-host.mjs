import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const [binary, root, profile = 'web'] = process.argv.slice(2);
if (!binary?.startsWith('/') || !root?.startsWith('/') || !/^[\w-]+$/.test(profile)) throw Error('Explicit DSH paths required');
mkdirSync(root, { recursive: true, mode: 0o700 });
const file = join(root, 'launch.json');
try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
// DSH 0.2.0-rc.2 prints an operator launch URL; exchange it through the standard browser-auth endpoint.
const child = spawn('/usr/bin/node', [binary, '--profile', profile, '--host', '127.0.0.1', '--port', '3082', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
const output = chunk => {
  buffer = (buffer + chunk.toString()).slice(-32768);
  const match = buffer.match(/http:\/\/127\.0\.0\.1:3082\/\?token=[A-Za-z0-9_-]+/);
  if (!match) return;
  writeFileSync(file + '.tmp', JSON.stringify({ url: match[0], pid: child.pid }), { mode: 0o600 });
  renameSync(file + '.tmp', file);
  buffer = '';
};
child.stdout.on('data', output); child.stderr.on('data', output);
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { try { unlinkSync(file); } catch {} process.exitCode = code ?? 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
