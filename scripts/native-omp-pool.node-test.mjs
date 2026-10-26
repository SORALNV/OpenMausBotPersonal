import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOmpPool } from './native-omp-pool.mjs';
import { NativeOmpCollab } from './native-omp-collab.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const binding={host:'fixture.test',user:'fixture',botId:'fixture',threadId:'one',binary:'/fixture/omp',stateRoot:'/fixture/threads',profile:'fixture',sessionDir:'/fixture/shared'};
function fixture(){
 const clients=[],sent=[];
 const pool=new NativeOmpPool((binding,options)=>{
  const c=new NativeOmpCollab(binding,options);c.name='OMB-'+binding.threadId;c.state={isStreaming:false,queuedMessageCount:0};
  c.session={sessionId:'same-native',sessionFile:'/fixture/shared/native.jsonl',resumed:true,cancelled:false};
  c.initialize=async()=>c.session;c.send=frame=>sent.push({threadId:binding.threadId,frame});clients.push(c);return c;
 });
 const one=pool.acquire(binding),two=pool.acquire({...binding,threadId:'two',expectedSessionId:'same-native'});
 const broadcast=frame=>clients.forEach(c=>c.frame(frame));
 const complete=(client,id,text,answer)=>{
  broadcast({t:'entry',entry:{type:'custom_message',id:'input-'+id,details:{from:client.name},content:text}});
  broadcast({t:'entry',entry:{type:'message',id:'answer-'+id,message:{role:'assistant',content:[{type:'text',text:answer}],stopReason:'stop'}}});
  broadcast({t:'event',event:{type:'agent_end'}});broadcast({t:'state',state:{isStreaming:false,queuedMessageCount:0}});
 };
 return {pool,clients,sent,one,two,complete,broadcast};
}
test('two OMB threads share one native owner and serialize inputs without duplicate prompts',async t=>{
 const f=fixture();t.after(()=>f.pool.close());
 const first=f.one.submit('request-one','A'),second=f.two.submit('request-two','B');
 await pause(300);assert.equal(f.clients.filter(c=>!c.options.host).length,1);
 assert.deepEqual(f.sent.filter(e=>e.frame.t==='prompt').map(e=>e.frame.text),['A']);
 assert.equal(f.two.requestStatus('request-two'),'queued');
 f.complete(f.one,'one','A','First');assert.equal((await first).text,'First');
 await pause(300);assert.deepEqual(f.sent.filter(e=>e.frame.t==='prompt').map(e=>e.frame.text),['A','B']);
 f.complete(f.two,'two','B','Second');assert.equal((await second).text,'Second');
 f.one.close();assert.equal(f.clients[0].closed,false);f.two.close();assert.equal(f.clients[0].closed,true);
});
test('stopping a queued view never interrupts the other OMB or human native turn',async t=>{
 const f=fixture();t.after(()=>f.pool.close());
 const first=f.one.submit('one','A'),second=f.two.submit('two','B');
 const refused=assert.rejects(second,/cancelled/);
 await pause(300);assert.equal(await f.two.stop(),true);await refused;
 assert.equal(f.sent.some(e=>e.frame.t==='abort'),false);assert.equal(f.two.requestStatus('two'),'queued');
 f.complete(f.one,'one','A','Done');await first;await pause(300);
 assert.equal(f.sent.filter(e=>e.frame.t==='prompt').length,1);
});
test('one native approval is surfaced only in the owning OMB view',async t=>{
 const f=fixture();t.after(()=>f.pool.close());const questions=[[],[]];
 f.one.on('question',q=>questions[0].push(q));f.two.on('question',q=>questions[1].push(q));
 const result=f.one.submit('one','A');await pause(300);
 f.broadcast({t:'entry',entry:{type:'custom_message',id:'admission',details:{from:f.one.name},content:'A'}});
 f.broadcast({t:'ui-request',request:{reqId:77,kind:'select',title:'Allow tool: bash',options:['Approve','Deny']}});
 assert.equal(questions[0].length,1);assert.equal(questions[1].length,0);
 f.one.answerUi('77',{value:'Deny'});f.broadcast({t:'ui-request-end',reqId:77});
 f.complete(f.one,'tail','A','Denied');await result;
 assert.equal(f.sent.filter(e=>e.frame.t==='ui-response').length,1);
});
test('different saved sessions in one directory have distinct owners and an unpinned owner is reused after identification',async t=>{
 const clients=[];
 const pool=new NativeOmpPool((b,o)=>{const c=new NativeOmpCollab(b,o);c.session={sessionId:b.expectedSessionId??'first'};clients.push(c);return c;});
 t.after(()=>pool.close());
 const first=pool.acquire(binding);
 const alias=pool.acquire({...binding,threadId:'alias',expectedSessionId:'first'});
 const second=pool.acquire({...binding,threadId:'second',expectedSessionId:'second'});
 assert.equal(first.options.host,alias.options.host);
 assert.notEqual(first.options.host,second.options.host);
 assert.equal(clients.filter(c=>!c.options.host).length,2);
 first.close();alias.close();assert.equal(second.options.host.closed,false);
});

test('queued shared views preserve the image payload while serializing native inputs',async t=>{
 const f=fixture();t.after(()=>f.pool.close());const images=[{type:'image',mimeType:'image/png',data:'aW1hZ2U='}];
 const first=f.one.submit('plain-first','A'),second=f.two.submit('image-second','B',images);
 await pause(300);f.complete(f.one,'plain','A','First');await first;await pause(300);
 const sent=f.sent.find(e=>e.threadId==='two'&&e.frame.t==='prompt');assert.deepEqual(sent.frame.images,images);
 f.complete(f.two,'image','B','Second');await second;
});
