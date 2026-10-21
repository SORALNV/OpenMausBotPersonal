import {lstatSync,realpathSync,writeFileSync,renameSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
const [directory,ownerArg]=process.argv.slice(2),owner=Number(ownerArg),uid=process.getuid();
const attaching=process.argv.includes('--attach');
if(!isAbsolute(directory)||!Number.isSafeInteger(owner)||(!attaching&&owner!==process.ppid))throw Error('An owning desktop child is required');
const info=lstatSync(directory);if(realpathSync(directory)!==directory||info.uid!==uid||info.mode&0o077)throw Error('Private directory required');
const statusFile=join(directory,'app-owned-status.json'),socket=join(directory,'control.sock');
const state={managedBy:'openmausbot-personal',mode:'desktop-owned',startedAt:new Date().toISOString(),nativePid:owner,proxyPid:process.pid,directDesktopChild:true,state:'starting'};
const save=()=>{if(attaching)return;const temp=statusFile+'.'+randomUUID();writeFileSync(temp,JSON.stringify(state),{mode:0o600,flag:'wx'});renameSync(temp,statusFile)};
save();process.stdin.pause();let ws,stopping=false,buffer='';
function stop(){if(stopping)return;stopping=true;state.state='stopping';save();ws?.terminate();if(!attaching&&process.ppid===owner)try{process.kill(owner,'SIGTERM')}catch{}process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.stdin.on('end',stop);
if(!attaching){const interval=setInterval(()=>{if(process.ppid!==owner)stop()},500);interval.unref();}
try{
 const deadline=Date.now()+20000;let target;
 for(;;){
  if(!attaching&&process.ppid!==owner)throw Error('Owning native server exited');
  try{target=realpathSync(socket);const p=lstatSync(dirname(target)),s=lstatSync(target);if(p.uid===uid&&!(p.mode&0o077)&&s.uid===uid&&s.isSocket()&&!(s.mode&0o077))break;}catch{}
  if(Date.now()>deadline)throw Error('Private native socket did not become ready');await new Promise(r=>setTimeout(r,50));
 }
 ws=new WebSocket('ws://localhost/rpc',{createConnection:()=>createConnection(target),perMessageDeflate:false,maxPayload:128*1024*1024,handshakeTimeout:5000});
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
 ws.on('message',data=>{if(!process.stdout.write(data.toString()+'\n'))ws.pause()});process.stdout.on('drain',()=>ws.resume());
 ws.on('error',stop);ws.on('close',stop);process.stdin.setEncoding('utf8');
 process.stdin.on('data',data=>{buffer+=data;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim())ws.send(line)}if(buffer.length>128*1024*1024)stop()});
 state.state='ready';save();process.stdin.resume();
}catch{state.state='failed';save();stop();}
