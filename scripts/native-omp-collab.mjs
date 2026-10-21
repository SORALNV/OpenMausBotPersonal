import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { nativeOmpCommand } from './native-omp-transport.mjs';
import { startOmpRelay } from './native-omp-collab-relay.mjs';

const BOOTSTRAP = String.raw`
import sys,json,os,subprocess,time,fcntl,select
b=json.loads(sys.stdin.readline())
d=b['sessionDir']; os.makedirs(d,mode=0o700,exist_ok=True)
lock=open(d+'/.nativeconect.lock','a'); os.chmod(d+'/.nativeconect.lock',0o600)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
name='omb-native-'+os.path.basename(d)[:20]
config=d+'/.nativeconect.yml'
settings='collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:'+str(b['remotePort'])+'\n'
if b.get('advisor'):
 settings+='advisor:\n  enabled: true\n  syncBacklog: off\nmodelRoles:\n  advisor: '+json.dumps(b['model'])+'\n'
fd=os.open(config,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write(settings)
base=[b['binary'],'--profile',b['profile']]
def run(args):return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=20)
if run(['tmux','has-session','-t',name]).returncode:
 for proc in os.listdir('/proc'):
  if not proc.isdigit():continue
  try:
   parts=open('/proc/'+proc+'/cmdline','rb').read().decode().split('\0')
   if '--session-dir' in parts and parts[parts.index('--session-dir')+1]==d:raise RuntimeError('Another native session writer is active')
  except (OSError,UnicodeError,ValueError):pass
 args=base+['--cwd',b['cwd'],'--model',b['model'],'--config',config,'--session-dir',d,'--continue','--no-lsp','--no-pty','--no-extensions','--no-skills','--no-rules','--no-title','--tools','read,bash,edit,write,grep,glob,ask','--approval-mode','always-ask']
 import shlex
 r=run(['tmux','new-session','-d','-s',name,'-x','120','-y','40',shlex.join(args)])
 if r.returncode: raise RuntimeError('Could not start managed native TUI')
for attempt in range(40):
 if select.select([sys.stdin],[],[],0)[0] and not sys.stdin.readline():raise RuntimeError('Native caller disconnected during startup')
 r=run(base+['collab','list','--json'])
 try: hosts=json.loads(r.stdout)['hosts']
 except Exception: hosts=[]
 matches=[h for h in hosts if h.get('cwd')==b['cwd'] and h.get('sessionId')==b.get('expectedSessionId')]
 if not b.get('expectedSessionId'):
  pid=run(['tmux','display-message','-p','-t',name,'#{pane_pid}']).stdout.strip()
  matches=[h for h in hosts if str(h.get('pid'))==pid]
 if len(matches)==1 and matches[0].get('connected',matches[0].get('relayConnected',True)):
  h=matches[0]; link=run(base+['collab','link',h['instanceId'],'--json'])
  if link.returncode==0:
   files=[f for f in os.listdir(d) if f.endswith('.jsonl') and h['sessionId'] in f]
   if len(files)!=1:raise RuntimeError('Native session file identity unavailable')
   print(json.dumps({'type':'nativeconect_host','host':h,'link':json.loads(link.stdout),'tmux':name,'sessionFile':d+'/'+files[0]}),flush=True)
   break
 time.sleep(.5)
else:raise RuntimeError('Native Collab host unavailable; no alternate session created')
for line in sys.stdin:
 if line.strip()=='close':break
`;

export function sealOmpFrame(key, frame) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([Buffer.alloc(4), iv, cipher.update(JSON.stringify(frame), 'utf8'), cipher.final(), cipher.getAuthTag()]);
}
export function openOmpFrame(key, data) {
  if (data.length < 32 || data.length > 8 * 1024 * 1024) throw Error('Invalid Collab envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(16, -16)), decipher.final()]).toString('utf8'));
}
const textOf = message => typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.filter(v => v.type === 'text').map(v => v.text).join('\n') : '';

/** Attaches as a standard OhMyPi 18.12.5 Collab guest. The native TUI alone owns the session writer. */
export class NativeOmpCollab extends EventEmitter {
  constructor(binding, options = {}) {
    super(); this.binding = binding; this.options = options; this.entries = new Map(); this.ui = new Map(); this.receipts = new Map(); this.closed = false;
  }
  static connect(binding, options) { return new NativeOmpCollab(binding, options); }
  initialize() { return this.initializing ??= this.boot(); }
  async boot() {
    if (this.session) return this.session;
    try {
      const plan = nativeOmpCommand(this.binding), remotePort = 18000 + Number.parseInt(plan.sessionDir.slice(-6), 16) % 20000;
      this.relay = await startOmpRelay();
      const args = plan.args.slice(0, -1);
      args.splice(args.indexOf('--'), 0, '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${this.relay.port}`);
      args[args.indexOf('ClearAllForwardings=yes')] = 'ClearAllForwardings=no';
      const command = `exec python3 -c '${BOOTSTRAP.replaceAll("'", "'\\''")}'`;
      args.push(command);
      const env = Object.fromEntries(['HOME','PATH','SSH_AUTH_SOCK','TMPDIR'].flatMap(k => process.env[k] ? [[k,process.env[k]]] : []));
      this.child = spawn(plan.command, args, { env, stdio: ['pipe','pipe','pipe'], shell: false });
      this.child.stderr.on('data', () => {});
      const meta = await new Promise((resolve, reject) => {
        let buffer = ''; const timer = setTimeout(() => reject(Error('Native TUI startup timed out')), this.options.timeoutMs ?? 90000);
        this.child.once('error', () => { clearTimeout(timer); reject(Error('Native SSH startup failed')); });
        this.child.once('close', () => { clearTimeout(timer); reject(Error('Native SSH disconnected')); this.fail('Native SSH disconnected; no automatic replay'); });
        this.child.stdout.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 64000) { clearTimeout(timer); reject(Error('Invalid native host metadata')); return; }
          if (buffer.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(buffer.split('\n')[0])); } catch { reject(Error('Invalid native host metadata')); } }
        });
        this.child.stdin.on('error', () => {});
        this.child.stdin.write(JSON.stringify({ ...this.binding, sessionDir: plan.sessionDir, remotePort })+'\n');
      });
      let link = typeof meta.link === 'string' ? meta.link : meta.link.url ?? meta.link.link;
      if (typeof link === 'string' && link.startsWith('http://')) {
        const url = new URL(link);
        if (!['localhost','127.0.0.1'].includes(url.hostname) || Number(url.port) !== remotePort || !url.hash || url.username || url.password || url.search) throw Error('Unexpected native relay URL');
        link = decodeURIComponent(url.hash.slice(1));
        if (!link.startsWith('ws://')) link = `ws://127.0.0.1:${remotePort}/r/${link}`;
      }
      if (!['localhost','127.0.0.1'].some(host=>link?.startsWith(`ws://${host}:${remotePort}/r/`))) throw Error('Unexpected private relay endpoint');
      const match = /^ws:\/\/(?:localhost|127\.0\.0\.1):\d+\/r\/([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]+)$/.exec(link ?? '');
      if (!match || Buffer.from(match[2], 'base64url').length !== 48) throw Error('Pinned private Collab link required');
      const secret = Buffer.from(match[2], 'base64url'); this.key = secret.subarray(0,32);
      this.hostSessionId=meta.host.sessionId;
      this.name = 'OMB-'+this.binding.threadId.slice(0,24);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Native Collab welcome timed out')), 30000);
        this.onWelcome = () => { clearTimeout(timer); resolve(); };
        this.ws = new WebSocket(`ws://127.0.0.1:${this.relay.port}/r/${match[1]}?role=guest`, { maxPayload: 8*1024*1024, perMessageDeflate: false });
        this.ws.on('open', () => this.send({t:'hello',proto:3,name:this.name,writeToken:secret.subarray(32).toString('base64url')}));
        this.ws.on('message', (data,binary) => {
          try { if (!binary) throw Error('Native host closed'); this.frame(openOmpFrame(this.key,Buffer.from(data))); }
          catch { clearTimeout(timer); reject(Error('Invalid native Collab stream')); this.fail('Native Collab disconnected; no automatic replay'); }
        });
        this.ws.on('error', () => { clearTimeout(timer); reject(Error('Native Collab connection failed')); });
        this.ws.on('close', () => this.fail('Native Collab disconnected; no automatic replay'));
      });
      if (this.session.sessionId !== meta.host.sessionId || (this.binding.expectedSessionId && this.session.sessionId !== this.binding.expectedSessionId)) throw Error('Native session identity changed');
      if (typeof meta.sessionFile !== 'string' || !meta.sessionFile.startsWith(plan.sessionDir+'/') || meta.sessionFile.split('/').includes('..')) throw Error('Invalid native session file');
      this.session.sessionFile = meta.sessionFile;
      this.tmux = meta.tmux;
      return this.session;
    } catch (error) { this.close(); throw error; }
  }
  send(frame) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw Error('Native Collab unavailable');
    this.ws.send(sealOmpFrame(this.key,frame));
  }
  idle() { return this.state?.isStreaming === false && this.state.queuedMessageCount === 0 && !this.state.isAborting && this.ui.size === 0; }
  async submit(id, text) {
    if (!this.session || this.closed || this.turn) throw Error('Native shared session unavailable');
    if (!id || typeof text !== 'string' || !text.trim() || text.length > 100000) throw Error('Invalid native prompt');
    if (this.receipts.has(id)) throw Error('Native request already submitted');
    this.receipts.set(id,{stage:'queued'});
    return await new Promise((resolve,reject) => {
      this.turn = { id,text,resolve,reject,admitted:false,ended:false,texts:[],contended:false };
      this.pump();
    });
  }
  pump() {
    const turn=this.turn;
    if (!turn || turn.sent || !this.idle()) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer=setTimeout(() => { if (this.turn!==turn || !this.idle()) return; turn.sent=true; this.receipts.get(turn.id).stage='sent'; this.send({t:'prompt',text:turn.text}); this.armTurnDeadline(); },250);
  }
  requestStatus(id) { return this.receipts.get(id)?.stage; }
  armTurnDeadline() {
    const turn=this.turn;
    if (!turn) return;
    clearTimeout(turn.timer);
    if (!turn.sent || this.ui.size) return;
    turn.timer=setTimeout(() => { if(this.turn!==turn)return; turn.reject(Error('Native shared turn timed out; do not replay')); this.turn=null; },this.options.turnTimeoutMs ?? 600000);
  }
  frame(frame) {
    if (frame.t==='welcome') {
      if (frame.proto!==3 || frame.readOnly || !frame.header?.id || (this.hostSessionId && frame.header.id!==this.hostSessionId) || (this.binding.expectedSessionId && frame.header.id!==this.binding.expectedSessionId)) throw Error('Unsupported native Collab welcome');
      this.session={sessionId:frame.header.id,sessionFile:'',resumed:true,cancelled:false}; this.state=frame.state; this.snapshot=[];
    }
    if (frame.t==='snapshot-chunk') {
      if (!this.snapshot || !Array.isArray(frame.entries) || this.entries.size+frame.entries.length>100000) throw Error('Invalid native snapshot');
      this.snapshot.push(...frame.entries);
      if (frame.final) { for (const entry of this.snapshot) this.entry(entry,true); this.snapshot=null; this.emit('nativeState',{busy:!this.idle()}); this.onWelcome?.(); }
    }
    if (frame.t==='entry') this.entry(frame.entry,false);
    if (frame.t==='state') { this.state=frame.state; this.emit('nativeState',{busy:!this.idle()}); this.pump(); this.finish(); }
    if (frame.t==='event') {
      const e=frame.event;
      if (e.type==='agent_start') { if(this.state)this.state.isStreaming=true; this.emit('nativeState',{busy:true}); }
      if (e.type==='agent_end') { if(this.turn?.admitted)this.turn.ended=true; }
      if (['tool_execution_start','tool_execution_end'].includes(e.type)) this.emit('nativeTool',e);
      this.finish();
    }
    if (frame.t==='ui-request') {
      const r=frame.request;
      if (!['select','editor'].includes(r.kind) || !Number.isInteger(r.reqId)) throw Error('Unsupported native question');
      const options=r.options?.map(o=>typeof o==='string'?o:o.label);
      this.ui.set(String(r.reqId),r);
      this.armTurnDeadline();
      this.emit('question',{id:String(r.reqId),method:r.kind,title:r.title,options});
    }
    if(frame.t==='ui-request-end') {this.ui.delete(String(frame.reqId));this.armTurnDeadline();this.emit('questionCancelled',String(frame.reqId));this.finish();this.pump();}
    if(frame.t==='error'||frame.t==='bye') this.fail('Native shared operation failed; do not replay');
  }
  entry(entry,snapshot) {
    if (!entry || typeof entry.id!=='string' || this.entries.has(entry.id)) return;
    this.entries.set(entry.id,entry);
    const msg=entry.message ?? (entry.type==='custom_message'?{role:'user',content:entry.content,details:entry.details,customType:entry.customType}:null);
    const text=textOf(msg);
    const own=entry.type==='custom_message' && entry.details?.from===this.name;
    const turn=this.turn;
    if (!snapshot && turn?.sent && own && text===turn.text) { turn.admitted=true; this.receipts.get(turn.id).stage='accepted'; }
    if (!snapshot && turn?.sent && !own && msg?.role==='user') turn.contended=true;
    if (!snapshot && turn?.admitted && msg?.role==='assistant') {
      if (['error','aborted'].includes(msg.stopReason)) { this.fail('Native shared turn failed; do not replay'); return; }
      if(text)turn.texts.push(text);
    }
    this.emit('nativeEntry',{entryId:entry.id,role:msg?.role,text,snapshot,own,sessionId:this.session?.sessionId,activeOwn:!!turn?.admitted});
  }
  finish() {
    const turn=this.turn;
    if (!turn?.admitted || !turn.ended || !this.idle() || !turn.texts.length) return;
    clearTimeout(turn.timer); this.turn=null;
    this.receipts.get(turn.id).stage='completed';
    turn.resolve({requestId:turn.id,sessionId:this.session.sessionId,sessionFile:this.session.sessionFile,text:turn.texts.join('\n\n'),sharedTurn:turn.contended});
  }
  answerUi(id,answer) {
    const r=this.ui.get(id); if(!r)throw Error('Native question already answered');
    if(answer.cancelled===true)this.send({t:'ui-response',reqId:r.reqId});
    else if(typeof answer.value==='string' && (r.kind!=='select'||r.options.some(o=>(typeof o==='string'?o:o.label)===answer.value)))this.send({t:'ui-response',reqId:r.reqId,value:answer.value});
    else throw Error('Invalid native answer');
    this.ui.delete(id);
  }
  async stop() {
    const turn=this.turn; if(!turn)return false;
    if(!turn.sent){clearTimeout(turn.timer);this.turn=null;turn.reject(Error('Queued native input cancelled'));return true;}
    // Collab abort targets the shared host: never interrupt a concurrent human turn.
    if(!turn.admitted||turn.contended)return false;
    this.send({t:'abort'});return false;
  }
  fail(message) {
    if(this.closed)return;
    clearTimeout(this.pumpTimer);
    if(this.turn){clearTimeout(this.turn.timer);this.turn.reject(Error(message));this.turn=null;}
    this.emit('disconnected',message);this.close();
  }
  close() {
    if(this.closed)return;this.closed=true;clearTimeout(this.pumpTimer);
    if(this.turn){clearTimeout(this.turn.timer);this.turn.reject(Error('Native connection detached; do not replay'));this.turn=null;}
    this.ws?.close();this.child?.stdin.end();this.child?.kill('SIGTERM');void this.relay?.close();
  }
}
