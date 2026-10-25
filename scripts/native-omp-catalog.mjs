import { spawn } from 'node:child_process';
import { nativeOmpCommand } from './native-omp-transport.mjs';

const PROGRAM = String.raw`
import os,sys,json,pathlib,subprocess,hashlib,fcntl,select,time,signal,re,urllib.parse
b=json.loads(sys.stdin.readline()); root=pathlib.Path(b['stateRoot'])
roots=[root,root.parent/'project-threads',pathlib.Path.home()/'.omp'/'profiles'/b['profile']/'agent'/'sessions',pathlib.Path.home()/'.omp'/'profiles'/b['profile']/'sessions']
def allowed(p):
 p=pathlib.Path(p)
 return not p.is_symlink() and str(p.resolve())==str(p.absolute()) and any(p==r or r in p.parents for r in roots)
def descriptor(f):
 header=None;name=None
 with f.open() as stream:
  for i,line in enumerate(stream):
   if i>=32 or len(line)>1048576:break
   try:e=json.loads(line)
   except ValueError:continue
   if e.get('type')=='session':header=e
   if e.get('type')=='title':name=e.get('title')
 if not header or not isinstance(header.get('id'),str):return None
 return {'id':header['id'],'name':name or header.get('title') or header['id'],'directory':str(f.parent),'file':str(f),'cwd':header.get('cwd',b['cwd']),'running':False,'shared':False}
def files():
 result={}; count=0
 for r in roots:
  if not r.is_dir() or not allowed(r):continue
  for d,dirs,names in os.walk(r,followlinks=False):
   dirs[:]=sorted(n for n in dirs if not n.startswith('.') and allowed(pathlib.Path(d)/n)) if len(pathlib.Path(d).relative_to(r).parts)<5 else []
   for name in sorted(names):
    count+=1
    if count>10000:raise RuntimeError('SESSION_CATALOG_LIMIT')
    f=pathlib.Path(d)/name
    if not name.endswith('.jsonl') or not allowed(f) or not f.is_file():continue
    item=descriptor(f)
    if item:
     if item['id'] in result and result[item['id']]['file']!=item['file']:raise RuntimeError('DUPLICATE_NATIVE_SESSION')
     result[item['id']]=item
     if len(result)>500:raise RuntimeError('SESSION_CATALOG_LIMIT')
 return result
def list_sessions():
 result=files()
 p=subprocess.run([b['binary'],'--profile',b['profile'],'collab','list','--json'],capture_output=True,text=True,timeout=30)
 if p.returncode:raise RuntimeError('NATIVE_REGISTRY_UNAVAILABLE')
 hosts=json.loads(p.stdout).get('hosts',[])
 bypid={str(h.get('pid')):h for h in hosts}
 for h in hosts:
  pid=str(h.get('pid',''))
  if not pid.isdigit():continue
  try:
   args=pathlib.Path('/proc/'+pid+'/cmdline').read_bytes().decode().split('\0')
   if args[0]!=b['binary'] or '--profile' not in args or args[args.index('--profile')+1]!=b['profile']:continue
   directory=pathlib.Path(args[args.index('--session-dir')+1])
   if not allowed(directory):continue
  except (OSError,UnicodeError,ValueError,IndexError):continue
  sid=h.get('sessionId'); item=result.get(sid,{'id':sid,'name':h.get('sessionName') or sid,'directory':str(directory),'running':True,'shared':True})
  if item['directory']!=str(directory):raise RuntimeError('NATIVE_DIRECTORY_MISMATCH')
  item.update({'running':True,'shared':True,'cwd':h.get('cwd',b['cwd'])})
  if isinstance(h.get('busy'),bool):item['busy']=h['busy']
  result[sid]=item
 for proc in pathlib.Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  try:
   args=(proc/'cmdline').read_bytes().decode().split('\0')
   if not args or args[0]!=b['binary'] or '--profile' not in args or args[args.index('--profile')+1]!=b['profile'] or '--session-dir' not in args:continue
   directory=args[args.index('--session-dir')+1]
   h=bypid.get(proc.name);resume=args[args.index('--resume')+1] if '--resume' in args else None
   candidates=[item for item in result.values() if item['directory']==directory]
   for item in candidates:
    if h and item['id']==h.get('sessionId') or not h and (resume==item.get('file') or not resume and len(candidates)==1):item['running']=True
  except (OSError,UnicodeError,ValueError,IndexError):pass
 return list(result.values())
def inspect():
 directory=b.get('sessionDir')
 if not directory:
  key=hashlib.sha256(json.dumps([b['botId'],b['threadId']],separators=(',',':')).encode()).hexdigest();directory=str(root/key)
 expected=b.get('expectedSessionId'); file=b.get('sessionFile')
 p=subprocess.run([b['binary'],'--profile',b['profile'],'collab','list','--json'],capture_output=True,text=True,timeout=30)
 if p.returncode:raise RuntimeError('NATIVE_REGISTRY_UNAVAILABLE')
 hosts=json.loads(p.stdout).get('hosts',[]); bypid={str(h.get('pid')):h for h in hosts};candidates=[]
 for proc in pathlib.Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  try:
   args=(proc/'cmdline').read_bytes().decode().split('\0')
   if not args or args[0]!=b['binary'] or '--profile' not in args or args[args.index('--profile')+1]!=b['profile'] or '--session-dir' not in args or args[args.index('--session-dir')+1]!=directory:continue
   h=bypid.get(proc.name)
   if expected and h and h.get('sessionId')!=expected:continue
   resume=args[args.index('--resume')+1] if '--resume' in args else None
   if not h and file and resume and pathlib.Path(resume)!=pathlib.Path(file):continue
   if expected and not h and resume and expected not in pathlib.Path(resume).name:continue
   if expected and not h and not resume:
    saved=[descriptor(f) for f in pathlib.Path(directory).glob('*.jsonl') if allowed(f)]
    saved=[s for s in saved if s]
    if len(saved)!=1:raise RuntimeError('AMBIGUOUS_NATIVE_WRITER')
    if saved[0].get('id')!=expected:continue
   candidates.append((h,args,proc.name))
  except (OSError,UnicodeError,ValueError,IndexError):pass
 if len(candidates)>1:raise RuntimeError('AMBIGUOUS_NATIVE_WRITER')
 result={}
 if candidates:
  h,args,pid=candidates[0]
  panes=subprocess.run(['tmux','list-panes','-a','-F','#{session_name}\t#{pane_pid}'],capture_output=True,text=True,timeout=20)
  names=[line.split('\t')[0] for line in panes.stdout.splitlines() if line.split('\t')[-1]==pid]
  if len(names)==1 and re.fullmatch(r'[A-Za-z0-9_-]{1,100}',names[0]):result['tmux']=names[0]
  if h:
   link=subprocess.run([b['binary'],'--profile',b['profile'],'collab','link',h['instanceId'],'--json'],capture_output=True,text=True,timeout=20)
   if link.returncode==0:
    payload=json.loads(link.stdout);url=urllib.parse.urlsplit(payload.get('url',''))
    if url.scheme not in ['ws','http'] or url.hostname not in ['127.0.0.1','localhost']:raise RuntimeError('NATIVE_NON_PRIVATE_RELAY')
    if not url.port or not 1024<=url.port<=65535:raise RuntimeError('INVALID_NATIVE_RELAY_PORT')
    result['remotePort']=url.port
  if 'remotePort' not in result:
   for i,arg in enumerate(args[:-1]):
    if arg=='--config':
     cfg=pathlib.Path(args[i+1])
     if cfg.parent==pathlib.Path(directory) and cfg.name.startswith('.nativeconect') and allowed(cfg) and cfg.is_file():
      match=re.search(r'^  relayUrl: ws://127\.0\.0\.1:([0-9]+)$',cfg.read_text(),re.M)
      if match and 1024<=int(match[1])<=65535:result['remotePort']=int(match[1])
 return result
def create():
 operation=b['botId']+':'+b['operationId']; directory=root/'projects'/hashlib.sha256(operation.encode()).hexdigest()
 directory.mkdir(mode=0o700,parents=True,exist_ok=True)
 if not allowed(directory):raise RuntimeError('INVALID_SESSION_DIRECTORY')
 lock_fd=os.open(directory/'.omb-create.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 with os.fdopen(lock_fd,'a') as lock:
  os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  receipt=directory/'.omb-create-request.json'; request={'botId':b['botId'],'operationId':b['operationId'],'name':b['name']}
  if receipt.exists():
   if receipt.is_symlink() or json.loads(receipt.read_text())!=request:raise RuntimeError('SESSION_REQUEST_CONFLICT')
  else:
   fd=os.open(receipt,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
   with os.fdopen(fd,'w') as out:json.dump(request,out)
  existing=[descriptor(p) for p in directory.glob('*.jsonl') if allowed(p)]
  existing=[p for p in existing if p]
  if len(existing)>1:raise RuntimeError('AMBIGUOUS_CREATED_SESSION')
  if existing:return existing[0]
  args=[b['binary'],'--profile',b['profile'],'--mode','rpc-ui','--cwd',b['cwd'],'--model',b['model'],'--session-dir',str(directory),'--no-lsp','--no-pty','--no-extensions','--no-skills','--no-rules','--no-title','--tools','read,bash,edit,write,grep,glob,ask','--approval-mode','always-ask']
  child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0,start_new_session=True)
  deadline=time.monotonic()+110
  buffer=bytearray()
  def read_until(accept):
   while time.monotonic()<deadline:
    while b'\n' not in buffer:
     if not select.select([child.stdout],[],[],max(0,deadline-time.monotonic()))[0]:raise RuntimeError('NATIVE_CREATE_TIMEOUT')
     chunk=os.read(child.stdout.fileno(),65536)
     if not chunk:raise RuntimeError('NATIVE_CREATE_CLOSED')
     buffer.extend(chunk)
     if len(buffer)>1048576:raise RuntimeError('NATIVE_FRAME_TOO_LARGE')
    end=buffer.index(b'\n');line=bytes(buffer[:end]);del buffer[:end+1]
    e=json.loads(line)
    if e.get('type')=='extension_ui_request' and e.get('method') in ['confirm','select','input','editor']:raise RuntimeError('NATIVE_STARTUP_REQUIRES_HUMAN')
    if accept(e):return e
   raise RuntimeError('NATIVE_CREATE_TIMEOUT')
  def command(kind,**data):
   child.stdin.write((json.dumps(dict(data,id='omb-'+kind,type=kind))+'\n').encode());child.stdin.flush()
   r=read_until(lambda e:e.get('type')=='response' and e.get('id')=='omb-'+kind)
   if r.get('success') is not True:raise RuntimeError('NATIVE_CREATE_REFUSED')
   return r.get('data',{})
  def interrupted(*_):raise InterruptedError()
  signal.signal(signal.SIGHUP,interrupted);signal.signal(signal.SIGTERM,interrupted)
  try:
   ready=read_until(lambda e:e.get('type')=='ready')
   if 2 not in ready.get('supportedProtocolVersions',[]):raise RuntimeError('NATIVE_PROTOCOL_MISMATCH')
   command('negotiate_protocol',protocolVersion=2)
   command('open_session',sessionDir=str(directory))
   command('new_session')
   command('set_session_name',name=b['name'])
   state=command('get_state'); f=pathlib.Path(state['sessionFile'])
   if f.parent!=directory or not allowed(f):raise RuntimeError('NATIVE_CREATE_IDENTITY_MISMATCH')
   result=descriptor(f)
   if not result or result['id']!=state['sessionId']:raise RuntimeError('NATIVE_CREATE_NOT_PERSISTED')
   return result
  finally:
   child.stdin.close()
   try:child.wait(timeout=8)
   except subprocess.TimeoutExpired:
    os.killpg(child.pid,signal.SIGTERM)
    try:child.wait(timeout=5)
    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
try:print(json.dumps({'sessions':list_sessions()} if b['action']=='list' else {'plan':inspect()} if b['action']=='inspect' else {'session':create()}),flush=True)
except Exception as e:print(json.dumps({'error':str(e) if isinstance(e,RuntimeError) else type(e).__name__}),flush=True);sys.exit(1)
`;

export async function nativeOmpCatalog(binding, action = 'list', input = {}, options = {}) {
  if (!['list','create','inspect'].includes(action)) throw Error('Invalid session operation');
  if (action === 'create' && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || /[\p{Cc}]/u.test(input.name) || !/^[\w-]{1,160}$/u.test(input.operationId ?? ''))) throw Error('Invalid new session name or receipt');
  const plan = nativeOmpCommand({...binding, threadId: binding.threadId ?? 'session-catalog'});
  const env=Object.fromEntries(['HOME','PATH','SSH_AUTH_SOCK','TMPDIR'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[]));
  return await new Promise((resolve,reject)=>{
    const child=spawn(plan.command,[...plan.args.slice(0,-1),`exec python3 -c '${PROGRAM.replaceAll("'", "'\\''")}'`],{env,stdio:['pipe','pipe','pipe'],shell:false});
    let output='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error){child.kill('SIGTERM');reject(error);}else resolve(value);};
    const abort=()=>finish(Error('Session operation interrupted; check the existing receipt before retrying'));
    const timer=setTimeout(()=>finish(Error('Native session operation timed out; do not create another automatically')),130000);
    options.signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1048576)finish(Error('Native session catalog exceeds limit'));});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.once('error',()=>finish(Error('Native session SSH unavailable')));
    child.once('close',code=>{try{const result=JSON.parse(output);if(code!==0||result.error)throw Error('Native session operation failed: '+String(result.error??'SSH_CLOSED').slice(0,100));finish(undefined,result);}catch(error){finish(error instanceof Error?error:Error('Invalid native catalog'));}});
    if(options.signal?.aborted)abort();
    else child.stdin.end(JSON.stringify({...binding,...input,action})+'\n');
  });
}

export class NativeOmpCatalog {
  run(binding, action, input, options) { return nativeOmpCatalog(binding, action, input, options); }
}
