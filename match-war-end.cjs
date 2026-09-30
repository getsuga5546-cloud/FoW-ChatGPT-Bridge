'use strict';
const {randomUUID}=require('node:crypto');
function createMatchWarEnd(deps){
 const sessions=new Map();
 const safe=(content,components=[])=>({content,components,allowedMentions:{parse:[]}});
 const button=(id,label,style=2,disabled=false)=>({type:2,custom_id:id,label,style,disabled});
 function eligible(plan){return (plan.clubs||[]).filter(c=>{
  const op=deps.operation(c.club);
  return op&&String(op.matchId)===String(plan.id)&&String(op.status).toUpperCase()==='WAR_ACTIVE'&&!deps.timed(c.club);
 });}
 function check(i,id){
  if(!deps.admin(i))throw Error('Only a war administrator can end wars.');
  const p=deps.get(id);
  if(!p||String(p.guildId)!==String(i.guildId)||!i.guildId)throw Error('Match ID not found in this server.');
  if(['CANCELLED','CLOSED'].includes(String(p.status).toUpperCase()))throw Error('Match ID is closed or cancelled.');
  return p;
 }
 function view(s){
  const pages=Math.max(1,Math.ceil(s.items.length/25));s.page=Math.min(Math.max(s.page,0),pages-1);
  const page=s.items.slice(s.page*25,s.page*25+25);
  const rows=[{type:1,components:[{type:3,custom_id:`mwend_select:${s.id}`,placeholder:'Select clubs whose wars have ended',min_values:0,max_values:page.length,options:page.map(c=>({label:c.club.slice(0,100),value:deps.normalize(c.club),default:s.selected.has(deps.normalize(c.club))}))}]},
   {type:1,components:[button(`mwend_prev:${s.id}`,'Previous',2,s.page===0),button(`mwend_next:${s.id}`,'Next',2,s.page===pages-1),button(`mwend_all:${s.id}`,'SELECT ALL'),button(`mwend_clear:${s.id}`,'CLEAR')]},
   {type:1,components:[button(`mwend_confirm:${s.id}`,`END WAR — ${s.selected.size} CLUBS`,3,!s.selected.size),button(`mwend_cancel:${s.id}`,'CANCEL')]}];
  return safe(`🏁 **WAR END — ${s.matchId}**\n\nSelect only clubs whose wars have ended.\nSelected: **${s.selected.size}/${s.items.length}** • Page ${s.page+1}/${pages}\nAfter confirmation: **${s.hours} hours ${s.hours===2?'KO':'KO + cooling'}**.\nUnselected clubs remain in war. Match results stay unchanged.`,rows);
 }
 async function interaction(i){
  if(!String(i.customId||'').startsWith('mwend_'))return false;
  try{
   for(const[id,s]of sessions)if(Date.now()-s.createdAt>900000)sessions.delete(id);
   const [action,id]=i.customId.split(':');
   if(action==='mwend_open'){
    const plan=check(i,id),items=eligible(plan);
    if(!items.length)throw Error('No WAR ACTIVE clubs without an isolation timer remain in this match.');
    const mode=deps.mode(plan),s={id:randomUUID(),matchId:plan.id,userId:i.user.id,guildId:i.guildId,channelId:i.channelId,items,selected:new Set(),page:0,mode,hours:['lightning','grease'].includes(mode)?2:14,createdAt:Date.now()};
    sessions.set(s.id,s);await i.reply({...view(s),flags:64});return true;
   }
   const s=sessions.get(id);
   if(!s||s.userId!==i.user.id||s.guildId!==i.guildId||s.channelId!==i.channelId)throw Error('War End selection expired. Reopen Match Controls.');
   const plan=check(i,s.matchId);
   if(action==='mwend_cancel'){sessions.delete(id);await i.update(safe('War End cancelled.'));return true;}
   if(action==='mwend_select'){
    const keys=new Set(s.items.slice(s.page*25,s.page*25+25).map(c=>deps.normalize(c.club)));
    for(const key of keys)s.selected.delete(key);
    for(const key of i.values||[])if(keys.has(key))s.selected.add(key);
   }else if(action==='mwend_prev')s.page--;
   else if(action==='mwend_next')s.page++;
   else if(action==='mwend_all')s.selected=new Set(s.items.map(c=>deps.normalize(c.club)));
   else if(action==='mwend_clear')s.selected.clear();
   else if(action==='mwend_confirm'){
    if(!s.selected.size)throw Error('Select at least one club.');
    const current=eligible(plan),chosen=current.filter(c=>s.selected.has(deps.normalize(c.club)));
    if(chosen.length!==s.selected.size||deps.mode(plan)!==s.mode)throw Error('War state changed. Reopen War End and select again.');
    // Consume before awaiting so duplicate clicks cannot start a second timer.
    sessions.delete(id);await i.deferUpdate();
    // Recheck after acknowledgement, before any mutation.
    check(i,s.matchId);
    if(eligible(plan).filter(c=>s.selected.has(deps.normalize(c.club))).length!==chosen.length)throw Error('War state changed. Reopen War End.');
    await deps.finish(plan,i,chosen);
    await i.editReply(safe(`✅ **WAR ENDED — ${plan.id}**\n\n${chosen.length} clubs entered **${s.hours} hours ${s.hours===2?'KO':'KO + cooling'}**.\nOther clubs and match results are unchanged.`));return true;
   }
   await i.update(view(s));
  }catch(e){const payload=safe(`❌ ${e.message}`);if(i.deferred||i.replied)await i.editReply(payload);else await i.reply({...payload,flags:64});}
  return true;
 }
 return {interaction,eligible};
}
module.exports={createMatchWarEnd};
