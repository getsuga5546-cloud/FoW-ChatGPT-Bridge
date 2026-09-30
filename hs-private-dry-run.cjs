'use strict';

const GUILD = '1254157821214326845';
const INPUT = '1256056255890587648';
const OUTPUT = '1550513884585005076';
const TARGETS = ['high', 'mid', 'low', 'additional'];
const TTL = 15 * 60 * 1000;
const HELP = '🧪 **PRIVATE DRY RUN**\nUse `create matchmaking 5500 to 6500`, then `send to high`, `mid`, `low`, or `additional`. Use `war status` for a read-only report.\nNo Match ID, database, event, timer, war or tracker changes. Production controls are disabled in these test channels.';
const payload = (content, components = []) => ({content, components, allowedMentions: {parse: [], repliedUser: false}});

// Only read/preview dependencies are injected. No persistence, production sender,
// event control, timer processor, or Match ID allocator is accessible here.
function createPrivateDryRun({parseMatchmaking, previewMatchmaking, formatPreview, warStatus, referencedElo, splitText, now = Date.now}) {
  const drafts = new Map();
  let sequence = 0;
  const scoped = item => String(item.guildId) === GUILD && [INPUT, OUTPUT].includes(String(item.channelId));
  const key = item => `${item.channelId}:${item.author?.id || item.user?.id}`;
  function current(item) {
    const cutoff = now() - TTL;
    for (const [id, draft] of drafts) if (draft.created < cutoff) drafts.delete(id);
    return drafts.get(key(item));
  }
  function controls(id) {
    return [{type: 1, components: TARGETS.map(target => ({type: 2, style: 2,
      custom_id: `hsdr:${id}:${target}`, label: `${target.toUpperCase()} — DRY RUN`}))}];
  }
  async function publish(client, label, text) {
    const channel = await client.channels.fetch(OUTPUT);
    if (String(channel?.id) !== OUTPUT || String(channel?.guildId) !== GUILD || typeof channel?.send !== 'function') {
      throw new Error('Private output channel unavailable or belongs to another server');
    }
    const report = `🧪 **${label} — PRIVATE DRY RUN**\nNo Match ID • No production data changed\n\n${text}`;
    for (const chunk of splitText(report, 1900)) await channel.send(payload(chunk));
  }
  async function sendDraft(item, target) {
    const draft = current(item);
    if (!draft) return 'No active dry-run preview. Create matchmaking first.';
    await publish(item.client, target.toUpperCase(), draft.text);
    return `✅ ${target.toUpperCase()} dry-run preview sent to <#${OUTPUT}>. No production action executed.`;
  }
  async function message(item) {
    if (!scoped(item)) return false;
    try {
      const text = String(item.content || '').replace(/^@hs\s*/i, '')
        .replace(new RegExp(`<@!?${item.client.user.id}>`, 'g'), '').trim();
      const elo = await referencedElo(item, text);
      if (elo) {
        for (const chunk of splitText(elo, 1900)) await item.reply(payload(chunk));
        return true;
      }
      if (/^(?:(?:show|send)(?: me)?\s+)?war\s+status[.!?]?$/i.test(text)) {
        await publish(item.client, 'WAR STATUS', warStatus());
        await item.reply(payload(`✅ Read-only War Status sent to <#${OUTPUT}>.`));
        return true;
      }
      const destination = text.match(/^send\s+to\s+(high|mid|low|additional)(?:\s+set)?[.!?]?$/i);
      if (destination) {
        await item.reply(payload(await sendDraft(item, destination[1].toLowerCase())));
        return true;
      }
      // Deliberately narrow grammar: mixed operational instructions cannot execute.
      if (/^(?:create\s+)?matchmaking\s+\d{4,5}\s*(?:to|-)\s*\d{4,5}[.!?]?$/i.test(text)) {
        const intent = parseMatchmaking(text);
        if (!intent) throw new Error('Invalid matchmaking range');
        const dry = previewMatchmaking(intent);
        const output = formatPreview(dry.result, dry.min, dry.max, dry.skipped || [], null);
        const id = `${now().toString(36)}-${++sequence}`;
        current(item);
        drafts.delete(key(item));
        const hasPairs = Boolean(dry.result?.pairs?.length);
        if (hasPairs) drafts.set(key(item), {id, text: output, created: now()});
        const chunks = splitText(`🧪 **MATCHMAKING PREVIEW — PRIVATE DRY RUN**\nNo Match ID • No production data changed\n\n${output}`, 1900);
        for (let index = 0; index < chunks.length; index++) {
          await item.reply(payload(chunks[index], hasPairs && index === chunks.length - 1 ? controls(id) : []));
        }
        return true;
      }
      await item.reply(payload(HELP));
    } catch (error) {
      console.error('Private dry-run request failed:', error.message);
      await item.reply(payload('❌ Dry run could not complete. Production routing was not invoked.')).catch(() => {});
    }
    return true;
  }
  async function interaction(item) {
    if (!scoped(item)) {
      if (!String(item.customId || '').startsWith('hsdr:')) return false;
      await item.reply({...payload('This dry-run control belongs to the private test channels.'), flags: 64});
      return true;
    }
    try {
      if (item.isAutocomplete()) { await item.respond([]); return true; }
      await item.deferReply({flags: 64});
      const match = String(item.customId || '').match(/^hsdr:([^:]+):(high|mid|low|additional)$/);
      if (match) {
        const draft = current(item);
        if (!draft || draft.id !== match[1]) {
          await item.editReply(payload('Preview expired or belongs to another user. Create your own preview.'));
        } else {
          await item.editReply(payload(await sendDraft(item, match[2])));
        }
      } else if (item.isChatInputCommand() && item.commandName === 'war_status') {
        await publish(item.client, 'WAR STATUS', warStatus());
        await item.editReply(payload(`✅ Read-only War Status sent to <#${OUTPUT}>.`));
      } else {
        await item.editReply(payload(HELP));
      }
    } catch (error) {
      console.error('Private dry-run interaction failed:', error.message);
      const reply = payload('❌ Dry run could not complete. Production routing was not invoked.');
      if (item.deferred || item.replied) await item.editReply(reply).catch(() => {});
      else await item.reply({...reply, flags: 64}).catch(() => {});
    }
    return true;
  }
  return {message, interaction};
}

module.exports = {createPrivateDryRun};
