import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { nativeOmpCommand } from './native-omp-transport.mjs';
import { StringDecoder } from 'node:string_decoder';
import { isIP } from 'node:net';

const LIMIT = 64 * 1024 * 1024;
const contentText = content => Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : '';
const sessionId = binding => binding.expectedSessionId ?? 'omb-' + createHash('sha256').update(JSON.stringify([binding.botId, binding.threadId])).digest('hex').slice(0, 32);

/** DSH 0.2.0-rc.2 standard Web RPC over owner-authenticated LAN SSH. No model loop or credentials are copied to the Mac. */
export class NativeDsh extends EventEmitter {
  constructor(binding, child, { timeoutMs = 45000, turnTimeoutMs = 900000 } = {}) {
    super(); this.binding = binding; this.child = child; this.timeoutMs = timeoutMs; this.turnTimeoutMs = turnTimeoutMs;
    this.pending = new Map(); this.receipts = new Map(); this.questions = new Map(); this.tools = new Map(); this.statuses = new Map(); this.knownRequests = new Set(binding.knownRequestIds ?? []);
    this.closed = false; this.buffer = ''; this.decoder = new StringDecoder('utf8'); this.busy = false; this.turn = null; this.cursor = -1;
    this.ready = this.slot(timeoutMs); this.opened = this.slot(timeoutMs); this.eventsReady = this.slot(timeoutMs);
    child.stdout.on('data', bytes => this.read(bytes)); child.stderr.on('data', () => {});
    child.on('error', () => this.fail('JetsonのSSH接続を開始できません。'));
    child.on('close', () => this.fail('Jetsonとの接続が切れました。送信済み入力は再送しません。'));
    child.stdin.on('error', () => this.fail('Jetsonへの入力接続が閉じました。'));
  }
  static connect(binding, options) {
    if (isIP(binding.host) !== 4 || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(binding.host)) throw Error('家庭内LANのプライベートIPv4を指定してください。');
    const plan = nativeOmpCommand(binding);
    const args = plan.args.slice(0, -1);
    args.push(`exec /usr/bin/node '${binding.stateRoot}/relay.mjs' '${binding.stateRoot}' '/home/${binding.user}/.local/lib/node_modules/@deepseek-ai/dsh/package.json'`);
    const env = Object.fromEntries(['HOME', 'PATH', 'SSH_AUTH_SOCK', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    return new NativeDsh(binding, spawn(plan.command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env }), options);
  }
  slot(ms) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    const timer = setTimeout(() => reject(Error('Jetsonの応答待ちが期限を超えました。自動再送はしていません。')), ms);
    return { promise, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
  }
  send(frame) {
    if (this.closed) throw Error('Jetson接続は閉じています。');
    const line = JSON.stringify(frame) + '\n'; if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw Error('入力が大きすぎます。');
    this.child.stdin.write(line);
  }
  async rpc(method, request, args = method === 'session/list' ? { _request: request } : { request }) {
    await this.ready.promise;
    const id = randomUUID(), pending = this.slot(this.timeoutMs); this.pending.set(id, pending);
    try { this.send({ id, method, args }); return await pending.promise; } finally { this.pending.delete(id); }
  }
  read(bytes) {
    this.buffer += this.decoder.write(bytes);
    if (Buffer.byteLength(this.buffer) > LIMIT) return this.fail('Jetsonの応答が上限を超えました。');
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      try { this.frame(JSON.parse(line)); } catch { this.fail('Jetsonの応答形式を確認できません。'); return; }
    }
  }
  frame(frame) {
    if (frame.ready === true) return this.ready.resolve();
    if (frame.id) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        if (frame.result?.ok) pending.resolve(frame.result.value);
        else pending.reject(Error(frame.error ?? 'DeepseekHarness: ' + (frame.result?.error?.code ?? '操作失敗')));
      }
      return;
    }
    const stream = frame.stream;
    if (!stream) throw Error('Unknown frame');
    if (stream.type === 'error') return this.fail('DeepseekHarnessの共有ストリームが終了しました。');
    if (stream.type !== 'item') return;
    const value = stream.value;
    if (stream.streamId === 'events') return this.remoteEvent(value);
    if (stream.streamId !== 'history') return;
    if (value.type === 'snapshot') {
      if (value.header?.sessionId !== this.session.sessionId && value.header?.id !== this.session.sessionId) throw Error('Session identity mismatch');
      for (const record of value.records ?? []) if (record.type === 'event') this.event(record.event, true);
      this.cursor = value.cursor; this.opened.resolve(); this.emitState();
    } else if (value.type === 'event') this.event(value.event, false);
  }
  async initialize() {
    return this.initializing ??= this.boot();
  }
  async boot() {
    await this.ready.promise;
    const id = sessionId(this.binding);
    const listing = await this.rpc('session/list', {});
    const existing = listing.items?.find(item => item.sessionId === id);
    if (!existing && this.binding.expectedSessionId) throw Error('選択したDeepseekHarnessセッションが見つかりません。');
    if (existing && !existing.agentAvailable) await this.rpc('session/create', { sessionId: id, cwd: existing.cwd ?? this.binding.cwd });
    if (!existing) {
      const created = await this.rpc('session/create', { sessionId: id, cwd: this.binding.cwd });
      if (created.sessionId !== id) throw Error('Session identity mismatch');
      await this.rpc('session/rename', { sessionId: id, title: 'Jetson / OMB' });
      const [provider, ...model] = (this.binding.model ?? '').split('/');
      if (provider && model.length) await this.rpc('session/selectModel', { sessionId: id, provider, model: model.join('/') });
    }
    this.session = { sessionId: id, sessionFile: '', resumed: Boolean(existing), cancelled: false };
    this.send({ ws: { type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } } });
    this.send({ ws: { type: 'open', streamId: 'history', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: id } } } } } });
    await Promise.all([this.opened.promise, this.eventsReady.promise]);
    return this.session;
  }
  event(event, snapshot) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < 0) throw Error('Invalid cursor');
    if (event.seq <= this.cursor) return;
    this.cursor = event.seq;
    const data = event.data;
    if (event.type === 'turn/start') { this.turn = { number: data.turn, requests: new Set(), text: '', lastSeq: event.seq, snapshot, shared: false }; this.busy = true; }
    if (event.type === 'user/message') {
      if (data.source?.kind !== 'user') return;
      const requestId = data.source?.rpcId, own = this.receipts.has(requestId) || this.knownRequests.has(requestId);
      if (this.turn) { if (requestId) this.turn.requests.add(requestId); if (!own) this.turn.shared = true; }
      this.emit('nativeEntry', { entryId: String(event.seq), role: 'user', text: contentText(data.content), own, activeOwn: this.receipts.has(requestId), snapshot, sessionId: this.session.sessionId, requestId });
    }
    if (event.type === 'assistant/message' && this.turn) { this.turn.text = contentText(data.message?.content); this.turn.lastSeq = event.seq; }
    if (event.type === 'tool/call') {
      let args; try { args = JSON.parse(data.arguments); } catch { args = {}; }
      this.tools.set(data.callId, { toolName: data.name, args });
      if (!snapshot) this.emit('nativeTool', { type: 'tool_execution_start', toolName: data.name, args, toolCallId: data.callId });
    }
    if (event.type === 'tool/result' && !snapshot) this.emit('nativeTool', { type: 'tool_execution_end', toolName: this.tools.get(data.callId)?.toolName, toolCallId: data.callId, isError: Boolean(data.error) });
    if (event.type === 'turn/end') {
      const turn = this.turn; this.busy = false;
      if (turn) {
        const own = [...turn.requests].some(id => this.receipts.has(id) || this.knownRequests.has(id));
        if (turn.text) this.emit('nativeEntry', { entryId: String(turn.lastSeq), role: 'assistant', text: turn.text, own, activeOwn: own, snapshot, sessionId: this.session.sessionId, sharedTurn: turn.shared && own, stopReason: data.reason?.kind === 'completed' ? 'stop' : 'error' });
        for (const id of turn.requests) {
          const receipt = this.receipts.get(id);
          if (!receipt) continue;
          this.statuses.set(id, 'completed');
          if (data.reason?.kind !== 'completed' || !turn.text) receipt.slot.reject(Object.assign(Error('Jetsonの実行は正常完了していません。'), { nativeTerminal: true, code: /^[A-Z_]{1,40}$/.test(data.reason?.error?.code ?? '') ? data.reason.error.code : data.reason?.kind ?? 'error' }));
          else receipt.slot.resolve({ ...this.session, requestId: id, text: turn.text, sharedTurn: turn.shared });
        }
      }
      this.turn = null;
    }
    if (!snapshot) this.emitState();
  }
  emitState() { this.emit('nativeState', { busy: this.busy || this.questions.size > 0, streaming: this.busy, queued: 0, waiting: this.questions.size > 0 }); }
  remoteEvent(value) {
    if (value.type === 'ready') { this.clientId = value.clientId; this.eventsReady.resolve(); return; }
    if (value.type === 'cancel') {
      for (const [id, item] of this.questions) if (item.value.eventId === value.eventId) { this.questions.delete(id); this.emit('questionCancelled', id); }
      this.emitState(); return;
    }
    if (value.type !== 'waterfall') return;
    if (value.agentId !== this.session?.sessionId || !['approval/request', 'user-questions/request'].includes(value.event)) {
      void this.rpc('$events/result', null, { clientId: this.clientId, eventId: value.eventId, outcome: { kind: 'next' } }).catch(() => {}); return;
    }
    if (value.event === 'user-questions/request') {
      const batch = { value, answers: [], count: value.request.questions.length };
      if (!batch.count) throw Error('Empty native question');
      for (const item of value.request.questions) {
        const id = value.eventId + ':' + item.id;
        const question = { id, method: item.options?.length ? 'select' : 'input', title: item.question, message: item.detail ?? '', ...(item.options?.length ? { options: item.options.map(option => option.label) } : {}) };
        this.questions.set(id, { value, question, item, batch }); this.emit('question', question);
      }
      this.emitState(); return;
    }
    const tool = this.tools.get(value.request.callId), operation = tool?.args;
    const question = { id: value.eventId, method: 'select', title: `Allow tool: ${value.request.toolName}`, message: `Allow tool: ${value.request.toolName}\n${value.request.displayReason?.ja ?? value.request.reason ?? ''}\n${operation ? JSON.stringify(operation) : ''}`, options: ['Approve', 'Deny'] };
    this.questions.set(value.eventId, { value, question, tool }); this.emit('question', question); this.emitState();
  }
  pendingOperation(question) { const tool = this.questions.get(question.id)?.tool; return tool ? { name: tool.toolName, arguments: tool.args } : undefined; }
  async answerUi(id, answer) {
    if (!this.questions.has(id) || !this.clientId) throw Error('確認要求は既に終了しています。');
    const pending = this.questions.get(id);
    if (pending.batch) {
      if (answer.cancelled) throw Error('質問の取消は標準Web画面で行ってください。');
      const selected = pending.item.options?.some(option => option.label === answer.value) ? [answer.value] : [];
      pending.batch.answers.push({ id: pending.item.id, selected, ...(selected.length ? {} : { custom: answer.value ?? '' }) });
      if (pending.batch.answers.length === pending.batch.count) await this.rpc('$events/result', null, { clientId: this.clientId, eventId: pending.value.eventId, outcome: { kind: 'result', value: { answers: pending.batch.answers } } });
      this.questions.delete(id); this.emit('questionCancelled', id); this.emitState(); return;
    }
    const allowed = answer.value === 'Approve' || answer.confirmed === true;
    await this.rpc('$events/result', null, { clientId: this.clientId, eventId: id, outcome: { kind: 'result', value: allowed ? 'allowed-once' : 'rejected' } });
    this.questions.delete(id); this.emit('questionCancelled', id); this.emitState();
  }
  canSteer() { return !this.closed && this.busy && [...(this.turn?.requests ?? [])].some(id => this.receipts.has(id)); }
  requestStatus(id) { return this.statuses.get(id); }
  async steer(id, text, images = []) {
    if (!this.canSteer()) return 'refused';
    try { await this.admit(id, text, images, 'steer'); return 'steered'; } catch { return 'indeterminate'; }
  }
  async admit(id, text, images, mode) {
    const digest = createHash('sha256').update(JSON.stringify([text, images])).digest('hex');
    const previous = this.receipts.get(id);
    if (previous) { if (previous.digest !== digest) throw Error('同じ送信IDを異なる入力に再利用できません。'); return previous; }
    const receipt = { digest, slot: this.slot(this.turnTimeoutMs) }; this.receipts.set(id, receipt); this.statuses.set(id, 'indeterminate');
    const content = [{ type: 'text', text }, ...images.map(image => ({ type: 'image', data: image.data, mediaType: image.mimeType }))];
    const result = await this.rpc('session/prompt', { sessionId: this.session.sessionId, requestId: id, mode, content, clientTimeZone: 'Asia/Tokyo' });
    if (result.accepted !== true) throw Error('Jetsonでの受理を確認できません。');
    if (this.statuses.get(id) !== 'completed') this.statuses.set(id, 'accepted');
    return receipt;
  }
  async submit(id, text, images = []) {
    await this.initialize();
    // Atomic native queue admission preserves a human's in-progress turn and never edits their draft.
    const receipt = await this.admit(id, text, images, 'queue');
    return receipt.slot.promise;
  }
  async command(type) {
    if (type === 'get_messages') return { messages: [] };
    if (type === 'get_state') return { isStreaming: this.busy, isCompacting: false };
    throw Error('このDeepseekHarness操作には対応していません。');
  }
  async stop() {
    if (this.canSteer()) return (await this.rpc('session/cancel', { sessionId: this.session.sessionId })).accepted === true;
    if (![...this.receipts.keys()].some(id => this.statuses.get(id) === 'accepted')) return false;
    const projection = await this.rpc('session/projections', { sessionId: this.session.sessionId });
    const inbox = projection?.values?.inbox;
    let removed = false;
    for (const message of [...(inbox?.['next-turn'] ?? []), ...(inbox?.['next-step'] ?? [])]) {
      const id = message.source?.rpcId;
      if (message.source?.kind !== 'user' || !this.receipts.has(id) || this.statuses.get(id) === 'completed') continue;
      const response = await this.rpc('session/updateQueue', { sessionId: this.session.sessionId, itemId: message.id, action: { kind: 'remove' } });
      if (response.accepted === true) { this.statuses.set(id, 'completed'); this.receipts.get(id).slot.reject(Error('未実行の入力を取り消しました。')); removed = true; }
    }
    return removed;
  }
  fail(message) {
    if (this.closed) return;
    this.closed = true; const error = Error(message);
    this.ready.reject(error); this.opened.reject(error); this.eventsReady.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    for (const receipt of this.receipts.values()) receipt.slot.reject(error);
    this.child.kill(); this.emit('disconnected');
  }
  close() { this.fail('NativeConnect接続を終了しました。Jetsonの共有Web版は継続します。'); }
}

export async function nativeDshCatalog(binding, action, args = {}, { signal } = {}) {
  const client = NativeDsh.connect(binding);
  const abort = () => client.close(); signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted(); await client.ready.promise;
    const descriptor = item => ({ id: item.sessionId, name: item.projections?.values?.title ?? item.sessionId, directory: binding.stateRoot, cwd: item.cwd ?? binding.cwd, running: item.agentAvailable, shared: true, busy: item.running });
    if (action === 'list') return { sessions: (await client.rpc('session/list', {})).items.filter(item => item.origin !== 'subagent').map(descriptor) };
    if (action === 'create') {
      const id = 'omb-' + createHash('sha256').update(args.operationId).digest('hex').slice(0, 32);
      await client.rpc('session/create', { sessionId: id, cwd: binding.cwd });
      await client.rpc('session/rename', { sessionId: id, title: args.name });
      const [provider, ...model] = (binding.model ?? '').split('/');
      if (provider && model.length) await client.rpc('session/selectModel', { sessionId: id, provider, model: model.join('/') });
      return { session: { ...descriptor({ sessionId: id, agentAvailable: true, running: false }), name: args.name } };
    }
    throw Error('未対応のDeepseekHarness管理操作です。');
  } finally { signal?.removeEventListener('abort', abort); client.close(); }
}
