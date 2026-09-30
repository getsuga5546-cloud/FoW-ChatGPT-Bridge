'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8');
const previous={id:'EVOLD',type:'lightning',name:'Lightning',status:'stopped',startAt:1,endAt:2};
const timers=Object.freeze([{matchId:'HS150',operationalMode:'lightning'}]);
let saves=0;
const ctx=vm.createContext({eventStore:{active:{...previous},summaries:[]},autoExpireActiveEvent:()=>{},eventDurationDays:t=>t==='normal'?0:7,saveEventStoreNow:async()=>{saves++;},activeFowTimers:timers});
for(const name of ['getCurrentEventContext','getEventById','getEventTypeForPlan']){
 const line=source.split('\n').find(l=>l.startsWith('function '+name+'('));vm.runInContext(line,ctx);
}
const start=source.indexOf('async function startMasterEvent(');
vm.runInContext(source.slice(start,source.indexOf('\n}',start)+2),ctx);
(async()=>{
 const result=await ctx.startMasterEvent('normal','admin');
 assert.equal(result.ok,true);assert.equal(result.event.type,'normal');assert.equal(result.event.endAt,null);
 assert.equal(ctx.getEventTypeForPlan({eventId:'EVOLD'}),'lightning');
 assert.equal(ctx.getEventTypeForPlan({eventId:result.event.id}),'normal');
 assert.equal(ctx.getEventById('EVOLD').status,'stopped');assert.equal(ctx.getEventById('EVOLD').completedAt,undefined);
 assert.equal(ctx.activeFowTimers,timers);assert.equal(saves,1);
 const blocked=await ctx.startMasterEvent('grease','admin');assert.equal(blocked.ok,false);assert.equal(saves,1);
 assert.equal(ctx.eventStore.active.type,'normal');
 console.log('PASS: stopped Lightning → active Normal; old plan mode and timers preserved; active event cannot be overwritten');
})().catch(e=>{console.error(e);process.exitCode=1;});
