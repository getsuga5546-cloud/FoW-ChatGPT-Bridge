'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8'),ctx=vm.createContext({});
for(const name of ['isDerbyResultsOnlyThread','isExplicitDerbyResultMessage']){const start=source.indexOf('function '+name+'(');vm.runInContext(source.slice(start,source.indexOf('\n}',start)+2),ctx);}
assert.equal(ctx.isDerbyResultsOnlyThread({channel:{name:'High Set War Chat',isThread:()=>true}}),true);
for(const name of ['general','Mid Set War Chat'])assert.equal(ctx.isDerbyResultsOnlyThread({channel:{name,isThread:()=>true}}),false);
assert.equal(ctx.isDerbyResultsOnlyThread({channel:{name:'High Set War Chat',isThread:()=>false}}),false);
for(const text of ['5 successful babe 😘','HS154\n5 successful babe 😘','1, 2 successful','1-5 successful','HS154 1 successful','successful 1, 2','3 failed','4 skip','5 undo'])assert.equal(ctx.isExplicitDerbyResultMessage(text),true,text);
for(const text of ['You can talk here other than successful thing?','Well I guess so babe','@hs hello','We had 2 successful wars yesterday','HS154 successful','hello'])assert.equal(ctx.isExplicitDerbyResultMessage(text),false,text);
const start=source.indexOf('    if(isDerbyResultsOnlyThread(message))');
assert.ok(start<source.indexOf('      if(await handleDerbyChecklistMessage(message))return;',start));
assert.ok(start<source.indexOf('    const hsLiteralMention',start));
console.log('PASS: target thread only, explicit results allowed, conversation and mentions silent before AI routing');
