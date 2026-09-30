# FoW ELO Bot — HS V2 Operations Guide

Last updated: 25 September 2026 (Asia/Kuala_Lumpur)

## Safety rules

- A preview or draft does not change production.
- Production changes happen only after a confirmation button is pressed.
- Do not press `START PREPARATION`, `CONFIRM & SEND`, `CONFIRM EDIT`, or cancellation confirmation unless the production action is intended.
- Match IDs that are already in `WAR_ACTIVE` or `KO_ACTIVE` cannot be cancelled through the normal cancellation flow.

## 1. Live War Status dashboard — ACTIVE

Examples:

```text
War status
Send me war status again
Show war status derby club
```

The bot opens a deterministic live dashboard with Previous, Next, and Refresh controls. AI prose is not used for the list.

## 2. Create Matchmaking — ACTIVE

Example:

```text
Create matchmaking 6756 to 6269
```

The range is normalized automatically. The bot uses available Derby clubs only and produces a preview. Choose `HIGH`, `MID`, `LOW`, or `ADDITIONAL`, then press `CONFIRM & SEND` only when a real Match ID should be created.

## 3. Modify a Matchmaking draft — ACTIVE

Send follow-up instructions before confirming the draft:

```text
Skip Mystic Mage
Neverland must win
Peace Keeper must lose
Regenerate
```

Multiple instructions can be sent together:

```text
Skip Mystic Mage, Neverland must win, Peace Keeper must lose
```

Partial names and small typos are accepted only when one unique club can be identified.

## 4. Direct opponent replacement in a draft — ACTIVE

Examples:

```text
Pair Force of War VIII with FoW Jewelry Brigade
Change Magslingers opponent to Force of War IV
```

Both clubs must be available, inside the draft range, and no more than 100 ELO apart. The requested pair is fixed and all remaining pairs are repaired automatically.

## 5. Edit a saved Match ID — ACTIVE

Example:

```text
Edit HS135, pair Club A with Club B
```

Both clubs must already exist in the same saved Match ID and come from different pairs. The bot previews the requested pair and the repaired opponent pair. Press `CONFIRM EDIT` to save. Editing is blocked after preparation or war isolation begins.

## 6. Start Preparation — ACTIVE

After a Match ID is published, use its `START PREPARATION` control. Review the eligible, failed, released, and skipped clubs before confirming. Preparation isolates the applicable clubs and starts the event timer.

## 7. War Monitor — ACTIVE

The start view shows Club Name, ELO, event, status, isolation, and preparation timing. After war becomes active, reminders provide:

- `ACKNOWLEDGE`
- `CHECK SOON` (15, 30, 45, or 60 minutes)
- `WAR DONE`

`ACKNOWLEDGE` confirms the war is still active and keeps the normal reminder cycle. `CHECK SOON` postpones the next check by the selected 15, 30, 45, or 60 minutes. `WAR DONE` always opens a confirmation flow: Lightning and Grease release the club and isolation immediately after confirmation, while Normal changes the club to `AWAITING COOLING TIME` and asks for the Cooling Time before final release. Asking how these controls work is read-only and never changes production.

## 7A. Match ID live operational status — ACTIVE

Examples:

```text
Show timers for HS135
Check war status HS135
Show status HS135
```

The bot returns deterministic live data for the saved plan, active timers, club war operations, remaining time, and next reminder. This query is read-only and does not use AI-generated operational values.

## 7B. Natural War Done — ACTIVE

Examples:

```text
Mark FoW Example war done
War done for FoW Example
```

The bot validates the live club and war operation, then displays a confirmation preview. Lightning and Grease release isolation immediately after confirmation. Normal changes to `AWAITING COOLING TIME` and opens the Cooling Time input. Sending the sentence alone never changes production.

## 8. Cancel Match ID and preparation operations — ACTIVE

Use `CANCEL MATCH ID` from Match Controls or `/cancel_matchmaking`.

When the Match ID is not started or is still in `PREPARATION`, confirmation will:

- mark the Match ID `CANCELLED`;
- stop linked preparation timers;
- remove linked preparation War Monitor state;
- cancel future reminders;
- release linked isolation;
- disable old controls;
- retain the historical audit record; and
- send a public cancellation notification.

Cancellation is blocked after `WAR_ACTIVE` or `KO_ACTIVE`. Use the normal War Done flow or an authorized master override instead.

## 8A. Natural Event Transition — ACTIVE

Examples:

```text
Start Lightning event
Change event to Grease Lightning
Close Lightning and start Normal
```

The bot shows the current and requested event mode before any change. Only the original requester with war-admin authority can press `CONFIRM EVENT CHANGE`. Event state is synchronized with Supabase after confirmation. A help question never triggers this action.

## 9. Missed Preparation / Batch Start War Now — ACTIVE

Use `START WAR NOW` from Match Controls when real wars started before `START PREPARATION` was pressed:

- run `DRY RUN` first to review the complete selected/excluded list and reminder timing without changing production;
- all Match ID clubs selected by default;
- `START ALL`, `EXCLUDE SOME`, or `PASTE EXCLUSIONS`;
- one shared batch start timestamp;
- selected clubs become `WAR_ACTIVE` and isolated;
- excluded clubs remain pending/available; and
- the first War Monitor reminder is scheduled two hours later.

All eligible clubs are selected by default. Unselect clubs that have not started, or use `PASTE EXCLUSIONS`. Confirmation marks selected clubs `WAR_ACTIVE`, isolates them, creates one shared batch timestamp, and schedules the first War Monitor reminder two hours later. Excluded clubs remain pending/available. The action is blocked if preparation, war, cancellation, or another isolation/timer already exists.

Always use `DRY RUN` before confirming `START WAR NOW`. It generates the complete selected/excluded and reminder preview without changing Match ID, timer, War Monitor, isolation, or Supabase state.

If clubs were excluded from the first batch, Match Controls shows `ADD WAR BATCH`. Use it when those pending clubs start later. Each additional batch receives its own start timestamp and first reminder schedule without changing clubs already in `WAR_ACTIVE`.

## Match ID lifecycle summary

```text
Draft -> Preview -> Confirm & Send -> Saved Match ID
Saved Match ID -> Edit allowed -> Start Preparation
Preparation -> War Active -> War Done -> Closed
Saved/Preparation -> Cancel All -> Cancelled
```

A cancelled Match ID is never reused. A rematch receives a new Match ID.
# Derby leaderboard

Ask naturally, for example `Show derby leaderboard`, `Send me the derby leaderboard`, `Give me derby rankings`, `Derby standings`, `Top derby clubs`, `Senarai ELO derby`, or `Paparkan kedudukan derby`.
The bot returns the live Derby leaderboard directly from production data, sorted from highest to lowest ELO. This output is deterministic and is not composed or rewritten by AI. Use the Previous, Next, and Refresh buttons to navigate or reload the current live data.

To limit the leaderboard to a specific ELO range, include the range in the request, for example `Show derby leaderboard 5000-5500`, `Derby rankings from 5000 to 5500`, or `Senarai derby antara 5000 dan 5500`. Reversed inputs such as `5500 to 5000` are normalized automatically.

The same deterministic behavior is available for the full leaderboard. Ask `Show leaderboard`, `Send me the ELO rankings`, or `Show leaderboard 5000-5500`. Without the word `derby`, the bot includes every club; with `derby`, it includes Derby clubs only.

## Live Lightning analysis — ACTIVE

Ask `Give me the latest Lightning analysis` or `Berikan saya analisis Lightning terkini`. While Lightning is still active, the output is clearly labelled `LIVE / IN PROGRESS` and is not presented as a final result. The deterministic report compares the event Derby baseline with current live ELO, shows the highest net gains, largest net drops, most active clubs by recorded changes, observation count, link coverage, remaining event time, and last recorded observation. Figures may change until the event ends; recorded ELO changes must not be described as confirmed war counts.

For gain analysis by opponent ELO gap, ask `Lightning ELO gain by gap` for bucket statistics or `Untuk Lightning gap 26-50, berapa kenaikan ELO?` for a specific range. The report includes linked gain observations, average, median, minimum, maximum, and top examples. `n` means linked gain observations, not confirmed war count.
