import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationServerEnvironment } from './control-omb.ts';

const repo = process.cwd(), root = mkdtempSync(join(tmpdir(), 'omb-thread-cleanup-fixture-')), data = join(root, 'data');
mkdirSync(data); mkdirSync(join(data, 'tmp'));
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const env = { ...verificationServerEnvironment({}, data, port), OMB_PERSONAL_BUILD: '1' };
writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { claude: { driver: 'claudeAgent', config: { cli: join(repo, 'server/testing/fake-claude-cli.ts') } } }, decider: { enabled: false }, newBotDefaults: { profile: { computer: 'off', browser: false } } }));
const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
const {Store}=await import('./server/store.ts');const real=Date.now();const old=real-48*3600000;Date.now=()=>old;
const s=new Store(()=>({instanceId:'claude',model:'fixture'}));const b=s.createBot({name:'Synthetic cleanup'});const main=b.threadId;
const make=name=>s.createTask(b.id,name,false,undefined,{botId:b.id,name:b.name,at:old});const stale=make('Synthetic stale'),pinned=make('Synthetic pinned'),pending=make('Synthetic approval');
s.patchTask(b.id,pinned.threadId,{pinned:true});s.appendMessage(stale.threadId,{role:'bot',kind:'text',text:'SYNTHETIC_ARCHIVED_HISTORY'});s.patchTask(b.id,stale.threadId,{unread:true});
s.appendMessage(pending.threadId,{role:'bot',kind:'options',card:{title:'架空の未回答確認',options:['許可','拒否'],requestId:'synthetic-pending',requestType:'permission'}});
console.log(JSON.stringify({botId:b.id,main,stale:stale.threadId,pinned:pinned.threadId,pending:pending.threadId}));
`], { cwd: repo, env, encoding: 'utf8', timeout: 15000 });
if (seed.status !== 0) throw Error('Synthetic seed failed: ' + seed.stderr);
const ids = JSON.parse(seed.stdout.trim());
const child = spawn(process.execPath, [join(repo, 'server/index.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
const url = `http://127.0.0.1:${port}`;
const api = async (path, method = 'GET', body) => {
  const response = await fetch(url + path, { method, headers: { origin: url, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
try {
  const deadline = Date.now() + 45000;
  for (;;) { try { if ((await fetch(url + '/api/health')).ok) break; } catch {} if (Date.now() > deadline || child.exitCode !== null) throw Error('Synthetic server did not start'); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.deepEqual(await api('/api/bot-thread-cleanup'), { enabled: true, idleHours: 24 });
  assert.equal((await api('/api/bot-thread-cleanup/run', 'POST')).archived, 1);
  const bot = (await api('/api/bots?messages=0')).bots.find(bot => bot.id === ids.botId);
  const stale = bot.tasks.find(task => task.threadId === ids.stale);
  assert.ok(stale.archivedAt); assert.equal(stale.unread, false);
  for (const key of ['main', 'pinned', 'pending']) assert.equal(bot.tasks.find(task => task.threadId === ids[key]).archivedAt, undefined);
  const history = await api('/api/threads/' + ids.stale + '/messages?limit=10');
  assert.ok(history.messages.some(message => message.text === 'SYNTHETIC_ARCHIVED_HISTORY'));
  await api(`/api/bots/${ids.botId}/tasks/${ids.stale}`, 'PATCH', { archivedAt: null });
  assert.equal((await api('/api/bot-thread-cleanup/run', 'POST')).archived, 0);
  const restored = (await api('/api/bots?messages=0')).bots.find(bot => bot.id === ids.botId).tasks.find(task => task.threadId === ids.stale);
  assert.equal(restored.archivedAt, undefined);
  await api('/api/bot-thread-cleanup', 'PUT', { enabled: false, idleHours: 3 });
  assert.deepEqual(await api('/api/bot-thread-cleanup'), { enabled: false, idleHours: 3 });
  const report = { ok: true, isolated: true, oldBotThreadArchived: true, pendingApprovalProtected: true, humanAndPinnedProtected: true, transcriptPreserved: true, restoredThreadNotImmediatelyRearchived: true, settingsApplyWithoutRestart: true, at: new Date().toISOString() };
  const evidence = process.env.OMB_CLEANUP_EVIDENCE ?? join(repo, '.privacy-dev/bot-thread-cleanup-20261028'); mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { const evidence = process.env.OMB_CLEANUP_EVIDENCE ?? join(repo, '.privacy-dev/bot-thread-cleanup-20261028'); mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, 'fixture-error.log'), logs); throw error; }
finally { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } rmSync(root, { recursive: true, force: true }); }
