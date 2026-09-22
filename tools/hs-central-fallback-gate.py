#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-hs-fallback-gate-"+str(int(time.time())))
shutil.copy2(p,bak)

def die(msg):
    shutil.copy2(bak,p)
    print("FAIL:",msg)
    print("ROLLED BACK:",bak)
    sys.exit(2)

def once(old,new,label):
    global s
    n=s.count(old)
    if n!=1: die(label+" anchor count="+str(n))
    s=s.replace(old,new,1)

# Required consolidated pieces.
for req in (
 "function resolveHsClubsByClubOrPresident(",
 "function extractHsClubsFromText(",
 "function buildHsFilteredWarStatusDashboard(",
 "HS_RESOLVED_CLUB_CONTEXT",
 "the computed live list is the"
):
    if req not in s: die("required prior patch missing: "+req)

# Protect stable production write paths.
elo_a=s.index("function saveDatabase()")
elo_marker="// ============================================================\n// NORMALIZE CLUB NAME"
elo_b=s.index(elo_marker,elo_a)
elo_before=s[elo_a:elo_b]

war_a=s.index("function setWarOperation(")
war_b=s.index("function findWarOperationById(",war_a)
war_before=s[war_a:war_b]

opt_a=s.index("function optimizeMatchmaking(")
# capture optimizer until next top-level function
opt_tail=s[opt_a:]
import re
m=re.search(r"\nfunction [A-Za-z0-9_$]+\(",opt_tail[len("function optimizeMatchmaking("):])
if not m: die("optimizer end landmark missing")
opt_b=opt_a+len("function optimizeMatchmaking(")+m.start()
opt_before=s[opt_a:opt_b]

# Add deterministic local operational-intent gate before generic AI fallback.
# It intentionally handles HS-domain requests from local context/data first.
anchor="function isHsContextReference(text) {"
idx=s.find(anchor)
if idx<0: die("context helper anchor missing")
# Insert helper immediately before isHsContextReference.
helper=r'''function detectHsLocalOperationalIntent(text, session, resolvedClubs) {
  const raw = String(text || "").trim();
  const q = raw.toLowerCase();
  const hasContext =
    Array.isArray(resolvedClubs) && resolvedClubs.length > 0 ||
    Array.isArray(session?.lastResults) && session.lastResults.length > 0 ||
    Boolean(session?.lastClub) ||
    Boolean(session?.lastRange) ||
    Boolean(session?.lastMatchId);

  // Strong HS-domain nouns/actions. This gate exists specifically so an
  // operational request never becomes generic AI chat merely because the
  // external intent classifier returned unknown.
  if (/\b(?:war\s*status|war status|status|availability|available|isolat(?:e|ed|ion)|elo|derby|leaderboard|club\s*code|code|matchmaking|match\s*making|pair(?:ing|ings)?|skip|must\s+win|must\s+lose|winner|loser|match\s*id|timer|preparation|cooling|push|war\s*monitor)\b/i.test(raw)) {
    if (/\b(?:club\s*code|codes?)\b/i.test(raw)) return "club_code";
    if (/\b(?:war\s*status|status|availability|available|isolat(?:e|ed|ion))\b/i.test(raw)) return "war_status";
    if (/\b(?:elo|leaderboard|derby)\b/i.test(raw)) return "elo_domain";
    if (/\b(?:matchmaking|match\s*making|pair(?:ing|ings)?|skip|must\s+win|must\s+lose|winner|loser)\b/i.test(raw)) return "matchmaking_domain";
    return "hs_domain";
  }

  // Contextual follow-up language is HS-domain only when a prior HS entity
  // context exists. Casual chat such as "lol" remains eligible for AI chat.
  if (
    hasContext &&
    /\b(?:them|those|these|it|that|this|their|club|clubs|kelab|senarai|list|tadi|previous|above)\b/i.test(q)
  ) {
    return "context_followup";
  }

  return null;
}

'''
s=s[:idx]+helper+s[idx:]

# In the already-patched pre-intent section, derive a local operational hint.
old='''          const hsIntentInput =
            hsResolvedContextClubs.length
              ? cleaned +
                "\\n\\n[HS_RESOLVED_CLUB_CONTEXT]\\n" +
                hsResolvedContextClubs
                  .map(item =>
                    item.club +
                    " (" + item.elo + ") - " +
                    String(item.president || "")
                  )
                  .join("\\n")
              : cleaned;

          const hsConversationIntent =
            await interpretHsConversationIntent(
              hsIntentInput,
              hsConversation
            );'''
new='''          const hsLocalOperationalIntent =
            detectHsLocalOperationalIntent(
              cleaned,
              hsConversation,
              hsResolvedContextClubs
            );

          const hsIntentInput =
            hsResolvedContextClubs.length
              ? cleaned +
                "\\n\\n[HS_RESOLVED_CLUB_CONTEXT]\\n" +
                hsResolvedContextClubs
                  .map(item =>
                    item.club +
                    " (" + item.elo + ") - " +
                    String(item.president || "")
                  )
                  .join("\\n")
              : cleaned;

          let hsConversationIntent =
            await interpretHsConversationIntent(
              hsIntentInput,
              hsConversation
            );

          // Central fallback guard: local HS operational meaning wins over
          // generic AI fallback. Do not depend on one exact wording.
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
once(old,new,"central pre-intent gate")

# Replace generic unknown fallback entrance with a protected HS-domain response.
# Status is routed above; other recognized HS domains must not be sent to generic AI.
old='''          } else {
            // HS PHASE 5 — HYBRID READ-ONLY AI FALLBACK
            // Used only when no FoW conversational intent was identified.
            // HS PHASE 6.1B TOKEN GUARD'''
new='''          } else if (hsLocalOperationalIntent) {
            // CENTRAL HS FALLBACK GUARD
            // An HS-domain request must never be answered by generic AI as
            // though live production data/functions are unavailable.
            const contextNames =
              hsResolvedContextClubs.length
                ? hsResolvedContextClubs.map(item => item.club)
                : Array.isArray(hsConversation.lastResults)
                  ? hsConversation.lastResults
                  : [];

            response =
              `🧭 **HS Operational Request**\\n\\n` +
              `I recognized this as an **HS/FoW operational request**, so it was not sent to generic AI chat.\\n` +
              (contextNames.length
                ? `📋 Active club context: **${contextNames.length} club${contextNames.length === 1 ? "" : "s"}**\\n`
                : "") +
              `Please use the same natural request again with the operation you want (status, ELO, Club Code, matchmaking, isolation, etc.).\\n\\n` +
              `🔒 No production data changed.`;

            console.warn(
              `🧭 HS fallback guard blocked generic AI • local=${hsLocalOperationalIntent} • user=${message.author.id}`
            );

          } else {
            // HS PHASE 5 — HYBRID READ-ONLY AI FALLBACK
            // Only genuine non-HS conversation may reach generic AI.
            // HS PHASE 6.1B TOKEN GUARD'''
# There may be only one current occurrence in Phase6 block.
if s.count(old)!=1: die("generic fallback anchor count="+str(s.count(old)))
s=s.replace(old,new,1)

# Hard protected-region checks.
elo_a2=s.index("function saveDatabase()"); elo_b2=s.index(elo_marker,elo_a2)
if s[elo_a2:elo_b2]!=elo_before: die("ELO production block changed")
war_a2=s.index("function setWarOperation("); war_b2=s.index("function findWarOperationById(",war_a2)
if s[war_a2:war_b2]!=war_before: die("war mutation block changed")
opt_a2=s.index("function optimizeMatchmaking(")
opt_tail2=s[opt_a2:]
m2=re.search(r"\nfunction [A-Za-z0-9_$]+\(",opt_tail2[len("function optimizeMatchmaking("):])
if not m2: die("optimizer end landmark missing after patch")
opt_b2=opt_a2+len("function optimizeMatchmaking(")+m2.start()
if s[opt_a2:opt_b2]!=opt_before: die("matchmaking optimizer changed")

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode: die("node --check: "+(r.stderr or r.stdout).strip())

final=p.read_text()
checks=[
 ("local operational detector",final.count("function detectHsLocalOperationalIntent(")==1),
 ("central status promotion",final.count('intent: "war_status",')>=1),
 ("generic AI guard",final.count("HS fallback guard blocked generic AI")==1),
 ("filtered status retained","function buildHsFilteredWarStatusDashboard(" in final),
 ("exact Derby context retained","the computed live list is the" in final),
 ("shared president resolver retained","function resolveHsClubsByClubOrPresident(" in final),
]
print("=== HS CENTRAL FALLBACK GATE PATCH ===")
for name,ok in checks: print("PASS" if ok else "FAIL",name)
if not all(ok for _,ok in checks): die("final verification")
print("PASS node --check")
print("PASS ELO production block byte-identical")
print("PASS war-state mutation block byte-identical")
print("PASS matchmaking optimizer byte-identical")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
