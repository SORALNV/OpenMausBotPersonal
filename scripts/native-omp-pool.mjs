import { createHash } from 'node:crypto';
import { nativeOmpCommand } from './native-omp-transport.mjs';
import { NativeOmpCollab } from './native-omp-collab.mjs';

/** One SSH/relay owner per native session; independent standard guests preserve each OMB thread's native attribution. */
export class NativeOmpPool {
  constructor(open = (binding, options) => NativeOmpCollab.connect(binding, options)) { this.open=open;this.sessions=new Map(); }
  acquire(binding) {
    const sessionDir=nativeOmpCommand(binding).sessionDir;
    const base=JSON.stringify([binding.host,binding.user,binding.binary,binding.profile,sessionDir]);
    const identity=binding.expectedSessionId??binding.sessionFile??'current';
    const key=JSON.stringify([base,identity]);
    let record=this.sessions.get(key)??[...this.sessions.values()].find(candidate=>
      candidate.base===base && !candidate.host.closed && binding.expectedSessionId &&
      (candidate.host.session?.sessionId??candidate.host.binding.expectedSessionId)===binding.expectedSessionId);
    if(!record || record.host.closed) {
      const threadId='shared-owner-'+createHash('sha256').update(key).digest('hex').slice(0,24);
      record={base,key,host:this.open({...binding,sessionDir,threadId},{timeoutMs:90000}),leases:new Set(),tail:Promise.resolve(),questions:new Map()};
      this.sessions.set(key,record);
      record.host.on('disconnected',()=>{for(const lease of record.leases)lease.fail('Native session owner disconnected; do not replay');});
    }
    const lease=this.open({...binding,sessionDir},{timeoutMs:90000,host:record.host});
    record.leases.add(lease);
    const original={emit:lease.emit.bind(lease),submit:lease.submit.bind(lease),stop:lease.stop.bind(lease),close:lease.close.bind(lease),status:lease.requestStatus.bind(lease)};
    const queued=new Map(), statuses=new Map();
    lease.emit=(event,...args)=>{
      if(event==='question') {
        const id=args[0].id,owner=record.questions.get(id)??record.active??record.lastActive??[...record.leases][0];
        if(owner!==lease)return false;
        record.questions.set(id,lease);
      }
      if(event==='questionCancelled')record.questions.delete(args[0]);
      return original.emit(event,...args);
    };
    lease.requestStatus=id=>queued.has(id)?'queued':original.status(id)??statuses.get(id);
    lease.submit=(id,text)=>{
      if(lease.closed||queued.has(id)||statuses.has(id))return Promise.reject(Error('Native request unavailable or already queued'));
      let rejectQueued;
      const cancelled=new Promise((_,reject)=>{rejectQueued=reject;});
      const slot={cancelled:false,reject:rejectQueued};queued.set(id,slot);statuses.set(id,'queued');
      const operation=record.tail.catch(()=>{}).then(async()=>{
        queued.delete(id);
        if(slot.cancelled||lease.closed)throw Error('Queued native input cancelled');
        record.active=lease;record.lastActive=lease;
        try{return await original.submit(id,text);}finally{if(record.active===lease)record.active=undefined;}
      });
      record.tail=operation.catch(()=>{});
      return Promise.race([operation,cancelled]);
    };
    lease.stop=async()=>{
      if(queued.size){for(const slot of queued.values()){slot.cancelled=true;slot.reject(Error('Queued native input cancelled'));}queued.clear();return true;}
      return record.active===lease?original.stop():false;
    };
    lease.close=()=>{
      if(!record.leases.has(lease))return;
      for(const slot of queued.values()){slot.cancelled=true;slot.reject(Error('Queued native input cancelled'));}queued.clear();
      original.close();record.leases.delete(lease);
      if(record.lastActive===lease)record.lastActive=undefined;
      for(const [id,owner] of record.questions)if(owner===lease)record.questions.delete(id);
      if(!record.leases.size){record.host.close();if(this.sessions.get(record.key)===record)this.sessions.delete(record.key);}
    };
    return lease;
  }
  close(){for(const record of this.sessions.values())for(const lease of record.leases)lease.close();this.sessions.clear();}
}
