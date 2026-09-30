'use strict';
const assert=require('node:assert/strict');
const {createMatchWarEnd}=require('../match-war-end.cjs');
const {ActionRowBuilder}=require('discord.js');
async function run(mode){
 const plan={id:'HS1',guildId:'g',clubs:Array.from({length:30},(_,i)=>({club:`Club ${i}`,status:'pending'}))};
 const ops=new Map(plan.clubs.map(c=>[c.club,{matchId:'HS1',status:'WAR_ACTIVE'}]));
 let calls=0,last,selected;
 const handler=createMatchWarEnd({get:()=>plan,admin:i=>i.user.id==='admin',normalize:s=>s,operation:c=>ops.get(c),mode:()=>mode,timed:()=>false,finish:async(p,i,clubs)=>{calls++;selected=clubs;for(const c of clubs)ops.get(c.club).status='KO_ACTIVE';}});
 const make=(customId,extra={})=>({customId,user:{id:'admin'},guildId:'g',channelId:'mid',async reply(p){last=p;},async update(p){last=p;},async editReply(p){last=p;},async deferUpdate(){this.deferred=true;},...extra});
 await handler.interaction(make('mwend_open:HS1'));
 for(const row of last.components)new ActionRowBuilder(row).toJSON();
 assert.match(last.content,mode==='normal'?/14 hours/:/2 hours/);
 const sid=last.components[0].components[0].custom_id.split(':')[1];
 await handler.interaction(make(`mwend_select:${sid}`,{values:['Club 0','Club 1']}));
 await handler.interaction(make(`mwend_confirm:${sid}`,{user:{id:'other'}}));assert.equal(calls,0);
 await handler.interaction(make(`mwend_confirm:${sid}`,{guildId:'other'}));assert.equal(calls,0);
 await handler.interaction(make(`mwend_confirm:${sid}`));assert.equal(calls,1);assert.equal(selected.length,2);assert.equal(ops.get('Club 2').status,'WAR_ACTIVE');
 assert.ok(plan.clubs.every(c=>c.status==='pending'));
 await handler.interaction(make(`mwend_confirm:${sid}`));assert.equal(calls,1);
 await handler.interaction(make('mwend_open:HS1'));
 const next=last.components[0].components[0].custom_id.split(':')[1];
 await handler.interaction(make(`mwend_select:${next}`,{values:['Club 2']}));ops.get('Club 2').status='AVAILABLE';
 await handler.interaction(make(`mwend_confirm:${next}`));assert.equal(calls,1);assert.match(last.content,/state changed/);
}
(async()=>{await run('normal');await run('lightning');console.log('PASS: selective War End, event duration, valid Discord rows, authorization, stale state, duplicate click and unchanged results');})().catch(e=>{console.error(e);process.exitCode=1;});
