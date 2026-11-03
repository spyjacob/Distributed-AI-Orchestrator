import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import * as apps from '../../src/core/apps.js';
import {runTool} from '../../src/core/tools.js';
import {runTurn} from '../../src/core/agent.js';
import * as responses from '../../src/core/providers/openai-responses.js';
import * as anthropic from '../../src/core/providers/anthropic.js';
import {budgetResponses} from '../../src/core/transcript.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(),'do-hardening-'));
const project = path.join(root,'project'), outside = path.join(root,'outside'), data = path.join(root,'data');
for (const dir of [project,outside,data]) await fs.mkdir(dir);
const children = [];
const requests = [];
const mock = http.createServer(async(req,res) => {
  const chunks=[]; for await(const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks)); requests.push(body);
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
  if(req.url.includes('/responses')) {
    emit('response.created',{response:{model:'served-responses',reasoning:{effort:'high'}}});
    emit('response.output_text.delta',{delta:'partial answer'});
    emit('response.incomplete',{response:{model:'fixture',status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}});
  } else if(req.url.includes('/messages')) {
    emit('message_start',{message:{id:'m1',type:'message',role:'assistant',model:'served-messages',content:[],usage:{input_tokens:1,output_tokens:0}}});
    emit('content_block_start',{index:0,content_block:{type:'text',text:''}});
    emit('content_block_delta',{index:0,delta:{type:'text_delta',text:'hello'}});
    emit('content_block_stop',{index:0});
    emit('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:1}});
    emit('message_stop',{});
  } else {
    res.write(`data: ${JSON.stringify({model:'served-chat',choices:[{index:0,delta:{tool_calls:[{index:0,id:'forbidden',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'should-not-exist',content:'bad'})}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
  }
  res.end();
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
try {
  const baseUrl=`http://127.0.0.1:${mock.address().port}/v1`;
  const spec={alias:'fixture',provider:'openai',model:'fixture',baseUrl,apiKey:'synthetic'};
  const session={id:'fixture',model:'fixture',mode:'chat',projectDir:project,events:[]};
  await runTurn({session,models:{fixture:{...spec,extraBody:{tools:[{type:'function'}],model:'wrong'}}},userText:'test',attachments:[],save:async()=>{}});
  assert.equal(requests.at(-1).tools,undefined);
  assert.equal(requests.at(-1).model,'fixture');
  assert.match(session.events.at(-1).text,/No tools were executed/);
  assert.equal(await fs.stat(path.join(project,'should-not-exist')).catch(()=>null),null);
  assert.equal(session.events.filter(e=>e.type==='tool_result').length,1);
  // Each API reports only what its response says: the model always, effort only where it is echoed.
  const sentReport=session.events.find(e=>e.type==='user').modelReport;
  assert.equal(sentReport.by,'API response'); assert.equal(sentReport.model,'served-chat');
  assert.ok(!('effort' in sentReport),'chat completions do not echo effort, so none is claimed');
  const rs={...spec,provider:'openai-responses',reasoningEffort:'max'};
  const responseReports=[];
  const incomplete=await responses.complete({client:responses.makeClient(rs),spec:rs,events:[],useTools:false,onModelReport:r=>responseReports.push(r)});
  assert.equal(incomplete.text,'partial answer'); assert.match(incomplete.error,/max_output_tokens/);
  assert.equal(responseReports[0].model,'served-responses'); assert.equal(responseReports[0].effort,'high','the effort the response names, not the one requested');
  assert.ok(!('effort' in responseReports[1]),'a response that leaves out reasoning reports no effort');
  const as={...spec,provider:'anthropic',fallbacks:false,effort:'max'};
  const messageReports=[];
  const answer=await anthropic.complete({client:anthropic.makeClient(as),spec:as,events:[],useTools:false,onModelReport:r=>messageReports.push(r)});
  assert.equal(answer.text,'hello'); assert.equal(requests.at(-1).tools,undefined);
  assert.equal(answer.servedModel,'served-messages');
  assert.equal(messageReports[0].model,'served-messages'); assert.ok(!('effort' in messageReports[0]),'the Messages API does not echo effort, so none is claimed');
  const items=[{role:'user',content:'never drop me'},{type:'function_call',call_id:'one',arguments:'{}'},
    {type:'function_call_output',call_id:'one',output:'a'.repeat(10000)},
    {type:'function_call',call_id:'two',arguments:'{}'},{type:'function_call_output',call_id:'two',output:'latest'}];
  const trimmed=budgetResponses(items,1000);
  assert.deepEqual(trimmed.map(x=>x.call_id),items.map(x=>x.call_id));
  assert.equal(trimmed[0].content,'never drop me'); assert.equal(trimmed.at(-1).output,'latest');
  assert.ok(JSON.stringify(trimmed).length<1000); assert.equal(items[2].output.length,10000);

  // Concurrent persisted mutations, not concurrent access to a mocked array.
  const registry=path.join(root,'registry');
  const created=await Promise.all(Array.from({length:12},(_,i)=>apps.create(registry,{name:'parallel',dir:path.join(root,'p'+i)})));
  assert.equal(new Set(created.map(a=>a.id)).size,12);
  assert.equal((await apps.load(registry)).filter(a=>!a.builtin).length,12);
  await Promise.all(created.map((a,i)=>apps.update(registry,a.id,{start:'fixture-'+i})));
  assert.equal((await apps.load(registry)).filter(a=>a.start?.startsWith('fixture-')).length,12);
  const corrupt='{broken registry'; await fs.writeFile(path.join(registry,'apps.json'),corrupt);
  await assert.rejects(apps.create(registry,{name:'no',dir:path.join(root,'no')}),/corrupt/);
  assert.equal(await fs.readFile(path.join(registry,'apps.json'),'utf8'),corrupt);

  await fs.writeFile(path.join(outside,'private.txt'),'private fixture');
  await fs.symlink(outside,path.join(project,'escape'),process.platform==='win32'?'junction':'dir');
  const ctx={projectDir:project,allowOutside:false,readableDirs:[]};
  assert.equal((await runTool({name:'read_file',args:{path:'escape/private.txt'}},ctx)).ok,false);
  assert.equal((await runTool({name:'write_file',args:{path:'escape/new/sub.txt',content:'bad'}},ctx)).ok,false);
  assert.equal((await runTool({name:'read_file',args:{path:'escape/private.txt'}},{...ctx,readableDirs:[outside]})).ok,true);

  const controller = new AbortController();
  await fs.writeFile(path.join(project,'owned-job.cjs'), "const fs=require('node:fs');fs.writeFileSync('started','1');setTimeout(()=>fs.writeFileSync('finished','1'),3000);");
  const command = '"' + process.execPath + '" owned-job.cjs';
  const job = runTool({name:'bash',args:{command}}, {...ctx,signal:controller.signal});
  for(let i=0;i<100 && !await fs.stat(path.join(project,'started')).catch(()=>null);i++) await new Promise(r=>setTimeout(r,50));
  assert.ok(await fs.stat(path.join(project,'started')));
  controller.abort();
  assert.equal((await job).ok,false);
  await new Promise(r=>setTimeout(r,3200));
  assert.equal(await fs.stat(path.join(project,'finished')).catch(()=>null),null,'owned command did not continue after cancellation');

  await fs.writeFile(path.join(data,'models.json'),JSON.stringify({default:'fixture',models:{fixture:spec}}));
  const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port; await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,HARNESS_PORT:String(port),HARNESS_DATA_DIR:data,HARNESS_TOKEN:'',ORCHESTRATOR_PUBLIC_URL:`http://127.0.0.1:${port}`},stdio:'ignore'});
  const closed=once(child,'exit');children.push({child,closed});
  const origin=`http://127.0.0.1:${port}`;
  const request=(route,options={})=>fetch(origin+route,{...options,signal:AbortSignal.timeout(10000)});
  for(let i=0;i<100;i++){try {if((await request('/api/state')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.equal((await request('/api/state')).status,200);
  const hostileStatus = await new Promise((resolve,reject) => { const req=http.get(origin+'/api/state',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject); });
  assert.equal(hostileStatus,401,'DNS rebinding refused');
  const lan=Object.values(os.networkInterfaces()).flat().find(n=>n.family==='IPv4'&&!n.internal);
  if(lan) assert.equal((await fetch(`http://${lan.address}:${port}/api/state`,{signal:AbortSignal.timeout(5000)})).status,401,'LAN socket refused');
  const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await request('/api/sessions',{...post({}),headers:{'Content-Type':'application/json',Origin:'https://attacker.example'}})).status,403);
  const made=await request('/api/sessions',post({name:'fixture',model:'fixture',projectDir:project,mode:'chat'}));
  assert.equal(made.status,200); const saved=await made.json();
  const sid=saved.id;
  assert.ok(sid);
  assert.equal((await request(`/api/sessions/${sid}`,{...post({events:[]}),method:'PATCH'})).status,400);
  const file=path.join(project,'page.html'); await fs.writeFile(file,'<script>fetch("/api/state")</script>');
  const scoped=p=>'/api/file?session='+encodeURIComponent(sid)+'&path='+encodeURIComponent(p);
  const html=await request(scoped(file));assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/^sandbox;/);
  assert.equal((await request(scoped(path.join(project,'escape/private.txt')))).status,403);
  assert.equal((await request(scoped(path.join(data,'models.json')))).status,403);
  assert.equal((await request('/api/files?path='+encodeURIComponent(data))).status,403);
  const frontend=await (await request('/app.js')).text();
  const renderContext=vm.createContext({state:{session:null},nodeApi:x=>x});
  vm.runInContext(frontend.slice(frontend.indexOf('const esc ='),frontend.indexOf('const clock =')),renderContext);
  const hostile=renderContext.render('[link](https://example.com/\"onclick=\"alert)');
  assert.ok(!hostile.includes('href="https://example.com/"onclick='));
  assert.match(hostile,/&quot;/);
  assert.ok(!renderContext.render('[link](javascript:alert)').includes('href='));
  console.log('PASS isolated hardening: hostile HTTP/rendering and paths, registry concurrency/corruption, provider no-tools/incomplete and context integrity');
} finally {
  for(const {child,closed} of children){child.kill('SIGTERM');await closed;}
  await new Promise(r=>mock.close(r));
  await fs.rm(root,{recursive:true,force:true});
}
