#!/usr/bin/env python3
from pathlib import Path
import shutil, subprocess, sys, time

p=Path('/opt/fow-elo-bot/bot.js')
s=p.read_text()
bak=p.with_name('bot.js.backup-before-isolation-override-bulk-'+str(int(time.time())))
shutil.copy2(p,bak)

def die(msg):
    shutil.copy2(bak,p)
    print('FAIL:',msg)
    print('ROLLED BACK:',bak)
    sys.exit(2)

def once(old,new,label):
    global s
    n=s.count(old)
    if n!=1:
        die(label+' anchor count='+str(n))
    s=s.replace(old,new,1)

# Hard prerequisites from current production baseline.
for req in (
    'new SlashCommandBuilder().setName("isolation_override")',
    'function setWarOperation(',
    'function areEquivalentClubNames(',
    'const commands =',
):
    if req not in s:
        die('required production landmark missing: '+req)

if 'isolation_override_bulk' in s:
    die('isolation_override_bulk already appears to be installed')

# Require Discord modal builders to already be imported by production.
for req in ('ModalBuilder','TextInputBuilder','TextInputStyle'):
    if req not in s:
        die('Discord modal builder missing from production import: '+req)

# 1) Register a separate bulk command. Existing isolation_override remains untouched.
old_cmd='''  new SlashCommandBuilder().setName("isolation_override").setDescription("Master override: release selected clubs from all isolation").toJSON(),'''
new_cmd='''  new SlashCommandBuilder().setName("isolation_override").setDescription("Master override: release selected clubs from all isolation").toJSON(),
  new SlashCommandBuilder().setName("isolation_override_bulk").setDescription("Bulk release clubs from isolation using paste list").toJSON(),'''
once(old_cmd,new_cmd,'slash command registration')

# 2) Add parser/helper before the existing war override handler. It accepts:
# Club Name
# Club Name (5987)
# Club Name (5987) - President
# numbered/bulleted lines
handler_anchor='''    if (interaction.commandName === "war_override") {'''
helper=r'''    if (interaction.commandName === "isolation_override_bulk") {
      if(!isWarAdminInteraction(interaction)){
        await interaction.reply({content:'⛔ You are not authorized to manage isolation.',flags:MessageFlags.Ephemeral});
        return;
      }
      const modal=new ModalBuilder()
        .setCustomId('isolation_override_bulk_modal')
        .setTitle('Bulk Isolation Override');
      const input=new TextInputBuilder()
        .setCustomId('clubs')
        .setLabel('Paste club list')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('FoW Berserker (5987)\nFoW Adeptus Astartes (5910)');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

'''
once(handler_anchor,helper+handler_anchor,'bulk command handler')

# 3) Insert modal submit handler at the top of the interactionCreate callback body,
# immediately before the first chat-input command gate. This keeps existing flows intact.
modal_anchor='''    if (!interaction.isChatInputCommand()) return;'''
modal_code=r'''    if (interaction.isModalSubmit() && interaction.customId === 'isolation_override_bulk_modal') {
      if(!isWarAdminInteraction(interaction)){
        await interaction.reply({content:'⛔ You are not authorized to manage isolation.',flags:MessageFlags.Ephemeral});
        return;
      }

      const raw=interaction.fields.getTextInputValue('clubs');
      const lines=String(raw||'')
        .split(/\r?\n/)
        .map(x=>x.trim())
        .filter(Boolean);

      const requested=[];
      const seen=new Set();
      for(const source of lines){
        const cleaned=String(source)
          .replace(/^[-•*\d.)\s]+/,'')
          .replace(/\s*\(\s*\d{3,5}\s*\).*$/,'')
          .replace(/\s+-\s+[^\n]+$/,'')
          .trim();
        if(!cleaned) continue;
        const db=leaderboardData.find(x=>areEquivalentClubNames(x.club,cleaned));
        if(!db){
          requested.push({input:cleaned,club:null});
          continue;
        }
        const key=normalizeClubName(db.club);
        if(seen.has(key)) continue;
        seen.add(key);
        requested.push({input:cleaned,club:db.club});
      }

      const released=[];
      const missing=[];
      for(const item of requested){
        if(!item.club){ missing.push(item.input); continue; }
        const existing=getWarOperation(item.club);
        const op=setWarOperation(item.club,{
          status:'AVAILABLE',
          isolated:false,
          reminderPending:false,
          nextReminderAt:null,
          nextAckReminderAt:null,
          lastReminderMessageId:null,
          preparationEndAt:null,
          coolingEndAt:null,
          warning15mSent:true,
          completionSent:true,
          channelId:existing?.channelId||interaction.channelId,
          guildId:interaction.guildId,
          eventType:existing?.eventType||'normal'
        },interaction.user.id,'ADMIN_BULK_ISOLATION_OVERRIDE');
        released.push(op.club);
      }

      let content='✅ **BULK ISOLATION OVERRIDE**\n\n';
      if(released.length){
        content+='🟢 **AVAILABLE ('+released.length+')**\n'+released.map(x=>'• '+x).join('\n');
      }
      if(missing.length){
        content+=(released.length?'\n\n':'')+'⚠️ **NOT FOUND ('+missing.length+')**\n'+missing.map(x=>'• '+x).join('\n');
      }
      content+='\n\nMatchmaking isolation cleared for listed clubs.';
      await interaction.reply({content,flags:MessageFlags.Ephemeral});
      return;
    }

'''
once(modal_anchor,modal_code+modal_anchor,'modal submit handler')

p.write_text(s)
r=subprocess.run(['node','--check',str(p)],capture_output=True,text=True)
if r.returncode:
    die('node --check: '+(r.stderr or r.stdout).strip())

final=p.read_text()
checks=[
    ('bulk command',final.count('setName("isolation_override_bulk")')==1),
    ('bulk handler',final.count('interaction.commandName === "isolation_override_bulk"')==1),
    ('bulk modal',final.count("customId === 'isolation_override_bulk_modal'")==1),
    ('existing command preserved',final.count('setName("isolation_override")')==1),
    ('war override preserved',final.count('interaction.commandName === "war_override"')==1),
]
print('=== ISOLATION OVERRIDE BULK PASTE PATCH ===')
for name,ok in checks:
    print('PASS' if ok else 'FAIL',name)
if not all(ok for _,ok in checks):
    die('final verification')
print('PASS node --check')
print('BACKUP',bak)
print('PATCH VERIFIED - SAFE TO RESTART PM2')
