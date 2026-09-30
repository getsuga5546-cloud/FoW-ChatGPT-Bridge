const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const s=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8'),ctx=vm.createContext({normalizeClubName:s=>s.toLowerCase()});
for(const n of ['pairPartnerFor','deriveKoSetup'])vm.runInContext(s.split('\n').find(l=>l.startsWith('function '+n+'(')),ctx);
const plan={clubs:[{club:'Failed',pairNo:1,status:'failed'},{club:'Partner',pairNo:1,status:'excluded'},{club:'A',pairNo:2,status:'success'},{club:'B',pairNo:2,status:'success'}]};
const d=ctx.deriveKoSetup(plan,{failed:new Set(),skipped:new Set()});assert.deepEqual([...d.failed],['failed']);assert.deepEqual([...d.released],['partner']);assert.equal(d.skipped.size,0);assert.deepEqual(Array.from(d.clubs,c=>c.club),['A','B']);
plan.clubs[1].status='failed';const both=ctx.deriveKoSetup(plan,{});assert.equal(both.failed.size,2);assert.equal(both.released.size,0);
console.log('PASS: saved failures inherited, opponents released, both-failed retained, successful clubs preserved');
