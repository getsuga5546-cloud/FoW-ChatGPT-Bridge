#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-hs-final-"+str(int(time.time())))
shutil.copy2(p,bak)

def die(m):
    shutil.copy2(bak,p)
    print("FAIL:",m)
    print("ROLLED BACK:",bak)
    sys.exit(2)

def patch(old,new,label):
    global s
    n=s.count(old)
    if n!=1: die(label+" anchor count="+str(n))
    s=s.replace(old,new,1)

if "function resolveHsClubsByClubOrPresident(" in s:
    die("unexpected prior HS resolver")
if "function saveDatabase()" not in s:
    die("ELO landmark missing")

a=s.index("function saveDatabase()")
marker="// ============================================================\n// NORMALIZE CLUB NAME"
b=s.index(marker,a)
elo=s[a:b]

anchor="function areEquivalentClubNames(nameA, nameB) {"
helper="""// HS FINAL SHARED ENTITY RESOLVER - READ ONLY
function resolveHsClubsByClubOrPresident(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const key = normalizeClubName(raw);
  const out = [];
  const seen = new Set();
  for (const item of leaderboardData || []) {
    const clubMatch =
      normalizeClubName(item.club) === key ||
      areEquivalentClubNames(item.club, raw);
    const president = String(item.president || "").trim();
    const presidentMatch =
      president && normalizeClubName(president) === key;
    if (!clubMatch && !presidentMatch) continue;
    const k = normalizeClubName(item.club);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function extractHsClubsFromText(text) {
  const raw = String(text || "");
  const out = [];
  const seen = new Set();
  const add = item => {
    if (!item?.club) return;
    const k = normalizeClubName(item.club);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(item);
  };
  for (const item of leaderboardData || []) {
    const name = String(item.club || "").trim();
    if (name && raw.toLowerCase().includes(name.toLowerCase())) add(item);
  }
  for (const sourceLine of raw.split(/\\r?\\n/)) {
    const line=String(sourceLine||"")
      .replace(/^[-•*\\d.)\\s]+/,"")
      .replace(/\\s*\\(\\s*\\d{3,5}\\s*\\).*$/,"")
      .replace(/\\s+-\\s+[^\\n]+$/,"")
      .trim();
    if (!line) continue;
    for (const item of resolveHsClubsByClubOrPresident(line)) add(item);
  }
  return out;
}

function isHsContextReference(text) {
  return /\\b(?:those|these|them|that list|this list|those clubs?|these clubs?|previous|above|tadi|yang tadi|senarai tadi|club tadi|kelab tadi)\\b/i.test(String(text||""));
}

"""
patch(anchor,helper+anchor,"resolver")

patch("""    lastResults: Array.isArray(session.lastResults)
      ? session.lastResults.slice(0, 20)
      : []""","""    lastResults: Array.isArray(session.lastResults)
      ? session.lastResults.slice(0, 100)
      : []""","context capacity")

patch("""          const hsConversation =
            getHsConversationSession(message);

          const hsConversationIntent =
            await interpretHsConversationIntent(
              cleaned,
              hsConversation
            );""","""          const hsConversation =
            getHsConversationSession(message);

          let hsResolvedContextClubs =
            extractHsClubsFromText(cleaned);

          if (
            !hsResolvedContextClubs.length &&
            isHsContextReference(cleaned) &&
            Array.isArray(hsConversation.lastResults)
          ) {
            hsResolvedContextClubs =
              hsConversation.lastResults
                .map(name =>
                  leaderboardData.find(item =>
                    normalizeClubName(item.club) === normalizeClubName(name)
                  )
                )
                .filter(Boolean);
          }

          const hsIntentInput =
            hsResolvedContextClubs.length
              ? cleaned +
                "\\n\\n[HS_RESOLVED_CLUB_CONTEXT]\\n" +
                hsResolvedContextClubs
                  .map(item =>
                    item.club + " (" + item.elo + ") - " +
                    String(item.president || "")
                  )
                  .join("\\n")
              : cleaned;

          const hsConversationIntent =
            await interpretHsConversationIntent(
              hsIntentInput,
              hsConversation
            );""","pre intent")

patch("""          if (
            hsConversationIntent &&
            hsConversationIntent.intent !== "unknown"
          ) {
            hsConversation.lastIntent =
              hsConversationIntent.intent;""","""          if (
            hsConversationIntent &&
            hsConversationIntent.intent !== "unknown"
          ) {
            if (hsConversationIntent.club) {
              const entityMatches =
                resolveHsClubsByClubOrPresident(hsConversationIntent.club);
              if (entityMatches.length === 1) {
                hsConversationIntent.club = entityMatches[0].club;
              } else if (entityMatches.length > 1) {
                hsResolvedContextClubs = entityMatches;
                hsConversationIntent.club = null;
              }
            }

            if (hsResolvedContextClubs.length) {
              hsConversationIntent.clubs =
                hsResolvedContextClubs.map(item => item.club);
            }

            hsConversation.lastIntent =
              hsConversationIntent.intent;""","canonical intent")

patch("""            hsConversation.updatedAt = Date.now();

            if (
              hsConversationIntent.min_elo !== null""","""            hsConversation.updatedAt = Date.now();

            if (hsResolvedContextClubs.length) {
              hsConversation.lastResults =
                hsResolvedContextClubs.map(item => item.club);
              hsConversation.lastClub =
                hsResolvedContextClubs.length === 1
                  ? hsResolvedContextClubs[0].club
                  : null;
            }

            if (
              hsConversationIntent.min_elo !== null""","session save")

patch("""            let club = leaderboardData.find(item =>
              normalizeClubName(item.club) === normalizeClubName(candidate)
            );

            if (!club) {
              club = leaderboardData.find(item =>
                areEquivalentClubNames(item.club, candidate)
              );
            }

            if (!club) return;

            const key = normalizeClubName(club.club);
            if (seenClubCodes.has(key)) return;
            seenClubCodes.add(key);
            foundClubCodes.push(club);""","""            const matches =
              resolveHsClubsByClubOrPresident(candidate);

            if (!matches.length) return;

            for (const club of matches) {
              const key = normalizeClubName(club.club);
              if (seenClubCodes.has(key)) continue;
              seenClubCodes.add(key);
              foundClubCodes.push(club);
            }""","club code")

patch("""        const hsFullResponse =
          `🤖 **HS Assistant — Phase 5 Hybrid**\\n\\n${response}`;
        const hsResponseChunks =""","""        try {
          const hsSessionForResponse =
            getHsConversationSession(message);
          const renderedClubs =
            extractHsClubsFromText(response);
          if (renderedClubs.length) {
            hsSessionForResponse.lastResults =
              renderedClubs.map(item => item.club);
            hsSessionForResponse.lastClub =
              renderedClubs.length === 1 ? renderedClubs[0].club : null;
            hsSessionForResponse.updatedAt = Date.now();
          }
        } catch (contextError) {
          console.warn(
            "HS response context capture skipped:",
            contextError?.message || contextError
          );
        }

        const hsFullResponse =
          `🤖 **HS Assistant — Phase 5 Hybrid**\\n\\n${response}`;
        const hsResponseChunks =""","response capture")

a2=s.index("function saveDatabase()")
b2=s.index(marker,a2)
if s[a2:b2] != elo: die("ELO production block changed")

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode:
    die("node --check: "+(r.stderr or r.stdout).strip())

checks=[
 ("resolver",s.count("function resolveHsClubsByClubOrPresident(")==1),
 ("extractor",s.count("function extractHsClubsFromText(")==1),
 ("pre-intent",s.count("HS_RESOLVED_CLUB_CONTEXT")==1),
 ("response-memory",s.count("HS response context capture skipped:")==1),
 ("ELO landmark",s.count("function saveDatabase()")==1),
]
print("=== HS FINAL PATCH ===")
for name,ok in checks: print("PASS" if ok else "FAIL",name)
if not all(ok for _,ok in checks): die("final gate")
print("PASS node --check")
print("PASS ELO production block byte-identical")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
