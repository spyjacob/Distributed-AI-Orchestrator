import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile('server/public/app.js', 'utf8');
const expressions = [...source.matchAll(/class="tag">\$\{esc\((.*?)\)\}/g)].map(match => match[1]);
const saved = expressions.find(value => value.includes('a.model'));
const live = expressions.find(value => value.includes('t.session'));
assert.ok(saved);
assert.ok(live);
const context = { state: { models: { 'source-123': { label: 'Astra' } } },
  a: { model: 'source-123', servedModel: 'gpt-test' }, t: { session: { model: 'source-123' } } };
assert.equal(vm.runInNewContext(saved, context), 'Astra');
assert.equal(vm.runInNewContext(live, context), 'Astra');
context.state.models = {};
assert.equal(vm.runInNewContext(saved, context), 'gpt-test');
assert.equal(vm.runInNewContext(live, context), 'source-123');
delete context.a.servedModel;
assert.equal(vm.runInNewContext(saved, context), 'source-123');
context.t = {};
assert.equal(vm.runInNewContext(live, context), '');
console.log('PASS chat labels use model names with safe fallbacks for removed sources and empty sessions');
