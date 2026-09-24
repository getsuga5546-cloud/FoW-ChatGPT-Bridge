#!/usr/bin/env python3
from pathlib import Path
import re, shutil, subprocess, sys, time

p = Path('/opt/fow-elo-bot/bot.js')
s = p.read_text()
bak = p.with_name('bot.js.backup-before-war-override-' + str(int(time.time())))
shutil.copy2(p, bak)

def die(msg):
    shutil.copy2(bak, p)
    print('FAIL:', msg)
    print('ROLLED BACK:', bak)
    sys.exit(2)

def require_once(token, label):
    n = s.count(token)
    if n != 1:
        die(f'{label} count={n}')

if 'WAR_OVERRIDE_COMMAND_V1' in s or '.setName("war_override")' in s or ".setName('war_override')" in s:
    die('war_override already appears to be installed')

for token, label in [
    ('function setWarOperation(', 'setWarOperation'),
    ('function getWarOperation(', 'getWarOperation'),
    ('function normalizeClubName(', 'normalizeClubName'),
]:
    if token not in s:
        die(f'missing required production anchor: {label}')

# ------------------------------------------------------------
# 1) Register /war_override safely inside the commands array.
# ------------------------------------------------------------
m = re.search(r'\b(?:const|let|var)\s+commands\s*=\s*\[', s)
if not m:
    die('commands array anchor not found')

start = s.find('[', m.start())
level = 0
quote = None
escape = False
end = None
for i in range(start, len(s)):
    ch = s[i]
    if quote:
        if escape:
            escape = False
        elif ch == '\\':
            escape = True
        elif ch == quote:
            quote = None
        continue
    if ch in ('"', "'", '`'):
        quote = ch
        continue
    if ch == '[':
        level += 1
    elif ch == ']':
        level -= 1
        if level == 0:
            end = i
            break
if end is None:
    die('commands array closing bracket not found')

command_block = '''\n  // WAR_OVERRIDE_COMMAND_V1\n  new SlashCommandBuilder()\n    .setName("war_override")\n    .setDescription("Force one club war status to AVAILABLE")\n    .addStringOption(option =>\n      option\n        .setName("club")\n        .setDescription("Club name to override")\n        .setRequired(true)\n    ),\n'''

before = s[:end].rstrip()
if before.endswith(','):
    insertion = command_block.lstrip('\n')
else:
    insertion = ',' + command_block
s = s[:end] + insertion + s[end:]

# ------------------------------------------------------------
# 2) Add targeted helper next to war-state functions.
#    It preserves all unrelated clubs and only mutates one club.
# ------------------------------------------------------------
helper_anchor = 'function findWarOperationById('
idx = s.find(helper_anchor)
if idx < 0:
    die('findWarOperationById anchor not found')

# Opportunistically detect timer/reminder Maps declared in production source.
map_names = []
for mm in re.finditer(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Map\s*\(', s):
    name = mm.group(1)
    low = name.lower()
    if any(k in low for k in ('war', 'timer', 'reminder', 'prep', 'cool')):
        map_names.append(name)
map_names = sorted(set(map_names))

map_clear_lines = []
for name in map_names:
    map_clear_lines.append(f'''  try {{\n    if ({name} instanceof Map) {{\n      const keys = [clubName, normalizeClubName(clubName)];\n      for (const key of keys) {{\n        const handle = {name}.get(key);\n        if (handle) {{\n          try {{ clearTimeout(handle); }} catch (_) {{}}\n          try {{ clearInterval(handle); }} catch (_) {{}}\n        }}\n        {name}.delete(key);\n      }}\n    }}\n  }} catch (_) {{}}''')
map_clear_code = '\n'.join(map_clear_lines) if map_clear_lines else '  // No obvious global war timer Maps detected by patcher.'

helper = f'''// WAR_OVERRIDE_COMMAND_V1\nasync function forceWarOperationAvailable(clubName, actorTag = null) {{\n  const current = getWarOperation(clubName);\n  const previousStatus = String(current?.status || "AVAILABLE").toUpperCase();\n\n  // Clear timer-like handles stored directly on the operation object.\n  if (current && typeof current === "object") {{\n    for (const [key, value] of Object.entries(current)) {{\n      if (!/(timer|timeout|interval|reminder)/i.test(key)) continue;\n      if (value) {{\n        try {{ clearTimeout(value); }} catch (_) {{}}\n        try {{ clearInterval(value); }} catch (_) {{}}\n      }}\n    }}\n  }}\n\n{map_clear_code}\n\n  const next = {{\n    ...(current || {{}}),\n    club: current?.club || clubName,\n    status: "AVAILABLE",\n    eventType: null,\n    preparationEndAt: null,\n    warStartAt: null,\n    warEndAt: null,\n    coolingEndAt: null,\n    nextReminderAt: null,\n    reminderAt: null,\n    isolated: false,\n    overrideAvailable: true,\n    overrideBy: actorTag,\n    overrideAt: Date.now(),\n    updatedAt: Date.now()\n  }};\n\n  const result = setWarOperation(clubName, next);\n  if (result && typeof result.then === "function") await result;\n\n  // Reuse any existing persistence hooks if present. setWarOperation may\n  // already persist; these are safe best-effort calls only when defined.\n  if (typeof saveRuntimeState === "function") {{\n    const r = saveRuntimeState();\n    if (r && typeof r.then === "function") await r;\n  }} else if (typeof persistRuntimeState === "function") {{\n    const r = persistRuntimeState();\n    if (r && typeof r.then === "function") await r;\n  }} else if (typeof saveWarOperations === "function") {{\n    const r = saveWarOperations();\n    if (r && typeof r.then === "function") await r;\n  }}\n\n  const confirmed = getWarOperation(clubName);\n  const confirmedStatus = String(confirmed?.status || "AVAILABLE").toUpperCase();\n  if (confirmedStatus !== "AVAILABLE") {{\n    throw new Error(`override verification failed: ${{confirmedStatus}}`);\n  }}\n\n  return {{ previousStatus, status: confirmedStatus }};\n}}\n\n'''

s = s[:idx] + helper + s[idx:]

# ------------------------------------------------------------
# 3) Add interaction handler immediately before existing war_monitor.
# ------------------------------------------------------------
patterns = [
    'if (interaction.commandName === "war_monitor") {',
    "if (interaction.commandName === 'war_monitor') {",
]
anchors = [(pat, s.find(pat)) for pat in patterns if s.find(pat) >= 0]
if len(anchors) != 1:
    die(f'war_monitor interaction anchor count={len(anchors)}')
pat, hidx = anchors[0]

handler = '''// WAR_OVERRIDE_COMMAND_V1\n      if (interaction.commandName === "war_override") {\n        try {\n          const rawClub = String(interaction.options.getString("club") || "").trim();\n          let club = leaderboardData.find(item =>\n            normalizeClubName(item.club) === normalizeClubName(rawClub)\n          );\n          if (!club && typeof areEquivalentClubNames === "function") {\n            club = leaderboardData.find(item =>\n              areEquivalentClubNames(item.club, rawClub)\n            );\n          }\n\n          if (!club) {\n            await interaction.reply({\n              content: `❌ Club not found: **${rawClub}**`,\n              ephemeral: true\n            });\n            return;\n          }\n\n          const before = getWarOperation(club.club);\n          const previousStatus = String(before?.status || "AVAILABLE").toUpperCase();\n          const actorTag = interaction.user?.tag || interaction.user?.id || null;\n          const result = await forceWarOperationAvailable(club.club, actorTag);\n\n          await interaction.reply({\n            content:\n              `⚠️ **WAR STATUS OVERRIDE**\\n\\n` +\n              `Club: **${club.club}**\\n` +\n              `Previous Status: **${previousStatus}**\\n` +\n              `New Status: **${result.status}**\\n\\n` +\n              `✅ War state set to AVAILABLE\\n` +\n              `✅ Isolation cleared for this club\\n` +\n              `✅ Timer/reminder handles cleared where applicable\\n` +\n              `✅ Other clubs unchanged`,\n            ephemeral: false\n          });\n        } catch (error) {\n          console.error("WAR_OVERRIDE ERROR", error);\n          const content =\n            `❌ War override failed: ${error?.message || error}`;\n          if (interaction.replied || interaction.deferred) {\n            await interaction.followUp({ content, ephemeral: true });\n          } else {\n            await interaction.reply({ content, ephemeral: true });\n          }\n        }\n        return;\n      }\n\n      '''

s = s[:hidx] + handler + s[hidx:]

# ------------------------------------------------------------
# Safety verification.
# ------------------------------------------------------------
p.write_text(s)
r = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
if r.returncode:
    die('node --check: ' + (r.stderr or r.stdout).strip())

final = p.read_text()
checks = [
    ('slash command', final.count('.setName("war_override")') == 1),
    ('helper', final.count('async function forceWarOperationAvailable(') == 1),
    ('interaction handler', final.count('interaction.commandName === "war_override"') == 1),
    ('war monitor preserved', 'war_monitor' in final),
    ('setWarOperation preserved', final.count('function setWarOperation(') == 1),
    ('getWarOperation preserved', final.count('function getWarOperation(') == 1),
]
print('=== WAR OVERRIDE COMMAND PATCH ===')
for name, ok in checks:
    print('PASS' if ok else 'FAIL', name)
if not all(ok for _, ok in checks):
    die('final verification failed')
print('PASS node --check')
print('DETECTED TIMER MAPS:', ', '.join(map_names) if map_names else 'none')
print('BACKUP', bak)
print('PATCH VERIFIED - SAFE TO RESTART PM2')
