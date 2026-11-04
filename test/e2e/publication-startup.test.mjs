import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {prepareTab, integrateTab, readPublication} from '../../src/core/tab-workspaces.js';
import {startupUpdate} from '../../scripts/startup-update.mjs';
import {verifyDependencies} from '../../scripts/dependency-state.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'do-publication-'));
const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  const repo=path.join(root,'project'), remote=path.join(root,'remote.git');
  await fs.mkdir(repo);
  git(root,'init','--bare',remote);git(repo,'init','-b','main');
  await fs.writeFile(path.join(repo,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
  await fs.writeFile(path.join(repo,'file.txt'),'initial');git(repo,'add','.');git(repo,'commit','-m','initial');
  git(repo,'remote','add','origin',remote);git(repo,'push','-u','origin','main');
  const session={id:'fixture',projectDir:repo};session.tabWorkspace=await prepareTab(session);
  await fs.writeFile(path.join(session.tabWorkspace.dir,'file.txt'),'published content');
  const result=await integrateTab(session,{push:true,beforePublish:async()=>{
    // User changes the primary checkout after validation, before remote acknowledgement.
    await fs.writeFile(path.join(repo,'file.txt'),'user work must survive');
  }});
  assert.equal(result.pushed,true);assert.equal(result.integrated,false);assert.match(result.warning,/Published/);
  assert.equal(await fs.readFile(path.join(repo,'file.txt'),'utf8'),'user work must survive');
  assert.equal(git(root,'--git-dir='+remote,'rev-parse','main').slice(0,8),result.sha);
  const receipt=await readPublication(session);assert.equal(receipt.state,'published');assert.equal(receipt.localCheckout,'pending');
  // New process reads the receipt too; not just the caller's in-memory result.
  const fresh=execFileSync(process.execPath,['--input-type=module','-e',`import {readPublication} from ${JSON.stringify(new URL('../../src/core/tab-workspaces.js',import.meta.url).href)}; console.log(JSON.stringify(await readPublication(${JSON.stringify(session)})));`],{encoding:'utf8'});
  assert.equal(JSON.parse(fresh).candidate,receipt.candidate);

  const boot=path.join(root,'boot');git(root,'clone','--branch','main',remote,boot);
  git(boot,'remote','set-url','origin',path.join(root,'absent.git'));
  assert.equal(await startupUpdate(boot),git(boot,'rev-parse','HEAD'),'offline published clean checkout boots');
  await fs.writeFile(path.join(boot,'uncommitted.txt'),'keep');
  await assert.rejects(startupUpdate(boot),/Local changes/);
  assert.equal(await fs.readFile(path.join(boot,'uncommitted.txt'),'utf8'),'keep');

  // Exercise the real desktop launcher in an isolated source distribution.
  const launcher=path.join(root,'launcher');
  for(const dir of ['scripts','src/core','server','node_modules/cross-spawn','.launcher']) await fs.mkdir(path.join(launcher,dir),{recursive:true});
  for(const file of ['scripts/start.mjs','scripts/node-config.mjs','scripts/startup-update.mjs','scripts/stop-server.mjs','scripts/dependency-state.mjs','src/core/platform.js']) await fs.copyFile(file,path.join(launcher,file));
  const lock='{"lockfileVersion":3}';await fs.writeFile(path.join(launcher,'package-lock.json'),lock);
  await fs.writeFile(path.join(launcher,'package.json'),'{"type":"module"}');
  await fs.writeFile(path.join(launcher,'node_modules/cross-spawn/package.json'),'{}');
  await fs.writeFile(path.join(launcher,'.launcher/dependencies.sha256'),crypto.createHash('sha256').update(lock).digest('hex'));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  await fs.writeFile(path.join(launcher,'.orchestrator-node.env'),`HARNESS_PORT=${port}\nHARNESS_TOKEN=synthetic-preserved\nHARNESS_DATA_DIR=${JSON.stringify(path.join(root,'launcher-data'))}\n`);
  await fs.writeFile(path.join(launcher,'server/boot.js'),"import fs from 'node:fs'; fs.writeFileSync('observed.json', JSON.stringify({token:process.env.HARNESS_TOKEN,port:process.env.HARNESS_PORT})); process.exit(7);");
  const env={...process.env};delete env.HARNESS_TOKEN;delete env.HARNESS_PORT;
  const child=spawn(process.execPath,['scripts/start.mjs','--no-browser'],{cwd:launcher,env,stdio:'ignore'});
  const [code]=await once(child,'exit');assert.equal(code,7);
  assert.equal(JSON.parse(await fs.readFile(path.join(launcher,'observed.json'),'utf8')).token,'synthetic-preserved');
  await verifyDependencies(launcher);
  await fs.writeFile(path.join(launcher,'package-lock.json'),lock+' ');
  await assert.rejects(verifyDependencies(launcher),/current server will keep running/);
  console.log('PASS published/local-failed receipt survives process exit; offline boot integrity; launcher preserves auth; dependency-changing restart refuses safely');
} finally {await fs.rm(root,{recursive:true,force:true});}
