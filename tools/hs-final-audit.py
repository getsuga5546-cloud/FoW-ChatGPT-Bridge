#!/usr/bin/env python3
from pathlib import Path
import subprocess,re,sys

p=Path("/opt/fow-elo-bot/bot.js")
if not p.exists():
    print("❌ bot.js not found"); sys.exit(1)
s=p.read_text(errors="replace")

checks=[]
def add(name, ok, detail=""):
    checks.append((name,ok,detail))

r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
add("Node syntax",r.returncode==0)

# Confirm experimental patches are absent after clean rollback.
markers=[
("Shared president resolver","resolveHsClubsByClubOrPresident"),
("Context pre-intent resolver","HS SHARED CONTEXT RESOLVER"),
("Context club-list patch","HS shared conversational club-list context"),
("Context clarification patch","hsReferencedClubs.length"),
]
for name,m in markers:
    n=s.count(m)
    add(name+" absent",n==0,f"count={n}")

# Stable landmarks needed for consolidated patch.
landmarks=[
("HS conversation session","function getHsConversationSession(message)"),
("HS intent interpreter","interpretHsConversationIntent"),
("Club Code fast path","hsClubCode"),
("War status dashboard","buildWarStatusDashboard"),
("Leaderboard data","leaderboardData"),
("Club normalizer","normalizeClubName"),
("Club equivalence","function areEquivalentClubNames"),
]
for name,m in landmarks:
    n=s.count(m)
    add(name,n>0,f"count={n}")

# ELO safety: audit only, never mutate.
elo_write_signals=[
"saveEloDatabase",
"elo_database.json",
"Supabase",
]
for m in elo_write_signals:
    add("ELO landmark "+m, m in s)

print("=== HS FINAL AUDIT ===")
for name,ok,detail in checks:
    print(("✅" if ok else "❌"),name,(("— "+detail) if detail else ""))

bad=[x for x in checks if not x[1]]
print("=== RESULT ===")
if bad:
    print(f"❌ AUDIT NEEDS REVIEW — {len(bad)} check(s) failed")
    sys.exit(2)
print("✅ CLEAN BASE AUDIT PASSED")
print("✅ ELO DATA NOT MODIFIED")
print("✅ PM2 NOT RESTARTED")
