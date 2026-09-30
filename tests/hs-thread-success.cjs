'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8');
const matchPlans=new Map();
const ctx=vm.createContext({CHATGPT_BRIDGE_MATCH_HIGH_CHANNEL_ID:"high",CHATGPT_BRIDGE_MATCH_MID_CHANNEL_ID:"mid",CHATGPT_BRIDGE_MATCH_LOW_CHANNEL_ID:"low",CHATGPT_BRIDGE_MATCH_ADDITIONAL_CHANNEL_ID:"additional",matchPlans,getMatchPlan:id=>matchPlans.get(id),normalizeMatchId:s=>s.replace(/\s/g,'').toUpperCase()});
for(const name of ['parseDerbyChecklistInstruction','resolveDerbyChecklistPlan']){
 const start=source.indexOf('function '+name+'(');
 vm.runInContext(source.slice(start,source.indexOf('\n}',start)+2),ctx);
}
const add=(id,channelId,createdAt,extra={})=>{const p={id,channelId,guildId:'guild',createdAt,...extra};matchPlans.set(id,p);return p;};
const old=add('HS149','mid',1,{updatedAt:9999});
const mid=add('HS150','mid',2);
add('HS151','high',3,{updatedAt:99999});
add('HS152','mid',4,{guildId:'other'});
const message={guildId:'guild',channelId:'mid'};
assert.equal(ctx.resolveDerbyChecklistPlan(message,{}),mid);
assert.equal(ctx.resolveDerbyChecklistPlan({...message,channelId:'empty'},{}),null);
assert.equal(ctx.resolveDerbyChecklistPlan(message,{matchId:'HS149'}),old);
assert.equal(ctx.resolveDerbyChecklistPlan(message,{pairNos:[999]}),mid);
const controls=add('HS153','source',5,{matchControlsChannelId:'mid'});
assert.equal(ctx.resolveDerbyChecklistPlan(message,{}),controls);
for(const input of ['HS150 1, 2 successful','1, 2 successful HS150','HS150 successful 1, 2']){
 const intent=ctx.parseDerbyChecklistInstruction(input);
 assert.equal(intent.matchId,'HS150');assert.deepEqual(Array.from(intent.pairNos),[1,2]);
}
assert.deepEqual(Array.from(ctx.parseDerbyChecklistInstruction('1-3 successful').pairNos),[1,2,3]);
assert.equal(ctx.parseDerbyChecklistInstruction('HS150 successful'),null);
console.log('PASS: thread isolation, creation order, explicit IDs, control destination and pair-number parsing');

const highOld=add('HS149','high-chat',10);
const highNew=add('HS154','high',20);
add('HS155','mid',30);
const thread={guildId:'guild',channelId:'high-chat',channel:{name:'High Set War Chat',parentId:'high',isThread:()=>true}};
assert.equal(ctx.resolveDerbyChecklistPlan(thread,{pairNos:[5]}),highNew);
assert.equal(ctx.resolveDerbyChecklistPlan({...thread,channel:{...thread.channel,name:'Unrelated'}},{}),highOld);
assert.equal(ctx.resolveDerbyChecklistPlan({...thread,channel:{...thread.channel,parentId:'unconfigured'}},{}),highOld);
console.log('PASS: HS154 in High parent wins over HS149 in High chat, never newer Mid');
