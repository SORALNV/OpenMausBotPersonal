import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,renameSync,existsSync,chmodSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {CodexSharedClient} from '../server/codex-shared-client.ts';
const repo=dirname(dirname(fileURLToPath(import.meta.url))),home=homedir(),directory=join(home,'.codex/omb-shared');
const desktop='/Applications/ChatGPT.app',label='dev.sora.openmausbot.codex-shared',plist=join(home,'Library/LaunchAgents',label+'.plist');
const target='019e6f25-8809-7713-b919-70b49f4c806d',socket=join(directory,'control.sock'),endpoint=`ws+unix://localhost${socket}:/rpc`;
const source=join(repo,'.privacy-dev/app-owned-runtime/codex'),wrapper=join(directory,'codex');
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:'pipe'});
const env=key=>{try{return run('/bin/launchctl',['getenv',key]).trim();}catch{return '';}};
const desktopPids=()=>run('/bin/ps',['-axo','pid=,comm=']).split('\n').filter(line=>line.trim().endsWith(desktop+'/Contents/MacOS/ChatGPT'));
const proof=JSON.parse(readFileSync(join(repo,'.privacy-dev/direct-codex-bridge/app-owned-probe.json'),'utf8'));
if(!proof.privateSharedConnection||!proof.actualDesktop||!proof.isolatedHome)throw Error('Actual desktop transport has not passed its isolated test');
const previous=JSON.parse(readFileSync(join(directory,'activation.json'),'utf8'));
if(previous.nativeThreadId!==target||previous.state!=='launched-awaiting-ui-verification')throw Error('Expected existing shared activation not found');
if(env('CODEX_APP_SERVER_WS_URL')!==endpoint||env('CODEX_CLI_PATH'))throw Error('Unexpected desktop runtime override; refusing to replace it');
const build=JSON.parse(readFileSync(join(repo,'.privacy-dev/direct-codex-bridge/build.json'),'utf8'));
if(hash('/Applications/OpenMausBot Personal.app/Contents/Resources/server/index.js')!==build.serverHash)throw Error('Personal has changed since installation');
if(!existsSync(plist)||!existsSync(source))throw Error('Existing service or candidate wrapper is missing');
if(process.argv.includes('--check')){console.log(JSON.stringify({ready:true,desktopMustQuit:!!desktopPids().length,personalRestart:false,originalThreadId:target,isolatedAppToolsVerified:proof.appToolsAvailable}));process.exit(0);}
if(desktopPids().length)throw Error('Quit the desktop before switching its runtime');
const bots=await fetch('http://127.0.0.1:8897/api/bots?messages=0',{signal:AbortSignal.timeout(5000)});
if(!bots.ok||(await bots.json()).bots.some(b=>b.busy||b.tasks?.some(t=>t.busy)))throw Error('Personal has active work or is unavailable');
const backup=join(repo,'.privacy-dev/local-backups','app-owned-'+randomUUID());mkdirSync(backup,{recursive:true,mode:0o700});
copyFileSync(plist,join(backup,'standalone.plist'));copyFileSync(join(directory,'activation.json'),join(backup,'activation.json'));
const privacy=join(home,'.openmausbot-personal/private/settings.json'),privacyHash=hash(privacy);
copyFileSync(source,wrapper);chmodSync(wrapper,0o700);
const receipt={...previous,mode:'desktop-owned',runtimeSwitchedAt:new Date().toISOString(),runtimeBackup:backup,wrapper,wrapperHash:hash(wrapper),state:'switching-runtime',appToolsVerified:false};
const save=()=>{const temp=join(directory,'activation.'+randomUUID()+'.tmp');writeFileSync(temp,JSON.stringify(receipt,null,2),{mode:0o600});renameSync(temp,join(directory,'activation.json'));};
save();let client;
try{
 const oldNative=JSON.parse(readFileSync(join(directory,'status.json'),'utf8')).nativePid;
 run('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`]);renameSync(plist,join(backup,'disabled-standalone.plist'));
 const stoppedDeadline=Date.now()+15000;
 for(;;){try{process.kill(oldNative,0);}catch{break;}if(Date.now()>stoppedDeadline)throw Error('Previous runtime did not stop');await new Promise(r=>setTimeout(r,100));}
 run('/bin/launchctl',['unsetenv','CODEX_APP_SERVER_WS_URL']);run('/bin/launchctl',['setenv','CODEX_CLI_PATH',wrapper]);
 run('/usr/bin/open',['--env','CODEX_APP_SERVER_WS_URL=','--env','CODEX_CLI_PATH='+wrapper,'--env','CODEX_APP_SERVER_FORCE_CLI=1','-a',desktop]);
 const deadline=Date.now()+60000,status=join(directory,'app-owned-status.json');
 for(;;){if(existsSync(status)){const state=JSON.parse(readFileSync(status,'utf8'));if(state.state==='ready'&&Date.parse(state.startedAt)>=Date.parse(receipt.runtimeSwitchedAt))break;}if(Date.now()>deadline)throw Error('Desktop-owned runtime did not start');await new Promise(r=>setTimeout(r,100));}
 client=new CodexSharedClient(socket);await client.initialize();
 run('/usr/bin/open',['codex://threads/'+target]);
 for(;;){const {thread}=await client.request('thread/read',{threadId:target});if(thread.id===target&&['idle','active'].includes(thread.status?.type))break;if(Date.now()>deadline)throw Error('Original thread did not load');await new Promise(r=>setTimeout(r,200));}
 if(hash(privacy)!==privacyHash)throw Error('Privacy settings unexpectedly changed');
 const servers=await client.request('mcpServerStatus/list',{});
 receipt.appToolCount=Object.keys(servers.data?.find(s=>s.name==='codex_app')?.tools??{}).length;
 Object.assign(receipt,{state:'launched-awaiting-ui-verification',desktopLoadedOriginalThread:true,privacySettingsUnchanged:true,personalRestart:false});save();
 console.log(JSON.stringify({switched:true,mode:receipt.mode,appToolCount:receipt.appToolCount,personalRestart:false,originalThreadId:target}));
}catch(error){receipt.state='runtime-switch-needs-review';receipt.error=error.message;save();throw error;}finally{await client?.close();}
