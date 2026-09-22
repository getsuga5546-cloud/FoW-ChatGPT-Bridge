#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-hs-fallback-gate-v2-"+str(int(time.time())))
shutil.copy2(p,bak)

def die(msg):
    shutil.copy2(bak,p)
    print("FAIL:",msg)
    print("ROLLED BACK:",bak)
    sys.exit(2)

for req in ("function resolveHsClubsByClubOrPresident(","function buildHsFilteredWarStatusDashboard(","HS_RESOLVED_CLUB_CONTEXT"):
    if req not in s: die("required prior patch missing: "+req)
if "function detectHsLocalOperationalIntent(" in s:
    die("v2 fallback gate already installed")

# Protected production regions.
elo_marker="// ============================================================\n// NORMALIZE CLUB NAME"
ea=s.index("function saveDatabase()"); eb=s.index(elo_marker,ea); elo=s[ea:eb]
wa=s.index("function setWarOperation("); wb=s.index("function findWarOperationById(",wa); war=s[wa:wb]

# Insert detector before existing context-reference helper.
anchor="function isHsContextReference(text) {"
if s.count(anchor)!=1: die("helper anchor count="+str(s.count(anchor)))
helper=r'''function detectHsLocalOperationalIntent(text, session, resolvedClubs) {
  const raw = String(text || "").trim();
  const hasContext =
    (Array.isArray(resolvedClubs) && resolvedClubs.length > 0) ||
    (Array.isArray(session?.lastResults) && session.lastResults.length > 0) ||
    Boolean(session?.lastClub) ||
    Boolean(session?.lastRange) ||
    Boolean(session?.lastMatchId);

  if (/\b(?:war\s*status|status|availability|available|isolat(?:e|ed|ion)|elo|derby|leaderboard|club\s*code|codes?|matchmaking|match\s*making|pair(?:ing|ings)?|skip|must\s+win|must\s+lose|winner|loser|match\s*id|timer|preparation|cooling|push|war\s*monitor)\b/i.test(raw)) {
    if (/\b(?:club\s*code|codes?)\b/i.test(raw)) return "club_code";
    if (/\b(?:war\s*status|status|availability|available|isolat(?:e|ed|ion))\b/i.test(raw)) return "war_status";
    if (/\b(?:elo|derby|leaderboard)\b/i.test(raw)) return "elo_domain";
    if (/\b(?:matchmaking|match\s*making|pair(?:ing|ings)?|skip|must\s+win|must\s+lose|winner|loser)\b/i.test(raw)) return "matchmaking_domain";
    return "hs_domain";
  }

  if (
    hasContext &&
    /\b(?:them|those|these|their|club|clubs|kelab|senarai|list|tadi|previous|above)\b/i.test(raw)
  ) return "context_followup";

  return null;
}

'''
s=s.replace(anchor,helper+anchor,1)

# Robustly locate current intent block by structural markers, not whitespace-exact old patch.
start=s.find("          const hsIntentInput =")
if start<0: die("hsIntentInput start not found")
end_marker='''            );\n\n          if (\n            hsConversationIntent &&'''
end=s.find(end_marker,start)
if end<0: die("intent block end not found")
old=s[start:end+len("            );")]
if "await interpretHsConversationIntent(" not in old: die("unexpected intent block")

new='''          const hsLocalOperationalIntent =
            detectHsLocalOperationalIntent(
              cleaned,
              hsConversation,
              hsResolvedContextClubs
            );

''' + old.replace(
    "          const hsConversationIntent =",
    "          let hsConversationIntent =",
    1
) + '''

          // Central HS guard: operational status requests stay local even
          // when the external classifier returns unknown.
          if (
            hsLocalOperationalIntent === "war_status" &&
            (!hsConversationIntent ||
             hsConversationIntent.intent === "unknown")
          ) {
            hsConversationIntent = {
              ...(hsConversationIntent || {}),
              intent: "war_status",
              confidence: 1,
              parser: "HS LOCAL OPERATIONAL GATE",
              requires_clarification: false,
              clarification_question: null
            };
          }'''
s=s[:start]+new+s[end+len("            );"):]

# Guard generic fallback itself. Find comment rather than brittle whole block.
comment="// HS PHASE 5 — HYBRID READ-ONLY AI FALLBACK"
ci=s.find(comment,start)
if ci<0: die("generic fallback comment not found")
elsepos=s.rfind("          } else {",start,ci)
if elsepos<0: die("generic fallback else not found")
replacement='''          } else if (hsLocalOperationalIntent) {
            // CENTRAL HS FALLBACK GUARD
            const contextNames =
              hsResolvedContextClubs.length
                ? hsResolvedContextClubs.map(item => item.club)
                : Array.isArray(hsConversation.lastResults)
                  ? hsConversation.lastResults
                  : [];

            response =
              `🧭 **HS Operational Request**\\n\\n` +
              `This is an **HS/FoW operational request** and was not sent to generic AI chat.\\n` +
              (contextNames.length
                ? `📋 Active club context: **${contextNames.length} club${contextNames.length === 1 ? "" : "s"}**\\n`
                : "") +
              `🔒 No production data changed.`;

            console.warn(
              `🧭 HS fallback guard blocked generic AI • local=${hsLocalOperationalIntent} • user=${message.author.id}`
            );

          } else {'''
s=s[:elsepos]+replacement+s[elsepos+len("          } else {"):]

# Protected regions unchanged.
ea2=s.index("function saveDatabase()"); eb2=s.index(elo_marker,ea2)
if s[ea2:eb2]!=elo: die("ELO production block changed")
wa2=s.index("function setWarOperation("); wb2=s.index("function findWarOperationById(",wa2)
if s[wa2:wb2]!=war: die("war mutation block changed")

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode: die("node --check: "+(r.stderr or r.stdout).strip())

f=p.read_text()
checks=[
 ("local detector",f.count("function detectHsLocalOperationalIntent(")==1),
 ("status promotion",f.count('parser: "HS LOCAL OPERATIONAL GATE"')==1),
 ("generic fallback guard",f.count("HS fallback guard blocked generic AI")==1),
 ("filtered status retained","function buildHsFilteredWarStatusDashboard(" in f),
 ("derby exact context","the computed live list is the" in f),
 ("shared president resolver","function resolveHsClubsByClubOrPresident(" in f),
]
print("=== HS CENTRAL FALLBACK GATE V2 ===")
for n,ok in checks: print("PASS" if ok else "FAIL",n)
if not all(ok for _,ok in checks): die("final verification")
print("PASS node --check")
print("PASS ELO production block byte-identical")
print("PASS war-state mutation block byte-identical")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
