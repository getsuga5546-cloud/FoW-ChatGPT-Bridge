#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-hs-context-clarification-fix-"+str(int(time.time())))
shutil.copy2(p,bak)

def die(msg):
    shutil.copy2(bak,p)
    print("FAIL:",msg)
    print("ROLLED BACK:",bak)
    sys.exit(2)

for req in (
 "function detectHsLocalOperationalIntent(",
 "HS LOCAL OPERATIONAL GATE",
 "function buildHsFilteredWarStatusDashboard(",
 "the computed live list is the"
):
    if req not in s: die("required prior patch missing: "+req)

# Protect ELO and War mutation.
elo_marker="// ============================================================\n// NORMALIZE CLUB NAME"
ea=s.index("function saveDatabase()"); eb=s.index(elo_marker,ea); elo=s[ea:eb]
wa=s.index("function setWarOperation("); wb=s.index("function findWarOperationById(",wa); war=s[wa:wb]

# Find clarification gate structurally after the intent interpreter.
search_from=s.index("HS LOCAL OPERATIONAL GATE")
needle="hsConversationIntent.requires_clarification"
pos=s.find(needle,search_from)
if pos<0: die("clarification gate not found")
ifpos=s.rfind("          if (",search_from,pos)
if ifpos<0: die("clarification if start not found")

# Inject a pre-gate override immediately before the clarification if.
insert='''          // Context-aware clarification guard:
          // If a status request already has a remembered/resolved club set,
          // the club question is already answered by conversation context.
          if (
            hsLocalOperationalIntent === "war_status" &&
            hsConversationIntent?.requires_clarification &&
            (
              hsResolvedContextClubs.length > 0 ||
              (Array.isArray(hsConversation.lastResults) &&
               hsConversation.lastResults.length > 0)
            )
          ) {
            if (!hsResolvedContextClubs.length) {
              hsResolvedContextClubs =
                hsConversation.lastResults
                  .map(name =>
                    leaderboardData.find(item =>
                      normalizeClubName(item.club) ===
                      normalizeClubName(name)
                    )
                  )
                  .filter(Boolean);
            }

            hsConversationIntent.intent = "war_status";
            hsConversationIntent.requires_clarification = false;
            hsConversationIntent.clarification_question = null;
            hsConversationIntent.clubs =
              hsResolvedContextClubs.map(item => item.club);
            hsConversationIntent.parser =
              "HS CONTEXT CLARIFICATION GUARD";
          }

'''
s=s[:ifpos]+insert+s[ifpos:]

# Protected blocks unchanged.
ea2=s.index("function saveDatabase()"); eb2=s.index(elo_marker,ea2)
if s[ea2:eb2]!=elo: die("ELO production block changed")
wa2=s.index("function setWarOperation("); wb2=s.index("function findWarOperationById(",wa2)
if s[wa2:wb2]!=war: die("war mutation block changed")

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode: die("node --check: "+(r.stderr or r.stdout).strip())

f=p.read_text()
checks=[
 ("context clarification guard",f.count("HS CONTEXT CLARIFICATION GUARD")==1),
 ("central fallback gate",f.count("HS fallback guard blocked generic AI")==1),
 ("filtered status","function buildHsFilteredWarStatusDashboard(" in f),
 ("exact Derby context","the computed live list is the" in f),
 ("shared resolver","function resolveHsClubsByClubOrPresident(" in f),
]
print("=== HS CONTEXT CLARIFICATION FIX ===")
for n,ok in checks: print("PASS" if ok else "FAIL",n)
if not all(ok for _,ok in checks): die("final verification")
print("PASS node --check")
print("PASS ELO production block byte-identical")
print("PASS war-state mutation block byte-identical")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
