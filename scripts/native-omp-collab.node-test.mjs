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
