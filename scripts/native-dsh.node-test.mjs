import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { NativeDsh } from './native-dsh.mjs';

function fixture() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const sent = [];
  child.stdin = new Writable({ write(chunk, _, done) { sent.push(JSON.parse(chunk.toString())); done(); } });
  const c = new NativeDsh({ knownRequestIds: ['older-omb'] }, child, { timeoutMs: 1000, turnTimeoutMs: 1000 });
  const frame = value => child.stdout.write(JSON.stringify(value) + '\n');
  c.session = { sessionId: 'synthetic-session', sessionFile: '', resumed: true, cancelled: false };
  c.initializing = Promise.resolve(c.session); c.ready.resolve(); c.opened.resolve(); c.eventsReady.resolve();
  let seq = 0;
  const event = (type, data) => c.event({ type, data, seq: seq++, time: seq }, false);
  return { c, sent, frame, event, close: () => c.close() };
}

test('native queue uses unchanged text and request identity, and excludes internal injected user messages', async () => {
  const f = fixture(); const entries = []; f.c.on('nativeEntry', value => entries.push(value));
  try {
    const result = f.c.submit('omb-1', '架空の人間の指示'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent.length, 1); const sent = f.sent[0];
    assert.equal(sent.method, 'session/prompt'); assert.equal(sent.args.request.mode, 'queue');
    assert.deepEqual(sent.args.request.content, [{ type: 'text', text: '架空の人間の指示' }]);
    f.frame({ id: sent.id, result: { ok: true, value: { accepted: true } } });
    f.event('turn/start', { turn: 0 });
    f.event('user/message', { source: { kind: 'user', rpcId: 'omb-1' }, content: [{ type: 'text', text: '架空の人間の指示' }] });
    f.event('user/message', { source: { kind: 'file-change' }, content: [{ type: 'text', text: '内部注入' }] });
    f.event('assistant/message', { message: { content: [{ type: 'text', text: '架空の回答' }] } });
    f.event('turn/end', { turn: 0, reason: { kind: 'completed' } });
    assert.equal((await result).text, '架空の回答'); assert.equal(entries.length, 2); assert.equal(entries[1].stopReason, 'stop');
  } finally { f.close(); }
});

test('human-only turns mirror but are not cancelled by OMB', async () => {
  const f = fixture(); const entries = []; f.c.on('nativeEntry', e => entries.push(e));
  try {
    f.event('turn/start', { turn: 1 }); f.event('user/message', { source: { kind: 'user', rpcId: 'human-1' }, content: [{ type: 'text', text: '端末入力' }] });
    assert.equal(await f.c.stop(), false); assert.equal(f.sent.length, 0);
    f.event('assistant/message', { message: { content: [{ type: 'text', text: '人間への回答' }] } }); f.event('turn/end', { reason: { kind: 'completed' } });
    assert.equal(entries[0].own, false); assert.equal(entries[1].own, false); assert.equal(f.c.busy, false);
  } finally { f.close(); }
});

test('same request is never submitted twice, and a changed payload is rejected', async () => {
  const f = fixture();
  try {
    const one = f.c.submit('once', '架空'); void one.catch(() => {}); await new Promise(resolve => setImmediate(resolve));
    const two = f.c.submit('once', '架空'); void two.catch(() => {});
    await assert.rejects(f.c.submit('once', '別内容'), /再利用/); assert.equal(f.sent.length, 1);
    f.close(); await assert.rejects(one); await assert.rejects(two);
  } finally { f.close(); }
});

test('older OMB inputs retain their origin after reconnect', () => {
  const f = fixture(); const entries = []; f.c.on('nativeEntry', e => entries.push(e));
  try { f.event('turn/start', { turn: 0 }); f.event('user/message', { source: { kind: 'user', rpcId: 'older-omb' }, content: [{ type: 'text', text: '以前の入力' }] }); assert.equal(entries[0].own, true); }
  finally { f.close(); }
});

test('only this session can receive approval cards; cancelled approvals cannot be answered', async () => {
  const f = fixture(); const questions = []; f.c.on('question', q => questions.push(q));
  try {
    f.c.remoteEvent({ type: 'ready', clientId: 'synthetic-owner' });
    f.c.remoteEvent({ type: 'waterfall', event: 'approval/request', eventId: 'other', agentId: 'other-session', request: { toolName: 'bash' } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(questions.length, 0);
    f.c.remoteEvent({ type: 'waterfall', event: 'approval/request', eventId: 'own', agentId: 'synthetic-session', request: { toolName: 'bash' } });
    assert.equal(questions[0].title, 'Allow tool: bash'); assert.deepEqual(questions[0].options, ['Approve', 'Deny']);
    f.c.remoteEvent({ type: 'cancel', eventId: 'own' }); await assert.rejects(f.c.answerUi('own', { value: 'Approve' }), /既に終了/);
  } finally { f.close(); }
});

test('failed native turn rejects the submitted job and clears working state', async () => {
  const f = fixture();
  try {
    const result = f.c.submit('failing', '架空'); await new Promise(resolve => setImmediate(resolve));
    f.frame({ id: f.sent[0].id, result: { ok: true, value: { accepted: true } } });
    f.event('turn/start', { turn: 1 }); f.event('user/message', { source: { kind: 'user', rpcId: 'failing' }, content: [{ type: 'text', text: '架空' }] });
    f.event('turn/end', { reason: { kind: 'error' } }); await assert.rejects(result, /正常完了していません/); assert.equal(f.c.busy, false);
  } finally { f.close(); }
});

test('UTF-8 split across SSH chunks preserves Japanese native input', () => {
  const f = fixture(); const entries = []; f.c.on('nativeEntry', e => entries.push(e));
  try {
    const bytes = Buffer.from(JSON.stringify({ stream: { type: 'item', streamId: 'history', value: { type: 'event', event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '架空の日本語' }] } } } } }) + '\n');
    const split = bytes.indexOf(Buffer.from('架')) + 1;
    f.c.child.stdout.write(bytes.subarray(0, split)); f.c.child.stdout.write(bytes.subarray(split));
    assert.equal(entries[0].text, '架空の日本語');
  } finally { f.close(); }
});

test('approval returns one native result and cannot be used after settlement', async () => {
  const f = fixture();
  try {
    f.c.remoteEvent({ type: 'ready', clientId: 'synthetic-owner' });
    f.c.remoteEvent({ type: 'waterfall', event: 'approval/request', eventId: 'own', agentId: 'synthetic-session', request: { toolName: 'bash' } });
    const answering = f.c.answerUi('own', { value: 'Approve' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.sent[0].args, { clientId: 'synthetic-owner', eventId: 'own', outcome: { kind: 'result', value: 'allowed-once' } });
    f.frame({ id: f.sent[0].id, result: { ok: true } }); await answering;
    await assert.rejects(f.c.answerUi('own', { value: 'Approve' }), /既に終了/); assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('stopping a queued OMB prompt removes only its native queue item and leaves the human running', async () => {
  const f = fixture();
  try {
    const result = f.c.submit('queued-omb', '架空'); void result.catch(() => {});
    await new Promise(resolve => setImmediate(resolve)); f.frame({ id: f.sent[0].id, result: { ok: true, value: { accepted: true } } });
    await new Promise(resolve => setImmediate(resolve));
    f.event('turn/start', { turn: 1 }); f.event('user/message', { source: { kind: 'user', rpcId: 'human-1' }, content: [{ type: 'text', text: '人間の作業' }] });
    const stopping = f.c.stop(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sent[1].method, 'session/projections');
    f.frame({ id: f.sent[1].id, result: { ok: true, value: { values: { inbox: { 'next-turn': [
      { id: 'human-item', source: { kind: 'user', rpcId: 'human-queued' } },
      { id: 'omb-item', source: { kind: 'user', rpcId: 'queued-omb' } },
    ] } } } } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sent[2].method, 'session/updateQueue');
    assert.equal(f.sent[2].args.request.itemId, 'omb-item'); assert.equal(f.sent[2].args.request.action.kind, 'remove');
    f.frame({ id: f.sent[2].id, result: { ok: true, value: { accepted: true } } });
    assert.equal(await stopping, true); await assert.rejects(result, /未実行/); assert.equal(f.c.busy, true);
    assert.equal(f.sent.some(frame => frame.method === 'session/cancel'), false);
  } finally { f.close(); }
});
