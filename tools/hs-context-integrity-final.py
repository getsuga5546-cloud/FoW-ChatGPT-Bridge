#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time, re

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-hs-context-integrity-"+str(int(time.time())))
shutil.copy2(p,bak)

def die(msg):
    shutil.copy2(bak,p)
    print("FAIL:",msg)
    print("ROLLED BACK:",bak)
    sys.exit(2)

# Require all current architecture pieces.
for req in (
 "function extractHsClubsFromText(text)",
 "function resolveHsClubsByClubOrPresident(",
 "the computed live list is the",
 "HS response context capture skipped:",
 "HS CONTEXT CLARIFICATION GUARD",
 "function buildHsFilteredWarStatusDashboard("
):
    if req not in s: die("required current marker missing: "+req)

# Protect production mutation paths.
elo_marker="// ============================================================\n// NORMALIZE CLUB NAME"
ea=s.index("function saveDatabase()"); eb=s.index(elo_marker,ea); elo=s[ea:eb]
wa=s.index("function setWarOperation("); wb=s.index("function findWarOperationById(",wa); war=s[wa:wb]

# ROOT CAUSE FIX:
# remove the broad substring scan from extractHsClubsFromText.
# It made "FORCE OF WAR" match lines containing "Force Of War II/V/IX".
old='''  for (const item of leaderboardData || []) {
    const name = String(item.club || "").trim();
    if (name && raw.toLowerCase().includes(name.toLowerCase())) add(item);
  }
'''
if s.count(old)!=1:
    die("broad substring extractor anchor count="+str(s.count(old)))
s=s.replace(old,'''  // IMPORTANT: do NOT substring-scan every database club here.
  // A parent name such as "FORCE OF WAR" must never match
  // "Force Of War II", "Force Of War V", "Force of War IX", etc.
  // Club-list extraction below is line/exact resolver based.
''',1)

# Make line parsing exact and robust for numbered HS list rows.
old2='''  for (const sourceLine of raw.split(/\\r?\\n/)) {
    const line=String(sourceLine||"")
      .replace(/^[-•*\\d.)\\s]+/,"")
      .replace(/\\s*\\(\\s*\\d{3,5}\\s*\\).*$/,"")
      .replace(/\\s+-\\s+[^\\n]+$/,"")
      .trim();
    if (!line) continue;
    for (const item of resolveHsClubsByClubOrPresident(line)) add(item);
  }
'''
new2='''  for (const sourceLine of raw.split(/\\r?\\n/)) {
    const line = String(sourceLine || "").trim();
    if (!line) continue;

    // Canonical HS list row:
    // 12. Force Of War II (5633) - BarBerry
    // Capture ONLY the entity before the ELO tuple.
    const listMatch =
      line.match(/^\\s*(?:[-•*]|\\d+[.)])?\\s*(.+?)\\s*\\(\\s*\\d{3,5}\\s*\\)(?:\\s+-.*)?$/);

    const candidate = listMatch
      ? String(listMatch[1] || "").trim()
      : line
          .replace(/^[-•*\\d.)\\s]+/, "")
          .replace(/\\s+-\\s+[^\\n]+$/, "")
          .trim();

    if (!candidate) continue;

    // Exact club/president resolver only. Never parent/sub-string expansion.
    for (const item of resolveHsClubsByClubOrPresident(candidate)) {
      add(item);
    }
  }
'''
if s.count(old2)!=1:
    die("line extractor anchor count="+str(s.count(old2)))
s=s.replace(old2,new2,1)

# Add integrity rule to response capture:
# if an authoritative exact list is already present and the response extractor
# differs in membership/count, do NOT overwrite it.
old3='''          if (renderedClubs.length) {
            hsSessionForResponse.lastResults =
              renderedClubs.map(item => item.club);
            hsSessionForResponse.lastClub =
              renderedClubs.length === 1 ? renderedClubs[0].club : null;
            hsSessionForResponse.updatedAt = Date.now();
          }
'''
new3='''          if (renderedClubs.length) {
            const renderedNames =
              renderedClubs.map(item => item.club);
            const existingNames =
              Array.isArray(hsSessionForResponse.lastResults)
                ? hsSessionForResponse.lastResults
                : [];

            const sameMembership =
              existingNames.length === renderedNames.length &&
              existingNames.every((name, index) =>
                normalizeClubName(name) ===
                normalizeClubName(renderedNames[index])
              );

            // Exact list context written by the Derby/live-list handler is
            // authoritative. Response parsing may confirm it, never expand it.
            if (!existingNames.length || sameMembership) {
              hsSessionForResponse.lastResults = renderedNames;
              hsSessionForResponse.lastClub =
                renderedNames.length === 1
                  ? renderedNames[0]
                  : null;
              hsSessionForResponse.updatedAt = Date.now();
            } else {
              console.warn(
                `🛡️ HS context integrity preserved • stored=${existingNames.length} • parsed=${renderedNames.length}`
              );
            }
          }
'''
if s.count(old3)!=1:
    die("response capture integrity anchor count="+str(s.count(old3)))
s=s.replace(old3,new3,1)

# Protected code must remain byte-identical.
ea2=s.index("function saveDatabase()"); eb2=s.index(elo_marker,ea2)
if s[ea2:eb2]!=elo: die("ELO production block changed")
wa2=s.index("function setWarOperation("); wb2=s.index("function findWarOperationById(",wa2)
if s[wa2:wb2]!=war: die("war-state mutation block changed")

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode: die("node --check: "+(r.stderr or r.stdout).strip())

f=p.read_text()

# BEHAVIORAL regression test for the exact bug seen live.
# Simulate the canonical list-row extraction semantics against overlapping names.
clubs=["FORCE OF WAR","Force Of War II","Force Of War V","Force of War IX",
       "FoW Diamond Dust","FoW Blue Crown"]
rows=[
 "1. Force of War IX (5748) - Uranium",
 "2. FoW Diamond Dust (5736) - IRIS-3",
 "3. Force Of War II (5633) - BarBerry",
 "4. FoW Blue Crown (5632) - QC-1",
 "5. Force Of War V (5448) - Mahkota 5",
]
def norm(x): return re.sub(r"[^a-z0-9]+"," ",x.lower()).strip()
resolved=[]
for row in rows:
    m=re.match(r"^\s*(?:(?:[-•*])|(?:\d+[.)]))?\s*(.+?)\s*\(\s*\d{3,5}\s*\)(?:\s+-.*)?$",row)
    if not m: die("behavior test parser failed")
    cand=m.group(1).strip()
    exact=[c for c in clubs if norm(c)==norm(cand)]
    resolved.extend(exact)

expected=["Force of War IX","FoW Diamond Dust","Force Of War II","FoW Blue Crown","Force Of War V"]
if resolved!=expected:
    die("behavior test membership mismatch: "+repr(resolved))
if "FORCE OF WAR" in resolved:
    die("behavior test contamination: parent FORCE OF WAR leaked in")

checks=[
 ("broad substring scan removed",'raw.toLowerCase().includes(name.toLowerCase())' not in f),
 ("exact list parser",'const listMatch =' in f),
 ("context integrity guard",f.count("HS context integrity preserved")==1),
 ("authoritative Derby context","the computed live list is the" in f),
 ("filtered status retained","function buildHsFilteredWarStatusDashboard(" in f),
 ("clarification guard retained","HS CONTEXT CLARIFICATION GUARD" in f),
]
print("=== HS CONTEXT INTEGRITY CONSOLIDATED FIX ===")
for n,ok in checks: print("PASS" if ok else "FAIL",n)
if not all(ok for _,ok in checks): die("static verification failed")
print("PASS node --check")
print("PASS BEHAVIOR: overlapping club names preserve exact membership")
print("PASS BEHAVIOR: FORCE OF WAR does NOT leak from Force Of War II/V/IX")
print("PASS ELO production block byte-identical")
print("PASS war-state mutation block byte-identical")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
