#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-derby-context-"+str(int(time.time())))
shutil.copy2(p,bak)

def die(msg):
    shutil.copy2(bak,p)
    print("FAIL:",msg)
    print("ROLLED BACK:",bak)
    sys.exit(2)

old='''            hsLiveRows.sort(
              (a, b) =>
                b.elo - a.elo ||
                a.club.localeCompare(b.club)
            );

            if (hsTopMatch) {'''
new='''            hsLiveRows.sort(
              (a, b) =>
                b.elo - a.elo ||
                a.club.localeCompare(b.club)
            );

            // HS conversational context: the computed live list is the
            // authoritative set for follow-ups such as "those clubs".
            // Store the exact club array, not names re-parsed from output.
            if (!hsCountRequest) {
              const hsListSession =
                getHsConversationSession(message);
              hsListSession.lastResults =
                hsLiveRows.map(item => item.club);
              hsListSession.lastClub =
                hsLiveRows.length === 1
                  ? hsLiveRows[0].club
                  : null;
              hsListSession.updatedAt = Date.now();
            }

            if (hsTopMatch) {'''
if s.count(old)!=1: die("Derby/live-list anchor count="+str(s.count(old)))
s=s.replace(old,new,1)

# Important: if TOP is applied, refresh context after slicing too.
old2='''              hsLiveRows = hsLiveRows.slice(0, limit);
            }

            const hsRangeLabel = hsRangeMatch'''
new2='''              hsLiveRows = hsLiveRows.slice(0, limit);

              if (!hsCountRequest) {
                const hsTopSession =
                  getHsConversationSession(message);
                hsTopSession.lastResults =
                  hsLiveRows.map(item => item.club);
                hsTopSession.lastClub =
                  hsLiveRows.length === 1
                    ? hsLiveRows[0].club
                    : null;
                hsTopSession.updatedAt = Date.now();
              }
            }

            const hsRangeLabel = hsRangeMatch'''
if s.count(old2)!=1: die("TOP context anchor count="+str(s.count(old2)))
s=s.replace(old2,new2,1)

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode: die("node --check: "+(r.stderr or r.stdout).strip())

final=p.read_text()
checks=[
 ("exact list context",final.count("the computed live list is the")==1),
 ("lastResults exact array",final.count("hsLiveRows.map(item => item.club)")>=2),
 ("filtered war status retained","function buildHsFilteredWarStatusDashboard(" in final),
 ("shared resolver retained","function resolveHsClubsByClubOrPresident(" in final),
 ("ELO save retained","function saveDatabase()" in final),
]
print("=== HS DERBY/LIVE LIST CONTEXT PATCH ===")
for name,ok in checks: print("PASS" if ok else "FAIL",name)
if not all(ok for _,ok in checks): die("verification failed")
print("PASS node --check")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
