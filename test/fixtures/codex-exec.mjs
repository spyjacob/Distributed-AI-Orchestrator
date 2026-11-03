#!/usr/bin/env node
// Deterministic `codex exec --json` peer. Like the real CLI, its stream names no
// model or effort; it records both in a rollout file under CODEX_HOME.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

if (!process.env.CODEX_HOME) throw Error('This fixture only writes under an explicit CODEX_HOME.');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const flag = name => process.argv[process.argv.indexOf(name) + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const thread = crypto.randomUUID();
send({type:'thread.started',thread_id:thread});
send({type:'turn.started'});
if (!prompt.includes('codex-silent')) {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const dir = path.join(process.env.CODEX_HOME,'sessions',String(now.getFullYear()),pad(now.getMonth()+1),pad(now.getDate()));
  await fs.mkdir(dir,{recursive:true});
  const asked = process.argv.join(' ').match(/model_reasoning_effort="([^"]+)"/)?.[1] ?? null;
  const lines = [
    {type:'session_meta',payload:{id:thread}},
    {type:'response_item',payload:{type:'message',text:'quotes "turn_context" without being one'}},
    {type:'turn_context',payload:{turn_id:'fixture-turn',model:flag('--model'),effort:prompt.includes('codex-capped') ? 'medium' : asked}},
  ];
  await fs.writeFile(path.join(dir,`rollout-fixture-${thread}.jsonl`),lines.map(l=>JSON.stringify(l)).join('\n') + '\n');
}
send({type:'item.completed',item:{id:'item_0',type:'agent_message',text:'codex fixture reply'}});
send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});
