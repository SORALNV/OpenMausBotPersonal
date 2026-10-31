import{readFile,writeFile,realpath}from'node:fs/promises';import{resolve,sep}from'node:path';import{fileURLToPath}from'node:url';import ts from'typescript';
const repo=fileURLToPath(new URL('../',import.meta.url)),file=await realpath(process.argv[2]??''),allowed=await realpath(resolve(repo,'.privacy-dev/personal-build'));
if(!file.startsWith(allowed+sep)||!file.endsWith('.app/Contents/Resources/server/index.js'))throw Error('Only a staged runtime may be patched');
let text=await readFile(file,'utf8');if(text.includes('ROUTES.push(scopeGoogleChatRoute(googleChat.route))')){console.log(JSON.stringify({alreadyPatched:true}));process.exit(0);}
const needle='ROUTES.push(googleChat.route)';if(text.split(needle).length!==2)throw Error('Unique Google Chat route registration not found');
const source=await readFile(resolve(repo,'server/google-chat-route.ts'),'utf8');let helper=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;helper=helper.replace(/^import .*;\s*$/gmu,'').replace(/^export /gmu,'');
text=helper+'\n'+text.replace(needle,'ROUTES.push(scopeGoogleChatRoute(googleChat.route))');await writeFile(file,text);console.log(JSON.stringify({patched:true,canonicalHostDecline:true}));
