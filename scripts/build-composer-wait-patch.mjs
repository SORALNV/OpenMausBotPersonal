import {readFile,writeFile,realpath,readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const repo=fileURLToPath(new URL('../',import.meta.url));
const assets=await realpath(process.argv[2]??''),allowed=await realpath(resolve(repo,'.privacy-dev/personal-build'));
if(!assets.startsWith(allowed+sep)||!assets.endsWith('.app/Contents/Resources/ui/assets'))throw Error('Only staged UI assets may be patched');
const find=(root,p)=>{const out=[];function walk(n){if(p(n))out.push(n);ts.forEachChild(n,walk);}walk(root);return out;};
const one=(root,p)=>{const all=find(root,p);if(all.length!==1)throw Error('UI patch target count: '+all.length);return all[0];};
const changed=[];
for(const name of await readdir(assets)) {
 if(!name.endsWith('.js'))continue;
 const file=resolve(assets,name),original=await readFile(file,'utf8');if(!original.includes('"data-tour":"composer"'))continue;
 if(original.includes('function ombComposerRoomWait('))throw Error('UI already patched');
 const tree=ts.createSourceFile(name,original,ts.ScriptTarget.ESNext,true,ts.ScriptKind.JS);
 const tour=one(tree,n=>ts.isPropertyAssignment(n)&&n.name.getText(tree)==='"data-tour"'&&n.initializer.getText(tree)==='"composer"');
 let component=tour;while(component&&!ts.isFunctionDeclaration(component))component=component.parent;
 if(!component||!ts.isObjectBindingPattern(component.parameters[0].name))throw Error('Composer binding missing');
 const prop=(pattern,key)=>pattern.elements.find(n=>n.propertyName?.getText(tree)===key||(!n.propertyName&&n.name.getText(tree)===key))?.name.getText(tree);
 const profile=prop(component.parameters[0].name,'bot'),group=prop(component.parameters[0].name,'group');
 const store=one(component,n=>ts.isVariableDeclaration(n)&&ts.isObjectBindingPattern(n.name)&&prop(n.name,'state')&&prop(n.name,'dispatch'));
 const state=prop(store.name,'state'),dispatch=prop(store.name,'dispatch');
 const jsx=tour.parent.parent;if(!ts.isCallExpression(jsx))throw Error('Composer JSX missing');
 const render=jsx.expression.getText(tree);
 const disabled=one(component,n=>ts.isPropertyAssignment(n)&&n.name.getText(tree)==='disabled'&&n.parent.properties?.some(p=>p.name?.getText(tree)==='"aria-busy"'));
 if(!ts.isBinaryExpression(disabled.initializer)||!ts.isPrefixUnaryExpression(disabled.initializer.left))throw Error('Approval disabled expression changed');
 let approval=disabled.initializer.left;while(ts.isPrefixUnaryExpression(approval))approval=approval.operand;
 const lock=disabled.initializer.right.getText(tree);
 const sendProp=one(component,n=>ts.isPropertyAssignment(n)&&n.name.getText(tree)==='onSend'&&n.parent.properties?.some(p=>p.name?.getText(tree)==='steerLabel'));
 const send=one(component,n=>ts.isVariableDeclaration(n)&&n.name.getText(tree)===sendProp.initializer.getText(tree));
 if(!ts.isArrowFunction(send.initializer)||!ts.isBlock(send.initializer.body))throw Error('Composer send missing');
 const placeholder=one(component,n=>ts.isCallExpression(n)&&n.arguments.some(a=>ts.isStringLiteral(a)&&a.text==='composer.placeholder.approval'));
 const innerEdits=[
 {start:disabled.initializer.getStart(tree),end:disabled.initializer.end,text:lock},
 {start:placeholder.getStart(tree),end:placeholder.end,text:JSON.stringify('確認待ちです。追加の指示は順番待ちに追加できます')}];
 let jsxText=jsx.getText(tree);const offset=jsx.getStart(tree);
 for(const edit of innerEdits.sort((a,b)=>b.start-a.start)){if(edit.start<offset||edit.end>jsx.end)throw Error('Unexpected JSX nesting');jsxText=jsxText.slice(0,edit.start-offset)+edit.text+jsxText.slice(edit.end-offset);}
 const edits=[{start:offset,end:jsx.end,text:`[ombComposerRoomWait(${profile},${group},${state}.groups,${dispatch},${render}),${jsxText}]`},
 {start:send.initializer.body.getStart(tree)+1,end:send.initializer.body.getStart(tree)+1,text:`if(${approval.getText(tree)})${send.initializer.parameters[0].name.getText(tree)}="queue";`}];
 let output=original;for(const edit of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
 const helper=ts.transpileModule(await readFile(resolve(repo,'src/components/ComposerRoomWait.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace(/^import .*;\s*$/gmu,'').replace(/^export /gmu,'');
 output=`function ombComposerRoomWait(profile,group,groups,dispatch,_jsx){const _jsxs=_jsx;${helper};return ComposerRoomWait({profile,group,groups,dispatch});}\n`+output;
 const check=ts.createSourceFile(name,output,ts.ScriptTarget.ESNext,true,ts.ScriptKind.JS);
 if(check.parseDiagnostics.length)throw Error(ts.flattenDiagnosticMessageText(check.parseDiagnostics[0].messageText,' '));
 await writeFile(file,output);changed.push(name);
}
if(changed.length!==1)throw Error('Expected exactly one composer bundle');
console.log(JSON.stringify({changed,waitLocation:true,approvalKeepsDraftInput:true,pendingApprovalSendQueues:true}));
