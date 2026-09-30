'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAddPair,proposePair,checkPlan,button}=require('../hs-add-pair.cjs');
const {ActionRowBuilder,ButtonBuilder,ModalBuilder}=require('discord.js');
function fixture(){
 let plan={id:'HS152',guildId:'g',channelId:'c',pairCount:1,min:6200,max:6250,updatedAt:1,clubs:[{club:'Old A',elo:6250,pairNo:1,matchRole:'win',status:'pending'},{club:'Old B',elo:6200,pairNo:1,matchRole:'lose',status:'pending'}]};
 const db=[{club:'New A',elo:6350,president:'P1'},{club:'New B',elo:6300,president:'P2'}];
 const replies=[];let saves=0,publishes=0;const blocked=new Set();let timer=false;
 const deps={get:()=>plan,set:p=>{plan=p;},save:async()=>{saves++;},publish:async()=>{publishes++;},admin:i=>i.user.id==='admin',normalize:s=>s.toLowerCase(),resolve:n=>db.filter(c=>c.club===n),derby:()=>true,available:n=>!blocked.has(n),hasTimer:()=>timer,maxGap:100,canSave:()=>true};
 const handler=createAddPair(deps);
 const i=(customId,extra={})=>({customId,guildId:'g',channelId:'c',user:{id:'admin'},fields:{getTextInputValue:n=>n==='club1'?'New A':'New B'},
   async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async reply(p){replies.push(p);},async editReply(p){replies.push(p);},async update(p){replies.push(p);},async showModal(p){new ModalBuilder(p).toJSON();replies.push(p);},...extra});
 const preview=async()=>{await handler.interaction(i('hsadd_submit:HS152'));return replies.at(-1).components[0].components[0].custom_id;};
 return {deps,handler,i,preview,replies,db,blocked,get plan(){return plan;},get saves(){return saves;},get publishes(){return publishes;},timer:()=>{timer=true;}};
}
test('modal, preview, confirmed append and double click',async()=>{
 const f=fixture();const before=JSON.stringify(f.plan);await f.handler.interaction(f.i('hsadd_open:HS152'));
 const id=await f.preview();assert.equal(JSON.stringify(f.plan),before);assert.equal(f.saves,0);
 await f.handler.interaction(f.i(id));assert.equal(f.saves,1);assert.equal(f.publishes,1);assert.equal(f.plan.pairCount,2);
 assert.equal(f.plan.clubs[2].pairNo,2);assert.equal(f.plan.max,6350);assert.equal(f.plan.min,6200);
 assert.deepEqual(f.plan.clubs.slice(0,2),JSON.parse(before).clubs);
 await f.handler.interaction(f.i(id));assert.equal(f.saves,1);
 new ActionRowBuilder().addComponents(new ButtonBuilder(button('HS152'))).toJSON();
});
test('duplicate, unknown, self-pair, non-Derby, unavailable and gap rejected',()=>{
 const f=fixture();
 for(const names of [['New A','New A'],['Unknown','New B']])assert.throws(()=>proposePair(f.plan,names,f.deps,'g'));
 f.db.push({club:'Old A',elo:6250});assert.throws(()=>proposePair(f.plan,['Old A','New B'],f.deps,'g'),/already/);
 f.db[0].elo=6500;assert.throws(()=>proposePair(f.plan,['New A','New B'],f.deps,'g'),/Gap/);f.db[0].elo=6350;
 f.blocked.add('New A');assert.throws(()=>proposePair(f.plan,['New A','New B'],f.deps,'g'),/unavailable/);f.blocked.clear();
 assert.throws(()=>proposePair(f.plan,['New A','New B'],{...f.deps,derby:()=>false},'g'),/Derby/);
});
test('active or completed plans and cross-server requests cannot change',()=>{
 const f=fixture();for(const extra of [{status:'CLOSED'},{status:'CANCELLED'},{preparationStartedAt:1},{preparationCompletedAt:1},{warStartedWithoutPreparationAt:1},{lifecycleTrackingStartedAt:1}])assert.throws(()=>checkPlan({...f.plan,...extra},'g',f.deps.available,f.deps.hasTimer));
 assert.throws(()=>checkPlan(f.plan,'other',f.deps.available,f.deps.hasTimer));f.timer();assert.throws(()=>checkPlan(f.plan,'g',f.deps.available,f.deps.hasTimer));
});
test('confirm rechecks permission, channel, changed plan, ELO and isolation',async()=>{
 for(const change of [f=>{f.plan.updatedAt++;},f=>{f.db[0].elo++;},f=>{f.blocked.add('New A');},f=>{f.blocked.add('Old A');},f=>{f.timer();}]){
 const f=fixture(),id=await f.preview();change(f);await f.handler.interaction(f.i(id));assert.equal(f.saves,0);}
 for(const extra of [{user:{id:'other'}},{guildId:'other'},{channelId:'other'}]){const f=fixture(),id=await f.preview();await f.handler.interaction(f.i(id,extra));assert.equal(f.saves,0);}
});
test('cancel, offline and save failure never report successful persistence',async()=>{
 const f=fixture(),id=await f.preview();await f.handler.interaction(f.i(id.replace('_confirm:','_cancel:')));assert.equal(f.saves,0);
 const offline=fixture(),oid=await offline.preview();offline.deps.canSave=()=>false;await offline.handler.interaction(offline.i(oid));assert.equal(offline.plan.pairCount,1);
 const broken=fixture(),bid=await broken.preview();broken.deps.save=async()=>{throw Error('offline');};await broken.handler.interaction(broken.i(bid));assert.match(broken.replies.at(-1).content,/persistence could not be confirmed/);assert.equal(broken.publishes,0);
});
test('unrelated controls fall through and disabled plans retain control row limit',async()=>{
 const f=fixture();assert.equal(await f.handler.interaction(f.i('war_done:1')),false);
 const fs=require('node:fs'),vm=require('node:vm');const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8');
 const start=source.indexOf('function buildMatchPlanKoButton(id){'),end=source.indexOf('\n}',start)+2;
 for(const mode of ['normal','lightning','grease']){const ctx=vm.createContext({getMatchPlan:()=>f.plan,getEventTypeForPlan:()=>mode,eventPreparationHours:()=>mode==='grease'?0:6,isClubMatchmakingAvailable:()=>true,hasActiveTimerForMatch:()=>false,hsAddPairModule:require('../hs-add-pair.cjs'),ActionRowBuilder,ButtonBuilder,ButtonStyle:require('discord.js').ButtonStyle});vm.runInContext(source.slice(start,end),ctx);assert.ok(ctx.buildMatchPlanKoButton('HS152').toJSON().components.length<=5);}
});
