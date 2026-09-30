'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8');
const names=['sortHsMatchmakingPairs','formatMatchmakingOutput','formatManualPlanOutput','buildHsV2MatchDraftView'];
const ctx=vm.createContext({MATCHMAKING_MAX_GAP:100,buildHsV2DestinationButtons:()=>[],buildHsV2ConfirmButtons:()=>[]});
for(const name of names){const start=source.indexOf('function '+name+'(');assert.ok(start>=0);vm.runInContext(source.slice(start,source.indexOf('\n}',start)+2),ctx);}
const club=(club,elo)=>Object.freeze({club,elo,president:'P'});
const pairs=Object.freeze([
 Object.freeze({a:club('Magslingers',6550),b:club('Royal Abattoir',6460),gap:90}),
 Object.freeze({a:club('Iron Horn',6322),b:club('Neverland',6241),gap:81}),
 Object.freeze({a:club('Empress',6408),b:club('Flower Garden',6391),gap:17})
]);
const before=JSON.stringify(pairs);
assert.deepEqual(Array.from(ctx.sortHsMatchmakingPairs(pairs),p=>p.a.elo),[6550,6408,6322]);
const draft={id:'test',previewResult:{pairs,unmatched:[]},minElo:6241,maxElo:6550};
ctx.draft=draft;
// Execute the real confirmation pair-number assignment without saving or posting.
const start=source.indexOf('        sortHsMatchmakingPairs(draft.previewResult.pairs).forEach');
const end=source.indexOf('        const elos = clubs.map',start);
assert.ok(start>=0 && end>start);
const stored=vm.runInContext('(function(){const clubs=[];'+source.slice(start,end)+'return clubs;})()',ctx);
assert.deepEqual(Array.from(stored.filter(c=>c.matchRole==='win'),c=>[c.club,c.pairNo]),[['Magslingers',1],['Empress',2],['Iron Horn',3]]);
const texts=[ctx.buildHsV2MatchDraftView(draft).content,ctx.formatMatchmakingOutput({pairs,unmatched:[]},6241,6550,[],null),ctx.formatManualPlanOutput({id:'NEW',min:6241,max:6550,clubs:stored})];
for(const text of texts){assert.ok(text.indexOf('Magslingers')<text.indexOf('Empress'));assert.ok(text.indexOf('Empress')<text.indexOf('Iron Horn'));}
const a=club('Forced lower winner',6100),b=club('Higher loser',6190);
const forced={a:b,b:a,winner:a,loser:b,gap:90};
const regular={a:club('Regular',6150),b:club('Opponent',6140),gap:10};
assert.equal(ctx.sortHsMatchmakingPairs([forced,regular])[0],regular);
assert.equal(forced.winner,a);
assert.equal(JSON.stringify(pairs),before);
// Historical pair numbers stay authoritative, including statuses.
const old={id:'HS152',min:6241,max:6550,clubs:[{club:'Iron Horn',elo:6322,pairNo:2,matchRole:'win',status:'success'},{club:'Neverland',elo:6241,pairNo:2,matchRole:'lose',status:'success'},{club:'Empress',elo:6408,pairNo:3,matchRole:'win'},{club:'Flower Garden',elo:6391,pairNo:3,matchRole:'lose'}]};
const oldBefore=JSON.stringify(old);ctx.formatManualPlanOutput(old);assert.equal(JSON.stringify(old),oldBefore);
const oldText=ctx.formatManualPlanOutput(old);
assert.ok(oldText.indexOf('3. **Empress')<oldText.indexOf('2. **Iron Horn'));
// HS150 regression: optimizer blocks used to appear after the low-ELO pairs.
const ratings=[[5859,5775],[5838,5758],[5832,5732],[5717,5684],[5707,5609],[5317,5217],[5347,5254],[5300,5273],[5393,5294],[5456,5364],[5482,5391],[5561,5462],[5659,5569],[5631,5537],[5617,5525],[5612,5580]];
const hs150={id:'HS150',min:5217,max:5859,clubs:ratings.flatMap(([win,lose],i)=>[
 {club:`Winner ${i+1}`,elo:win,pairNo:i+1,matchRole:'win',status:'pending'},
 {club:`Loser ${i+1}`,elo:lose,pairNo:i+1,matchRole:'lose',status:'pending'}
])};
const snapshot=JSON.stringify(hs150);
const rendered=ctx.formatManualPlanOutput(hs150);
assert.deepEqual([...rendered.matchAll(/^(\d+)\. \*\*/gm)].map(m=>Number(m[1])),[1,2,3,4,5,13,14,15,16,12,11,10,9,7,6,8]);
assert.equal(JSON.stringify(hs150),snapshot);
console.log('PASS: HS preview, persisted pair numbers and output agree; forced roles and historical plans unchanged');
