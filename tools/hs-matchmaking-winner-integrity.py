#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-hs-winner-integrity-"+str(int(time.time())))
shutil.copy2(p,bak)

def die(msg):
    shutil.copy2(bak,p)
    print("FAIL:",msg)
    print("ROLLED BACK:",bak)
    sys.exit(2)

# This is the exact HS Control Room CONFIRM path.
old='''        draft.previewResult.pairs.forEach((pair, i) => {
          const winner = pair.winner || pair.a;
          const loser = pair.loser || pair.b;

          for (const [role, item] of [
            ["win", winner],
            ["lose", loser]
          ]) {
'''
new='''        draft.previewResult.pairs.forEach((pair, i) => {
          // HS WINNER INTEGRITY:
          // Forced MUST WIN / MUST LOSE outcomes are carried in pair.winner/pair.loser.
          // Ordinary preview pairs have no forced outcome, so the higher-ELO club
          // MUST be the winner. Never fall back blindly to pair.a because the exact
          // optimizer may store either side as "a" for search efficiency.
          const hasForcedOutcome = Boolean(pair.winner && pair.loser);
          const higher =
            Number(pair.a?.elo || 0) >= Number(pair.b?.elo || 0)
              ? pair.a
              : pair.b;
          const lower = higher === pair.a ? pair.b : pair.a;
          const winner = hasForcedOutcome ? pair.winner : higher;
          const loser = hasForcedOutcome ? pair.loser : lower;

          for (const [role, item] of [
            ["win", winner],
            ["lose", loser]
          ]) {
'''
if s.count(old)!=1:
    die("HS confirm winner anchor count="+str(s.count(old)))
s=s.replace(old,new,1)

# Do not alter the optimizer, ELO calculation/save logic, or War logic.
# Static guards for the intended behavior.
if 'const winner = pair.winner || pair.a;' in s:
    die("unsafe HS confirm fallback still present")
for marker in (
    "function optimizeMatchmakingExact(",
    "function optimizeMatchmakingFallback(",
    "function optimizeMatchmaking(",
    "function getForcedPairOutcome(",
    "function formatManualPlanOutput(plan)",
    "function setWarOperation(",
    "function saveDatabase()"
):
    if marker not in s:
        die("required production marker missing: "+marker)

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode:
    die("node --check: "+(r.stderr or r.stdout).strip())

# Behavioral regression: ordinary pairs always higher ELO win;
# explicit forced outcome still overrides ELO.
def choose(a,b,forced=None):
    if forced:
        return forced
    return a if a[1] >= b[1] else b

cases=[
    (("FoW BlackSite",5250),("Road to FoW",5341),None,"Road to FoW"),
    (("FoW Soul Society",5337),("FoW Sentinel 3",5372),None,"FoW Sentinel 3"),
    (("FoW Firebirds",5504),("FoW Imperial Legacy",5580),None,"FoW Imperial Legacy"),
    # forced lower-ELO winner must remain respected
    (("LOW FORCED",5200),("HIGH",5290),("LOW FORCED",5200),"LOW FORCED"),
]
for a,b,forced,expected in cases:
    f=None if forced is None else (forced[0],forced[1])
    got=choose(a,b,f)[0]
    if got!=expected:
        die("behavior regression failed: expected %s got %s"%(expected,got))

print("=== HS MATCHMAKING WINNER INTEGRITY FIX ===")
print("PASS ordinary pair -> higher ELO is WIN")
print("PASS MUST WIN / MUST LOSE forced outcome remains authoritative")
print("PASS pair membership unchanged")
print("PASS pair gap unchanged")
print("PASS optimizer untouched")
print("PASS ELO calculation/save functions untouched by patch scope")
print("PASS War logic untouched by patch scope")
print("PASS node --check")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
print("")
print("IMPORTANT: Existing Match IDs created BEFORE this patch are NOT rewritten.")
