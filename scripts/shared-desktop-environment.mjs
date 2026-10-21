import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,writeFileSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const directory=join(homedir(),'.codex/omb-shared'),file=join(directory,'activation.json'),uid=process.getuid();
function privateFile(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==uid||s.mode&0o077)throw Error('Owner-private runtime file required');}
privateFile(file);const receipt=JSON.parse(readFileSync(file,'utf8'));
if(receipt.mode!=='desktop-owned'||receipt.state==='rolled-back'||dirname(receipt.wrapper)!==directory)throw Error('Desktop-owned runtime is not active');
for(const [path,digest] of [[receipt.wrapper,receipt.wrapperHash],[join(directory,'app-owned-codex-proxy.mjs'),receipt.proxyHash]]){privateFile(path);if(createHash('sha256').update(readFileSync(path)).digest('hex')!==digest)throw Error('Runtime file changed since verification');}
let existing='';try{existing=execFileSync('/bin/launchctl',['getenv','CODEX_CLI_PATH'],{encoding:'utf8'}).trim();}catch{}
if(existing&&existing!==receipt.wrapper)throw Error('A different CLI override is already configured');
execFileSync('/bin/launchctl',['setenv','CODEX_CLI_PATH',receipt.wrapper]);
const status=join(directory,'desktop-environment.json');writeFileSync(status+'.tmp',JSON.stringify({configuredAt:new Date().toISOString(),managedBy:'openmausbot-personal',ready:true}),{mode:0o600});renameSync(status+'.tmp',status);
