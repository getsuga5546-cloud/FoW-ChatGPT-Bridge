'use strict';
const {mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = mkdtempSync(join(tmpdir(), 'fow-deploy-test-'));
try {
  for (const scenario of ['success', 'test-failure', 'restart-failure', 'unstable']) {
    const dir = join(root, scenario), candidate = join(dir, 'candidate'), bin = join(dir, 'bin');
    mkdirSync(candidate, {recursive:true}); mkdirSync(bin); mkdirSync(join(candidate,'tests'));
    mkdirSync(join(dir,'node_modules'));
    copyFileSync(resolve(__dirname,'../deploy-dev.sh'),join(dir,'deploy-dev.sh'));
    const files=['bot.js','hs-add-pair.cjs','match-war-end.cjs','package.json','package-lock.json'];
    writeFileSync(join(candidate,'deploy-files.txt'),files.join('\n')+'\n');
    for(const file of files) {
      writeFileSync(join(dir,file),file.endsWith('.json')?'{}':'old');
      writeFileSync(join(candidate,file),file.endsWith('.json')?'{}':'new');
    }
    const mock=(name,body)=>writeFileSync(join(bin,name),'#!/bin/bash\n'+body+'\n',{mode:0o755});
    mock('git', 'case "$1" in fetch) exit 0;; rev-parse) echo fixture;; archive) tar -cf - -C "$FIXTURE/candidate" .;; esac');
    mock('node','exit 0');
    mock('npm','[[ "$SCENARIO" != test-failure ]]');
    mock('sleep','exit 0');
    mock('pm2', `case "$1" in
 describe) exit 0;;
 restart) echo restart >> "$FIXTURE/restarts"; if [[ "$SCENARIO" == restart-failure && ! -f "$FIXTURE/failed" ]]; then touch "$FIXTURE/failed"; exit 1; fi;;
 pid) if [[ "$SCENARIO" == unstable && -f "$FIXTURE/pid-read" ]]; then echo 0; else touch "$FIXTURE/pid-read"; echo "$HEALTH_PID"; fi;;
 esac`);
    const result=spawnSync('bash',['deploy-dev.sh'],{cwd:dir,encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,FIXTURE:dir,SCENARIO:scenario,HEALTH_PID:String(process.pid)}});
    assert.equal(result.status===0,scenario==='success',result.stdout+result.stderr);
    for(const file of files.filter(f=>f.endsWith('.js')||f.endsWith('.cjs')))
      assert.equal(readFileSync(join(dir,file),'utf8'),scenario==='success'?'new':'old',scenario);
    if(scenario==='restart-failure'||scenario==='unstable')
      assert.equal(readFileSync(join(dir,'restarts'),'utf8').trim().split('\n').length,2,'Rollback must restart restored code');
    console.log('PASS deployment:',scenario);
  }
} finally { rmSync(root,{recursive:true,force:true}); }
