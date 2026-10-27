import { spawn } from 'node:child_process';
import { nativeOmpCommand } from './native-omp-transport.mjs';

/** OhMyPi 18.12.5 can move a pending Collab approval to its local TUI when the last guest leaves. */
export const OMP_TUI_PROGRAM = String.raw`
import sys,json,os,stat,pathlib,re,subprocess,hashlib,time,fcntl

def pending(entries):
 result={}
 for e in entries:
  m=e.get('message',{})
  if m.get('role')=='assistant':
   for c in m.get('content',[]):
    if isinstance(c,dict) and c.get('type')=='toolCall' and c.get('id'):result[c['id']]=c
  elif m.get('role')=='toolResult':result.pop(m.get('toolCallId'),None)
 return list(result.values())
def extract(screen,entries):
 lines=screen.splitlines();starts=[i for i,l in enumerate(lines) if re.match(r'^\s*╭─ Allow tool: (bash|write|edit) ',l)]
 if len(starts)!=1:return None
 start=starts[0];tool=re.search(r'Allow tool: (bash|write|edit) ',lines[start])[1];box=[]
 for l in lines[start+1:]:
  if l.lstrip().startswith('╰'):break
  if l.lstrip().startswith('├'):continue
  if not re.match(r'^\s*│.*│\s*$',l):return None
  box.append(l.strip()[1:-1].strip())
 else:return None
 options=[];selected=None;body=[]
 for l in box:
  label=l.removeprefix('❯').strip()
  if label in ['Approve','Approve '+tool+' for this session','Deny']:
   if l.startswith('❯'):selected=len(options)
   options.append(label)
  elif not options:body.append(l)
 if options not in [['Approve','Deny'],['Approve','Approve '+tool+' for this session','Deny']] or selected is None:return None
 compact=lambda s:re.sub(r'\s+','',s)
 previous=[i for i,l in enumerate(lines[:start]) if l.lstrip().startswith('╭')]
 if previous:
  detail=[]
  for l in lines[previous[-1]+1:start]:
   if l.lstrip().startswith('╰'):break
   if re.match(r'^\s*│.*│\s*$',l):detail.append(l.strip()[1:-1].strip())
  if any(marker in ''.join(detail) for marker in ['Command:','Path:','File:']):body=detail+body
 display=compact(''.join(body));matches=[]
 for c in pending(entries):
  if c.get('name')!=tool:continue
  args=c.get('arguments',{});detail=None
  if tool=='bash' and isinstance(args.get('command'),str):
   rendered=display.split('Command:',1)[1] if 'Command:' in display else ''
   expected=compact(args['command'])
   exact=bool(rendered) and expected in rendered
   clipped=rendered.endswith('…') and len(rendered[:-1])>=24 and expected.startswith(rendered[:-1])
   if exact or clipped:detail='Command: '+args['command']
  elif isinstance(args.get('path'),str):
   if compact(args['path']) in display:detail='Path: '+args['path']
  elif tool=='edit' and isinstance(args.get('input'),str):
   paths=[a or b for a,b in re.findall(r'^\[([^\]\n]+)#[A-Fa-f0-9]+\]$|^\*\*\* (?:Update|Add|Delete) File: ([^\n]+)$',args['input'],re.M)]
   if paths and all(compact(p) in display for p in paths):detail='\n'.join('File: '+p for p in paths)
  if detail:matches.append((c,detail))
 if len(matches)!=1:return None
 c,detail=matches[0];fingerprint=hashlib.sha256(json.dumps([tool,display,options,selected,c['id']],ensure_ascii=False).encode()).hexdigest()
 return {'id':'tui-'+fingerprint,'fingerprint':fingerprint,'operationId':c['id'],'method':'select','title':'Allow tool: '+tool+'\n'+detail,'options':['Approve','Deny'],'rows':options,'selected':selected}

def main():
 b=json.load(sys.stdin);pid=b['pid'];name=b['tmux'];file=b['sessionFile'];sid=b['sessionId']
 if not isinstance(pid,int) or pid<=1 or not re.fullmatch(r'omb-[\w-]{1,100}',name):raise RuntimeError('invalid native terminal')
 def run(args):
  r=subprocess.run(args,capture_output=True,text=True,timeout=10)
  if r.returncode:raise RuntimeError('native terminal unavailable')
  return r.stdout
 def identity():
  if run(['tmux','display-message','-p','-t',name,'#{pane_pid}']).strip()!=str(pid):raise RuntimeError('native writer changed')
  if run(['tmux','list-clients','-t',name,'-F','#{client_name}']).strip():raise RuntimeError('human terminal attached')
  args=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().decode().split('\0')
  if args[0]!=b['binary'] or '--profile' not in args or args[args.index('--profile')+1]!=b['profile'] or '--session-dir' not in args or args[args.index('--session-dir')+1]!=b['sessionDir']:raise RuntimeError('native writer changed')
  p=pathlib.Path(file)
  if p.is_symlink() or str(p.resolve())!=str(p) or p.parent!=pathlib.Path(b['sessionDir']):raise RuntimeError('invalid native history')
 visible=[False]
 def capture():
  identity();screen=run(['tmux','capture-pane','-p','-t',name])
  visible[0]=bool(re.search(r'Allow tool: (bash|write|edit)',screen))
  if not visible[0]:return None
  info=os.stat(file,follow_symlinks=False)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_size>64000000:raise RuntimeError('invalid native history')
  entries=[];header=None
  with open(file) as f:
   for i,line in enumerate(f):
    if i>100000:raise RuntimeError('native history too large')
    if len(line)>2000000:continue
    try:e=json.loads(line)
    except ValueError:continue
    if e.get('type')=='session':header=e.get('id')
    entries.append(e)
  if header!=sid:raise RuntimeError('native session changed')
  return extract(screen,entries)
 def registry():
  hosts=json.loads(run([b['binary'],'--profile',b['profile'],'collab','list','--json'])).get('hosts',[])
  if not any(h.get('pid')==pid and h.get('sessionId')==sid for h in hosts):raise RuntimeError('native session changed')
 identity();registry()
 lockfile=pathlib.Path(b['sessionDir'])/('.omb-tui-'+str(pid)+'.lock')
 fd=os.open(lockfile,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX);q=capture()
  if b['action']=='probe':print(json.dumps({'question':q,'approvalVisible':visible[0]}));return
  if b['action']!='answer' or b.get('value') not in ['Approve','Deny'] or not q or q['fingerprint']!=b.get('fingerprint') or q['operationId']!=b.get('operationId'):raise RuntimeError('native approval changed; no answer sent')
  identity();registry();again=capture()
  if not again or again['fingerprint']!=q['fingerprint']:raise RuntimeError('native approval changed; no answer sent')
  delta=q['rows'].index(b['value'])-q['selected'];keys=(['Down']*delta if delta>=0 else ['Up']*(-delta))+['Enter']
  import shlex
  condition='#{&&:#{==:#{pane_pid},'+str(pid)+'},#{==:#{session_attached},0}}'
  run(['tmux','if-shell','-F','-t',name,condition,shlex.join(['send-keys','-t',name]+keys)])
  deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   identity();current=capture()
   if current and current['operationId']!=q['operationId']:
    print(json.dumps({'received':True}));return
   if not current and not re.search(r'Allow tool: (bash|write|edit)',run(['tmux','capture-pane','-p','-t',name])):
    print(json.dumps({'received':True}));return
   time.sleep(.1)
  raise RuntimeError('native answer receipt unconfirmed; do not resend')
if __name__=='__main__':main()
`;

export async function nativeOmpTui(binding, metadata, action='probe', answer={}, options={}) {
  const plan=nativeOmpCommand(binding),host=metadata?.host;
  if(!host?.pid || host.sessionId!==binding.expectedSessionId || !metadata.tmux || !metadata.sessionFile)throw Error('Pinned native terminal required');
  const args=plan.args.slice(0,-1);
  args.push(`exec python3 -c '${OMP_TUI_PROGRAM.replaceAll("'","'\\''")}'`);
  const input={...answer,action,pid:host.pid,tmux:metadata.tmux,sessionFile:metadata.sessionFile,sessionId:host.sessionId,binary:binding.binary,profile:binding.profile??'omb-native',sessionDir:plan.sessionDir};
  return await new Promise((resolve,reject)=>{
    const child=spawn(plan.command,args,{stdio:['pipe','pipe','pipe'],env:Object.fromEntries(['HOME','PATH','SSH_AUTH_SOCK','TMPDIR'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[])),signal:options.signal});
    let output='';const timer=setTimeout(()=>{child.kill();reject(Error('Native terminal check timed out'));},20000);
    child.stdout.on('data',part=>{output+=part;if(output.length>64000){child.kill();reject(Error('Native terminal response too large'));}});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(Error('Native terminal unavailable'));});
    child.on('close',code=>{clearTimeout(timer);try{if(code)throw Error();resolve(JSON.parse(output));}catch{reject(Error('Native terminal changed or answer receipt unconfirmed'));}});
    child.stdin.end(JSON.stringify(input));
  });
}
