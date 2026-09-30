'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPrivateDryRun} = require('../hs-private-dry-run.cjs');
const GUILD = '1254157821214326845', INPUT = '1256056255890587648', OUTPUT = '1550513884585005076';
function fixture() {
  const sent = [], replies = [], calls = [];
  let clock = 1000000;
  const target = {id: OUTPUT, guildId: GUILD, send: async data => sent.push(data)};
  const client = {user: {id: 'bot'}, channels: {fetch: async id => {assert.equal(id, OUTPUT); return target;}}};
  const gate = createPrivateDryRun({
    now: () => clock,
    parseMatchmaking: text => {calls.push('parse'); return {min_elo: 5500, max_elo: 6500};},
    previewMatchmaking: intent => {calls.push('preview'); return {result: {pairs: [{a: {club:'A'}, b: {club:'B'}}]}, min: intent.min_elo, max: intent.max_elo};},
    formatPreview: (...args) => {assert.equal(args[4], null); return 'A vs B';},
    warStatus: () => {calls.push('status'); return 'WAR_ACTIVE: A';},
    referencedElo: async (item,text) => text === 'show ELO for those clubs' ? 'HS Live ELO — Read Only' : null,
    splitText: text => [text]
  });
  const msg = (content, extra={}) => ({guildId: GUILD, channelId: INPUT, author:{id:'owner'}, content, client, reply: async data => replies.push(data), ...extra});
  const interaction = (customId, extra={}) => ({guildId:GUILD,channelId:INPUT,user:{id:'owner'},client,customId,
    isAutocomplete:()=>false,isChatInputCommand:()=>false,
    deferReply:async()=>{}, editReply:async data=>replies.push(data),reply:async data=>replies.push(data),...extra});
  return {gate,msg,interaction,sent,replies,calls,target,advance:()=>{clock += 16*60*1000;}};
}
test('all four destinations publish only previews to the private output', async () => {
  const f=fixture();
  await f.gate.message(f.msg('create matchmaking 5500 to 6500'));
  const buttons=f.replies[0].components[0].components;
  assert.equal(buttons.length,4);
  for(const target of ['high','mid','low','additional']) {
    assert.equal(await f.gate.message(f.msg('send to '+target)),true);
    assert.match(f.sent.at(-1).content,new RegExp(target.toUpperCase()));
    assert.deepEqual(f.sent.at(-1).components,[]);
    assert.deepEqual(f.sent.at(-1).allowedMentions.parse,[]);
  }
  await f.gate.interaction(f.interaction(buttons[0].custom_id));
  assert.equal(f.sent.length,5);
  assert.deepEqual(f.calls,['parse','preview']);
});
test('war status text and slash command are read-only and diverted',async()=>{
  const f=fixture();
  await f.gate.message(f.msg('war status'));
  await f.gate.interaction(f.interaction('',{isChatInputCommand:()=>true,commandName:'war_status'}));
  assert.equal(f.sent.length,2);
  assert.deepEqual(f.calls,['status','status']);
});
test('all production text and old controls are consumed before production routing',async()=>{
  const f=fixture();
  for(const channelId of [INPUT,OUTPUT]) {
    for(const content of ['start war','update ELO A 6000','end event','create matchmaking 5500 to 6500 and start war']) {
      assert.equal(await f.gate.message(f.msg(content,{channelId})),true);
    }
    for(const id of ['hscr_confirm:old','hsv2_wdone_confirm:old','war_override_bulk_confirm:old','hsev_confirm:old']) {
      assert.equal(await f.gate.interaction(f.interaction(id,{channelId})),true);
    }
  }
  assert.deepEqual(f.calls,[]); assert.equal(f.sent.length,0);
});
test('shared server and unrelated channels retain existing routing',async()=>{
  const f=fixture();
  for(const extra of [{guildId:'shared'},{channelId:'production'}]) {
    assert.equal(await f.gate.message(f.msg('war status',extra)),false);
    assert.equal(await f.gate.interaction(f.interaction('hscr_confirm:old',extra)),false);
  }
  assert.equal(f.replies.length,0); assert.equal(f.sent.length,0);
});
test('preview ownership, channel, stale buttons and expiry are enforced',async()=>{
  const f=fixture(); await f.gate.message(f.msg('create matchmaking 5500 to 6500'));
  const id=f.replies[0].components[0].components[0].custom_id;
  await f.gate.interaction(f.interaction(id,{user:{id:'other'}}));
  await f.gate.interaction(f.interaction(id,{channelId:OUTPUT}));
  await f.gate.interaction(f.interaction(id,{guildId:'shared'}));
  await f.gate.message(f.msg('create matchmaking 5500 to 6500'));
  await f.gate.interaction(f.interaction(id));
  f.advance(); await f.gate.message(f.msg('send to high'));
  assert.equal(f.sent.length,0);
});
test('wrong output guild fails closed without fallback',async()=>{
  const f=fixture(); f.target.guildId='shared';
  assert.equal(await f.gate.message(f.msg('war status')),true);
  assert.equal(f.sent.length,0);
  assert.match(f.replies[0].content,/could not complete/);
});
test('ELO reference lookup still replies locally',async()=>{
  const f=fixture(); await f.gate.message(f.msg('show ELO for those clubs'));
  assert.match(f.replies[0].content,/HS Live ELO/); assert.equal(f.sent.length,0);
});
test('production routing has no private gate and retires old dry-run buttons',()=>{
  const fs=require('node:fs'); const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8');
  assert.ok(!source.includes('hsPrivateDryRun'));
  assert.ok(!source.includes("require('./hs-private-dry-run.cjs')"));
  assert.ok(source.includes('This dry-run preview has expired. Create a new production preview.'));
});

test('real preview and status helpers preserve frozen club, war and timer state',async()=>{
  const fs=require('node:fs'), vm=require('node:vm');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8');
  const names=['normalizeClubName','getSortedLeaderboard','getDerbyLeaderboard','getDerbyFilteredLeaderboard',
    'isDerbyClub','warOpKey','getWarOperation','isClubMatchmakingAvailable','getEloGroup','getForcedPairOutcome',
    'compareMatchmakingResults','emptyMatchmakingResult','optimizeMatchmakingExact','optimizeMatchmakingFallback',
    'optimizeMatchmaking','pairMustWinLoseFirst','dryRunMatchmakingFromIntent','formatMatchmakingOutput',
    'parseLocalMatchmakingInstruction','buildWarStatusDashboard','warEventLabel','splitDiscordText'];
  const helpers=names.map(name=>{
    const start=source.search(new RegExp(`^function ${name}\\(`,'m')); assert.ok(start>=0,name);
    const lineEnd=source.indexOf('\n',start);
    const end=source.slice(start,lineEnd).trimEnd().endsWith('}')?lineEnd:source.indexOf('\n}',start)+2;
    return source.slice(start,end);
  }).join('\n');
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  const state=freeze({leaderboardData:[{club:'A',elo:6000},{club:'B',elo:6050},{club:'C',elo:6060},{club:'D',elo:6090}],
    warOperations:{c:{club:'C',status:'WAR_ACTIVE',eventType:'lightning'}},
    activeFowTimers:[{clubs:[{club:'D'}],sent:{end:false}}]});
  const before=JSON.stringify(state);
  const ctx=vm.createContext({...state,MATCHMAKING_MAX_GAP:100,isDerbyExcludedName:()=>false});
  vm.runInContext('"use strict";\n'+helpers,ctx);
  const dry=ctx.dryRunMatchmakingFromIntent(ctx.parseLocalMatchmakingInstruction('create matchmaking 5500 to 6500'));
  assert.equal(dry.result.pairs.length,1);
  assert.equal(dry.available.length,2);
  assert.match(ctx.formatMatchmakingOutput(dry.result,dry.min,dry.max,[],null),/A \(6000\)/);
  assert.match(ctx.buildWarStatusDashboard(),/C/);
  assert.equal(JSON.stringify(state),before);
});
