import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createFramedMessageParser,writeFramedMessage} from '../../mcp-server/dist/mcp_stdio.js';

for (const identity of [null, '__operator__', 'other-owner']) {
  test(`owner identity binding ${identity ?? 'unbound'} preserves explicit owners and helper reporting`, async () => {
    const requests = [];
    const server = http.createServer((req,res) => {
      let raw=''; req.on('data',c=>{raw+=c;}); req.on('end',()=>{
        requests.push({url:req.url,body:raw?JSON.parse(raw):null});
        res.writeHead(200,{'content-type':'application/json'});
        res.end(JSON.stringify({ok:true,result:{action:'created'},state:{reports:[],summary:{unresolved_count:0}}}));
      });
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const env={...process.env,FACE_HTTP_BASE_URL:`http://127.0.0.1:${server.address().port}`,FACE_WS_URL:'ws://127.0.0.1:1/ws'};
    delete env.MH_FACE_AGENT_ID; if(identity)env.MH_FACE_AGENT_ID=identity;
    const child=spawn(process.execPath,['mcp-server/dist/index.js'],{env,stdio:['pipe','pipe','pipe']});
    child.stderr.resume();let seq=0;const pending=new Map();
    child.stdout.on('data',createFramedMessageParser(m=>{pending.get(m.id)?.(m);pending.delete(m.id);}));
    const call=(method,params)=>new Promise((resolve,reject)=>{
      const id=++seq,timer=setTimeout(()=>reject(Error('RPC timeout')),3000);
      pending.set(id,m=>{clearTimeout(timer);resolve(m);});writeFramedMessage(child.stdin,{jsonrpc:'2.0',id,method,params});
    });
    const tool=(name,args)=>call('tools/call',{name,arguments:args});
    try {
      await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'identity-test',version:'1'}});
      const schema=await call('tools/list',{});
      const assign=schema.result.tools.find(t=>t.name==='agent.assign');
      assert.equal(assign.inputSchema.required.includes('owner_agent_id'),!identity);
      if(identity)assert.ok(assign.description.includes(identity));
      const args={stream_id:'test',mission_id:'mission',agent_id:'helper',goal:'Harmless test'};
      const implicit=await tool('agent.assign',args);
      assert.equal(implicit.result.isError===true,!identity);
      if(identity)assert.equal(requests.at(-1).body.owner_agent_id,identity);
      await tool('agent.assign',{...args,owner_agent_id:'owner'});
      assert.equal(requests.at(-1).body.owner_agent_id,'owner','arbitrary owners must not be aliased or overwritten');
      const inbox=await tool('owner.inbox.list',{});
      assert.equal(inbox.result.isError===true,!identity);
      if(identity)assert.equal(new URL(requests.at(-1).url,'http://localhost').searchParams.get('owner_agent_id'),identity);
      await tool('owner.inbox.list',{owner_agent_id:'another-owner'});
      assert.equal(new URL(requests.at(-1).url,'http://localhost').searchParams.get('owner_agent_id'),'another-owner');
      const count=requests.length;
      const report=await tool('agent.report',{stream_id:'test',mission_id:'mission',from_agent_id:'helper',kind:'progress',summary:'Ack'});
      assert.equal(report.result.isError,true,'helper reports must retain their assignment owner explicitly');
      assert.equal(requests.length,count);
      const empty=await tool('agent.assign',{...args,owner_agent_id:''});
      assert.equal(empty.result.isError,true,'an explicitly invalid owner must not silently fall back');
    } finally {
      child.stdin.end();child.kill('SIGTERM');
      await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
      await new Promise(resolve=>server.close(resolve));
    }
  });
}
