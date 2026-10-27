import test from 'node:test';import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';import{OMP_TUI_PROGRAM,nativeOmpTui}from'./native-omp-tui.mjs';
const screen=(tool='bash',detail='Command: lsblk',choice='Approve')=>['╭─ Allow tool: '+tool+' ───╮','│ '+detail+' │','│ '+(choice==='Approve'?'❯ ':'  ')+'Approve │','│ '+(choice==='session'?'❯ ':'  ')+'Approve '+tool+' for this session │','│ '+(choice==='Deny'?'❯ ':'  ')+'Deny │','╰────────────────────╯'].join('\n');
const entry=(id,name,args)=>({type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name,arguments:args}]}});
const parse=(s,entries)=>{const r=spawnSync('python3',['-c',`import json,sys\nb=json.load(sys.stdin);g={'__name__':'fixture'};exec(b['program'],g);print(json.dumps(g['extract'](b['screen'],b['entries'])))`],{input:JSON.stringify({program:OMP_TUI_PROGRAM,screen:s,entries}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
test('local native approval is pinned to one unresolved tool call, preserving full command and safe choices',()=>{
 const q=parse(screen(),[entry('native-call','bash',{command:'lsblk'})]);assert.equal(q.operationId,'native-call');assert.equal(q.title,'Allow tool: bash\nCommand: lsblk');assert.deepEqual(q.options,['Approve','Deny']);assert.equal(q.selected,0);
 assert.equal(parse(screen(),[entry('native-call','bash',{command:'different'})]),null);
 assert.equal(parse(screen(),[entry('native-call','bash',{command:'lsblk'}),entry('other','bash',{command:'lsblk'})]),null);
 assert.equal(parse(screen(),[entry('native-call','bash',{command:'lsblk'}),{message:{role:'toolResult',toolCallId:'native-call'}}]),null);
});
test('native question identity changes with the operation even if the terminal text is identical',()=>{
 const a=parse(screen(),[entry('A','bash',{command:'lsblk'})]),b=parse(screen(),[entry('B','bash',{command:'lsblk'})]);assert.notEqual(a.id,b.id);
 assert.equal(parse(screen('bash','Command: lsblk','Deny'),[entry('A','bash',{command:'lsblk'})]).selected,2);
});
test('wrapped native commands and file permissions match history; incomplete or ambiguous terminals are refused',()=>{
 assert.ok(parse(screen('bash','Command: python3 -m │\n│ unittest discover'),[entry('wrapped','bash',{command:'python3 -m unittest discover'})]));
 assert.equal(parse(screen('write','Path: tests/a.py'),[entry('write','write',{path:'tests/a.py',content:'fixture'})]).title,'Allow tool: write\nPath: tests/a.py');
 assert.equal(parse('Terminal without an approval',[entry('A','bash',{command:'lsblk'})]),null);
 assert.equal(parse(screen()+'\n'+screen(),[entry('A','bash',{command:'lsblk'})]),null);
 assert.equal(parse(screen().replace('❯',' '),[entry('A','bash',{command:'lsblk'})]),null);
});
test('missing native session pin cannot open SSH or send a terminal answer',async()=>{
 await assert.rejects(nativeOmpTui({host:'fixture.test',user:'fixture',binary:'/fixture/omp',botId:'fixture',threadId:'fixture',stateRoot:'/fixture'},null,'answer',{value:'Approve'}),/Pinned/);
});
test('native detail and selector boxes remain bound to the exact unresolved command',()=>{
 const command='python3 -m unittest discover -s tests';
 const separate=['╭─ Permission ───╮','│ Command: python3 -m unittest │','│ discover -s tests │','╰────────╯',screen('bash','')].join('\n');
 const q=parse(separate,[entry('old','bash',{command:'kill -KILL 999'}),entry('current','bash',{command})]);assert.equal(q.operationId,'current');
 assert.equal(parse(separate.replace('discover -s tests','discover…'),[entry('current','bash',{command})]).operationId,'current');
});
test('background status updates cannot churn the pending native approval identity',()=>{
 const entries=[entry('stable','bash',{command:'lsblk'})];
 assert.equal(parse(screen()+'\nNative elapsed 1s',entries).id,parse(screen()+'\nNative elapsed 30s',entries).id);
});
test('native clipped command preview is resolved only against a unique full pending command',()=>{
 const command='python3 -m unittest discover -s tests --verbose';
 const clipped=screen('bash','Command: python3 -m unittest discover…').replace('│   Deny │','│   Deny │\n├─────────────────┤\n│ ↑↓ Select · Enter confirm │');
 assert.equal(parse(clipped,[entry('full','bash',{command})]).title,'Allow tool: bash\nCommand: '+command);
 assert.equal(parse(clipped,[entry('full','bash',{command}),entry('ambiguous','bash',{command:command+' extra'})]),null);
 assert.equal(parse(screen('bash','Command: py…'),[entry('short','bash',{command})]),null);
});

function terminalMain(mode,value='Approve') {
 const program=String.raw`import json,sys,tempfile,pathlib,io,types,contextlib,shlex
from unittest.mock import patch
b=json.load(sys.stdin);g={'__name__':'fixture'};exec(b['program'],g)
with tempfile.TemporaryDirectory() as directory:
 directory=str(pathlib.Path(directory).resolve())
 f=pathlib.Path(directory)/'session.jsonl';entries=[{'type':'session','id':'native'},b['entry']];f.write_text('\n'.join(json.dumps(e) for e in entries)+'\n')
 screen=b['screen'];question=g['extract'](screen,entries);sent=[]
 request={'pid':12345,'tmux':'omb-fixture','sessionFile':str(f),'sessionId':'native','binary':'/fixture/omp','profile':'fixture','sessionDir':directory,'action':'answer','fingerprint':question['fingerprint'],'operationId':question['operationId'],'value':b['value']}
 if b['mode']=='stale':request['fingerprint']='changed'
 def run(args,**kw):
  text=''
  if args[0]=='/fixture/omp':text=json.dumps({'hosts':[{'pid':12345,'sessionId':'other' if b['mode']=='other-session' else 'native'}]})
  elif args[1]=='display-message':text='12345'
  elif args[1]=='list-clients':text='human' if b['mode']=='human' else ''
  elif args[1]=='capture-pane':text=screen if not sent or b['mode']=='no-receipt' else ''
  elif args[1]=='if-shell':sent.append(shlex.split(args[-1]));text=''
  return types.SimpleNamespace(returncode=0,stdout=text)
 old=pathlib.Path.read_bytes
 def read(p):
  if str(p)=='/proc/12345/cmdline':return ('/fixture/omp\0--profile\0fixture\0--session-dir\0'+directory+'\0').encode()
  return old(p)
 tick=[0]
 def now():tick[0]+=1;return tick[0]
 g['time']=types.SimpleNamespace(monotonic=now,sleep=lambda _:None)
 output=io.StringIO();error=None
 with patch('subprocess.run',run),patch.object(pathlib.Path,'read_bytes',read),patch('sys.stdin',io.StringIO(json.dumps(request))),contextlib.redirect_stdout(output):
  try:g['main']()
  except Exception as e:error=str(e)
 print(json.dumps({'sent':sent,'receipt':output.getvalue(),'error':error}))`;
 const r=spawnSync('python3',['-c',program],{input:JSON.stringify({program:OMP_TUI_PROGRAM,mode,value,screen:screen(),entry:entry('operation','bash',{command:'lsblk'})}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('terminal receipt follows only an exact pinned choice and never selects session-wide approval',()=>{
 const approve=terminalMain('ok');assert.equal(approve.error,null);assert.equal(JSON.parse(approve.receipt).received,true);assert.deepEqual(approve.sent[0].slice(3),['Enter']);
 const deny=terminalMain('ok','Deny');assert.equal(JSON.parse(deny.receipt).received,true);assert.deepEqual(deny.sent[0].slice(3),['Down','Down','Enter']);
 const wide=terminalMain('ok','Approve bash for this session');assert.equal(wide.sent.length,0);assert.ok(wide.error);
});
test('human attachment, replaced session and stale approval cannot send a terminal key',()=>{
 for(const mode of ['human','other-session','stale']){const r=terminalMain(mode);assert.equal(r.sent.length,0);assert.ok(r.error);}
});
test('sending keys without a native end receipt never reports permission success or retries',()=>{
 const r=terminalMain('no-receipt');assert.equal(r.sent.length,1);assert.equal(r.receipt,'');assert.match(r.error,/unconfirmed/);
});
