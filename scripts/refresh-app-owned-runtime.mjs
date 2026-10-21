import {execFileSync} from 'node:child_process';
import {copyFileSync,readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,chmodSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {CodexSharedClient} from '../server/codex-shared-client.ts';
const repo=dirname(dirname(fileURLToPath(import.meta.url))),home=homedir(),directory=join(home,'.codex/omb-shared'),desktop='/Applications/ChatGPT.app',target='019e6f25-8809-7713-b919-70b49f4c806d';
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:'pipe'}),hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const receiptFile=join(directory,'activation.json'),receipt=JSON.parse(readFileSync(receiptFile,'utf8')),proof=JSON.parse(readFileSync(join(repo,'.privacy-dev/direct-codex-bridge/app-owned-probe.json'),'utf8'));
if(!proof.ok||!proof.appToolsAvailable||!proof.isolatedHome||!proof.actualDesktop)throw Error('Actual desktop app-tools test has not passed');
if(receipt.nativeThreadId!==target||receipt.mode!=='desktop-owned'||hash(receipt.wrapper)!==receipt.wrapperHash)throw Error('Unexpected installed runtime');
if(run('/bin/launchctl',['getenv','CODEX_CLI_PATH']).trim()!==receipt.wrapper)throw Error('Unexpected CLI override');
const running=run('/bin/ps',['-axo','comm=']).split('\n').some(line=>line.trim()===desktop+'/Contents/MacOS/ChatGPT');
if(process.argv.includes('--check')){console.log(JSON.stringify({ready:true,desktopMustQuit:running,personalRestart:false,appToolsInIsolatedDesktop:44}));process.exit(0);}
if(running)throw Error('Quit ChatGPT before changing its runtime');
const res=await fetch('http://127.0.0.1:8897/api/bots?messages=0',{signal:AbortSignal.timeout(5000)});
if(!res.ok||(await res.json()).bots.some(b=>b.busy||b.tasks?.some(t=>t.busy)))throw Error('Personal has active work or is unavailable');
const socket=join(directory,'control.sock'),deadline=Date.now()+20000;
for(;;){const active=await new Promise(resolve=>{const s=createConnection(socket);s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.setTimeout(500,()=>{s.destroy();resolve(true)});});if(!active)break;if(Date.now()>deadline)throw Error('Previous native runtime is still active');await new Promise(r=>setTimeout(r,100));}
const backup=join(repo,'.privacy-dev/local-backups','app-owned-direct-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});copyFileSync(receiptFile,join(backup,'activation.json'));copyFileSync(receipt.wrapper,join(backup,'codex'));
const privacy=join(home,'.openmausbot-personal/private/settings.json'),privacyHash=hash(privacy);
for(const file of ['codex','app-owned-codex-proxy.mjs']){const dest=join(directory,file);if(existsSync(dest)&&file!=='codex')copyFileSync(dest,join(backup,file));copyFileSync(join(repo,'.privacy-dev/app-owned-runtime',file),dest);chmodSync(dest,file==='codex'?0o700:0o600);}
Object.assign(receipt,{runtimeSwitchedAt:new Date().toISOString(),directRuntimeBackup:backup,wrapperHash:hash(receipt.wrapper),proxyHash:hash(join(directory,'app-owned-codex-proxy.mjs')),state:'switching-runtime',directDesktopChild:true});
const save=()=>{writeFileSync(receiptFile+'.tmp',JSON.stringify(receipt,null,2),{mode:0o600});renameSync(receiptFile+'.tmp',receiptFile)};save();let client;
try{
 run('/usr/bin/open',['--env','CODEX_APP_SERVER_WS_URL=','--env','CODEX_CLI_PATH='+receipt.wrapper,'--env','CODEX_APP_SERVER_FORCE_CLI=1','-a',desktop]);
 const ready=Date.now()+60000,status=join(directory,'app-owned-status.json');
 for(;;){if(existsSync(status)){const state=JSON.parse(readFileSync(status,'utf8'));if(state.state==='ready'&&state.directDesktopChild&&Date.parse(state.startedAt)>=Date.parse(receipt.runtimeSwitchedAt))break;}if(Date.now()>ready)throw Error('Direct desktop-owned server did not start');await new Promise(r=>setTimeout(r,100));}
 client=new CodexSharedClient(socket);await client.initialize();run('/usr/bin/open',['codex://threads/'+target]);
 for(;;){const {thread:t}=await client.request('thread/read',{threadId:target});if(t.id===target&&t.name==='M1MacControl'&&['idle','active'].includes(t.status?.type))break;if(Date.now()>ready)throw Error('Original thread did not load');await new Promise(r=>setTimeout(r,200));}
 const servers=await client.request('mcpServerStatus/list',{});receipt.appToolCount=Object.keys(servers.data?.find(s=>s.name==='codex_app')?.tools??{}).length;
 if(hash(privacy)!==privacyHash)throw Error('Privacy settings changed unexpectedly');
 Object.assign(receipt,{state:'launched-awaiting-ui-verification',desktopLoadedOriginalThread:true,privacySettingsUnchanged:true,personalRestart:false,appToolsCatalogVerified:receipt.appToolCount>0});save();console.log(JSON.stringify({switched:true,appTools:receipt.appToolCount,personalRestart:false}));
}catch(error){receipt.state='runtime-refresh-needs-review';receipt.error=error.message;save();throw error;}finally{await client?.close();}
