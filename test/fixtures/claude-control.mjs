#!/usr/bin/env node
// Deterministic Claude CLI control-protocol peer for real SDK/server workflows.
import readline from 'node:readline';
import fs from 'node:fs/promises';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const session = 'be7bdebc-bf4e-4f4e-97cb-8cd836674c86';
let asked = false, promptLength, historyReadable, historyFile, doNote, reportCase;
const effortArg = process.argv.find(a=>a.startsWith('--effort='))?.slice(9) || (process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort')+1] : undefined);
// The model and effort as Claude Code reports them: get_settings answers, then the turn finishes.
const answerSettings = message => {
  if (reportCase === 'refused') send({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Unsupported control request'}});
  else send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{applied:{model:'fixture-claude',effort:reportCase === 'capped' ? 'high' : effortArg ?? null}}}});
  if (!reportCase) return;
  send({type:'assistant',session_id:session,parent_tool_use_id:'task-1',message:{model:'fixture-subagent',content:[{type:'text',text:'subagent note'},{type:'tool_use',id:'sub-1',name:'Read',input:{}}],usage:{input_tokens:1,output_tokens:1}}});
  send({type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'fixture-claude-served',content:[{type:'text',text:'reported'}],usage:{input_tokens:1,output_tokens:1}}});
  send({type:'result',subtype:'success',is_error:false,session_id:session,result:'reported',num_turns:1,usage:{input_tokens:1,output_tokens:1},total_cost_usd:0});
  setTimeout(() => process.exit(0), 20);
};
for await (const line of readline.createInterface({input:process.stdin})) {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request?.subtype === 'get_settings') {
    answerSettings(message);
  } else if (message.type === 'control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{commands:[],models:[],account:{},output_style:'default',available_output_styles:['default']}}});
  } else if (message.type === 'user' && !asked && JSON.stringify(message).includes('login expired')) {
    // As the real CLI reports a missing login: its own <synthetic> status line, an error result, a failed exit.
    send({type:'system',subtype:'init',session_id:session,model:'fixture-claude',tools:[],mcp_servers:[],permissionMode:'default',apiKeySource:'none',cwd:process.cwd()});
    send({type:'assistant',session_id:session,message:{model:'<synthetic>',content:[{type:'text',text:'Not logged in · Please run /login'}],usage:{input_tokens:0,output_tokens:0}}});
    send({type:'result',subtype:'success',is_error:true,session_id:session,result:'Not logged in · Please run /login',num_turns:1,usage:{input_tokens:0,output_tokens:0},total_cost_usd:0});
    setTimeout(() => process.exit(1), 20);
  } else if (message.type === 'user' && JSON.stringify(message).includes('model-report:')) {
    reportCase = [...JSON.stringify(message).matchAll(/model-report:([a-z]+)/g)].at(-1)[1]; // the newest, if history came along
    send({type:'system',subtype:'init',session_id:session,model:'fixture-claude',claude_code_version:'9.9.9',tools:[],mcp_servers:[],permissionMode:'default',apiKeySource:'none',cwd:process.cwd()});
  } else if (message.type === 'user' && !asked) {
    asked = true;
    const prompt = message.message.content;
    promptLength = typeof prompt === 'string' ? prompt.length : JSON.stringify(prompt).length;
    const file = JSON.stringify(prompt).match(/(\/[^"\\]*do-claude-history-[^"\\]*history.txt)/)?.[1];
    historyFile = file;
    doNote = JSON.stringify(prompt).includes('DO note, not from the user');
    historyReadable = file ? (await fs.readFile(file,'utf8')).includes('HISTORY-MARKER') : false;
    send({type:'system',subtype:'init',session_id:session,model:'fixture-claude',tools:['AskUserQuestion'],mcp_servers:[],permissionMode:'default',apiKeySource:'none',cwd:process.cwd()});
    const permission = JSON.stringify(message).includes('ask permission');
    send({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:permission ? 'Bash' : 'AskUserQuestion',tool_use_id:'question-1',...(permission ? {permission_suggestions:[{type:'addRules',rules:[{toolName:'Bash',ruleContent:'echo fixture'}],behavior:'allow',destination:'localSettings'}]} : {}),input:permission ? {command:'echo fixture'} : {questions:[{question:'Which behavior?',header:'Behavior',options:[{label:'Keep',description:'Preserve it'},{label:'Change',description:'Update it'}],multiSelect:false}]}}});
  } else if (message.type === 'control_response' && message.response.request_id === 'permission-1') {
    const answer = message.response.response;
    const text = JSON.stringify({answer, promptLength, historyReadable, historyFile, doNote, resumed:process.argv.some(a=>a.startsWith('--resume=')), effort:process.argv.find(a=>a.startsWith('--effort='))?.slice(9) || (process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort')+1] : null)});
    send({type:'stream_event',session_id:session,event:{type:'message_start'}});
    send({type:'stream_event',session_id:session,event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
    send({type:'assistant',session_id:session,message:{model:'fixture-claude',content:[{type:'text',text}],usage:{input_tokens:2,output_tokens:2}}});
    send({type:'result',subtype:'success',is_error:false,session_id:session,result:text,num_turns:1,usage:{input_tokens:2,output_tokens:2},total_cost_usd:0});
    process.exit(0);
  }
}
