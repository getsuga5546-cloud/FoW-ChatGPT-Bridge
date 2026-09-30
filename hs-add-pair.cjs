'use strict';
const {randomUUID} = require('node:crypto');
const PREFIX = 'hsadd';
const TTL = 15 * 60 * 1000;
const safe = (content, components=[]) => ({content, components, allowedMentions:{parse:[], repliedUser:false}});
const button = id => ({type:2,style:2,custom_id:`${PREFIX}_open:${id}`,label:'EDIT / ADD PAIR'});

function checkPlan(plan, guildId, available, hasTimer) {
  if (!plan) throw Error('Match ID not found.');
  if (String(plan.guildId || '') !== String(guildId || '') || !guildId) throw Error('Match ID belongs to another server.');
  if (!['','PENDING','DRAFT'].includes(String(plan.status || '').toUpperCase()) ||
      plan.preparationStartedAt || plan.preparationCompletedAt || plan.warStartedWithoutPreparationAt ||
      plan.lifecycleTrackingStartedAt || plan.koStartedAt || plan.closedAt || plan.cancelledAt ||
      hasTimer(plan.id) || (plan.clubs || []).some(c => !available(c.club) || String(c.status || 'pending').toLowerCase() !== 'pending')) {
    throw Error('Add pair is allowed only before preparation/war starts and before results are recorded.');
  }
}

function proposePair(plan, names, deps, guildId) {
  checkPlan(plan,guildId,deps.available,deps.hasTimer);
  const chosen=names.map(name=>{
    const found=deps.resolve(name);
    if (found.length !== 1) throw Error(`Club must resolve uniquely: ${name}`);
    const club=found[0];
    if (!deps.derby(club)) throw Error(`${club.club} is not in Derby.`);
    if (!deps.available(club.club)) throw Error(`${club.club} is isolated or unavailable.`);
    if ((plan.clubs || []).some(c=>deps.normalize(c.club)===deps.normalize(club.club))) throw Error(`${club.club} is already in this Match ID.`);
    if (!Number.isFinite(Number(club.elo))) throw Error('Club ELO is invalid.');
    return club;
  });
  if (chosen.length !== 2 || deps.normalize(chosen[0].club)===deps.normalize(chosen[1].club)) throw Error('Choose two different clubs.');
  const gap=Math.abs(Number(chosen[0].elo)-Number(chosen[1].elo));
  if (gap > deps.maxGap) throw Error(`Gap ${gap} exceeds ${deps.maxGap}.`);
  const existing=new Map();
  for (const c of plan.clubs || []) {
    if (!Number.isInteger(Number(c.pairNo)) || Number(c.pairNo)<=0) throw Error('Existing pair numbers are invalid.');
    existing.set(Number(c.pairNo),(existing.get(Number(c.pairNo)) || 0)+1);
  }
  if ([...existing.values()].some(count=>count!==2)) throw Error('Existing plan contains an incomplete pair.');
  const pairNo=Math.max(0,...existing.keys())+1;
  const ordered=[...chosen].sort((a,b)=>Number(b.elo)-Number(a.elo));
  const added=ordered.map((c,i)=>({club:c.club,president:c.president || '',elo:Number(c.elo),pairNo,
    matchRole:i===0?'win':'lose',status:'pending',failedAt:null,failedBy:null}));
  const clubs=[...(plan.clubs || []).map(c=>({...c})),...added];
  return {added,gap,plan:{...plan,clubs,pairCount:existing.size+1,min:Math.min(...clubs.map(c=>Number(c.elo))),max:Math.max(...clubs.map(c=>Number(c.elo)))}};
}

function createAddPair(deps) {
  const drafts=new Map();
  function cleanup(){for(const [id,draft] of drafts)if(Date.now()-draft.createdAt>TTL)drafts.delete(id);}
  function authorized(i){if(!deps.admin(i))throw Error('Only a war administrator can add pairs.');}
  async function interaction(i) {
    if (!String(i.customId || '').startsWith(PREFIX+'_')) return false;
    try {
      authorized(i); cleanup();
      const [action,id]=String(i.customId).split(':');
      if (action===PREFIX+'_open') {
        const plan=deps.get(id);checkPlan(plan,i.guildId,deps.available,deps.hasTimer);
        await i.showModal({custom_id:`${PREFIX}_submit:${id}`,title:`Add pair — ${id}`,
          components:['Club 1','Club 2'].map((label,index)=>({type:1,components:[{type:4,custom_id:`club${index+1}`,label,style:1,required:true,max_length:150}]}))});
        return true;
      }
      if (action===PREFIX+'_submit') {
        await i.deferReply({flags:64});
        const plan=deps.get(id);
        const names=[i.fields.getTextInputValue('club1'),i.fields.getTextInputValue('club2')];
        const proposed=proposePair(plan,names,deps,i.guildId);
        const draftId=randomUUID();
        drafts.set(draftId,{matchId:id,names:proposed.added.map(c=>c.club),base:JSON.stringify(plan),
          added:JSON.stringify(proposed.added),userId:String(i.user.id),guildId:String(i.guildId),channelId:String(i.channelId),createdAt:Date.now()});
        const [a,b]=proposed.added;
        await i.editReply(safe(`✏️ **ADD PAIR — PREVIEW**\nMatch ID: **${id}**\nNew pair: **#${a.pairNo}**\n\n**${a.club} (${a.elo})**\nvs ${b.club} (${b.elo})\nGap: **${proposed.gap}**\n\nELO range after edit: **${proposed.plan.min} - ${proposed.plan.max}**\nExisting pair numbers stay unchanged. No changes saved yet.`,[{type:1,components:[
          {type:2,style:3,custom_id:`${PREFIX}_confirm:${draftId}`,label:'CONFIRM ADD PAIR'},
          {type:2,style:2,custom_id:`${PREFIX}_cancel:${draftId}`,label:'CANCEL'}]}]));
        return true;
      }
      const draft=drafts.get(id);
      if (!draft || draft.userId!==String(i.user.id) || draft.guildId!==String(i.guildId) || draft.channelId!==String(i.channelId)) throw Error('Preview expired or belongs to another user/channel.');
      if (action===PREFIX+'_cancel') {drafts.delete(id);await i.update(safe('Add pair cancelled. Match ID unchanged.'));return true;}
      if (action!==PREFIX+'_confirm') throw Error('Unknown add-pair action.');
      await i.deferUpdate();
      const plan=deps.get(draft.matchId);
      if (JSON.stringify(plan)!==draft.base) throw Error('Match ID changed after preview. Create a fresh preview.');
      const proposed=proposePair(plan,draft.names,deps,i.guildId);
      if(JSON.stringify(proposed.added)!==draft.added)throw Error('Club details changed after preview. Create a fresh preview.');
      if(deps.canSave && !deps.canSave())throw Error('Database is unavailable. No pair was added.');
      drafts.delete(id); // Consume before the first save/publish await; double clicks cannot append twice.
      const next={...proposed.plan,updatedAt:Date.now(),updatedBy:String(i.user.id)};
      deps.set(next); // Match ID only: no timer, war, isolation, or ELO mutations.
      try {await deps.save(next);} catch(error) {
        await i.editReply(safe(`⚠️ **${next.id}** was updated in memory but persistence could not be confirmed. Do not retry until its state is checked.`));
        return true;
      }
      let published=true;
      try {await deps.publish(next);} catch(error) {published=false;console.error('Add-pair publish failed:',error.message);}
      await i.editReply(safe(`✅ **PAIR ADDED — ${next.id}**\nPair #${proposed.added[0].pairNo} saved. Total pairs: **${next.pairCount}**.\n${published?'Matchmaking display updated.':'Display could not be updated; the pair is already saved. Do not add it again.'}\nNo preparation, war or timer was started.`));
    } catch(error) {
      const reply=safe(`❌ ${error.message}`);
      if(i.deferred || i.replied)await i.editReply(reply).catch(()=>{});
      else await i.reply({...reply,flags:64}).catch(()=>{});
    }
    return true;
  }
  return {interaction};
}
module.exports={createAddPair,proposePair,checkPlan,button};
