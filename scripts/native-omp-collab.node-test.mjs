import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { NativeOmpCollab, sealOmpFrame, openOmpFrame } from './native-omp-collab.mjs';
import { startOmpRelay } from './native-omp-collab-relay.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
function peer() {
  const client=new NativeOmpCollab({});
  client.name='OMB-synthetic'; client.session={sessionId:'synthetic-session',sessionFile:'/fixture/native',resumed:true,cancelled:false};
  client.state={isStreaming:false,queuedMessageCount:0};
  const sent=[];client.send=frame=>sent.push(frame);
  return {client,sent};
}
const own=(id,text)=>({t:'entry',entry:{type:'custom_message',id,customType:'collab-user',details:{from:'OMB-synthetic'},content:text}});
const human=(id,text)=>({t:'entry',entry:{type:'message',id,message:{role:'user',content:[{type:'text',text}]}}});
const answer=(id,text)=>({t:'entry',entry:{type:'message',id,message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}}});
function end(c) {c.frame({t:'event',event:{type:'agent_end'}});c.frame({t:'state',state:{isStreaming:false,queuedMessageCount:0}});}

test('standard Collab AES-GCM frames authenticate without exposing plaintext',()=>{
 const key=randomBytes(32), data=sealOmpFrame(key,{t:'prompt',text:'架空の入力'});
 assert.ok(!data.includes(Buffer.from('架空の入力')));assert.equal(openOmpFrame(key,data).text,'架空の入力');
 const tampered=Buffer.from(data);tampered[17]^=1;assert.throws(()=>openOmpFrame(key,tampered));
});
test('a host operation error cannot discard an admitted prompt or its later approvals and answer',async()=>{
 const {client:c,sent}=peer();const notices=[];c.on('nativeNotice',notice=>notices.push(notice));
 const result=c.submit('admitted-error','Original');await pause(300);c.frame(own('accepted','Original'));
 c.frame({t:'error',message:'synthetic unrelated host operation error'});
 assert.equal(c.closed,false);assert.equal(c.requestStatus('admitted-error'),'accepted');
 c.frame({t:'ui-request',request:{reqId:90,kind:'select',title:'Allow tool: bash',options:['Approve','Deny']}});
 c.answerUi('90',{value:'Deny'});c.frame({t:'ui-request-end',reqId:90});
 c.frame(answer('final-after-error','Native answer'));end(c);
 assert.equal((await result).text,'Native answer');assert.equal(sent.filter(f=>f.t==='prompt').length,1);
 assert.deepEqual(notices,[{code:'host-operation-error',admitted:true}]);c.close();
});
test('resynchronizing the same pending question does not ask the user again and retires missing questions',()=>{
 const {client:c}=peer(),questions=[],cancelled=[];
 c.on('question',q=>questions.push(q));c.on('questionCancelled',id=>cancelled.push(id));
 const request={reqId:91,kind:'select',title:'Allow tool: write',options:['Approve','Deny']};
 c.frame({t:'ui-request',request});
 c.frame({t:'ui-request',request:{...request,reqId:92}});
 c.frame({t:'welcome',proto:3,header:{id:'synthetic-session'},state:{isStreaming:true,queuedMessageCount:0}});
 c.frame({t:'snapshot-chunk',final:true,entries:[]});c.frame({t:'ui-request',request});
 c.frame({t:'state',state:{isStreaming:true,queuedMessageCount:0}});
 assert.equal(questions.length,2);assert.deepEqual(cancelled,['92']);assert.equal(c.ui.size,1);
 c.close();
});
test('BOT waits while the human native turn is active and preserves exact text',async()=>{
 const {client:c,sent}=peer();c.state.isStreaming=true;
 const result=c.submit('synthetic-A','変更しない原文');await pause(300);assert.equal(sent.length,0);
 c.frame({t:'state',state:{isStreaming:false,queuedMessageCount:0}});await pause(300);
 assert.deepEqual(sent,[{t:'prompt',text:'変更しない原文'}]);c.frame(own('own-A','変更しない原文'));c.frame(answer('a-A','通常の回答'));end(c);
 assert.equal((await result).text,'通常の回答');c.close();
});
test('a second simultaneous BOT input is refused rather than mixed into the first',async()=>{
 const {client:c}=peer();const result=c.submit('first','A');await assert.rejects(c.submit('second','B'));
 await pause(300);c.frame(own('one','A'));c.frame(answer('two','answer'));end(c);await result;c.close();
});
test('human input racing a submitted BOT prompt is flagged as a shared turn',async()=>{
 const {client:c}=peer();const result=c.submit('synthetic','BOT');await pause(300);
 c.frame(own('one','BOT'));c.frame(human('human','人間の追加入力'));c.frame(answer('answer','共有の回答'));end(c);
 assert.equal((await result).sharedTurn,true);c.close();
});
test('native agent background results are not human input and cannot replace the BOT review context',async()=>{
 const {client:c}=peer(),events=[];c.on('nativeEntry',e=>events.push(e));
 const result=c.submit('background','BOT');await pause(300);c.frame(own('own-background','BOT'));
 c.frame({t:'entry',entry:{type:'custom_message',id:'async-background',customType:'async-result',attribution:'agent',content:'Background job completed'}});
 c.frame(answer('after-background','Done'));end(c);
 assert.equal((await result).sharedTurn,false);assert.equal(events.find(e=>e.entryId==='async-background').role,'system');c.close();
});
test('test review evidence includes only successful native writes and invalidates later failed writes or edits',()=>{
 const {client:c}=peer();c.binding.cwd='/fixture/project';
 const call=(id,name,path,content)=>c.frame({t:'entry',entry:{id,type:'message',message:{role:'assistant',content:[{type:'toolCall',id,name,arguments:{path,content}}]}}});
 const done=(id,callId,isError=false)=>c.frame({t:'entry',entry:{id,type:'message',message:{role:'toolResult',toolCallId:callId,isError,details:{resolvedPath:'/fixture/project/tests/test_a.py'},content:[]}}});
 call('write-one','write','tests/test_a.py','Saved test');assert.deepEqual(c.recentFileWrites(),[]);done('result-one','write-one');
 assert.deepEqual(c.recentFileWrites(),[{path:'/fixture/project/tests/test_a.py',content:'Saved test'}]);
 call('edit-one','edit','tests/test_a.py','');assert.deepEqual(c.recentFileWrites(),[]);
 call('write-two','write','tests/test_a.py','New test');done('result-two','write-two');
 call('write-three','write','tests/test_a.py','Unknown state');done('result-three','write-three',true);assert.deepEqual(c.recentFileWrites(),[]);c.close();
});
test('unrelated assistant output cannot complete a BOT request without its native admission',async()=>{
 const {client:c}=peer();const result=c.submit('synthetic','BOT');let settled=false;void result.then(()=>{settled=true;},()=>{});
 await pause(300);c.frame(human('human','人間の依頼'));c.frame(answer('human-answer','人間への回答'));end(c);await pause(10);assert.equal(settled,false);
 c.frame(own('one','BOT'));c.frame(answer('answer','BOTへの回答'));end(c);assert.equal((await result).text,'BOTへの回答');c.close();
});
test('native approval resolution expires every other presentation; duplicate answer is refused',()=>{
 const {client:c,sent}=peer();const cancelled=[];c.on('questionCancelled',id=>cancelled.push(id));
 c.frame({t:'ui-request',request:{reqId:7,kind:'select',title:'Allow tool: write',options:['Approve','Deny']}});
 c.answerUi('7',{value:'Approve'});assert.deepEqual(sent,[{t:'ui-response',reqId:7,value:'Approve'}]);
 c.frame({t:'ui-request-end',reqId:7});assert.deepEqual(cancelled,['7']);assert.throws(()=>c.answerUi('7',{value:'Approve'}));c.close();
});
test('human native entries are observable and duplicate replication entries are ignored',()=>{
 const {client:c}=peer(),entries=[];c.on('nativeEntry',e=>entries.push(e));c.frame(human('one','Human'));c.frame(human('one','Human'));c.frame(answer('two','Reply'));
 assert.deepEqual(entries.map(e=>[e.role,e.text]),[['user','Human'],['assistant','Reply']]);c.close();
});
test('Stop cancels a waiting BOT input without aborting a human turn',async()=>{
 const {client:c,sent}=peer();c.state.isStreaming=true;const result=c.submit('synthetic','BOT');const rejected=assert.rejects(result,/cancelled/);
 assert.equal(await c.stop(),true);await rejected;assert.equal(sent.length,0);c.close();
});
test('Stop refuses shared-host abort when a concurrent human input joined the turn',async()=>{
 const {client:c,sent}=peer();const result=c.submit('synthetic','BOT');void result.catch(()=>{});await pause(300);c.frame(own('one','BOT'));c.frame(human('human','Human'));
 assert.equal(await c.stop(),false);assert.ok(!sent.some(f=>f.t==='abort'));c.close();
});
test('disconnect is indeterminate and never resubmits the original prompt',async()=>{
 const {client:c,sent}=peer();const result=c.submit('synthetic','BOT');const rejected=assert.rejects(result,/disconnected/);await pause(300);c.fail('disconnected');await rejected;
 assert.equal(sent.filter(f=>f.t==='prompt').length,1);await assert.rejects(c.submit('synthetic','BOT'));
});
test('private loopback relay preserves guest routing and rejects a duplicate host',async()=>{
 const relay=await startOmpRelay();const base=`ws://127.0.0.1:${relay.port}/r/syntheticRoom123`;
 const host=new WebSocket(base+'?role=host');await once(host,'open');
 const joined=once(host,'message');const guest=new WebSocket(base+'?role=guest');await once(guest,'open');const [hello]=await joined;const id=JSON.parse(hello).peer;assert.ok(id>0);
 const incoming=once(host,'message');guest.send(sealOmpFrame(randomBytes(32),{t:'hello'}));const [data]=await incoming;assert.equal(data.readUInt32BE(0),id);
 const duplicate=new WebSocket(base+'?role=host');const closed=once(duplicate,'close');assert.equal((await closed)[0],4009);
 const reply=once(guest,'message');host.send(sealOmpFrame(randomBytes(32),{t:'state'}));await reply;
 host.close();guest.close();await relay.close();
});

test('human approval wait does not consume the native execution deadline',async()=>{
 const {client:c}=peer();c.options.turnTimeoutMs=70;
 const result=c.submit('approval-wait','BOT');void result.catch(()=>{});
 await pause(265);c.frame(own('approval-own','BOT'));
 c.frame({t:'ui-request',request:{reqId:33,kind:'select',title:'Allow tool: bash',options:['Approve','Deny']}});
 await pause(110);assert.ok(c.turn);assert.equal(c.ui.size,1);
 c.answerUi('33',{value:'Deny'});c.frame({t:'ui-request-end',reqId:33});
 c.frame(answer('approval-reply','Denied safely'));end(c);
 assert.equal((await result).text,'Denied safely');c.close();
});
test('a prompt waiting for the human native turn is not called a failed remote execution',async()=>{
 const {client:c,sent}=peer();c.options.turnTimeoutMs=15;c.state.isStreaming=true;
 const result=c.submit('queued-wait','BOT');void result.catch(()=>{});
 await pause(55);assert.ok(c.turn);assert.equal(sent.length,0);
 const rejected=assert.rejects(result,/cancelled/);assert.equal(await c.stop(),true);await rejected;c.close();
});

test('a rotated native room resynchronizes an admitted turn without resending it',async()=>{
 const relay=await startOmpRelay();
 const keys=[randomBytes(32),randomBytes(32)], ids=['rotated-room-0001','rotated-room-0002'];
 const tokens=keys.map(key=>Buffer.concat([key,randomBytes(16)]));
 const hosts=[]; const prompts=[];let refreshes=0;
 const c=new NativeOmpCollab({threadId:'synthetic'});
 c.plan={sessionDir:'/fixture'};c.remotePort=relay.port;c.relay=relay;
 c.child={stdin:{write:()=>{refreshes++;},end:()=>{}},kill:()=>{}};
 const meta=index=>({host:{sessionId:'same-session'},link:`ws://127.0.0.1:${relay.port}/r/${ids[index]}.${tokens[index].toString('base64url')}`,tmux:'fixture',sessionFile:'/fixture/native.jsonl'});
 const nativeOwn={type:'custom_message',id:'admitted-entry',content:'Original prompt',details:{from:'OMB-synthetic'}};
 try{
  for(let i=0;i<2;i++){
   const host=new WebSocket(`ws://127.0.0.1:${relay.port}/r/${ids[i]}?role=host`);hosts.push(host);await once(host,'open');
   host.on('message',(data,binary)=>{
    if(!binary)return;
    const peer=Buffer.from(data).readUInt32BE(0),frame=openOmpFrame(keys[i],Buffer.from(data));
    const send=frame=>{const data=sealOmpFrame(keys[i],frame);data.writeUInt32BE(peer,0);host.send(data);};
    if(frame.t==='hello'){
     send({t:'welcome',proto:3,header:{id:'same-session'},state:{isStreaming:false,queuedMessageCount:0}});
     send({t:'snapshot-chunk',final:true,entries:i?[nativeOwn,{type:'message',id:'finished-entry',message:{role:'assistant',content:[{type:'text',text:'Native completed while disconnected'}],stopReason:'stop'}}]:[]});
    }
    if(frame.t==='prompt'){
     prompts.push(frame.text);send({t:'entry',entry:nativeOwn});
     setTimeout(()=>host.close(),20);
    }
   });
  }
  c.nextMetadata=async()=>meta(1);
  await c.join(meta(0));
  const result=await c.submit('once-only','Original prompt');
  assert.equal(result.text,'Native completed while disconnected');
  assert.equal(result.sessionId,'same-session');
  assert.deepEqual(prompts,['Original prompt']);assert.equal(refreshes,1);
 }finally{c.close();for(const host of hosts)host.terminate();await relay.close();}
});

test('reconnection snapshots preserve concurrent human input and do not resend',async()=>{
 const {client:c,sent}=peer();
 const pending=c.submit('snapshot-turn','BOT');await pause(280);
 c.frame(own('own-entry','BOT'));
 c.recoverLink=async()=>{
  c.frame({t:'welcome',proto:3,header:{id:'synthetic-session'},state:{isStreaming:false,queuedMessageCount:0}});
  c.frame({t:'snapshot-chunk',final:true,entries:[human('late-human','Human').entry,answer('late-answer','Shared completed answer').entry]});
 };
 c.reconnect();
 assert.equal((await pending).sharedTurn,true);
 assert.deepEqual(sent,[{t:'prompt',text:'BOT'}]);c.close();
});

test('an unknown replacement session is never imported as a recovered answer',async()=>{
 const {client:c,sent}=peer();c.binding.expectedSessionId='synthetic-session';
 const pending=c.submit('pinned-turn','BOT');const rejected=assert.rejects(pending,/reconnection failed/);await pause(280);
 c.recoverLink=async()=>c.frame({t:'welcome',proto:3,header:{id:'foreign-session'},state:{isStreaming:false,queuedMessageCount:0}});
 c.reconnect();await rejected;assert.equal(sent.length,1);assert.equal(c.closed,true);
});

test('a silent relay host is retired so the native host can reclaim its room',async()=>{
 const relay=await startOmpRelay({heartbeatMs:20});const base=`ws://127.0.0.1:${relay.port}/r/heartbeat-room-0001`;
 const host=new WebSocket(base+'?role=host',{autoPong:false});let replacement;
 try{
  await once(host,'open');await once(host,'close');
  replacement=new WebSocket(base+'?role=host');await once(replacement,'open');
  await pause(65);assert.equal(replacement.readyState,WebSocket.OPEN);
 }finally{host.terminate();replacement?.terminate();await relay.close();}
});

test('matches native hashed multi-file edits and never borrows another pending operation',async()=>{
 const {client:c}=peer();c.binding.cwd='/fixture/project';
 const args={input:'*** Begin Patch\n[requirements.txt#1234]\nPUT >1:\n+httpx==0.28.1\n[computers.toml#5678]\nREM\n*** End Patch'};
 c.frame({t:'entry',entry:{id:'pending-edit',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'edit-call',name:'edit',arguments:args}]}}});
 const q={title:'Allow tool: edit\nFile: requirements.txt\nFile: computers.toml'};
 assert.deepEqual(c.pendingOperation(q),{id:'edit-call',name:'edit',arguments:args});
 assert.equal(c.pendingOperation({title:'Allow tool: edit\nFile: unrelated.py'}),undefined);
 c.frame({t:'entry',entry:{id:'edit-done',type:'message',message:{role:'toolResult',toolCallId:'edit-call',isError:false,content:[]}}});
 assert.equal(c.pendingOperation(q),undefined);c.close();
});

test('refreshes source paths after hashed edits and excludes private paths and escapes',async()=>{
 const {client:c}=peer();c.binding.cwd='/fixture/project';
 const paths=[];c.options.readReviewFiles=async requested=>{paths.push(...requested);return requested.map(path=>({path,content:'fresh edited source'}));};
 c.frame({t:'entry',entry:{id:'edited',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'c',name:'edit',arguments:{input:'*** Begin Patch\n[tests/test_nas.py#ABCD]\nPUT >1:\n+pass\n[../outside.py#1234]\nREM\n[.env#1234]\nREM\n[.git/config#1234]\nREM\n*** End Patch'}}]}}});
 const result=await c.reviewFiles({title:'Allow tool: bash\nCommand: python3 -m unittest'},new AbortController().signal);
 assert.deepEqual(paths,['/fixture/project/tests/test_nas.py']);assert.equal(result[0].content,'fresh edited source');c.close();
});

test('remote review source reader refuses symlinks, private files, escapes, oversize files and FIFOs',async()=>{
 const {READ_REVIEW_FILES}=await import('./native-omp-collab.mjs');
 const {mkdtempSync,writeFileSync,symlinkSync,mkdirSync,rmSync,realpathSync}=await import('node:fs');
 const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'omb-review-source-'));
 try {
  mkdirSync(join(root,'project'));const cwd=realpathSync(join(root,'project'));
  writeFileSync(join(cwd,'test_good.py'),'assert True');writeFileSync(join(cwd,'.env'),'FICTIONAL_SECRET');writeFileSync(join(root,'outside.py'),'outside');
  symlinkSync(join(root,'outside.py'),join(cwd,'link.py'));writeFileSync(join(cwd,'huge.py'),'x'.repeat(32001));execFileSync('mkfifo',[join(cwd,'pipe.py')]);
  const paths=['test_good.py','.env','../outside.py','link.py','huge.py','pipe.py'].map(name=>join(cwd,name));
  const result=JSON.parse(execFileSync('python3',['-c',READ_REVIEW_FILES],{input:JSON.stringify({cwd,paths}),encoding:'utf8',timeout:3000}));
  assert.deepEqual(result,[{path:join(cwd,'test_good.py'),content:'assert True'}]);
 } finally{rmSync(root,{recursive:true,force:true});}
});

test('public native narration is observable but the final answer excludes intermediate narration and hidden thinking',async()=>{
 const {client:c}=peer();const entries=[];c.on('nativeEntry',e=>entries.push(e));
 const result=c.submit('progress-turn','Inspect and test');await pause(270);c.frame(own('progress-admitted','Inspect and test'));
 c.frame({t:'entry',entry:{id:'progress-comment',type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_REASONING_NOT_FOR_DISPLAY'},{type:'text',text:'接続を確認し、次にテストします。'}],stopReason:'toolUse'}}});
 assert.equal(entries.at(-1).text,'接続を確認し、次にテストします。');
 c.frame(answer('progress-final','検証完了です。'));end(c);
 assert.equal((await result).text,'検証完了です。');assert.ok(!JSON.stringify(entries).includes('PRIVATE_REASONING_NOT_FOR_DISPLAY'));c.close();
});

test('shared native prompt carries real image content instead of Mac path markers',async()=>{
 const {client:c,sent}=peer();const images=[{type:'image',mimeType:'image/png',data:'aW1hZ2U='}];
 const pending=c.submit('image-request','Describe this',images);await pause(300);
 assert.deepEqual(sent.find(f=>f.t==='prompt'),{t:'prompt',text:'Describe this',images});
 c.frame({t:'entry',entry:{type:'custom_message',id:'image-input',details:{from:'OMB-synthetic'},content:[{type:'text',text:'Describe this'},...images]}});
 c.frame(answer('image-answer','Image described'));end(c);assert.equal((await pending).text,'Image described');c.close();
});

for(const value of ['Approve','Deny'])test(`native ${value} waits for host receipt and repeated clicks send once`,async()=>{
 const {client:c,sent}=peer();
 c.frame({t:'ui-request',request:{reqId:201,kind:'select',title:'Allow tool: bash',options:['Approve','Deny']}});
 let settled=false;
 const result=c.answerUi('201',{value});result.then(()=>{settled=true;});
 assert.equal(c.answerUi('201',{value}),result);
 await pause(15);assert.equal(settled,false);assert.equal(c.ui.has('201'),true);
 assert.equal(sent.filter(f=>f.t==='ui-response').length,1);
 c.frame({t:'ui-request-end',reqId:201});await result;
 assert.equal(c.ui.has('201'),false);c.close();
});
test('a lost native answer receipt keeps the question open and reports failure',async()=>{
 const {client:c}=peer();c.options.answerTimeoutMs=25;
 c.frame({t:'ui-request',request:{reqId:202,kind:'select',title:'Allow tool: bash',options:['Approve','Deny']}});
 await assert.rejects(c.answerUi('202',{value:'Deny'}),/受領確認/);
 assert.equal(c.ui.has('202'),true);assert.equal(c.uiAnswers.size,0);c.close();
});
test('disconnect while delivering a native decision rejects instead of reporting success',async()=>{
 const {client:c}=peer();
 c.frame({t:'ui-request',request:{reqId:203,kind:'select',title:'Allow tool: bash',options:['Approve','Deny']}});
 const result=c.answerUi('203',{value:'Deny'});const rejected=assert.rejects(result,/接続が切れ/);
 c.close();await rejected;
});

test('standard shared prompt steers into a live turn and confirms native history admission once',async()=>{
 const {client:c,sent}=peer();c.state.isStreaming=true;
 const images=[{type:'image',data:'synthetic',mimeType:'image/png'}];
 const result=c.steer('injection','追加の指示',images);
 assert.deepEqual(sent,[{t:'prompt',text:'追加の指示',images}]);
 c.frame(own('injected-entry','追加の指示'));
 assert.equal(await result,'steered');assert.equal(c.requestStatus('injection'),'accepted');
 await assert.rejects(c.steer('injection','追加の指示',images),/duplicate/);c.close();
});
test('steer does not submit when idle, reconnecting or still loading a snapshot',async()=>{
 const {client:c,sent}=peer();assert.equal(await c.steer('idle','A'),'refused');
 c.state.isStreaming=true;c.reconnecting=true;assert.equal(await c.steer('lost','A'),'refused');
 c.reconnecting=false;c.snapshot=[];assert.equal(await c.steer('snapshot','A'),'refused');
 assert.equal(sent.length,0);c.close();
});
test('missing steer admission is indeterminate, late native admission reconciles it without resend',async()=>{
 const {client:c,sent}=peer();c.options.steerTimeoutMs=10;c.state.isStreaming=true;
 assert.equal(await c.steer('late','B'),'indeterminate');assert.equal(sent.length,1);
 c.frame(own('late-entry','B'));assert.equal(c.requestStatus('late'),'accepted');assert.equal(sent.length,1);c.close();
});
test('steering an owned running turn keeps its original completion and does not interrupt a human',async()=>{
 const {client:c}=peer();const result=c.submit('original','Original');await pause(280);
 c.frame(own('first','Original'));c.frame({t:'event',event:{type:'agent_start'}});
 const steer=c.steer('next','Additional');c.frame(own('next-entry','Additional'));assert.equal(await steer,'steered');
 c.frame(human('human-after','Human'));assert.equal(await c.stop(),false);
 c.frame(answer('final-steered','Both handled'));end(c);assert.equal((await result).text,'Both handled');c.close();
});
test('authoritative host check repairs a missed end state through a snapshot, never by inventing idle',async()=>{
 const {client:c}=peer();c.state.isStreaming=true;
 c.refreshMetadata=async()=>({host:{sessionId:'synthetic-session',busy:false,inputRequired:false}});
 let resync=0;c.reconnect=()=>{resync++;};await c.checkState();assert.equal(resync,1);assert.equal(c.state.isStreaming,true);c.close();
});
test('a fresh host check retires only absent resync questions and preserves actual pending approval',async()=>{
 const {client:c}=peer();c.resyncUi=new Map([['old',{}]]);const ended=[];c.on('questionCancelled',id=>ended.push(id));
 c.refreshMetadata=async()=>({host:{sessionId:'synthetic-session',busy:false,inputRequired:true}});
 await c.checkState();assert.equal(c.idle(),false);assert.equal(ended.length,0);
 c.refreshMetadata=async()=>({host:{sessionId:'synthetic-session',busy:false,inputRequired:false}});
 await c.checkState();assert.equal(c.idle(),true);assert.deepEqual(ended,['old']);c.close();
});

test('local TUI approval fallback is surfaced once and waits for a verified native receipt',async()=>{
 const {client:c}=peer();c.state.isStreaming=true;const questions=[],ended=[];c.on('question',q=>questions.push(q));c.on('questionCancelled',id=>ended.push(id));
 const q={id:'tui-fixture',fingerprint:'fixture',operationId:'tool-fixture',method:'select',title:'Allow tool: bash\nCommand: lsblk',options:['Approve','Deny']};
 let resolve;const calls=[];c.metadata={};c.options.localUi=async(_b,_m,action,args)=>{calls.push({action,args});return action==='probe'?{question:q}:new Promise(yes=>{resolve=yes;});};
 await c.checkLocalUi({});await c.checkLocalUi({});assert.equal(questions.length,1);assert.equal(c.localUi.size,1);
 const answer=c.answerUi(q.id,{value:'Deny'});assert.equal(c.localUi.size,1);assert.equal(c.answerUi(q.id,{value:'Deny'}),answer);
 resolve({received:true});await answer;assert.equal(c.localUi.size,0);assert.deepEqual(ended,[q.id]);assert.equal(calls.filter(x=>x.action==='answer').length,1);c.close();
});
test('unconfirmed local approval remains pending and a later host idle check retires it without retry',async()=>{
 const {client:c}=peer();c.state.isStreaming=true;
 const q={id:'tui-unknown',fingerprint:'fixture',operationId:'tool',method:'select',title:'Allow tool: bash\nCommand: lsblk',options:['Approve','Deny']};
 c.options.localUi=async(_b,_m,action)=>action==='probe'?{question:q}:{received:false};await c.checkLocalUi({});
 await assert.rejects(c.answerUi(q.id,{value:'Approve'}),/unconfirmed/);assert.equal(c.localUi.size,1);
 c.state.isStreaming=false;c.refreshMetadata=async()=>({host:{sessionId:'synthetic-session',busy:false,inputRequired:false}});await c.checkState();assert.equal(c.localUi.size,0);assert.equal(c.idle(),true);c.close();
});
test('unrecognized local approval remains visible as waiting without offering an unsafe answer',async()=>{
 const {client:c}=peer();c.state.isStreaming=true;const questions=[],states=[],notices=[];
 c.on('question',q=>questions.push(q));c.on('nativeState',s=>states.push(s));c.on('nativeNotice',n=>notices.push(n));
 c.options.localUi=async()=>({question:null,approvalVisible:true});await c.checkLocalUi({});
 assert.equal(questions.length,0);assert.equal(states.at(-1).waiting,true);assert.equal(notices[0].code,'local-approval-unrecognized');c.close();
});
