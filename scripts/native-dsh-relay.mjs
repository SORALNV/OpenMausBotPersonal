import { readFileSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const [root, packageFile] = process.argv.slice(2);
const file = root + '/launch.json', stat = lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 4096) throw Error('Invalid connector launch record');
const { url } = JSON.parse(readFileSync(file, 'utf8'));
const launch = new URL(url);
if (launch.origin !== 'http://127.0.0.1:3082' || launch.pathname !== '/' || !launch.searchParams.get('token')) throw Error('Invalid DSH launch URL');
const login = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
if (login.status !== 303 || !cookie) throw Error('DSH operator login failed');
const WebSocket = createRequire(packageFile)('ws');
const ws = new WebSocket('ws://127.0.0.1:3082/api/remote.mux', { headers: { cookie }, maxPayload: 64 * 1024 * 1024 });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
ws.on('message', bytes => { try { emit({ stream: JSON.parse(bytes.toString()) }); } catch { ws.close(); } });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
ws.on('error', () => process.exit(1)); ws.on('close', () => process.exit(1));
emit({ ready: true });
const allowed = new Set(['session/list', 'session/create', 'session/rename', 'session/selectModel', 'session/prompt', 'session/cancel', 'session/updateQueue', 'session/projections', 'session/page', '$events/result', 'userQuestions/answer']);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  let frame;
  try {
    if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw Error('Frame too large');
    frame = JSON.parse(line);
    if (frame.ws) {
      const value = frame.ws;
      if (!['open', 'cancel', 'end', 'item'].includes(value.type) || value.type === 'open' && !['session/follow', '$events'].includes(value.endpoint)) throw Error('Unsupported stream');
      ws.send(JSON.stringify(value)); return;
    }
    if (!allowed.has(frame.method) || typeof frame.id !== 'string') throw Error('Unsupported RPC');
    const response = await fetch('http://127.0.0.1:3082/api/' + frame.method, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: frame.id, method: frame.method, payload: { args: frame.args } }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('DSH HTTP ' + response.status);
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw Error('Response too large');
    const value = JSON.parse(text);
    if (value.rpcId !== frame.id) throw Error('RPC identity mismatch');
    emit({ id: frame.id, result: value.result });
  } catch { emit({ id: frame?.id, error: 'DSH接続または操作を完了できませんでした。自動再送はしていません。' }); }
});
lines.on('close', () => { ws.close(); process.exit(0); });
