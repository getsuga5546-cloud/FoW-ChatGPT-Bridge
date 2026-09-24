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

# Current production landmarks.
for req in (
    'new SlashCommandBuilder().setName("isolation_override")',
    'function setWarOperation(',
    'function areEquivalentClubNames(',
    'if (interaction.isModalSubmit()) {',
):
    if req not in s:
        die('required production landmark missing: '+req)

if 'isolation_override_bulk' in s:
    die('isolation_override_bulk already appears to be installed')

for req in ('ModalBuilder','TextInputBuilder','TextInputStyle','ActionRowBuilder'):
    if req not in s:
        die('Discord modal builder missing from production import: '+req)

# 1) Register separate command. Existing isolation_override remains untouched.
old_cmd='''  new SlashCommandBuilder().setName("isolation_override").setDescription("Master override: release selected clubs from all isolation").toJSON(),'''
new_cmd='''  new SlashCommandBuilder().setName("isolation_override").setDescription("Master override: release selected clubs from all isolation").toJSON(),
  new SlashCommandBuilder().setName("isolation_override_bulk").setDescription("Bulk release clubs from isolation using paste list").toJSON(),'''
once(old_cmd,new_cmd,'slash command registration')

# 2) Add command handler immediately before existing war_override handler.
handler_anchor='''    if (interaction.commandName === "war_override") {'''
handler_code=r'''    if (interaction.commandName === "isolation_override_bulk") {
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
once(handler_anchor,handler_code+handler_anchor,'bulk command handler')

# 3) Current production has one central modal block. Insert our handler at its top.
modal_anchor='''    if (interaction.isModalSubmit()) {
'''
modal_code=r'''    if (interaction.isModalSubmit()) {
      if(interaction.customId==='isolation_override_bulk_modal'){
        try{
          if(!isWarAdminInteraction(interaction)){
            await interaction.reply({content:'⛔ You are not authorized to manage isolation.',flags:MessageFlags.Ephemeral});
            return;
          }

          reloadLatestDatabase();

          const raw=interaction.fields.getTextInputValue('clubs');
          const lines=String(raw||'')
            .split(/\r?\n/)
            .map(x=>x.trim())
            .filter(Boolean);

          const found=[];
          const missing=[];
          const seen=new Set();

          for(const source of lines){
            const cleaned=String(source)
              .replace(/^[-•*\d.)\s]+/,'')
              .replace(/\s*\(\s*\d{3,5}\s*\).*$/,'')
              .replace(/\s+-\s+[^\n]+$/,'')
              .trim();
            if(!cleaned) continue;

            const db=leaderboardData.find(x=>
              areEquivalentClubNames(x.club,cleaned)
            );
            if(!db){
              missing.push(cleaned);
              continue;
            }

            const key=normalizeClubName(db.club);
            if(seen.has(key)) continue;
            seen.add(key);
            found.push(db);
          }

          const released=[];
          for(const db of found){
            const existing=getWarOperation(db.club);
            const op=setWarOperation(db.club,{
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
            content+='🟢 **AVAILABLE ('+released.length+')**\n'+
              released.map(x=>'• '+x).join('\n');
          }else{
            content+='No clubs were released.';
          }
          if(missing.length){
            content+='\n\n⚠️ **NOT FOUND ('+missing.length+')**\n'+
              missing.map(x=>'• '+x).join('\n');
          }
          content+='\n\nMatchmaking isolation cleared for listed clubs.';

          await interaction.reply({content,flags:MessageFlags.Ephemeral});
        }catch(error){
          console.error('❌ Bulk isolation override submit error:',error);
          try{
            await interaction.reply({content:'❌ Bulk isolation override failed.',flags:MessageFlags.Ephemeral});
          }catch{}
        }
        return;
      }
'''
once(modal_anchor,modal_code,'modal submit handler')

p.write_text(s)
r=subprocess.run(['node','--check',str(p)],capture_output=True,text=True)
if r.returncode:
    die('node --check: '+(r.stderr or r.stdout).strip())

final=p.read_text()
checks=[
    ('bulk command',final.count('setName("isolation_override_bulk")')==1),
    ('bulk handler',final.count('interaction.commandName === "isolation_override_bulk"')==1),
    ('bulk modal submit',final.count("interaction.customId==='isolation_override_bulk_modal'")==1),
    ('existing isolation command preserved',final.count('setName("isolation_override")')==1),
    ('war override preserved',final.count('interaction.commandName === "war_override"')==1),
    ('central modal block preserved',final.count('if (interaction.isModalSubmit()) {')==1),
]
print('=== ISOLATION OVERRIDE BULK PASTE PATCH V2 ===')
for name,ok in checks:
    print('PASS' if ok else 'FAIL',name)
if not all(ok for _,ok in checks):
    die('final verification')
print('PASS node --check')
print('BACKUP',bak)
print('PATCH VERIFIED - SAFE TO RESTART PM2')
