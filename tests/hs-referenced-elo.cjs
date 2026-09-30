const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../bot.js'), 'utf8');
// Execute only pure helpers, never bot startup, credentials, or database clients.
const names = ['normalizeClubName', 'resolveHsClubsByClubOrPresident',
  'extractHsClubsFromText', 'areEquivalentClubNames', 'prepareHsReferencedEloLookup'];
const helpers = names.map(name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0);
  const end = source.indexOf('\n}', start) + 2;
  return source.slice(start, end);
}).join('\n');
const clubs = Object.freeze([
  Object.freeze({ club: 'Force Of War', elo: 6000 }),
  Object.freeze({ club: 'Force Of War II', elo: 6100 }),
  Object.freeze({ club: 'FoW Neverland', elo: 6200 })
]);
const context = vm.createContext({ leaderboardData: clubs });
vm.runInContext(helpers, context);
const lookup = context.prepareHsReferencedEloLookup;
const request = 'show ELO for those clubs';
const message = fetchReference => ({ channelId: 'test', reference: { messageId: 'ref' }, fetchReference });
(async () => {
  const before = JSON.stringify(clubs);
  const result = await lookup(message(async () => ({ channelId: 'test',
    content: '1. Force Of War II (9999) - Someone\n2. FoW Neverland (9999) - Someone' })), request);
  assert.match(result, /Force Of War II \(6100\)/);
  assert.match(result, /FoW Neverland \(6200\)/);
  assert.doesNotMatch(result, /Force Of War \(6000\)|9999|clarification/);
  for (const fetch of [async () => { throw Error('Unknown Message'); },
    async () => null, async () => ({ channelId: 'other', content: 'FoW Neverland' }),
    async () => ({ channelId: 'test', content: 'No known clubs' })]) {
    assert.match(await lookup(message(fetch), request), /HS needs clarification/);
  }
  const neverFetch = message(() => { throw Error('Must not fetch'); });
  for (const text of ['do something with those clubs', 'update ELO for those clubs',
    'show ELO for those clubs and start war', 'war status']) {
    assert.equal(await lookup(neverFetch, text), null);
  }
  assert.equal(await lookup({ channelId: 'test' }, request), null);
  assert.equal(JSON.stringify(clubs), before);
  assert.ok(source.indexOf('await prepareHsReferencedEloLookup(message, cleaned)') < source.indexOf('// HS V2 TEST HOOK'));
  console.log('PASS: referenced clubs, live ELO, missing/inaccessible references, routing scope, immutable data');
})().catch(error => { console.error(error); process.exitCode = 1; });
