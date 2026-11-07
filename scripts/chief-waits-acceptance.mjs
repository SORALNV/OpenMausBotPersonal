import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join,resolve}from'node:path';import{createServer}from'node:net';
import{verificationServerEnvironment}from'./control-omb.ts';
import{callTool,toolCallContextFromEnv}from'../server/drivers/agents-call.ts';
const repo=process.cwd(),root=mkdtempSync(join(tmpdir(),'omb-teammate-wait-')),data=join(root,'data');mkdirSync(data);mkdirSync(join(data,'tmp'));const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const env={...verificationServerEnvironment({},data,port),OMB_PERSONAL_BUILD:'1',FAKE_CLAUDE_MODE:'slow',FAKE_CLAUDE_DUMP:join(data,'chief-dump.json'),FAKE_CLAUDE_SLOW_FINISH_GATE:join(data,'finish.gate')};writeFileSync(join(data,'config.json'),JSON.stringify({instances:{claude:{driver:'claudeAgent',config:{cli:join(repo,'server/testing/fake-claude-cli.ts')}}},decider:{enabled:false},newBotDefaults:{profile:{computer:'off',browser:false}}}));
const seed=spawnSync(process.execPath,['--input-type=module','-e',`
const {Store}=await import('./server/store.ts');const{openRuntimeStore}=await import('./server/runtime/store.ts');const s=new Store(()=>({instanceId:'claude',model:'fixture'}));const manager=s.createBot({name:'Synthetic Manager'});const chief=s.createBot({name:'Fixture Chief'});s.patchBot(chief.id,{chiefOfStaff:true});const r=openRuntimeStore(process.env.OMB_DATA_DIR+'/runtime.db');const ids=[];const now=Date.now()-3600000;
for(const [i,domain]of ['chat.google.com','github.com'].entries()){
 const b=s.createBot({name:'Synthetic waiting '+i});const base={rootId:'root-'+i,depth:0,origin:{kind:'person',source:'chat'},requester:{kind:'person',threadId:b.threadId,botId:b.id},assignee:{botId:b.id,destination:{kind:'standing_thread',threadId:b.threadId}},mode:'work',reply:'resume',brief:'Fixture read only',status:'waiting',level:'ask',levelSource:'own',executions:1,restarts:0,createdAt:now,startedAt:now,lastActivityAt:now,result:'Delegated fixture',rework:false,version:1};r.insert({...base,id:'root-'+i},{kind:'enqueued'});r.insert({...base,id:'child-'+i,parentId:'root-'+i,depth:1,assignee:{botId:manager.id,destination:{kind:'standing_thread',threadId:manager.threadId}},status:'needs_input',question:'Waiting on the person: sign in to '+domain,result:''},{kind:'parked'});s.appendMessage(b.threadId,{role:'user',kind:'text',text:'Synthetic original request '+i});ids.push({botId:b.id,threadId:b.threadId,domain});
}
const q=s.createBot({name:'Synthetic pending question'});const card=s.appendMessage(q.threadId,{role:'bot',kind:'card',card:{requestId:'synthetic-question',requestType:'question',title:'Synthetic choice',questionRequest:{version:1,questions:[{question:'Choose a fixture',options:[{label:'A'},{label:'B'}]}]}}});
r.insert({id:'question-root',rootId:'question-root',depth:0,origin:{kind:'person',source:'chat'},requester:{kind:'person',threadId:q.threadId,botId:q.id},assignee:{botId:q.id,destination:{kind:'standing_thread',threadId:q.threadId}},mode:'work',reply:'resume',brief:'Fixture question',status:'needs_input',question:'Synthetic question',cards:[card.id],level:'ask',levelSource:'own',executions:1,restarts:0,createdAt:now,startedAt:now,lastActivityAt:now,result:'',rework:false,version:1},{kind:'parked'});ids.push({botId:q.id,threadId:q.threadId,questionCardId:card.id});
const room=s.createGroup('Synthetic ALL',[chief.id,manager.id]);const signIn=s.appendMessage(room.threadId,{role:'bot',kind:'signin',from:{botId:manager.id,name:manager.name,color:manager.color},signIn:{url:'https://example.test/',site:'example.test',place:'local'}});
r.insert({id:'room-wait',rootId:'room-wait',depth:0,origin:{kind:'person',source:'chat'},requester:{kind:'person',threadId:room.threadId,botId:manager.id},assignee:{botId:manager.id,destination:{kind:'room_thread',threadId:room.threadId,groupId:room.id}},mode:'work',reply:'resume',brief:'Old room login',status:'needs_input',question:'Waiting on the person: sign in to example.test',cards:[signIn.id],level:'ask',levelSource:'own',executions:1,restarts:0,createdAt:now,startedAt:now,lastActivityAt:now,result:'',rework:false,version:1},{kind:'parked'});ids.push({botId:manager.id,threadId:room.threadId,waitId:'room-wait',signInId:signIn.id});
r.close();console.log(JSON.stringify({ids,chief:{botId:chief.id,threadId:chief.threadId}}));
`],{cwd:repo,env,encoding:'utf8'});if(seed.status)throw Error('seed: '+seed.stderr);const {ids,chief}=JSON.parse(seed.stdout.trim());
const target=process.argv[2]?resolve(process.argv[2]):join(repo,'server/index.ts');let child,logs='';const base='http://127.0.0.1:'+port;
async function until(read,accept){const end=Date.now()+45000;for(;;){const x=await read();if(accept(x))return x;if(child.exitCode!==null||Date.now()>end)throw Error('fixture timeout');await new Promise(r=>setTimeout(r,100));}}
async function start(){child=spawn(process.execPath,[target],{cwd:repo,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);await until(async()=>{try{return(await fetch(base+'/api/health')).ok}catch{return false}},Boolean);}
async function stop(){if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function api(path,method='GET',body){const r=await fetch(base+path,{method,signal:AbortSignal.timeout(5000),headers:{origin:base,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.status===200||r.status===202);return r.json();}
try {
  await start(); await api('/api/auth/session');
  const originals = await Promise.all(ids.map(id => api('/api/threads/'+id.threadId+'/messages?limit=100')));
  await api('/api/bots/'+chief.botId+'/messages','POST',{threadId:chief.threadId,text:'Synthetic wait recovery controller'});
  await until(async()=>existsSync(join(data,'chief-dump.json')),Boolean);
  const dump=JSON.parse(readFileSync(join(data,'chief-dump.json'),'utf8'));
  assert.ok(dump.systemPrompt.includes('manage_thread_wait'));
  const context=toolCallContextFromEnv(dump.mcpConfig.mcpServers.agents.env);
  const tool=async args=>JSON.parse((await callTool('manage_thread_wait',args,context)).text);
  const listed=await tool({action:'list'});
  assert.equal(listed.waits.length,5);
  assert.ok(!listed.waits.some(w=>w.threadId===chief.threadId));
  for(const id of ids) {
    const wait=listed.waits.find(w=>w.threadId===id.threadId);assert.ok(wait);
    const stale=await fetch(base+'/api/internal/thread-waits',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN},body:JSON.stringify({action:'clear',toBotId:id.botId,toThreadId:id.threadId,...(id.waitId?{waitId:id.waitId}:{}),expectedToken:'stale',reason:'fixture stale'})});
    assert.equal(stale.status,409);await stale.body.cancel();
    const result=await tool({action:'clear',bot_id:id.botId,thread_id:id.threadId,expected_token:wait.token,...(id.waitId?{wait_id:id.waitId}:{}),reason:'利用者から依頼された不要な待機の解除'});
    assert.equal(result.cleared,true);
    if(!id.waitId)await until(async()=>{const b=(await api('/api/bots?messages=0')).bots.find(b=>b.id===id.botId);return !b.waitingForTeammates&&b.activity!=='waiting-on-you'},Boolean);
    const after=(await api('/api/threads/'+id.threadId+'/messages?limit=100')).messages;
    const before=originals[ids.indexOf(id)].messages;
    for(const row of before)assert.ok(after.some(m=>m.id===row.id&&m.text===row.text));
    assert.ok(after.some(m=>m.tool?.name==='Chiefによる待機解除'));
    if(id.questionCardId){const c=after.find(m=>m.id===id.questionCardId).card;assert.equal(c.dismissed,true);assert.equal(c.answered,'unavailable');assert.notEqual(c.answered,'allow');}
    if(id.signInId){const c=after.find(m=>m.id===id.signInId).signIn;assert.equal(c.cancelled,true);assert.notEqual(c.done,true);}
  }
  assert.ok(!(await tool({action:'list'})).waits.some(w=>ids.some(id=>id.threadId===w.threadId)));
  const caller=(await api('/api/bots?messages=0')).bots.find(b=>b.id===chief.botId);assert.equal(caller.busy,true);
  await api('/api/bots/'+chief.botId+'/interrupt','POST',{threadId:chief.threadId});
  await stop();await start();
  for(const id of ids.filter(id=>!id.waitId)){const b=(await api('/api/bots?messages=0')).bots.find(b=>b.id===id.botId);assert.equal(b.waitingForTeammates,false);assert.notEqual(b.activity,'waiting-on-you');}
  const report={isolated:true,compiled:target.endsWith('.js'),chiefToolRoundTrip:true,staleTokenRefused:true,dependencyAndQuestionWaitsCleared:true,questionCancelledWithoutApproval:true,roomLoginCancelledWithoutAuthenticating:true,originalMessagesPreserved:true,auditBothConversations:true,controllerKeptRunning:true,noWaitResurrectionAfterRestart:true,ok:true};
  const out=join(repo,'.privacy-dev/chief-waits-20261031');mkdirSync(out,{recursive:true});writeFileSync(join(out,target.endsWith('.js')?'packaged-acceptance.json':'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(e) {writeFileSync(join(repo,'.privacy-dev/chief-waits-20261031/fixture-error.log'),logs);throw e;}
finally{await stop();rmSync(root,{recursive:true,force:true});}
