FoW ELO Bot v74 - Timer Recovery Fix

CHANGES FROM v73
- Fixes missing final KO / timer-ended notification after a Hostinger restart.
- Running timers are NOT modified, reset, extended, shortened, deleted, or recreated.
- Expired timers with sent.end != true are preserved during startup.
- After Discord becomes ready, the existing timer processor sends the final notification.
- Expired timers are removed only after the final notification is confirmed sent.
- All v73 stability/reconnect behavior and existing commands are preserved.

DEPLOYMENT
1. Deploy bot.js + package.json as usual.
2. Keep the existing environment variables.
3. Do not manually clear Supabase runtime state or timer JSON.
4. Existing active timers will restore with their original startAt/endAt values.

EXPECTED RECOVERY LOG
♻️ Timer recovery: preserved X expired timer(s) awaiting final notification.

Then, once Discord is ready, the normal processor should deliver the final timer message.
