import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import { posix } from 'node:path';
import { WebSocket } from 'ws';
import { nativeOmpCommand } from './native-omp-transport.mjs';
import { startOmpRelay } from './native-omp-collab-relay.mjs';
import { nativeOmpTui } from './native-omp-tui.mjs';
import { nativeOmpCatalog } from './native-omp-catalog.mjs';

const BOOTSTRAP = String.raw`
import sys,json,os,subprocess,time,fcntl,select,re,hashlib
b=json.loads(sys.stdin.readline())
d=b['sessionDir']; os.makedirs(d,mode=0o700,exist_ok=True)
identity=b.get('expectedSessionId') or b.get('sessionFile')
suffix='-'+hashlib.sha256(identity.encode()).hexdigest()[:20] if identity else ''
lock_path=d+'/.nativeconect'+suffix+'.lock'
lock_fd=os.open(lock_path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
lock=os.fdopen(lock_fd,'a');os.chmod(lock_path,0o600)
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
name='omb-native-'+(hashlib.sha256((d+'|'+identity).encode()).hexdigest()[:20] if identity else os.path.basename(d)[:20])
config=d+'/.nativeconect'+suffix+'.yml'
settings='collab:\n  autoStart: control\n  relayUrl: ws://127.0.0.1:'+str(b['remotePort'])+'\n'
if b.get('advisor'):
 settings+='advisor:\n  enabled: true\n  syncBacklog: off\nmodelRoles:\n  advisor: '+json.dumps(b['model'])+'\n'
fd=os.open(config,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as f:f.write(settings)
base=[b['binary'],'--profile',b['profile']]
def run(args):return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=20)
def refuse(code):print(json.dumps({'error':code}),flush=True);sys.exit(1)
def writers(directory=d):
 result=[]
 listing=run(base+['collab','list','--json']) if directory is not None else None
 hosts=json.loads(listing.stdout).get('hosts',[]) if listing and listing.returncode==0 else []
 bypid={str(h.get('pid')):h for h in hosts}
 for proc in os.listdir('/proc'):
  if not proc.isdigit():continue
  try:
   parts=open('/proc/'+proc+'/cmdline','rb').read().decode().split('\0')
   if not parts or parts[0]!=b['binary'] or '--profile' not in parts or parts[parts.index('--profile')+1]!=b['profile']:continue
   if directory is None:result.append(proc);continue
   if '--session-dir' not in parts or parts[parts.index('--session-dir')+1]!=directory:continue
   if b.get('expectedSessionId'):
    h=bypid.get(proc)
    if h:
     if h.get('sessionId')==b['expectedSessionId']:result.append(proc)
     continue
    resume=parts[parts.index('--resume')+1] if '--resume' in parts else None
    if resume:
     saved_id=None
     with open(resume) as saved:
      for i,line in enumerate(saved):
       if i>=32 or len(line)>1048576:break
       try:
        item=json.loads(line)
        if item.get('type')=='session':saved_id=item.get('id');break
       except ValueError:pass
     if saved_id!=b['expectedSessionId']:refuse('NATIVE_TUI_REQUIRES_SHARING')
    else:
     saved=[f for f in os.listdir(directory) if f.endswith('.jsonl')]
     if len(saved)!=1:refuse('AMBIGUOUS_NATIVE_WRITER')
     if b['expectedSessionId'] not in saved[0]:continue
   result.append(proc)
  except (OSError,UnicodeError,ValueError,IndexError):pass
 return result
def enable_unattended(pane,session):
 if run(['tmux','list-clients','-t',session,'-F','#{client_name}']).stdout.strip():refuse('NATIVE_TUI_ATTACHED')
 cursor=run(['tmux','display-message','-p','-t',pane,'#{cursor_x} #{cursor_y}']).stdout.split()
 if len(cursor)!=2:refuse('NATIVE_DRAFT_PRESENT')
 x,y=map(int,cursor); lines=run(['tmux','capture-pane','-p','-t',pane]).stdout.splitlines()
 suffix=lines[y][2:] if y<len(lines) and lines[y].startswith('╰─') else None
 # OhMyPi 18.12.5 composer-hints.ts renders these right-aligned placeholders only in an empty composer.
 empty=suffix is not None and (not suffix.strip() or re.fullmatch(r'\s{8,}(?:\S{1,24} to change thinking effort|←← to see [1-9][0-9]* running agents?)\s*',suffix))
 if x!=3 or y<1 or y>=len(lines) or not empty or ('-'+b['profile']) not in lines[y-1] or ' > ' not in lines[y-1]:refuse('NATIVE_DRAFT_PRESENT')
 import shlex
 command='/collab ws://127.0.0.1:'+str(b['remotePort'])
 condition='#{&&:#{==:#{session_attached},0},#{&&:#{==:#{cursor_x},3},#{==:#{cursor_y},'+str(y)+'}}}'
 action=shlex.join(['send-keys','-t',pane,'-l','\x1b[200~'+command+'\x1b[201~'])
 if run(['tmux','if-shell','-F','-t',pane,condition,action]).returncode:refuse('NATIVE_SHARING_UNAVAILABLE')
 deadline=time.monotonic()+90
 while time.monotonic()<deadline:
  if run(['tmux','list-clients','-t',session,'-F','#{client_name}']).stdout.strip():refuse('NATIVE_TUI_ATTACHED')
  lines=run(['tmux','capture-pane','-p','-t',pane]).stdout.splitlines()
  if y<len(lines) and lines[y].strip()=='╰─ '+command:break
  time.sleep(.25)
 else:refuse('NATIVE_DRAFT_PRESENT')
 condition='#{&&:#{==:#{session_attached},0},#{&&:#{==:#{cursor_x},'+str(3+len(command))+'},#{==:#{cursor_y},'+str(y)+'}}}'
 if run(['tmux','if-shell','-F','-t',pane,condition,shlex.join(['send-keys','-t',pane,'Enter'])]).returncode:refuse('NATIVE_SHARING_UNAVAILABLE')
if run(['tmux','has-session','-t',name]).returncode:
 pids=writers()
 if pids:
  if len(pids)!=1:refuse('MULTIPLE_NATIVE_WRITERS')
  panes=[line.split('\t') for line in run(['tmux','list-panes','-a','-F','#{session_name}\t#{pane_id}\t#{pane_pid}']).stdout.splitlines()]
  panes=[p for p in panes if len(p)==3 and p[2]==pids[0]]
  if len(panes)!=1:refuse('NATIVE_TUI_REQUIRES_SHARING')
  name,pane,_=panes[0]
  listing=run(base+['collab','list','--json'])
  hosts=json.loads(listing.stdout).get('hosts',[]) if listing.returncode==0 else []
  if not any(str(h.get('pid'))==pids[0] for h in hosts):enable_unattended(pane,name)
 else:
  if len(writers(None))>=8:refuse('NATIVE_SESSION_LIMIT')
  resume=['--resume',b['sessionFile']] if b.get('sessionFile') else ['--continue']
  has_model=False
  if b.get('sessionFile'):
   with open(b['sessionFile']) as saved:
    for line in saved:
     try:
      if json.loads(line).get('type')=='model_change':has_model=True;break
     except ValueError:pass
  model=[] if has_model else ['--model',b['model']]
  args=base+['--cwd',b['cwd']]+model+['--config',config,'--session-dir',d]+resume+['--no-lsp','--no-pty','--no-extensions','--no-skills','--no-rules','--no-title','--tools','read,bash,edit,write,grep,glob,ask','--approval-mode','always-ask']
  import shlex
  r=run(['tmux','new-session','-d','-s',name,'-x','120','-y','40',shlex.join(args)])
  if r.returncode: raise RuntimeError('Could not start managed native TUI')
def discover():
 for attempt in range(80):
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
    if len(files)>1:raise RuntimeError('Native session file identity ambiguous')
    return {'type':'nativeconect_host','host':h,'link':json.loads(link.stdout),'tmux':name,'sessionFile':d+'/'+files[0] if files else ''}
  time.sleep(.5)
 return {'error':'NATIVE_SHARING_UNAVAILABLE'}
meta=discover()
print(json.dumps(meta),flush=True)
if meta.get('host'):b['expectedSessionId']=meta['host']['sessionId']
for line in sys.stdin:
 if line.strip()=='close':break
 if line.strip()=='refresh':print(json.dumps(discover()),flush=True)
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

export function nativeToolPaths(args) {
  const paths=typeof args?.path==='string'?[args.path]:[];
  if(typeof args?.input==='string')for(const match of args.input.matchAll(/^\[([^\]\n]+)#[A-Fa-f0-9]+\]$|^\*\*\* (?:Update|Add|Delete) File: ([^\n]+)$/gmu))paths.push(match[1]??match[2]);
  return [...new Set(paths)];
}
const reviewFilePath=(cwd,path)=>{
  if(typeof path!=='string'||!posix.isAbsolute(cwd)||cwd==='/'||!/[\w]/u.test(path)||!/^[\p{L}\p{N}_./ -]+$/u.test(path)||path.split('/').includes('..'))return null;
  const full=posix.resolve(cwd,path),relative=posix.relative(cwd,full);
  if(!relative||relative.startsWith('../')||posix.isAbsolute(relative)||/(?:\.ssh|\.gnupg|\.aws|\.env\b|auth\.json|credentials?|password|shadow|secret|token|keychain)/iu.test(relative))return null;
  if(relative.split('/').some(part=>part.startsWith('.')&&!['.gitignore','.mcp.json','.editorconfig'].includes(part)))return null;
  return full;
};
export const READ_REVIEW_FILES=String.raw`
import sys,json,pathlib,os,stat,re
b=json.load(sys.stdin); root=pathlib.Path(b['cwd']); result=[]; total=0
if not root.is_absolute() or str(root.resolve())!=str(root) or str(root)=='/':raise RuntimeError('invalid workspace')
for name in b['paths'][:12]:
 try:
  p=pathlib.Path(name); rel=p.relative_to(root)
  if str(p.resolve())!=str(p) or '..' in rel.parts or any(x.startswith('.') and x not in ['.gitignore','.mcp.json','.editorconfig'] for x in rel.parts):continue
  if re.search(r'\.ssh|\.gnupg|\.aws|\.env\b|auth\.json|credentials?|password|shadow|secret|token|keychain',str(rel),re.I):continue
  fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  with os.fdopen(fd,'rb') as f:
   info=os.fstat(f.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_size>32000:continue
   data=f.read(32001)
  if len(data)>32000 or total+len(data)>96000:continue
  content=data.decode('utf8');total+=len(data);result.append({'path':str(p),'content':content})
 except (OSError,ValueError,UnicodeError):pass
print(json.dumps(result))
`;

/** Attaches as a standard OhMyPi 18.12.5 Collab guest. The native TUI alone owns the session writer. */
export class NativeOmpCollab extends EventEmitter {
  constructor(binding, options = {}) {
    super(); this.binding = binding; this.options = options; this.entries = new Map(); this.ui = new Map(); this.uiAnswers = new Map(); this.receipts = new Map(); this.steerWaiters = new Map(); this.localUi = new Map(); this.localUnknown=false; this.closed = false; this.lifetime = new AbortController();
  }
  static connect(binding, options) { return new NativeOmpCollab(binding, options); }
  initialize() { return this.initializing ??= this.boot().then(session=>{this.watchState();return session;}); }
  watchState() {
    if(this.stateTimer || this.closed)return;
    this.stateTimer=setInterval(()=>{if(!this.idle() && !this.reconnecting)void this.checkState();},this.options.stateCheckMs??30000);
    this.stateTimer.unref();
    if(!this.idle())void this.checkState();
  }
  async checkState() {
    if(this.checkingState || this.closed || this.reconnecting)return;
    this.checkingState=true;
    try {
      const meta=await this.refreshMetadata(30000),host=meta.host;
      if(!host || host.sessionId!==this.session?.sessionId) {this.reconnect();return;}
      if(host.busy===false && host.inputRequired===false) {
        if(this.state?.isStreaming || this.state?.queuedMessageCount || this.state?.isAborting || this.ui.size) {this.reconnect();return;}
        if(this.resyncUi?.size) {
          for(const id of this.resyncUi.keys())this.emit('questionCancelled',id);
          this.resyncUi=undefined;
          this.emit('nativeState',{busy:!this.idle(),streaming:false,queued:this.state?.queuedMessageCount??0,waiting:false});
          this.finish();this.pump();
        }
      } else if(host.inputRequired===true && !this.ui.size && !this.resyncUi?.size)this.reconnect();
      if(host.busy===true && host.inputRequired===false && !this.ui.size)await this.checkLocalUi(meta);
      else if(!host.busy || host.inputRequired)this.clearLocalUi();
    } catch {if(!this.closed)this.reconnect();}
    finally {this.checkingState=false;}
  }
  clearLocalUi(except) {
    let changed=this.localUnknown;this.localUnknown=false;
    for(const id of this.localUi.keys())if(id!==except){this.localUi.delete(id);this.emit('questionCancelled',id);changed=true;}
    if(changed){this.emit('nativeState',{busy:!this.idle(),streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0 || this.localUi.size>0 || this.localUnknown});this.finish();this.pump();}
  }
  async checkLocalUi(metadata) {
    if([...this.uiAnswers.keys()].some(id=>this.localUi.has(id)))return;
    try {
      const binding={...this.binding,expectedSessionId:this.session.sessionId,sessionDir:this.plan?.sessionDir??this.binding.sessionDir};
      const reply=await (this.options.localUi??nativeOmpTui)(binding,metadata,'probe',{}, {signal:this.lifetime.signal});
      if(this.closed || this.reconnecting || this.ui.size || [...this.uiAnswers.keys()].some(id=>this.localUi.has(id)))return;
      const q=reply.question;this.clearLocalUi(q?.id);this.localUnknown=reply.approvalVisible===true && !q;
      if(this.localUnknown)this.emit('nativeNotice',{code:'local-approval-unrecognized',admitted:true});
      if(q && !this.localUi.has(q.id)){this.localUi.set(q.id,q);this.emit('question',q);}
      this.emit('nativeState',{busy:!this.idle(),streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0 || this.localUi.size>0 || this.localUnknown});
    } catch { if(!this.closed)this.emit('nativeState',{busy:true,streaming:false,queued:0,waiting:false}); }
  }
  answerLocalUi(id,answer) {
    const q=this.localUi.get(id),existing=this.uiAnswers.get(id);
    if(existing){if(existing.answer!==JSON.stringify(answer))throw Error('Native answer already being delivered');return existing.promise;}
    if(!q || !['Approve','Deny'].includes(answer.value))throw Error('Invalid native terminal answer');
    const promise=(async()=>{
      const binding={...this.binding,expectedSessionId:this.session.sessionId,sessionDir:this.plan?.sessionDir??this.binding.sessionDir};
      const receipt=await (this.options.localUi??nativeOmpTui)(binding,this.metadata,'answer',{fingerprint:q.fingerprint,operationId:q.operationId,value:answer.value},{signal:this.lifetime.signal});
      if(receipt.received!==true)throw Error('Native terminal answer receipt unconfirmed');
      if(this.localUi.get(id)===q){this.localUi.delete(id);this.emit('questionCancelled',id);}
      this.emit('nativeState',{busy:!this.idle(),streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0 || this.localUi.size>0 || this.localUnknown});
    })();
    const slot={answer:JSON.stringify(answer),promise,reject:()=>{}};this.uiAnswers.set(id,slot);
    promise.finally(()=>{if(this.uiAnswers.get(id)===slot)this.uiAnswers.delete(id);}).catch(()=>{});return promise;
  }
  async boot() {
    if (this.session) return this.session;
    try {
      if (this.options.host) {
        const host=this.options.host;
        await host.initialize();
        this.lifetime.signal.throwIfAborted();
        this.plan=host.plan;this.remotePort=host.remotePort;this.relay=host.relay;
        await this.join(host.metadata);
        return this.session;
      }
      const plan = nativeOmpCommand(this.binding);
      const existing=await nativeOmpCatalog({...this.binding,sessionDir:plan.sessionDir},'inspect',{}, {signal:this.lifetime.signal});
      const identity=this.binding.expectedSessionId??this.binding.sessionFile;
      const suffix=identity ? createHash('sha256').update(plan.sessionDir+'|'+identity).digest('hex').slice(-6) : /^[a-f0-9]{6}$/u.test(plan.sessionDir.slice(-6)) ? plan.sessionDir.slice(-6) : createHash('sha256').update(plan.sessionDir).digest('hex').slice(-6);
      const remotePort = existing.plan?.remotePort ?? 18000 + Number.parseInt(suffix, 16) % 20000;
      this.relay = await startOmpRelay();
      const args = plan.args.slice(0, -1);
      args.splice(args.indexOf('--'), 0, '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${this.relay.port}`);
      args[args.indexOf('ClearAllForwardings=yes')] = 'ClearAllForwardings=no';
      const command = `exec python3 -c '${BOOTSTRAP.replaceAll("'", "'\\''")}'`;
      args.push(command);
      const env = Object.fromEntries(['HOME','PATH','SSH_AUTH_SOCK','TMPDIR'].flatMap(k => process.env[k] ? [[k,process.env[k]]] : []));
      this.child = spawn(plan.command, args, { env, stdio: ['pipe','pipe','pipe'], shell: false });
      this.child.stderr.on('data', () => {});
      const lines = createInterface({ input: this.child.stdout });
      lines.on('line', line => {
        if (line.length > 64000) { this.fail('Invalid native host metadata'); return; }
        try { this.emit('metadata', JSON.parse(line)); } catch { this.fail('Invalid native host metadata'); }
      });
      this.child.once('error', () => this.fail('Native SSH startup failed'));
      this.child.once('close', () => this.fail('Native SSH disconnected; no automatic replay'));
      this.child.stdin.on('error', () => {});
      this.plan = plan;
      const metadata = this.nextMetadata(this.options.timeoutMs ?? 90000);
      this.child.stdin.write(JSON.stringify({ ...this.binding, sessionDir: plan.sessionDir, remotePort })+'\n');
      const meta = await metadata;
      if(meta.error)throw Error(({NATIVE_TUI_ATTACHED:'標準OhMyPi TUIが別の端末で使用されています。そのTUIで共有を有効にするか、端末をデタッチしてから接続してください。',NATIVE_DRAFT_PRESENT:'標準OhMyPi TUIに下書きまたはダイアログがあります。入力を保持したまま接続を中止しました。',NATIVE_TUI_REQUIRES_SHARING:'起動中のOhMyPiは共有が無効です。標準TUIでCollabを有効にしてください。',NATIVE_SESSION_LIMIT:'このOMPプロファイルの起動数が上限8個に達しています。実行状況を確認し、不要なTUIを終了してから接続してください。'})[meta.error]??'OMPの共有接続を開始できません。');
      this.remotePort = remotePort;
      await this.join(meta);
      return this.session;
    } catch (error) { this.close(); throw error; }
  }
  async nextMetadata(timeout) {
    return (await once(this, 'metadata', { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeout)]) }))[0];
  }
  refreshMetadata(timeout) {
    if(this.options.host)return this.options.host.refreshMetadata(timeout);
    const next=(this.refreshingMetadata??Promise.resolve()).catch(()=>{}).then(async()=>{
      if(this.closed)throw Error('Native host unavailable');
      const pending=this.nextMetadata(timeout);this.child.stdin.write('refresh\n');
      return this.metadata=await pending;
    });
    this.refreshingMetadata=next;return next;
  }
  async join(meta, timeoutMs = 30000) {
      const { remotePort, plan } = this;
      if (!meta.host?.sessionId || (this.hostSessionId && this.hostSessionId !== meta.host.sessionId)
        || (this.binding.expectedSessionId && meta.host.sessionId !== this.binding.expectedSessionId)) throw Error('Native session identity unavailable or changed');
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
      this.metadata=meta;
      this.name = 'OMB-'+this.binding.threadId.slice(0,24);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Native Collab welcome timed out')), timeoutMs);
        let ready = false;
        this.onJoinAbort = () => { clearTimeout(timer); reject(Error('Native Collab closed')); };
        this.onWelcome = () => { clearTimeout(timer); this.onJoinAbort = undefined; ready = true; resolve(); };
        const ws = this.ws = new WebSocket(`ws://127.0.0.1:${this.relay.port}/r/${match[1]}?role=guest`, { maxPayload: 8*1024*1024, perMessageDeflate: false });
        ws.on('open', () => { if (this.ws === ws && !this.closed) this.send({t:'hello',proto:3,name:this.name,writeToken:secret.subarray(32).toString('base64url')}); });
        const lost = () => {
          if (this.ws !== ws || this.closed) return;
          clearTimeout(timer);
          if (!ready) reject(Error('Native Collab connection failed'));
          else this.reconnect();
        };
        ws.on('message', (data,binary) => {
          if (this.ws !== ws || this.closed) return;
          if (!binary) {
            try { if (JSON.parse(data.toString()).t === 'room-closed') { lost(); return; } } catch { this.fail('Invalid native Collab stream'); reject(Error('Invalid native Collab stream')); return; }
            this.fail('Invalid native Collab stream'); reject(Error('Invalid native Collab stream')); return;
          }
          try { this.frame(openOmpFrame(this.key,Buffer.from(data))); }
          catch { clearTimeout(timer); reject(Error('Invalid native Collab stream')); this.fail('Invalid native Collab stream'); }
        });
        ws.on('error', lost); ws.on('close', lost);
      });
      if (this.closed) throw Error('Native Collab closed');
      if (this.session.sessionId !== meta.host.sessionId) throw Error('Native session identity changed');
      if (typeof meta.sessionFile !== 'string' || meta.sessionFile && (!meta.sessionFile.startsWith(plan.sessionDir+'/') || meta.sessionFile.split('/').includes('..'))) throw Error('Invalid native session file');
      this.session.sessionFile = meta.sessionFile;
      this.tmux = meta.tmux;
  }
  reconnect() {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    for(const settle of this.steerWaiters.values())settle('indeterminate');
    clearTimeout(this.pumpTimer);
    const old = this.ws; this.ws = undefined; old?.terminate();
    this.emit('reconnecting'); this.emit('nativeState', { busy: true, reconnecting: true });
    void this.recoverLink().then(() => {
      if (this.closed) return;
      this.reconnecting = false;
      if(this.resyncUi?.size)void this.checkState();
      this.emit('nativeState', { streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0 || this.localUi.size>0 || this.localUnknown,busy:!this.idle() }); this.finish(); this.pump();
    }, () => this.fail('Native shared reconnection failed; no automatic replay'));
  }
  async recoverLink() {
    const deadline = Date.now() + (this.options.reconnectTimeoutMs ?? 120000);
    while (!this.closed && Date.now() < deadline) {
      try {
        const metadata = await this.refreshMetadata(Math.max(1, Math.min(90000, deadline-Date.now())));
        await this.join(metadata, Math.max(1, Math.min(30000, deadline-Date.now())));
        if (this.ws?.readyState !== WebSocket.OPEN) throw Error("Native Collab disconnected during recovery");
        return;
      } catch {
        if (this.closed || Date.now() >= deadline) throw Error('Native shared reconnection failed');
        const old = this.ws; this.ws = undefined; old?.terminate();
        await new Promise(resolve => { const timer = setTimeout(resolve, 1000); this.lifetime.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
    }
    throw Error('Native shared reconnection failed');
  }
  send(frame) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) throw Error('Native Collab unavailable');
    this.ws.send(sealOmpFrame(this.key,frame));
  }
  idle() { return this.state?.isStreaming === false && this.state.queuedMessageCount === 0 && !this.state.isAborting && this.ui.size === 0 && !this.resyncUi?.size && this.localUi.size===0 && !this.localUnknown; }
  canSteer() {
    return !this.closed && !this.reconnecting && !this.snapshot && this.state?.isStreaming === true;
  }
  async steer(id, text, images = []) {
    if (!this.canSteer()) return 'refused';
    if (!id || this.receipts.has(id) || typeof text !== 'string' || !text.trim() || text.length > 100000) throw Error('Invalid or duplicate native steer');
    this.receipts.set(id,{stage:'sent',text,steer:true});
    let settle;
    const result=new Promise(resolve=>{settle=resolve;});
    const timer=setTimeout(()=>settle('indeterminate'),this.options.steerTimeoutMs??1500);
    this.steerWaiters.set(id,settle);
    try {
      this.send({t:'prompt',text,...(images.length?{images}:{})});
      return await result;
    } catch { return 'indeterminate'; }
    finally {clearTimeout(timer);this.steerWaiters.delete(id);}
  }
  async submit(id, text, images = []) {
    if (!this.session || this.closed || this.turn) throw Error('Native shared session unavailable');
    if (!id || typeof text !== 'string' || !text.trim() || text.length > 100000) throw Error('Invalid native prompt');
    if (this.receipts.has(id)) throw Error('Native request already submitted');
    this.receipts.set(id,{stage:'queued'});
    return await new Promise((resolve,reject) => {
      this.turn = { id,text,images,resolve,reject,admitted:false,ended:false,texts:[],contended:false };
      this.pump();
    });
  }
  pump() {
    const turn=this.turn;
    if (this.reconnecting || !turn || turn.sent || !this.idle()) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer=setTimeout(() => { if (this.turn!==turn || !this.idle()) return; turn.sent=true; this.receipts.get(turn.id).stage='sent'; this.send({t:'prompt',text:turn.text,...(turn.images.length?{images:turn.images}:{})}); this.armTurnDeadline(); },Math.max(250,(turn.notBefore??0)-Date.now()));
  }
  requestStatus(id) { return this.receipts.get(id)?.stage; }
  pendingOperation(question) {
    const raw=question.message??question.title??'', tool=question.title?.split('\n')[0]?.match(/^Allow tool: (bash|write|edit)$/u)?.[1];
    const pending=new Map(), cwd=this.binding.cwd??'/';
    for(const entry of [...this.entries.values()].slice(-160)) {
      const message=entry.message;
      if(message?.role==='assistant'&&Array.isArray(message.content))for(const item of message.content)if(item.type==='toolCall'&&item.name===tool)pending.set(item.id,item);
      if(message?.role==='toolResult')pending.delete(message.toolCallId);
    }
    const wanted=[...raw.matchAll(/^(?:Path|File): ([^\n]+)$/gmu)].map(m=>posix.resolve(cwd,m[1])).sort();
    const command=raw.match(/(?:^|\n)Command: ([\s\S]+)$/u)?.[1];
    const matches=[...pending.values()].filter(item=>{
      if(tool==='bash')return item.arguments?.command===command;
      const paths=nativeToolPaths(item.arguments).map(p=>posix.resolve(cwd,p)).sort();
      return wanted.length&&JSON.stringify(paths)===JSON.stringify(wanted);
    });
    if(matches.length!==1||JSON.stringify(matches[0].arguments).length>48000)return undefined;
    return {id:matches[0].id,name:tool,arguments:matches[0].arguments};
  }
  async reviewFiles(question, signal) {
    const cwd=this.binding.cwd, selected=nativeToolPaths(this.pendingOperation(question)?.arguments);
    const paths=[...selected];
    for(const entry of [...this.entries.values()].slice(-160).reverse()) {
      const message=entry.message;
      if(message?.role==='assistant'&&Array.isArray(message.content))for(const item of message.content)if(item.type==='toolCall'&&['write','edit'].includes(item.name))paths.push(...nativeToolPaths(item.arguments));
    }
    const approved=[...new Set(paths.map(path=>reviewFilePath(cwd,path)).filter(Boolean))].slice(0,12);
    if(!approved.length)return [];
    if(this.options.readReviewFiles)return this.options.readReviewFiles(approved,signal);
    const plan=nativeOmpCommand(this.binding), args=plan.args.slice(0,-1);
    args.push(`exec python3 -c '${READ_REVIEW_FILES.replaceAll("'", "'\\''")}'`);
    return new Promise((resolve,reject)=>{
      const child=spawn(plan.command,args,{stdio:['pipe','pipe','pipe'],signal,env:Object.fromEntries(['HOME','PATH','SSH_AUTH_SOCK','TMPDIR'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[]))});
      let output='',oversized=false;child.stdout.on('data',part=>{output+=part;if(output.length>600000){oversized=true;child.kill();}});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      child.on('error',()=>reject(Error('Review source unavailable')));
      child.on('close',code=>{try{if(code!==0||oversized)throw Error();const files=JSON.parse(output);if(!Array.isArray(files)||files.length>12||files.some(file=>!approved.includes(file.path)||typeof file.content!=='string'||file.content.length>32000))throw Error();resolve(files);}catch{reject(Error('Review source unavailable'));}});
      child.stdin.end(JSON.stringify({cwd,paths:approved}));
    });
  }
  recentFileWrites() {
    const writes=new Map(),complete=[];
    const samePath=(left,right)=>posix.resolve(this.binding.cwd??'/',left)===posix.resolve(this.binding.cwd??'/',right);
    for(const entry of [...this.entries.values()].slice(-160)) {
      const message=entry.message;
      if(message?.role==='assistant' && Array.isArray(message.content))for(const item of message.content) {
        const args=item.arguments;
        if(item.type==='toolCall' && ['write','edit'].includes(item.name) && typeof args?.path==='string') {
          for(let i=complete.length-1;i>=0;i--)if(samePath(complete[i].path,args.path))complete.splice(i,1);
          for(const [id,file] of writes)if(samePath(file.path,args.path))writes.delete(id);
          if(item.name==='write' && typeof args.content==='string' && args.content.length<=12000)writes.set(item.id,{path:args.path,content:args.content});
        }
      }
      if(message?.role==='toolResult' && writes.has(message.toolCallId)) {
        const file=writes.get(message.toolCallId);writes.delete(message.toolCallId);
        if(message.isError===false){
          if(typeof message.details?.resolvedPath==='string')file.path=message.details.resolvedPath;
          for(let i=complete.length-1;i>=0;i--)if(complete[i].path===file.path)complete.splice(i,1);complete.push(file);
        }
      }
    }
    return complete.slice(-8);
  }
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
      this.resyncUi = new Map([...(this.resyncUi ?? []), ...this.ui]); this.ui.clear();
    }
    if (frame.t==='snapshot-chunk') {
      if (!this.snapshot || !Array.isArray(frame.entries) || this.entries.size+frame.entries.length>100000) throw Error('Invalid native snapshot');
      this.snapshot.push(...frame.entries);
      if (frame.final) { for (const entry of this.snapshot) this.entry(entry,true); this.snapshot=null; this.emit('nativeState',{streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0 || this.localUi.size>0 || this.localUnknown,busy:!this.idle(), reconnecting:!!this.reconnecting}); this.onWelcome?.(); this.armTurnDeadline(); if (!this.reconnecting) this.finish(); }
    }
    if (frame.t==='entry') this.entry(frame.entry,false);
    if (frame.t==='state') {
      this.state=frame.state;
      if (this.resyncUi) { for (const id of this.resyncUi.keys()) this.emit('questionCancelled',id); this.resyncUi=undefined; }
      this.emit('nativeState',{streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0 || this.localUi.size>0 || this.localUnknown,busy:!this.idle()}); this.pump(); this.finish();
    }
    if (frame.t==='event') {
      const e=frame.event;
      if (e.type==='agent_start') { if(this.state)this.state.isStreaming=true; this.emit('nativeState',{busy:true,streaming:true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0}); }
      if (e.type==='agent_end') { if(this.turn?.admitted)this.turn.ended=true; }
      if (['tool_execution_start','tool_execution_end'].includes(e.type)) this.emit('nativeTool',e);
      this.finish();
    }
    if (frame.t==='ui-request') {
      const r=frame.request;
      if (!['select','editor'].includes(r.kind) || !Number.isInteger(r.reqId)) throw Error('Unsupported native question');
      const id=String(r.reqId), previous=this.resyncUi?.get(id) ?? this.ui.get(id);
      this.resyncUi?.delete(id);
      if (previous && JSON.stringify(previous)!==JSON.stringify(r)) this.emit('questionCancelled',id);
      const options=r.options?.map(o=>typeof o==='string'?o:o.label);
      this.ui.set(id,r);
      this.emit('nativeState',{busy:true,streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:true});
      this.armTurnDeadline();
      if (!previous || JSON.stringify(previous)!==JSON.stringify(r)) this.emit('question',{id,method:r.kind,title:r.title,options});
    }
    if(frame.t==='ui-request-end') {this.uiAnswers.get(String(frame.reqId))?.resolve();this.ui.delete(String(frame.reqId));this.resyncUi?.delete(String(frame.reqId));this.armTurnDeadline();this.emit('questionCancelled',String(frame.reqId));this.emit('nativeState',{streaming:this.state?.isStreaming===true,queued:this.state?.queuedMessageCount??0,waiting:this.ui.size>0 || this.localUi.size>0 || this.localUnknown,busy:!this.idle()});this.finish();this.pump();}
    // OhMyPi 18.12.5 guest.ts treats host errors as notices: they do not revoke a prompt already admitted into native history.
    if(frame.t==='error') {
      const turn=this.turn;
      // This exact native refusal precedes #handlePrompt in OhMyPi 18.12.5; unknown errors and admitted inputs are never replayed.
      const refusedBeforeAdmission=!turn?.admitted && /^prompting is unavailable until (?:the host finishes starting up|the session transition completes)$/u.test(frame.message??'');
      if(turn?.sent && refusedBeforeAdmission) {
        turn.startupWaitSince??=Date.now();turn.sent=false;clearTimeout(turn.timer);this.receipts.get(turn.id).stage='queued';
        if(Date.now()-turn.startupWaitSince>120000){turn.reject(Error('Native startup did not become ready; input was refused'));this.turn=null;}
        else{turn.notBefore=Date.now()+1000;this.emit('nativeNotice',{code:'host-startup-wait',admitted:false});this.pump();}
      } else this.emit('nativeNotice', { code: 'host-operation-error', admitted: !!turn?.admitted });
    }
    if(frame.t==='bye') this.reconnect();
  }
  entry(entry,snapshot) {
    if (!entry || typeof entry.id!=='string' || this.entries.has(entry.id)) return;
    this.entries.set(entry.id,entry);
    const msg=entry.message ?? (entry.type==='custom_message'?{role:'user',content:entry.content,details:entry.details,customType:entry.customType}:null);
    const text=textOf(msg);
    const own=entry.type==='custom_message' && entry.details?.from===this.name;
    const turn=this.turn;
    if (turn?.sent && own && text===turn.text) { turn.admitted=true; this.receipts.get(turn.id).stage='accepted'; }
    const role=entry.type==='custom_message' && entry.attribution==='agent' ? 'system' : msg?.role;
    if (turn?.sent && !own && role==='user') turn.contended=true;
    if (turn?.admitted && msg?.role==='assistant') {
      if (['error','aborted'].includes(msg.stopReason)) { this.fail('Native shared turn failed; do not replay'); return; }
      if(text)turn.texts.push(text);
      if(text && msg.stopReason==='stop')turn.finalText=text;
      if (snapshot && msg.stopReason === 'stop') turn.ended=true;
    }
    if(own)for(const [id,receipt] of this.receipts)if(receipt.steer && receipt.stage==='sent' && receipt.text===text){receipt.stage='accepted';this.steerWaiters.get(id)?.('steered');break;}
    this.emit('nativeEntry',{entryId:entry.id,role,text,snapshot,own,sessionId:this.session?.sessionId,activeOwn:!!turn?.admitted,stopReason:msg?.stopReason});
  }
  finish() {
    const turn=this.turn;
    if (this.reconnecting || !turn?.admitted || !turn.ended || !this.idle() || !turn.texts.length) return;
    clearTimeout(turn.timer); this.turn=null;
    this.receipts.get(turn.id).stage='completed';
    turn.resolve({requestId:turn.id,sessionId:this.session.sessionId,sessionFile:this.session.sessionFile,text:turn.finalText??turn.texts.join('\n\n'),sharedTurn:turn.contended});
  }
  answerUi(id,answer) {
    if(this.localUi.has(id))return this.answerLocalUi(id,answer);
    const r=this.ui.get(id); if(!r)throw Error('Native question already answered');
    const existing=this.uiAnswers.get(id);
    if(existing) {
      if(existing.answer!==JSON.stringify(answer))throw Error('Native answer already being delivered');
      return existing.promise;
    }
    if(answer.cancelled!==true && !(typeof answer.value==='string' && (r.kind!=='select'||r.options.some(o=>(typeof o==='string'?o:o.label)===answer.value))))throw Error('Invalid native answer');
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>reject(Error('Piから回答の受領確認が返りませんでした。接続を確認してください。')),this.options.answerTimeoutMs??8000);
    const pending={answer:JSON.stringify(answer),promise,resolve,reject};
    this.uiAnswers.set(id,pending);
    promise.finally(()=>{clearTimeout(timer);if(this.uiAnswers.get(id)===pending)this.uiAnswers.delete(id);}).catch(()=>{});
    try {this.send({t:'ui-response',reqId:r.reqId,...(answer.cancelled===true?{}:{value:answer.value})});}
    catch(error){reject(error);}
    return promise;
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
    if(this.closed)return;this.closed=true;clearInterval(this.stateTimer);for(const settle of this.steerWaiters.values())settle('indeterminate');for(const pending of this.uiAnswers.values())pending.reject(Error('Piへの回答中に接続が切れました。'));this.lifetime.abort();this.onJoinAbort?.();clearTimeout(this.pumpTimer);
    if(this.turn){clearTimeout(this.turn.timer);this.turn.reject(Error('Native connection detached; do not replay'));this.turn=null;}
    this.ws?.close();
    if(!this.options.host){this.child?.stdin.end();this.child?.kill('SIGTERM');void this.relay?.close();}
  }
}
