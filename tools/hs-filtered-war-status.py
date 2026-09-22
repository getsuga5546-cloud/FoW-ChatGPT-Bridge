#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
bak=p.with_name("bot.js.backup-before-hs-filtered-status-"+str(int(time.time())))
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

# Require consolidated context patch already installed.
for req in ("function resolveHsClubsByClubOrPresident(","function extractHsClubsFromText(","HS_RESOLVED_CLUB_CONTEXT"):
    if req not in s: die("required prior patch missing: "+req)

# Protect production war-state mutation and ELO save regions.
war_a=s.index("function setWarOperation(")
war_b=s.index("function findWarOperationById(",war_a)
war_before=s[war_a:war_b]
elo_a=s.index("function saveDatabase()")
elo_marker="// ============================================================\n// NORMALIZE CLUB NAME"
elo_b=s.index(elo_marker,elo_a)
elo_before=s[elo_a:elo_b]

# Add a read-only filtered formatter beside the existing global dashboard.
anchor="function timerIsolationLabel(t){"
helper=r'''function buildHsFilteredWarStatusDashboard(clubs) {
  const requested = Array.isArray(clubs) ? clubs.filter(Boolean) : [];
  if (!requested.length) return buildWarStatusDashboard();

  const lines = [];
  let isolatedCount = 0;

  for (const item of requested) {
    const club = typeof item === "string" ? item : item.club;
    if (!club) continue;

    const op = getWarOperation(club);
    const status = String(op?.status || "AVAILABLE").toUpperCase();

    if (!op || status === "AVAILABLE") {
      lines.push(`🟢 **${club}** — AVAILABLE`);
      continue;
    }

    isolatedCount += 1;

    let label = status.replace(/_/g, " ");
    let icon = "🚫";
    if (status === "WAR_ACTIVE") icon = "🔴";
    else if (status === "KO_ACTIVE") icon = "🔴";
    else if (status === "PREPARATION") icon = "⚪";
    else if (status === "COOLING_DOWN") icon = "🟡";
    else if (status === "AWAITING_COOLING_TIME") icon = "🟠";

    let remaining = "";
    if (status === "PREPARATION" && op.preparationEndAt) {
      remaining = ` • ${formatRemaining(Number(op.preparationEndAt)-Date.now())} left`;
    } else if (status === "COOLING_DOWN" && op.coolingEndAt) {
      remaining = ` • ${formatRemaining(Number(op.coolingEndAt)-Date.now())} left`;
    }

    lines.push(
      `${icon} **${club}** — ${label} • ${warEventLabel(op.eventType)}${remaining}`
    );
  }

  return (
    `📋 **WAR STATUS — SELECTED CLUBS (${requested.length})**\n\n` +
    lines.join("\n") +
    `\n\n🚫 **Matchmaking Isolated: ${isolatedCount}/${requested.length}**`
  );
}

'''
once(anchor,helper+anchor,"filtered dashboard helper")

old='''            } else if (
              hsConversationIntent.intent === "war_status"
            ) {
              // HS PHASE 6.2B — LIVE WAR STATUS RESOLVER
              // Read-only: reuse the existing production War Status dashboard.
              response = buildWarStatusDashboard();

            } else {'''
new='''            } else if (
              hsConversationIntent.intent === "war_status"
            ) {
              // HS filtered status is display-only. When conversational
              // context has clubs, report only those clubs. With no club
              // context, preserve the existing global dashboard behavior.
              response =
                hsResolvedContextClubs.length
                  ? buildHsFilteredWarStatusDashboard(
                      hsResolvedContextClubs
                    )
                  : hsConversationIntent.club
                    ? buildHsFilteredWarStatusDashboard(
                        resolveHsClubsByClubOrPresident(
                          hsConversationIntent.club
                        )
                      )
                    : buildWarStatusDashboard();

            } else {'''
once(old,new,"HS war_status route")

# Hard guards: no state mutation or ELO persistence code changed.
war_a2=s.index("function setWarOperation(")
war_b2=s.index("function findWarOperationById(",war_a2)
if s[war_a2:war_b2] != war_before: die("war-state mutation block changed")
elo_a2=s.index("function saveDatabase()")
elo_b2=s.index(elo_marker,elo_a2)
if s[elo_a2:elo_b2] != elo_before: die("ELO production block changed")

p.write_text(s)
r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode: die("node --check: "+(r.stderr or r.stdout).strip())

final=p.read_text()
checks=[
 ("filtered helper",final.count("function buildHsFilteredWarStatusDashboard(")==1),
 ("HS route",final.count("buildHsFilteredWarStatusDashboard(")>=3),
 ("global dashboard preserved",final.count("function buildWarStatusDashboard()")==1),
 ("war mutation preserved",final[final.index("function setWarOperation("):final.index("function findWarOperationById(",final.index("function setWarOperation("))]==war_before),
]
print("=== HS FILTERED WAR STATUS PATCH ===")
for name,ok in checks: print("PASS" if ok else "FAIL",name)
if not all(ok for _,ok in checks): die("final verification")
print("PASS node --check")
print("PASS war-state mutation block byte-identical")
print("PASS ELO production block byte-identical")
print("BACKUP",bak)
print("PATCH VERIFIED - SAFE TO RESTART PM2")
