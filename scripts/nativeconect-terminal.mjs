#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeOmpCommand } from './native-omp-transport.mjs';
import { nativeOmpCatalog } from './native-omp-catalog.mjs';

const option = name => { const i=process.argv.indexOf(name); return i<0 ? undefined : process.argv[i+1]; };
const data=option('--data-dir') ?? join(homedir(),'.openmausbot-personal');
const file=join(data,'private','native-omp.json');
const info=lstatSync(file);
if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077))throw Error('Invalid private NativeConect configuration');
const bindings=JSON.parse(readFileSync(file,'utf8')).bindings;
const bots=JSON.parse(readFileSync(join(data,'bots.json'),'utf8'));
const name=option('--bot') ?? 'RaspberryPi';
const matches=bots.filter(b=>b.name===name||b.id===name);
if(matches.length!==1)throw Error('Select one existing Bot with --bot');
const bot=matches[0], binding=bindings.find(b=>b.botId===bot.id&&b.enabled&&b.connection==='shared-tui');
if(!binding)throw Error('This Bot has no enabled shared native TUI connection');
const threadId=option('--thread')??bot.threadId;
if(!/^[\w-]{1,100}$/.test(threadId??''))throw Error('Explicit native thread required');
if(!bot.tasks?.some(task=>task.threadId===threadId))throw Error('このBotに属するスレッドを選んでください。');
const privateJson=name=>{
 const path=join(data,'private',name);if(!existsSync(path))return {};
 const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)||info.size>2000000)throw Error('Invalid private native target');
 return JSON.parse(readFileSync(path,'utf8'));
};
const target=privateJson('native-omp-targets.json')[threadId]?.session;
const destination={...binding,threadId,expectedSessionId:target?.id??privateJson('native-omp-sessions.json')[threadId],...(target?{sessionDir:target.directory,sessionFile:target.file,cwd:target.cwd??binding.cwd}:{})};
const plan=nativeOmpCommand(destination);
const session=(await nativeOmpCatalog(destination,'inspect')).plan?.tmux;
if(!session||!/^[A-Za-z0-9_-]{1,100}$/.test(session))throw Error('共有TUIが起動していません。PersonalのOMP接続設定でこのスレッドを接続してください。');
const args=plan.args.slice(0,-1);args[0]='-tt';
args.push(`exec env TERM=xterm-256color tmux attach-session -t '${session}'`);
console.log('標準OhMyPi TUIへ接続します。戻るときは Ctrl+B → D。別の omp --continue を起動せず、この共有TUIを使ってください。');
const child=spawn(plan.command,args,{stdio:'inherit',shell:false});
child.once('error',()=>{console.error('SSH could not start');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
