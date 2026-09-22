#!/usr/bin/env python3
from pathlib import Path
import shutil,time,subprocess,sys

p=Path("/opt/fow-elo-bot/bot.js")
s=p.read_text()
backup=Path(f"/opt/fow-elo-bot/bot.js.backup-hs-context-final-{int(time.time())}")
shutil.copy2(p,backup)

anchor="""          // HS shared context must exist before clarification routing.
          let hsReferencedClubs = [];

          const hsConversationIntent ="""

insert="""          // HS shared context must exist before clarification routing.
          let hsReferencedClubs = [];

          const hsContextReferenceQuery =
            /\\b(?:those|these|them|this\\s+list|those\\s+clubs?|these\\s+clubs?)\\b/i.test(cleaned);

          if (hsContextReferenceQuery && message.reference?.messageId) {
            try {
              const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
              const referencedText = String(referencedMessage?.content || "").toLowerCase();
              const seenReferenced = new Set();

              for (const item of leaderboardData || []) {
                const clubName = String(item.club || "").trim();
                if (!clubName || !referencedText.includes(clubName.toLowerCase())) continue;
                const key = normalizeClubName(clubName);
                if (seenReferenced.has(key)) continue;
                seenReferenced.add(key);
                hsReferencedClubs.push(item);
              }

              if (hsReferencedClubs.length) {
                console.log("🧠 HS shared context resolved • clubs=" + hsReferencedClubs.length);
              }
            } catch (error) {
              console.warn("⚠️ HS shared context lookup failed: " + (error?.message || error));
            }
          }

          const hsConversationIntent ="""

if s.count(anchor)!=1:
    print(f"STOP: anchor count = {s.count(anchor)}")
    sys.exit(2)

s=s.replace(anchor,insert,1)
p.write_text(s)

r=subprocess.run(["node","--check",str(p)],capture_output=True,text=True)
if r.returncode:
    shutil.copy2(backup,p)
    print("FAILED: node --check; rollback completed")
    print(r.stderr)
    sys.exit(r.returncode)

print("✅ HS CONTEXT PATCH APPLIED")
print("✅ NODE CHECK PASSED")
print("✅ PM2 NOT RESTARTED")
print("Backup:",backup)
