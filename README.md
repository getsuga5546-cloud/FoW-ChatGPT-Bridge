# FoW-ChatGPT-Bridge
Bridge between ChatGPT and FoW ELO Bot for matchmaking, ELO update, and controlled war-state override requests.

Supported request schemas:
- `schemas/manual_matchmaking.schema.json`
- `schemas/elo_update.schema.json`
- `schemas/war_override.schema.json`

`war_override` is intended for a targeted Discord `/war_override club:<club>` flow that marks only the selected club AVAILABLE and requests its war timers/isolation state to be cleared without affecting other clubs.
