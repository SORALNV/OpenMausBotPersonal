import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,lstatSync,realpathSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConnection} from 'node:net';
import {desktopRuntimeRoute} from './shared-runtime-routing.mjs';
const cli='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',args=process.argv.slice(2);
const desktopChild=execFileSync('/bin/ps',['-p',String(process.ppid),'-o','comm='],{encoding:'utf8'}).trim()==='/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const routeInput={desktopChild,appPipe:Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH),args,socketActive:false};
const shared=desktopRuntimeRoute(routeInput)!=='stdio';
let finalArgs=args;
if(shared){
 const directory=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'omb-shared');mkdirSync(directory,{recursive:true,mode:0o700});
 const info=lstatSync(directory);if(realpathSync(directory)!==directory||info.uid!==process.getuid()||info.mode&0o077)throw Error('Shared runtime directory must be owner-private');
 const socket=join(directory,'control.sock');let active=false;
 try{const target=realpathSync(socket);active=await new Promise(resolve=>{const s=createConnection(target);s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.setTimeout(1000,()=>{s.destroy();resolve(false)});});}catch{}
 const route=desktopRuntimeRoute({...routeInput,socketActive:active});
 if(route==='attach'){
  const status=join(directory,'app-owned-status.json'),entry=lstatSync(status);
  if(!entry.isFile()||entry.isSymbolicLink()||entry.uid!==process.getuid()||entry.mode&0o077)throw Error('A private runtime ownership record is required');
  const state=JSON.parse(readFileSync(status,'utf8'));
  if(!Number.isSafeInteger(state.nativePid)||execFileSync('/bin/ps',['-p',String(state.nativePid),'-o','ppid='],{encoding:'utf8'}).trim()!==String(process.ppid))throw Error('Existing runtime is not owned by this desktop');
  process.execve(process.execPath,[process.execPath,join(dirname(fileURLToPath(import.meta.url)),'app-owned-codex-proxy.mjs'),directory,'0','--attach'],process.env);
 }
 if(route==='create'){
  // execve preserves the desktop's direct child PID and runs the genuine signed CLI with its original environment.
  const proxy=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'app-owned-codex-proxy.mjs'),directory,String(process.pid)],{env:process.env,stdio:'inherit'});
  await new Promise((resolve,reject)=>{proxy.once('spawn',resolve);proxy.once('error',reject)});
  finalArgs=[...args,'--listen',`unix://${socket}`];
 }
}
process.execve(cli,[cli,...finalArgs],process.env);
