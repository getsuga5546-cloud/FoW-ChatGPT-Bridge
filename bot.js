require("dotenv").config();

// FoW ELO Bot v79 — ChatGPT GitHub Bridge Phase 1 + v78 Production
// Production operations remain intact. AI test is isolated and never writes Match IDs/Supabase.
// v81.4 — Compact War UX + Isolation Dashboard + KO Match Controls + Custom Range Search
// Phase 1: English natural-language matchmaking interpretation + dry-run only.
// Match SUCCESS remains explicit via /match_success; /war_done never auto-marks success.

const fs = require("fs");
const path = require("path");
const https = require("https");
const express = require("express");
const { Pool } = require("pg");

// Optional Gemini dependency for AI-command fallback. Local parsing works without it.
let GoogleGenAI = null;
try {
  ({ GoogleGenAI } = require("@google/genai"));
} catch (error) {
  console.warn("⚠️ @google/genai is not installed. /ai_command_test will use LOCAL parser only until installed.");
}
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// HS Assistant Phase 5 — optional OpenAI hybrid fallback.
// Secret stays in .env; never hard-coded in bot.js.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const HS_OPENAI_MODEL = process.env.HS_OPENAI_MODEL || "gpt-5.4-mini";

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_BOT_ENABLED = String(process.env.DISCORD_BOT_ENABLED ?? "true").toLowerCase() !== "false";

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || "";

const GITHUB_OWNER =
  process.env.GITHUB_OWNER || "";

const GITHUB_REPO =
  process.env.GITHUB_REPO || "";

const GITHUB_BRANCH =
  process.env.GITHUB_BRANCH || "main";

const DATABASE_FILE = path.join(
  __dirname,
  "elo_database.json"
);

const DATABASE_BACKUP_FILE = path.join(
  __dirname,
  "elo_database_backup.json"
);

const DEFAULT_DATABASE_FILE = path.join(
  __dirname,
  "elo_database_default.json"
);

const PUSH_REMINDERS_FILE = path.join(
  __dirname,
  "push_reminders.json"
);

// Only these clubs are hard-coded as initial seeds.
// No old leaderboard snapshot is stored inside bot.js.
const DEFAULT_SEED_CLUBS = [
  { club: "FoW Evolution", president: "Evo Prez", elo: 6779 },
  { club: "FoW Southern Charm", president: "Charm Prez", elo: 6668 },
  { club: "FoW Iron Horn Brigade", president: "AK-131", elo: 6233 }
];

// ============================================================
// DATABASE SAFETY / SYNCHRONIZED DEFAULT DATABASE
// ============================================================
//
// elo_database.json          = LIVE database used by the bot
// elo_database_default.json  = latest synchronized default snapshot
// elo_database_backup.json   = previous live version before each save
//
// IMPORTANT:
// - No old full ELO snapshot is hard-coded in this bot.
// - DEFAULT_SEED_CLUBS only provides the 3 requested clubs if a database
//   has to be created from scratch.
// - Every successful database save overwrites BOTH the live database and
//   the default snapshot with the latest data.
// - New clubs, edited club/president names, and ELO updates therefore
//   become part of the latest default snapshot automatically.

// ============================================================
// DATABASE FUNCTIONS
// ============================================================

function cloneData(data) {
  return JSON.parse(
    JSON.stringify(data)
  );
}

function mergeMissingSeedClubs(data) {
  let changed = false;

  for (const seed of DEFAULT_SEED_CLUBS) {
    const exists = data.some(
      item =>
        normalizeClubName(item.club) ===
        normalizeClubName(seed.club)
    );

    if (!exists) {
      data.push(
        cloneData(seed)
      );

      changed = true;

      console.log(
        `➕ Default seed added: ${seed.club} (${seed.elo})`
      );
    }
  }

  return changed;
}

function writeDefaultSnapshot(data) {
  fs.writeFileSync(
    DEFAULT_DATABASE_FILE,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );

  console.log(
    "📌 elo_database_default.json synchronized"
  );
}

function loadJsonDatabase(filePath) {
  const raw = fs.readFileSync(
    filePath,
    "utf8"
  );

  const data = JSON.parse(raw);

  if (!Array.isArray(data)) {
    throw new Error(
      `${path.basename(filePath)} is not an array`
    );
  }

  return data;
}

function loadDatabase() {
  try {
    let data;

    if (fs.existsSync(DATABASE_FILE)) {
      data =
        loadJsonDatabase(
          DATABASE_FILE
        );

    } else if (
      fs.existsSync(
        DEFAULT_DATABASE_FILE
      )
    ) {
      console.warn(
        "⚠️ elo_database.json missing. Restoring from elo_database_default.json."
      );

      data =
        loadJsonDatabase(
          DEFAULT_DATABASE_FILE
        );

      fs.writeFileSync(
        DATABASE_FILE,
        JSON.stringify(
          data,
          null,
          2
        ),
        "utf8"
      );

      console.log(
        "♻️ elo_database.json restored from synchronized default"
      );

    } else {
      console.warn(
        "⚠️ No database files found. Creating a new database from DEFAULT_SEED_CLUBS only."
      );

      data =
        cloneData(
          DEFAULT_SEED_CLUBS
        );

      fs.writeFileSync(
        DATABASE_FILE,
        JSON.stringify(
          data,
          null,
          2
        ),
        "utf8"
      );

      writeDefaultSnapshot(
        data
      );

      console.log(
        "✅ New live/default databases created"
      );
    }

    // Add the 3 requested clubs only if missing.
    // Existing President/Pusher and ELO are NEVER overwritten here.
    const seedAdded =
      mergeMissingSeedClubs(
        data
      );

    if (seedAdded) {
      fs.writeFileSync(
        DATABASE_FILE,
        JSON.stringify(
          data,
          null,
          2
        ),
        "utf8"
      );
    }

    // At startup, default snapshot always becomes the latest live DB.
    writeDefaultSnapshot(
      data
    );

    return data;

  } catch (error) {
    console.error(
      "❌ Database load error:",
      error
    );

    throw error;
  }
}

let leaderboardData =
  loadDatabase();

// Always reload the latest LIVE database from disk before any write operation.
// This prevents stale in-memory data from overwriting newer server-side updates.
function reloadLatestDatabase() {
  leaderboardData =
    loadJsonDatabase(
      DATABASE_FILE
    );

  return leaderboardData;
}

function saveDatabase() {
  try {
    if (fs.existsSync(DATABASE_FILE)) {
      fs.copyFileSync(
        DATABASE_FILE,
        DATABASE_BACKUP_FILE
      );

      console.log(
        "🛡️ elo_database_backup.json updated"
      );
    }

    // Overwrite LIVE database with latest data.
    fs.writeFileSync(
      DATABASE_FILE,
      JSON.stringify(
        leaderboardData,
        null,
        2
      ),
      "utf8"
    );

    console.log(
      "💾 elo_database.json saved"
    );

    // Overwrite DEFAULT snapshot with the same latest data.
    // Therefore new clubs and ELO/name updates are preserved here too.
    writeDefaultSnapshot(
      leaderboardData
    );

    // Persist the authoritative Club / President / ELO database to Supabase.
    // This prevents Hostinger GitHub redeploys from rolling ELO values back
    // to an older elo_database.json bundled with the new build.
    if (typeof queueSupabaseStateSave === "function") {
      queueSupabaseStateSave(
        "elo_database",
        leaderboardData
      );
    }

    // Verify both files now contain the same number of records.
    const liveVerify =
      loadJsonDatabase(
        DATABASE_FILE
      );

    const defaultVerify =
      loadJsonDatabase(
        DEFAULT_DATABASE_FILE
      );

    if (
      liveVerify.length !==
      defaultVerify.length
    ) {
      throw new Error(
        "Live/default database sync verification failed"
      );
    }

    // Publish a read-only ChatGPT snapshot asynchronously.
    // GitHub failure must never affect the production database save.
    Promise.resolve()
      .then(() => publishChatgptEloSnapshot("database save"))
      .catch(error => {
        console.error(
          "⚠️ ChatGPT snapshot queue error:",
          error?.message || error
        );
      });

    return true;

  } catch (error) {
    console.error(
      "❌ Database save error:",
      error
    );

    return false;
  }
}

// ============================================================
// NORMALIZE CLUB NAME
// ============================================================

function normalizeClubName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /[^a-z0-9]/g,
      ""
    );
}

// ============================================================
// ALIASES
// ============================================================

// Alias-only normalization.
// Converts superscript numbers before normal club-name normalization.
// This lets "FoW Eternal Wanderer³" resolve to "FoW Eternal Wanderer 3"
// without changing names stored in elo_database.json.
function normalizeClubAliasKey(name) {
  return normalizeClubName(
    String(name || "")
      .replace(/¹/g, "1")
      .replace(/²/g, "2")
      .replace(/³/g, "3")
  );
}

const clubAliases = {
  fowbope: "FoW Bope",
  fowbluecrown: "FoW Blue Crown",

  forceofwar2: "Force Of War II",
  forceofwarii: "Force Of War II",

  forceofwar3: "Force of War III",
  forceofwariii: "Force of War III",

  forceofwar4: "Force of War IV",
  forceofwariv: "Force of War IV",

  forceofwar5: "Force Of War V",
  forceofwarv: "Force Of War V",

  forceofwar6: "Force of War VI",
  forceofwarvi: "Force of War VI",

  forceofwar7: "Force Of War VII",
  forceofwarvii: "Force Of War VII",

  forceofwar8: "Force of War VIII",
  forceofwarviii: "Force of War VIII",

  forceofwar9: "Force of War IX",
  forceofwarix: "Force of War IX",

  forceofwar10: "Force of War X",
  forceofwarx: "Force of War X",

  twistoffate: "Twist Of Fate",

  // BlackSite spelling variants
  fowl3lacksiite: "FoW BlackSite",
  fowblacksiite: "FoW BlackSite",
  fowblacksite: "FoW BlackSite",

  // BlackSite II spelling variants
  fowl3lacksiiteii: "FoW BlackSite II",
  fowblacksiiteii: "FoW BlackSite II",
  fowblacksiteii: "FoW BlackSite II",

  // Eternal Wanderer variants
  foweternalwanderer2: "FoW Eternal Wanderer 2",
  foweternalwanderer3: "FoW Eternal Wanderer 3",
  foweternalwanderers: "FoW Eternal Wanderer",

  // Neverland variants
  fowneverlandii: "FoW Neverland 2",
  fowneverland2: "FoW Neverland 2",

  // Sentinels 4 / IV variants
  fowsentinels4: "FoW Sentinels 4",
  fowsentinelsiv: "FoW Sentinels 4",
  sentinelsiv: "FoW Sentinels 4",
  fowsentineliv: "FoW Sentinels 4",
  sentinels4: "FoW Sentinels 4",
  sentinel4: "FoW Sentinels 4"
};

function areEquivalentClubNames(nameA, nameB) {
  const a =
    normalizeClubName(nameA);

  const b =
    normalizeClubName(nameB);

  if (a === b) {
    return true;
  }

  // Bidirectional equivalence:
  // FoW Neverland II <-> FoW Neverland 2
  const neverlandNames =
    new Set([
      "fowneverlandii",
      "fowneverland2"
    ]);

  if (
    neverlandNames.has(a) &&
    neverlandNames.has(b)
  ) {
    return true;
  }

  // Bidirectional equivalence:
  // FoW Sentinels 4 / FoW Sentinels IV / Sentinels IV /
  // FoW Sentinel IV / Sentinels 4 / Sentinel 4
  const sentinels4Names =
    new Set([
      "fowsentinels4",
      "fowsentinelsiv",
      "sentinelsiv",
      "fowsentineliv",
      "sentinels4",
      "sentinel4"
    ]);

  if (
    sentinels4Names.has(a) &&
    sentinels4Names.has(b)
  ) {
    return true;
  }

  return false;
}

function findClubIndex(inputName) {
  const rawInput =
    String(inputName || "").trim();

  const superscriptAliases = {
    "FoW Eternal Wanderer²": "FoW Eternal Wanderer 2",
    "FoW Eternal Wanderer³": "FoW Eternal Wanderer 3"
  };

  const superscriptTarget =
    superscriptAliases[rawInput];

  if (superscriptTarget) {
    const superscriptIndex =
      leaderboardData.findIndex(
        item =>
          normalizeClubName(item.club) ===
          normalizeClubName(superscriptTarget)
      );

    if (superscriptIndex !== -1) {
      return superscriptIndex;
    }
  }

  const normalizedInput =
    normalizeClubName(inputName);

  let index =
    leaderboardData.findIndex(
      item =>
        areEquivalentClubNames(
          item.club,
          inputName
        )
    );

  if (index !== -1) {
    return index;
  }

  const aliasKey =
    normalizeClubAliasKey(
      inputName
    );

  const aliasTarget =
    clubAliases[
      aliasKey
    ];

  if (aliasTarget) {
    index =
      leaderboardData.findIndex(
        item =>
          normalizeClubName(
            item.club
          ) ===
          normalizeClubName(
            aliasTarget
          )
      );
  }

  return index;
}

// ============================================================
// SORT / FILTER
// ============================================================

function getSortedLeaderboard() {
  return [...leaderboardData]
    .sort(
      (a, b) =>
        Number(b.elo) -
        Number(a.elo)
    );
}

function getFilteredLeaderboard(
  min,
  max
) {
  return getSortedLeaderboard()
    .filter(
      item =>
        Number(item.elo) >=
          Number(min) &&
        Number(item.elo) <=
          Number(max)
    );
}


// ============================================================
// FOW PUSH / WAR DONE TIMER SYSTEM
// ============================================================
//
// /push
//   - choose 6h or 12h preparation timer
//   - select one or more clubs
//   - reminder: 15 minutes before end
//   - final notification at preparation end
//   - STOP. No KO timer starts automatically.
//
// /war_done
//   - used manually after the war is actually completed
//   - choose either:
//       2h KO Timer
//       14h KO + Cooling Down Timer
//   - select one or more clubs
//   - reminder: 15 minutes before end
//   - final notification at timer end
//
// Active timers are persisted in fow_timers.json so server/bot restarts
// do not lose the schedule. Interactive /push, /war_done and
// /war_done_manual setup selections are persisted separately in
// fow_timer_setup_sessions.json for the same restart protection.
//


// ============================================================
// SUPABASE / POSTGRES PERSISTENT BOT STATE
// ============================================================
// Hostinger uses versioned deployments, so JSON files inside the build
// directory are not reliable across redeploys. Supabase is the primary
// persistence layer for active timers and interactive setup sessions.
// Local JSON files are still kept as a runtime fallback/debug snapshot.

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "";
let supabasePool = null;
let supabasePersistenceReady = false;
const supabaseStateWriteChains = new Map();

let discordInstanceLockClient = null;
const DISCORD_INSTANCE_LOCK_KEY_1 = 70421;
const DISCORD_INSTANCE_LOCK_KEY_2 = 26573;

async function acquireDiscordInstanceLock() {
  if (!supabasePersistenceReady || !supabasePool) {
    console.error("🛑 Supabase is unavailable, so the Discord single-instance lock cannot be verified. Discord login is blocked to prevent duplicate bot instances.");
    return false;
  }

  try {
    discordInstanceLockClient = await supabasePool.connect();
    const result = await discordInstanceLockClient.query(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [DISCORD_INSTANCE_LOCK_KEY_1, DISCORD_INSTANCE_LOCK_KEY_2]
    );

    if (result.rows[0]?.locked === true) {
      console.log("🔒 Discord leader lock acquired. This process owns Discord + timer notifications.");

      // The advisory lock lives on this dedicated PostgreSQL connection.
      // If that connection is ever lost, the lock is released by PostgreSQL.
      // Exit this process rather than risk continuing as a second Discord bot.
      discordInstanceLockClient.once("error", error => {
        console.error(
          "🛑 Discord leader-lock connection lost. Stopping this process to prevent duplicate bot instances:",
          error?.message || error
        );
        discordInstanceLockClient = null;
        try { client.destroy(); } catch {}
        setTimeout(() => process.exit(1), 500);
      });

      return true;
    }

    discordInstanceLockClient.release();
    discordInstanceLockClient = null;
    console.warn("🛑 Another FoW bot instance is already active. This process will NOT log in to Discord.");
    return false;
  } catch (error) {
    if (discordInstanceLockClient) {
      try { discordInstanceLockClient.release(); } catch {}
      discordInstanceLockClient = null;
    }
    console.error("❌ Failed to acquire Discord single-instance lock:", error.message || error);
    return false;
  }
}

async function releaseDiscordInstanceLock() {
  if (!discordInstanceLockClient) return;
  try {
    await discordInstanceLockClient.query(
      "SELECT pg_advisory_unlock($1, $2)",
      [DISCORD_INSTANCE_LOCK_KEY_1, DISCORD_INSTANCE_LOCK_KEY_2]
    );
  } catch {}
  try { discordInstanceLockClient.release(); } catch {}
  discordInstanceLockClient = null;
}

async function initSupabasePersistence() {
  if (!SUPABASE_DB_URL) {
    console.warn("⚠️ SUPABASE_DB_URL is not set. Runtime state will use local JSON only.");
    return false;
  }

  try {
    supabasePool = new Pool({
      connectionString: SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });

    await supabasePool.query("SELECT 1");
    await supabasePool.query(`
      CREATE TABLE IF NOT EXISTS fow_bot_state (
        state_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    supabasePersistenceReady = true;
    console.log("✅ Supabase persistent state connected.");
    return true;
  } catch (error) {
    supabasePersistenceReady = false;
    console.error("❌ Supabase persistent state connection failed:", error.message || error);
    return false;
  }
}

async function loadSupabaseState(stateKey) {
  if (!supabasePersistenceReady || !supabasePool) return null;
  try {
    const result = await supabasePool.query(
      "SELECT payload FROM fow_bot_state WHERE state_key = $1 LIMIT 1",
      [stateKey]
    );
    return result.rows[0]?.payload ?? null;
  } catch (error) {
    console.error(`❌ Failed to load Supabase state ${stateKey}:`, error.message || error);
    return null;
  }
}

function queueSupabaseStateSave(stateKey, payload) {
  if (!supabasePersistenceReady || !supabasePool) return;

  const previous = supabaseStateWriteChains.get(stateKey) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await supabasePool.query(
        `INSERT INTO fow_bot_state (state_key, payload, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (state_key)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [stateKey, JSON.stringify(payload)]
      );
    })
    .catch(error => {
      console.error(`❌ Failed to save Supabase state ${stateKey}:`, error.message || error);
    });

  supabaseStateWriteChains.set(stateKey, next);
}

async function flushSupabaseStateSave(stateKey) {
  const pending = supabaseStateWriteChains.get(stateKey);
  if (pending) {
    await pending;
  }
}

async function restoreSupabaseRuntimeStateToLocalFiles() {
  if (!supabasePersistenceReady) return;

  const mappings = [
    ["active_fow_timers", FOW_TIMERS_FILE],
    ["timer_setup_sessions", FOW_TIMER_SETUP_SESSIONS_FILE],
    ["matchmaking_sessions", MATCHMAKING_SESSIONS_FILE]
  ];

  let restored = 0;
  for (const [stateKey, filePath] of mappings) {
    const payload = await loadSupabaseState(stateKey);
    if (payload == null) continue;
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
      restored += 1;
    } catch (error) {
      console.error(`❌ Failed to stage Supabase state ${stateKey} locally:`, error);
    }
  }

  if (restored) {
    console.log(`💾 Supabase runtime state snapshots restored: ${restored}`);
  } else {
    console.log("ℹ️ No existing Supabase runtime state snapshots found yet.");
  }
}

// ============================================================
// TIMER REMINDER USER MENTIONS
// Notifications will mention ONLY these two Discord users.
// Timer creator is intentionally NOT mentioned.
// ============================================================

const FOW_TIMER_REMINDER_USER_IDS = [
  "1260999303657295912", // 💙ђєคгՇɭคภ๔💙
  "1187537105174413332"  // ḠƹƮƧƲḠƛ
];

const FOW_TIMERS_FILE =
  path.join(
    __dirname,
    "fow_timers.json"
  );

// Persistent interactive setup state for /push, /war_done and
// /war_done_manual. This keeps club selections available after
// a bot process restart, as long as Hostinger preserves this file.
const FOW_TIMER_SETUP_SESSIONS_FILE =
  path.join(
    __dirname,
    "fow_timer_setup_sessions.json"
  );

const fowTimerSetupSessions =
  new Map();

// /delete_club interactive sessions.
const deleteClubSessions =
  new Map();

const DELETE_CLUB_SESSION_TTL =
  30 * 60 * 1000;

function createDeleteClubSessionId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function cleanupDeleteClubSessions() {
  const now =
    Date.now();

  for (
    const [
      id,
      session
    ] of deleteClubSessions
  ) {
    if (
      now -
      Number(session.updatedAt || 0) >
      DELETE_CLUB_SESSION_TTL
    ) {
      deleteClubSessions.delete(
        id
      );
    }
  }
}

function getDeleteClubPageCount(
  session
) {
  return Math.max(
    1,
    Math.ceil(
      session.clubs.length / 25
    )
  );
}

function getDeleteClubPageItems(
  session
) {
  const start =
    session.page * 25;

  return session.clubs.slice(
    start,
    start + 25
  );
}

function buildDeleteClubView(
  session
) {
  const pageCount =
    getDeleteClubPageCount(
      session
    );

  session.page =
    Math.max(
      0,
      Math.min(
        session.page,
        pageCount - 1
      )
    );

  const pageItems =
    getDeleteClubPageItems(
      session
    );

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        `dc_select:${session.id}`
      )
      .setPlaceholder(
        "Select one or more clubs to delete"
      )
      .setMinValues(0)
      .setMaxValues(Math.max(1, pageItems.length))
      .addOptions(
        pageItems.map(
          item => ({
            label:
              String(item.club)
                .slice(0, 100),
            description:
              `ELO ${item.elo} • ${item.president || "No President"}`
                .slice(0, 100),
            value:
              normalizeClubName(
                item.club
              ),
            default:
              session.selectedKeys instanceof Set &&
              session.selectedKeys.has(normalizeClubName(item.club))
          })
        )
      );

  const selectRow =
    new ActionRowBuilder()
      .addComponents(
        menu
      );

  const buttons =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `dc_prev:${session.id}`
          )
          .setLabel(
            "Previous"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page <= 0
          ),
        new ButtonBuilder()
          .setCustomId(
            `dc_next:${session.id}`
          )
          .setLabel(
            "Next"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page >=
            pageCount - 1
          ),
        new ButtonBuilder()
          .setCustomId(
            `dc_confirm:${session.id}`
          )
          .setLabel(
            "DELETE SELECTED"
          )
          .setStyle(
            ButtonStyle.Danger
          )
          .setDisabled(!(session.selectedKeys instanceof Set) || session.selectedKeys.size === 0),
        new ButtonBuilder()
          .setCustomId(
            `dc_cancel:${session.id}`
          )
          .setLabel(
            "Cancel"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    content:
      `🗑️ **DELETE CLUB**\n\n` +
      `Select one or more clubs to delete.\n` +
      `Page **${session.page + 1}/${pageCount}** • ` +
      `Clubs: **${session.clubs.length}** • Selected: **${session.selectedKeys instanceof Set ? session.selectedKeys.size : 0}**`,
    components: [
      selectRow,
      buttons
    ]
  };
}


// /derby_add_club and /derby_remove_club interactive sessions.
const derbyManageSessions =
  new Map();

const DERBY_MANAGE_SESSION_TTL =
  30 * 60 * 1000;

function createDerbyManageSessionId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function cleanupDerbyManageSessions() {
  const now =
    Date.now();

  for (
    const [
      id,
      session
    ] of derbyManageSessions
  ) {
    if (
      now -
      Number(session.updatedAt || 0) >
      DERBY_MANAGE_SESSION_TTL
    ) {
      derbyManageSessions.delete(
        id
      );
    }
  }
}

function getDerbyManagePageCount(
  session
) {
  return Math.max(
    1,
    Math.ceil(
      session.clubs.length / 25
    )
  );
}

function getDerbyManagePageItems(
  session
) {
  const start =
    session.page * 25;

  return session.clubs.slice(
    start,
    start + 25
  );
}

function buildDerbyManageView(
  session
) {
  const pageCount =
    getDerbyManagePageCount(
      session
    );

  session.page =
    Math.max(
      0,
      Math.min(
        session.page,
        pageCount - 1
      )
    );

  const pageItems =
    getDerbyManagePageItems(
      session
    );

  const isAdd =
    session.mode === "add";

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        `dm_select:${session.id}`
      )
      .setPlaceholder(
        isAdd
          ? "Select clubs to ADD to Derby"
          : "Select clubs to REMOVE from Derby"
      )
      .setMinValues(0)
      .setMaxValues(Math.max(1, pageItems.length))
      .addOptions(
        pageItems.map(
          item => ({
            label:
              String(item.club)
                .slice(0, 100),
            description:
              `ELO ${item.elo} • ${item.president || "No President"}`
                .slice(0, 100),
            value:
              normalizeClubName(
                item.club
              ),
            default:
              session.selectedKeys instanceof Set &&
              session.selectedKeys.has(normalizeClubName(item.club))
          })
        )
      );

  const selectRow =
    new ActionRowBuilder()
      .addComponents(
        menu
      );

  const buttons =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `dm_prev:${session.id}`
          )
          .setLabel("Previous")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page <= 0
          ),
        new ButtonBuilder()
          .setCustomId(
            `dm_next:${session.id}`
          )
          .setLabel("Next")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page >=
            pageCount - 1
          ),
        new ButtonBuilder()
          .setCustomId(
            `dm_confirm:${session.id}`
          )
          .setLabel(
            isAdd ? "ADD SELECTED" : "REMOVE SELECTED"
          )
          .setStyle(
            isAdd ? ButtonStyle.Success : ButtonStyle.Danger
          )
          .setDisabled(
            !(session.selectedKeys instanceof Set) || session.selectedKeys.size === 0
          ),
        new ButtonBuilder()
          .setCustomId(
            `dm_cancel:${session.id}`
          )
          .setLabel("Cancel")
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    content:
      (isAdd
        ? `🏇 **ADD CLUBS TO DERBY LIST**\n\nSelect one or more clubs that are currently **OUT** of the Derby list.`
        : `🚫 **REMOVE CLUBS FROM DERBY LIST**\n\nSelect one or more clubs that are currently **IN** the Derby list.`) +
      `\nPage **${session.page + 1}/${pageCount}** • ` +
      `Available choices: **${session.clubs.length}** • ` +
      `Selected: **${session.selectedKeys instanceof Set ? session.selectedKeys.size : 0}**`,
    components: [
      selectRow,
      buttons
    ],
    flags:
      MessageFlags.Ephemeral
  };
}

const FOW_TIMER_PAGE_SIZE = 25;
const FOW_TIMER_SESSION_TTL_MS =
  30 * 60 * 1000;

function serializeFowTimerSetupSession(
  session
) {
  return {
    id: session.id,
    userId: session.userId,
    channelId: session.channelId,
    guildId: session.guildId,
    type: session.type,
    hours: session.hours,
    warDoneMode: session.warDoneMode,
    pushMode: session.pushMode || null,
    operationalMode: session.operationalMode || null,
    durationMinutes: session.durationMinutes,
    minElo: session.minElo,
    maxElo: session.maxElo,
    matchId: session.matchId || null,
    clubs: Array.isArray(session.clubs)
      ? session.clubs
      : [],
    selected: Array.from(
      session.selected instanceof Set
        ? session.selected
        : []
    ),
    page: Number(session.page) || 0,
    createdAt: Number(session.createdAt) || Date.now(),
    updatedAt: Number(session.updatedAt) || Date.now()
  };
}

function saveFowTimerSetupSessions() {
  try {
    const sessions =
      Array.from(
        fowTimerSetupSessions.values()
      ).map(
        serializeFowTimerSetupSession
      );

    fs.writeFileSync(
      FOW_TIMER_SETUP_SESSIONS_FILE,
      JSON.stringify(
        sessions,
        null,
        2
      ),
      "utf8"
    );

    queueSupabaseStateSave("timer_setup_sessions", sessions);
  } catch (error) {
    console.error(
      "❌ Failed to save fow_timer_setup_sessions.json:",
      error
    );
  }
}

// Persist an individual timer setup session as its own Supabase row.
// This avoids stale whole-array snapshots when two Discord component
// interactions are handled close together (or by different app workers).
async function persistFowTimerSetupSession(session) {
  saveFowTimerSetupSessions();

  if (!session || !supabasePersistenceReady || !supabasePool) return;

  const payload = serializeFowTimerSetupSession(session);
  try {
    await supabasePool.query(
      `INSERT INTO fow_bot_state (state_key, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (state_key)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [`timer_setup_session:${session.id}`, JSON.stringify(payload)]
    );
  } catch (error) {
    console.error(`❌ Failed to persist timer setup session ${session.id}:`, error.message || error);
  }
}

async function loadFowTimerSetupSessionFromSupabase(sessionId) {
  if (!supabasePersistenceReady || !supabasePool) return null;
  try {
    const result = await supabasePool.query(
      "SELECT payload FROM fow_bot_state WHERE state_key = $1 LIMIT 1",
      [`timer_setup_session:${sessionId}`]
    );
    return hydrateFowTimerSetupSession(result.rows[0]?.payload ?? null);
  } catch (error) {
    console.error(`❌ Failed to load timer setup session ${sessionId}:`, error.message || error);
    return null;
  }
}

async function deleteFowTimerSetupSessionPersistent(sessionId) {
  fowTimerSetupSessions.delete(sessionId);
  saveFowTimerSetupSessions();

  if (!supabasePersistenceReady || !supabasePool) return;
  try {
    await supabasePool.query(
      "DELETE FROM fow_bot_state WHERE state_key = $1",
      [`timer_setup_session:${sessionId}`]
    );
  } catch (error) {
    console.error(`❌ Failed to delete timer setup session ${sessionId}:`, error.message || error);
  }
}

function hydrateFowTimerSetupSession(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !raw.id ||
    !raw.userId
  ) {
    return null;
  }

  const updatedAt = Number(raw.updatedAt || 0);
  const now = Date.now();

  if (
    !Number.isFinite(updatedAt) ||
    now - updatedAt > FOW_TIMER_SESSION_TTL_MS
  ) {
    return null;
  }

  return {
    id: String(raw.id),
    userId: String(raw.userId),
    channelId: raw.channelId ? String(raw.channelId) : null,
    guildId: raw.guildId ? String(raw.guildId) : null,
    type: String(raw.type || "push"),
    hours: Number(raw.hours) || 0,
    warDoneMode: raw.warDoneMode || null,
    pushMode: raw.pushMode || null,
    operationalMode: raw.operationalMode || null,
    durationMinutes:
      raw.durationMinutes == null
        ? null
        : Number(raw.durationMinutes),
    minElo: Number(raw.minElo) || 0,
    maxElo: Number(raw.maxElo) || 0,
    matchId: raw.matchId ? normalizeMatchId(raw.matchId) : null,
    clubs: Array.isArray(raw.clubs) ? raw.clubs : [],
    selected: new Set(
      Array.isArray(raw.selected)
        ? raw.selected.map(value => String(value))
        : []
    ),
    page: Math.max(0, Number(raw.page) || 0),
    createdAt: Number(raw.createdAt) || updatedAt,
    updatedAt
  };
}

async function recoverFowTimerSetupSession(sessionId) {
  let best = fowTimerSetupSessions.get(sessionId) || null;

  // Prefer the newest per-session Supabase snapshot. This is important on
  // Hostinger because consecutive Discord interactions can be handled after
  // a process recycle or against a worker whose in-memory Map is stale.
  const remoteSingle = await loadFowTimerSetupSessionFromSupabase(sessionId);
  if (
    remoteSingle &&
    (!best || Number(remoteSingle.updatedAt || 0) >= Number(best.updatedAt || 0))
  ) {
    best = remoteSingle;
    fowTimerSetupSessions.set(best.id, best);
  }

  if (best) return best;

  // Recover from the local runtime snapshot.
  try {
    if (fs.existsSync(FOW_TIMER_SETUP_SESSIONS_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(FOW_TIMER_SETUP_SESSIONS_FILE, "utf8")
      );

      if (Array.isArray(parsed)) {
        const raw = parsed.find(
          item => item && String(item.id) === String(sessionId)
        );
        const recovered = hydrateFowTimerSetupSession(raw);
        if (recovered) {
          fowTimerSetupSessions.set(recovered.id, recovered);
          console.log(`♻️ Timer setup session ${sessionId} recovered from local snapshot.`);
          return recovered;
        }
      }
    }
  } catch (error) {
    console.error("❌ Local timer setup session recovery failed:", error);
  }

  // Backward compatibility with the older aggregate Supabase snapshot.
  if (supabasePersistenceReady) {
    try {
      const remote = await loadSupabaseState("timer_setup_sessions");
      if (Array.isArray(remote)) {
        const raw = remote.find(
          item => item && String(item.id) === String(sessionId)
        );
        const recovered = hydrateFowTimerSetupSession(raw);
        if (recovered) {
          fowTimerSetupSessions.set(recovered.id, recovered);
          await persistFowTimerSetupSession(recovered);
          console.log(`☁️ Timer setup session ${sessionId} recovered from Supabase.`);
          return recovered;
        }
      }
    } catch (error) {
      console.error("❌ Supabase timer setup session recovery failed:", error);
    }
  }

  return null;
}

function loadFowTimerSetupSessions() {
  try {
    if (
      !fs.existsSync(
        FOW_TIMER_SETUP_SESSIONS_FILE
      )
    ) {
      fs.writeFileSync(
        FOW_TIMER_SETUP_SESSIONS_FILE,
        "[]",
        "utf8"
      );

      return;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          FOW_TIMER_SETUP_SESSIONS_FILE,
          "utf8"
        )
      );

    if (!Array.isArray(parsed)) {
      throw new Error(
        "Setup sessions file must contain an array."
      );
    }

    const now = Date.now();
    let restored = 0;
    let removed = 0;

    fowTimerSetupSessions.clear();

    for (const raw of parsed) {
      if (
        !raw ||
        typeof raw !== "object" ||
        !raw.id ||
        !raw.userId
      ) {
        removed += 1;
        continue;
      }

      const updatedAt =
        Number(raw.updatedAt || 0);

      if (
        !Number.isFinite(updatedAt) ||
        now - updatedAt >
          FOW_TIMER_SESSION_TTL_MS
      ) {
        removed += 1;
        continue;
      }

      const selected =
        new Set(
          Array.isArray(raw.selected)
            ? raw.selected.map(
                value =>
                  String(value)
              )
            : []
        );

      const session = {
        id: String(raw.id),
        userId: String(raw.userId),
        channelId: raw.channelId
          ? String(raw.channelId)
          : null,
        guildId: raw.guildId
          ? String(raw.guildId)
          : null,
        type: String(raw.type || "push"),
        hours: Number(raw.hours) || 0,
        warDoneMode:
          raw.warDoneMode || null,
        pushMode: raw.pushMode || null,
        operationalMode: raw.operationalMode || null,
        matchId: raw.matchId ? normalizeMatchId(raw.matchId) : null,
        durationMinutes:
          raw.durationMinutes == null
            ? null
            : Number(raw.durationMinutes),
        minElo: Number(raw.minElo) || 0,
        maxElo: Number(raw.maxElo) || 0,
        clubs: Array.isArray(raw.clubs)
          ? raw.clubs
          : [],
        selected,
        page: Math.max(
          0,
          Number(raw.page) || 0
        ),
        createdAt:
          Number(raw.createdAt) ||
          updatedAt,
        updatedAt
      };

      fowTimerSetupSessions.set(
        session.id,
        session
      );

      restored += 1;
    }

    // Rewrite the file after startup so expired/corrupt entries are removed.
    saveFowTimerSetupSessions();

    console.log(
      `💾 Timer setup sessions restored: ${restored}` +
      (removed
        ? ` • removed expired/invalid: ${removed}`
        : "")
    );
  } catch (error) {
    console.error(
      "❌ Failed to load fow_timer_setup_sessions.json:",
      error
    );

    fowTimerSetupSessions.clear();
  }
}

loadFowTimerSetupSessions();

function loadFowTimers() {
  try {
    if (
      !fs.existsSync(
        FOW_TIMERS_FILE
      )
    ) {
      fs.writeFileSync(
        FOW_TIMERS_FILE,
        "[]",
        "utf8"
      );

      return [];
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          FOW_TIMERS_FILE,
          "utf8"
        )
      );

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch (error) {
    console.error(
      "❌ Failed to load fow_timers.json:",
      error
    );

    return [];
  }
}

let activeFowTimers =
  loadFowTimers();
removeExpiredFowTimersOnStartup();

// Backward-compatible migration:
// older timers used channelId only. Each timer remains independent.
for (const timer of activeFowTimers) {
  if (
    !timer.destinationId &&
    timer.channelId
  ) {
    timer.destinationId =
      timer.channelId;
  }
}

console.log(
  `💾 Active FoW timers restored from disk: ${activeFowTimers.length}`
);

function removeExpiredFowTimersOnStartup() {
  const now = Date.now();
  const beforeCount = activeFowTimers.length;

  // v74 TIMER RECOVERY FIX
  // IMPORTANT:
  // - Running timers are NEVER changed here.
  // - An expired timer whose final/end notification has NOT been sent is
  //   preserved so the normal timer processor can deliver the final message
  //   after Discord reconnects.
  // - Only expired timers already confirmed with sent.end === true are safe
  //   to remove during startup cleanup.
  const safeToRemove = activeFowTimers.filter(timer => {
    const endAt = Number(timer.endAt);
    const expired = Number.isFinite(endAt) && endAt <= now;
    const finalAlreadySent = Boolean(timer.sent && timer.sent.end === true);
    return expired && finalAlreadySent;
  });

  const expiredAwaitingFinal = activeFowTimers.filter(timer => {
    const endAt = Number(timer.endAt);
    const expired = Number.isFinite(endAt) && endAt <= now;
    const finalAlreadySent = Boolean(timer.sent && timer.sent.end === true);
    return expired && !finalAlreadySent;
  });

  if (safeToRemove.length > 0) {
    const removeIds = new Set(safeToRemove.map(timer => timer.id));
    activeFowTimers = activeFowTimers.filter(timer => !removeIds.has(timer.id));
    saveFowTimers();

    console.log(
      `🧹 Startup timer cleanup: removed ${safeToRemove.length} expired timer(s) whose final notification was already sent.`
    );
  }

  if (expiredAwaitingFinal.length > 0) {
    console.log(
      `♻️ Timer recovery: preserved ${expiredAwaitingFinal.length} expired timer(s) awaiting final notification.`
    );

    for (const timer of expiredAwaitingFinal) {
      console.log(
        `   - Pending final notification: ${timer.id || "unknown"} (${timer.type || "unknown"})`
      );
    }
  }

  if (safeToRemove.length === 0 && expiredAwaitingFinal.length === 0) {
    console.log(
      "✅ No expired FoW timers found during startup cleanup."
    );
  }

  console.log(
    `   Active/recoverable timers retained: ${activeFowTimers.length}/${beforeCount}`
  );
}

function saveFowTimers() {
  try {
    // Atomic write: prevents a partially-written timer file if the process
    // is interrupted while Hostinger is restarting the app.
    const tempFile = `${FOW_TIMERS_FILE}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(
        activeFowTimers,
        null,
        2
      ),
      "utf8"
    );

    fs.renameSync(
      tempFile,
      FOW_TIMERS_FILE
    );

    queueSupabaseStateSave("active_fow_timers", activeFowTimers);
  } catch (error) {
    console.error(
      "❌ Failed to save fow_timers.json:",
      error
    );
  }
}

function createFowTimerId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function cleanupFowTimerSetupSessions() {
  const now = Date.now();
  let changed = false;

  for (
    const [id, session] of
    fowTimerSetupSessions.entries()
  ) {
    if (
      now - Number(
        session.updatedAt || 0
      ) >
      FOW_TIMER_SESSION_TTL_MS
    ) {
      fowTimerSetupSessions.delete(id);
      changed = true;
    }
  }

  if (changed) {
    saveFowTimerSetupSessions();
  }
}

function getFowTimerClubPool(
  minElo = 1,
  maxElo = Number.MAX_SAFE_INTEGER
) {
  // Use Derby-eligible clubs within the selected ELO range.
  return getDerbyFilteredLeaderboard(
    minElo,
    maxElo
  )
    .slice()
    .sort(
      (a, b) =>
        Number(b.elo) -
        Number(a.elo)
    );
}

function getFowTimerSetupPageCount(
  session
) {
  return Math.max(
    1,
    Math.ceil(
      session.clubs.length /
      FOW_TIMER_PAGE_SIZE
    )
  );
}

function getFowTimerSetupPageItems(
  session
) {
  const start =
    session.page *
    FOW_TIMER_PAGE_SIZE;

  return session.clubs.slice(
    start,
    start + FOW_TIMER_PAGE_SIZE
  );
}

function getFowTimerDurationLabel(
  session
) {
  if (session.type === "push") {
    if (
      Number.isInteger(
        Number(session.durationMinutes)
      ) &&
      Number(session.durationMinutes) > 0
    ) {
      const minutes =
        Number(
          session.durationMinutes
        );

      return session.pushMode === "manual"
        ? `⏳ Manual Preparation: **${minutes} Minute${minutes === 1 ? "" : "s"}**`
        : `🧪⏳ Push Test Preparation: **${minutes} Minute${minutes === 1 ? "" : "s"}**`;
    }

    return session.hours === 6
      ? "⏳ 6 Hours Preparation"
      : "⏳ 12 Hours Preparation";
  }

  if (
    session.type ===
    "war_done_manual"
  ) {
    const minutes =
      Number(
        session.durationMinutes
      );

    return session.warDoneMode ===
      "ko"
      ? `🥊 KO Timer: **${formatRemaining(minutes*60000)}**`
      : `❄️🥊 KO + Cooling Down: **${formatRemaining(minutes*60000)}**`;
  }

  return session.hours === 2
    ? "🥊 2 Hours KO Timer"
    : "❄️🥊 14 Hours KO + Cooling Down";
}

function buildFowTimerSetupView(
  session
) {
  const pageCount =
    getFowTimerSetupPageCount(
      session
    );

  session.page =
    Math.min(
      Math.max(
        session.page,
        0
      ),
      pageCount - 1
    );

  const pageItems =
    getFowTimerSetupPageItems(
      session
    );

  const options =
    pageItems.map(
      item => {
        const key =
          normalizeClubName(
            item.club
          );

        return {
          label:
            String(item.club)
              .slice(0, 100),

          description:
            `${item.elo} ELO • ${String(
              item.president ||
              "Not Set"
            ).slice(0, 60)}`,

          value: key,

          default:
            session.selected.has(key)
        };
      }
    );

  const select =
    new StringSelectMenuBuilder()
      .setCustomId(
        `ft_select:${session.id}`
      )
      .setPlaceholder(
        "🏰 Select one or more clubs"
      )
      .setMinValues(0)
      .setMaxValues(
        Math.max(
          1,
          options.length
        )
      )
      .addOptions(options);

  const selectRow =
    new ActionRowBuilder()
      .addComponents(select);

  const navRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `ft_prev:${session.id}`
          )
          .setLabel("◀ Previous")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page <= 0
          ),

        new ButtonBuilder()
          .setCustomId(
            `ft_next:${session.id}`
          )
          .setLabel("Next ▶")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page >=
            pageCount - 1
          ),

        new ButtonBuilder()
          .setCustomId(
            `ft_clear:${session.id}`
          )
          .setLabel("Clear")
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const actionRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `ft_start:${session.id}`
          )
          .setLabel(
            session.type === "push"
              ? "🚀 START PUSH"
              : "⚔️ START TIMER"
          )
          .setStyle(
            ButtonStyle.Success
          )
          .setDisabled(
            session.selected.size === 0
          ),

        new ButtonBuilder()
          .setCustomId(
            `ft_cancel:${session.id}`
          )
          .setLabel("❌ CANCEL")
          .setStyle(
            ButtonStyle.Danger
          )
      );

  const heading =
    session.type === "push"
      ? "⏳⚔️ FOW PUSH SETUP ⚔️⏳"
      : "⚔️ FOW WAR DONE TIMER ⚔️";

  const content =
    `${heading}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${getFowTimerDurationLabel(
      session
    )}\n` +
    (session.operationalMode ? `🎮 Mode: **${getOperationalModeLabel(session.operationalMode)}**\n` : ``) +
    (session.matchId
      ? `🆔 Match ID: **${session.matchId}**\n` +
        (session.type === "push"
          ? `🏆 Match Scope: **Matchmaking winners only**\n`
          : `⚔️ Match Scope: **All matched clubs except FAILED**\n`)
      : `📊 ELO Range: **${session.minElo} - ${session.maxElo}**\n`) +
    `🏰 Clubs Available: **${session.clubs.length}**\n` +
    `🏰 Clubs Selected: **${session.selected.size}**\n` +
    `📄 Page: **${session.page + 1}/${pageCount}**\n\n` +
    `Select all clubs that belong to this timer.`;

  return {
    content,
    components: [
      selectRow,
      navRow,
      actionRow
    ]
  };
}

function resolveMatchPlanForTimer(interaction) {
  const raw = interaction.options.getString("match_id");
  if (!raw) return { matchPlan: null, matchId: null };
  const matchId = normalizeMatchId(raw);
  let matchPlan = getMatchPlan(matchId);
  if (matchPlan && matchPlan.guildId && interaction.guildId && String(matchPlan.guildId) !== String(interaction.guildId)) {
    matchPlan = null;
  }
  return { matchPlan, matchId };
}

function resolveTimerEloRange(interaction, matchPlan) {
  if (matchPlan) {
    const elos = getMatchPlanActiveClubs(matchPlan).map(item => Number(item.elo) || 0);
    return {
      minElo: elos.length ? Math.min(...elos) : 0,
      maxElo: elos.length ? Math.max(...elos) : 0
    };
  }
  return {
    minElo: interaction.options.getInteger("min_elo"),
    maxElo: interaction.options.getInteger("max_elo")
  };
}

function createFowTimerSetupSession(
  interaction,
  type,
  hours,
  minElo,
  maxElo,
  warDoneMode = null,
  durationMinutes = null,
  pushMode = null,
  matchPlan = null
) {
  const id =
    createFowTimerId();

  const session = {
    id,
    userId:
      interaction.user.id,
    channelId:
      interaction.channelId,
    guildId:
      interaction.guildId,
    type,
    hours,
    warDoneMode,
    pushMode,
    durationMinutes,
    minElo,
    maxElo,
    matchId: matchPlan ? normalizeMatchId(matchPlan.id) : null,
    clubs:
      matchPlan && Array.isArray(matchPlan.clubs)
        ? (type === "push" ? getMatchPlanWinningClubs(matchPlan) : getMatchPlanActiveClubs(matchPlan)).map(item => ({
            club: item.club,
            president: item.president || "",
            elo: Number(item.elo) || 0,
            matchRole: item.matchRole || null,
            pairNo: item.pairNo || null
          }))
        : getFowTimerClubPool(
            minElo,
            maxElo
          ),
    selected:
      new Set(
        matchPlan && Array.isArray(matchPlan.clubs)
          ? (type === "push" ? getMatchPlanWinningClubs(matchPlan) : getMatchPlanActiveClubs(matchPlan))
              .map(item => normalizeClubName(item.club))
          : []
      ),
    page: 0,
    createdAt:
      Date.now(),
    updatedAt:
      Date.now()
  };

  fowTimerSetupSessions.set(
    id,
    session
  );

  saveFowTimerSetupSessions();
  queueSupabaseStateSave(`timer_setup_session:${session.id}`, serializeFowTimerSetupSession(session));

  return session;
}

function applyOperationalModeToTimerSession(session, mode, matchPlan = null) {
  const normalized = ["grease", "lightning", "normal", "external"].includes(mode) ? mode : null;
  session.operationalMode = normalized;

  if (!matchPlan && normalized === "external") {
    session.clubs = getFilteredLeaderboard(session.minElo, session.maxElo).slice().sort((a,b)=>Number(b.elo)-Number(a.elo));
    session.selected = new Set();
  }

  session.updatedAt = Date.now();
  saveFowTimerSetupSessions();
  queueSupabaseStateSave(`timer_setup_session:${session.id}`, serializeFowTimerSetupSession(session));
  return session;
}

function buildFowTimerClubRecords(
  session
) {
  const selected =
    session.selected;

  return session.clubs
    .filter(
      item =>
        selected.has(
          normalizeClubName(
            item.club
          )
        )
    )
    .map(
      item => ({
        club:
          item.club,
        president:
          item.president || "",
        elo:
          Number(item.elo) || 0
      })
    );
}

function formatFowTimerClubList(
  clubs
) {
  return clubs
    .map(
      club =>
        `🏰 ${club.club} (${club.elo}) — ` +
        `${club.president || "Not Set"}`
    )
    .join("\n");
}

function formatFowTimerClubListPlain(clubs) {
  return (clubs || [])
    .map(club => `${club.club} (${club.elo}) — ${club.president || "Not Set"}`)
    .join("\n");
}

function isKoOnlyTimer(timer) {
  return timer?.type === "war_done_manual"
    ? timer?.warDoneMode === "ko"
    : Number(timer?.hours) === 2;
}

function createManualIsolationId(){return `ISO-M${Date.now().toString(36).toUpperCase().slice(-7)}`;}
function createActiveFowTimer(
  session
) {
  if(session?.type==='war_done_manual'&&!session.matchId)session.matchId=createManualIsolationId();
  const startAt =
    Date.now();

  const endAt =
    startAt +
    (
      (
        session.type ===
          "war_done_manual" ||
        (
          session.type === "push" &&
          Number.isInteger(
            Number(session.durationMinutes)
          ) &&
          Number(session.durationMinutes) > 0
        )
      )
        ? Number(
            session.durationMinutes
          ) *
          60 *
          1000
        : session.hours *
          60 *
          60 *
          1000
    );

  const timer = {
    // Every timer is an independent instance.
    // Never use channelId, club name, or timer type as the timer identity.
    id:
      createFowTimerId(),

    type:
      session.type,

    hours:
      session.hours,

    warDoneMode:
      session.warDoneMode,

    pushMode:
      session.pushMode || null,

    operationalMode:
      session.operationalMode || null,

    durationMinutes:
      session.durationMinutes,

    matchId:
      session.matchId || null,

    preparationControl: Boolean(session.preparationControl),
    failedClubKeys: Array.isArray(session.failedClubKeys) ? [...session.failedClubKeys] : [],

    userId:
      session.userId,

    guildId:
      session.guildId,

    // The exact channel or thread where this timer was started.
    // All reminders for this timer return only to this destination.
    destinationId:
      session.channelId,

    // Kept for backward compatibility with timers created by older bot versions.
    channelId:
      session.channelId,

    // One timer may contain one club or a multi-club batch.
    // This club list belongs only to this timer instance.
    clubs:
      buildFowTimerClubRecords(
        session
      ),

    startAt,
    endAt,

    sent: {
      oneHour:
        false,
      thirtyMinutes:
        false,
      fifteenMinutes:
        false,
      end:
        false
    }
  };

  activeFowTimers.push(
    timer
  );

  saveFowTimers();

  // V77: preparation automatically isolates selected clubs.
  try { markPreparationForTimer(timer); } catch (error) { console.error("❌ War preparation state hook failed:", error); }

  // Kick the processor immediately. This matters for short manual/test-style
  // timers and also confirms the newly-created timer is visible to the engine.
  if (
    client &&
    typeof client.isReady === "function" &&
    client.isReady()
  ) {
    setImmediate(() => {
      processFowTimers().catch(
        error =>
          console.error(
            `❌ Timer ${timer.id} immediate processor error:`,
            error
          )
      );
    });
  }

  return timer;
}

function getFowTimerTitle(timer, stage) {
  if (timer.type === "test") {
    return timer.testNotification === "start"
      ? "🧪⚔️ FoW WAR START ALERT — TEST ⚔️🧪"
      : "🧪🏁 FoW WAR END ALERT — TEST 🏁🧪";
  }

  if (timer.type === "push") {
    if (stage === "end") return "🏁⚔️ FOW PUSH ALERT — PREPARATION ENDED ⚔️🏁";
    return "⏳⚔️ FoW WAR START ALERT ⚔️⏳";
  }

  const koOnly = isKoOnlyTimer(timer);
  if (stage === "fifteenMinutes") {
    return koOnly
      ? "⚠️🥊 FOW KO TIMER ENDING SOON"
      : "⚠️🥊🧊 FOW KO + COOLING ENDING SOON";
  }
  if (stage === "end") {
    return koOnly
      ? "🟢🥊 FOW KO TIMER COMPLETED"
      : "🟢🥊🧊 FOW KO + COOLING COMPLETED";
  }
  return koOnly
    ? "🥊 FOW KO TIMER"
    : "🥊🧊 FOW KO + COOLING";
}

function getFowTimerStageText(
  timer,
  stage
) {
  if (
    timer.type === "test"
  ) {
    return timer.testNotification ===
      "start"
      ? "⚔️🔥 **WAR START** 🔥⚔️"
      : "🏁 **WAR END** 🏁";
  }

  if (stage === "oneHour") {
    if (timer.type === "push") {
      return "🟡 **1 HOUR TO START WAR**";
    }

    return "🟡 **1 HOUR TO PUSH AGAIN**";
  }

  if (stage === "thirtyMinutes") {
    if (timer.type === "push") {
      return "🟠 **30 MINUTES TO START WAR**";
    }

    return "🟠 **30 MINUTES TO PUSH AGAIN**";
  }

  if (stage === "fifteenMinutes") {
    if (timer.type === "push") {
      return "🔴 **15 MINUTES TO START WAR**";
    }

    return "🔴 **15 MINUTES TO PUSH AGAIN**";
  }

  if (timer.type === "push") {
    return (
      "🏁 **PREPARATION TIMER ENDED**\n" +
      "⚔️🔥 **WAR START** 🔥⚔️"
    );
  }

  if (
    timer.type ===
    "war_done_manual"
  ) {
    if (
      timer.warDoneMode ===
      "ko"
    ) {
      return (
        "🏁 **KO TIMER ENDED**\n" +
        "✅⚔️ **MATCHMAKING READY TO MAKE** ⚔️✅"
      );
    }

    return (
      "✅ **KO + COOLING DOWN TIMER COMPLETED**\n" +
      "✅⚔️ **MATCHMAKING READY TO MAKE** ⚔️✅"
    );
  }

  if (timer.hours === 2) {
    return (
      "🏁 **KO TIMER ENDED**\n" +
      "✅⚔️ **MATCHMAKING READY TO MAKE** ⚔️✅"
    );
  }

  return (
    "✅ **KO + COOLING DOWN TIMER COMPLETED**\n" +
    "✅⚔️ **MATCHMAKING READY TO MAKE** ⚔️✅"
  );
}


async function getFowTimerReminderMentions(
  timer
) {
  const mentions =
    new Set();

  for (
    const userId of
    FOW_TIMER_REMINDER_USER_IDS
  ) {
    if (userId) {
      mentions.add(
        `<@${userId}>`
      );
    }
  }

  console.log(
    `🔔 Timer ${timer.id} reminder users:` +
    ` fixedUsers=${mentions.size}`
  );

  return Array.from(
    mentions
  );
}

function buildFowTimerNotification(
  timer,
  stage,
  reminderMentions = []
) {
  if (
    timer.type === "test"
  ) {
    return (
      `${getFowTimerTitle(timer, stage)}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${getFowTimerStageText(timer, stage)}\n\n` +
      `🧪 Timer notification test completed.\n` +
      `⏱️ Test delay: **${timer.testMinutes} minute${timer.testMinutes === 1 ? "" : "s"}**\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${
        reminderMentions.length
          ? reminderMentions.join(" ")
          : `<@${timer.userId}>`
      }`
    );
  }

  // v81.4.1: Compact isolation notifications for KO / KO+Cooling timers.
  // Existing persisted timers use the same data and continue running across deploys.
  if (timer.type === "war_done" || timer.type === "war_done_manual") {
    const koOnly = isKoOnlyTimer(timer);
    if (stage === "fifteenMinutes") {
      return (
        `${getFowTimerTitle(timer, stage)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        (timer.matchId ? `🆔 Match ID: **${timer.matchId}**\n` : ``) +
        `🏰 Clubs: **${timer.clubs.length}**\n` +
        `⏱️ Remaining: **15 Minutes**\n\n` +
        `🚫 Matchmaking: **Still Isolated**` +
        (reminderMentions.length ? `\n\n${reminderMentions.join(" ")}` : ``)
      );
    }
    if (stage === "end") {
      return (
        `${getFowTimerTitle(timer, stage)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        (timer.matchId ? `🆔 Match ID: **${timer.matchId}**\n` : ``) +
        `🏰 Clubs Released: **${timer.clubs.length}**\n` +
        `✅ Matchmaking: **AVAILABLE**` +
        (reminderMentions.length ? `\n\n${reminderMentions.join(" ")}` : ``)
      );
    }
  }

  const clubList =
    formatFowTimerClubList(
      timer.clubs
    );

  const typeLine =
    timer.type === "push"
      ? (
          Number.isInteger(
            Number(timer.durationMinutes)
          ) &&
          Number(timer.durationMinutes) > 0
            ? (timer.pushMode === "manual"
                ? `⏳ Manual Preparation: **${timer.durationMinutes} Minute${Number(timer.durationMinutes) === 1 ? "" : "s"}**`
                : `🧪⏳ Push Test Preparation: **${timer.durationMinutes} Minute${Number(timer.durationMinutes) === 1 ? "" : "s"}**`)
            : `⏳ Preparation: **${timer.hours} Hours**`
        )
      : timer.type ===
          "war_done_manual"
        ? (
            timer.warDoneMode ===
            "ko"
              ? `⏱️ KO Timer: **${timer.durationMinutes} Minute${timer.durationMinutes === 1 ? "" : "s"}**`
              : `⏱️ KO + Cooling Down: **${timer.durationMinutes} Minute${timer.durationMinutes === 1 ? "" : "s"}**`
          )
        : timer.hours === 2
          ? "⏱️ KO Timer: **2 Hours**"
          : "⏱️ KO + Cooling Down: **14 Hours**";

  return (
    `${getFowTimerTitle(timer, stage)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${getFowTimerStageText(timer, stage)}\n\n` +
    `${typeLine}\n` +
    `🔥 Clubs: **${timer.clubs.length}**\n\n` +
    `${clubList}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${
      reminderMentions.length
        ? reminderMentions.join(" ")
        : `<@${timer.userId}>`
    }`
  );
}


const FOW_TIMER_DISCORD_OPERATION_TIMEOUT_MS =
  15 * 1000;

function withFowTimerTimeout(
  promise,
  label,
  timeoutMs = FOW_TIMER_DISCORD_OPERATION_TIMEOUT_MS
) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out after ${timeoutMs}ms`
            )
          ),
        timeoutMs
      );

      // Do not keep Node.js alive only because of this guard timer.
      if (
        timeout &&
        typeof timeout.unref === "function"
      ) {
        timeout.unref();
      }
    })
  ]);
}

function getFowTimerDestinationId(
  timer
) {
  // New timers use destinationId.
  // Older persisted timers still use channelId.
  return (
    timer.destinationId ||
    timer.channelId
  );
}

async function resolveFowTimerDestination(
  timer
) {
  let channel = null;

  const destinationId =
    getFowTimerDestinationId(
      timer
    );

  // First try the global channel manager.
  try {
    channel =
      await withFowTimerTimeout(
        client.channels.fetch(
          destinationId,
          {
            force: true
          }
        ),
        `Timer ${timer.id} direct channel fetch`
      );
  } catch (error) {
    console.error(
      `⚠️ Timer ${timer.id}: direct channel fetch failed for ${destinationId}:`,
      error.message
    );
  }

  // Fallback through the guild channel manager.
  if (!channel && timer.guildId) {
    try {
      const guild =
        await withFowTimerTimeout(
          client.guilds.fetch(
            timer.guildId
          ),
          `Timer ${timer.id} guild fetch`
        );

      if (guild) {
        channel =
          await withFowTimerTimeout(
            guild.channels.fetch(
              destinationId,
              {
                force: true
              }
            ),
            `Timer ${timer.id} guild channel fetch`
          );
      }
    } catch (error) {
      console.error(
        `⚠️ Timer ${timer.id}: guild channel fetch failed for ${destinationId}:`,
        error.message
      );
    }
  }

  if (!channel) {
    throw new Error(
      `Timer destination ${destinationId} could not be found.`
    );
  }

  if (
    typeof channel.isTextBased !==
      "function" ||
    !channel.isTextBased()
  ) {
    throw new Error(
      `Timer destination ${destinationId} is not text based.`
    );
  }

  // Threads can auto-archive. Attempt to reopen an archived thread
  // before sending the reminder. If Discord permissions do not allow
  // this, channel.send() below will report the actual permission error.
  if (
    typeof channel.isThread ===
      "function" &&
    channel.isThread()
  ) {
    if (
      channel.archived &&
      typeof channel.setArchived ===
        "function"
    ) {
      try {
        await withFowTimerTimeout(
          channel.setArchived(
            false,
            "FoW active timer reminder"
          ),
          `Timer ${timer.id} reopen archived thread`
        );

        console.log(
          `✅ Timer ${timer.id}: reopened archived thread ${destinationId}.`
        );
      } catch (error) {
        console.error(
          `⚠️ Timer ${timer.id}: could not reopen archived thread ${destinationId}:`,
          error.message
        );
      }
    }

    if (channel.locked) {
      console.error(
        `⚠️ Timer ${timer.id}: thread ${destinationId} is locked.`
      );
    }
  }

  return channel;
}

async function sendFowTimerNotification(
  timer,
  stage
) {
  try {
    const channel =
      await resolveFowTimerDestination(
        timer
      );

    const reminderMentions =
      await getFowTimerReminderMentions(
        timer
      );

    const content =
      buildFowTimerNotification(
        timer,
        stage,
        reminderMentions
      );

    const chunks =
      splitDiscordText(
        content
      );

    let firstMessageId =
      null;

    for (
      const chunk of chunks
    ) {
      const sentMessage =
        await withFowTimerTimeout(
          channel.send({
            content: chunk,
            allowedMentions: {
              parse: [
                "users"
              ]
            }
          }),
          `Timer ${timer.id} Discord send (${stage})`
        );

      if (
        !firstMessageId &&
        sentMessage &&
        sentMessage.id
      ) {
        firstMessageId =
          sentMessage.id;
      }
    }

    console.log(
      `✅ FoW timer ${timer.id} stage ${stage} sent to ${getFowTimerDestinationId(timer)}` +
      `${
        typeof channel.isThread === "function" &&
        channel.isThread()
          ? " (thread)"
          : " (channel)"
      }` +
      `${firstMessageId ? ` • message ${firstMessageId}` : ""}.`
    );

    return {
      ok: true,
      messageId:
        firstMessageId
    };
  } catch (error) {
    console.error(
      `❌ Failed to send FoW timer ${timer.id} stage ${stage} ` +
      `to destination ${getFowTimerDestinationId(timer)}:`,
      error
    );

    console.error(
      "   Check bot permissions: View Channel, Send Messages, " +
      "Send Messages in Threads, and Manage Threads if the thread is archived."
    );

    return {
      ok: false,
      messageId: null
    };
  }
}


function getActiveFowTimersForDestination(
  interaction
) {
  return activeFowTimers
    .filter(
      timer =>
        timer.guildId ===
          interaction.guildId &&
        getFowTimerDestinationId(
          timer
        ) ===
          interaction.channelId
    )
    .slice()
    .sort(
      (a, b) =>
        Number(a.endAt) -
        Number(b.endAt)
    );
}

function getFowTimerCancelLabel(
  timer
) {
  const typeLabel =
    timer.type === "test"
      ? `TEST ${timer.testNotification === "start" ? "War Start" : "War End"}`
      : timer.type === "push"
        ? (
            Number.isInteger(
              Number(timer.durationMinutes)
            ) &&
            Number(timer.durationMinutes) > 0
              ? (timer.pushMode === "manual"
                  ? `${timer.durationMinutes}M Manual Push`
                  : `${timer.durationMinutes}M Push Test`)
              : `${timer.hours}H Preparation`
          )
        : timer.hours === 2
          ? "2H KO"
          : "14H KO + Cooling";

  const clubCount =
    Array.isArray(timer.clubs)
      ? timer.clubs.length
      : 0;

  return `${typeLabel} • ${clubCount} club${clubCount === 1 ? "" : "s"}`;
}

async function showCancelTimerMenu(
  interaction
) {
  // Acknowledge the slash command immediately. Hostinger can briefly be busy
  // with database/network work, and Discord interactions must be acknowledged
  // quickly or they expire with Unknown interaction (10062).
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });
  }

  // Make Supabase the source of truth before presenting the cancel list.
  // This is important after a Hostinger restart/redeploy because the current
  // process may not yet have the newest active timer array in memory.
  try {
    await flushSupabaseStateSave("active_fow_timers");

    const remoteTimers =
      await loadSupabaseState("active_fow_timers");

    if (Array.isArray(remoteTimers)) {
      const now = Date.now();
      activeFowTimers = remoteTimers.filter(timer =>
        timer &&
        timer.id &&
        Number.isFinite(Number(timer.endAt)) &&
        Number(timer.endAt) > now
      );

      // Keep the local runtime snapshot synchronized with the authoritative
      // Supabase copy without queuing a needless remote write.
      try {
        const tempFile = `${FOW_TIMERS_FILE}.tmp`;
        fs.writeFileSync(
          tempFile,
          JSON.stringify(activeFowTimers, null, 2),
          "utf8"
        );
        fs.renameSync(tempFile, FOW_TIMERS_FILE);
      } catch (snapshotError) {
        console.error(
          "❌ Failed to refresh local timer snapshot for /cancel_timer:",
          snapshotError
        );
      }

      console.log(
        `🔄 /cancel_timer refreshed active timers from Supabase: ${activeFowTimers.length}`
      );
    }
  } catch (error) {
    console.error(
      "❌ /cancel_timer Supabase refresh failed; using in-memory timers:",
      error
    );
  }

  const timers =
    getActiveFowTimersForDestination(
      interaction
    );

  console.log(
    `🧭 /cancel_timer scope ${interaction.guildId}/${interaction.channelId} • matching timers: ${timers.length}`
  );

  if (timers.length === 0) {
    await interaction.editReply({
      content:
        "❌ No active FoW timer found in this channel/thread.",
      components: []
    });

    return;
  }

  const options =
    timers
      .slice(0, 25)
      .map(
        timer => ({
          label:
            getFowTimerCancelLabel(
              timer
            ).slice(0, 100),

          description:
            `ID ${timer.id.slice(-6)} • Ends <t:${Math.floor(
              timer.endAt / 1000
            )}:R>`,

          value:
            timer.id
        })
      );

  const select =
    new StringSelectMenuBuilder()
      .setCustomId(
        `ft_cancel_timer_select:${interaction.user.id}`
      )
      .setPlaceholder(
        "Select active timer to cancel"
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options);

  const row =
    new ActionRowBuilder()
      .addComponents(select);

  await interaction.editReply({
    content:
      "🛑 **CANCEL FOW TIMER**\n\nOnly timers created in **this exact channel/thread** are shown. Select the timer you want to cancel.",
    components: [row]
  });
}

function ensureFowTimerDeliveryState(
  timer,
  stage
) {
  if (
    !timer.delivery ||
    typeof timer.delivery !==
      "object"
  ) {
    timer.delivery = {};
  }

  if (
    !timer.delivery[stage] ||
    typeof timer.delivery[stage] !==
      "object"
  ) {
    timer.delivery[stage] = {
      status: "pending",
      messageId: null,
      sentAt: null,
      lastAttemptAt: null
    };
  }

  return timer.delivery[stage];
}

function isFowTimerStageSent(
  timer,
  stage
) {
  const delivery =
    ensureFowTimerDeliveryState(
      timer,
      stage
    );

  return (
    delivery.status === "sent" &&
    Boolean(delivery.messageId)
  );
}

async function deliverFowTimerStageOnce(
  timer,
  stage
) {
  const delivery =
    ensureFowTimerDeliveryState(
      timer,
      stage
    );

  if (
    delivery.status === "sent" &&
    delivery.messageId
  ) {
    return true;
  }

  if (
    delivery.status === "sending"
  ) {
    const lastAttempt =
      Number(
        delivery.lastAttemptAt ||
        0
      );

    if (
      lastAttempt &&
      Date.now() - lastAttempt <
        2 * 60 * 1000
    ) {
      console.log(
        `⏳ Timer ${timer.id} stage ${stage} is protected as SENDING; retry skipped.`
      );

      return false;
    }

    delivery.status = "pending";
  }

  delivery.status = "sending";
  delivery.lastAttemptAt =
    Date.now();

  console.log(
    `📨 Timer ${timer.id}: sending ${stage} to destination ${getFowTimerDestinationId(timer)}`
  );

  saveFowTimers();

  const result =
    await sendFowTimerNotification(
      timer,
      stage
    );

  if (
    result &&
    result.messageId
  ) {
    delivery.status = "sent";
    delivery.messageId =
      result.messageId;
    delivery.sentAt =
      Date.now();

    saveFowTimers();

    return true;
  }

  delivery.status = "pending";
  saveFowTimers();

  return false;
}

let fowTimerProcessorRunning =
  false;

async function processFowTimers() {
  // Do not attempt Discord delivery before the client is fully ready.
  // The processor will run immediately from clientReady and then on its interval.
  if (
    !client ||
    typeof client.isReady !== "function" ||
    !client.isReady()
  ) {
    return;
  }

  if (fowTimerProcessorRunning) {
    console.log(
      "⏭️ FoW timer processor skipped: previous cycle is still running."
    );
    return;
  }

  fowTimerProcessorRunning =
    true;

  try {
    const now =
      Date.now();

    let changed =
      false;

    for (
      const timer of
      activeFowTimers
    ) {
      if (
        !timer.sent ||
        typeof timer.sent !==
          "object"
      ) {
        timer.sent = {
          oneHour: false,
          thirtyMinutes: false,
          fifteenMinutes: false,
          end: false
        };

        changed = true;
      }

      // Make sure every milestone has its own independent delivery state.
      for (
        const stage of [
          "oneHour",
          "thirtyMinutes",
          "fifteenMinutes",
          "end"
        ]
      ) {
        const delivery =
          ensureFowTimerDeliveryState(
            timer,
            stage
          );

        // Backward compatibility for old timer files.
        if (
          timer.sent[stage] === true &&
          delivery.status === "pending"
        ) {
          delivery.status = "sent";
          delivery.messageId =
            `legacy-${timer.id}-${stage}`;
          delivery.sentAt =
            timer.startAt ||
            Date.now();

          changed = true;
        }
      }

      const remaining =
        Number(timer.endAt) -
        now;

      if (
        !Number.isFinite(
          remaining
        )
      ) {
        console.error(
          `⚠️ Timer ${timer.id}: invalid endAt; skipped.`
        );
        continue;
      }

      // Test timers only use their final notification.
      if (
        timer.type === "test"
      ) {
        if (
          remaining <= 0 &&
          !isFowTimerStageSent(
            timer,
            "end"
          )
        ) {
          const delivered =
            await deliverFowTimerStageOnce(
              timer,
              "end"
            );

          if (delivered) {
            timer.sent.end =
              true;
            changed = true;
            try { await handleFowTimerOperationalCompletion(timer); } catch (error) { console.error("❌ Timer operational completion hook failed:", error); }
          }
        }

        continue;
      }

      // FINAL
      if (
        remaining <= 0
      ) {
        if (
          !isFowTimerStageSent(
            timer,
            "end"
          )
        ) {
          const delivered =
            await deliverFowTimerStageOnce(
              timer,
              "end"
            );

          if (delivered) {
            timer.sent.end =
              true;
            changed = true;
            try { await handleFowTimerOperationalCompletion(timer); } catch (error) { console.error("❌ Timer operational completion hook failed:", error); }
          }
        }

        continue;
      }

      // ======================================================
      // PUSH TIMER
      // Only one reminder is used: 15 minutes before WAR START.
      // The old 1-hour and 30-minute push reminders are disabled.
      // Delivery is only completed after Discord confirms a message ID.
      // ======================================================
      if (
        timer.type === "push"
      ) {
        // A manual push-test shorter than 15 minutes cannot truthfully send
        // a "15 MINUTES TO START WAR" reminder. In that case, only the
        // final WAR START notification is sent. Use 15+ minutes to test
        // the standard 15-minute push reminder as well.
        const manualPushMinutes =
          Number(timer.durationMinutes);

        if (
          Number.isFinite(manualPushMinutes) &&
          manualPushMinutes > 0 &&
          manualPushMinutes < 15
        ) {
          continue;
        }

        if (
          remaining <=
            15 * 60 * 1000
        ) {
          if (
            !isFowTimerStageSent(
              timer,
              "fifteenMinutes"
            )
          ) {
            const delivered =
              await deliverFowTimerStageOnce(
                timer,
                "fifteenMinutes"
              );

            if (delivered) {
              timer.sent.fifteenMinutes =
                true;
              changed = true;
            }
          }
        }

        continue;
      }

      // ======================================================
      // WAR DONE / WAR DONE MANUAL
      // Keep existing behavior: 15-minute reminder only.
      // ======================================================
      if (
        remaining <=
          15 * 60 * 1000
      ) {
        if (
          !isFowTimerStageSent(
            timer,
            "fifteenMinutes"
          )
        ) {
          const delivered =
            await deliverFowTimerStageOnce(
              timer,
              "fifteenMinutes"
            );

          if (delivered) {
            timer.sent.fifteenMinutes =
              true;
            changed = true;
          }
        }

        continue;
      }
    }

    const before =
      activeFowTimers.length;

    activeFowTimers =
      activeFowTimers.filter(
        timer =>
          !(
            timer.sent &&
            timer.sent.end
          )
      );

    if (
      activeFowTimers.length !==
      before
    ) {
      changed = true;
    }

    if (changed) {
      saveFowTimers();
    }
  } finally {
    fowTimerProcessorRunning =
      false;
  }
}

const FOW_TIMER_PROCESS_INTERVAL_MS =
  10 * 1000;

let fowTimerProcessorInterval =
  null;

function startFowTimerProcessor() {
  if (fowTimerProcessorInterval) {
    return;
  }

  console.log(
    `⏱️ FoW timer processor started • active timers: ${activeFowTimers.length}`
  );

  // Process immediately after Discord becomes ready instead of waiting
  // for the first interval tick.
  processFowTimers().catch(
    error =>
      console.error(
        "❌ FoW timer processor initial run error:",
        error
      )
  );

  fowTimerProcessorInterval =
    setInterval(
      () => {
        processFowTimers()
          .catch(
            error =>
              console.error(
                "❌ FoW timer processor error:",
                error
              )
          );
      },
      FOW_TIMER_PROCESS_INTERVAL_MS
    );
}


// ============================================================
// END FOW PUSH / WAR DONE TIMER SYSTEM
// ============================================================

// ============================================================
// INTERACTIVE MATCHMAKING SELECTION
// ============================================================
//
// /matchmaking now opens a multi-select interface instead of requiring
// club names to be typed manually.
//
// Discord allows a maximum of 25 options in one string select menu,
// therefore the eligible Derby clubs are automatically split into pages.
//
// Each session belongs to the user who started it. Other users cannot
// change that user's Must Win / Must Lose / Skip selections.
//

const matchmakingSessions =
  new Map();

// Persisted generated matchmaking plans. A simple HS Match ID lets timer
// commands reuse the exact matched clubs without re-entering ELO ranges.
const matchPlans = new Map();
let matchPlanCounter = 0;

function normalizeMatchId(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  const m = raw.match(/^(?:HS|M)?(\d{1,6})$/);
  // Backward compatible: old HS001 / 001 IDs are migrated to HS001.
  return m ? `HS${String(Number(m[1])).padStart(3, "0")}` : raw;
}

function nextMatchId() {
  matchPlanCounter += 1;
  return `HS${String(matchPlanCounter).padStart(3, "0")}`;
}

function serializeMatchPlans() {
  return {
    counter: matchPlanCounter,
    plans: [...matchPlans.values()]
  };
}

async function saveMatchPlansNow() {
  queueSupabaseStateSave("match_plans", serializeMatchPlans());
  await flushSupabaseStateSave("match_plans");
}

function ensureMatchPlanWinnerRoles(matchPlan) {
  if (!matchPlan || !Array.isArray(matchPlan.clubs) || matchPlan.clubs.length === 0) {
    return false;
  }

  let changed = false;
  const pairs = new Map();

  for (const club of matchPlan.clubs) {
    const pairNo = Number(club?.pairNo);
    if (!Number.isInteger(pairNo) || pairNo <= 0) continue;
    if (!pairs.has(pairNo)) pairs.set(pairNo, []);
    pairs.get(pairNo).push(club);
  }

  for (const pairClubs of pairs.values()) {
    if (pairClubs.length !== 2) continue;

    const [a, b] = pairClubs;
    const aRole = String(a?.matchRole || '').toLowerCase();
    const bRole = String(b?.matchRole || '').toLowerCase();

    // Preserve any explicit Must Win / Must Lose result already stored.
    if (aRole === 'win' || bRole === 'lose') {
      if (a.matchRole !== 'win') { a.matchRole = 'win'; changed = true; }
      if (b.matchRole !== 'lose') { b.matchRole = 'lose'; changed = true; }
      continue;
    }
    if (bRole === 'win' || aRole === 'lose') {
      if (b.matchRole !== 'win') { b.matchRole = 'win'; changed = true; }
      if (a.matchRole !== 'lose') { a.matchRole = 'lose'; changed = true; }
      continue;
    }

    // Ordinary matchmaking rule: higher ELO is the winner.
    // For an exact tie, keep the first club as winner for deterministic output.
    const aElo = Number(a?.elo) || 0;
    const bElo = Number(b?.elo) || 0;
    const winner = bElo > aElo ? b : a;
    const loser = winner === a ? b : a;

    if (winner.matchRole !== 'win') { winner.matchRole = 'win'; changed = true; }
    if (loser.matchRole !== 'lose') { loser.matchRole = 'lose'; changed = true; }
  }

  return changed;
}

async function restoreMatchPlansFromSupabase() {
  if (!supabasePersistenceReady) return;
  const remote = await loadSupabaseState("match_plans");
  if (!remote || !Array.isArray(remote.plans)) {
    await saveMatchPlansNow();
    console.log("☁️ Match plan store initialized in Supabase.");
    return;
  }
  matchPlans.clear();
  for (const plan of remote.plans) {
    if (!plan || !plan.id || !Array.isArray(plan.clubs)) continue;
    const migratedClubs = plan.clubs.map(item => ({
      ...item,
      status: ["pending", "success", "failed", "excluded"].includes(String(item?.status || "").toLowerCase())
        ? String(item.status).toLowerCase()
        : "pending",
      failedAt: String(item?.status || "").toLowerCase() === "failed" ? (Number(item?.failedAt) || null) : null,
      failedBy: String(item?.status || "").toLowerCase() === "failed" ? (item?.failedBy || null) : null,
      // v52+: generated matchmaking plans remember which side is expected to win.
      // Legacy plans have no role and remain null for safe backward compatibility.
      matchRole: ["win", "lose"].includes(String(item?.matchRole || "").toLowerCase())
        ? String(item.matchRole).toLowerCase()
        : null,
      pairNo: Number.isInteger(Number(item?.pairNo)) && Number(item.pairNo) > 0
        ? Number(item.pairNo)
        : null
    }));
    const restoredPlan = {
      ...plan,
      id: normalizeMatchId(plan.id),
      clubs: migratedClubs
    };
    ensureMatchPlanWinnerRoles(restoredPlan);
    matchPlans.set(restoredPlan.id, restoredPlan);
  }
  matchPlanCounter = Math.max(
    Number(remote.counter) || 0,
    ...[...matchPlans.keys()].map(id => Number(id.replace(/^(?:HS|M)/, "")) || 0),
    0
  );
  // Persist any winner-role backfill so older HS IDs immediately become usable
  // for Push winner filtering after this version is deployed.
  await saveMatchPlansNow();
  console.log(`💾 Match plans restored from Supabase: ${matchPlans.size}`);
}

function getMatchPlan(matchId) {
  const plan = matchPlans.get(normalizeMatchId(matchId)) || null;
  if (plan) ensureMatchPlanWinnerRoles(plan);
  return plan;
}

function getMatchPlanActiveClubs(matchPlan) {
  if (!matchPlan || !Array.isArray(matchPlan.clubs)) return [];
  return matchPlan.clubs.filter(item => {
    const status = String(item?.status || "pending").toLowerCase();
    return status !== "failed" && status !== "excluded";
  });
}

function getMatchPlanFailedClubs(matchPlan) {
  if (!matchPlan || !Array.isArray(matchPlan.clubs)) return [];
  return matchPlan.clubs.filter(
    item => String(item?.status || "matched").toLowerCase() === "failed"
  );
}

function getMatchPlanWinningClubs(matchPlan) {
  return getMatchPlanActiveClubs(matchPlan).filter(
    item => String(item?.matchRole || "").toLowerCase() === "win"
  );
}


// ============================================================
// v82.2 — MATCH ID LIFECYCLE / AUTO CLOSE
// ============================================================
let matchPlanLifecycleProcessorInterval = null;
let matchPlanLifecycleProcessorRunning = false;

function markMatchPlanLifecycleActive(matchId) {
  const id = normalizeMatchId(matchId);
  const plan = getMatchPlan(id);
  if (!plan) return null;

  const now = Date.now();

  if (!plan.lifecycleTrackingStartedAt) {
    plan.lifecycleTrackingStartedAt = now;
  }

  if (String(plan.status || '').toUpperCase() !== 'CLOSED') {
    plan.status = 'ACTIVE';
  }

  plan.updatedAt = now;

  saveMatchPlansNow().catch(error =>
    console.error("❌ Match lifecycle activation save failed:", error)
  );

  return plan;
}

function getActiveTimersForMatchId(matchId) {
  const id = normalizeMatchId(matchId);

  return (activeFowTimers || []).filter(timer =>
    normalizeMatchId(timer?.matchId || '') === id &&
    timer?.sent?.end !== true &&
    !['completed', 'cancelled'].includes(
      String(timer?.status || '').toLowerCase()
    )
  );
}

function getActiveWarOpsForMatchId(matchId) {
  const id = normalizeMatchId(matchId);

  return Object.values(warOperations || {}).filter(op =>
    normalizeMatchId(op?.matchId || '') === id &&
    String(op?.status || 'AVAILABLE').toUpperCase() !== 'AVAILABLE'
  );
}

function countUniqueMatchPlanClubs(plan) {
  const seen = new Set();

  for (const item of plan?.clubs || []) {
    const key = normalizeClubName(item?.club || '');
    if (key) seen.add(key);
  }

  return seen.size;
}

async function sendMatchPlanClosedNotification(plan) {
  if (!plan || plan.closeNotificationSent) return false;

  const channelId =
    plan.channelId ||
    plan.destinationId ||
    null;

  if (!channelId || !client?.isReady?.()) return false;

  try {
    const channel =
      await client.channels.fetch(String(channelId));

    if (!channel?.isTextBased?.()) return false;

    const clubCount =
      countUniqueMatchPlanClubs(plan);

    await channel.send(
      `✅ **WAR COMPLETED — MATCH ID CLOSED**\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🆔 Match ID: **${plan.id}**\n` +
      `🏰 Clubs: **${clubCount}**\n` +
      `🟢 Released: **${clubCount}**\n` +
      `🚫 Isolated: **0**\n` +
      `⏱️ Active Timers: **0**\n\n` +
      `All clubs under **${plan.id}** are now AVAILABLE.\n` +
      `Match ID **${plan.id}** has been CLOSED.\n\n` +
      `Closed: <t:${Math.floor(Number(plan.closedAt) / 1000)}:F>`
    );

    plan.closeNotificationSent = true;
    plan.closeNotificationSentAt = Date.now();
    plan.updatedAt = Date.now();

    await saveMatchPlansNow();

    return true;

  } catch (error) {
    console.error(
      `❌ Match ID close notification failed for ${plan.id}:`,
      error
    );

    return false;
  }
}

async function maybeAutoCloseMatchPlan(plan) {
  if (!plan?.id) return false;

  // CANCELLED is a terminal Match ID state.
  // Never auto-close or continue lifecycle tracking.
  if (String(plan.status || '').toUpperCase() === 'CANCELLED') {
    return false;
  }

  // Important safety:
  // Historical Match IDs are ignored unless lifecycle tracking
  // was explicitly started after v82.2.
  if (!plan.lifecycleTrackingStartedAt) return false;

  if (
    String(plan.status || '').toUpperCase() === 'CLOSED'
  ) {
    if (!plan.closeNotificationSent) {
      await sendMatchPlanClosedNotification(plan);
    }

    return true;
  }

  const timers =
    getActiveTimersForMatchId(plan.id);

  const warOps =
    getActiveWarOpsForMatchId(plan.id);

  if (timers.length || warOps.length) {
    return false;
  }

  const now = Date.now();

  plan.status = 'CLOSED';
  plan.warCompletedAt =
    plan.warCompletedAt || now;
  plan.allReleasedAt =
    plan.allReleasedAt || now;
  plan.closedAt =
    plan.closedAt || now;
  plan.closedBy = 'SYSTEM';
  plan.updatedAt = now;

  await saveMatchPlansNow();

  console.log(
    `✅ Match ID auto-closed: ${plan.id}`
  );

  await sendMatchPlanClosedNotification(plan);

  return true;
}

async function reconcileMatchPlanLifecycle() {
  if (matchPlanLifecycleProcessorRunning) return;

  matchPlanLifecycleProcessorRunning = true;

  try {
    for (const plan of matchPlans.values()) {
      await maybeAutoCloseMatchPlan(plan);
    }
  } catch (error) {
    console.error(
      "❌ Match lifecycle reconciliation failed:",
      error
    );
  } finally {
    matchPlanLifecycleProcessorRunning = false;
  }
}

function startMatchPlanLifecycleProcessor() {
  if (matchPlanLifecycleProcessorInterval) return;

  reconcileMatchPlanLifecycle().catch(() => {});

  matchPlanLifecycleProcessorInterval =
    setInterval(() => {
      reconcileMatchPlanLifecycle()
        .catch(error =>
          console.error(
            "❌ Match lifecycle processor error:",
            error
          )
        );
    }, 60 * 1000);

  if (
    matchPlanLifecycleProcessorInterval &&
    typeof matchPlanLifecycleProcessorInterval.unref === 'function'
  ) {
    matchPlanLifecycleProcessorInterval.unref();
  }

  console.log(
    "🆔 Match ID lifecycle processor started."
  );
}

function matchPlanHasWinLoseRoles(matchPlan) {
  if (!matchPlan || !Array.isArray(matchPlan.clubs) || matchPlan.clubs.length === 0) return false;
  return matchPlan.clubs.every(
    item => ["win", "lose"].includes(String(item?.matchRole || "").toLowerCase())
  );
}

// Interactive Match ID cancellation (/cancel_matchmaking).
// Cancelling a Match ID removes only the saved matchmaking plan from Supabase.
// Any timer already running keeps its own copied club list and is untouched.
const matchCancelSessions = new Map();
const MATCH_CANCEL_PAGE_SIZE = 25;
const MATCH_CANCEL_SESSION_TTL_MS = 30 * 60 * 1000;

function createMatchCancelSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cleanupMatchCancelSessions() {
  const now = Date.now();
  for (const [id, session] of matchCancelSessions.entries()) {
    if (!session || now - Number(session.updatedAt || session.createdAt || 0) > MATCH_CANCEL_SESSION_TTL_MS) {
      matchCancelSessions.delete(id);
    }
  }
}

function getMatchCancelPageCount(session) {
  return Math.max(1, Math.ceil(session.plans.length / MATCH_CANCEL_PAGE_SIZE));
}

function getMatchCancelPageItems(session) {
  const start = session.page * MATCH_CANCEL_PAGE_SIZE;
  return session.plans.slice(start, start + MATCH_CANCEL_PAGE_SIZE);
}

function buildMatchCancelView(session) {
  const pageCount = getMatchCancelPageCount(session);
  session.page = Math.min(Math.max(Number(session.page) || 0, 0), pageCount - 1);
  const pageItems = getMatchCancelPageItems(session);

  const options = pageItems.map(plan => {
    const activeCount = getMatchPlanActiveClubs(plan).length;
    const failedCount = getMatchPlanFailedClubs(plan).length;
    const min = Number(plan.minElo ?? plan.min ?? 0) || 0;
    const max = Number(plan.maxElo ?? plan.max ?? 0) || 0;
    const rangeText = min || max ? `${min}-${max}` : 'Saved Match';
    return {
      label: String(plan.id).slice(0, 100),
      description: `${rangeText} • Active ${activeCount} • Failed ${failedCount}`.slice(0, 100),
      value: String(plan.id),
      default: session.selectedId === plan.id
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`mc_select:${session.id}`)
    .setPlaceholder('Choose Match ID to cancel')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mc_prev:${session.id}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(session.page <= 0),
    new ButtonBuilder().setCustomId(`mc_next:${session.id}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(session.page >= pageCount - 1)
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mc_confirm:${session.id}`)
      .setLabel('❌ CANCEL MATCH ID')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!session.selectedId),
    new ButtonBuilder().setCustomId(`mc_cancel:${session.id}`).setLabel('CLOSE').setStyle(ButtonStyle.Secondary)
  );

  const selectRow = new ActionRowBuilder().addComponents(select);
  return {
    content:
      `🗑️ **CANCEL MATCHMAKING ID**\n` +
      `Select the Match ID you want to remove.\n\n` +
      `📄 Page: **${session.page + 1}/${pageCount}**\n` +
      `🆔 Saved Match IDs: **${session.plans.length}**` +
      (session.selectedId ? `\n✅ Selected: **${session.selectedId}**` : ''),
    components: [selectRow, navRow, actionRow]
  };
}

// Interactive Match ID status management (/match_fail and /match_restore).
// Changes only the saved match plan. Any timer that is already running keeps
// its own copied club list and is never modified by these commands.
const matchStatusSessions = new Map();
const MATCH_STATUS_PAGE_SIZE = 25;
const MATCH_STATUS_SESSION_TTL_MS = 30 * 60 * 1000;

function createMatchStatusSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cleanupMatchStatusSessions() {
  const now = Date.now();
  for (const [id, session] of matchStatusSessions.entries()) {
    if (!session || now - Number(session.updatedAt || session.createdAt || 0) > MATCH_STATUS_SESSION_TTL_MS) {
      matchStatusSessions.delete(id);
    }
  }
}

function getMatchStatusPageCount(session) {
  return Math.max(1, Math.ceil(session.clubs.length / MATCH_STATUS_PAGE_SIZE));
}

function getMatchStatusPageItems(session) {
  const start = session.page * MATCH_STATUS_PAGE_SIZE;
  return session.clubs.slice(start, start + MATCH_STATUS_PAGE_SIZE);
}

function buildMatchStatusView(session) {
  const pageCount = getMatchStatusPageCount(session);
  session.page = Math.min(Math.max(Number(session.page) || 0, 0), pageCount - 1);
  const pageItems = getMatchStatusPageItems(session);
  const options = pageItems.map(item => {
    const key = normalizeClubName(item.club);
    return {
      label: String(item.club).slice(0, 100),
      description: `${Number(item.elo) || 0} ELO • ${String(item.president || "Not Set").slice(0, 60)}`,
      value: key,
      default: session.selected.has(key)
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ms_select:${session.id}`)
    .setPlaceholder(session.mode === "fail" ? "❌ Select failed clubs" : "✅ Select clubs to restore")
    .setMinValues(0)
    .setMaxValues(Math.max(1, options.length))
    .addOptions(options);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ms_prev:${session.id}`).setLabel("◀ Previous").setStyle(ButtonStyle.Secondary).setDisabled(session.page <= 0),
    new ButtonBuilder().setCustomId(`ms_next:${session.id}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(session.page >= pageCount - 1),
    new ButtonBuilder().setCustomId(`ms_clear:${session.id}`).setLabel("Clear").setStyle(ButtonStyle.Secondary)
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ms_confirm:${session.id}`)
      .setLabel(session.mode === "fail" ? "❌ MARK FAILED" : "✅ RESTORE MATCH")
      .setStyle(session.mode === "fail" ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(session.selected.size === 0),
    new ButtonBuilder().setCustomId(`ms_cancel:${session.id}`).setLabel("CANCEL").setStyle(ButtonStyle.Secondary)
  );

  const selectRow = new ActionRowBuilder().addComponents(select);
  const activeCount = getMatchPlanActiveClubs(session.plan).length;
  const failedCount = getMatchPlanFailedClubs(session.plan).length;

  return {
    content:
      `${session.mode === "fail" ? "❌ **MARK MATCH FAILED**" : "✅ **RESTORE MATCH CLUBS**"}
` +
      `🆔 Match ID: **${session.matchId}**
` +
      `✅ Active Clubs: **${activeCount}**
` +
      `❌ Failed Clubs: **${failedCount}**
` +
      `☑️ Selected: **${session.selected.size}**
` +
      `📄 Page: **${session.page + 1}/${pageCount}**

` +
      (session.mode === "fail"
        ? "Select clubs that failed to match/push. They will be excluded from future timers using this Match ID."
        : "Select failed clubs to restore. They will be available again for future timers using this Match ID."),
    components: [selectRow, navRow, actionRow]
  };
}


const MATCHMAKING_SELECT_PAGE_SIZE =
  25;

const MATCHMAKING_SESSION_TTL_MS =
  30 * 60 * 1000;

// Persistent interactive /matchmaking setup state.
// This prevents Must Win / Must Lose / Skip selections from being lost
// when the Node.js process restarts or Hostinger redeploys the app,
// as long as this file is preserved.
const MATCHMAKING_SESSIONS_FILE =
  path.join(
    __dirname,
    "fow_matchmaking_sessions.json"
  );

function createMatchmakingSessionId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function serializeMatchmakingSession(
  session
) {
  return {
    id:
      String(session.id),
    userId:
      String(session.userId),
    min:
      Number(session.min),
    max:
      Number(session.max),
    rangeData:
      Array.isArray(
        session.rangeData
      )
        ? session.rangeData
        : [],
    category:
      String(
        session.category ||
        "must_win"
      ),
    page:
      Math.max(
        0,
        Number(session.page) || 0
      ),
    mustWin:
      Array.from(
        session.mustWin instanceof Set
          ? session.mustWin
          : []
      ),
    mustLose:
      Array.from(
        session.mustLose instanceof Set
          ? session.mustLose
          : []
      ),
    skip:
      Array.from(
        session.skip instanceof Set
          ? session.skip
          : []
      ),
    createdAt:
      Number(
        session.createdAt
      ) || Date.now(),
    updatedAt:
      Number(
        session.updatedAt
      ) || Date.now()
  };
}

function saveMatchmakingSessions() {
  try {
    const sessions =
      Array.from(
        matchmakingSessions.values()
      ).map(
        serializeMatchmakingSession
      );

    fs.writeFileSync(
      MATCHMAKING_SESSIONS_FILE,
      JSON.stringify(
        sessions,
        null,
        2
      ),
      "utf8"
    );

    queueSupabaseStateSave("matchmaking_sessions", sessions);
  } catch (error) {
    console.error(
      "❌ Failed to save fow_matchmaking_sessions.json:",
      error
    );
  }
}

async function persistMatchmakingSessionsNow() {
  saveMatchmakingSessions();
  await flushSupabaseStateSave("matchmaking_sessions");
}

function hydrateMatchmakingSession(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.userId) return null;

  const updatedAt = Number(raw.updatedAt || 0);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > MATCHMAKING_SESSION_TTL_MS) {
    return null;
  }

  const rangeData = Array.isArray(raw.rangeData) ? raw.rangeData : [];
  if (!rangeData.length) return null;

  return {
    id: String(raw.id),
    userId: String(raw.userId),
    min: Number(raw.min),
    max: Number(raw.max),
    rangeData,
    category: ["must_win", "must_lose", "skip"].includes(raw.category) ? raw.category : "must_win",
    page: Math.max(0, Number(raw.page) || 0),
    mustWin: new Set(Array.isArray(raw.mustWin) ? raw.mustWin.map(String) : []),
    mustLose: new Set(Array.isArray(raw.mustLose) ? raw.mustLose.map(String) : []),
    skip: new Set(Array.isArray(raw.skip) ? raw.skip.map(String) : []),
    createdAt: Number(raw.createdAt) || updatedAt,
    updatedAt
  };
}

async function recoverMatchmakingSession(sessionId) {
  const existing = matchmakingSessions.get(sessionId);
  if (existing) return existing;

  // First try the authoritative Supabase aggregate snapshot.
  if (supabasePersistenceReady) {
    try {
      const remote = await loadSupabaseState("matchmaking_sessions");
      if (Array.isArray(remote)) {
        const raw = remote.find(item => item && String(item.id) === String(sessionId));
        const recovered = hydrateMatchmakingSession(raw);
        if (recovered) {
          matchmakingSessions.set(recovered.id, recovered);
          console.log(`☁️ Matchmaking session ${sessionId} recovered from Supabase.`);
          return recovered;
        }
      }
    } catch (error) {
      console.error("❌ Supabase matchmaking session recovery failed:", error);
    }
  }

  // Local fallback for development / temporary Supabase outage.
  try {
    if (fs.existsSync(MATCHMAKING_SESSIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MATCHMAKING_SESSIONS_FILE, "utf8"));
      if (Array.isArray(parsed)) {
        const raw = parsed.find(item => item && String(item.id) === String(sessionId));
        const recovered = hydrateMatchmakingSession(raw);
        if (recovered) {
          matchmakingSessions.set(recovered.id, recovered);
          console.log(`♻️ Matchmaking session ${sessionId} recovered from local snapshot.`);
          return recovered;
        }
      }
    }
  } catch (error) {
    console.error("❌ Local matchmaking session recovery failed:", error);
  }

  return null;
}

async function deleteMatchmakingSessionPersistent(sessionId) {
  matchmakingSessions.delete(sessionId);
  await persistMatchmakingSessionsNow();
}

function loadMatchmakingSessions() {
  try {
    if (
      !fs.existsSync(
        MATCHMAKING_SESSIONS_FILE
      )
    ) {
      fs.writeFileSync(
        MATCHMAKING_SESSIONS_FILE,
        "[]",
        "utf8"
      );

      return;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          MATCHMAKING_SESSIONS_FILE,
          "utf8"
        )
      );

    if (
      !Array.isArray(parsed)
    ) {
      throw new Error(
        "Matchmaking sessions file must contain an array."
      );
    }

    const now =
      Date.now();

    let restored = 0;
    let removed = 0;

    matchmakingSessions.clear();

    for (
      const raw of parsed
    ) {
      if (
        !raw ||
        typeof raw !==
          "object" ||
        !raw.id ||
        !raw.userId
      ) {
        removed += 1;
        continue;
      }

      const updatedAt =
        Number(
          raw.updatedAt || 0
        );

      if (
        !Number.isFinite(
          updatedAt
        ) ||
        now -
          updatedAt >
          MATCHMAKING_SESSION_TTL_MS
      ) {
        removed += 1;
        continue;
      }

      const rangeData =
        Array.isArray(
          raw.rangeData
        )
          ? raw.rangeData
          : [];

      if (
        rangeData.length === 0
      ) {
        removed += 1;
        continue;
      }

      const category =
        [
          "must_win",
          "must_lose",
          "skip"
        ].includes(
          raw.category
        )
          ? raw.category
          : "must_win";

      const session = {
        id:
          String(raw.id),
        userId:
          String(raw.userId),
        min:
          Number(raw.min),
        max:
          Number(raw.max),
        rangeData,
        category,
        page:
          Math.max(
            0,
            Number(raw.page) ||
              0
          ),
        mustWin:
          new Set(
            Array.isArray(
              raw.mustWin
            )
              ? raw.mustWin.map(
                  value =>
                    String(value)
                )
              : []
          ),
        mustLose:
          new Set(
            Array.isArray(
              raw.mustLose
            )
              ? raw.mustLose.map(
                  value =>
                    String(value)
                )
              : []
          ),
        skip:
          new Set(
            Array.isArray(
              raw.skip
            )
              ? raw.skip.map(
                  value =>
                    String(value)
                )
              : []
          ),
        createdAt:
          Number(
            raw.createdAt
          ) || updatedAt,
        updatedAt
      };

      matchmakingSessions.set(
        session.id,
        session
      );

      restored += 1;
    }

    // Remove expired/corrupt entries from disk immediately.
    saveMatchmakingSessions();

    console.log(
      `💾 Matchmaking sessions restored: ${restored}` +
      (
        removed
          ? ` • removed expired/invalid: ${removed}`
          : ""
      )
    );
  } catch (error) {
    console.error(
      "❌ Failed to load fow_matchmaking_sessions.json:",
      error
    );

    matchmakingSessions.clear();
  }
}

loadMatchmakingSessions();

function cleanupMatchmakingSessions() {
  const now =
    Date.now();

  let changed =
    false;

  for (
    const [id, session] of
    matchmakingSessions.entries()
  ) {
    if (
      now -
      session.updatedAt >
      MATCHMAKING_SESSION_TTL_MS
    ) {
      matchmakingSessions.delete(id);
      changed =
        true;
    }
  }

  if (changed) {
    saveMatchmakingSessions();
  }
}

function getMatchmakingCategoryLabel(
  category
) {
  if (category === "must_win") {
    return "🏆 Must Win";
  }

  if (category === "must_lose") {
    return "💀 Must Lose";
  }

  return "⏭️ Skip";
}

function getMatchmakingCategorySet(
  session,
  category = session.category
) {
  if (category === "must_win") {
    return session.mustWin;
  }

  if (category === "must_lose") {
    return session.mustLose;
  }

  return session.skip;
}

function removeClubFromOtherSelections(
  session,
  category,
  clubKey
) {
  if (category !== "must_win") {
    session.mustWin.delete(clubKey);
  }

  if (category !== "must_lose") {
    session.mustLose.delete(clubKey);
  }

  if (category !== "skip") {
    session.skip.delete(clubKey);
  }
}

function getMatchmakingSessionPageCount(
  session
) {
  return Math.max(
    1,
    Math.ceil(
      session.rangeData.length /
      MATCHMAKING_SELECT_PAGE_SIZE
    )
  );
}

function getMatchmakingSessionPageItems(
  session
) {
  const start =
    session.page *
    MATCHMAKING_SELECT_PAGE_SIZE;

  return session.rangeData.slice(
    start,
    start +
      MATCHMAKING_SELECT_PAGE_SIZE
  );
}

function buildMatchmakingSelectionView(
  session
) {
  const pageCount =
    getMatchmakingSessionPageCount(
      session
    );

  if (session.page >= pageCount) {
    session.page =
      pageCount - 1;
  }

  if (session.page < 0) {
    session.page = 0;
  }

  const pageItems =
    getMatchmakingSessionPageItems(
      session
    );

  const activeSet =
    getMatchmakingCategorySet(
      session
    );

  const options =
    pageItems.map(
      item => {
        const key =
          normalizeClubName(
            item.club
          );

        return {
          label:
            String(item.club)
              .slice(0, 100),

          description:
            `${item.elo} ELO • ${String(
              item.president ||
              "Not Set"
            ).slice(0, 60)}`,

          value:
            key,

          default:
            activeSet.has(key)
        };
      }
    );

  const selectedOnPage =
    options.filter(
      option => option.default
    ).length;

  const select =
    new StringSelectMenuBuilder()
      .setCustomId(
        `mm_select:${session.id}`
      )
      .setPlaceholder(
        `${getMatchmakingCategoryLabel(
          session.category
        )} • select one or more clubs`
      )
      .setMinValues(0)
      .setMaxValues(
        Math.max(
          1,
          options.length
        )
      )
      .addOptions(options);

  const categoryRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `mm_category:${session.id}:must_win`
          )
          .setLabel(
            `Must Win (${session.mustWin.size})`
          )
          .setStyle(
            session.category ===
            "must_win"
              ? ButtonStyle.Success
              : ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            `mm_category:${session.id}:must_lose`
          )
          .setLabel(
            `Must Lose (${session.mustLose.size})`
          )
          .setStyle(
            session.category ===
            "must_lose"
              ? ButtonStyle.Danger
              : ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            `mm_category:${session.id}:skip`
          )
          .setLabel(
            `Skip (${session.skip.size})`
          )
          .setStyle(
            session.category ===
            "skip"
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary
          )
      );

  const selectRow =
    new ActionRowBuilder()
      .addComponents(
        select
      );

  const navigationRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `mm_prev:${session.id}`
          )
          .setLabel("◀ Previous")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page <= 0
          ),

        new ButtonBuilder()
          .setCustomId(
            `mm_next:${session.id}`
          )
          .setLabel("Next ▶")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.page >=
            pageCount - 1
          ),

        new ButtonBuilder()
          .setCustomId(
            `mm_clear:${session.id}`
          )
          .setLabel(
            "Clear Category"
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const actionRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `mm_generate:${session.id}`
          )
          .setLabel(
            "⚔️ Generate Matchmaking"
          )
          .setStyle(
            ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId(
            `mm_cancel:${session.id}`
          )
          .setLabel("Cancel")
          .setStyle(
            ButtonStyle.Danger
          )
      );

  const content =
    `⚔️ **FoW ELO MATCHMAKING SETUP**\n` +
    `ELO Range: **${session.min} - ${session.max}**\n` +
    `Eligible Derby Clubs: **${session.rangeData.length}**\n\n` +
    `Current Selection: **${getMatchmakingCategoryLabel(
      session.category
    )}**\n` +
    `Page: **${session.page + 1}/${pageCount}**\n` +
    `Selected on this page: **${selectedOnPage}**\n\n` +
    `🏆 Must Win: **${session.mustWin.size}**\n` +
    `💀 Must Lose: **${session.mustLose.size}**\n` +
    `⏭️ Skip: **${session.skip.size}**\n\n` +
    `Choose **one or more clubs** from the dropdown. ` +
    `Use the category buttons to switch between Must Win, Must Lose and Skip.`;

  return {
    content,
    components: [
      categoryRow,
      selectRow,
      navigationRow,
      actionRow
    ]
  };
}

function getForcedPairOutcome(
  a,
  b,
  mustWinSet,
  mustLoseSet
) {
  const aKey =
    normalizeClubName(
      a.club
    );

  const bKey =
    normalizeClubName(
      b.club
    );

  const aMustWin =
    mustWinSet.has(aKey);

  const bMustWin =
    mustWinSet.has(bKey);

  const aMustLose =
    mustLoseSet.has(aKey);

  const bMustLose =
    mustLoseSet.has(bKey);

  if (
    (aMustWin && aMustLose) ||
    (bMustWin && bMustLose) ||
    (aMustWin && bMustWin) ||
    (aMustLose && bMustLose)
  ) {
    return {
      valid: false,
      winner: null,
      loser: null,
      forcedCount: 0
    };
  }

  if (aMustWin) {
    return {
      valid: true,
      winner: a,
      loser: b,
      forcedCount:
        1 +
        (bMustLose ? 1 : 0)
    };
  }

  if (bMustWin) {
    return {
      valid: true,
      winner: b,
      loser: a,
      forcedCount:
        1 +
        (aMustLose ? 1 : 0)
    };
  }

  if (aMustLose) {
    return {
      valid: true,
      winner: b,
      loser: a,
      forcedCount: 1
    };
  }

  if (bMustLose) {
    return {
      valid: true,
      winner: a,
      loser: b,
      forcedCount: 1
    };
  }

  return {
    valid: true,
    winner: null,
    loser: null,
    forcedCount: 0
  };
}

// ============================================================
// MATCHMAKING ENGINE
// ============================================================

const MATCHMAKING_MAX_GAP = 100;

// ============================================================
// DERBY LIST
// ============================================================
// Derby membership is managed dynamically.
// Clubs remain in elo_database.json. The separate derby_config.json stores
// only clubs that are currently OUT of Derby. This lets /derby,
// /derby_leaderboard and /matchmaking use the same live Derby list.
const DERBY_CONFIG_FILE =
  path.join(
    __dirname,
    "derby_config.json"
  );

const DEFAULT_DERBY_EXCLUDED_CLUBS = [
  "FoW BlackSite II",
  "Blueheart",
  "FoW Cheers!",
  "FoW Fyr",
  "FoW Destruction inc",
  "The Drain",
  "FoW Scorpion XX"
];

function loadDerbyExcludedClubs() {
  try {
    if (
      !fs.existsSync(
        DERBY_CONFIG_FILE
      )
    ) {
      const initial = {
        excludedClubs:
          [...DEFAULT_DERBY_EXCLUDED_CLUBS]
      };

      fs.writeFileSync(
        DERBY_CONFIG_FILE,
        JSON.stringify(
          initial,
          null,
          2
        ),
        "utf8"
      );

      return initial.excludedClubs;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          DERBY_CONFIG_FILE,
          "utf8"
        )
      );

    if (
      !parsed ||
      !Array.isArray(
        parsed.excludedClubs
      )
    ) {
      throw new Error(
        "derby_config.json must contain an excludedClubs array"
      );
    }

    return parsed.excludedClubs
      .map(name => String(name || "").trim())
      .filter(Boolean);
  } catch (error) {
    console.error(
      "❌ Derby config load error. Using default exclusions:",
      error
    );

    return [
      ...DEFAULT_DERBY_EXCLUDED_CLUBS
    ];
  }
}

let derbyExcludedClubs =
  loadDerbyExcludedClubs();

function saveDerbyConfig() {
  try {
    fs.writeFileSync(
      DERBY_CONFIG_FILE,
      JSON.stringify(
        {
          excludedClubs:
            derbyExcludedClubs
        },
        null,
        2
      ),
      "utf8"
    );

    console.log(
      `💾 derby_config.json saved (${derbyExcludedClubs.length} excluded)`
    );

    // Supabase is the authoritative live Derby configuration.
    // Local JSON remains only as a runtime/default snapshot; no GitHub commit
    // is required for Derby add/remove operations.
    if (typeof queueSupabaseStateSave === "function") {
      queueSupabaseStateSave(
        "derby_config",
        { excludedClubs: [...derbyExcludedClubs] }
      );
    }

    return true;
  } catch (error) {
    console.error(
      "❌ Derby config save error:",
      error
    );

    return false;
  }
}

function getDerbyIdentityKeys(name) {
  const keys =
    new Set();

  const normalized =
    normalizeClubName(name);

  if (normalized) {
    keys.add(normalized);
  }

  const aliasTarget =
    clubAliases[
      normalizeClubAliasKey(name)
    ];

  if (aliasTarget) {
    keys.add(
      normalizeClubName(
        aliasTarget
      )
    );
  }

  // Preserve existing Blueheart/FoW Blueheart equivalence.
  if (
    normalized === "blueheart" ||
    normalized === "fowblueheart"
  ) {
    keys.add("blueheart");
    keys.add("fowblueheart");
  }

  return keys;
}

function isDerbyExcludedName(name) {
  const targetKeys =
    getDerbyIdentityKeys(name);

  return derbyExcludedClubs.some(
    excludedName => {
      const excludedKeys =
        getDerbyIdentityKeys(
          excludedName
        );

      for (
        const key of targetKeys
      ) {
        if (
          excludedKeys.has(key)
        ) {
          return true;
        }
      }

      return false;
    }
  );
}

function isDerbyClub(item) {
  return !isDerbyExcludedName(
    item.club
  );
}

function addClubToDerbyList(clubName) {
  const targetKeys =
    getDerbyIdentityKeys(
      clubName
    );

  const before =
    derbyExcludedClubs.length;

  derbyExcludedClubs =
    derbyExcludedClubs.filter(
      excludedName => {
        const excludedKeys =
          getDerbyIdentityKeys(
            excludedName
          );

        for (
          const key of targetKeys
        ) {
          if (
            excludedKeys.has(key)
          ) {
            return false;
          }
        }

        return true;
      }
    );

  return (
    derbyExcludedClubs.length !==
    before
  );
}

function removeClubFromDerbyList(clubName) {
  if (
    isDerbyExcludedName(
      clubName
    )
  ) {
    return false;
  }

  derbyExcludedClubs.push(
    String(clubName)
  );

  return true;
}

async function autoSyncDerbyConfigToGitHub(
  reason = "Derby list update"
) {
  try {
    validateGitHubConfig();

    const stamp =
      new Date().toISOString();

    await updateGitHubFile(
      "derby_config.json",
      DERBY_CONFIG_FILE,
      `FoW Derby config update - ${reason} - ${stamp}`
    );

    console.log(
      `☁️ Derby config GitHub sync complete: ${reason}`
    );

    return true;
  } catch (error) {
    console.error(
      `❌ Derby config GitHub auto-sync failed after ${reason}:`,
      error
    );

    return false;
  }
}

function getDerbyLeaderboard() {
  return getSortedLeaderboard()
    .filter(isDerbyClub);
}

function getDerbyFilteredLeaderboard(min, max) {
  return getDerbyLeaderboard()
    .filter(
      item =>
        Number(item.elo) >= Number(min) &&
        Number(item.elo) <= Number(max) &&
        isClubMatchmakingAvailable(item.club)
    );
}

// Different-group priority is calculated only from the current ELO.
// Nothing extra is stored in elo_database.json.
// Temporary ELO groups:
// 5100-5199, 5200-5299, 5300-5399, etc.
function getEloGroup(item) {
  return Math.floor(Number(item.elo) / 100);
}

function parseSkipList(text) {
  return String(text || "")
    .split(/[,;\n]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function itemMatchesSkip(item, token) {
  const normalizedToken =
    normalizeClubName(token);

  if (!normalizedToken) {
    return false;
  }

  const clubNormalized =
    normalizeClubName(item.club);

  const presidentNormalized =
    normalizeClubName(item.president);

  if (
    areEquivalentClubNames(
      item.club,
      token
    ) ||
    normalizedToken === presidentNormalized
  ) {
    return true;
  }

  const aliasTarget =
    clubAliases[
      normalizeClubAliasKey(token)
    ];

  if (
    aliasTarget &&
    normalizeClubName(aliasTarget) ===
      clubNormalized
  ) {
    return true;
  }

  return false;
}

function compareMatchmakingResults(a, b) {
  if (!b) {
    return 1;
  }

  // Hard priority: satisfy as many Must Win / Must Lose clubs as possible.
  if (
    (a.forcedMatched || 0) !==
    (b.forcedMatched || 0)
  ) {
    return (a.forcedMatched || 0) >
      (b.forcedMatched || 0)
      ? 1
      : -1;
  }

  // Priority 1: most different-tier matches.
  if (
    a.differentTierMatches !==
    b.differentTierMatches
  ) {
    return a.differentTierMatches >
      b.differentTierMatches
      ? 1
      : -1;
  }

  // Priority 2: most clubs successfully matched.
  if (
    a.matchedClubs !==
    b.matchedClubs
  ) {
    return a.matchedClubs >
      b.matchedClubs
      ? 1
      : -1;
  }

  // Priority 3: largest total ELO gap.
  if (
    a.totalGap !==
    b.totalGap
  ) {
    return a.totalGap >
      b.totalGap
      ? 1
      : -1;
  }

  // Priority 4: compare individual gaps from largest to smallest.
  const gapsA = [...a.gaps]
    .sort((x, y) => y - x);

  const gapsB = [...b.gaps]
    .sort((x, y) => y - x);

  const length = Math.max(
    gapsA.length,
    gapsB.length
  );

  for (let i = 0; i < length; i++) {
    const gapA = (gapsA[i] !== undefined && gapsA[i] !== null) ? gapsA[i] : -1;
    const gapB = (gapsB[i] !== undefined && gapsB[i] !== null) ? gapsB[i] : -1;

    if (gapA !== gapB) {
      return gapA > gapB
        ? 1
        : -1;
    }
  }

  return 0;
}

function emptyMatchmakingResult() {
  return {
    pairs: [],
    unmatched: [],
    differentTierMatches: 0,
    matchedClubs: 0,
    totalGap: 0,
    gaps: [],
    forcedMatched: 0
  };
}

function optimizeMatchmakingExact(inputData, mustWinSet = new Set(), mustLoseSet = new Set()) {
  const data = [...inputData]
    .sort(
      (a, b) =>
        Number(b.elo) -
        Number(a.elo)
    );

  const n = data.length;

  if (n === 0) {
    return emptyMatchmakingResult();
  }

  // Exact solver using memoized bitmask search. Choosing the club with
  // the fewest remaining legal opponents dramatically reduces states.
  // BigInt keeps the mask safe beyond JavaScript's 32-bit bit operators.
  const adjacency = Array.from(
    { length: n },
    () => 0n
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const gap = Math.abs(
        Number(data[i].elo) -
        Number(data[j].elo)
      );

      const outcome =
        getForcedPairOutcome(
          data[i],
          data[j],
          mustWinSet,
          mustLoseSet
        );

      if (
        gap <= MATCHMAKING_MAX_GAP &&
        outcome.valid
      ) {
        adjacency[i] |= 1n << BigInt(j);
        adjacency[j] |= 1n << BigInt(i);
      }
    }
  }

  const memo = new Map();

  function hasBit(mask, index) {
    return (
      mask &
      (1n << BigInt(index))
    ) !== 0n;
  }

  function bitCount(mask) {
    let count = 0;

    while (mask) {
      mask &= mask - 1n;
      count++;
    }

    return count;
  }

  function chooseClub(mask) {
    let chosen = -1;
    let fewest = Infinity;

    for (let i = 0; i < n; i++) {
      if (!hasBit(mask, i)) {
        continue;
      }

      const opponents =
        adjacency[i] & mask;

      const count =
        bitCount(opponents);

      if (count < fewest) {
        fewest = count;
        chosen = i;

        if (count === 0) {
          break;
        }
      }
    }

    return chosen;
  }

  function solve(mask) {
    if (mask === 0n) {
      return emptyMatchmakingResult();
    }

    const key = mask.toString();

    if (memo.has(key)) {
      return memo.get(key);
    }

    const first = chooseClub(mask);
    const firstBit =
      1n << BigInt(first);

    const withoutFirst =
      mask & ~firstBit;

    const unmatchedSub =
      solve(withoutFirst);

    let best = {
      pairs: [...unmatchedSub.pairs],
      unmatched: [
        data[first],
        ...unmatchedSub.unmatched
      ],
      differentTierMatches:
        unmatchedSub.differentTierMatches,
      matchedClubs:
        unmatchedSub.matchedClubs,
      totalGap:
        unmatchedSub.totalGap,
      gaps: [...unmatchedSub.gaps],
      forcedMatched:
        unmatchedSub.forcedMatched || 0
    };

    let opponentMask =
      adjacency[first] & withoutFirst;

    while (opponentMask !== 0n) {
      let opponent = -1;

      for (let j = 0; j < n; j++) {
        if (hasBit(opponentMask, j)) {
          opponent = j;
          break;
        }
      }

      const opponentBit =
        1n << BigInt(opponent);

      opponentMask &= ~opponentBit;

      const nextMask =
        withoutFirst & ~opponentBit;

      const sub = solve(nextMask);

      const gap = Math.abs(
        Number(data[first].elo) -
        Number(data[opponent].elo)
      );

      const differentTier =
        getEloGroup(data[first]) !==
        getEloGroup(data[opponent]);

      const outcome =
        getForcedPairOutcome(
          data[first],
          data[opponent],
          mustWinSet,
          mustLoseSet
        );

      const candidate = {
        pairs: [
          {
            a: data[first],
            b: data[opponent],
            gap,
            differentTier,
            winner: outcome.winner,
            loser: outcome.loser
          },
          ...sub.pairs
        ],
        unmatched: [...sub.unmatched],
        differentTierMatches:
          sub.differentTierMatches +
          (differentTier ? 1 : 0),
        matchedClubs:
          sub.matchedClubs + 2,
        totalGap:
          sub.totalGap + gap,
        gaps: [gap, ...sub.gaps],
        forcedMatched:
          (sub.forcedMatched || 0) +
          outcome.forcedCount
      };

      if (
        compareMatchmakingResults(
          candidate,
          best
        ) > 0
      ) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  }

  const fullMask =
    (1n << BigInt(n)) - 1n;

  return solve(fullMask);
}

function optimizeMatchmakingFallback(inputData, mustWinSet = new Set(), mustLoseSet = new Set()) {
  // Safety fallback only for unusually large selections. It still honors
  // all hard rules and priorities, but exact global search is intentionally
  // limited to avoid freezing the Discord process on huge ranges.
  const remaining = [...inputData]
    .sort(
      (a, b) =>
        Number(b.elo) -
        Number(a.elo)
    );

  const pairs = [];

  while (remaining.length >= 2) {
    let best = null;

    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const a = remaining[i];
        const b = remaining[j];

        const gap = Math.abs(
          Number(a.elo) -
          Number(b.elo)
        );

        if (gap > MATCHMAKING_MAX_GAP) {
          continue;
        }

        const outcome =
          getForcedPairOutcome(
            a,
            b,
            mustWinSet,
            mustLoseSet
          );

        if (!outcome.valid) {
          continue;
        }

        const differentTier =
          getEloGroup(a) !==
          getEloGroup(b);

        const candidate = {
          i,
          j,
          a,
          b,
          gap,
          differentTier,
          winner: outcome.winner,
          loser: outcome.loser,
          forcedCount: outcome.forcedCount
        };

        if (
          !best ||
          candidate.forcedCount >
            best.forcedCount ||
          (
            candidate.forcedCount ===
              best.forcedCount &&
            Number(candidate.differentTier) >
              Number(best.differentTier)
          ) ||
          (
            candidate.forcedCount ===
              best.forcedCount &&
            candidate.differentTier ===
              best.differentTier &&
            candidate.gap > best.gap
          )
        ) {
          best = candidate;
        }
      }
    }

    if (!best) {
      break;
    }

    pairs.push({
      a: best.a,
      b: best.b,
      gap: best.gap,
      differentTier: best.differentTier,
      winner: best.winner,
      loser: best.loser
    });

    const removeIndexes = [
      best.i,
      best.j
    ].sort((a, b) => b - a);

    for (const index of removeIndexes) {
      remaining.splice(index, 1);
    }
  }

  return {
    pairs,
    unmatched: remaining,
    differentTierMatches:
      pairs.filter(
        pair => pair.differentTier
      ).length,
    matchedClubs:
      pairs.length * 2,
    totalGap:
      pairs.reduce(
        (sum, pair) =>
          sum + pair.gap,
        0
      ),
    gaps:
      pairs.map(pair => pair.gap),
    forcedMatched:
      pairs.reduce(
        (sum, pair) => {
          const aKey =
            normalizeClubName(pair.a.club);
          const bKey =
            normalizeClubName(pair.b.club);

          return sum +
            Number(
              mustWinSet.has(aKey) ||
              mustLoseSet.has(aKey)
            ) +
            Number(
              mustWinSet.has(bKey) ||
              mustLoseSet.has(bKey)
            );
        },
        0
      )
  };
}

function optimizeMatchmaking(inputData, mustWinSet = new Set(), mustLoseSet = new Set()) {
  // Typical FoW ranges such as 5100-5500 are solved exactly.
  // Use fallback only for exceptionally large selections.
  if (inputData.length <= 32) {
    return optimizeMatchmakingExact(
      inputData,
      mustWinSet,
      mustLoseSet
    );
  }

  return optimizeMatchmakingFallback(
    inputData,
    mustWinSet,
    mustLoseSet
  );
}

function formatMatchmakingOutput(
  result,
  min,
  max,
  skipped,
  matchId = null
) {
  let output =
    `⚔️ **FoW ELO MATCHMAKING**\n` +
    (matchId ? `Match ID: **${matchId}**\n` : ``) +
    `ELO Range: **${min} - ${max}**\n` +
    `Maximum Gap: **${MATCHMAKING_MAX_GAP}**\n\n`;

  if (result.pairs.length === 0) {
    output +=
      "No valid matches found.\n\n";
  }

  const sortedPairs =
    [...result.pairs]
      .map(pair => {
        let top;
        let bottom;

        if (
          pair.winner &&
          pair.loser
        ) {
          top =
            pair.winner;

          bottom =
            pair.loser;
        } else {
          top =
            pair.a;

          bottom =
            pair.b;

          if (
            Number(bottom.elo) >
            Number(top.elo)
          ) {
            [top, bottom] =
              [bottom, top];
          }
        }

        return {
          ...pair,
          top,
          bottom
        };
      })
      .sort((a, b) => {
        const topDiff =
          Number(b.top.elo) -
          Number(a.top.elo);

        if (topDiff !== 0) {
          return topDiff;
        }

        const bottomDiff =
          Number(b.bottom.elo) -
          Number(a.bottom.elo);

        if (bottomDiff !== 0) {
          return bottomDiff;
        }

        return
          Number(b.gap) -
          Number(a.gap);
      });

  sortedPairs.forEach(
    (pair, index) => {
      const topPusher =
        String(pair.top.president || "Not Set").trim();

      const bottomPusher =
        String(pair.bottom.president || "Not Set").trim();

      // v54 display rule:
      // - Winner is always the top club.
      // - Must Win / Must Lose overrides are already reflected in pair.top.
      // - Ordinary pairs use the higher-ELO club as winner.
      // - No WIN / LOSE wording is printed; bold alone identifies the winner.
      const topLine = `${pair.top.club} (${pair.top.elo}) — ${topPusher}`;
      const bottomLine = `${pair.bottom.club} (${pair.bottom.elo}) — ${bottomPusher}`;

      // v55 layout restore: keep every pair as a clear 3-line block.
      // This intentionally matches the older mobile-friendly Discord layout:
      // winner/top club on line 1, opponent on line 2, gap on line 3.
      // v56 hard line-break fix:
      // Build the block as one explicit string so Discord cannot accidentally
      // concatenate the opponent line and Gap line during later formatting.
      // Two trailing spaces before each newline also force a Markdown hard break
      // on clients that render single newlines inconsistently.
      const pairBlock =
        `${index + 1}. **${topLine}**  \n` +
        `   vs ${bottomLine}  \n` +
        `   **Gap: ${pair.gap}**\n\n`;

      output += pairBlock;
    }
  );

  output +=
    "**Unmatched / Skipped**\n";

  if (
    result.unmatched.length === 0 &&
    skipped.length === 0
  ) {
    output += "- None\n";
  }

  [...result.unmatched]
    .sort(
      (a, b) =>
        Number(b.elo) -
        Number(a.elo)
    )
    .forEach(item => {
      output +=
        `- ${item.club} (${item.elo}) — **NO MATCH**\n`;
    });

  [...skipped]
    .sort(
      (a, b) =>
        Number(b.elo) -
        Number(a.elo)
    )
    .forEach(item => {
      output +=
        `- ${item.club} (${item.elo}) — **SKIPPED**\n`;
    });

  return output;
}

function splitDiscordText(
  text,
  maxLength = 1900
) {
  const lines =
    String(text).split("\n");

  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current
      ? `${current}\n${line}`
      : line;

    if (next.length > maxLength) {
      if (current) {
        chunks.push(current);
      }

      current = line;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

// ============================================================
// AUTO UPDATE ELO FROM NORMAL MESSAGE
// ============================================================

function parseAndUpdateElo(text) {
  // Refresh from disk first so manual/server-side DB changes are preserved.
  reloadLatestDatabase();

  const lines =
    String(text)
      .split(/\r?\n/)
      .map(
        line =>
          line.trim()
      )
      .filter(Boolean);

  const result = {
    updated: [],
    unchanged: [],
    notFound: [],
    invalid: []
  };

  for (const line of lines) {
    const match =
      line.match(
        /^(.+?)\s*\(\s*(\d{4,5})\s*\)\s*$/
      );

    if (!match) {
      result.invalid.push(
        line
      );

      continue;
    }

    const inputClub =
      match[1].trim();

    // Strict normal-message ELO update safety:
    // ONLY "Club Name (ELO)" is accepted.
    // President/pusher text, pipes, hyphen suffixes and VS lines are rejected.
    if (
      inputClub.includes("|") ||
      /\s+-\s+/.test(inputClub) ||
      /\s+vs\s+/i.test(inputClub)
    ) {
      result.invalid.push(line);
      continue;
    }

    const newElo =
      Number(match[2]);

    const index =
      findClubIndex(
        inputClub
      );

    if (index === -1) {
      result.notFound.push({
        club:
          inputClub,

        elo:
          newElo
      });

      continue;
    }

    const oldElo =
      Number(
        leaderboardData[
          index
        ].elo
      );

    const clubName =
      leaderboardData[
        index
      ].club;

    if (
      oldElo ===
      newElo
    ) {
      result.unchanged.push({
        club:
          clubName,

        elo:
          oldElo
      });

      continue;
    }

    leaderboardData[
      index
    ].elo =
      newElo;

    result.updated.push({
      club:
        clubName,

      oldElo,
      newElo
    });
  }

  if (
    result.updated.length >
    0
  ) {
    saveDatabase();
  }

  return result;
}

// ============================================================
// HTML
// ============================================================

function escapeHTML(value) {
  return String(
    (value !== undefined && value !== null ? value : "")
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

function getArenaFromElo(elo) {
  const value = Number(elo);

  if (!Number.isFinite(value)) {
    return "—";
  }

  if (value >= 4600) return "A7";
  if (value >= 4000) return "A6";
  if (value >= 3500) return "A5";
  if (value >= 3000) return "A4";
  if (value >= 2400) return "A3";
  if (value >= 1800) return "A2";
  if (value >= 1500) return "A1";

  return "—";
}

function generateHTML(
  data,
  title,
  subtitle
) {
  const rows =
    data.map(
      (item, index) => `
        <tr>
          <td class="rank">
            ${index + 1}
          </td>

          <td class="club">
            ${escapeHTML(
              item.club
            )}
          </td>

          <td class="president">
            ${escapeHTML(
              item.president
            )}
          </td>

          <td class="elo">
            ${escapeHTML(
              item.elo
            )}
          </td>

          <td class="arena">
            ${escapeHTML(
              getArenaFromElo(item.elo)
            )}
          </td>
        </tr>
      `
    ).join("");

  return `
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
${escapeHTML(title)}
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 30px;

  background:
    radial-gradient(
      circle at top,
      #12344e 0%,
      #07131f 45%,
      #030a10 100%
    );

  color: white;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

  min-height: 100vh;
}

.container {
  max-width: 1100px;
  margin: auto;
}

.header {
  text-align: center;
  margin-bottom: 25px;
}

h1 {
  margin: 0;

  color:
    #5ed8ff;

  font-size:
    36px;
}

.subtitle {
  margin-top:
    10px;

  color:
    #ffd54f;

  font-size:
    18px;

  font-weight:
    bold;
}

.count {
  margin-top:
    8px;

  color:
    #9db8ca;
}

.table-wrapper {
  overflow-x:
    auto;

  border-radius:
    14px;

  border:
    1px solid #25485f;

  box-shadow:
    0 8px 30px
    rgba(0,0,0,0.45);
}

table {
  width:
    100%;

  border-collapse:
    collapse;

  background:
    rgba(9,29,43,0.95);
}

thead {
  background:
    linear-gradient(
      90deg,
      #08685f,
      #0b8173
    );
}

th {
  padding:
    15px 10px;
}

td {
  padding:
    11px 10px;

  border-bottom:
    1px solid #1c394c;
}

tbody tr:nth-child(even) {
  background:
    rgba(
      255,
      255,
      255,
      0.025
    );
}

tbody tr:hover {
  background:
    #143b53;
}

.rank {
  width:
    60px;

  text-align:
    center;

  font-weight:
    bold;
}

.club {
  font-weight:
    bold;
}

.president {
  color:
    #6fcaff;

  font-weight:
    bold;
}

.elo {
  width:
    120px;

  text-align:
    center;

  color:
    #ffd54f;

  font-size:
    16px;

  font-weight:
    bold;
}

.arena {
  width:
    100px;

  text-align:
    center;

  color:
    #ffffff;

  font-size:
    16px;

  font-weight:
    bold;
}

.footer {
  margin-top:
    20px;

  text-align:
    center;

  color:
    #718b9b;

  font-size:
    12px;
}

</style>

</head>

<body>

<div class="container">

  <div class="header">

    <h1>
      ⚔️ ${escapeHTML(title)}
    </h1>

    <div class="subtitle">
      ${escapeHTML(
        subtitle
      )}
    </div>

    <div class="count">
      Total Clubs:
      ${data.length}
    </div>

  </div>

  <div class="table-wrapper">

    <table>

      <thead>
        <tr>
          <th>#</th>
          <th>Club</th>
          <th>President</th>
          <th>ELO</th>
          <th>Arena</th>
        </tr>
      </thead>

      <tbody>
        ${rows}
      </tbody>

    </table>

  </div>

  <div class="footer">
    FoW Empire ELO Database
    •
    Generated
    ${new Date().toLocaleString()}
  </div>

</div>

</body>

</html>
`;
}

// ============================================================
// EXPRESS
// ============================================================

const app =
  express();

// ============================================================
// PRIVATE LEADERBOARD AUTHENTICATION
// ============================================================
// Set these in Hostinger -> Environment variables:
// LEADERBOARD_USERNAME
// LEADERBOARD_PASSWORD
//
// /health remains public so Hostinger/uptime checks can verify
// that the Node.js service is running. All leaderboard/download/API
// routes are protected with HTTP Basic Authentication.

function secureStringEqual(a, b) {
  const crypto = require("crypto");
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function requireLeaderboardAuth(req, res, next) {
  if (req.path === "/health") {
    return next();
  }

  const expectedUsername = process.env.LEADERBOARD_USERNAME;
  const expectedPassword = process.env.LEADERBOARD_PASSWORD;

  // Fail closed if Hostinger environment variables are not configured.
  if (!expectedUsername || !expectedPassword) {
    console.error(
      "❌ Private leaderboard is enabled, but LEADERBOARD_USERNAME or LEADERBOARD_PASSWORD is missing."
    );

    return res
      .status(503)
      .send("Private leaderboard login is not configured yet.");
  }

  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Basic ")) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="FoW Empire Private Leaderboard", charset="UTF-8"'
    );

    return res
      .status(401)
      .send("Authentication required.");
  }

  let decoded = "";

  try {
    decoded = Buffer.from(
      authorization.slice(6),
      "base64"
    ).toString("utf8");
  } catch (error) {
    decoded = "";
  }

  const separatorIndex = decoded.indexOf(":");
  const suppliedUsername =
    separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
  const suppliedPassword =
    separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  const usernameMatches = secureStringEqual(
    suppliedUsername,
    expectedUsername
  );

  const passwordMatches = secureStringEqual(
    suppliedPassword,
    expectedPassword
  );

  if (!usernameMatches || !passwordMatches) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="FoW Empire Private Leaderboard", charset="UTF-8"'
    );

    return res
      .status(401)
      .send("Invalid username or password.");
  }

  next();
}

// Public GitHub webhook endpoint for the ChatGPT bridge.
// This route is deliberately registered BEFORE leaderboard Basic Auth.
// GitHub requests are authenticated with X-Hub-Signature-256 instead.
app.post(
  "/bridge/github",
  express.raw({ type: "application/json", limit: "256kb" }),
  handleChatgptBridgeWebhook
);


// ============================================================
// CHATGPT READ-ONLY ELO API
// ============================================================
// Dedicated read-only endpoint for ChatGPT.
// Uses a separate Bearer token and never modifies ELO/database state.
function requireChatgptReadAuth(req, res, next) {
  if (!CHATGPT_READ_TOKEN || CHATGPT_READ_TOKEN.length < 32) {
    return res.status(503).json({
      ok: false,
      error: "read_api_not_configured"
    });
  }

  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      ok: false,
      error: "authentication_required"
    });
  }

  const suppliedToken = authorization.slice(7).trim();

  if (!secureStringEqual(suppliedToken, CHATGPT_READ_TOKEN)) {
    return res.status(401).json({
      ok: false,
      error: "invalid_token"
    });
  }

  next();
}

app.get(
  "/bridge/read/elo",
  requireChatgptReadAuth,
  (req, res) => {
    const clubs = getSortedLeaderboard();

    res.setHeader("Cache-Control", "no-store");

    res.json({
      ok: true,
      source: "fow-production",
      timestamp: new Date().toISOString(),
      count: clubs.length,
      clubs
    });
  }
);

app.use(requireLeaderboardAuth);

// MAIN LEADERBOARD
app.get(
  "/",
  (req, res) => {

    res.send(
      generateHTML(
        getSortedLeaderboard(),
        "FoW Empire",
        "Global ELO Leaderboard"
      )
    );

  }
);

// FULL DOWNLOAD
app.get(
  "/download",
  (req, res) => {

    const data =
      getSortedLeaderboard();

    const html =
      generateHTML(
        data,
        "FoW Empire",
        "Global ELO Leaderboard"
      );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="FoW_ELO_Leaderboard.html"'
    );

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(
      html
    );

  }
);

// RANGE DOWNLOAD
app.get(
  "/download-elo",
  (req, res) => {

    const min =
      Number(
        req.query.min
      );

    const max =
      Number(
        req.query.max
      );

    if (
      !Number.isFinite(min) ||
      !Number.isFinite(max)
    ) {
      return res
        .status(400)
        .send(
          "Example: /download-elo?min=5100&max=5500"
        );
    }

    if (
      min > max
    ) {
      return res
        .status(400)
        .send(
          "Minimum ELO cannot be higher than Maximum ELO."
        );
    }

    const data =
      getFilteredLeaderboard(
        min,
        max
      );

    if (
      data.length === 0
    ) {
      return res
        .status(404)
        .send(
          `No clubs found between ${min} and ${max} ELO.`
        );
    }

    const html =
      generateHTML(
        data,
        "FoW Empire",
        `ELO ${min} - ${max}`
      );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="FoW_ELO_${min}-${max}.html"`
    );

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(
      html
    );

  }
);

// API
app.get(
  "/api/leaderboard",
  (req, res) => {

    res.json(
      getSortedLeaderboard()
    );

  }
);

// HEALTH CHECK
// Public endpoint used to confirm that the Hostinger Node.js process is alive.
// It intentionally does NOT expose tokens, passwords, connection strings,
// Discord IDs, or any other secret configuration.
function formatProcessUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

app.get(
  "/health",
  (req, res) => {
    const discordReady = Boolean(
      client &&
      typeof client.isReady === "function" &&
      client.isReady()
    );

    const databaseReady = Array.isArray(leaderboardData);
    const supabaseReady = Boolean(
      supabasePersistenceReady &&
      supabasePool
    );

    res.json({
      status:
        discordReady && databaseReady
          ? "healthy"
          : "degraded",

      node: "online",
      discord: discordReady ? "online" : "offline",
      database: databaseReady ? "ok" : "error",
      supabase: supabaseReady ? "connected" : "unavailable",
      clubs: databaseReady ? leaderboardData.length : 0,
      uptimeSeconds: Math.floor(process.uptime()),
      uptime: formatProcessUptime(process.uptime()),
      timestamp: new Date().toISOString()
    });
  }
);

// ============================================================
// START EXPRESS
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      "===================================="
    );

    console.log(
      `🌐 Leaderboard: http://localhost:${PORT}`
    );

    console.log(
      `📥 Full HTML: http://localhost:${PORT}/download`
    );

    console.log(
      `🎯 Range HTML: http://localhost:${PORT}/download-elo?min=5100&max=5500`
    );

    console.log(
      `📊 API: http://localhost:${PORT}/api/leaderboard`
    );

    console.log(
      `💾 Database: ${DATABASE_FILE}`
    );

    console.log(
      `📌 Default DB: ${DEFAULT_DATABASE_FILE}`
    );

    console.log(
      "===================================="
    );

  }
);

// ============================================================
// DISCORD CLIENT
// ============================================================

const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

// ============================================================
// DISCORD CONNECTION HEALTH / SELF-RECOVERY STATE
// ============================================================
// discord.js already performs normal gateway reconnection automatically.
// The watchdog below only performs a controlled re-login if the client stays
// non-ready for several minutes, preventing aggressive reconnect loops.
let discordDisconnectedSince = null;
let discordRecoveryInProgress = false;
let lastDiscordRecoveryAttemptAt = 0;
let discordRecoveryAttempts = 0;

const DISCORD_RECOVERY_CHECK_INTERVAL_MS = 30 * 1000;
const DISCORD_RECOVERY_OFFLINE_THRESHOLD_MS = 60 * 1000;
const DISCORD_RECOVERY_COOLDOWN_MS = 2 * 60 * 1000;

function markDiscordHealthy() {
  discordDisconnectedSince = null;
  discordRecoveryAttempts = 0;
}

function markDiscordDisconnected() {
  if (!discordDisconnectedSince) {
    discordDisconnectedSince = Date.now();
  }
}

async function attemptDiscordSoftRecovery() {
  if (discordRecoveryInProgress) return;
  if (!TOKEN) return;
  if (!applicationStarted) return;
  if (client.isReady()) {
    markDiscordHealthy();
    return;
  }

  const now = Date.now();
  if (!discordDisconnectedSince) {
    discordDisconnectedSince = now;
    return;
  }

  if (now - discordDisconnectedSince < DISCORD_RECOVERY_OFFLINE_THRESHOLD_MS) {
    return;
  }

  if (now - lastDiscordRecoveryAttemptAt < DISCORD_RECOVERY_COOLDOWN_MS) {
    return;
  }

  discordRecoveryInProgress = true;
  lastDiscordRecoveryAttemptAt = now;
  discordRecoveryAttempts += 1;

  console.warn(
    `🩺 Discord watchdog: client has remained offline for at least 60 seconds. ` +
    `Starting controlled recovery attempt #${discordRecoveryAttempts}.`
  );

  try {
    try {
      client.destroy();
    } catch (error) {
      console.warn(
        "⚠️ Discord watchdog: client.destroy() warning:",
        error?.message || error
      );
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
    await client.login(TOKEN);
    markDiscordHealthy();
    console.log("✅ Discord watchdog: controlled re-login succeeded.");
  } catch (error) {
    markDiscordDisconnected();
    console.error(
      "❌ Discord watchdog recovery failed:",
      error?.message || error
    );
  } finally {
    discordRecoveryInProgress = false;
  }
}

// ============================================================
// GITHUB API SYNC
// ============================================================
// Hostinger Business friendly:
// - No local git command required
// - No SSH key required
// - Uses GitHub REST API with GITHUB_TOKEN
//
// Required Hostinger environment variables:
//   GITHUB_TOKEN
//   GITHUB_OWNER
//   GITHUB_REPO
//   GITHUB_BRANCH
//
// Fine-grained token permission:
//   Contents -> Read and write

function validateGitHubConfig() {
  const missing = [];

  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GITHUB_OWNER) missing.push("GITHUB_OWNER");
  if (!GITHUB_REPO) missing.push("GITHUB_REPO");
  if (!GITHUB_BRANCH) missing.push("GITHUB_BRANCH");

  if (missing.length > 0) {
    throw new Error(
      `Missing GitHub environment variable(s): ${missing.join(", ")}`
    );
  }
}

function githubRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);

    const headers = {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "FoW-ELO-Bot"
    };

    if (payload !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const request = https.request(
      {
        hostname: "api.github.com",
        port: 443,
        path: apiPath,
        method,
        headers
      },
      response => {
        let raw = "";

        response.on("data", chunk => {
          raw += chunk;
        });

        response.on("end", () => {
          let parsed = null;

          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }

          if (
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve({
              status: response.statusCode,
              data: parsed
            });
            return;
          }

          const message =
            parsed && typeof parsed === "object" && parsed.message
              ? parsed.message
              : String(raw || "");

          const error = new Error(
            `GitHub API ${response.statusCode}: ${message}`
          );

          error.statusCode = response.statusCode;
          error.response = parsed;
          reject(error);
        });
      }
    );

    request.on("error", reject);

    if (payload !== null) {
      request.write(payload);
    }

    request.end();
  });
}

function encodeGitHubPath(filePath) {
  return String(filePath)
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
}

async function getGitHubFileSha(repoFilePath) {
  const encodedPath = encodeGitHubPath(repoFilePath);

  const apiPath =
    `/repos/${encodeURIComponent(GITHUB_OWNER)}` +
    `/${encodeURIComponent(GITHUB_REPO)}` +
    `/contents/${encodedPath}` +
    `?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  try {
    const response = await githubRequest("GET", apiPath);
    return (response.data && response.data.sha) || null;
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function updateGitHubFile(
  repoFilePath,
  localFilePath,
  commitMessage
) {
  validateGitHubConfig();

  if (!fs.existsSync(localFilePath)) {
    throw new Error(
      `Local file not found: ${localFilePath}`
    );
  }

  const content =
    fs.readFileSync(localFilePath)
      .toString("base64");

  const sha =
    await getGitHubFileSha(repoFilePath);

  const encodedPath =
    encodeGitHubPath(repoFilePath);

  const apiPath =
    `/repos/${encodeURIComponent(GITHUB_OWNER)}` +
    `/${encodeURIComponent(GITHUB_REPO)}` +
    `/contents/${encodedPath}`;

  const body = {
    message: commitMessage,
    content,
    branch: GITHUB_BRANCH
  };

  // GitHub requires the current file SHA when replacing an existing file.
  if (sha) {
    body.sha = sha;
  }

  const response =
    await githubRequest(
      "PUT",
      apiPath,
      body
    );

  return response.data;
}

async function syncDatabaseToGitHub(
  reason = "manual sync"
) {
  validateGitHubConfig();

  reloadLatestDatabase();

  const stamp =
    new Date().toISOString();

  const liveResult =
    await updateGitHubFile(
      "elo_database.json",
      DATABASE_FILE,
      `FoW ELO database update - ${reason} - ${stamp}`
    );

  console.log(
    `☁️ GitHub API sync complete: ${reason}`
  );

  return {
    changed: true,
    liveCommit:
      (liveResult &&
       liveResult.commit &&
       liveResult.commit.sha) ||
      null
  };
}

// Kept for explicit/manual GitHub synchronization workflows only.
// Normal add/edit/delete club and Derby membership changes do NOT call this,
// preventing Hostinger auto-deploys during live operations.
async function autoSyncDatabaseToGitHub(reason = "database update") {
  try {
    await syncDatabaseToGitHub(reason);
    return true;
  } catch (error) {
    console.error(
      `❌ GitHub API auto-sync failed after ${reason}:`,
      error
    );
    return false;
  }
}

// ============================================================
// PC DATABASE SYNC HELPER
// ============================================================
// Used by /sync_database to download a JSON file uploaded from the user's PC.
// No GitHub call is made by this command.

function downloadTextFromUrl(
  url,
  redirectsLeft = 5
) {
  return new Promise(
    (resolve, reject) => {

      https.get(
        url,
        response => {

          // Follow redirects from Discord CDN if required.
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {

            if (redirectsLeft <= 0) {
              reject(
                new Error(
                  "Too many redirects while downloading database file."
                )
              );

              return;
            }

            resolve(
              downloadTextFromUrl(
                response.headers.location,
                redirectsLeft - 1
              )
            );

            return;
          }

          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(
                `Failed to download attachment. HTTP ${response.statusCode}`
              )
            );

            return;
          }

          let data = "";

          response.setEncoding(
            "utf8"
          );

          response.on(
            "data",
            chunk => {
              data += chunk;
            }
          );

          response.on(
            "end",
            () => {
              resolve(data);
            }
          );

        }
      ).on(
        "error",
        reject
      );

    }
  );
}

function validateUploadedDatabase(data) {
  if (!Array.isArray(data)) {
    throw new Error(
      "Uploaded JSON must contain an array of clubs."
    );
  }

  const cleaned = [];

  for (
    let i = 0;
    i < data.length;
    i++
  ) {

    const item =
      data[i];

    if (
      !item ||
      typeof item !== "object"
    ) {
      throw new Error(
        `Invalid club record at position ${i + 1}.`
      );
    }

    const club =
      String(
        item.club || ""
      ).trim();

    const president =
      String(
        item.president || ""
      ).trim();

    const elo =
      Number(
        item.elo
      );

    if (!club) {
      throw new Error(
        `Missing club name at position ${i + 1}.`
      );
    }

    if (
      !Number.isFinite(elo) ||
      elo <= 0
    ) {
      throw new Error(
        `Invalid ELO for ${club}.`
      );
    }

    cleaned.push({
      club,
      president,
      elo
    });
  }

  return cleaned;
}

// ============================================================
// PUSH REMINDERS
// ============================================================
// A reminder starts from the moment /push_reminder is used.
// Reminders are stored on disk so Hostinger/bot restarts do not lose them.

let pushReminders = [];

function loadPushReminders() {
  try {
    if (!fs.existsSync(PUSH_REMINDERS_FILE)) {
      fs.writeFileSync(
        PUSH_REMINDERS_FILE,
        "[]",
        "utf8"
      );
      return [];
    }

    const data = JSON.parse(
      fs.readFileSync(
        PUSH_REMINDERS_FILE,
        "utf8"
      )
    );

    return Array.isArray(data)
      ? data
      : [];
  } catch (error) {
    console.error(
      "❌ Push reminder database load error:",
      error
    );
    return [];
  }
}

function savePushReminders() {
  try {
    fs.writeFileSync(
      PUSH_REMINDERS_FILE,
      JSON.stringify(
        pushReminders,
        null,
        2
      ),
      "utf8"
    );
    return true;
  } catch (error) {
    console.error(
      "❌ Push reminder database save error:",
      error
    );
    return false;
  }
}

function createPushReminderId() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function formatDiscordTimestamp(ms, style = "F") {
  return `<t:${Math.floor(Number(ms) / 1000)}:${style}>`;
}

async function checkPushReminders() {
  if (!client || !client.isReady()) {
    return;
  }

  const now = Date.now();
  let changed = false;

  for (const reminder of pushReminders) {
    try {
      const dueAt = Number(reminder.dueAt);
      const preDueAt = Number(
        reminder.preDueAt ||
        (dueAt - (60 * 60 * 1000))
      );

      // Backward compatibility for reminders created by older bot versions.
      if (!reminder.preDueAt) {
        reminder.preDueAt = preDueAt;
        changed = true;
      }

      if (typeof reminder.preSent !== "boolean") {
        reminder.preSent = false;
        changed = true;
      }

      const needsPreReminder =
        !reminder.preSent &&
        !reminder.sent &&
        now >= preDueAt &&
        now < dueAt;

      const needsFinalReminder =
        !reminder.sent &&
        now >= dueAt;

      if (!needsPreReminder && !needsFinalReminder) {
        continue;
      }

      const channel = await client.channels.fetch(
        reminder.channelId
      );

      if (!channel || !channel.isTextBased()) {
        throw new Error(
          "Reminder channel is unavailable or not text based."
        );
      }

      const currentIndex = findClubIndex(
        reminder.club
      );

      const currentClub =
        currentIndex !== -1
          ? leaderboardData[currentIndex]
          : null;

      const clubName = currentClub
        ? currentClub.club
        : reminder.club;

      const president = currentClub
        ? String(currentClub.president || "Not Set")
        : String(reminder.president || "Not Set");

      const eloText = currentClub
        ? ` (${currentClub.elo})`
        : "";

      if (needsPreReminder) {
        await channel.send(
          `⏰ **FoW PUSH REMINDER — 1 HOUR LEFT**\n` +
          `<@${reminder.userId}> **1 hour remaining before the ${reminder.hours}-hour push time is reached.**\n\n` +
          `Club: **${clubName}${eloText}**\n` +
          `President / Pusher: **${president}**\n` +
          `Push started: ${formatDiscordTimestamp(reminder.createdAt, "F")}\n` +
          `Target time: ${formatDiscordTimestamp(dueAt, "F")} ` +
          `(${formatDiscordTimestamp(dueAt, "R")})`
        );

        reminder.preSent = true;
        reminder.preSentAt = now;
        changed = true;

        console.log(
          `⏰ Push pre-reminder sent: ${clubName} - 1h before ${reminder.hours}h`
        );
      }

      if (needsFinalReminder) {
        await channel.send(
          `🔔 **FoW PUSH REMINDER — TIME REACHED**\n` +
          `<@${reminder.userId}> **${reminder.hours} hours have passed since the push.**\n\n` +
          `Club: **${clubName}${eloText}**\n` +
          `President / Pusher: **${president}**\n` +
          `Push started: ${formatDiscordTimestamp(reminder.createdAt, "F")}\n` +
          `Reminder: **${reminder.hours} hours after push**`
        );

        reminder.sent = true;
        reminder.sentAt = now;
        changed = true;

        console.log(
          `🔔 Final push reminder sent: ${clubName} - ${reminder.hours}h`
        );
      }
    } catch (error) {
      console.error(
        `❌ Failed to send push reminder ${reminder.id}:`,
        error
      );
    }
  }

  if (changed) {
    // Keep recent completed reminders for history, while preventing endless growth.
    const keepAfter =
      Date.now() -
      (7 * 24 * 60 * 60 * 1000);

    pushReminders = pushReminders.filter(
      reminder =>
        !reminder.sent ||
        Number(reminder.sentAt || 0) >= keepAfter
    );

    savePushReminders();
  }
}

pushReminders = loadPushReminders();



// ============================================================
// V77 WAR OPERATIONS / MATCHMAKING ISOLATION
// ============================================================
// Persistent operational state used to keep clubs out of matchmaking while
// they are in preparation, war/KO, awaiting Normal cooling input, or cooling.
// NORMAL: manual preparation remaining -> war/KO -> Normal cooling (manual remaining supported)
// LIGHTNING: manual preparation remaining -> war/KO -> no cooling
// GREASE: no preparation -> war/KO -> no cooling (2h KO rule remains available)
// War status reminders begin ONLY after preparation is complete.

const WAR_REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000; // PRODUCTION: 2 hours
const WAR_ACK_FOLLOWUP_INTERVAL_MS = 15 * 60 * 1000; // unanswered reminder follow-up
const WAR_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const WAR_ADMIN_USER_IDS = new Set(String(process.env.WAR_ADMIN_USER_IDS || "")
  .split(/[,;\s]+/).map(v=>v.trim()).filter(Boolean));
let warOperations = {};
let warAuditHistory = [];
let warOpsProcessorRunning = false;
let warOpsProcessorInterval = null;

function warOpKey(club){ return normalizeClubName(club); }
function getWarOperation(club){ return warOperations[warOpKey(club)] || null; }
function isClubMatchmakingAvailable(club){
  const op=getWarOperation(club);
  if(op && String(op.status||'AVAILABLE').toUpperCase()!=='AVAILABLE') return false;
  const key=normalizeClubName(club);
  const timerIsolation=(activeFowTimers||[]).some(timer=>timer?.sent?.end!==true && Array.isArray(timer?.clubs) && timer.clubs.some(c=>normalizeClubName(c?.club)===key));
  return !timerIsolation;
}

function isWarAdminInteraction(interaction){
  if (WAR_ADMIN_USER_IDS.size && WAR_ADMIN_USER_IDS.has(String(interaction.user?.id||""))) return true;
  try {
    return Boolean(interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
      interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild));
  } catch { return WAR_ADMIN_USER_IDS.size===0; }
}
function warEventLabel(type){ return ({normal:'Normal',lightning:'Lightning',grease:'Grease'})[String(type||'normal').toLowerCase()] || 'Normal'; }
function warStateLabel(status){ return ({PREPARATION:'⚪ PREPARATION',WAR_ACTIVE:'🔴 WAR ACTIVE',KO_ACTIVE:'🔴 KO ACTIVE',AWAITING_COOLING_TIME:'🟠 AWAITING COOLING TIME',COOLING_DOWN:'🟡 COOLING DOWN',AVAILABLE:'🟢 AVAILABLE'})[String(status||'AVAILABLE').toUpperCase()] || String(status||'AVAILABLE'); }
function createWarOpId(){ return 'wo'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function saveWarOperations(){
  queueSupabaseStateSave('war_operations_v1', warOperations);
  queueSupabaseStateSave('war_audit_v1', warAuditHistory);
}
function recordWarAudit(op, action, userId=null, details={}){
  warAuditHistory.push({at:Date.now(),opId:op?.id||null,club:op?.club||null,eventType:op?.eventType||null,action,userId:userId||null,...details});
  const cutoff=Date.now()-WAR_AUDIT_RETENTION_MS;
  warAuditHistory=warAuditHistory.filter(x=>Number(x.at||0)>=cutoff).slice(-5000);
  saveWarOperations();
}
async function restoreWarOperationsFromSupabase(){
  if(!supabasePersistenceReady) return;
  const ops=await loadSupabaseState('war_operations_v1');
  const audit=await loadSupabaseState('war_audit_v1');
  if(ops && typeof ops==='object' && !Array.isArray(ops)) warOperations=ops;
  if(Array.isArray(audit)) warAuditHistory=audit;
  console.log(`💾 War operations restored from Supabase: ${Object.keys(warOperations).length}`);
}
function setWarOperation(club, patch, userId=null, action='STATE_UPDATE'){
  const db=leaderboardData.find(x=>areEquivalentClubNames(x.club,club));
  const canonical=db?.club || String(club||'').trim();
  const key=warOpKey(canonical);
  if(!key) return null;
  const old=warOperations[key] || {id:createWarOpId(),club:canonical,president:db?.president||'',elo:Number(db?.elo)||0,createdAt:Date.now()};
  const op={...old,...patch,club:canonical,president:db?.president||old.president||'',elo:Number(db?.elo)||Number(old.elo)||0,updatedAt:Date.now()};
  warOperations[key]=op;
  recordWarAudit(op,action,userId,{fromStatus:old.status||null,toStatus:op.status||null});
  return op;
}
function findWarOperationById(id){ return Object.values(warOperations).find(x=>String(x.id)===String(id)) || null; }
function parseManualDurationHrMin(text){
  const raw=String(text||'').trim().toLowerCase();
  const m=raw.match(/^(\d{1,3})h\s*(\d{1,2})(?:min|m)$/);
  if(!m) return null;
  const hours=Number(m[1]), minutes=Number(m[2]);
  if(!Number.isInteger(hours)||!Number.isInteger(minutes)||hours<0||minutes<0||minutes>59) return null;
  const totalMinutes=hours*60+minutes;
  return totalMinutes>0 ? {hours,minutes,totalMinutes,ms:totalMinutes*60000,text:`${String(hours).padStart(2,'0')}h ${String(minutes).padStart(2,'0')}min`} : null;
}
function parseRemainingDuration(text){ const d=parseManualDurationHrMin(text); return d?d.ms:null; }
function formatRemaining(ms){ const v=Math.max(0,Number(ms)||0); const h=Math.floor(v/3600000), m=Math.floor((v%3600000)/60000); return `${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}min`; }
function parsePreparationDurationStrict(text){
  const raw=String(text||'').trim().toLowerCase();
  const m=raw.match(/^(\d{1,3})h\s*(\d{1,2})(?:min|m)$/);
  if(!m) return null;
  const hours=Number(m[1]), minutes=Number(m[2]);
  if(!Number.isInteger(hours)||!Number.isInteger(minutes)||hours<0||minutes<0||minutes>59) return null;
  const ms=(hours*60+minutes)*60*1000;
  return ms>0?ms:null;
}
function getWarReminderMentions(){
  return FOW_TIMER_REMINDER_USER_IDS.filter(Boolean).map(id=>`<@${id}>`);
}
async function notifyPreparationCompleted(op){
  if(!client?.isReady?.() || !op?.channelId) return;

  // Controlled Derby successful club:
  // one Match-ID notification is sent by the preparation timer completion handler.
  if(op?.matchId && op?.monitorAfterPrep === false) return;
  try{
    const channel=await client.channels.fetch(String(op.channelId));
    if(!channel?.isTextBased?.()) return;
    const monitor=op.monitorAfterPrep!==false;
    const mentions=monitor?getWarReminderMentions():[];
    const extra=monitor
      ? `First war status reminder: **in 2 hours**.`
      : `War Monitor: **NOT REQUIRED**\nNo 2-hour war status reminders.`;
    await channel.send({
      content:`⚔️ **WAR STARTED**
━━━━━━━━━━━━━━━━━━━━

${mentions.length?mentions.join(' ')+'\n\n':''}🏰 Club: **${op.club}**
⚡ Event: **${warEventLabel(op.eventType)}**
🔴 Status: **WAR ACTIVE**
🚫 Matchmaking: **ISOLATED**

⏰ ${extra}
📌 War Monitor remains active until **WAR ENDED** is confirmed.`,
      allowedMentions:{parse:['users']}
    });
  }catch(error){ console.error(`❌ Preparation completed notification failed for ${op.club}:`,error); }
}
async function notifyGreaseWarStarted(op){
  if(!client?.isReady?.() || !op?.channelId || String(op.eventType||'').toLowerCase()!=='grease') return;
  try{
    const channel=await client.channels.fetch(String(op.channelId));
    if(!channel?.isTextBased?.()) return;
    const mentions=getWarReminderMentions();
    await channel.send({content:`🚨 **GREASE WAR STARTED**\n\n🏙️ **${op.club}**\n🔴 Status: **WAR ACTIVE**\n🚫 Matchmaking: **ISOLATED**\n\n${mentions.join(' ')}`,allowedMentions:{parse:['users']}});
  }catch(error){console.error(`❌ Grease war start notification failed for ${op.club}:`,error);}
}
function warReminderComponents(op){
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`war_ack:${op.id}`).setLabel('⚔️ WAR STILL ON').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`war_end:${op.id}`).setLabel('✅ WAR ENDED').setStyle(ButtonStyle.Danger)
  )];
}
function buildWarReminderText(op){
  return `⏰ **WAR REMINDER**\n\n🏙️ **${op.club}**\n⚔️ Event: **${warEventLabel(op.eventType)}**\n🔴 Status: **WAR ACTIVE**\n🚫 Matchmaking: **ISOLATED**`;
}

async function sendWarReminder(op){
  if(!client?.isReady?.() || !op?.channelId || op.reminderPending) return false;
  try{
    const channel=await client.channels.fetch(String(op.channelId));
    if(!channel?.isTextBased?.()) return false;
    const reminderMentions=String(op.eventType||'').toLowerCase()==='grease'?[]:getWarReminderMentions();
    const reminderContent=reminderMentions.length?`${reminderMentions.join(' ')}\n\n${buildWarReminderText(op)}`:buildWarReminderText(op);
    const msg=await channel.send({content:reminderContent,components:warReminderComponents(op),allowedMentions:{parse:reminderMentions.length?['users']:[]}});
    op.reminderPending=true; op.lastReminderAt=Date.now(); op.lastReminderMessageId=msg.id; op.nextAckReminderAt=Date.now()+WAR_ACK_FOLLOWUP_INTERVAL_MS; op.updatedAt=Date.now();
    recordWarAudit(op,'WAR_REMINDER_SENT',null,{messageId:msg.id});
    return true;
  }catch(error){ console.error(`❌ War reminder send failed for ${op.club}:`,error); return false; }
}
async function sendWarAckFollowup(op){
  if(!client?.isReady?.() || !op?.channelId || !op?.reminderPending) return false;
  try{
    const channel=await client.channels.fetch(String(op.channelId));
    if(!channel?.isTextBased?.()) return false;
    const mentions=getWarReminderMentions();

    // Keep only one active War Monitor reminder visible.
    const oldMessageIds=[
      op.lastReminderMessageId,
      op.lastAckReminderMessageId
    ].filter(Boolean);

    for(const messageId of [...new Set(oldMessageIds)]){
      try{
        const oldMessage=await channel.messages.fetch(String(messageId));
        if(oldMessage) await oldMessage.delete();
        console.log(`🧹 Previous War Monitor reminder removed • ${op.club} • ${messageId}`);
      }catch(error){
        if(error?.code!==10008){
          console.error(`⚠️ Failed to remove previous War Monitor reminder • ${op.club} • ${messageId}:`,error);
        }
      }
    }

    op.lastReminderMessageId=null;
    op.lastAckReminderMessageId=null;

    const msg=await channel.send({
      content:`${mentions.length?mentions.join(' ')+'\n\n':''}⚠️ **WAR STATUS NOT ACKNOWLEDGED**\n\n🏙️ **${op.club}**\n⚔️ Event: **${warEventLabel(op.eventType)}**\n🔴 Status: **WAR ACTIVE**\n🚫 Matchmaking: **ISOLATED**\n\nPlease confirm the current war status.`,
      components:warReminderComponents(op),
      allowedMentions:{parse:mentions.length?['users']:[]}
    });
    op.lastAckReminderAt=Date.now(); op.lastAckReminderMessageId=msg.id; op.nextAckReminderAt=Date.now()+WAR_ACK_FOLLOWUP_INTERVAL_MS; op.updatedAt=Date.now();
    recordWarAudit(op,'WAR_ACK_FOLLOWUP_SENT',null,{messageId:msg.id});
    return true;
  }catch(error){ console.error(`❌ War acknowledgement follow-up failed for ${op.club}:`,error); return false; }
}
async function notifyWarAvailable(op, reason='War ended'){
  if(!client?.isReady?.() || !op?.channelId) return;
  try{
    const channel=await client.channels.fetch(String(op.channelId));
    if(channel?.isTextBased?.()) await channel.send(`🟢 **MATCHMAKING AVAILABLE**\n\n🏙️ **${op.club}**\n⚔️ Event: **${warEventLabel(op.eventType)}**\n✅ Status: **AVAILABLE**\n✅ Matchmaking: **AVAILABLE**\n\n${reason}`);
  }catch(error){console.error(`❌ Available notification failed for ${op.club}:`,error);}
}


function buildWarMonitorStartedContent(op){
  const type=String(op?.eventType||'normal').toLowerCase();

  let timingLine='';
  if(type==='grease'){
    timingLine=
      `Preparation: **NONE**
First war status reminder: **in 2 hours**.`;
  }else{
    const endAt=Number(op?.preparationEndAt||0);
    timingLine=endAt>0
      ? `Preparation remaining: **<t:${Math.floor(endAt/1000)}:R>**
Preparation ends: **<t:${Math.floor(endAt/1000)}:F>**
War status reminders: **start only after preparation ends**.
First reminder after war starts: **2 hours later**.`
      : `Preparation: **COMPLETED**
War status reminder cycle: **ACTIVE**.`;
  }

  return `⚔️ **WAR MONITOR STARTED**
━━━━━━━━━━━━━━━━━━━━

🏰 Club: **${op.club}**
⚡ Event: **${warEventLabel(type)}**
${type==='grease'?'🔴':'⚪'} Status: **${String(op.status||'WAR_ACTIVE').replaceAll('_',' ')}**
🚫 Matchmaking: **ISOLATED**

${timingLine}`;
}

function buildWarMonitorStartedControls(op){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`war_monitor_edit:${op.id}`)
      .setLabel('✏️ EDIT CLUB')
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`war_monitor_cancel:${op.id}`)
      .setLabel('🛑 CANCEL WAR MONITOR')
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId(`war_monitor_close:${op.id}`)
      .setLabel('✖️ CLOSE')
      .setStyle(ButtonStyle.Secondary)
  );
}

function createWarMonitorEditModal(op,messageId){
  return new ModalBuilder()
    .setCustomId(`war_monitor_edit_modal:${op.id}:${messageId}`)
    .setTitle('Edit War Monitor Club')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('club')
          .setLabel('Correct club name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(String(op.club||'').slice(0,100))
      )
    );
}

function startWarMonitoringForClub(club,eventType,interactionOrMeta={}){
  const type=['normal','lightning','grease'].includes(String(eventType).toLowerCase())?String(eventType).toLowerCase():'normal';
  const channelId=interactionOrMeta.channelId||null, guildId=interactionOrMeta.guildId||null, userId=interactionOrMeta.userId||interactionOrMeta.user?.id||null;
  return setWarOperation(club,{eventType:type,status:'WAR_ACTIVE',isolated:true,channelId,guildId,matchId:interactionOrMeta.matchId||null,monitorAfterPrep:true,nextReminderAt:Date.now()+WAR_REMINDER_INTERVAL_MS,reminderPending:false,nextAckReminderAt:null,lastAckBy:null,lastAckAt:null,coolingEndAt:null,warning15mSent:false,completionSent:false},userId,'WAR_MONITOR_STARTED');
}

async function sendFailedClubWarMonitorPublic({plan,mode,failedNames,releasedNames,userId}){
  if(!Array.isArray(failedNames)||!failedNames.length)return false;
  try{
    const channel=await client.channels.fetch(String(CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID)).catch(()=>null);
    if(!channel?.isTextBased?.()||typeof channel.send!=="function")return false;
    const grease=String(mode||'').toLowerCase()==='grease';
    const mentions=grease?getWarReminderMentions():[];
    let text=`⚠️ **FOW WAR MONITOR STARTED**\n━━━━━━━━━━━━━━━━━━━━\n\n`+
      `🆔 Match ID: **${plan?.id||'N/A'}**\n`+
      `⚔️ Event: **${warEventLabel(mode)}**\n`+
      `📌 Reason: **Derby Match Failed**\n\n`+
      `🔴 **Failed / War Monitor (${failedNames.length})**\n${failedNames.map(x=>`• ${x}`).join('\n')}\n\n`+
      `🚫 Matchmaking: **ISOLATED**\n`+
      `⏱️ War Reminder: **Every 2 Hours**`;
    if(releasedNames?.length)text+=`\n\n🟢 **Opponent Released (${releasedNames.length})**\n${releasedNames.map(x=>`• ${x}`).join('\n')}\n✅ Matchmaking: **AVAILABLE unless another independent restriction applies**`;
    if(mentions.length)text+=`\n\n${mentions.join(' ')}`;
    for(const chunk of splitDiscordText(text))await channel.send({content:chunk,allowedMentions:{parse:mentions.length?['users']:[]}});
    return true;
  }catch(error){console.error('❌ Failed club War Status notification failed:',error);return false;}
}

async function sendKoTimerStartedPublic(timer,plan,{failedNames=[],releasedNames=[],skipNames=[]}={}){
  try{
    const destinationId=getFowTimerDestinationId(timer);
    const channel=await client.channels.fetch(String(destinationId)).catch(()=>null);
    if(!channel?.isTextBased?.()||typeof channel.send!=="function")return false;
    const koOnly=isKoOnlyTimer(timer);
    const title=koOnly?'🥊 **FOW KO TIMER STARTED**':'🥊🧊 **FOW KO + COOLING DOWN STARTED**';
    const timerLine=koOnly?'⏱️ KO Timer: **2 Hours**':'⏱️ KO + Cooling Down: **14 Hours**';
    const clubList=formatFowTimerClubListPlain(timer.clubs);
    let text=`${title}\n━━━━━━━━━━━━━━━━━━━━\n\n${timerLine}\n🆔 Match ID: **${plan.id}**\n🏰 Clubs: **${timer.clubs.length}**\n\n${clubList}\n\n🕘 Ends: <t:${Math.floor(timer.endAt/1000)}:F>\n🔔 Reminder: **15 Minutes** before timer ends.\n🚫 Matchmaking: **Isolated**`;
    if(failedNames.length)text+=`\n\n⚠️ War Monitor: **${failedNames.length}** failed club(s)`;
    if(releasedNames.length)text+=`\n🟢 Released Opponents: **${releasedNames.length}**`;
    if(skipNames.length)text+=`\n⏭️ Skipped: **${skipNames.length}**`;
    for(const chunk of splitDiscordText(text))await channel.send({content:chunk});
    return true;
  }catch(error){console.error('❌ Public KO timer start notification failed:',error);return false;}
}
function markPreparationForTimer(timer){
  if (timer?.matchId) {
    markMatchPlanLifecycleActive(timer.matchId);
  }
if(timer?.type!=='push')return;const mode=String(timer.operationalMode||'normal').toLowerCase(),failedKeys=new Set(timer.failedClubKeys||[]);for(const c of timer.clubs||[]){if(mode==='grease')startWarMonitoringForClub(c.club,'grease',{channelId:getFowTimerDestinationId(timer),guildId:timer.guildId,userId:timer.userId,matchId:timer.matchId});else{const failed=failedKeys.has(normalizeClubName(c.club));setWarOperation(c.club,{eventType:mode==='lightning'?'lightning':'normal',status:'PREPARATION',isolated:true,channelId:failed?CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID:getFowTimerDestinationId(timer),guildId:timer.guildId,matchId:timer.matchId||null,monitorAfterPrep:timer.preparationControl?failed:true,preparationEndAt:Number(timer.endAt),preparation15mSent:false,nextReminderAt:null,reminderPending:false},timer.userId,'PREPARATION_STARTED');}}}
async function handleFowTimerOperationalCompletion(timer){if(timer?.type==='push'){const mode=String(timer.operationalMode||'normal').toLowerCase(),failedKeys=new Set(timer.failedClubKeys||[]);for(const c of timer.clubs||[]){if(mode==='grease')continue;if(timer.preparationControl){const failed=failedKeys.has(normalizeClubName(c.club));if(failed)startWarMonitoringForClub(c.club,mode==='lightning'?'lightning':'normal',{channelId:CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID,guildId:timer.guildId,userId:timer.userId,matchId:timer.matchId});else setWarOperation(c.club,{eventType:mode,status:'WAR_ACTIVE',isolated:true,channelId:getFowTimerDestinationId(timer),guildId:timer.guildId,matchId:timer.matchId||null,monitorAfterPrep:false,preparationEndAt:null,nextReminderAt:null,reminderPending:false},timer.userId,'PREPARATION_COMPLETED_MATCH_SUCCESS');}else startWarMonitoringForClub(c.club,mode==='lightning'?'lightning':'normal',{channelId:getFowTimerDestinationId(timer),guildId:timer.guildId,userId:timer.userId,matchId:timer.matchId});}if(timer.preparationControl&&timer.matchId){const plan=getMatchPlan(timer.matchId);if(plan){plan.preparationCompletedAt=Date.now();plan.preparationEndAt=Number(timer.endAt);plan.updatedAt=Date.now();matchPlans.set(plan.id,plan);await saveMatchPlansNow();try{
const ch=await client.channels.fetch(String(plan.channelId||timer.destinationId));
if(ch?.isTextBased?.()){
const warControlMsg=await ch.send({content:`⚔️ **PREPARATION COMPLETED**\n\n🆔 Match ID: **${plan.id}**\n\n🔴 **WAR IS NOW ACTIVE**\n🚫 Matchmaking: **ISOLATED**\n\n🔔 **Reminder:** Tap **START KO TIMER** only after all wars are closed.`,components:[buildMatchPlanKoButton(plan.id)]});

// New War/KO control was created successfully.
// Only now remove the old Match Controls message.
if(plan.matchControlsMessageId){
try{
const oldChannelId=plan.matchControlsChannelId||plan.channelId||timer.destinationId;
const oldChannel=await client.channels.fetch(String(oldChannelId));
if(oldChannel?.isTextBased?.()&&oldChannel.messages?.fetch){
const oldControls=await oldChannel.messages.fetch(String(plan.matchControlsMessageId));
if(oldControls)await oldControls.delete();
}
console.log(`🧹 Old Match Controls removed • ${plan.id} • ${plan.matchControlsMessageId}`);
plan.matchControlsMessageId=null;
plan.matchControlsChannelId=null;
plan.updatedAt=Date.now();
matchPlans.set(plan.id,plan);
await saveMatchPlansNow();
}catch(error){
if(error?.code===10008){
plan.matchControlsMessageId=null;
plan.matchControlsChannelId=null;
plan.updatedAt=Date.now();
matchPlans.set(plan.id,plan);
await saveMatchPlansNow();
}else{
console.error(`⚠️ Failed to remove old Match Controls • ${plan.id}:`,error);
}
}
}

console.log(`🎛️ Post-preparation War/KO controls created • ${plan.id} • ${warControlMsg.id}`);
}
}catch(e){console.error('❌ Post-preparation controls failed:',e);}}}return;}if(timer?.type==='war_done'||timer?.type==='war_done_manual'){for(const c of timer.clubs||[]){const op=getWarOperation(c.club);if(op&&String(op.status||'').toUpperCase()!=='AVAILABLE')setWarOperation(c.club,{status:'AVAILABLE',isolated:false,reminderPending:false,nextReminderAt:null,coolingEndAt:null,completionSent:true},timer.userId,'KO_COOLING_COMPLETED');}}}

async function processWarOperations(){
  if(!client?.isReady?.() || warOpsProcessorRunning) return;
  warOpsProcessorRunning=true;
  try{
    const now=Date.now();
    for(const op of Object.values(warOperations)){
      let st=String(op.status||'AVAILABLE').toUpperCase();
      if(st==='PREPARATION' && Number(op.preparationEndAt)>now){
        const prepRemaining=Number(op.preparationEndAt)-now;
        if(prepRemaining<=15*60*1000 && !op.preparation15mSent){
          const batchOps=op.matchId
            ? Object.values(warOperations).filter(x =>
                String(x?.status||'').toUpperCase()==='PREPARATION' &&
                String(x?.matchId||'')===String(op.matchId) &&
                String(x?.channelId||'')===String(op.channelId) &&
                Number(x?.preparationEndAt||0)===Number(op.preparationEndAt) &&
                !x?.preparation15mSent)
            : [op];
          try{
            const ch=await client.channels.fetch(String(op.channelId));
            if(ch?.isTextBased?.()){
              const mentions=getWarReminderMentions();
              const clubLines=batchOps.map(x=>`• ${x.club}`).join('\n');
              await ch.send({
                content:`⏰ **PREPARATION ENDING SOON**
━━━━━━━━━━━━━━━━━━━━

${mentions.length?mentions.join(' ')+'\n\n':''}🆔 Match ID: **${op.matchId||'N/A'}**
🏰 Clubs: **${batchOps.length}**

${clubLines}

⚪ Status: **PREPARATION**
⏳ Remaining: **15 minutes**
🕘 Ends: <t:${Math.floor(Number(op.preparationEndAt)/1000)}:F>

⚔️ War will start automatically when preparation ends.
🚫 Matchmaking: **ISOLATED**`,
                allowedMentions:{parse:['users']}
              });
            }
            for(const batchOp of batchOps){
              batchOp.preparation15mSent=true;
              batchOp.updatedAt=now;
              recordWarAudit(batchOp,'PREPARATION_15M_WARNING',null,{matchId:op.matchId||null,batchSize:batchOps.length});
            }
          }catch(e){
            console.error(`❌ Preparation 15m batch warning failed for ${op.matchId||op.club}:`,e);
          }
        }
      }
      if(st==='PREPARATION' && Number(op.preparationEndAt)>0 && Number(op.preparationEndAt)<=now){
        op.status='WAR_ACTIVE';
        op.preparationEndAt=null;
        op.reminderPending=false;
        op.nextReminderAt=op.monitorAfterPrep===false?null:now+WAR_REMINDER_INTERVAL_MS;
        op.updatedAt=now;
        recordWarAudit(op,'PREPARATION_COMPLETED');
        await notifyPreparationCompleted(op);
        st='WAR_ACTIVE';
      }
      if((st==='WAR_ACTIVE'||st==='KO_ACTIVE') && !op.reminderPending && Number(op.nextReminderAt||0)>0 && Number(op.nextReminderAt)<=now){ await sendWarReminder(op); }
      if((st==='WAR_ACTIVE'||st==='KO_ACTIVE') && op.reminderPending && Number(op.nextAckReminderAt||0)>0 && Number(op.nextAckReminderAt)<=now){ await sendWarAckFollowup(op); }
      if(st==='COOLING_DOWN' && Number(op.coolingEndAt)>0){
        const remaining=Number(op.coolingEndAt)-now;
        if(remaining<=15*60*1000 && remaining>0 && !op.warning15mSent){
          try{ const ch=await client.channels.fetch(String(op.channelId)); if(ch?.isTextBased?.()) await ch.send(`🟡 **COOLING ENDING SOON**\n\nClub: **${op.club}**\nEvent: **Normal**\nCooling ends in **15 minutes**.\nMatchmaking: **ISOLATED**`); op.warning15mSent=true; recordWarAudit(op,'COOLING_15M_WARNING'); }catch(e){console.error('❌ Cooling warning failed:',e);}
        }
        if(remaining<=0 && !op.completionSent){
          op.status='AVAILABLE'; op.isolated=false; op.completionSent=true; op.coolingEndAt=null; op.updatedAt=now; recordWarAudit(op,'COOLING_COMPLETED'); await notifyWarAvailable(op,'Cooling completed');
        }
      }
    }
    saveWarOperations();
  } finally { warOpsProcessorRunning=false; }
}
function startWarOperationsProcessor(){
  if(warOpsProcessorInterval) return;
  processWarOperations().catch(e=>console.error('❌ War operations initial processor error:',e));
  warOpsProcessorInterval=setInterval(()=>processWarOperations().catch(e=>console.error('❌ War operations processor error:',e)),30*1000);
  if(warOpsProcessorInterval?.unref) warOpsProcessorInterval.unref();
}
function createCoolingModal(op){
  return new ModalBuilder().setCustomId(`war_cooling:${op.id}`).setTitle('Normal Cooling Remaining').addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('remaining').setLabel('Cooling remaining (XXh XXmin)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setPlaceholder('07h 35min')
  ));
}
function buildWarStatusDashboard(){
  const active=Object.values(warOperations).filter(o=>o&&String(o.status||'AVAILABLE').toUpperCase()!=='AVAILABLE');
  if(!active.length) return '📋 **WAR STATUS**\n\n🟢 No clubs are currently isolated by war operations.';
  const groups={};
  for(const o of active){const st=String(o.status||'').toUpperCase();let x='';if(st==='PREPARATION'&&o.preparationEndAt)x=` • ${formatRemaining(Number(o.preparationEndAt)-Date.now())} left`;if(st==='COOLING_DOWN'&&o.coolingEndAt)x=` • ${formatRemaining(Number(o.coolingEndAt)-Date.now())} left`;(groups[st]||(groups[st]=[])).push(`${o.club} • ${warEventLabel(o.eventType)}${x}`);}
  const specs=[['WAR_ACTIVE','🔴 WAR ACTIVE'],['KO_ACTIVE','🔴 KO ACTIVE'],['PREPARATION','⚪ PREPARATION'],['COOLING_DOWN','🟡 COOLING DOWN'],['AWAITING_COOLING_TIME','🟠 AWAITING COOLING TIME']];
  const out=[];for(const [k,l] of specs)if(groups[k]?.length)out.push(`${l} **(${groups[k].length})**\n${groups[k].join('\n')}`);
  return `📋 **WAR STATUS**\n\n${out.join('\n\n')}\n\n🚫 **Matchmaking Isolated: ${active.length}**`;
}
function timerIsolationLabel(t){if(t?.type==='push')return'Preparation';if(t?.type==='war_done_manual')return t.warDoneMode==='ko'?'KO':'KO + Cooling';if(t?.type==='war_done')return Number(t.hours)===2?'KO':'KO + Cooling';return String(t?.type||'Timer').replaceAll('_',' ');}
function buildIsolationTimerDashboard(){
  const now=Date.now(),active=[],soon=[],overdue=[],keys=new Set();
  for(const t of activeFowTimers||[]){if(t?.sent?.end===true)continue;const rem=Number(t.endAt||0)-now,id=t.matchId||t.id||'Timer',clubs=(t.clubs||[]).map(c=>c.club).filter(Boolean);const line=`**${id}** • ${timerIsolationLabel(t)} • ${clubs.length} club${clubs.length===1?'':'s'} • ${rem>0?formatRemaining(rem):'OVERDUE'}`;if(rem<=0)overdue.push(line);else if(rem<=900000)soon.push(line);else active.push(line);clubs.forEach(c=>keys.add(normalizeClubName(c)));}
  for(const o of Object.values(warOperations||{})){const st=String(o?.status||'AVAILABLE').toUpperCase();if(st==='AVAILABLE')continue;const k=normalizeClubName(o.club);if(keys.has(k))continue;let rem=null;if(st==='PREPARATION'&&o.preparationEndAt)rem=Number(o.preparationEndAt)-now;if(st==='COOLING_DOWN'&&o.coolingEndAt)rem=Number(o.coolingEndAt)-now;const line=`**${o.club}** • ${warEventLabel(o.eventType)} • ${st.replaceAll('_',' ')}${rem!=null?` • ${rem>0?formatRemaining(rem):'OVERDUE'}`:''}`;if(st==='AWAITING_COOLING_TIME'||(rem!=null&&rem<=0))overdue.push(line);else if(rem!=null&&rem<=900000)soon.push(line);else active.push(line);keys.add(k);}
  const sec=[];if(active.length)sec.push(`🟢 **ACTIVE (${active.length})**\n${active.join('\n')}`);if(soon.length)sec.push(`🟡 **ENDING SOON (${soon.length})**\n${soon.join('\n')}`);if(overdue.length)sec.push(`🔴 **OVERDUE (${overdue.length})**\n${overdue.join('\n')}`);return sec.length?`⏱️ **ISOLATION TIMER DASHBOARD**\n\n${sec.join('\n\n')}\n\n🚫 **Isolated Clubs: ${keys.size}**`:'⏱️ **ISOLATION TIMER DASHBOARD**\n\n🟢 No active isolation timers.';
}


// ============================================================
// V58 OPERATIONS SUITE: MANUAL MATCHMAKING / EVENTS / BULK OPS
// ============================================================

const manualMatchSessions = new Map();
const bulkAddSessions = new Map();
const MANUAL_MATCH_SESSION_TTL_MS = 30 * 60 * 1000;
const BULK_ADD_SESSION_TTL_MS = 30 * 60 * 1000;

function createShortSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function cleanupSimpleSessions(map, ttl) {
  const now = Date.now();
  for (const [id, session] of map.entries()) {
    if (!session || now - Number(session.updatedAt || session.createdAt || 0) > ttl) map.delete(id);
  }
}

function findClubByKey(key) {
  return leaderboardData.find(item => normalizeClubName(item.club) === String(key)) || null;
}

function searchDerbyClubs(query, excludedKeys = new Set()) {
  const q = normalizeClubName(query);
  if (!q) return [];
  return getDerbyLeaderboard()
    .filter(item => isClubMatchmakingAvailable(item.club))
    .filter(item => !excludedKeys.has(normalizeClubName(item.club)))
    .map(item => ({
      item,
      key: normalizeClubName(item.club),
      exact: normalizeClubName(item.club) === q ? 1 : 0,
      starts: normalizeClubName(item.club).startsWith(q) ? 1 : 0,
      includes: normalizeClubName(item.club).includes(q) ? 1 : 0
    }))
    .filter(x => x.includes || x.exact || x.starts)
    .sort((a,b) => b.exact-a.exact || b.starts-a.starts || Number(b.item.elo)-Number(a.item.elo))
    .slice(0,25)
    .map(x => x.item);
}

function searchManualAllClubs(query, excluded=new Set()) {
  reloadLatestDatabase();
  const q=normalizeClubName(String(query||''));
  return (leaderboardData||[])
    .filter(item=>item?.club)
    .filter(item=>isClubMatchmakingAvailable(item.club))
    .filter(item=>!excluded.has(normalizeClubName(item.club)))
    .map(item=>{
      const club=normalizeClubName(item.club);
      const president=normalizeClubName(item.president||'');
      let rank=99;
      if(!q) rank=5;
      else if(club===q) rank=0;
      else if(club.startsWith(q)) rank=1;
      else if(club.includes(q)) rank=2;
      else if(president===q) rank=3;
      else if(president.includes(q)) rank=4;
      return {item,rank};
    })
    .filter(x=>x.rank<99)
    .sort((a,b)=>a.rank-b.rank || Number(b.item.elo||0)-Number(a.item.elo||0))
    .slice(0,25)
    .map(x=>x.item);
}

function manualSessionUsedKeys(session, ignorePairIndex = null) {
  const used = new Set();
  (session.pairs || []).forEach((pair, idx) => {
    if (idx === ignorePairIndex) return;
    if (pair.a?.club) used.add(normalizeClubName(pair.a.club));
    if (pair.b?.club) used.add(normalizeClubName(pair.b.club));
  });
  return used;
}

function manualCurrentPair(session) {
  if (!session.draft) session.draft = { a: null, b: null, winnerSide: null };
  return session.draft;
}

function buildManualMatchmakingView(session) {
  const draft = manualCurrentPair(session);
  const pairLines = (session.pairs || []).map((pair, i) => {
    const winner = pair.winnerSide === 'b' ? pair.b : pair.a;
    const loser = pair.winnerSide === 'b' ? pair.a : pair.b;
    const gap = Math.abs(Number(pair.a.elo)-Number(pair.b.elo));
    return `${i+1}. **${winner.club} (${winner.elo}) - ${winner.president || 'Not Set'}**\n   vs ${loser.club} (${loser.elo}) - ${loser.president || 'Not Set'}\n   **Gap: ${gap}**`;
  });

  const top =
    `⚔️ **${session.mode === 'edit' ? 'EDIT' : 'MANUAL'} MATCHMAKING**\n` +
    (session.mode === 'edit' ? `🆔 Match ID: **${session.matchId}**\n` : '') +
    `Pairs ready: **${(session.pairs || []).length}**\n\n` +
    `Club A: **${draft.a ? `${draft.a.club} (${draft.a.elo}) - ${draft.a.president || 'Not Set'}` : 'Not selected'}**\n` +
    `Club B: **${draft.b ? `${draft.b.club} (${draft.b.elo}) - ${draft.b.president || 'Not Set'}` : 'Not selected'}**\n` +
    `Winner: **${draft.winnerSide === 'a' ? 'Club A' : draft.winnerSide === 'b' ? 'Club B' : 'Not selected'}**`;

  const preview = pairLines.length ? `\n\n${pairLines.slice(-5).join('\n\n')}` : '';
  const rows=[];
  if ((session.pairs || []).length) {
    const pairSelect = new StringSelectMenuBuilder()
      .setCustomId(`man_pair:${session.id}`)
      .setPlaceholder(session.editingPairIndex != null ? `Editing Pair ${session.editingPairIndex + 1}` : 'Select a pair to edit')
      .setMinValues(1).setMaxValues(1)
      .addOptions(session.pairs.slice(0,25).map((pair,i)=>({
        label:`Pair ${i+1}: ${pair.a.club} vs ${pair.b.club}`.slice(0,100),
        description:`Gap ${Math.abs(Number(pair.a.elo)-Number(pair.b.elo))}`.slice(0,100),
        value:String(i),
        default:session.editingPairIndex===i
      })));
    rows.push(new ActionRowBuilder().addComponents(pairSelect));
  }
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`man_paste:${session.id}`).setLabel('📋 Paste Match List').setStyle(ButtonStyle.Success).setDisabled(session.mode==='edit'),
    new ButtonBuilder().setCustomId(`man_search:${session.id}:a`).setLabel('🔎 Search Club A').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`man_search:${session.id}:b`).setLabel('🔎 Search Club B').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`range_open:${session.id}`).setLabel('🎯 Range Search').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`man_win:${session.id}:a`).setLabel('🏆 Club A Winner').setStyle(draft.winnerSide==='a'?ButtonStyle.Success:ButtonStyle.Secondary).setDisabled(!draft.a),
    new ButtonBuilder().setCustomId(`man_win:${session.id}:b`).setLabel('🏆 Club B Winner').setStyle(draft.winnerSide==='b'?ButtonStyle.Success:ButtonStyle.Secondary).setDisabled(!draft.b),
    new ButtonBuilder().setCustomId(`man_add:${session.id}`).setLabel(session.editingPairIndex != null ? '💾 Save Pair' : '➕ Add Pair').setStyle(ButtonStyle.Success).setDisabled(!(draft.a && draft.b && draft.winnerSide))
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`man_remove:${session.id}`).setLabel(session.editingPairIndex != null ? '🗑 Remove Selected Pair' : '↩ Remove Last Pair').setStyle(ButtonStyle.Secondary).setDisabled(!(session.pairs || []).length),
    new ButtonBuilder().setCustomId(`man_generate:${session.id}`).setLabel(session.mode==='edit'?'💾 Save Changes':'✅ Generate Matchmaking').setStyle(ButtonStyle.Success).setDisabled(!(session.pairs || []).length),
    new ButtonBuilder().setCustomId(`man_cancel:${session.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
  rows.push(row1,row2,row3);
  return { content: (top + (session.editingPairIndex != null ? `\nEditing Pair: **${session.editingPairIndex+1}**` : '') + preview).slice(0,1900), components:rows };
}

function buildManualSearchResults(session, side, results) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`man_select:${session.id}:${side}`)
    .setPlaceholder(`Choose Club ${side.toUpperCase()}`)
    .setMinValues(1).setMaxValues(1)
    .addOptions(results.map(item => ({
      label:String(item.club).slice(0,100),
      description:`${item.elo} ELO • ${item.president || 'Not Set'}`.slice(0,100),
      value:normalizeClubName(item.club)
    })));
  const row = new ActionRowBuilder().addComponents(select);
  const back = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`man_back:${session.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary)
  );
  return { content:`🔎 **SEARCH RESULTS — CLUB ${side.toUpperCase()}**\nChoose one club from **${results.length}** result(s).`, components:[row,back] };
}

function createManualRangeModal(sessionId){return new ModalBuilder().setCustomId(`range_modal:${sessionId}`).setTitle('Custom Range Match Search').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('source_min').setLabel('Source minimum ELO').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5)),
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('source_max').setLabel('Source maximum ELO').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5)),
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('opp_min').setLabel('Opponent minimum ELO').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5)),
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('opp_max').setLabel('Opponent maximum ELO').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5)));}
function derbyRangeCandidates(min,max,excluded=new Set()){reloadLatestDatabase();return (leaderboardData||[]).filter(c=>c?.club&&isDerbyClub(c)&&Number(c.elo)>=Number(min)&&Number(c.elo)<=Number(max)&&isClubMatchmakingAvailable(c.club)&&!excluded.has(normalizeClubName(c.club))).sort((a,b)=>Number(b.elo)-Number(a.elo));}
function buildRangeSourceResults(session,c){const opts=c.slice(0,25).map(x=>({label:`${x.club} (${x.elo})`.slice(0,100),description:String(x.president||'Not Set').slice(0,100),value:normalizeClubName(x.club)}));return{content:`🎯 **CUSTOM RANGE SEARCH**\n\nSource: **${session.range.sourceMin}-${session.range.sourceMax}**\nOpponent: **${session.range.oppMin}-${session.range.oppMax}**\n\nChoose source club from **${c.length}** available result(s).`,components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`range_source:${session.id}`).setPlaceholder('Choose source club').setMinValues(1).setMaxValues(1).addOptions(opts)),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`man_back:${session.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary))]};}
function buildRangeOpponentResults(session,source,c){const v=c.map(x=>({...x,gap:Math.abs(Number(x.elo)-Number(source.elo))})).filter(x=>x.gap<=MATCHMAKING_MAX_GAP).slice(0,25);if(!v.length)return null;const opts=v.map(x=>({label:`${x.club} (${x.elo})`.slice(0,100),description:`Gap ${x.gap} • ${Number(x.elo)>=Number(source.elo)?'HIGHER':'LOWER'} • ${x.president||'Not Set'}`.slice(0,100),value:normalizeClubName(x.club)}));return{content:`🎯 **OPPONENT SEARCH**\n\nSource: **${source.club} (${source.elo})**\nOpponent Range: **${session.range.oppMin}-${session.range.oppMax}**\nMaximum Gap: **${MATCHMAKING_MAX_GAP}**`,components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`range_opponent:${session.id}`).setPlaceholder('Choose opponent').setMinValues(1).setMaxValues(1).addOptions(opts)),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`man_back:${session.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary))]};}

function createManualSearchModal(sessionId, side) {
  return new ModalBuilder()
    .setCustomId(`man_modal:${sessionId}:${side}`)
    .setTitle(`Search Club ${side.toUpperCase()}`)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('query')
        .setLabel('Type all or part of club name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
    ));
}

function planFromManualSession(session, interaction) {
  const id = session.mode === 'edit' ? session.matchId : nextMatchId();
  const clubs=[];
  session.pairs.forEach((pair, i) => {
    const winnerSide = pair.winnerSide || 'a';
    for (const [side,item] of [['a',pair.a],['b',pair.b]]) {
      clubs.push({
        club:item.club, president:item.president||'', elo:Number(item.elo)||0,
        status:'pending', failedAt:null, failedBy:null,
        matchRole: side === winnerSide ? 'win' : 'lose', pairNo:i+1
      });
    }
  });
  const elos=clubs.map(x=>Number(x.elo)||0);
  return {
    id, guildId:interaction.guildId, channelId:interaction.channelId,
    min:elos.length?Math.min(...elos):0, max:elos.length?Math.max(...elos):0,
    clubs, pairCount:session.pairs.length,
    createdAt: session.originalCreatedAt || Date.now(),
    createdBy: session.originalCreatedBy || interaction.user.id,
    updatedAt:Date.now(), updatedBy:interaction.user.id,
    eventId: session.eventId || getActiveEvent()?.id || null,
    manual:true
  };
}

function getEventTypeForPlan(plan){const x=getEventById(plan?.eventId);return String(x?.type||'normal').toLowerCase();}
function buildMatchPlanKoButton(id){
  const plan=getMatchPlan(id),mode=getEventTypeForPlan(plan),prepHours=eventPreparationHours(mode);
  if(prepHours>0 && !plan?.preparationCompletedAt){
    const started=Number(plan?.preparationStartedAt||0)>0;
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`match_prep_start:${id}`).setLabel(started?`⏳ ${prepHours}H PREPARATION ACTIVE`:`▶️ START ${prepHours}H PREPARATION`).setStyle(ButtonStyle.Primary).setDisabled(started),
      new ButtonBuilder().setCustomId(`match_cancel_request:${id}`).setLabel('🛑 CANCEL MATCH ID').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`match_controls_cancel:${id}`).setLabel('✖️ CLOSE').setStyle(ButtonStyle.Secondary));
  }
  const koOnly=['grease','lightning'].includes(mode);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`match_ko_start:${id}`).setLabel(koOnly?'🥊 START KO TIMER':'🥊🧊 START KO + COOLING').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`match_cancel_request:${id}`).setLabel('🛑 CANCEL MATCH ID').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`match_controls_cancel:${id}`).setLabel('✖️ CLOSE').setStyle(ButtonStyle.Secondary));
}
function hasActiveTimerForMatch(id){id=normalizeMatchId(id);return(activeFowTimers||[]).some(t=>normalizeMatchId(t.matchId||'')===id&&t?.sent?.end!==true);}
function startKoTimerForMatchPlan(plan,interaction,clubOverride=null){const mode=getEventTypeForPlan(plan),hours=['grease','lightning'].includes(mode)?2:14,seen=new Set(),clubs=[];const source=Array.isArray(clubOverride)?clubOverride:getMatchPlanActiveClubs(plan);for(const c of source||[]){const k=normalizeClubName(c.club);if(!k||seen.has(k))continue;seen.add(k);clubs.push({club:c.club,president:c.president||'',elo:Number(c.elo)||0});}if(!clubs.length)return null;for(const c of clubs)setWarOperation(c.club,{eventType:mode,status:'KO_ACTIVE',isolated:true,matchId:plan.id,channelId:interaction.channelId,guildId:interaction.guildId,monitorAfterPrep:false,reminderPending:false,nextReminderAt:null},interaction.user.id,'KO_TIMER_STARTED');return createActiveFowTimer({id:createFowTimerId(),userId:interaction.user.id,guildId:interaction.guildId,channelId:interaction.channelId,type:'war_done',hours,warDoneMode:null,pushMode:null,operationalMode:mode,durationMinutes:null,minElo:plan.min||0,maxElo:plan.max||0,matchId:plan.id,clubs,selected:new Set(clubs.map(c=>normalizeClubName(c.club))),page:0,createdAt:Date.now(),updatedAt:Date.now()});}

// v81.4.2 — KO confirmation exclusions + master isolation override.
const koTimerSetupSessions=new Map();
const preparationSetupSessions=new Map();
const isolationOverrideSessions=new Map();
const OPS_UI_SESSION_TTL_MS=30*60*1000;
function opsSessionId(prefix='op'){return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;}
function cleanupOpsSessions(map){const cutoff=Date.now()-OPS_UI_SESSION_TTL_MS;for(const [id,x] of map.entries())if(Number(x?.updatedAt||x?.createdAt||0)<cutoff)map.delete(id);}
function pairPartnerFor(plan,clubKey){const item=(plan?.clubs||[]).find(c=>normalizeClubName(c.club)===clubKey);if(!item)return null;const pairNo=Number(item.pairNo);if(pairNo>0)return(plan.clubs||[]).find(c=>Number(c.pairNo)===pairNo&&normalizeClubName(c.club)!==clubKey)||null;return null;}
function deriveKoSetup(plan,session){const failed=new Set(session.failed||[]),skipped=new Set(session.skipped||[]),released=new Set();for(const key of failed){const partner=pairPartnerFor(plan,key);if(partner)released.add(normalizeClubName(partner.club));}const excluded=new Set([...failed,...skipped,...released]);const clubs=[];const seen=new Set();for(const c of plan?.clubs||[]){const k=normalizeClubName(c.club);if(!k||seen.has(k)||excluded.has(k))continue;const st=String(c.status||'pending').toLowerCase();if(st==='failed'||st==='excluded')continue;seen.add(k);clubs.push(c);}return{failed,skipped,released,excluded,clubs};}
function koSetupPageItems(plan,page){const all=(plan?.clubs||[]).filter(Boolean);const pages=Math.max(1,Math.ceil(all.length/25));const p=Math.max(0,Math.min(Number(page)||0,pages-1));return{items:all.slice(p*25,p*25+25),page:p,pages};}
function openPreparationSetup(plan,interaction){cleanupOpsSessions(preparationSetupSessions);const s={id:opsSessionId('prep'),matchId:plan.id,userId:interaction.user.id,guildId:interaction.guildId,channelId:interaction.channelId,failed:new Set(),skipped:new Set(),mode:null,page:0,createdAt:Date.now(),updatedAt:Date.now()};preparationSetupSessions.set(s.id,s);return s;}
function buildPreparationSetupView(session){const plan=getMatchPlan(session.matchId);if(!plan)return{content:'❌ Match ID no longer exists.',components:[]};const d=deriveKoSetup(plan,session),mode=getEventTypeForPlan(plan),hours=eventPreparationHours(mode);const base=`⏳ **${warEventLabel(mode).toUpperCase()} PREPARATION CONFIRMATION**\n\n🆔 Match ID: **${plan.id}**\n⏱️ Preparation: **${hours} Hours**\n✅ Preparation / Isolated: **${d.clubs.length+d.failed.size} clubs**\n⚠️ Failed → War Monitor after prep: **${d.failed.size}**\n🟢 Released Opponents: **${d.released.size}**\n⏭️ Skipped / Available: **${d.skipped.size}**`;if(session.mode==='failed'||session.mode==='skip'){const pg=koSetupPageItems(plan,session.page),set=session.mode==='failed'?session.failed:session.skipped,options=pg.items.map(c=>({label:String(c.club).slice(0,100),description:`${Number(c.elo)||0} — ${String(c.president||'Not Set').slice(0,70)}`,value:normalizeClubName(c.club),default:set.has(normalizeClubName(c.club))})),menu=new StringSelectMenuBuilder().setCustomId(`prep_setup_select:${session.id}`).setPlaceholder(session.mode==='failed'?'Select FAILED club(s)':'Select SKIP club(s)').setMinValues(0).setMaxValues(Math.max(1,options.length)).addOptions(options),nav=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`prep_setup_prev:${session.id}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(pg.page<=0),new ButtonBuilder().setCustomId(`prep_setup_next:${session.id}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(pg.page>=pg.pages-1),new ButtonBuilder().setCustomId(`prep_setup_done:${session.id}`).setLabel('✅ DONE').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`prep_setup_clear:${session.id}`).setLabel('Clear').setStyle(ButtonStyle.Secondary));return{content:`${base}\n\n${session.mode==='failed'?'⚠️ Failed stays isolated during preparation. 2-hour War Monitor starts only after preparation ends; its opponent is released.':'⏭️ Skip = no monitor, no isolation, immediately available.'}`,components:[new ActionRowBuilder().addComponents(menu),nav]};}return{content:`${base}\n\nFailed clubs remain on the same preparation countdown.`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`prep_setup_confirm:${session.id}`).setLabel(`✅ START ${hours}H PREPARATION`).setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`prep_setup_failed:${session.id}`).setLabel('⚠️ FAILED CLUB').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`prep_setup_skip:${session.id}`).setLabel('⏭️ SKIP CLUB').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`prep_setup_cancel:${session.id}`).setLabel('❌ CANCEL').setStyle(ButtonStyle.Secondary))]};}
function createPreparationTimerForPlan(plan,interaction,d){const mode=getEventTypeForPlan(plan),hours=eventPreparationHours(mode);if(!hours)return null;const keys=new Set([...d.failed]);for(const c of d.clubs||[])keys.add(normalizeClubName(c.club));const records=(plan.clubs||[]).filter(c=>keys.has(normalizeClubName(c.club))).map(c=>({club:c.club,president:c.president||'',elo:Number(c.elo)||0}));if(!records.length)return null;return createActiveFowTimer({type:'push',hours,pushMode:'event_preparation',operationalMode:mode,durationMinutes:null,matchId:plan.id,userId:interaction.user.id,guildId:interaction.guildId,channelId:interaction.channelId,clubs:records,selected:new Set(records.map(c=>normalizeClubName(c.club))),failedClubKeys:[...d.failed],preparationControl:true});}
function buildKoSetupView(session){const plan=getMatchPlan(session.matchId);if(!plan)return{content:'❌ Match ID no longer exists.',components:[]};const d=deriveKoSetup(plan,session);const mode=getEventTypeForPlan(plan),koOnly=['grease','lightning'].includes(mode),hours=koOnly?2:14;const base=`${koOnly?'🥊':'🥊🧊'} **${koOnly?'KO TIMER CONFIRMATION':'KO + COOLING CONFIRMATION'}**\n\n🆔 Match ID: **${plan.id}**\n⏱️ ${koOnly?'KO Timer':'KO + Cooling'}: **${hours} Hours**\n✅ KO Isolation: **${d.clubs.length} clubs**\n⚠️ War Monitor: **${d.failed.size} failed**\n🟢 Released Opponents: **${d.released.size}**\n⏭️ Skipped: **${d.skipped.size}**`;
 if(session.mode==='failed'||session.mode==='skip'){const pg=koSetupPageItems(plan,session.page);const set=session.mode==='failed'?session.failed:session.skipped;const options=pg.items.map(c=>({label:String(c.club).slice(0,100),description:`${Number(c.elo)||0} — ${String(c.president||'Not Set').slice(0,70)}`,value:normalizeClubName(c.club),default:set.has(normalizeClubName(c.club))}));const menu=new StringSelectMenuBuilder().setCustomId(`ko_setup_select:${session.id}`).setPlaceholder(session.mode==='failed'?'Select FAILED club(s)':'Select SKIP club(s)').setMinValues(0).setMaxValues(Math.max(1,options.length)).addOptions(options);const nav=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ko_setup_prev:${session.id}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(pg.page<=0),new ButtonBuilder().setCustomId(`ko_setup_next:${session.id}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(pg.page>=pg.pages-1),new ButtonBuilder().setCustomId(`ko_setup_done:${session.id}`).setLabel('✅ DONE').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`ko_setup_clear:${session.id}`).setLabel('Clear').setStyle(ButtonStyle.Secondary));return{content:`${base}\n\n${session.mode==='failed'?'⚠️ **MARK FAILED CLUB**\nFailed club → WAR MONITOR. Its opponent → RELEASED.':'⏭️ **MARK SKIP CLUB**\nSkipped club will NOT enter the KO isolation timer.'}\n📄 Page: **${pg.page+1}/${pg.pages}**`,components:[new ActionRowBuilder().addComponents(menu),nav]};}
 const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ko_setup_confirm:${session.id}`).setLabel('✅ START TIMER').setStyle(ButtonStyle.Success).setDisabled(d.clubs.length===0),new ButtonBuilder().setCustomId(`ko_setup_failed:${session.id}`).setLabel('⚠️ FAILED CLUB').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId(`ko_setup_skip:${session.id}`).setLabel('⏭️ SKIP CLUB').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId(`ko_setup_cancel:${session.id}`).setLabel('❌ CANCEL').setStyle(ButtonStyle.Secondary));return{content:`${base}\n\nFailed clubs are moved to **WAR MONITOR**. Opponents of failed clubs and skipped clubs remain free from this timer.`,components:[row]};}
function openKoSetup(plan,interaction){cleanupOpsSessions(koTimerSetupSessions);const session={id:opsSessionId('ko'),userId:String(interaction.user.id),guildId:interaction.guildId,channelId:interaction.channelId,matchId:plan.id,failed:new Set(),skipped:new Set(),mode:null,page:0,createdAt:Date.now(),updatedAt:Date.now()};koTimerSetupSessions.set(session.id,session);return session;}
function currentIsolatedClubRecords(){return (leaderboardData||[]).filter(c=>!isClubMatchmakingAvailable(c.club)).sort((a,b)=>Number(b.elo)-Number(a.elo));}
function buildIsolationOverrideView(session){const all=currentIsolatedClubRecords();const pages=Math.max(1,Math.ceil(all.length/25));session.page=Math.max(0,Math.min(Number(session.page)||0,pages-1));const items=all.slice(session.page*25,session.page*25+25);if(!items.length)return{content:'🟢 **MASTER ISOLATION OVERRIDE**\n\nNo clubs are currently isolated.',components:[]};const options=items.map(c=>({label:String(c.club).slice(0,100),description:`${Number(c.elo)||0} — ${String(c.president||'Not Set').slice(0,70)}`,value:normalizeClubName(c.club),default:session.selected.has(normalizeClubName(c.club))}));const menu=new StringSelectMenuBuilder().setCustomId(`iso_override_select:${session.id}`).setPlaceholder('Select club(s) to RELEASE').setMinValues(0).setMaxValues(Math.max(1,options.length)).addOptions(options);const nav=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`iso_override_prev:${session.id}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(session.page<=0),new ButtonBuilder().setCustomId(`iso_override_next:${session.id}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(session.page>=pages-1),new ButtonBuilder().setCustomId(`iso_override_clear:${session.id}`).setLabel('Clear').setStyle(ButtonStyle.Secondary));const act=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`iso_override_confirm:${session.id}`).setLabel('🟢 RELEASE SELECTED').setStyle(ButtonStyle.Danger).setDisabled(session.selected.size===0),new ButtonBuilder().setCustomId(`iso_override_cancel:${session.id}`).setLabel('❌ CANCEL').setStyle(ButtonStyle.Secondary));return{content:`🛡️ **MASTER ISOLATION OVERRIDE**\n\n⚠️ Emergency correction only. Selected clubs will be removed from **ALL active timer isolation and war isolation**.\n☑️ Selected: **${session.selected.size}**\n📄 Page: **${session.page+1}/${pages}**`,components:[new ActionRowBuilder().addComponents(menu),nav,act]};}
async function masterReleaseIsolation(keys,interaction){const selected=new Set(keys),released=[];for(const db of leaderboardData||[]){const key=normalizeClubName(db.club);if(!selected.has(key))continue;let changed=false;for(const timer of activeFowTimers||[]){if(timer?.sent?.end===true||!Array.isArray(timer.clubs))continue;const before=timer.clubs.length;timer.clubs=timer.clubs.filter(c=>normalizeClubName(c?.club)!==key);if(timer.clubs.length!==before)changed=true;}const op=getWarOperation(db.club);if(op&&String(op.status||'AVAILABLE').toUpperCase()!=='AVAILABLE'){setWarOperation(db.club,{status:'AVAILABLE',isolated:false,reminderPending:false,nextReminderAt:null,coolingEndAt:null,completionSent:true},interaction.user.id,'MASTER_ISOLATION_OVERRIDE_RELEASE');changed=true;}if(changed)released.push(db.club);}activeFowTimers=(activeFowTimers||[]).filter(t=>t?.sent?.end===true||!Array.isArray(t.clubs)||t.clubs.length>0);saveFowTimers();await flushSupabaseStateSave('active_fow_timers');return released;}

function formatManualPlanOutput(plan) {
  let out=`⚔️ **FoW ELO MATCHMAKING**\nMatch ID: **${plan.id}**\nELO Range: **${plan.min} - ${plan.max}**\nMaximum Gap: **${MATCHMAKING_MAX_GAP}**\n\n`;
  const pairs=new Map();
  for(const c of plan.clubs){ if(!pairs.has(c.pairNo)) pairs.set(c.pairNo,[]); pairs.get(c.pairNo).push(c); }
  [...pairs.entries()].sort((a,b)=>a[0]-b[0]).forEach(([no,arr])=>{
    if(arr.length!==2)return;
    const winner=arr.find(x=>x.matchRole==='win')||arr[0];
    const loser=arr.find(x=>x!==winner)||arr[1];
    const gap=Math.abs(Number(winner.elo)-Number(loser.elo));
    out += `${no}. **${winner.club} (${winner.elo}) - ${winner.president || 'Not Set'}**  \n` +
           `   vs ${loser.club} (${loser.elo}) - ${loser.president || 'Not Set'}  \n` +
           `   **Gap: ${gap}**\n\n`;
  });
  return out;
}


function createManualPasteModal(sessionId){
  return new ModalBuilder().setCustomId(`man_paste_modal:${sessionId}`).setTitle('Paste Manual Match List').addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('matches').setLabel('Paste pair list').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setPlaceholder('Club A (5600) - Prez A\nvs\nClub B (5520) - Prez B\nWinner: Club A')
  ));
}
function cleanManualPasteLine(line){
  return String(line||'')
    .replace(/\*\*/g,'')
    .replace(/__/g,'')
    .replace(/`/g,'')
    .replace(/^\s*[-•]\s*/,'')
    .replace(/^\s*\d+\.\s*/,'')
    .trim();
}
function parseManualClubLine(line){
  const cleaned=cleanManualPasteLine(line).replace(/^vs\s+/i,'').trim();
  const m=cleaned.match(/^(.+?)\s*\(\s*(\d{3,5})\s*\)\s*(?:-|–|—)\s*(.+)$/);
  if(!m) return null;
  return {club:m[1].trim(), pastedElo:Number(m[2]), pastedPresident:m[3].trim()};
}
function resolveManualClub(parsed){
  if(!parsed) return null;
  const db=leaderboardData.find(x=>areEquivalentClubNames(x.club,parsed.club));
  if(!db) return {error:`Club not found: ${parsed.club}`};
  if(!isDerbyClub(db)) return {error:`Not in Derby list: ${db.club}`};
  if(!isClubMatchmakingAvailable(db.club)) return {error:`${db.club} is currently ${String(getWarOperation(db.club)?.status||'ISOLATED').replaceAll('_',' ')} and cannot be matched.`};
  return {club:db.club,president:db.president||'',elo:Number(db.elo)||0,pastedElo:parsed.pastedElo,pastedPresident:parsed.pastedPresident};
}
function parseManualMatchPaste(text){
  const rawLines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const lines=rawLines.map(cleanManualPasteLine).filter(Boolean).filter(x=>!/^\d+\.?$/.test(x));
  const pairs=[],warnings=[],errors=[]; const used=new Set();

  const addPair=(left,right,markerIndex)=>{
    if(!left||!right){ errors.push(`Could not parse pairing around line ${markerIndex+1}.`); return; }
    const a=resolveManualClub(left), b=resolveManualClub(right);
    if(a?.error){errors.push(a.error);return;} if(b?.error){errors.push(b.error);return;}
    const ak=normalizeClubName(a.club),bk=normalizeClubName(b.club);
    if(ak===bk){errors.push(`${a.club} cannot be paired with itself.`);return;}
    if(used.has(ak)||used.has(bk)){errors.push(`Duplicate club in pasted plan: ${used.has(ak)?a.club:b.club}`);return;}
    const gap=Math.abs(Number(a.elo)-Number(b.elo));
    if(gap>MATCHMAKING_MAX_GAP){errors.push(`${a.club} vs ${b.club}: gap ${gap} exceeds ${MATCHMAKING_MAX_GAP}.`);return;}
    if(Number(a.pastedElo)!==Number(a.elo)) warnings.push(`${a.club}: pasted ELO ${a.pastedElo} → database ${a.elo}`);
    if(Number(b.pastedElo)!==Number(b.elo)) warnings.push(`${b.club}: pasted ELO ${b.pastedElo} → database ${b.elo}`);

    let winnerSide=null, notes=[];
    for(let j=markerIndex+1;j<Math.min(lines.length,markerIndex+7);j++){
      const current=lines[j];
      if(j>markerIndex+1 && (/^vs\b/i.test(current)||parseManualClubLine(current))) break;
      const wm=current.match(/^winner\s*:\s*(.+)$/i);
      if(wm){
        const w=wm[1].trim();
        if(areEquivalentClubNames(w,a.club)) winnerSide='a';
        else if(areEquivalentClubNames(w,b.club)) winnerSide='b';
        else warnings.push(`Winner not recognized for ${a.club} vs ${b.club}: ${w}`);
      } else if(/cross\s*match|different[-\s]*tier/i.test(current)) notes.push(current);
    }
    if(!winnerSide) winnerSide=Number(a.elo)>=Number(b.elo)?'a':'b';
    pairs.push({a:{club:a.club,president:a.president,elo:a.elo},b:{club:b.club,president:b.president,elo:b.elo},winnerSide,notes});
    used.add(ak);used.add(bk);
  };

  for(let i=0;i<lines.length;i++){
    const line=lines[i];

    // Format A: separate `vs` line.
    if(/^vs$/i.test(line)){
      let li=i-1, ri=i+1;
      while(li>=0 && !parseManualClubLine(lines[li])) li--;
      while(ri<lines.length && !parseManualClubLine(lines[ri])) ri++;
      addPair(parseManualClubLine(lines[li]),parseManualClubLine(lines[ri]),i);
      i=ri;
      continue;
    }

    // Format B: `vs Club B (ELO) - President` on one line.
    if(/^vs\s+/i.test(line)){
      let li=i-1;
      while(li>=0 && !parseManualClubLine(lines[li])) li--;
      addPair(parseManualClubLine(lines[li]),parseManualClubLine(line),i);
      continue;
    }

    // Format C: entire pair on one line: `Club A (...) - Prez vs Club B (...) - Prez`.
    const inline=line.match(/^(.*?)\s+vs\s+(.*)$/i);
    if(inline){
      addPair(parseManualClubLine(inline[1]),parseManualClubLine(inline[2]),i);
      continue;
    }
  }

  if(!pairs.length&&!errors.length) errors.push('No valid pairs detected. Paste either `Club A (ELO) - President` + `vs` + `Club B (ELO) - President`, or use `vs Club B ...` on the next line. Markdown/bold numbering is supported.');
  return {pairs,warnings,errors};
}

function createBulkAddModal() {
  return new ModalBuilder()
    .setCustomId(`bulk_modal:${createShortSessionId()}`)
    .setTitle('Bulk Add Clubs')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('clubs')
        .setLabel('Club Name, President, ELO — one per line')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder('FoW Club A, President A, 5600\nFoW Club B, President B, 5500')
    ));
}

function parseBulkClubText(text) {
  const valid=[], duplicates=[], invalid=[];
  const seen=new Set();
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=raw.trim(); if(!line)continue;
    const parts=line.split(',').map(v=>v.trim());
    if(parts.length!==3){ invalid.push({line,reason:'Use: Club Name, President, ELO'}); continue; }
    const [club,president,eloRaw]=parts; const elo=Number(eloRaw);
    if(!club||!president||!Number.isInteger(elo)||elo<=0){ invalid.push({line,reason:'Missing/invalid value'}); continue; }
    const key=normalizeClubName(club);
    if(seen.has(key)||findClubIndex(club)!==-1){ duplicates.push({club,president,elo}); continue; }
    seen.add(key); valid.push({club,president,elo});
  }
  return {valid,duplicates,invalid};
}

function buildBulkPreview(session) {
  const lines=session.valid.slice(0,20).map(x=>`- ${x.club} (${x.elo}) - ${x.president}`).join('\n');
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bulk_confirm:${session.id}`).setLabel('CONFIRM ADD').setStyle(ButtonStyle.Success).setDisabled(!session.valid.length),
    new ButtonBuilder().setCustomId(`bulk_cancel:${session.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
  return { content:
    `📥 **BULK ADD PREVIEW**\n\n✅ Valid: **${session.valid.length}**\n⚠️ Duplicate: **${session.duplicates.length}**\n❌ Invalid: **${session.invalid.length}**\n\n`+
    (lines||'No valid clubs ready to add.') + (session.valid.length>20?`\n...and ${session.valid.length-20} more.`:''), components:[row] };
}

// ---------------- EVENT TRACKING ----------------
let eventStore = { active: null, summaries: [] };
const EVENT_DETAIL_RETENTION_DAYS = 7;

function eventDurationDays(type){ return type==='grease' ? 5 : type==='lightning' ? 7 : 0; }
function getActiveEvent(){ return eventStore && eventStore.active && eventStore.active.status==='active' ? eventStore.active : null; }
function getCurrentEventContext(){ return eventStore && eventStore.active ? eventStore.active : null; }
function getEventById(id){ if(!id)return null; if(eventStore?.active?.id===id)return eventStore.active; return (eventStore?.summaries||[]).find(x=>x?.id===id)||null; }
function eventPreparationHours(type){ type=String(type||'normal').toLowerCase(); return type==='normal'?12:type==='lightning'?6:0; }
async function restoreEventStoreFromSupabase(){
  if(!supabasePersistenceReady)return;
  const remote=await loadSupabaseState('event_store');
  if(remote && typeof remote==='object') eventStore={active:remote.active||null,summaries:Array.isArray(remote.summaries)?remote.summaries:[]};
  else await saveEventStoreNow();
  autoExpireActiveEvent();
}
async function saveEventStoreNow(){ queueSupabaseStateSave('event_store',eventStore); await flushSupabaseStateSave('event_store'); }
function autoExpireActiveEvent(){
  const e=getActiveEvent(); if(e && Number(e.endAt)>0 && Number(e.endAt)<=Date.now()){ e.status='completed'; e.completedAt=Number(e.endAt)||Date.now(); eventStore.summaries.push(buildEventSummary(e)); eventStore.active=null; queueSupabaseStateSave('event_store',eventStore); }
}
function plansForEvent(eventId){ return [...matchPlans.values()].filter(p=>p && p.eventId===eventId); }
function getEventStats(event){
  const plans=plansForEvent(event.id); let success=0,failed=0,pending=0,excluded=0; const successfulPairs=new Set();
  for(const plan of plans){
    const byPair=new Map();
    for(const c of plan.clubs||[]){
      const st=String(c.status||'pending').toLowerCase();
      if(st==='success') success++; else if(st==='failed') failed++; else if(st==='excluded') excluded++; else pending++;
      if(!byPair.has(c.pairNo))byPair.set(c.pairNo,[]); byPair.get(c.pairNo).push(st);
    }
    for(const [pairNo,sts] of byPair){ if(sts.length===2 && sts.every(x=>x==='success')) successfulPairs.add(`${plan.id}:${pairNo}`); }
  }
  const resolved=success+failed; return {matchIds:plans.length,entered:success+failed+pending+excluded,success,failed,pending,excluded,successfulMatches:successfulPairs.size,successRate:resolved?success/resolved*100:0};
}
function buildEventSummary(event){ const st=getEventStats(event); return {...event,...st,status:'completed',summaryAt:Date.now()}; }
function formatEventStats(event){ const st=getEventStats(event); return `⚡ **${event.name.toUpperCase()} — EVENT STATS**\n\nMatch IDs: **${st.matchIds}**\nClubs Entered: **${st.entered}**\n\n✅ Successful Clubs: **${st.success}**\n❌ Failed Clubs: **${st.failed}**\n⏳ Pending Clubs: **${st.pending}**\n➖ Excluded Clubs: **${st.excluded}**\n\n⚔️ Successful FoW Matches: **${st.successfulMatches}**\n📊 Success Rate: **${st.successRate.toFixed(1)}%**`; }
// ---------------- MATCH SUCCESS ----------------
// Success is NEVER inferred from /war_done. It is explicitly confirmed by
// /match_success so event statistics remain accurate during fast Grease runs.
const matchSuccessSessions = new Map();
const MATCH_SUCCESS_SESSION_TTL_MS = 30 * 60 * 1000;
const MATCH_SUCCESS_PAGE_SIZE = 25;

function createMatchSuccessSessionId(){
  return 'mss' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function cleanupMatchSuccessSessions(){
  const now=Date.now();
  for(const [id,session] of matchSuccessSessions){
    if(!session || now-Number(session.updatedAt||session.createdAt||0)>MATCH_SUCCESS_SESSION_TTL_MS){
      matchSuccessSessions.delete(id);
    }
  }
}

function getMatchPlanPairs(plan){
  const map=new Map();
  for(const club of plan?.clubs||[]){
    const pairNo=Number(club?.pairNo);
    if(!Number.isInteger(pairNo)||pairNo<=0) continue;
    if(!map.has(pairNo)) map.set(pairNo,[]);
    map.get(pairNo).push(club);
  }
  return [...map.entries()]
    .filter(([,clubs])=>clubs.length===2)
    .sort((a,b)=>a[0]-b[0])
    .map(([pairNo,clubs])=>({pairNo,clubs}));
}

function getSuccessEligiblePairs(plan){
  return getMatchPlanPairs(plan).filter(pair=>{
    const states=pair.clubs.map(c=>String(c.status||'pending').toLowerCase());
    // A pair can only be confirmed SUCCESS while both original clubs are still pending.
    // If either side FAILED/EXCLUDED, the other club remains PENDING and this original
    // pair is intentionally not eligible for success.
    return states.every(st=>st==='pending');
  });
}

function buildMatchSuccessView(session){
  const pageCount=Math.max(1,Math.ceil(session.pairs.length/MATCH_SUCCESS_PAGE_SIZE));
  session.page=Math.min(Math.max(Number(session.page)||0,0),pageCount-1);
  const start=session.page*MATCH_SUCCESS_PAGE_SIZE;
  const pageItems=session.pairs.slice(start,start+MATCH_SUCCESS_PAGE_SIZE);

  const options=pageItems.map(pair=>{
    const [a,b]=pair.clubs;
    return {
      label:`Pair ${pair.pairNo}`.slice(0,100),
      description:`${a.club} vs ${b.club}`.slice(0,100),
      value:String(pair.pairNo),
      default:session.selected.has(Number(pair.pairNo))
    };
  });

  const select=new StringSelectMenuBuilder()
    .setCustomId(`mss_select:${session.id}`)
    .setPlaceholder('Select successful FoW pair(s)')
    .setMinValues(0)
    .setMaxValues(Math.max(1,options.length))
    .addOptions(options);

  const navRow=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mss_prev:${session.id}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(session.page<=0),
    new ButtonBuilder().setCustomId(`mss_next:${session.id}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(session.page>=pageCount-1),
    new ButtonBuilder().setCustomId(`mss_clear:${session.id}`).setLabel('Clear').setStyle(ButtonStyle.Secondary)
  );
  const actionRow=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mss_confirm:${session.id}`).setLabel('✅ MARK SUCCESS').setStyle(ButtonStyle.Success).setDisabled(session.selected.size===0),
    new ButtonBuilder().setCustomId(`mss_cancel:${session.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );

  return {
    content:
      `✅ **MATCH SUCCESS — ${session.matchId}**\n`+
      `Select one or more FoW-vs-FoW pairs that matched successfully.\n\n`+
      `Eligible Pairs: **${session.pairs.length}**\n`+
      `Selected: **${session.selected.size}**\n`+
      `Page: **${session.page+1}/${pageCount}**`,
    components:[new ActionRowBuilder().addComponents(select),navRow,actionRow]
  };
}

async function applyMatchSuccessPairs(matchId,pairNumbers,userId){
  const plan=getMatchPlan(matchId);
  if(!plan||!Array.isArray(plan.clubs)) return {ok:false,reason:'missing'};
  const wanted=new Set([...pairNumbers].map(Number));
  const eligible=new Map(getSuccessEligiblePairs(plan).map(pair=>[pair.pairNo,pair]));
  const changedPairs=[];
  const now=Date.now();

  for(const pairNo of wanted){
    const pair=eligible.get(pairNo);
    if(!pair) continue;
    for(const club of pair.clubs){
      club.status='success';
      club.successAt=now;
      club.successBy=userId||null;
      club.failedAt=null;
      club.failedBy=null;
    }
    changedPairs.push(pair);
  }

  if(!changedPairs.length) return {ok:false,reason:'nochange',plan};
  plan.updatedAt=now;
  plan.updatedBy=userId||null;
  matchPlans.set(plan.id,plan);
  await saveMatchPlansNow();
  return {ok:true,plan,changedPairs};
}

function getOperationalModeLabel(mode){ return ({grease:'Grease Lightning',lightning:'Lightning',normal:'Normal / Outside Event',external:'External'})[mode] || 'Standard'; }
function getTimerClubPoolForMode(mode,minElo,maxElo){
  return mode==='external' ? getFilteredLeaderboard(minElo,maxElo) : getFowTimerClubPool(minElo,maxElo);
}

async function cleanupPersistentOperationsData(){
  autoExpireActiveEvent();
  const cutoff=Date.now()-EVENT_DETAIL_RETENTION_DAYS*86400000;
  const completedEventIds=new Set((eventStore.summaries||[]).filter(e=>Number(e.completedAt||e.endAt||0)<cutoff).map(e=>e.id));
  if(completedEventIds.size){
    let changed=false;
    for(const [id,plan] of matchPlans){ if(plan.eventId && completedEventIds.has(plan.eventId)){ matchPlans.delete(id); changed=true; } }
    if(changed) await saveMatchPlansNow();
  }
  await saveEventStoreNow();
}

// ============================================================
// SLASH COMMANDS
// ============================================================


// ============================================================
// AI NATURAL-LANGUAGE PARSER CORE — v71 PRODUCTION
// ============================================================
// Parser core retained from testing; production control is implemented below:
// - English natural-language instructions.
// - Active only in the exact channel/thread where /ai_command_test is started.
// - Only the user who starts the test can issue test instructions.
// - LOCAL parser first (0 AI quota).
// - Gemini 3.5 Flash-Lite fallback ONLY for FoW/war-related text the local parser
//   cannot understand. Normal chat, emoji and unrelated messages are ignored.
// - ALL operational actions are preview/simulation only: no Match ID creation,
//   no Supabase write, no database edit, no real event/timer mutation.

const aiCommandTestSessions = new Map();
const AI_COMMAND_TEST_TTL_MS = 30 * 60 * 1000;

function aiCommandSessionKey(guildId, channelId) {
  return `${String(guildId || "dm")}:${String(channelId || "")}`;
}

function cleanupAiCommandTestSessions() {
  const now = Date.now();
  for (const [key, session] of aiCommandTestSessions.entries()) {
    if (!session || now - Number(session.updatedAt || session.createdAt || 0) > AI_COMMAND_TEST_TTL_MS) {
      aiCommandTestSessions.delete(key);
    }
  }
}

function splitNaturalClubList(text) {
  return String(text || "")
    .replace(/\band\b/gi, ",")
    .split(/[,;\n]+/)
    .map(v => v.trim())
    .map(v => v.replace(/^[\-–—\s]+|[.\s]+$/g, ""))
    .filter(Boolean);
}

function cleanNaturalEntity(value) {
  return String(value || "")
    .replace(/^[\s,;:.-]+|[\s,;:.!?-]+$/g, "")
    .replace(/\b(?:please|pls|for me|now)\b/gi, "")
    .trim();
}

function looksLikeFowOperationalInstruction(content) {
  const text = String(content || "").trim();
  if (!text || text.length < 3) return false;
  // Avoid spending quota on emoji / ordinary conversation.
  const keywords = /\b(?:war|match|matchmaking|elo|derby|club|pusher|president|skip|exclude|avoid|must\s+win|must\s+lose|failed|fail|success|successful|restore|timer|push|ko|cooling|event|grease|lightning|HS\s*\d+)\b/i;
  return keywords.test(text);
}

function parseLocalMatchmakingInstruction(content) {
  const text = String(content || "").trim();
  if (!/\bmatch(?:making)?\b/i.test(text)) return null;

  let range = text.match(/\b(?:from|between)?\s*(\d{4,5})\s*(?:-|–|—|to|until|through|and)\s*(\d{4,5})\b/i);
  if (!range) {
    const nums = [...text.matchAll(/\b(\d{4,5})\b/g)].map(m => Number(m[1]));
    if (nums.length >= 2) range = [null, String(nums[0]), String(nums[1])];
  }
  if (!range) return null;

  const min_elo = Math.min(Number(range[1]), Number(range[2]));
  const max_elo = Math.max(Number(range[1]), Number(range[2]));
  if (!Number.isFinite(min_elo) || !Number.isFinite(max_elo)) return null;

  const skip = [];
  const stopWords = String.raw`(?=\b(?:must\s+win|must\s+lose|prefer|priority|prioritize|cross\s*match|different\s+tier|largest\s+gap|biggest\s+gap)\b|$)`;
  const skipMatch = text.match(new RegExp(String.raw`\b(?:skip|exclude|avoid|don'?t\s+use)\b\s*[:\-]?\s*(.+?)${stopWords}`, "i"));
  if (skipMatch) skip.push(...splitNaturalClubList(skipMatch[1]));
  // Also support postfix form: "FL2 skip" / "Berserker exclude".
  for (const m of text.matchAll(/(?:^|[,;])\s*([^,;]+?)\s+(?:skip|exclude|avoid)\b/gi)) {
    const name = cleanNaturalEntity(m[1]);
    if (name && !/matchmaking|elo|must\s+win|must\s+lose/i.test(name)) skip.push(name);
  }

  const must_win = [];
  const must_lose = [];
  for (const m of text.matchAll(/([^,;.\n]+?)\s+must\s+win\b/gi)) {
    let name = cleanNaturalEntity(m[1]);
    name = name.replace(/^.*?\b(?:then|and)\b\s*/i, "").replace(/^(?:make|set|change)\s+/i, "");
    if (name && !/matchmaking|elo|skip|exclude|avoid/i.test(name)) must_win.push(name);
  }
  for (const m of text.matchAll(/([^,;.\n]+?)\s+must\s+lose\b/gi)) {
    let name = cleanNaturalEntity(m[1]);
    name = name.replace(/^.*?\b(?:then|and)\b\s*/i, "").replace(/^(?:make|set|change)\s+/i, "");
    if (name && !/matchmaking|elo|skip|exclude|avoid/i.test(name)) must_lose.push(name);
  }

  const uniq = arr => [...new Map(arr.map(v => [normalizeClubName(v), v])).values()];
  return { intent:"matchmaking", min_elo, max_elo, skip:uniq(skip), must_win:uniq(must_win), must_lose:uniq(must_lose), parser:"LOCAL" };
}

function parseLocalForcedRoleInstruction(content) {
  const text = String(content || "").trim();
  let m = text.match(/^(?:please\s+)?(?:change|make|set)?\s*(.+?)\s+(?:as\s+)?must\s+win[?.!]*$/i);
  if (m) return { intent:"set_must_win", club:cleanNaturalEntity(m[1]), parser:"LOCAL" };
  m = text.match(/^(?:please\s+)?(?:change|make|set)?\s*(.+?)\s+(?:as\s+)?must\s+lose[?.!]*$/i);
  if (m) return { intent:"set_must_lose", club:cleanNaturalEntity(m[1]), parser:"LOCAL" };
  return null;
}

function parseLocalChangeMatchInstruction(content) {
  const text = String(content || "").trim();
  if (!/\b(change|replace|switch|swap|rematch)\b/i.test(text)) return null;
  let m = text.match(/\b(?:change|replace|switch|swap)\s+(.+?)\s+(?:match\s+with|opponent\s+(?:to|with)|with|to)\s+(.+?)[?.!]*$/i);
  if (!m) m = text.match(/\b(.+?)'?s\s+opponent\s+(?:to|with)\s+(.+?)[?.!]*$/i);
  if (!m) return null;
  const target = cleanNaturalEntity(m[1].replace(/^(?:can\s+you|please)\s+/i, ""));
  const replacement = cleanNaturalEntity(m[2]);
  if (!target || !replacement) return null;
  return { intent:"change_match", target, replacement, parser:"LOCAL" };
}

function parseLocalStatusInstruction(content) {
  const text = String(content || "").trim();
  let m = text.match(/\b(?:mark|set)?\s*(.+?)\s+(?:as\s+)?failed\s+(?:for|in)?\s*(HS\s*\d+)\b/i);
  if (m) return { intent:"mark_failed", club:cleanNaturalEntity(m[1]), match_id:normalizeMatchId(m[2]), parser:"LOCAL" };
  m = text.match(/\b(?:mark|set)?\s*(.+?)\s+(?:as\s+)?success(?:ful)?\s+(?:for|in)?\s*(HS\s*\d+)\b/i);
  if (m) return { intent:"mark_success", club:cleanNaturalEntity(m[1]), match_id:normalizeMatchId(m[2]), parser:"LOCAL" };
  m = text.match(/\b(?:restore|reset)\s+(.+?)\s+(?:for|in)?\s*(HS\s*\d+)\b/i);
  if (m) return { intent:"restore_match", club:cleanNaturalEntity(m[1]), match_id:normalizeMatchId(m[2]), parser:"LOCAL" };
  return null;
}

function parseLocalReadInstruction(content) {
  const text = String(content || "").trim();
  if (/\b(show|list|display|give\s+me)\b.*\b(active\s+)?timers?\b/i.test(text) || /^active\s+timers?$/i.test(text)) return { intent:"show_timers", parser:"LOCAL" };
  if (/\b(show|display|give\s+me)\b.*\bevent\s+stats?\b/i.test(text) || /^event\s+stats?$/i.test(text)) return { intent:"show_event_stats", parser:"LOCAL" };
  return null;
}

function parseLocalTestMatchIdInstruction(content) {
  const text = String(content || "").trim();
  let m = text.match(/\b(?:create|set|use)\s+(?:a\s+)?(?:test\s+)?match\s*id\s*(?:to|as)?\s*(HS\s*\d+)\b/i);
  if (!m) m = text.match(/\b(?:use|set)\s*(HS\s*\d+)\s+(?:as\s+)?(?:the\s+)?test\s+match(?:\s*id)?\b/i);
  if (!m) return null;
  return { intent:"create_test_match_id", match_id:normalizeMatchId(m[1]), parser:"LOCAL" };
}

function parseLocalEventInstruction(content) {
  const text = String(content || "").trim();
  let m = text.match(/\b(?:start|begin)\s+(?:the\s+)?(grease(?:\s+lightning)?|lightning)(?:\s+event)?\b/i);
  if (m) {
    const raw = m[1].toLowerCase();
    return { intent:"start_event", event_type:raw.startsWith("grease") ? "Grease Lightning" : "Lightning", parser:"LOCAL" };
  }
  if (/\b(?:end|stop|finish)\s+(?:the\s+)?(?:current\s+)?event\b/i.test(text)) return { intent:"end_event", parser:"LOCAL" };
  return null;
}

function parseLocalTimerInstruction(content) {
  const text = String(content || "").trim();
  const mid = text.match(/\b(HS\s*\d+)\b/i);
  const match_id = mid ? normalizeMatchId(mid[1]) : null;
  const hasStart = /\b(?:start|begin|run)\b/i.test(text);
  const hasTimer = /\btimer\b/i.test(text);
  if (!hasStart || !hasTimer) return null;

  // Both "start KO timer" and "KO timer start" are LOCAL.
  if (/\b(?:ko|knock\s*out)\b/i.test(text)) return { intent:"start_timer", timer_type:"ko", match_id, parser:"LOCAL" };
  if (/\bwar\s*done\b/i.test(text)) return { intent:"start_timer", timer_type:"war_done", match_id, parser:"LOCAL" };
  if (/\b(?:push|preparation|prep)\b/i.test(text)) {
    const hours = text.match(/\b(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\b/i);
    return { intent:"start_timer", timer_type:"push", requested_hours:hours?Number(hours[1]):null, match_id, parser:"LOCAL" };
  }
  if (/\bcooling\b/i.test(text)) return { intent:"start_timer", timer_type:"cooling", match_id, parser:"LOCAL" };
  if (/^(?:the\s+)?timer\s+(?:start|begin|run)[?.!]*$/i.test(text) || /^(?:start|begin|run)\s+(?:the\s+)?timer[?.!]*$/i.test(text)) {
    return { intent:"start_timer", timer_type:"push", requested_hours:null, match_id, parser:"LOCAL" };
  }
  return null;
}

function parseLocalAiCommand(content) {
  return parseLocalMatchmakingInstruction(content)
    || parseLocalForcedRoleInstruction(content)
    || parseLocalChangeMatchInstruction(content)
    || parseLocalStatusInstruction(content)
    || parseLocalReadInstruction(content)
    || parseLocalTestMatchIdInstruction(content)
    || parseLocalEventInstruction(content)
    || parseLocalTimerInstruction(content)
    || null;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}


// ============================================================
// HS ASSISTANT — PHASE 5 HYBRID AI (READ ONLY)
// Gemini primary AI fallback • OpenAI secondary fallback
// These functions return text only and execute no FoW actions.
// ============================================================
async function askHsGeminiReadOnly(question, context = "") {
  if (!GoogleGenAI || !GEMINI_API_KEY) {
    return { ok: false, provider: "GEMINI", reason: "not_configured" };
  }

  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const prompt =
      `You are HS Assistant for the Force of War Discord community.\n` +
      `You are operating in STRICT READ-ONLY mode.\n` +
      `Answer the user's question clearly and concisely.\n` +
      `Never claim that you changed ELO, Supabase, Match IDs, timers, ` +
      `War Monitor, isolation, matchmaking state, Discord settings or production data.\n` +
      `Never invent club names, ELO values, presidents, Match IDs or live operational state.\n` +
      `If live data is not provided in the context, say that you do not have that live data.\n` +
      `Do not reveal API keys, tokens, passwords, environment variables or credentials.\n` +
      `Do not provide instructions to bypass HS read-only restrictions.\n\n` +
      (context ? `FoW context:\n${context}\n\n` : "") +
      `User question:\n${String(question || "").slice(0, 4000)}`;

    const result = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: prompt,
      config: {
        temperature: 0.2,
        maxOutputTokens: 700
      }
    });

    const text = String(result?.text || "").trim();

    if (!text) {
      return { ok: false, provider: "GEMINI", reason: "empty_response" };
    }

    return { ok: true, provider: "GEMINI", text };
  } catch (error) {
    const message = String(error?.message || error || "");
    console.warn(
      `⚠️ HS Gemini read-only fallback failed: ${message.slice(0, 500)}`
    );

    return {
      ok: false,
      provider: "GEMINI",
      reason: /429|quota|rate.?limit/i.test(message)
        ? "quota"
        : "provider_error"
    };
  }
}

async function askHsOpenAIReadOnly(question, context = "") {
  if (!OPENAI_API_KEY) {
    return { ok: false, provider: "OPENAI", reason: "not_configured" };
  }

  try {
    const instructions =
      `You are HS Assistant for the Force of War Discord community. ` +
      `You are operating in STRICT READ-ONLY mode. ` +
      `Answer clearly and concisely. ` +
      `Never claim that you changed ELO, Supabase, Match IDs, timers, ` +
      `War Monitor, isolation, matchmaking state, Discord settings or production data. ` +
      `Never invent club names, ELO values, presidents, Match IDs or live operational state. ` +
      `If live data is not provided in the context, say that you do not have that live data. ` +
      `Never reveal API keys, tokens, passwords, environment variables or credentials. ` +
      `Do not provide instructions to bypass HS read-only restrictions.`;

    const input =
      (context ? `FoW context:\n${context}\n\n` : "") +
      `User question:\n${String(question || "").slice(0, 4000)}`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: HS_OPENAI_MODEL,
        instructions,
        input,
        max_output_tokens: 700
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const message = String(data?.error?.message || "");
      console.warn(
        `⚠️ HS OpenAI read-only fallback failed (${response.status}): ` +
        message.slice(0, 500)
      );

      return {
        ok: false,
        provider: "OPENAI",
        reason:
          response.status === 429
            ? "quota"
            : response.status === 401 || response.status === 403
              ? "authentication"
              : "provider_error"
      };
    }

    const text =
      String(data?.output_text || "").trim() ||
      String(
        (data?.output || [])
          .flatMap(item => item?.content || [])
          .find(item => item?.type === "output_text")?.text || ""
      ).trim();

    if (!text) {
      return { ok: false, provider: "OPENAI", reason: "empty_response" };
    }

    return { ok: true, provider: "OPENAI", text };
  } catch (error) {
    const message = String(error?.message || error || "");
    console.warn(
      `⚠️ HS OpenAI read-only fallback failed: ${message.slice(0, 500)}`
    );

    return {
      ok: false,
      provider: "OPENAI",
      reason: "provider_error"
    };
  }
}

async function parseGeminiCommandInstruction(content) {
  if (!GoogleGenAI || !GEMINI_API_KEY) return null;
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const prompt = `You are an intent parser for a Discord FoW ELO bot.\n` +
    `Return JSON only. Do not execute anything and do not invent club names, Match IDs, ELOs or pusher names.\n` +
    `Supported intents:\n` +
    `matchmaking {min_elo,max_elo,skip[],must_win[],must_lose[]}\n` +
    `change_match {target,replacement}\nset_must_win {club}\nset_must_lose {club}\n` +
    `mark_failed {club,match_id}\nmark_success {club,match_id}\nrestore_match {club,match_id}\n` +
    `show_timers {}\nshow_event_stats {}\ncreate_test_match_id {match_id}\nstart_event {event_type:Grease Lightning|Lightning}\nend_event {}\n` +
    `start_timer {timer_type:ko|war_done|push|cooling,match_id:string|null,requested_hours:number|null}\n` +
    `Otherwise {"intent":"unknown"}.\nUser instruction: ${JSON.stringify(String(content || ""))}`;
  try {
    const response = await ai.models.generateContent({ model:"gemini-3.5-flash-lite", contents:prompt, config:{ temperature:0, maxOutputTokens:300 } });
    const parsed = extractJsonObject(response?.text || "");
    if (!parsed || !parsed.intent || parsed.intent === "unknown") return null;
    const intent = String(parsed.intent);
    const allowed = new Set(["matchmaking","change_match","set_must_win","set_must_lose","mark_failed","mark_success","restore_match","show_timers","show_event_stats","create_test_match_id","start_event","end_event","start_timer"]);
    if (!allowed.has(intent)) return null;
    if (intent === "matchmaking") {
      const min=Number(parsed.min_elo), max=Number(parsed.max_elo); if(!Number.isFinite(min)||!Number.isFinite(max)) return null;
      return { intent,min_elo:Math.min(min,max),max_elo:Math.max(min,max),skip:Array.isArray(parsed.skip)?parsed.skip.map(String).filter(Boolean):[],must_win:Array.isArray(parsed.must_win)?parsed.must_win.map(String).filter(Boolean):[],must_lose:Array.isArray(parsed.must_lose)?parsed.must_lose.map(String).filter(Boolean):[],parser:"GEMINI 3.5 FLASH-LITE" };
    }
    if (intent === "change_match") { if(!parsed.target||!parsed.replacement)return null; return {intent,target:String(parsed.target),replacement:String(parsed.replacement),parser:"GEMINI 3.5 FLASH-LITE"}; }
    if (["set_must_win","set_must_lose"].includes(intent)) { if(!parsed.club)return null; return {intent,club:String(parsed.club),parser:"GEMINI 3.5 FLASH-LITE"}; }
    if (["mark_failed","mark_success","restore_match"].includes(intent)) { if(!parsed.club||!parsed.match_id)return null; return {intent,club:String(parsed.club),match_id:normalizeMatchId(parsed.match_id),parser:"GEMINI 3.5 FLASH-LITE"}; }
    if (intent === "start_event") { const et=/grease/i.test(String(parsed.event_type||""))?"Grease Lightning":/lightning/i.test(String(parsed.event_type||""))?"Lightning":null; if(!et)return null; return {intent,event_type:et,parser:"GEMINI 3.5 FLASH-LITE"}; }
    if (intent === "create_test_match_id") { if(!parsed.match_id)return null; return {intent,match_id:normalizeMatchId(parsed.match_id),parser:"GEMINI 3.5 FLASH-LITE"}; }
    if (intent === "start_timer") { const tt=String(parsed.timer_type||"").toLowerCase(); if(!["ko","war_done","push","cooling"].includes(tt))return null; return {intent,timer_type:tt,match_id:parsed.match_id?normalizeMatchId(parsed.match_id):null,requested_hours:Number.isFinite(Number(parsed.requested_hours))?Number(parsed.requested_hours):null,parser:"GEMINI 3.5 FLASH-LITE"}; }
    return { intent, parser:"GEMINI 3.5 FLASH-LITE" };
  } catch (error) {
    const msg=String(error?.message||error||""); console.warn(`⚠️ AI command Gemini fallback failed: ${msg.slice(0,500)}`);
    return { intent:"gemini_error", error:msg, parser:"GEMINI 3.5 FLASH-LITE" };
  }
}


// ============================================================
// HS PHASE 6.1A — CONVERSATIONAL INTENT LAYER
// Interpretation/context only. NO production execution here.
// ============================================================
const hsConversationSessions = new Map();
const HS_CONVERSATION_TTL_MS = 45 * 60 * 1000;

function hsConversationKey(message) {
  return [
    String(message?.guildId || "dm"),
    String(message?.channelId || "unknown"),
    String(message?.author?.id || "unknown")
  ].join(":");
}

function cleanupHsConversationSessions() {
  const now = Date.now();

  for (const [key, session] of hsConversationSessions.entries()) {
    const touched = Number(session?.updatedAt || session?.createdAt || 0);

    if (!touched || now - touched > HS_CONVERSATION_TTL_MS) {
      hsConversationSessions.delete(key);
    }
  }
}

function getHsConversationSession(message) {
  cleanupHsConversationSessions();

  const key = hsConversationKey(message);
  let session = hsConversationSessions.get(key);

  if (!session) {
    session = {
      key,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastIntent: null,
      lastRange: null,
      lastClub: null,
      lastMatchId: null,
      activeDraftId: null,
      pendingAction: null,
      lastResults: []
    };

    hsConversationSessions.set(key, session);
  }

  session.updatedAt = Date.now();
  return session;
}

function buildHsConversationContext(session) {
  if (!session) return {};

  return {
    lastIntent: session.lastIntent || null,
    lastRange: session.lastRange || null,
    lastClub: session.lastClub || null,
    lastMatchId: session.lastMatchId || null,
    activeDraftId: session.activeDraftId || null,
    pendingAction: session.pendingAction || null,
    lastResults: Array.isArray(session.lastResults)
      ? session.lastResults.slice(0, 20)
      : []
  };
}

async function interpretHsConversationIntent(content, session) {
  if (!GoogleGenAI || !GEMINI_API_KEY) {
    return {
      intent: "unknown",
      confidence: 0,
      parser: "HS CONVERSATION",
      reason: "gemini_not_configured"
    };
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const context = buildHsConversationContext(session);

  const prompt =
    `You are the intent interpreter for HS Assistant, a Force of War Discord operations bot.\n` +
    `Interpret the user's meaning. NEVER execute an action.\n` +
    `Return exactly one JSON object and no markdown.\n` +
    `Use conversation context to resolve words such as it, this, that, previous, tadi, yang tadi, dia, mereka, and numbered references.\n` +
    `Never invent club names, ELO values, Match IDs, presidents, pushers, timers or live status.\n` +
    `If required information is missing or ambiguous, set requires_clarification=true and provide clarification_question.\n\n` +

    `Supported intents:\n` +
    `leaderboard\n` +
    `derby_leaderboard\n` +
    `elo_lookup\n` +
    `elo_range\n` +
    `club_availability\n` +
    `matchmaking\n` +
    `modify_matchmaking\n` +
    `set_destination\n` +
    `war_status\n` +
    `show_timers\n` +
    `start_timer\n` +
    `change_timer\n` +
    `start_event\n` +
    `end_event\n` +
    `transition_event\n` +
    `show_event_stats\n` +
    `add_derby_club\n` +
    `remove_derby_club\n` +
    `mark_failed\n` +
    `mark_success\n` +
    `restore_match\n` +
    `confirm_pending\n` +
    `cancel_pending\n` +
    `unknown\n\n` +

    `JSON schema:\n` +
    `{\n` +
    `  "intent": "one supported intent",\n` +
    `  "confidence": 0.0,\n` +
    `  "club": null,\n` +
    `  "clubs": [],\n` +
    `  "min_elo": null,\n` +
    `  "max_elo": null,\n` +
    `  "skip": [],\n` +
    `  "must_win": [],\n` +
    `  "must_lose": [],\n` +
    `  "destination": null,\n` +
    `  "match_id": null,\n` +
    `  "timer_type": null,\n` +
    `  "requested_hours": null,\n` +
    `  "event_type": null,\n` +
    `  "from_event": null,\n` +
    `  "to_event": null,\n` +
    `  "reference_number": null,\n` +
    `  "requires_clarification": false,\n` +
    `  "clarification_question": null\n` +
    `}\n\n` +

    `Destination must be one of high, mid, low, additional, test, or null.\n` +
    `Event values must be one of normal, lightning, grease, or null.\n` +
    `If one message asks to close/end one event and start another event, use transition_event with from_event and to_event.\n` +
    `Examples: close normal event and start lightning event => transition_event normal to lightning; close lightning and start grease event => transition_event lightning to grease; close grease and return to normal => transition_event grease to normal.\n` +
    `Do not treat ordinary conversation as an operational command.\n` +
    `A confirmation such as yes, ya, proceed, confirm, teruskan refers only to pendingAction from context.\n` +
    `A cancellation such as no, cancel, batal refers only to pendingAction from context.\n\n` +
    `Conversation context:\n${JSON.stringify(context)}\n\n` +
    `User message:\n${JSON.stringify(String(content || "").slice(0, 4000))}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: prompt,
      config: {
        temperature: 0,
        maxOutputTokens: 500
      }
    });

    const parsed = extractJsonObject(response?.text || "");

    if (!parsed || !parsed.intent) {
      return {
        intent: "unknown",
        confidence: 0,
        parser: "HS CONVERSATION"
      };
    }

    const allowed = new Set([
      "leaderboard",
      "derby_leaderboard",
      "elo_lookup",
      "elo_range",
      "club_availability",
      "matchmaking",
      "modify_matchmaking",
      "set_destination",
      "war_status",
      "show_timers",
      "start_timer",
      "change_timer",
      "start_event",
      "end_event",
      "transition_event",
      "show_event_stats",
      "add_derby_club",
      "remove_derby_club",
      "mark_failed",
      "mark_success",
      "restore_match",
      "confirm_pending",
      "cancel_pending",
      "unknown"
    ]);

    const intent = String(parsed.intent || "unknown");

    if (!allowed.has(intent)) {
      return {
        intent: "unknown",
        confidence: 0,
        parser: "HS CONVERSATION"
      };
    }

    return {
      ...parsed,
      intent,
      confidence: Math.max(
        0,
        Math.min(1, Number(parsed.confidence) || 0)
      ),
      parser: "HS CONVERSATION / GEMINI 3.5 FLASH-LITE"
    };
  } catch (error) {
    const message = String(error?.message || error || "");

    console.warn(
      `⚠️ HS conversational intent failed: ${message.slice(0, 500)}`
    );

    return {
      intent: "unknown",
      confidence: 0,
      parser: "HS CONVERSATION",
      error: message
    };
  }
}

function resolveNaturalClubToken(token, candidates = leaderboardData) {
  const value=String(token||"").trim(); if(!value)return null;
  // Resolution priority: exact club -> alias -> exact president/pusher -> unique partial/fuzzy.
  const normalized=normalizeClubName(value);
  const pool=candidates||leaderboardData;
  const exactClub=pool.find(item=>normalizeClubName(item.club)===normalized); if(exactClub)return exactClub;
  const aliasTarget=clubAliases[normalizeClubAliasKey(value)];
  if(aliasTarget){ const aliased=pool.find(item=>normalizeClubName(item.club)===normalizeClubName(aliasTarget)); if(aliased)return aliased; }
  const exactPresident=pool.find(item=>normalizeClubName(item.president)===normalized); if(exactPresident)return exactPresident;
  const directIndex=findClubIndex(value);
  if(directIndex!==-1){ const item=leaderboardData[directIndex]; if(pool.some(c=>normalizeClubName(c.club)===normalizeClubName(item.club)))return item; }
  const fuzzy=pool.filter(item=>itemMatchesSkip(item,value));
  if(fuzzy.length===1)return fuzzy[0];
  const partial=pool.filter(item=>normalizeClubName(item.club).includes(normalized)||normalizeClubName(item.president).includes(normalized));
  if(partial.length===1)return partial[0];
  return null;
}

function pairMustWinLoseFirst(available, mustWinSet, mustLoseSet) {
  const remaining=[...available]; const forcedPairs=[]; const unresolved=[];
  const getByKey=(set)=>remaining.filter(c=>set.has(normalizeClubName(c.club)));
  while(true){
    const wins=getByKey(mustWinSet), loses=getByKey(mustLoseSet); if(!wins.length||!loses.length)break;
    let best=null;
    for(const w of wins) for(const l of loses){ if(normalizeClubName(w.club)===normalizeClubName(l.club))continue; const gap=Math.abs(Number(w.elo)-Number(l.elo)); if(gap>MATCHMAKING_MAX_GAP)continue; const diff=getEloGroup(w)!==getEloGroup(l); const cand={w,l,gap,diff}; if(!best||Number(diff)>Number(best.diff)||(diff===best.diff&&gap>best.gap))best=cand; }
    if(!best)break;
    forcedPairs.push({a:best.w,b:best.l,gap:best.gap,differentTier:best.diff,winner:best.w,loser:best.l});
    for(const c of [best.w,best.l]){ const idx=remaining.findIndex(x=>normalizeClubName(x.club)===normalizeClubName(c.club)); if(idx>=0)remaining.splice(idx,1); }
  }
  for(const c of remaining){ const k=normalizeClubName(c.club); if(mustWinSet.has(k))unresolved.push(`${c.club} (MUST WIN)`); if(mustLoseSet.has(k))unresolved.push(`${c.club} (MUST LOSE)`); }
  const leftoverWin=new Set([...mustWinSet].filter(k=>remaining.some(c=>normalizeClubName(c.club)===k)));
  const leftoverLose=new Set([...mustLoseSet].filter(k=>remaining.some(c=>normalizeClubName(c.club)===k)));
  return {forcedPairs,remaining,unresolved,leftoverWin,leftoverLose};
}

function dryRunMatchmakingFromIntent(intent) {
  const min=Number(intent.min_elo), max=Number(intent.max_elo); const rangeData=getDerbyFilteredLeaderboard(min,max);
  const skipped=[],unresolvedSkip=[],skipKeys=new Set();
  for(const token of intent.skip||[]){ const club=resolveNaturalClubToken(token,rangeData); if(club){skipKeys.add(normalizeClubName(club.club));skipped.push(club);}else unresolvedSkip.push(String(token)); }
  const available=rangeData.filter(item=>!skipKeys.has(normalizeClubName(item.club)));
  const mustWinSet=new Set(),mustLoseSet=new Set(),unresolvedForced=[];
  for(const token of intent.must_win||[]){ const club=resolveNaturalClubToken(token,available); if(club)mustWinSet.add(normalizeClubName(club.club));else unresolvedForced.push(`${token} (must win)`); }
  for(const token of intent.must_lose||[]){ const club=resolveNaturalClubToken(token,available); if(club)mustLoseSet.add(normalizeClubName(club.club));else unresolvedForced.push(`${token} (must lose)`); }
  // v70 TEST RULE: MUST WIN is paired with MUST LOSE first. Only then are the
  // remaining clubs sent through the normal matchmaking optimizer.
  const stage=pairMustWinLoseFirst(available,mustWinSet,mustLoseSet);
  const normal=optimizeMatchmaking(stage.remaining,stage.leftoverWin,stage.leftoverLose);
  const result={...normal,pairs:[...stage.forcedPairs,...normal.pairs],matchedClubs:stage.forcedPairs.length*2+normal.matchedClubs,totalGap:stage.forcedPairs.reduce((s,p)=>s+p.gap,0)+normal.totalGap,differentTierMatches:stage.forcedPairs.filter(p=>p.differentTier).length+normal.differentTierMatches,gaps:[...stage.forcedPairs.map(p=>p.gap),...normal.gaps],forcedMatched:stage.forcedPairs.length*2+(normal.forcedMatched||0)};
  unresolvedForced.push(...stage.unresolved);
  return {result,skipped,unresolvedSkip,unresolvedForced,available,min,max,forcedPairs:stage.forcedPairs};
}

function formatAiInterpretation(intent,dry){
  const fmt=a=>(a||[]).length?(a||[]).map(x=>`• ${x}`).join("\n"):"• None"; const warnings=[];
  if(dry.unresolvedSkip.length)warnings.push(`⚠️ Skip not resolved: ${dry.unresolvedSkip.join(", ")}`);
  if(dry.unresolvedForced.length)warnings.push(`⚠️ Forced rule unresolved / no opposite forced club within 100 ELO: ${dry.unresolvedForced.join(", ")}`);
  const resolvedSkip=(dry.skipped||[]).length?(dry.skipped||[]).map(x=>`• ${x.club}${x.president?` — ${x.president}`:""}`).join("\n"):"• None";
  return `🧠 **AI COMMAND TEST — INTERPRETATION**\nParser: **${intent.parser}**\nAI quota used: **${intent.parser==="LOCAL"?"NO":"YES"}**\nAction: **MATCHMAKING (DRY RUN)**\nELO Range: **${intent.min_elo} - ${intent.max_elo}**\n\n**Skip requested**\n${fmt(intent.skip)}\n\n**Skip resolved**\n${resolvedSkip}\n\n**Must Win**\n${fmt(intent.must_win)}\n\n**Must Lose**\n${fmt(intent.must_lose)}\n\nForced MW↔ML pairs made first: **${dry.forcedPairs.length}**`+(warnings.length?`\n\n${warnings.join("\n")}`:"")+`\n\n🧪 **No Match ID created. No Supabase/database/event/timer data changed.**`;
}

function findPlansContainingClub(club,guildId){const key=normalizeClubName(club.club);return [...matchPlans.values()].filter(plan=>(!guildId||!plan.guildId||String(plan.guildId)===String(guildId))&&Array.isArray(plan.clubs)&&plan.clubs.some(c=>normalizeClubName(c.club)===key));}
function getPairFromPlan(plan,clubName){if(!plan||!Array.isArray(plan.clubs))return null;const item=plan.clubs.find(c=>normalizeClubName(c.club)===normalizeClubName(clubName));if(!item||!item.pairNo)return null;const pair=plan.clubs.filter(c=>Number(c.pairNo)===Number(item.pairNo));return pair.length?{item,pair,pairNo:Number(item.pairNo)}:null;}
function previewChangeMatch(intent,guildId){const target=resolveNaturalClubToken(intent.target,leaderboardData),replacement=resolveNaturalClubToken(intent.replacement,leaderboardData);if(!target||!replacement)return{error:`Could not resolve ${!target?`target **${intent.target}**`:`replacement **${intent.replacement}**`} to a unique club/pusher.`};if(normalizeClubName(target.club)===normalizeClubName(replacement.club))return{error:"Target and replacement resolve to the same club."};const plans=findPlansContainingClub(target,guildId).sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));if(!plans.length)return{error:`${target.club} is not found in a saved Match ID.`};const plan=plans[0],current=getPairFromPlan(plan,target.club);if(!current||current.pair.length<2)return{error:`Could not resolve the current pair for ${target.club} in ${plan.id}.`};const opponent=current.pair.find(c=>normalizeClubName(c.club)!==normalizeClubName(target.club));const replacementExisting=plan.clubs.find(c=>normalizeClubName(c.club)===normalizeClubName(replacement.club));return{target,replacement,plan,current,opponent,replacementExisting};}
function previewStatusIntent(intent){const plan=getMatchPlan(intent.match_id);if(!plan)return{error:`Match ID **${intent.match_id}** was not found.`};const club=resolveNaturalClubToken(intent.club,plan.clubs);if(!club)return{error:`Could not resolve **${intent.club}** inside ${plan.id}.`};const stored=plan.clubs.find(c=>normalizeClubName(c.club)===normalizeClubName(club.club));return{plan,club:stored||club};}

function getSimulatedTimerSpec(intent,session){
  const event=session.testEventType||null; let hours=null,label="";
  if(intent.timer_type==="ko"){hours=2;label="KO";}
  else if(intent.timer_type==="war_done"){
    if(event==="Grease Lightning"||event==="Lightning"){hours=2;label="KO";} else {hours=14;label="KO + Cooling Down";}
  } else if(intent.timer_type==="push"){
    if(event==="Grease Lightning")return{blocked:true,reason:"Grease Lightning has no preparation timer."};
    hours=event==="Lightning"?6:(intent.requested_hours||12); label="Preparation / Push";
  } else if(intent.timer_type==="cooling"){
    if(event==="Grease Lightning"||event==="Lightning")return{blocked:true,reason:`${event} does not use the Normal 12-hour cooling-down timer.`};
    hours=12;label="Cooling Down";
  }
  return{blocked:false,hours,label,event:event||"Normal / Outside Event"};
}

function getTestTimerClubs(session, matchId) {
  if (Array.isArray(session?.testMatchClubs) && session.testMatchClubs.length) return session.testMatchClubs;
  if (matchId) {
    const plan = getMatchPlan(matchId);
    if (plan && Array.isArray(plan.clubs)) return plan.clubs.filter(c => String(c.status || "pending").toLowerCase() !== "failed");
  }
  return [];
}

function formatSimulatedProductionTimer(spec, intent, session, end) {
  const matchId = intent.match_id || session.testMatchId || null;
  const clubs = getTestTimerClubs(session, matchId);
  const title = spec.label === "KO + Cooling Down"
    ? "❄️🥊 FOW KO + COOLING DOWN STARTED 🥊❄️"
    : spec.label === "KO"
      ? "🥊⚔️ FOW KO TIMER STARTED ⚔️🥊"
      : "🚀⚔️ FOW PUSH STARTED ⚔️🚀";
  const timerLine = spec.label === "KO + Cooling Down"
    ? `❄️🥊 KO + Cooling Down: **${spec.hours} Hours**`
    : spec.label === "KO"
      ? `🥊 KO Timer: **${spec.hours} Hours**`
      : `⏳ Preparation: **${spec.hours} Hours**`;
  const clubList = clubs.length ? formatFowTimerClubList(clubs) : "🏰 No clubs attached to this simulated Match ID yet.";
  return `🧪 **TEST MODE — NO REAL TIMER CREATED**\n${title}\n━━━━━━━━━━━━━━━━━━━━\n\n${timerLine}\n🎮 Mode: **${spec.event}**\n${matchId ? `🆔 Match ID: **${matchId}**\n` : ""}🔥 Clubs: **${clubs.length}**\n\n${clubList}\n\n🕒 Ends: <t:${Math.floor(end / 1000)}:F> (<t:${Math.floor(end / 1000)}:R>)\n🔔 Reminder: **15 Minutes** before timer ends.\n\n⚠️ Simulation only — no reminder, Supabase record, production timer or Match ID was changed.`;
}

async function handleAiCommandTestMessage(message,session){
  let intent=parseLocalAiCommand(message.content);
  if(!intent){
    if(!looksLikeFowOperationalInstruction(message.content))return false; // silently ignore unrelated chat
    intent=await parseGeminiCommandInstruction(message.content);
  }
  if(!intent){await message.reply("❓ I could not understand that FoW/war instruction. Try a simpler English sentence.");return true;}
  session.updatedAt=Date.now();
  if(intent.intent==="gemini_error"){const quota=/429|quota|rate.?limit/i.test(intent.error||"");await message.reply(quota?"⚠️ Gemini fallback hit its quota/rate limit. LOCAL parser is still available; try a simpler FoW instruction.":"⚠️ Gemini fallback is temporarily unavailable. LOCAL parser is still available; try a simpler FoW instruction.");return true;}
  const source=`Parser: **${intent.parser}**\nAI quota used: **${intent.parser==="LOCAL"?"NO":"YES"}**`;

  if(intent.intent==="matchmaking"){
    if(Number(intent.min_elo)<=0||Number(intent.max_elo)<=0||Number(intent.min_elo)>Number(intent.max_elo)){await message.reply("❌ Invalid ELO range.");return true;}
    try {
      const dry=dryRunMatchmakingFromIntent(intent);
      session.lastDryRun=dry;
      // v70: dry.result is the optimizer result object. Its actual pairs live in dry.result.pairs.
      // v69 incorrectly called .flatMap() on the result object itself, which caused every
      // natural-language matchmaking instruction to crash after it had already parsed correctly.
      const dryPairs = Array.isArray(dry?.result?.pairs) ? dry.result.pairs : [];
      session.testMatchClubs=dryPairs.flatMap(pair=>[pair.a,pair.b]).filter(Boolean);

      // Hard safety validation: a resolved SKIP club must never appear in a generated pair.
      const skippedKeys = new Set((dry.skipped||[]).map(c=>normalizeClubName(c.club)));
      const leakedSkip = session.testMatchClubs.find(c=>skippedKeys.has(normalizeClubName(c.club)));
      if (leakedSkip) {
        throw new Error(`Skipped club leaked into dry-run result: ${leakedSkip.club}`);
      }

      await message.reply(formatAiInterpretation(intent,dry));
      const txt=formatMatchmakingOutput(dry.result,dry.min,dry.max,dry.skipped,session.testMatchId||null).replace("⚔️ **FoW ELO MATCHMAKING**","🧪 **FoW ELO MATCHMAKING — TEST DRY RUN**");
      for(const chunk of splitDiscordText(txt,1900)) await message.channel.send(chunk);
      return true;
    } catch (error) {
      console.error("❌ v70 matchmaking dry-run failed:", error);
      const details = [
        `Range: **${intent.min_elo} - ${intent.max_elo}**`,
        `Skip: **${(intent.skip||[]).join(", ") || "None"}**`,
        `Must Win: **${(intent.must_win||[]).join(", ") || "None"}**`,
        `Must Lose: **${(intent.must_lose||[]).join(", ") || "None"}**`
      ].join("\n");
      await message.reply(`${source}\n❌ **MATCHMAKING DRY-RUN PROCESSING ERROR**\n${details}\n\nReason: **${String(error?.message||error||"Unknown error").slice(0,220)}**\n\n🧪 No production data changed.`);
      return true;
    }
  }
  if(intent.intent==="create_test_match_id"){
    session.testMatchId=intent.match_id;
    if(!Array.isArray(session.testMatchClubs)) session.testMatchClubs=[];
    await message.reply(`${source}\n🧪 **TEST MATCH CONTEXT CREATED**\nMatch ID: **${intent.match_id}**\nMode: **SIMULATION ONLY**\nAttached dry-run clubs: **${session.testMatchClubs.length}**\n\nNo production Match ID was created. No Supabase data changed.`);
    return true;
  }
  if(intent.intent==="change_match"){
    const p=previewChangeMatch(intent,message.guildId);if(p.error){await message.reply(`${source}\nAction: **CHANGE MATCH — DRY RUN**\n\n❌ ${p.error}\n\n🧪 No production data changed.`);return true;}
    const dup=p.replacementExisting&&normalizeClubName(p.replacementExisting.club)!==normalizeClubName(p.opponent?.club||"")?`\n⚠️ **${p.replacement.club} is already inside ${p.plan.id}.** A real edit would need to repair both affected pairs.`:"";
    await message.reply(`${source}\nAction: **CHANGE MATCH — DRY RUN**\nMatch ID: **${p.plan.id}**\n\n**Current**\n${p.target.club} (${p.target.elo}) — ${p.target.president||"-"}\nvs ${p.opponent?.club||"Unknown"} (${p.opponent?.elo||"?"}) — ${p.opponent?.president||"-"}\n\n**Requested**\n${p.target.club} (${p.target.elo}) — ${p.target.president||"-"}\nvs ${p.replacement.club} (${p.replacement.elo}) — ${p.replacement.president||"-"}${dup}\n\n🧪 **Preview only. Match ID was not modified.**`);return true;
  }
  if(["set_must_win","set_must_lose"].includes(intent.intent)){
    const club=resolveNaturalClubToken(intent.club,leaderboardData);if(!club){await message.reply(`${source}\n❌ Could not uniquely resolve **${intent.club}** as a club or president/pusher.`);return true;}
    const plans=findPlansContainingClub(club,message.guildId).sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));const plan=plans[0];const pair=plan?getPairFromPlan(plan,club.club):null;const role=intent.intent==="set_must_win"?"MUST WIN":"MUST LOSE";
    await message.reply(`${source}\nAction: **${role} — DRY RUN**\nResolved: **${intent.club} → ${club.club}**${club.president?` (${club.president})`:""}${plan?`\nLatest Match ID: **${plan.id}**`:""}${pair&&pair.pair.length>1?`\nCurrent opponent: **${pair.pair.find(c=>normalizeClubName(c.club)!==normalizeClubName(club.club))?.club||"Unknown"}**`:""}\nWould set: **${club.club} = ${role}**\n\n🧪 Preview only. No Match ID changed.`);return true;
  }
  if(["mark_failed","mark_success","restore_match"].includes(intent.intent)){
    const p=previewStatusIntent(intent);if(p.error){await message.reply(`${source}\nAction: **${intent.intent.toUpperCase()} — DRY RUN**\n\n❌ ${p.error}\n\n🧪 No production data changed.`);return true;}
    const next=intent.intent==="mark_failed"?"FAILED":intent.intent==="mark_success"?"SUCCESS":"PENDING";await message.reply(`${source}\nAction: **${intent.intent.toUpperCase()} — DRY RUN**\nMatch ID: **${p.plan.id}**\nClub: **${p.club.club}**\nCurrent status: **${String(p.club.status||"pending").toUpperCase()}**\nWould become: **${next}**\n\n🧪 **Preview only. Status was not changed.**`);return true;
  }
  if(intent.intent==="start_event"){
    session.testEventType=intent.event_type;session.testEventStartedAt=Date.now();
    const detail=intent.event_type==="Grease Lightning"?"Duration: 5 days\nPreparation: NONE\nKO: 2 hours\nCooling Down: NONE":"Duration: 7 days\nPreparation: 6 hours\nKO: 2 hours\nCooling Down: NONE";
    await message.reply(`${source}\n🧪 **TEST MODE — EVENT SIMULATION ACTIVE**\nEvent: **${intent.event_type}**\n${detail}\n\nThis is test context only. No production event was started.`);return true;
  }
  if(intent.intent==="end_event"){
    const old=session.testEventType||"None";session.testEventType=null;session.testEventStartedAt=null;await message.reply(`${source}\n🧪 **TEST EVENT ENDED**\nPrevious simulated event: **${old}**\nNo production event was changed.`);return true;
  }
  if(intent.intent==="start_timer"){
    if(!intent.match_id && session.testMatchId) intent.match_id=session.testMatchId;
    const spec=getSimulatedTimerSpec(intent,session);if(spec.blocked){await message.reply(`${source}\n🧪 **TIMER SIMULATION**\n❌ ${spec.reason}\nNo actual timer created.`);return true;}
    const start=Date.now(),end=start+spec.hours*3600000;session.lastSimulatedTimer={type:intent.timer_type,hours:spec.hours,matchId:intent.match_id||null,startAt:start,endAt:end,event:spec.event};
    await message.reply(`${source}\n${formatSimulatedProductionTimer(spec,intent,session,end)}`);return true;
  }
  if(intent.intent==="show_timers"){
    if(session.lastSimulatedTimer){const t=session.lastSimulatedTimer;await message.reply(`${source}\nAction: **SHOW TIMERS — TEST**\n\nSimulated timer: **${t.type.toUpperCase()}** • ${t.hours}h • ${t.event} • Match ID ${t.matchId||"None"}\nSimulated end: <t:${Math.floor(t.endAt/1000)}:R>\n\n🧪 Production timers were not changed.`);return true;}
    const active=(activeFowTimers||[]).filter(t=>String(t.guildId||"")===String(message.guildId||"")&&String(t.channelId||t.destinationId||"")===String(message.channelId||"")&&!['completed','cancelled'].includes(String(t.status||"").toLowerCase()));const lines=active.length?active.slice(0,25).map((t,i)=>`${i+1}. ${t.matchId||t.id||"Timer"} — ${String(t.type||t.timerType||"timer")}`).join("\n"):"No active timer in this channel/thread.";await message.reply(`${source}\nAction: **SHOW TIMERS — TEST READ**\n\n${lines}\n\n🧪 No production data changed.`);return true;
  }
  if(intent.intent==="show_event_stats"){
    if(session.testEventType){await message.reply(`${source}\nAction: **SHOW EVENT STATS — TEST CONTEXT**\n\nSimulated event: **${session.testEventType}**\nStatus: **SIMULATED ACTIVE**\nStarted: <t:${Math.floor((session.testEventStartedAt||Date.now())/1000)}:R>\n\n🧪 This is not the production event.`);return true;}
    const ev=getActiveEvent();if(!ev){await message.reply(`${source}\nAction: **SHOW EVENT STATS — TEST READ**\n\nNo active production event.\n\n🧪 No production data changed.`);return true;}const stats=getEventStats(ev);await message.reply(`${source}\nAction: **SHOW EVENT STATS — TEST READ**\n\nActive production event: **${ev.name||ev.type||ev.id}**${stats?`\nSUCCESS: **${stats.success??0}**\nFAILED: **${stats.failed??0}**\nPENDING: **${stats.pending??0}**\nEXCLUDED: **${stats.excluded??0}**`:""}\n\n🧪 Read only.`);return true;
  }
  return false;
}


// ============================================================
// FoW NATURAL-LANGUAGE CONTROL — PRODUCTION / v71
// ============================================================
// LOCAL parser first; Gemini fallback only for FoW-related instructions.
// Existing slash commands remain available as a safety/backup interface.
const naturalControlSessions = new Map();

// ============================================================
// HS PHASE 6 — AI CONTROL ROOM DRAFTS
// Preview/confirmation state only.
// Phase 6.0A MUST NOT create Match IDs or write production data.
// ============================================================
const hsControlRoomDrafts = new Map();
const HS_CONTROL_ROOM_DRAFT_TTL_MS = 15 * 60 * 1000;

function cleanupHsControlRoomDrafts() {
  const now = Date.now();
  for (const [id, draft] of hsControlRoomDrafts.entries()) {
    const touched = Number(draft?.updatedAt || draft?.createdAt || 0);
    if (!touched || now - touched > HS_CONTROL_ROOM_DRAFT_TTL_MS) {
      hsControlRoomDrafts.delete(id);
    }
  }
}

const HS_TEST_DRY_RUN_CHANNEL_ID = "1550513884585005076";
function parseHsControlRoomDestination(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(test channel|test room|dry[ -]?run)\b/i.test(value)) return { key: "test", label: "TEST DRY-RUN", channelId: HS_TEST_DRY_RUN_CHANNEL_ID };

  if (/\bhigh(?:\s+set)?(?:\s+war\s+control)?\b/i.test(value)) {
    return {
      key: "high",
      label: "HIGH SET WAR CONTROL",
      channelId: CHATGPT_BRIDGE_MATCH_HIGH_CHANNEL_ID
    };
  }

  if (/\bmid(?:\s+set)?(?:\s+war\s+control)?\b/i.test(value)) {
    return {
      key: "mid",
      label: "MID SET WAR CONTROL",
      channelId: CHATGPT_BRIDGE_MATCH_MID_CHANNEL_ID
    };
  }

  if (/\blow(?:\s+set)?(?:\s+war\s+control)?\b/i.test(value)) {
    return {
      key: "low",
      label: "LOW SET WAR CONTROL",
      channelId: CHATGPT_BRIDGE_MATCH_LOW_CHANNEL_ID
    };
  }

  if (
    /\badditional(?:\s+war\s+control)?\b/i.test(value) ||
    /\bcross[ -]?range(?:\s+war\s+control)?\b/i.test(value)
  ) {
    return {
      key: "additional",
      label: "ADDITIONAL / CROSS-RANGE WAR CONTROL",
      channelId: CHATGPT_BRIDGE_MATCH_ADDITIONAL_CHANNEL_ID
    };
  }

  return null;
}

// ============================================================
// HS PHASE 6.1C — CONVERSATIONAL DESTINATION BRIDGE
// Reuses existing Phase 6 draft + confirmation workflow.
// Does NOT create Match ID or send production matchmaking.
// ============================================================
function prepareHsConversationalDestination(message, destinationKey) {
  cleanupHsControlRoomDrafts();

  const hsDestination =
    parseHsControlRoomDestination(String(destinationKey || ""));

  if (!hsDestination) {
    return {
      ok: false,
      response:
        `❌ Destination not recognized.\n\n` +
        `Use **high**, **mid**, **low**, **additional**, or **test**.`,
      components: []
    };
  }

  const latestDraft =
    [...hsControlRoomDrafts.values()]
      .filter(draft =>
        draft?.userId === message.author.id &&
        draft?.guildId === message.guildId &&
        draft?.sourceChannelId === message.channelId &&
        draft?.previewResult?.pairs?.length
      )
      .sort(
        (a, b) =>
          Number(b.updatedAt || b.createdAt || 0) -
          Number(a.updatedAt || a.createdAt || 0)
      )[0];

  if (!latestDraft) {
    return {
      ok: false,
      response:
        `⚠️ No active matchmaking preview found.\n\n` +
        `Create a matchmaking preview first, then choose the destination.`,
      components: []
    };
  }

  latestDraft.destinationKey = hsDestination.key;
  latestDraft.destinationLabel = hsDestination.label;
  latestDraft.destinationChannelId = hsDestination.channelId;
  latestDraft.updatedAt = Date.now();

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`hscr_confirm:${latestDraft.id}`)
        .setLabel("CONFIRM & SEND")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`hscr_cancel:${latestDraft.id}`)
        .setLabel("CANCEL")
        .setStyle(ButtonStyle.Danger)
    )
  ];

  return {
    ok: true,
    draft: latestDraft,
    destination: hsDestination,
    components,
    response:
      `🎛️ **Phase 6 — AI Control Room**\n\n` +
      `⚔️ Stored preview: **${latestDraft.minElo} - ${latestDraft.maxElo}**\n` +
      `🤝 Pairs: **${latestDraft.previewResult.pairs.length}**\n` +
      `📤 Destination: **${hsDestination.label}**\n\n` +
      `Review the destination, then use the button below.\n\n` +
      `🔒 No Match ID created yet. No database changes.`
  };
}

// ============================================================
// HS PHASE 6.1D — CONVERSATIONAL EVENT TRANSITION CONFIRMATION
// Normal is represented by no active special event.
// Reuses existing eventStore persistence; timer/War Monitor logic is untouched.
// ============================================================
const hsEventTransitionDrafts = new Map();
const HS_EVENT_TRANSITION_TTL_MS = 10 * 60 * 1000;

function normalizeHsEventMode(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  if (/^normal$/.test(v)) return "normal";
  if (/^lightning$/.test(v)) return "lightning";
  if (/^(?:grease|grease lightning)$/.test(v)) return "grease";
  return null;
}

function hsEventModeLabel(mode) {
  if (mode === "grease") return "GREASE LIGHTNING";
  if (mode === "lightning") return "LIGHTNING";
  return "NORMAL";
}

function cleanupHsEventTransitionDrafts() {
  const now = Date.now();
  for (const [id, draft] of hsEventTransitionDrafts.entries()) {
    if (!draft || now - Number(draft.updatedAt || draft.createdAt || 0) > HS_EVENT_TRANSITION_TTL_MS) {
      hsEventTransitionDrafts.delete(id);
    }
  }
}

function prepareHsEventTransition(message, intent) {
  cleanupHsEventTransitionDrafts();
  autoExpireActiveEvent();

  const currentMode = getNaturalControlOperationalMode();
  const requestedFrom = normalizeHsEventMode(intent?.from_event);
  const requestedTo = normalizeHsEventMode(intent?.to_event || intent?.event_type);

  if (!requestedTo) {
    return { ok:false, response:"❓ **HS needs clarification**\n\nWhich event should start next: **Normal**, **Lightning**, or **Grease Lightning**?\n\n🔒 No production data changed.", components:[] };
  }

  if (requestedFrom && requestedFrom !== currentMode) {
    return {
      ok:false,
      response:`⚠️ **Event state changed / mismatch**\n\nCurrent production mode: **${hsEventModeLabel(currentMode)}**\nRequested transition starts from: **${hsEventModeLabel(requestedFrom)}**\n\nPlease send the event transition again using the current mode.\n\n🔒 No production data changed.`,
      components:[]
    };
  }

  if (requestedTo === currentMode) {
    return { ok:false, response:`ℹ️ **${hsEventModeLabel(currentMode)}** is already the current event mode.\n\n🔒 No production data changed.`, components:[] };
  }

  const id = `HSEV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
  const draft = {
    id,
    userId:String(message.author.id),
    guildId:String(message.guildId || ""),
    channelId:String(message.channelId || ""),
    fromMode:currentMode,
    toMode:requestedTo,
    createdAt:Date.now(),
    updatedAt:Date.now()
  };
  hsEventTransitionDrafts.set(id,draft);

  const components=[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hsev_confirm:${id}`).setLabel("CONFIRM EVENT CHANGE").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`hsev_cancel:${id}`).setLabel("CANCEL").setStyle(ButtonStyle.Danger)
  )];

  return {
    ok:true,draft,components,
    response:
      `⚡ **HS Event Control — Confirmation Required**\n\n` +
      `Current: **${hsEventModeLabel(currentMode)}**\n` +
      `Requested:\n1. Close **${hsEventModeLabel(currentMode)}**\n2. Start **${hsEventModeLabel(requestedTo)}**\n\n` +
      `⚠️ This will change the active production event.\n` +
      `Timer and War Monitor logic will not be modified by this action.\n\n` +
      `🔒 No production data changed yet.`
  };
}

async function applyHsEventTransition(draft, userId) {
  autoExpireActiveEvent();
  const currentMode=getNaturalControlOperationalMode();
  if (currentMode !== draft.fromMode) {
    return {ok:false,message:`❌ Event mode changed before confirmation. Current mode is **${hsEventModeLabel(currentMode)}**. Nothing was changed.`};
  }

  const ended=getActiveEvent();
  let endedSummary=null;
  if (ended) {
    endedSummary=buildEventSummary(ended);
    endedSummary.completedAt=Date.now();
    eventStore.summaries.push(endedSummary);
    eventStore.active=null;
  }

  if (draft.toMode !== "normal") {
    const now=Date.now();
    const days=eventDurationDays(draft.toMode);
    eventStore.active={
      id:`EV${now.toString(36).toUpperCase()}`,
      type:draft.toMode,
      name:draft.toMode==="grease"?"Grease Lightning":"Lightning",
      status:"active",
      startAt:now,
      endAt:now+days*86400000,
      createdBy:String(userId)
    };
  }

  await saveEventStoreNow();
  return {ok:true,ended,endedSummary,active:getActiveEvent(),toMode:draft.toMode};
}

const NATURAL_CONTROL_TTL_MS = 30 * 60 * 1000;

function cleanupNaturalControlSessions(){
  const now=Date.now();
  for(const [key,session] of naturalControlSessions){
    if(!session || now-Number(session.updatedAt||session.createdAt||0)>NATURAL_CONTROL_TTL_MS){
      naturalControlSessions.delete(key);
    }
  }
}

function getNaturalControlOperationalMode(){
  autoExpireActiveEvent();
  const ev=getActiveEvent();
  if(ev?.type==='grease') return 'grease';
  if(ev?.type==='lightning') return 'lightning';
  return 'normal';
}

function createNaturalMatchPlan(intent,message){
  const dry=dryRunMatchmakingFromIntent(intent);
  const pairs=Array.isArray(dry?.result?.pairs)?dry.result.pairs:[];
  const skippedKeys=new Set((dry.skipped||[]).map(c=>normalizeClubName(c.club)));
  const leaked=pairs.flatMap(p=>[p.a,p.b]).filter(Boolean).find(c=>skippedKeys.has(normalizeClubName(c.club)));
  if(leaked) throw new Error(`Skipped club leaked into matchmaking: ${leaked.club}`);

  const matchId=nextMatchId();
  const pairedClubMap=new Map();
  pairs.forEach((pair,pairIndex)=>{
    let winner=pair.winner||null, loser=pair.loser||null;
    if(!winner||!loser){
      const aElo=Number(pair.a?.elo)||0,bElo=Number(pair.b?.elo)||0;
      winner=bElo>aElo?pair.b:pair.a; loser=winner===pair.a?pair.b:pair.a;
    }
    const wk=winner?.club?normalizeClubName(winner.club):null;
    const lk=loser?.club?normalizeClubName(loser.club):null;
    for(const item of [pair.a,pair.b]){
      if(!item?.club) continue;
      const k=normalizeClubName(item.club);
      pairedClubMap.set(k,{club:item.club,president:item.president||'',elo:Number(item.elo)||0,status:'pending',failedAt:null,failedBy:null,matchRole:wk===k?'win':lk===k?'lose':null,pairNo:pairIndex+1});
    }
  });
  const plan={id:matchId,guildId:message.guildId,channelId:message.channelId,min:dry.min,max:dry.max,clubs:[...pairedClubMap.values()].sort((a,b)=>Number(b.elo)-Number(a.elo)),pairCount:pairs.length,createdAt:Date.now(),createdBy:message.author.id,eventId:getActiveEvent()?.id||null};
  matchPlans.set(matchId,plan);
  return {dry,plan,matchId};
}

async function saveNaturalMatchPlan(result){
  await saveMatchPlansNow();
  return result;
}

function latestPlanForNaturalSession(message,session){
  if(session.lastMatchId){
    const p=getMatchPlan(session.lastMatchId);
    if(p && (!p.guildId || String(p.guildId)===String(message.guildId))) return p;
  }
  return [...matchPlans.values()].filter(p=>(!p.guildId||String(p.guildId)===String(message.guildId))&&(!p.channelId||String(p.channelId)===String(message.channelId))).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0))[0]||null;
}

async function handleNaturalControlMessage(message,session){
  let intent=parseLocalAiCommand(message.content);
  if(!intent){
    if(!looksLikeFowOperationalInstruction(message.content)) return false;
    intent=await parseGeminiCommandInstruction(message.content);
  }
  if(!intent){await message.reply('❓ I could not understand that FoW/war instruction.');return true;}
  session.updatedAt=Date.now();
  if(intent.intent==='gemini_error'){
    const quota=/429|quota|rate.?limit/i.test(intent.error||'');
    await message.reply(quota?'⚠️ Gemini fallback quota/rate limit reached. LOCAL commands still work.':'⚠️ Gemini fallback is unavailable. LOCAL commands still work.');
    return true;
  }
  const source=`Parser: **${intent.parser}** • AI quota: **${intent.parser==='LOCAL'?'NO':'YES'}**`;

  if(intent.intent==='matchmaking'){
    if(Number(intent.min_elo)<=0||Number(intent.max_elo)<=0||Number(intent.min_elo)>Number(intent.max_elo)){await message.reply('❌ Invalid ELO range.');return true;}
    const created=await saveNaturalMatchPlan(createNaturalMatchPlan(intent,message));
    session.lastMatchId=created.matchId;
    const warns=[];
    if(created.dry.unresolvedSkip?.length) warns.push(`⚠️ Skip not resolved: ${created.dry.unresolvedSkip.join(', ')}`);
    if(created.dry.unresolvedForced?.length) warns.push(`⚠️ Forced rule unresolved/no valid opposite within ${MATCHMAKING_MAX_GAP}: ${created.dry.unresolvedForced.join(', ')}`);
    await message.reply(`${source}\n✅ **MATCHMAKING CREATED**\n🆔 Match ID: **${created.matchId}**${warns.length?'\n'+warns.join('\n'):''}`);
    const out=formatMatchmakingOutput(created.dry.result,created.dry.min,created.dry.max,created.dry.skipped,created.matchId);
    for(const chunk of splitDiscordText(out,1900)) await message.channel.send(chunk);
    return true;
  }

  if(intent.intent==='set_must_win'||intent.intent==='set_must_lose'){
    const club=resolveNaturalClubToken(intent.club,leaderboardData);
    if(!club){await message.reply(`${source}\n❌ Could not uniquely resolve **${intent.club}**.`);return true;}
    const plans=findPlansContainingClub(club,message.guildId).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
    const plan=plans[0]; if(!plan){await message.reply(`${source}\n❌ ${club.club} is not inside a saved Match ID.`);return true;}
    const pair=getPairFromPlan(plan,club.club); if(!pair||pair.pair.length<2){await message.reply(`${source}\n❌ Could not resolve pair for ${club.club}.`);return true;}
    const target=pair.pair.find(c=>normalizeClubName(c.club)===normalizeClubName(club.club));
    const opponent=pair.pair.find(c=>normalizeClubName(c.club)!==normalizeClubName(club.club));
    if(intent.intent==='set_must_win'){target.matchRole='win';opponent.matchRole='lose';}else{target.matchRole='lose';opponent.matchRole='win';}
    plan.updatedAt=Date.now();plan.updatedBy=message.author.id;matchPlans.set(plan.id,plan);await saveMatchPlansNow();session.lastMatchId=plan.id;
    await message.reply(`${source}\n✅ **${club.club}** set to **${intent.intent==='set_must_win'?'MUST WIN':'MUST LOSE'}** in **${plan.id}**.\nOpponent: **${opponent.club}**`);return true;
  }

  if(intent.intent==='change_match'){
    const p=previewChangeMatch(intent,message.guildId);
    if(p.error){await message.reply(`${source}\n❌ ${p.error}`);return true;}
    await message.reply(`${source}\n⚠️ **CHANGE MATCH REQUIRES INTERACTIVE EDIT**\nResolved request: **${p.target.club}** → opponent **${p.replacement.club}** in **${p.plan.id}**.\nUse **/edit_matchmaking** for this saved Match ID so both affected pairs are repaired safely.`);return true;
  }

  if(['mark_failed','restore_match','mark_success'].includes(intent.intent)){
    const p=previewStatusIntent(intent); if(p.error){await message.reply(`${source}\n❌ ${p.error}`);return true;}
    if(p.plan.guildId&&String(p.plan.guildId)!==String(message.guildId)){await message.reply('❌ Match ID belongs to another server.');return true;}
    if(intent.intent==='mark_success'){
      const pair=getPairFromPlan(p.plan,p.club.club); if(!pair?.pairNo){await message.reply(`${source}\n❌ Could not resolve pair for ${p.club.club}.`);return true;}
      const res=await applyMatchSuccessPairs(p.plan.id,new Set([pair.pairNo]),message.author.id);
      if(!res.ok){await message.reply(`${source}\nℹ️ Pair is not eligible for SUCCESS (it may already be success or contain FAILED/EXCLUDED club).`);return true;}
      session.lastMatchId=p.plan.id;
      await message.reply(`${source}\n✅ **MATCH SUCCESS** — ${p.plan.id}\nPair ${pair.pairNo} marked SUCCESS: **${pair.pair.map(c=>c.club).join(' vs ')}**`);return true;
    }
    const stored=p.plan.clubs.find(c=>normalizeClubName(c.club)===normalizeClubName(p.club.club));
    if(intent.intent==='mark_failed'){
      stored.status='failed';stored.failedAt=Date.now();stored.failedBy=message.author.id;
    }else{
      stored.status='pending';stored.failedAt=null;stored.failedBy=null;
    }
    p.plan.updatedAt=Date.now();p.plan.updatedBy=message.author.id;matchPlans.set(p.plan.id,p.plan);await saveMatchPlansNow();session.lastMatchId=p.plan.id;
    await message.reply(`${source}\n✅ **${stored.club}** → **${intent.intent==='mark_failed'?'FAILED':'PENDING / RESTORED'}** in **${p.plan.id}**.`);return true;
  }

  if(intent.intent==='start_event'){
    autoExpireActiveEvent(); if(getActiveEvent()){await message.reply(`${source}\n❌ Event **${getActiveEvent().name}** is already active.`);return true;}
    const type=intent.event_type==='Grease Lightning'?'grease':'lightning';const days=eventDurationDays(type);const now=Date.now();
    eventStore.active={id:`EV${now.toString(36).toUpperCase()}`,type,name:type==='grease'?'Grease Lightning':'Lightning',status:'active',startAt:now,endAt:now+days*86400000,createdBy:message.author.id};await saveEventStoreNow();
    await message.reply(`${source}\n⚡ **EVENT STARTED**\nEvent: **${eventStore.active.name}**\nDuration: **${days} days**\n${type==='grease'?'Preparation: **None**\nKO: **2 hours**':'Preparation: **6 hours**\nKO: **2 hours**'}`);return true;
  }

  if(intent.intent==='end_event'){
    const ev=getActiveEvent();if(!ev){await message.reply(`${source}\nℹ️ No active event to end.`);return true;}
    const summary=buildEventSummary(ev);summary.completedAt=Date.now();eventStore.summaries.push(summary);eventStore.active=null;await saveEventStoreNow();
    await message.reply(`${source}\n🏁 **EVENT ENDED — ${ev.name.toUpperCase()}**\n✅ Success: **${summary.success}** • ❌ Failed: **${summary.failed}** • ⏳ Pending: **${summary.pending}**\n📊 Success Rate: **${Number(summary.successRate).toFixed(1)}%**`);return true;
  }

  if(intent.intent==='show_event_stats'){
    autoExpireActiveEvent();const ev=getActiveEvent();if(!ev){await message.reply(`${source}\nℹ️ No active event.`);return true;}
    await message.reply(`${source}\n${formatEventStats(ev)}`);return true;
  }

  if(intent.intent==='show_timers'){
    const timers=(activeFowTimers||[]).filter(t=>String(t.guildId||'')===String(message.guildId||'')&&String(t.channelId||t.destinationId||'')===String(message.channelId||'')&&!['completed','cancelled'].includes(String(t.status||'').toLowerCase()));
    if(!timers.length){await message.reply(`${source}\nℹ️ No active FoW timer in this channel/thread.`);return true;}
    const lines=timers.map((t,i)=>{const rem=Math.max(0,Number(t.endAt)-Date.now());const h=Math.floor(rem/3600000),m=Math.floor((rem%3600000)/60000);return `${i+1}. **${getFowTimerCancelLabel(t)}**${t.matchId?` • ${t.matchId}`:''} — **${h}h ${m}m** remaining`;});
    await message.reply(`${source}\n⏱️ **ACTIVE TIMERS**\n\n${lines.join('\n')}`);return true;
  }

  if(intent.intent==='start_timer'){
    const planId=normalizeMatchId(intent.match_id||session.lastMatchId||'');
    const plan=planId?getMatchPlan(planId):latestPlanForNaturalSession(message,session);
    if(!plan){await message.reply(`${source}\n❌ No Match ID context found. Include a Match ID once, e.g. **KO timer start for HS021**.`);return true;}
    if(plan.guildId&&String(plan.guildId)!==String(message.guildId)){await message.reply('❌ Match ID belongs to another server.');return true;}
    session.lastMatchId=plan.id;
    const mode=getNaturalControlOperationalMode();
    let type='war_done',hours=2;
    if(intent.timer_type==='push'){
      if(mode==='grease'){await message.reply(`${source}\n❌ Grease Lightning has no preparation timer.`);return true;}
      type='push';hours=mode==='lightning'?6:(intent.requested_hours||12);
    }else if(intent.timer_type==='war_done'){
      type='war_done';hours=(mode==='grease'||mode==='lightning')?2:14;
    }else if(intent.timer_type==='ko'){
      type='war_done';hours=2;
    }else if(intent.timer_type==='cooling'){
      if(mode!=='normal'){await message.reply(`${source}\n❌ ${getOperationalModeLabel(mode)} does not use the Normal cooling-down timer.`);return true;}
      type='war_done';hours=12;
    }
    const elos=getMatchPlanActiveClubs(plan).map(c=>Number(c.elo)||0);
    const pseudo={user:{id:message.author.id},channelId:message.channelId,guildId:message.guildId};
    const setup=createFowTimerSetupSession(pseudo,type,hours,elos.length?Math.min(...elos):0,elos.length?Math.max(...elos):0,null,null,null,plan);
    applyOperationalModeToTimerSession(setup,mode,plan);
    if(!setup.clubs.length){await deleteFowTimerSetupSessionPersistent(setup.id);await message.reply(`${source}\n❌ ${plan.id} has no active clubs for this timer.`);return true;}
    await message.reply(`${source}\n✅ Timer setup prepared from **${plan.id}**. Review the clubs below and press the existing **START TIMER** button to create the real production timer.`);
    await message.channel.send(buildFowTimerSetupView(setup));
    return true;
  }

  if(intent.intent==='create_test_match_id'){
    await message.reply(`${source}\nℹ️ Test Match IDs are disabled in production. Natural matchmaking automatically creates a real **HSxxx** Match ID.`);return true;
  }
  return false;
}

const commands = [

  new SlashCommandBuilder()
    .setName(
      "leaderboard"
    )
    .setDescription(
      "Show FoW ELO leaderboard"
    ),

  new SlashCommandBuilder()
    .setName(
      "download"
    )
    .setDescription(
      "Download full FoW ELO leaderboard"
    ),

  new SlashCommandBuilder()
    .setName(
      "derby"
    )
    .setDescription(
      "Download full Derby ELO list"
    ),

  new SlashCommandBuilder()
    .setName(
      "derby_leaderboard"
    )
    .setDescription(
      "Show leaderboard for Derby clubs only"
    ),

  new SlashCommandBuilder()
    .setName(
      "derby_add_club"
    )
    .setDescription(
      "Interactively add one or more clubs to the Derby list"
    ),

  new SlashCommandBuilder()
    .setName(
      "derby_remove_club"
    )
    .setDescription(
      "Interactively remove one or more clubs from the Derby list"
    ),

  new SlashCommandBuilder()
    .setName(
      "download_elo"
    )
    .setDescription(
      "Download clubs within a specific ELO range"
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "min"
          )
          .setDescription(
            "Minimum ELO"
          )
          .setRequired(
            true
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "max"
          )
          .setDescription(
            "Maximum ELO"
          )
          .setRequired(
            true
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "add_club"
    )
    .setDescription(
      "Add new club to FoW ELO database"
    )
    .addStringOption(
      option =>
        option
          .setName(
            "club"
          )
          .setDescription(
            "Club name"
          )
          .setRequired(
            true
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "president"
          )
          .setDescription(
            "President name"
          )
          .setRequired(
            true
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "elo"
          )
          .setDescription(
            "Current ELO"
          )
          .setRequired(
            true
          )
          .setMinValue(
            1
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "edit_club"
    )
    .setDescription(
      "Edit a club name or President / Pusher"
    )
    .addStringOption(
      option =>
        option
          .setName(
            "type"
          )
          .setDescription(
            "Choose what you want to edit"
          )
          .setRequired(
            true
          )
          .addChoices(
            {
              name: "Club Name",
              value: "club"
            },
            {
              name: "President / Pusher",
              value: "pusher"
            }
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "club"
          )
          .setDescription(
            "Club to edit"
          )
          .setRequired(
            true
          )
          .setAutocomplete(
            true
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "new_value"
          )
          .setDescription(
            "New club name or new President / Pusher name"
          )
          .setRequired(
            true
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "delete_club"
    )
    .setDescription(
      "Interactively delete a club from the FoW ELO database"
    ),

  new SlashCommandBuilder()
    .setName(
      "test_timer"
    )
    .setDescription(
      "Test a War Start or War End timer notification"
    )
    .addStringOption(
      option =>
        option
          .setName(
            "notification"
          )
          .setDescription(
            "Choose the notification to test"
          )
          .setRequired(
            true
          )
          .addChoices(
            {
              name: "⚔️ War Start",
              value: "start"
            },
            {
              name: "🏁 War End",
              value: "end"
            }
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "minutes"
          )
          .setDescription(
            "Send the test notification after this many minutes"
          )
          .setRequired(
            true
          )
          .setMinValue(
            1
          )
          .setMaxValue(
            1440
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "sync_database"
    )
    .setDescription(
      "Sync an ELO database file from your PC to the bot"
    )
    .addAttachmentOption(
      option =>
        option
          .setName(
            "file"
          )
          .setDescription(
            "Upload your elo_database.json file"
          )
          .setRequired(
            true
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "sync_github"
    )
    .setDescription(
      "Manually sync the latest ELO database through GitHub API"
    ),

  new SlashCommandBuilder()
    .setName(
      "push"
    )
    .setDescription(
      "Start a FoW push preparation timer"
    )
    .addStringOption(
      option =>
        option
          .setName(
            "preparation"
          )
          .setDescription(
            "Preparation timer duration"
          )
          .setRequired(
            true
          )
          .addChoices(
            {
              name:
                "⏳ 6 Hours Preparation",
              value:
                "6"
            },
            {
              name:
                "⏳ 12 Hours Preparation",
              value:
                "12"
            }
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "min_elo"
          )
          .setDescription(
            "Minimum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "max_elo"
          )
          .setDescription(
            "Maximum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "match_id"
          )
          .setDescription(
            "Use clubs from a saved matchmaking ID, e.g. HS001"
          )
          .setRequired(
            false
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "push_test"
    )
    .setDescription(
      "Test FoW push timer using a manual duration in minutes"
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "minutes"
          )
          .setDescription(
            "Push preparation duration in minutes"
          )
          .setRequired(
            true
          )
          .setMinValue(
            1
          )
          .setMaxValue(
            1440
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "min_elo"
          )
          .setDescription(
            "Minimum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "max_elo"
          )
          .setDescription(
            "Maximum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "match_id"
          )
          .setDescription(
            "Use clubs from a saved matchmaking ID, e.g. HS001"
          )
          .setRequired(
            false
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "push_manual"
    )
    .setDescription("Start FoW push preparation using manual XXh XXmin duration")
    .addStringOption(option => option.setName("duration").setDescription("e.g. 06h 30min; maximum 12h 00min").setRequired(true))
    .addIntegerOption(
      option =>
        option
          .setName(
            "min_elo"
          )
          .setDescription(
            "Minimum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "max_elo"
          )
          .setDescription(
            "Maximum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "match_id"
          )
          .setDescription(
            "Use clubs from a saved matchmaking ID, e.g. HS001"
          )
          .setRequired(
            false
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "war_done"
    )
    .setDescription(
      "Start timer after the war is completed"
    )
    .addStringOption(
      option =>
        option
          .setName(
            "timer"
          )
          .setDescription(
            "Select KO or KO + Cooling Down timer"
          )
          .setRequired(
            true
          )
          .addChoices(
            {
              name:
                "🥊 2 Hours KO Timer",
              value:
                "2"
            },
            {
              name:
                "❄️🥊 14 Hours KO + Cooling Down",
              value:
                "14"
            }
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "min_elo"
          )
          .setDescription(
            "Minimum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "max_elo"
          )
          .setDescription(
            "Maximum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "match_id"
          )
          .setDescription(
            "Use clubs from a saved matchmaking ID, e.g. HS001"
          )
          .setRequired(
            false
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "war_done_manual"
    )
    .setDescription(
      "Start manual timer after the war is completed"
    )
    .addStringOption(
      option =>
        option
          .setName(
            "timer"
          )
          .setDescription(
            "Select KO or KO + Cooling Down timer"
          )
          .setRequired(
            true
          )
          .addChoices(
            {
              name:
                "🥊 KO Timer",
              value:
                "ko"
            },
            {
              name:
                "❄️🥊 KO + Cooling Down",
              value:
                "ko_cooling"
            }
          )
    )
    .addStringOption(option => option.setName("duration").setDescription("XXh XXmin, e.g. 02h 30min").setRequired(true))
    .addIntegerOption(
      option =>
        option
          .setName(
            "min_elo"
          )
          .setDescription(
            "Minimum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "max_elo"
          )
          .setDescription(
            "Maximum ELO for club selection"
          )
          .setRequired(
            false
          )
    )
    .addStringOption(
      option =>
        option
          .setName(
            "match_id"
          )
          .setDescription(
            "Use clubs from a saved matchmaking ID, e.g. HS001"
          )
          .setRequired(
            false
          )
    ),

  new SlashCommandBuilder()
    .setName(
      "cancel_matchmaking"
    )
    .setDescription(
      "Choose and remove one saved Match ID"
    ),

  new SlashCommandBuilder()
    .setName(
      "match_fail"
    )
    .setDescription(
      "Mark one or more clubs as failed for a Match ID"
    )
    .addStringOption(
      option =>
        option
          .setName("match_id")
          .setDescription("Match ID, e.g. HS001")
          .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName(
      "match_restore"
    )
    .setDescription(
      "Restore failed clubs to a Match ID"
    )
    .addStringOption(
      option =>
        option
          .setName("match_id")
          .setDescription("Match ID, e.g. HS001")
          .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName(
      "cancel_timer"
    )
    .setDescription(
      "Cancel one active FoW timer"
    ),

  new SlashCommandBuilder()
    .setName(
      "matchmaking"
    )
    .setDescription(
      "Create optimized FoW ELO matchmaking"
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "min_elo"
          )
          .setDescription(
            "Minimum ELO"
          )
          .setRequired(
            true
          )
          .setMinValue(
            1
          )
    )
    .addIntegerOption(
      option =>
        option
          .setName(
            "max_elo"
          )
          .setDescription(
            "Maximum ELO"
          )
          .setRequired(
            true
          )
          .setMinValue(
            1
          )
    )

].map(
  command =>
    command.toJSON()
).filter(command => ![
  "sync_database",
  "sync_github",
  "push_test",
  "test_timer"
].includes(command.name));

commands.push(
  new SlashCommandBuilder()
    .setName("control")
    .setDescription("Start, stop or check FoW natural-language control in this channel/thread")
    .addStringOption(option =>
      option.setName("action")
        .setDescription("Natural control action")
        .setRequired(true)
        .addChoices(
          { name: "Start", value: "start" },
          { name: "Stop", value: "stop" },
          { name: "Status", value: "status" }
        )
    )
    .toJSON(),
  new SlashCommandBuilder().setName("manual_matchmaking").setDescription("Create manual FoW matchmaking by paste list or club search").toJSON(),
  new SlashCommandBuilder().setName("war_monitor").setDescription("Start war monitoring and matchmaking isolation")
    .addStringOption(o=>o.setName("club").setDescription("Search by club name or president/pusher").setRequired(true).setAutocomplete(true))
    .addStringOption(o=>o.setName("event_type").setDescription("Event type").setRequired(true).addChoices(
      {name:"Normal",value:"normal"},{name:"Lightning",value:"lightning"},{name:"Grease",value:"grease"}
    ))
    .addStringOption(o=>o.setName("preparation_time").setDescription("Normal/Lightning only, format XXh XXm or XXh XXmin (e.g. 5h 30m)").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("war_status").setDescription("Show clubs currently isolated by war operations").toJSON(),
  new SlashCommandBuilder().setName("war_override").setDescription("Admin correction for a club war state")
    .addStringOption(o=>o.setName("club").setDescription("Club name").setRequired(true))
    .addStringOption(o=>o.setName("action").setDescription("New state").setRequired(true).addChoices(
      {name:"Available",value:"available"},{name:"War Active",value:"war_active"},{name:"KO Active",value:"ko_active"},{name:"Cooling Down",value:"cooling"}
    ))
    .addIntegerOption(o=>o.setName("minutes").setDescription("Cooling minutes (required for Cooling Down)").setRequired(false).setMinValue(1).setMaxValue(10080)).toJSON(),
  new SlashCommandBuilder().setName("edit_matchmaking").setDescription("Edit an existing Match ID")
    .addStringOption(o=>o.setName("match_id").setDescription("Match ID, e.g. HS001").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("bulk_add_club").setDescription("Add many clubs using Club Name, President, ELO format").toJSON(),
  new SlashCommandBuilder().setName("match_list").setDescription("Show saved Match IDs and their status").toJSON(),
  new SlashCommandBuilder().setName("timer_status").setDescription("Show active timers in this channel/thread").toJSON(),
  new SlashCommandBuilder().setName("isolation_status").setDescription("Show active, ending-soon and overdue club isolation timers").toJSON(),
  new SlashCommandBuilder().setName("isolation_override").setDescription("Master override: release selected clubs from all isolation").toJSON(),
  new SlashCommandBuilder().setName("ko_timer_start").setDescription("Start KO isolation timer from a saved Match ID")
    .addStringOption(o=>o.setName("match_id").setDescription("Saved Match ID, e.g. HS023").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("event_start").setDescription("Start master event context for matchmaking and war operations")
    .addStringOption(o=>o.setName("event_type").setDescription("Event type").setRequired(true).addChoices(
      {name:"Normal — 12h preparation",value:"normal"},
      {name:"Grease Lightning — 5 days",value:"grease"},
      {name:"Lightning — 7 days / 6h preparation",value:"lightning"}
    )).toJSON(),
  new SlashCommandBuilder().setName("event_status").setDescription("Show event, matchmaking, timers and War Monitor status").toJSON(),
  new SlashCommandBuilder().setName("event_stop").setDescription("Stop new matchmaking joining current event; active operations continue").toJSON(),
  new SlashCommandBuilder().setName("event_stats").setDescription("Show current event matchmaking statistics").toJSON(),
  new SlashCommandBuilder().setName("event_end").setDescription("Close current event after active operations complete").toJSON(),
  new SlashCommandBuilder().setName("match_success").setDescription("Mark one or more successful FoW pairs for a Match ID")
    .addStringOption(o=>o.setName("match_id").setDescription("Match ID, e.g. HS021").setRequired(true)).toJSON()
);
// Add operational mode option to production timer commands without changing existing required options.
for (const command of commands) {
  if (!["push", "push_manual", "war_done", "war_done_manual"].includes(command.name)) continue;
  command.options = command.options || [];
  command.options.push({
    type: 3,
    name: "mode",
    description: "Operational mode",
    required: false,
    choices: [
      { name: "Grease Lightning", value: "grease" },
      { name: "Lightning", value: "lightning" },
      { name: "Normal / Outside Event", value: "normal" },
      { name: "External / Non-Derby", value: "external" }
    ]
  });
}


async function restoreEloDatabaseFromSupabase() {
  if (!supabasePersistenceReady) return false;

  const remoteDatabase = await loadSupabaseState("elo_database");

  if (Array.isArray(remoteDatabase) && remoteDatabase.length > 0) {
    leaderboardData = cloneData(remoteDatabase);

    fs.writeFileSync(
      DATABASE_FILE,
      JSON.stringify(leaderboardData, null, 2),
      "utf8"
    );

    writeDefaultSnapshot(leaderboardData);

    console.log(
      `💾 FoW ELO database restored from Supabase: ${leaderboardData.length} clubs`
    );
    return true;
  }

  // First Supabase-enabled deployment: seed Supabase from the current
  // repository/live database. Future ELO writes will keep this snapshot current.
  queueSupabaseStateSave("elo_database", leaderboardData);
  const pending = supabaseStateWriteChains.get("elo_database");
  if (pending) await pending;

  console.log(
    `☁️ FoW ELO database seeded to Supabase: ${leaderboardData.length} clubs`
  );
  return false;
}

async function restoreDerbyConfigFromSupabase() {
  if (!supabasePersistenceReady) return false;

  const remoteConfig = await loadSupabaseState("derby_config");

  if (
    remoteConfig &&
    Array.isArray(remoteConfig.excludedClubs)
  ) {
    derbyExcludedClubs = remoteConfig.excludedClubs
      .map(name => String(name || "").trim())
      .filter(Boolean);

    fs.writeFileSync(
      DERBY_CONFIG_FILE,
      JSON.stringify(
        { excludedClubs: derbyExcludedClubs },
        null,
        2
      ),
      "utf8"
    );

    console.log(
      `💾 Derby configuration restored from Supabase: ${derbyExcludedClubs.length} excluded clubs`
    );
    return true;
  }

  queueSupabaseStateSave(
    "derby_config",
    { excludedClubs: [...derbyExcludedClubs] }
  );
  await flushSupabaseStateSave("derby_config");

  console.log(
    `☁️ Derby configuration seeded to Supabase: ${derbyExcludedClubs.length} excluded clubs`
  );
  return false;
}

async function restoreRuntimeStateFromSupabaseBeforeDiscordStart() {
  const connected = await initSupabasePersistence();
  if (!connected) return;

  // Supabase snapshots are authoritative across Hostinger redeploys.
  await restoreEloDatabaseFromSupabase();
  await restoreDerbyConfigFromSupabase();
  await restoreMatchPlansFromSupabase();
  await restoreEventStoreFromSupabase();
  await restoreWarOperationsFromSupabase();

  await restoreSupabaseRuntimeStateToLocalFiles();

  // Rehydrate all in-memory runtime structures using the bot's existing,
  // battle-tested JSON migration/validation logic.
  loadFowTimerSetupSessions();
  loadMatchmakingSessions();
  activeFowTimers = loadFowTimers();

  // Backward-compatible timer destination migration.
  for (const timer of activeFowTimers) {
    if (!timer.destinationId && timer.channelId) {
      timer.destinationId = timer.channelId;
    }
  }

  removeExpiredFowTimersOnStartup();

  console.log(`💾 Active FoW timers restored from Supabase: ${activeFowTimers.length}`);
  console.log(`💾 Timer setup sessions in memory: ${fowTimerSetupSessions.size}`);
  console.log(`💾 Matchmaking sessions in memory: ${matchmakingSessions.size}`);

  // Write cleaned/migrated snapshots back to Supabase.
  saveFowTimers();
  saveFowTimerSetupSessions();
  saveMatchmakingSessions();
}


// ============================================================
// CHATGPT ↔ FOW GITHUB BRIDGE (v81)
// ============================================================
// Public bridge repo is intentionally DATA-ONLY. No secrets are stored there.
// GitHub PUSH webhook mode: GitHub notifies this VPS when requests/*.json changes.
// No GitHub API polling or GitHub PAT is required. Request files are read from
// raw.githubusercontent.com at the exact pushed commit SHA. Idempotency/history
// remain in Supabase. Unknown request types are rejected. dry_run=true NEVER writes ELO.

const CHATGPT_BRIDGE_ENABLED = String(process.env.CHATGPT_BRIDGE_ENABLED ?? "true").toLowerCase() !== "false";
const CHATGPT_BRIDGE_OWNER = process.env.CHATGPT_BRIDGE_OWNER || "getsuga5546-cloud";
const CHATGPT_BRIDGE_REPO = process.env.CHATGPT_BRIDGE_REPO || "FoW-ChatGPT-Bridge";
const CHATGPT_BRIDGE_BRANCH = process.env.CHATGPT_BRIDGE_BRANCH || "main";
const CHATGPT_BRIDGE_MODE = String(process.env.CHATGPT_BRIDGE_MODE || "webhook").trim().toLowerCase();
const CHATGPT_BRIDGE_POLL_MS = Math.max(900000, Number(process.env.CHATGPT_BRIDGE_POLL_MS) || 900000);
const CHATGPT_BRIDGE_WEBHOOK_SECRET = String(process.env.CHATGPT_BRIDGE_WEBHOOK_SECRET || "");
const CHATGPT_READ_TOKEN = String(process.env.CHATGPT_READ_TOKEN || "");
const CHATGPT_BRIDGE_MAX_ITEMS = 100;
const CHATGPT_BRIDGE_PROCESSED_KEY = "chatgpt_bridge_processed_v1";
const CHATGPT_BRIDGE_ELO_HISTORY_KEY = "chatgpt_bridge_elo_history_v1";
// V80 production channel routing. Legacy bridge channel remains as fallback only.
const CHATGPT_BRIDGE_DISCORD_CHANNEL_ID = process.env.CHATGPT_BRIDGE_DISCORD_CHANNEL_ID || "1548858502427054100";
const CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID = process.env.CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID || "1548711491547562116";
const CHATGPT_BRIDGE_ELO_CHANNEL_ID = process.env.CHATGPT_BRIDGE_ELO_CHANNEL_ID || "1542082345413124107";
const CHATGPT_BRIDGE_MATCH_HIGH_CHANNEL_ID = process.env.CHATGPT_BRIDGE_MATCH_HIGH_CHANNEL_ID || "1542082045897875516";
const CHATGPT_BRIDGE_MATCH_MID_CHANNEL_ID = process.env.CHATGPT_BRIDGE_MATCH_MID_CHANNEL_ID || "1542082100281221162";
const CHATGPT_BRIDGE_MATCH_LOW_CHANNEL_ID = process.env.CHATGPT_BRIDGE_MATCH_LOW_CHANNEL_ID || "1542082163631980614";
const CHATGPT_BRIDGE_MATCH_ADDITIONAL_CHANNEL_ID = process.env.CHATGPT_BRIDGE_MATCH_ADDITIONAL_CHANNEL_ID || "1547256898699534376";


// ============================================================
// CHATGPT LIVE ELO SNAPSHOT PUBLISHER
// ============================================================
// Publishes a DATA-ONLY snapshot to:
//   FoW-ChatGPT-Bridge/live/elo.json
//
// This is intentionally separate from the HS-Elo-Bot GitHub sync.
// Failure here must never affect the production ELO database or Supabase.
async function publishChatgptEloSnapshot(reason = "elo database update") {
  try {
    if (!GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is not configured");
    }

    const clubs = getSortedLeaderboard();

    const snapshot = {
      schema_version: 1,
      source: "fow-production",
      generated_at: new Date().toISOString(),
      count: clubs.length,
      clubs
    };

    const repoFilePath = "live/elo.json";
    const encodedPath = encodeGitHubPath(repoFilePath);

    const getPath =
      `/repos/${encodeURIComponent(CHATGPT_BRIDGE_OWNER)}` +
      `/${encodeURIComponent(CHATGPT_BRIDGE_REPO)}` +
      `/contents/${encodedPath}` +
      `?ref=${encodeURIComponent(CHATGPT_BRIDGE_BRANCH)}`;

    let sha = null;

    try {
      const existing = await githubRequest("GET", getPath);
      sha = existing?.data?.sha || null;
    } catch (error) {
      if (error.statusCode !== 404) {
        throw error;
      }
    }

    const putPath =
      `/repos/${encodeURIComponent(CHATGPT_BRIDGE_OWNER)}` +
      `/${encodeURIComponent(CHATGPT_BRIDGE_REPO)}` +
      `/contents/${encodedPath}`;

    const body = {
      message: `Update live ELO snapshot - ${reason}`,
      content: Buffer.from(
        JSON.stringify(snapshot, null, 2),
        "utf8"
      ).toString("base64"),
      branch: CHATGPT_BRIDGE_BRANCH
    };

    if (sha) {
      body.sha = sha;
    }

    const result = await githubRequest("PUT", putPath, body);

    console.log(
      `🌉 ChatGPT live ELO snapshot published • ${snapshot.count} clubs`
    );

    return {
      ok: true,
      count: snapshot.count,
      commit:
        result?.data?.commit?.sha ||
        null
    };

  } catch (error) {
    console.error(
      "⚠️ ChatGPT live ELO snapshot publish failed:",
      error?.message || error
    );

    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

function bridgeMatchmakingBand(elo) {
  const value = Number(elo) || 0;
  if (value >= 5900) return "high";
  if (value >= 5600 && value <= 5899) return "mid";
  if (value >= 5200 && value <= 5599) return "low";
  return "additional";
}

function bridgeMatchmakingRoute(validPairs) {
  if (!Array.isArray(validPairs) || validPairs.length === 0) {
    return { key: "additional", label: "ADDITIONAL", channelId: CHATGPT_BRIDGE_MATCH_ADDITIONAL_CHANNEL_ID };
  }

  const pairBands = validPairs.map(pair => {
    const bandA = bridgeMatchmakingBand(pair?.a?.elo);
    const bandB = bridgeMatchmakingBand(pair?.b?.elo);
    return bandA === bandB ? bandA : "additional";
  });

  const unique = [...new Set(pairBands)];
  const key = unique.length === 1 ? unique[0] : "additional";
  if (key === "high") return { key, label: "HIGH SET (5900+)", channelId: CHATGPT_BRIDGE_MATCH_HIGH_CHANNEL_ID };
  if (key === "mid") return { key, label: "MID SET (5600-5899)", channelId: CHATGPT_BRIDGE_MATCH_MID_CHANNEL_ID };
  if (key === "low") return { key, label: "LOW SET (5200-5599)", channelId: CHATGPT_BRIDGE_MATCH_LOW_CHANNEL_ID };
  return { key: "additional", label: "ADDITIONAL / CROSS-RANGE", channelId: CHATGPT_BRIDGE_MATCH_ADDITIONAL_CHANNEL_ID };
}

// v81.4.3 — ChatGPT Bridge routing is authoritative when an explicit target is supplied.
// Automatic ELO routing remains only as a safe fallback for older payloads.
function bridgeMatchmakingTargetRoute(payload, validPairs) {
  const raw = String(payload?.target ?? payload?.target_channel ?? "").trim().toLowerCase();
  const aliases = {
    high: "high", "high_set": "high", "high set": "high",
    mid: "mid", "mid_set": "mid", "mid set": "mid",
    low: "low", "low_set": "low", "low set": "low",
    additional: "additional", "cross-range": "additional", "cross_range": "additional", "cross range": "additional"
  };
  // v81.4.3.1 — ChatGPT Bridge matchmaking must explicitly declare the target set.
  // Do not silently auto-route by ELO because ChatGPT may intentionally place a
  // custom range into High / Mid / Low for operational reasons.
  if (!raw) {
    throw new Error("target is required for ChatGPT matchmaking: high, mid, low, or additional");
  }
  const key = aliases[raw];
  if (!key) throw new Error("target must be high, mid, low, or additional");
  if (key === "high") return { key, label: "HIGH SET (5900+)", channelId: CHATGPT_BRIDGE_MATCH_HIGH_CHANNEL_ID, explicit: true };
  if (key === "mid") return { key, label: "MID SET (5600-5899)", channelId: CHATGPT_BRIDGE_MATCH_MID_CHANNEL_ID, explicit: true };
  if (key === "low") return { key, label: "LOW SET (5200-5599)", channelId: CHATGPT_BRIDGE_MATCH_LOW_CHANNEL_ID, explicit: true };
  return { key: "additional", label: "ADDITIONAL / CROSS-RANGE", channelId: CHATGPT_BRIDGE_MATCH_ADDITIONAL_CHANNEL_ID, explicit: true };
}

let chatgptBridgeProcessed = {};
let chatgptBridgeEloHistory = [];
let chatgptBridgeInterval = null;
let chatgptBridgeRunning = false;

function bridgeGithubGetJson(apiPath) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: "api.github.com",
      path: apiPath,
      headers: {
        "User-Agent": "FoW-ELO-Bot-ChatGPT-Bridge",
        "Accept": "application/vnd.github+json"
      },
      timeout: 15000
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`GitHub bridge HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (error) { reject(new Error(`GitHub bridge invalid JSON: ${error.message}`)); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("GitHub bridge request timeout")));
    request.on("error", reject);
  });
}

function bridgeSafeRequestId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) ? id : null;
}

function bridgeFindUniqueClubIndex(inputName) {
  const name = String(inputName || "").trim();
  if (!name) return { index: -1, reason: "empty_club" };
  const matches = [];
  for (let i = 0; i < leaderboardData.length; i++) {
    if (areEquivalentClubNames(leaderboardData[i].club, name)) matches.push(i);
  }
  if (matches.length === 1) return { index: matches[0], reason: null };
  if (matches.length > 1) return { index: -1, reason: "ambiguous_club" };

  // Exact normalized alias resolution only; never fuzzy-match bridge requests.
  const aliasKey = normalizeClubAliasKey(name);
  const aliasTarget = clubAliases && clubAliases[aliasKey];
  if (aliasTarget) {
    const aliasMatches = [];
    for (let i = 0; i < leaderboardData.length; i++) {
      if (normalizeClubName(leaderboardData[i].club) === normalizeClubName(aliasTarget)) aliasMatches.push(i);
    }
    if (aliasMatches.length === 1) return { index: aliasMatches[0], reason: null };
    if (aliasMatches.length > 1) return { index: -1, reason: "ambiguous_alias" };
  }
  return { index: -1, reason: "club_not_found" };
}

async function restoreChatgptBridgeState() {
  try {
    const processed = await loadSupabaseState(CHATGPT_BRIDGE_PROCESSED_KEY);
    if (processed && typeof processed === "object" && !Array.isArray(processed)) chatgptBridgeProcessed = processed;
    const history = await loadSupabaseState(CHATGPT_BRIDGE_ELO_HISTORY_KEY);
    if (Array.isArray(history)) chatgptBridgeEloHistory = history.slice(-5000);
    console.log(`🌉 ChatGPT bridge state restored • processed=${Object.keys(chatgptBridgeProcessed).length} • history=${chatgptBridgeEloHistory.length}`);
  } catch (error) {
    console.error("❌ ChatGPT bridge state restore failed:", error.message || error);
  }
}

function saveChatgptBridgeState() {
  queueSupabaseStateSave(CHATGPT_BRIDGE_PROCESSED_KEY, chatgptBridgeProcessed);
  queueSupabaseStateSave(CHATGPT_BRIDGE_ELO_HISTORY_KEY, chatgptBridgeEloHistory.slice(-5000));
}

function markBridgeProcessed(requestId, status, detail = {}) {
  chatgptBridgeProcessed[requestId] = {
    status,
    processedAt: new Date().toISOString(),
    ...detail
  };
  const keys = Object.keys(chatgptBridgeProcessed);
  if (keys.length > 2000) {
    keys.sort((a,b) => String(chatgptBridgeProcessed[a]?.processedAt || "").localeCompare(String(chatgptBridgeProcessed[b]?.processedAt || "")));
    for (const key of keys.slice(0, keys.length - 1500)) delete chatgptBridgeProcessed[key];
  }
  saveChatgptBridgeState();
}

function buildChatgptBridgeHeader(requestId) {
  return (
    `🤖 **Source: ChatGPT Bridge**\n` +
    `🆔 Request ID: **${requestId || "Unknown"}**\n\n`
  );
}

async function sendBridgeEloDiscordSummary({ requestId, dryRun, staged, skipped, changed = [] }) {
  try{const channel=await client.channels.fetch(CHATGPT_BRIDGE_ELO_CHANNEL_ID).catch(()=>null);if(!channel||!channel.isTextBased?.()||typeof channel.send!=="function")return false;if(dryRun){for(const chunk of splitDiscordText(buildChatgptBridgeHeader(requestId) + `🧪 **ELO UPDATE — DRY RUN**\n\nValidated: **${staged.length}**\nSkipped: **${skipped.length}**\nDatabase changed: **NO**`))await channel.send({content:chunk});return true;}const ck=new Set(changed.map(r=>normalizeClubName(r.club))),unchanged=staged.filter(r=>!ck.has(normalizeClubName(r.club)));let out=buildChatgptBridgeHeader(requestId) + `✅ **ELO DATABASE AUTO UPDATE**\n`;if(changed.length){out+=`\n📊 **Updated (${changed.length})**\n`;for(const r of changed)out+=`${r.club}: ${r.oldElo} → **${r.newElo}**\n`;}if(unchanged.length){out+=`\n➖ **No Change (${unchanged.length})**\n`;for(const r of unchanged)out+=`${r.club}: ${r.oldElo}\n`;}if(skipped.length){out+=`\n⚠️ **Skipped (${skipped.length})**\n`;for(const r of skipped.slice(0,20))out+=`${r.club||'?'} — ${r.reason}\n`;}out+=`\n💾 Database saved automatically.\n☁️ **Database synchronized with Supabase.**`;for(const chunk of splitDiscordText(out))await channel.send({content:chunk});return true;}catch(error){console.error(`❌ ChatGPT bridge ELO Discord summary failed (${requestId}):`,error);return false;}
}

async function processBridgeEloUpdate(payload, sourceFile) {
  const requestId = bridgeSafeRequestId(payload.request_id);
  if (!requestId) throw new Error("invalid request_id");
  if (chatgptBridgeProcessed[requestId]) return;
  if (String(payload.created_by || "").toLowerCase() !== "chatgpt") throw new Error("created_by must be chatgpt");
  if (!Array.isArray(payload.clubs) || payload.clubs.length < 1 || payload.clubs.length > CHATGPT_BRIDGE_MAX_ITEMS) throw new Error("clubs must contain 1-100 items");

  reloadLatestDatabase();
  const dryRun = payload.dry_run === true;
  const staged = [];
  const skipped = [];

  for (const item of payload.clubs) {
    const requestedClub = String(item?.club || "").trim();
    const newElo = Number(item?.new_elo);
    if (!requestedClub || !Number.isInteger(newElo) || newElo < 0 || newElo > 9999) {
      skipped.push({ club: requestedClub || "(blank)", reason: "invalid_club_or_elo" });
      continue;
    }
    const resolved = bridgeFindUniqueClubIndex(requestedClub);
    if (resolved.index < 0) {
      skipped.push({ club: requestedClub, reason: resolved.reason });
      continue;
    }
    const current = leaderboardData[resolved.index];
    const oldElo = Number(current.elo) || 0;
    staged.push({
      index: resolved.index,
      club: current.club,
      president: current.president || "",
      oldElo,
      newElo,
      delta: newElo - oldElo,
      opponent: item.opponent ? String(item.opponent).trim() : null,
      opponentEloBefore: Number.isFinite(Number(item.opponent_elo_before)) ? Number(item.opponent_elo_before) : null,
      result: item.result ? String(item.result).toLowerCase() : null
    });
  }

  if (dryRun) {
    console.log(`🧪 ChatGPT bridge DRY RUN ${requestId} • valid=${staged.length} skipped=${skipped.length} • no ELO changed`);
    for (const row of staged.slice(0, 20)) console.log(`   ${row.club}: ${row.oldElo} → ${row.newElo} (${row.delta >= 0 ? "+" : ""}${row.delta})`);
    const discordPosted = await sendBridgeEloDiscordSummary({ requestId, dryRun: true, staged, skipped, changed: [] });
    markBridgeProcessed(requestId, "dry_run", { sourceFile, valid: staged.length, skipped: skipped.length, discordPosted, channelId: CHATGPT_BRIDGE_ELO_CHANNEL_ID });
    return;
  }

  // Atomic policy: valid rows update; invalid/ambiguous rows are skipped and reported.
  // No silent club creation and no fuzzy guesses.
  const changed = staged.filter(row => row.oldElo !== row.newElo);
  for (const row of changed) leaderboardData[row.index].elo = row.newElo;
  if (changed.length) saveDatabase();

  const timestamp = new Date().toISOString();
  for (const row of changed) {
    const gapBefore = row.opponentEloBefore == null ? null : Math.abs(row.oldElo - row.opponentEloBefore);
    chatgptBridgeEloHistory.push({
      request_id: requestId,
      source_file: sourceFile,
      event_type: payload.event_type ? String(payload.event_type) : null,
      club: row.club,
      president: row.president,
      elo_before: row.oldElo,
      elo_after: row.newElo,
      delta: row.delta,
      opponent: row.opponent,
      opponent_elo_before: row.opponentEloBefore,
      gap_before: gapBefore,
      elo_position_before: row.opponentEloBefore == null ? null : (row.oldElo > row.opponentEloBefore ? "HIGHER" : row.oldElo < row.opponentEloBefore ? "LOWER" : "EQUAL"),
      result: row.result,
      match_id: payload.match_id ? normalizeMatchId(payload.match_id) : null,
      source: "chatgpt_bridge",
      timestamp
    });
  }
  chatgptBridgeEloHistory = chatgptBridgeEloHistory.slice(-5000);
  const discordPosted = await sendBridgeEloDiscordSummary({ requestId, dryRun: false, staged, skipped, changed });
  markBridgeProcessed(requestId, "applied", { sourceFile, updated: changed.length, unchanged: staged.length - changed.length, skipped: skipped.length, discordPosted, channelId: CHATGPT_BRIDGE_ELO_CHANNEL_ID });
  console.log(`✅ ChatGPT bridge ELO ${requestId} • updated=${changed.length} unchanged=${staged.length-changed.length} skipped=${skipped.length} • discord=${discordPosted ? "posted" : "not_posted"}`);
}

async function processBridgeManualMatchmaking(payload, sourceFile) {
  const requestId = bridgeSafeRequestId(payload.request_id);
  if (!requestId) throw new Error("invalid request_id");
  if (chatgptBridgeProcessed[requestId]) return;
  if (String(payload.created_by || "").toLowerCase() !== "chatgpt") throw new Error("created_by must be chatgpt");
  if (!Array.isArray(payload.pairs) || payload.pairs.length < 1 || payload.pairs.length > 50) throw new Error("pairs must contain 1-50 items");

  // ChatGPT routing is authoritative. Require an explicit target on every
  // bridge matchmaking request so missing routing can never fall back to
  // ADDITIONAL / CROSS-RANGE by accident.
  const targetToken = String(payload?.target ?? payload?.target_channel ?? "").trim();
  if (!targetToken) throw new Error("target is required for ChatGPT matchmaking: high, mid, low, or additional");

  reloadLatestDatabase();
  const maxGap = Math.max(0, Math.min(100, Number(payload.max_gap) || 100));
  const valid = [];
  const skipped = [];
  const used = new Set();

  for (const pair of payload.pairs) {
    const a = bridgeFindUniqueClubIndex(pair?.club_a);
    const b = bridgeFindUniqueClubIndex(pair?.club_b);
    if (a.index < 0 || b.index < 0 || a.index === b.index) {
      skipped.push({ club_a: pair?.club_a || "", club_b: pair?.club_b || "", reason: a.index < 0 ? a.reason : (b.index < 0 ? b.reason : "same_club") });
      continue;
    }

    const A = leaderboardData[a.index], B = leaderboardData[b.index];
    const keyA = normalizeClubName(A.club), keyB = normalizeClubName(B.club);
    if (used.has(keyA) || used.has(keyB)) {
      skipped.push({ club_a:A.club, club_b:B.club, reason:"duplicate_club_in_request" });
      continue;
    }
    if (!isClubMatchmakingAvailable(A.club) || !isClubMatchmakingAvailable(B.club)) {
      skipped.push({ club_a:A.club, club_b:B.club, reason:"war_isolated" });
      continue;
    }

    const gap = Math.abs((Number(A.elo)||0) - (Number(B.elo)||0));
    if (gap > maxGap) {
      skipped.push({ club_a:A.club, club_b:B.club, reason:`gap_${gap}_over_${maxGap}` });
      continue;
    }

    let winnerSide = null;
    const winnerToken = String(pair?.winner || "").trim();
    if (/^a$/i.test(winnerToken) || areEquivalentClubNames(winnerToken, A.club)) winnerSide = "a";
    else if (/^b$/i.test(winnerToken) || areEquivalentClubNames(winnerToken, B.club)) winnerSide = "b";
    if (!winnerSide) winnerSide = (Number(B.elo)||0) > (Number(A.elo)||0) ? "b" : "a";

    used.add(keyA); used.add(keyB);
    valid.push({
      a:{club:A.club,president:A.president||"",elo:Number(A.elo)||0},
      b:{club:B.club,president:B.president||"",elo:Number(B.elo)||0},
      gap, winnerSide, note:pair?.note ? String(pair.note).trim() : null
    });
  }

  // Production execution requires an explicit execute=true. Any omitted/false value
  // remains a safe validation-only request.
  const execute = payload.execute === true && payload.dry_run !== true;
  if (!execute) {
    const route = bridgeMatchmakingTargetRoute(payload, valid);
    const channel = await client.channels.fetch(route.channelId).catch(() => null);

    let discordPosted = false;

    if (channel && channel.isTextBased?.() && typeof channel.send === "function") {
      let output =
        buildChatgptBridgeHeader(requestId) +
        `🧪 **MATCHMAKING — DRY RUN**\n\n` +
        `📍 Target: **${route.label}**\n` +
        `✅ Valid Pairs: **${valid.length}**\n` +
        `⚠️ Skipped: **${skipped.length}**\n\n`;

      valid.forEach((pair, index) => {
        const winner = pair.winnerSide === "b" ? pair.b : pair.a;
        const loser = pair.winnerSide === "b" ? pair.a : pair.b;

        output +=
          `**${index + 1}. ${pair.a.club} (${pair.a.elo})**\n` +
          `vs\n` +
          `**${pair.b.club} (${pair.b.elo})**\n` +
          `Gap: **${pair.gap}**\n` +
          `🏆 Winner: **${winner.club}**\n` +
          `🚀 Pusher: **${winner.president || "Not Set"}**\n\n`;
      });

      if (skipped.length) {
        output += `⚠️ **Skipped from ChatGPT request (${skipped.length})**\n`;

        for (const row of skipped.slice(0, 20)) {
          output +=
            `• ${row.club_a || "?"} vs ${row.club_b || "?"} — ${row.reason}\n`;
        }

        if (skipped.length > 20) {
          output += `• ...and ${skipped.length - 20} more\n`;
        }

        output += `\n`;
      }

      output +=
        `🔒 **VALIDATION ONLY**\n` +
        `No Match ID created. No database changes. No isolation or timers started.`;

      for (const chunk of splitDiscordText(output)) {
        await channel.send({ content: chunk });
      }

      discordPosted = true;
    }

    console.log(
      `🧪 ChatGPT bridge MATCHMAKING ${requestId} • valid=${valid.length} skipped=${skipped.length} • VALIDATION ONLY • discord=${discordPosted ? "posted" : "not_posted"}`
    );

    markBridgeProcessed(requestId, "dry_run", {
      sourceFile,
      valid: valid.length,
      skipped: skipped.length,
      discordPosted,
      channelId: route.channelId
    });

    return;
  }
  if (!valid.length) {
    console.log(`⚠️ ChatGPT bridge MATCHMAKING ${requestId} • no valid pairs`);
    markBridgeProcessed(requestId, "no_valid_pairs", { sourceFile, valid: 0, skipped: skipped.length });
    return;
  }

  const route = bridgeMatchmakingTargetRoute(payload, valid);
  const channel = await client.channels.fetch(route.channelId).catch(()=>null);
  if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") {
    throw new Error(`Discord matchmaking channel unavailable: ${route.channelId} (${route.label})`);
  }

  const matchId = nextMatchId();
  const clubs = [];
  valid.forEach((pair, i) => {
    for (const side of ["a","b"]) {
      const item = pair[side];
      clubs.push({
        club:item.club, president:item.president||"", elo:Number(item.elo)||0,
        status:"pending", failedAt:null, failedBy:null,
        matchRole: side === pair.winnerSide ? "win" : "lose", pairNo:i+1
      });
    }
  });
  const elos = clubs.map(x=>Number(x.elo)||0);
  const plan = {
    id:matchId,
    guildId:channel.guildId || null,
    channelId:channel.id,
    min:elos.length?Math.min(...elos):0,
    max:elos.length?Math.max(...elos):0,
    clubs, pairCount:valid.length,
    createdAt:Date.now(), createdBy:"chatgpt_bridge",
    updatedAt:Date.now(), updatedBy:"chatgpt_bridge",
    eventId:getActiveEvent()?.id || null,
    manual:true, bridgeRequestId:requestId
  };
  matchPlans.set(matchId, plan);
  await saveMatchPlansNow();

  let output = buildChatgptBridgeHeader(requestId) + formatManualPlanOutput(plan);
  if (skipped.length) {
    output += `\n⚠️ **Skipped from ChatGPT request: ${skipped.length}**\n`;
    for (const row of skipped.slice(0,20)) output += `- ${row.club_a || "?"} vs ${row.club_b || "?"} — ${row.reason}\n`;
    if (skipped.length > 20) output += `- ...and ${skipped.length-20} more\n`;
  }
  const chunks = splitDiscordText(output);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await channel.send({
      content: chunks[i],
      components: isLast ? [buildMatchPlanKoButton(matchId)] : []
    });
  }

  markBridgeProcessed(requestId, "match_created", { sourceFile, matchId, valid: valid.length, skipped: skipped.length, channelId: channel.id, route: route.key });
  console.log(`✅ ChatGPT bridge MATCHMAKING ${requestId} • Match ID=${matchId} • pairs=${valid.length} skipped=${skipped.length} • route=${route.key} • channel=${channel.id}`);
}

function bridgeGithubRawText(commitSha, repoPath) {
  return new Promise((resolve, reject) => {
    const encodedPath = String(repoPath || "").split("/").map(encodeURIComponent).join("/");
    const request = https.get({
      hostname: "raw.githubusercontent.com",
      path: `/${encodeURIComponent(CHATGPT_BRIDGE_OWNER)}/${encodeURIComponent(CHATGPT_BRIDGE_REPO)}/${encodeURIComponent(commitSha)}/${encodedPath}`,
      headers: {
        "User-Agent": "FoW-ELO-Bot-ChatGPT-Bridge",
        "Accept": "application/json,text/plain;q=0.9,*/*;q=0.8"
      },
      timeout: 15000
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        raw += chunk;
        if (raw.length > 200000) request.destroy(new Error("bridge request file too large"));
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`GitHub raw HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
        }
        resolve(raw);
      });
    });
    request.on("timeout", () => request.destroy(new Error("GitHub raw request timeout")));
    request.on("error", reject);
  });
}

async function sendBridgeWarStatusDiscordSummary({ requestId, sourceFile }) {
  const channel=await client.channels.fetch(CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID).catch(()=>null);if(!channel||!channel.isTextBased?.()||typeof channel.send!=="function")throw new Error(`Discord war status channel unavailable: ${CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID}`);const output=buildChatgptBridgeHeader(requestId) + buildWarStatusDashboard();for(const chunk of splitDiscordText(output))await channel.send({content:chunk});return channel.id;
}

async function processBridgeWarStatus(payload, sourceFile) {
  const requestId = bridgeSafeRequestId(payload?.request_id);
  if (!requestId) throw new Error("invalid request_id");

  const channelId = await sendBridgeWarStatusDiscordSummary({ requestId, sourceFile });
  const active = Object.values(warOperations).filter(op => String(op?.status || "AVAILABLE").toUpperCase() !== "AVAILABLE").length;
  markBridgeProcessed(requestId, "war_status_posted", { sourceFile, active, channelId });
  console.log(`✅ ChatGPT bridge WAR STATUS ${requestId} • active=${active} • channel=${channelId}`);
}


async function sendBridgeWarStartDiscordSummary({ requestId, sourceFile, eventType, prepMs, clubs, dryRun }) {
  const channel=await client.channels.fetch(CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID).catch(()=>null);if(!channel||!channel.isTextBased?.()||typeof channel.send!=="function")throw new Error(`Discord war status channel unavailable: ${CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID}`);let output=buildChatgptBridgeHeader(requestId) + `🚨 **WAR START${dryRun?' — DRY RUN':''}**\n\n⚔️ Event: **${warEventLabel(eventType)}**\n${dryRun?'🧪':'🔴'} Status: **${dryRun?'VALIDATION ONLY':eventType==='grease'?'WAR ACTIVE':'PREPARATION'}**\n🚫 Matchmaking: **${dryRun?'NO CHANGE':'ISOLATED'}**\n\n${clubs.map(c=>`🏙️ ${c}`).join('\n')}`;if(!dryRun)output+=eventType==='grease'?`\n\n${getWarReminderMentions().join(' ')}`:`\n\n⏱️ Preparation: **${formatRemaining(prepMs)}**`;for(const chunk of splitDiscordText(output))await channel.send({content:chunk,allowedMentions:{parse:eventType==='grease'&&!dryRun?['users']:[]}});return channel.id;
}

async function processBridgeWarStart(payload, sourceFile) {
  const requestId = bridgeSafeRequestId(payload?.request_id);
  if (!requestId) throw new Error("invalid request_id");

  const eventType = String(payload?.event_type || "").trim().toLowerCase();
  if (!["normal", "lightning", "grease"].includes(eventType)) {
    throw new Error("event_type must be normal, lightning, or grease");
  }

  let requested = payload?.clubs;
  if (typeof requested === "string") requested = parseSkipList(requested);
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > CHATGPT_BRIDGE_MAX_ITEMS) {
    throw new Error(`clubs must contain 1-${CHATGPT_BRIDGE_MAX_ITEMS} club names`);
  }

  const clubs = [];
  const missing = [];
  const duplicates = new Set();
  for (const raw of requested) {
    const name = typeof raw === "string" ? raw : raw?.club;
    const db = leaderboardData.find(x => areEquivalentClubNames(x.club, String(name || "")));
    if (!db) { missing.push(String(name || "").trim() || "(blank)"); continue; }
    const key = warOpKey(db.club);
    if (duplicates.has(key)) continue;
    duplicates.add(key);
    clubs.push(db.club);
  }
  if (missing.length) throw new Error(`club not found: ${missing.join(", ")}`);
  if (!clubs.length) throw new Error("no valid clubs");

  let prepMs = null;
  const prepText = String(payload?.preparation_time || "").trim();
  if (eventType === "normal" || eventType === "lightning") {
    prepMs = parsePreparationDurationStrict(prepText);
    if (!prepMs) throw new Error("preparation_time is required in XXh XXmin format for Normal/Lightning");
  } else if (prepText) {
    throw new Error("Grease has no preparation_time");
  }

  const dryRun = payload?.dry_run === true || payload?.execute !== true;
  if (!dryRun) {
    for (const club of clubs) {
      const current = getWarOperation(club);
      if (current && String(current.status || "AVAILABLE").toUpperCase() !== "AVAILABLE") {
        throw new Error(`${club} already has active war state: ${current.status}`);
      }
    }
    for (const club of clubs) {
      if (eventType === "grease") {
        startWarMonitoringForClub(club, eventType, {
          channelId: CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID,
          guildId: null,
          userId: "chatgpt-bridge"
        });
      } else {
        setWarOperation(club, {
          eventType,
          status: "PREPARATION",
          isolated: true,
          channelId: CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID,
          guildId: null,
          preparationEndAt: Date.now() + prepMs,
          nextReminderAt: null,
          reminderPending: false,
          lastAckBy: null,
          lastAckAt: null,
          coolingEndAt: null,
          warning15mSent: false,
          completionSent: false
        }, "chatgpt-bridge", "PREPARATION_STARTED_BRIDGE");
      }
    }
  }

  const channelId = await sendBridgeWarStartDiscordSummary({ requestId, sourceFile, eventType, prepMs, clubs, dryRun });
  markBridgeProcessed(requestId, dryRun ? "war_start_validated" : "war_start_executed", { sourceFile, eventType, clubs, channelId, dryRun });
  console.log(`${dryRun ? "🧪" : "✅"} ChatGPT bridge WAR START ${requestId} • event=${eventType} • clubs=${clubs.length} • ${dryRun ? "VALIDATION ONLY" : "executed"} • channel=${channelId}`);
}


async function sendBridgeWarDoneDiscordSummary({ requestId, sourceFile, results, dryRun }) {
  const channel=await client.channels.fetch(CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID).catch(()=>null);if(!channel||!channel.isTextBased?.()||typeof channel.send!=="function")throw new Error(`Discord war status channel unavailable: ${CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID}`);let output=buildChatgptBridgeHeader(requestId) + `✅ **WAR ${dryRun?'DONE — DRY RUN':'DONE'}**\n\n`+results.map(r=>`${dryRun?'🧪':r.toStatus==='AVAILABLE'?'🟢':r.toStatus==='COOLING_DOWN'?'🟡':'🟠'} **${r.club}** • ${warEventLabel(r.eventType)}\nStatus: **${String(r.toStatus).replaceAll('_',' ')}**${r.coolingMs?` • Cooling: **${formatRemaining(r.coolingMs)}**`:''}\nMatchmaking: **${r.toStatus==='AVAILABLE'?'AVAILABLE':'ISOLATED'}**`).join('\n\n');const tag=!dryRun&&results.some(r=>String(r.eventType).toLowerCase()==='grease'&&r.toStatus==='AVAILABLE');if(tag)output+=`\n\n${getWarReminderMentions().join(' ')}`;for(const chunk of splitDiscordText(output))await channel.send({content:chunk,allowedMentions:{parse:tag?['users']:[]}});return channel.id;
}

async function processBridgeWarDone(payload, sourceFile) {
  const requestId = bridgeSafeRequestId(payload?.request_id);
  if (!requestId) throw new Error("invalid request_id");

  let requested = payload?.clubs;
  if (typeof requested === "string") requested = parseSkipList(requested);
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > CHATGPT_BRIDGE_MAX_ITEMS) {
    throw new Error(`clubs must contain 1-${CHATGPT_BRIDGE_MAX_ITEMS} club names`);
  }

  const clubs = [];
  const missing = [];
  const duplicates = new Set();
  for (const raw of requested) {
    const name = typeof raw === "string" ? raw : raw?.club;
    const db = leaderboardData.find(x => areEquivalentClubNames(x.club, String(name || "")));
    if (!db) { missing.push(String(name || "").trim() || "(blank)"); continue; }
    const key = warOpKey(db.club);
    if (duplicates.has(key)) continue;
    duplicates.add(key);
    clubs.push(db.club);
  }
  if (missing.length) throw new Error(`club not found: ${missing.join(", ")}`);
  if (!clubs.length) throw new Error("no valid clubs");

  const coolingText = String(payload?.cooling_time || "").trim();
  const coolingMs = coolingText ? parseRemainingDuration(coolingText) : null;
  if (coolingText && !coolingMs) throw new Error("cooling_time is invalid; use e.g. 7h 35m, 455m, or 00h 15min");

  const dryRun = payload?.dry_run === true || payload?.execute !== true;
  const plans = [];

  for (const club of clubs) {
    const op = getWarOperation(club);
    const status = String(op?.status || "AVAILABLE").toUpperCase();
    if (!op || !["WAR_ACTIVE", "KO_ACTIVE"].includes(status)) {
      throw new Error(`${club} is not in WAR_ACTIVE/KO_ACTIVE state (current: ${status})`);
    }
    const eventType = String(op.eventType || "normal").toLowerCase();
    if (eventType !== "normal" && coolingText) {
      throw new Error(`${club} is ${warEventLabel(eventType)}; cooling_time is only valid for Normal`);
    }
    plans.push({
      club,
      eventType,
      fromStatus: status,
      toStatus: eventType === "normal" ? (coolingMs ? "COOLING_DOWN" : "AWAITING_COOLING_TIME") : "AVAILABLE",
      coolingMs: eventType === "normal" ? coolingMs : null
    });
  }

  if (!dryRun) {
    for (const plan of plans) {
      const op = getWarOperation(plan.club);
      if (plan.toStatus === "COOLING_DOWN") {
        setWarOperation(plan.club, {
          status: "COOLING_DOWN",
          isolated: true,
          nextReminderAt: null,
          reminderPending: false,
          coolingEndAt: Date.now() + plan.coolingMs,
          warning15mSent: plan.coolingMs <= 15 * 60 * 1000,
          completionSent: false
        }, "chatgpt-bridge", "WAR_ENDED_COOLING_STARTED_BRIDGE");
      } else if (plan.toStatus === "AWAITING_COOLING_TIME") {
        setWarOperation(plan.club, {
          status: "AWAITING_COOLING_TIME",
          isolated: true,
          nextReminderAt: null,
          reminderPending: false,
          coolingEndAt: null,
          warning15mSent: false,
          completionSent: false
        }, "chatgpt-bridge", "WAR_ENDED_AWAITING_COOLING_BRIDGE");
      } else {
        setWarOperation(plan.club, {
          status: "AVAILABLE",
          isolated: false,
          nextReminderAt: null,
          reminderPending: false,
          coolingEndAt: null,
          warning15mSent: false,
          completionSent: true
        }, "chatgpt-bridge", "WAR_ENDED_AVAILABLE_BRIDGE");
      }
    }
  }

  const channelId = await sendBridgeWarDoneDiscordSummary({ requestId, sourceFile, results: plans, dryRun });
  markBridgeProcessed(requestId, dryRun ? "war_done_validated" : "war_done_executed", { sourceFile, clubs, plans, channelId, dryRun });
  console.log(`${dryRun ? "🧪" : "✅"} ChatGPT bridge WAR DONE ${requestId} • clubs=${clubs.length} • ${dryRun ? "VALIDATION ONLY" : "executed"} • channel=${channelId}`);
}


async function sendBridgeCoolingStartDiscordSummary({ requestId, sourceFile, results, dryRun }) {
  const channel = await client.channels.fetch(CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased?.() || typeof channel.send !== "function") {
    throw new Error(`Discord war status channel unavailable: ${CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID}`);
  }

  let output = buildChatgptBridgeHeader(requestId) + `🧊 **COOLING START${dryRun ? " DRY RUN" : ""}**\n\n`;
  output += results.map(r => {
    const icon = dryRun ? "🧪" : "🟡";
    return `${icon} **${r.club}** • Normal • ${dryRun ? "VALIDATION ONLY" : "COOLING DOWN"} • Cooling: **${formatRemaining(r.coolingMs)}** • Matchmaking: **ISOLATED**`;
  }).join("\n");
  output += `\n\n📍 Channel: <#${CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID}>`;
  if (sourceFile) output += ` • ${sourceFile}`;

  for (const chunk of splitDiscordText(output)) await channel.send({ content: chunk });
  return channel.id;
}

async function processBridgeCoolingStart(payload, sourceFile) {
  const requestId = bridgeSafeRequestId(payload?.request_id);
  if (!requestId) throw new Error("invalid request_id");

  let requested = payload?.clubs ?? payload?.club;
  if (typeof requested === "string") requested = [requested];
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > CHATGPT_BRIDGE_MAX_ITEMS) {
    throw new Error(`clubs must contain 1-${CHATGPT_BRIDGE_MAX_ITEMS} club names`);
  }

  const clubs = [];
  const missing = [];
  const duplicates = new Set();
  for (const raw of requested) {
    const name = typeof raw === "string" ? raw : raw?.club;
    const db = leaderboardData.find(x => areEquivalentClubNames(x.club, String(name || "")));
    if (!db) { missing.push(String(name || "").trim() || "(blank)"); continue; }
    const key = warOpKey(db.club);
    if (duplicates.has(key)) continue;
    duplicates.add(key);
    clubs.push(db.club);
  }
  if (missing.length) throw new Error(`club not found: ${missing.join(", ")}`);
  if (!clubs.length) throw new Error("no valid clubs");

  const coolingText = String(payload?.cooling_time || "").trim();
  const coolingMs = parseRemainingDuration(coolingText);
  if (!coolingMs) throw new Error("cooling_time is required and must be valid; use e.g. 7h 35m, 455m, or 00h 10min");

  const dryRun = payload?.dry_run === true || payload?.execute !== true;
  const plans = [];

  for (const club of clubs) {
    const op = getWarOperation(club);
    const status = String(op?.status || "AVAILABLE").toUpperCase();
    if (!op || status !== "AWAITING_COOLING_TIME") {
      throw new Error(`${club} is not in AWAITING_COOLING_TIME state (current: ${status})`);
    }
    const eventType = String(op.eventType || "normal").toLowerCase();
    if (eventType !== "normal") {
      throw new Error(`${club} is ${warEventLabel(eventType)}; cooling_start is only valid for Normal`);
    }
    plans.push({ club, eventType, fromStatus: status, toStatus: "COOLING_DOWN", coolingMs });
  }

  if (!dryRun) {
    for (const plan of plans) {
      setWarOperation(plan.club, {
        status: "COOLING_DOWN",
        isolated: true,
        nextReminderAt: null,
        reminderPending: false,
        coolingEndAt: Date.now() + plan.coolingMs,
        warning15mSent: plan.coolingMs <= 15 * 60 * 1000,
        completionSent: false
      }, "chatgpt-bridge", "COOLING_STARTED_BRIDGE");
    }
  }

  const channelId = await sendBridgeCoolingStartDiscordSummary({ requestId, sourceFile, results: plans, dryRun });
  markBridgeProcessed(requestId, dryRun ? "cooling_start_validated" : "cooling_start_executed", { sourceFile, clubs, plans, channelId, dryRun });
  console.log(`${dryRun ? "🧪" : "✅"} ChatGPT bridge COOLING START ${requestId} • clubs=${clubs.length} • ${dryRun ? "VALIDATION ONLY" : "executed"} • channel=${channelId}`);
}

async function processChatgptBridgePayload(payload, sourceFile) {
  const requestId = bridgeSafeRequestId(payload?.request_id);
  if (requestId && chatgptBridgeProcessed[requestId]) return { skipped: "already_processed", requestId };
  if (payload?.type === "war_status") {
    await processBridgeWarStatus(payload, sourceFile);
    return { processed: true, requestId };
  }
  if (payload?.type === "war_start") {
    await processBridgeWarStart(payload, sourceFile);
    return { processed: true, requestId };
  }
  if (payload?.type === "war_done") {
    await processBridgeWarDone(payload, sourceFile);
    return { processed: true, requestId };
  }
  if (payload?.type === "cooling_start") {
    await processBridgeCoolingStart(payload, sourceFile);
    return { processed: true, requestId };
  }
  if (payload?.type === "elo_update") {
    await processBridgeEloUpdate(payload, sourceFile);
    return { processed: true, requestId };
  }
  if (payload?.type === "manual_matchmaking") {
    await processBridgeManualMatchmaking(payload, sourceFile);
    return { processed: true, requestId };
  }
  throw new Error(`unsupported request type: ${String(payload?.type || "")}`);
}

async function processOneChatgptBridgeRawFile(repoPath, commitSha) {
  if (!/^requests\/[^/]+\.json$/i.test(String(repoPath || ""))) return;
  if (!/^[0-9a-f]{40}$/i.test(String(commitSha || ""))) throw new Error("invalid GitHub commit SHA");
  const raw = await bridgeGithubRawText(commitSha, repoPath);
  const payload = JSON.parse(raw);
  return processChatgptBridgePayload(payload, String(repoPath).split("/").pop());
}

function bridgeParseIssueJson(body) {
  const text = String(body || "").trim();
  if (!text) throw new Error("empty GitHub issue body");

  // Preferred format: the entire issue body is the bridge JSON payload.
  try { return JSON.parse(text); } catch (_) {}

  // Also accept a single fenced JSON block so ChatGPT can keep the issue readable.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!fenced) throw new Error("GitHub issue body must contain valid JSON");
  return JSON.parse(String(fenced[1] || "").trim());
}

async function processChatgptBridgeIssue(issuePayload) {
  const issue = issuePayload?.issue;
  const issueNumber = Number(issue?.number || 0);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("invalid GitHub issue number");

  const payload = bridgeParseIssueJson(issue?.body);
  const requestId = bridgeSafeRequestId(payload?.request_id);
  if (!requestId) throw new Error("invalid request_id");

  const source = `issue-${issueNumber}`;
  const result = await processChatgptBridgePayload(payload, source);
  console.log(`🌉 ChatGPT bridge issue processed • #${issueNumber} • request=${requestId}`);
  return result;
}

function bridgeWebhookSignatureValid(rawBody, signatureHeader) {
  const crypto = require("crypto");
  if (!CHATGPT_BRIDGE_WEBHOOK_SECRET || CHATGPT_BRIDGE_WEBHOOK_SECRET.length < 16) return false;
  const supplied = String(signatureHeader || "");
  if (!/^sha256=[0-9a-f]{64}$/i.test(supplied)) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", CHATGPT_BRIDGE_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return secureStringEqual(supplied.toLowerCase(), expected.toLowerCase());
}

async function handleChatgptBridgeWebhook(req, res) {
  try {
    if (!CHATGPT_BRIDGE_ENABLED || CHATGPT_BRIDGE_MODE !== "webhook") {
      return res.status(503).json({ ok: false, error: "bridge_webhook_disabled" });
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    if (!bridgeWebhookSignatureValid(rawBody, req.headers["x-hub-signature-256"])) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }
    const event = String(req.headers["x-github-event"] || "").toLowerCase();
    if (event === "ping") return res.status(200).json({ ok: true, event: "ping" });

    const payload = JSON.parse(rawBody.toString("utf8"));
    if (String(payload?.repository?.full_name || "") !== `${CHATGPT_BRIDGE_OWNER}/${CHATGPT_BRIDGE_REPO}`) {
      return res.status(403).json({ ok: false, error: "wrong_repository" });
    }

    // Phase 2.3: ChatGPT can create GitHub Issues even when repository-content writes
    // are restricted. An opened/edited issue can therefore act as a signed bridge
    // request. The issue body must be the same JSON payload used by requests/*.json.
    if (event === "issues") {
      const action = String(payload?.action || "").toLowerCase();
      if (!new Set(["opened", "edited", "reopened"]).has(action)) {
        return res.status(202).json({ ok: true, ignored: `issues_${action || "unknown"}` });
      }
      const issueNumber = Number(payload?.issue?.number || 0);
      res.status(202).json({ ok: true, queued: 1, source: `issue-${issueNumber || "unknown"}` });
      setImmediate(async () => {
        try {
          await processChatgptBridgeIssue(payload);
        } catch (error) {
          console.error(`❌ ChatGPT bridge issue request failed (#${issueNumber || "?"}):`, error.message || error);
        }
      });
      return;
    }

    if (event !== "push") return res.status(202).json({ ok: true, ignored: `event_${event || "unknown"}` });
    if (String(payload?.ref || "") !== `refs/heads/${CHATGPT_BRIDGE_BRANCH}`) {
      return res.status(202).json({ ok: true, ignored: "wrong_branch" });
    }
    const commitSha = String(payload?.after || "");
    const touched = new Set();
    for (const commit of Array.isArray(payload?.commits) ? payload.commits : []) {
      for (const path of [...(commit?.added || []), ...(commit?.modified || [])]) {
        if (/^requests\/[^/]+\.json$/i.test(String(path || ""))) touched.add(String(path));
      }
    }
    res.status(202).json({ ok: true, queued: touched.size });
    if (!touched.size) return;

    // Process after acknowledging GitHub so webhook delivery remains fast.
    setImmediate(async () => {
      for (const repoPath of touched) {
        try {
          await processOneChatgptBridgeRawFile(repoPath, commitSha);
          console.log(`🌉 ChatGPT bridge webhook processed • ${repoPath} • commit=${commitSha.slice(0, 8)}`);
        } catch (error) {
          console.error(`❌ ChatGPT bridge webhook request failed (${repoPath}):`, error.message || error);
          const fallbackId = bridgeSafeRequestId(String(repoPath).split("/").pop().replace(/\.json$/i, ""));
          if (fallbackId && !chatgptBridgeProcessed[fallbackId]) {
            markBridgeProcessed(fallbackId, "rejected", { sourceFile: repoPath, error: String(error.message || error).slice(0, 300) });
          }
        }
      }
    });
  } catch (error) {
    console.error("❌ ChatGPT bridge webhook failed:", error.message || error);
    if (!res.headersSent) res.status(400).json({ ok: false, error: "invalid_webhook_payload" });
  }
}

async function processOneChatgptBridgeFile(fileMeta) {
  if (!fileMeta || fileMeta.type !== "file" || !/\.json$/i.test(fileMeta.name || "")) return;
  const encodedPath = String(fileMeta.path || `requests/${fileMeta.name}`).split("/").map(encodeURIComponent).join("/");
  const apiPath = `/repos/${encodeURIComponent(CHATGPT_BRIDGE_OWNER)}/${encodeURIComponent(CHATGPT_BRIDGE_REPO)}/contents/${encodedPath}?ref=${encodeURIComponent(CHATGPT_BRIDGE_BRANCH)}`;
  const file = await bridgeGithubGetJson(apiPath);
  if (!file || file.encoding !== "base64" || typeof file.content !== "string") throw new Error(`cannot decode ${fileMeta.name}`);
  if (Number(file.size || 0) > 200000) throw new Error(`request file too large: ${fileMeta.name}`);
  const payload = JSON.parse(Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8"));
  return processChatgptBridgePayload(payload, fileMeta.name);
}

async function pollChatgptBridge() {
  if (!CHATGPT_BRIDGE_ENABLED || chatgptBridgeRunning) return;
  chatgptBridgeRunning = true;
  try {
    const apiPath = `/repos/${encodeURIComponent(CHATGPT_BRIDGE_OWNER)}/${encodeURIComponent(CHATGPT_BRIDGE_REPO)}/contents/requests?ref=${encodeURIComponent(CHATGPT_BRIDGE_BRANCH)}`;
    const files = await bridgeGithubGetJson(apiPath);
    if (!Array.isArray(files)) throw new Error("requests path is not a directory");
    const requestFiles = files.filter(item => item && item.type === "file" && /\.json$/i.test(item.name || "")).slice(0, 200);
    for (const fileMeta of requestFiles) {
      try { await processOneChatgptBridgeFile(fileMeta); }
      catch (error) {
        console.error(`❌ ChatGPT bridge request failed (${fileMeta?.name || "unknown"}):`, error.message || error);
        const fallbackId = bridgeSafeRequestId(String(fileMeta?.name || "").replace(/\.json$/i, ""));
        if (fallbackId && !chatgptBridgeProcessed[fallbackId]) markBridgeProcessed(fallbackId, "rejected", { sourceFile:fileMeta.name, error:String(error.message || error).slice(0,300) });
      }
    }
  } catch (error) {
    console.error("❌ ChatGPT bridge poll failed:", error.message || error);
  } finally {
    chatgptBridgeRunning = false;
  }
}

async function startChatgptBridgeProcessor() {
  if (!CHATGPT_BRIDGE_ENABLED) return;
  await restoreChatgptBridgeState();
  if (CHATGPT_BRIDGE_MODE === "webhook") {
    console.log(`🌉 ChatGPT bridge processor started • ${CHATGPT_BRIDGE_OWNER}/${CHATGPT_BRIDGE_REPO} • mode=webhook • endpoint=/bridge/github`);
    if (!CHATGPT_BRIDGE_WEBHOOK_SECRET || CHATGPT_BRIDGE_WEBHOOK_SECRET.length < 16) {
      console.warn("⚠️ ChatGPT bridge webhook secret is missing/too short. Set CHATGPT_BRIDGE_WEBHOOK_SECRET in .env before enabling the GitHub webhook.");
    }
    return;
  }
  if (chatgptBridgeInterval) return;
  console.log(`🌉 ChatGPT bridge processor started • ${CHATGPT_BRIDGE_OWNER}/${CHATGPT_BRIDGE_REPO} • mode=poll • poll=${Math.round(CHATGPT_BRIDGE_POLL_MS/1000)}s`);
  await pollChatgptBridge();
  chatgptBridgeInterval = setInterval(() => pollChatgptBridge(), CHATGPT_BRIDGE_POLL_MS);
  if (chatgptBridgeInterval && typeof chatgptBridgeInterval.unref === "function") chatgptBridgeInterval.unref();
}

// ============================================================
// DISCORD READY
// ============================================================

client.once(
  "clientReady",
  async () => {

    console.log(
      `✅ Discord bot online as ${client.user.tag}`
    );

    markDiscordHealthy();

    try {

      await client
        .application
        .commands
        .set(
          commands
        );

      console.log(
        "✅ Slash commands registered"
      );

    } catch (
      error
    ) {

      console.error(
        "❌ Slash command registration error:",
        error
      );

    }

    // Start the active FoW timer engine only after Discord is fully ready.
    // This prevents startup fetch/send attempts from being lost before login.
    startFowTimerProcessor();
    startWarOperationsProcessor();
    startMatchPlanLifecycleProcessor();
    startChatgptBridgeProcessor().catch(error => console.error("❌ ChatGPT bridge startup error:", error));

    cleanupPersistentOperationsData().catch(error => console.error("❌ Operations cleanup error:", error));
    const operationsCleanupInterval = setInterval(() => {
      cleanupPersistentOperationsData().catch(error => console.error("❌ Operations cleanup error:", error));
    }, 6 * 60 * 60 * 1000);
    if (operationsCleanupInterval && typeof operationsCleanupInterval.unref === "function") operationsCleanupInterval.unref();

    // Check persistent legacy push reminders immediately after login and every minute.
    await checkPushReminders();

    setInterval(
      () => {
        checkPushReminders()
          .catch(
            error =>
              console.error(
                "❌ Push reminder checker error:",
                error
              )
          );
      },
      60 * 1000
    );

  }
);

// ============================================================
// AUTO UPDATE FROM NORMAL MESSAGE
// ============================================================

client.on(
  "messageCreate",
  async message => {

    if (
      message.author.bot
    ) {
      return;
    }

    const content =
      message.content.trim();

    if (
      !content
    ) {
      return;
    }

    // ============================================================
    // HS ASSISTANT — PHASE 2 / v82.1
    // Test channel only • Mention only • Read only
    // ============================================================
    const HS_TEST_CHANNEL_ID = "1256056255890587648";

    const HS_NO_MENTION_CHANNEL_IDS = new Set([
      "1551169287962628157",
      "1551169775714041887",
      "1551169605056209018",
      "1551170391387406356",
      "1551275848663826593"
    ]);

    const hsNoMentionChannel =
      HS_NO_MENTION_CHANNEL_IDS.has(String(message.channelId));

    const hsLiteralMention =
      /^@hs(?:\s|$)/i.test(content);

    const hsDiscordMention =
      client.user &&
      message.mentions?.users?.has(client.user.id);
    if (
      (
        String(message.channelId) === HS_TEST_CHANNEL_ID &&
        (hsLiteralMention || hsDiscordMention)
      ) ||
      hsNoMentionChannel
    ) {
      try {
        const cleaned = content
          .replace(/^@hs(?:\s+|$)/i, "")
          .replace(
            client.user
              ? new RegExp(`<@!?${client.user.id}>`, "g")
              : /$^/,
            " "
          )
          .replace(/\s+/g, " ")
          .trim();

        const q = cleaned.toLowerCase();

        const isOwner =
          Boolean(message.guild?.ownerId) &&
          String(message.guild.ownerId) === String(message.author.id);

        let isAdmin = false;

        try {
          isAdmin = Boolean(
            message.member?.permissions?.has?.(
              PermissionsBitField.Flags.Administrator
            )
          );
        } catch {}

        const access =
          isOwner
            ? "Server Owner"
            : isAdmin
              ? "Admin"
              : "Member";

        let response = "";
        let hsReplyComponents = [];

        if (
          !q ||
          /^(hi|hello|hey|hai|helo|bro|test|ping)[!. ]*$/.test(q)
        ) {
          response =
            `Hello! HS is online.\n\n` +
            `👤 Access detected: **${access}**\n` +
            `✅ Mention detection: **Working**\n` +
            `🔒 Mode: **Read-only test**\n` +
            `🧠 AI connection: **Not enabled yet**\n\n` +
            `Try:\n` +
            `• @HS what can you do?\n` +
            `• @HS how do I use war monitor?\n` +
            `• @HS what command for matchmaking?`;

        } else if (
          /what\s+(?:can\s+)?you\s+do|what\s+you\s+can\s+do|boleh buat apa|apa yang .*boleh|help|bantuan/.test(q)
        ) {
          response =
            `👤 Access detected: **${access}**\n\n` +
            `For this test phase I can:\n` +
            `• Explain basic FoW bot commands\n` +
            `• Identify command categories\n` +
            `• Recognize your Discord access level\n` +
            `• Operate only inside this test channel\n\n` +
            `🔒 I cannot modify production data.`;

        } else if (
          /war[_ ]?monitor|war monitor|monitor war/.test(q)
        ) {
          response =
            `⚔️ **War Monitor Help**\n\n` +
            `Command: **/war_monitor**\n\n` +
            `Normal and Lightning use preparation before the 2-hour ` +
            `War Monitor reminder cycle begins.\n` +
            `Grease has no preparation stage.\n\n` +
            `🔒 Explanation only — no War Monitor state changed.`;

        } else if (
          /\bsend\s+to\s+(?:high|mid|low|additional|cross[ -]?range)(?:\s+set)?(?:\s+channel)?\b/i.test(q)
        ) {
          // HS PHASE 6 — attach destination to latest stored preview.
          cleanupHsControlRoomDrafts();

          const hsDestination =
            parseHsControlRoomDestination(q);

          const latestDraft =
            [...hsControlRoomDrafts.values()]
              .filter(draft =>
                draft?.userId === message.author.id &&
                draft?.guildId === message.guildId &&
                draft?.sourceChannelId === message.channelId &&
                draft?.previewResult?.pairs?.length
              )
              .sort(
                (a, b) =>
                  Number(b.updatedAt || b.createdAt || 0) -
                  Number(a.updatedAt || a.createdAt || 0)
              )[0];

          if (!hsDestination) {
            response =
              `❌ Destination not recognized.\n\n` +
              `Use: **send to high set**, **mid set**, **low set**, or **additional**.`;

          } else if (!latestDraft) {
            response =
              `⚠️ No active matchmaking preview found.\n\n` +
              `Create a matchmaking preview first, then choose the destination.`;

          } else {
            latestDraft.destinationKey = hsDestination.key;
            latestDraft.destinationLabel = hsDestination.label;
            latestDraft.destinationChannelId = hsDestination.channelId;
            latestDraft.updatedAt = Date.now();

            hsReplyComponents = [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`hscr_confirm:${latestDraft.id}`)
                  .setLabel("CONFIRM & SEND")
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`hscr_cancel:${latestDraft.id}`)
                  .setLabel("CANCEL")
                  .setStyle(ButtonStyle.Danger)
              )
            ];

            response =
              `🎛️ **Phase 6 — AI Control Room**\n\n` +
              `⚔️ Stored preview: **${latestDraft.minElo} - ${latestDraft.maxElo}**\n` +
              `🤝 Pairs: **${latestDraft.previewResult.pairs.length}**\n` +
              `📤 Destination: **${hsDestination.label}**\n\n` +
              `Review the destination, then use the button below.\n\n` +
              `🔒 No Match ID created yet. No database changes.`;
          }

        } else if (
          /manual[_ ]?matchmaking|manual matchmaking/.test(q)
        ) {
          response =
            `⚔️ **Manual Matchmaking Help**\n\n` +
            `Command: **/manual_matchmaking**\n\n` +
            `Use this when you want to create pairings manually.\n\n` +
            `🔒 No Match ID or pairing was created.`;

        } else if (
          /matchmaking|match making|matchmake/.test(q)
        ) {

          // HS PHASE 4 — READ-ONLY MATCHMAKING PREVIEW
          const rangeMatch =
            q.match(/\b(\d{4,5})\s*(?:-|–|—|to|\s)\s*(\d{4,5})\b/i);

          if (rangeMatch) {

            let minElo = Number(rangeMatch[1]);
            let maxElo = Number(rangeMatch[2]);

            if (minElo > maxElo) {
              [minElo, maxElo] = [maxElo, minElo];
            }

            // ========================================================
            // HS PHASE 6.0A — CONTROL ROOM PREVIEW DRAFT
            // Destination is explicitly selected by the user.
            // ELO range NEVER determines the destination channel.
            // ========================================================
            cleanupHsControlRoomDrafts();

            const hsDraftId =
              `${Date.now().toString(36)}${message.author.id.slice(-4)}`;
            const hsDestination =
              parseHsControlRoomDestination(cleaned);

            hsControlRoomDrafts.set(hsDraftId, {
                id: hsDraftId,
                userId: message.author.id,
                guildId: message.guildId,
                sourceChannelId: message.channelId,
                destinationKey: hsDestination?.key || null,
                destinationLabel: hsDestination?.label || null,
                destinationChannelId: hsDestination?.channelId || null,
                minElo,
                maxElo,
                requestText: cleaned,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                phase: "6.0A"
            });

            if (hsDestination) {
              hsReplyComponents = [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`hscr_confirm:${hsDraftId}`)
                    .setLabel("CONFIRM & SEND")
                    .setStyle(ButtonStyle.Success),
                  new ButtonBuilder()
                    .setCustomId(`hscr_cancel:${hsDraftId}`)
                    .setLabel("CANCEL")
                    .setStyle(ButtonStyle.Danger)
                )
              ];
            }

            reloadLatestDatabase();

            // ========================================================
            // HS PHASE 4.1 — NATURAL MATCHMAKING CONTROLS
            // Supported:
            // skip <club>
            // <club> must win
            // <club> must lose
            // Multiple controls may be separated by ; or ,
            // ========================================================

            let directiveText =
              q.slice(
                (rangeMatch.index || 0) +
                rangeMatch[0].length
              ).trim();

            const skipSet = new Set();
            const mustWinSet = new Set();
            const mustLoseSet = new Set();

            const skippedNames = [];
            const mustWinNames = [];
            const mustLoseNames = [];

            // HS PHASE 4.5 — SAFE PARTIAL CLUB/PRESIDENT RESOLUTION
            const referenceIssueLines = [];
            const resolvedReferenceLines = [];
            const requestedControlLines = [];

            const resolverEntries =
              (leaderboardData || [])
                .filter(item => item?.club);

            const resolveHsReference = raw => {

              const ref =
                String(raw || "").trim();

              const key =
                normalizeClubName(ref);

              if (!key) {
                return {
                  status: "unresolved",
                  raw: ref
                };
              }

              // 1. Exact club / president match has highest priority.
              const exact =
                resolverEntries.filter(item =>
                  normalizeClubName(item.club) === key ||
                  normalizeClubName(item.president || "") === key
                );

              if (exact.length === 1) {
                return {
                  status: "resolved",
                  raw: ref,
                  item: exact[0]
                };
              }

              if (exact.length > 1) {
                return {
                  status: "ambiguous",
                  raw: ref,
                  matches: exact
                };
              }

              // 2. Prefix match.
              const prefix =
                resolverEntries.filter(item => {
                  const club =
                    normalizeClubName(item.club);

                  const president =
                    normalizeClubName(item.president || "");

                  return (
                    club.startsWith(key) ||
                    president.startsWith(key)
                  );
                });

              if (prefix.length === 1) {
                return {
                  status: "resolved",
                  raw: ref,
                  item: prefix[0]
                };
              }

              if (prefix.length > 1) {
                return {
                  status: "ambiguous",
                  raw: ref,
                  matches: prefix
                };
              }

              // 3. Contains match — only accepted when unique.
              const contains =
                resolverEntries.filter(item => {
                  const club =
                    normalizeClubName(item.club);

                  const president =
                    normalizeClubName(item.president || "");

                  return (
                    club.includes(key) ||
                    president.includes(key)
                  );
                });

              if (contains.length === 1) {
                return {
                  status: "resolved",
                  raw: ref,
                  item: contains[0]
                };
              }

              if (contains.length > 1) {
                return {
                  status: "ambiguous",
                  raw: ref,
                  matches: contains
                };
              }

              return {
                status: "unresolved",
                raw: ref
              };
            };

            const directiveParts =
              directiveText
                .split(";")
                .map(x => x.trim())
                .filter(Boolean);

            const rebuiltParts = [];

            for (const part of directiveParts) {

              let action = null;
              let rawReference = null;

              let m =
                part.match(/^skip\s+(.+)$/i);

              if (m) {
                action = "skip";
                rawReference = m[1].trim();
              }

              if (!action) {
                m =
                  part.match(/^(.+?)\s+must\s+win$/i);

                if (m) {
                  action = "mustWin";
                  rawReference = m[1].trim();
                }
              }

              if (!action) {
                m =
                  part.match(/^must\s+win\s+(.+)$/i);

                if (m) {
                  action = "mustWin";
                  rawReference = m[1].trim();
                }
              }

              if (!action) {
                m =
                  part.match(/^(.+?)\s+must\s+lose$/i);

                if (m) {
                  action = "mustLose";
                  rawReference = m[1].trim();
                }
              }

              if (!action) {
                m =
                  part.match(/^must\s+lose\s+(.+)$/i);

                if (m) {
                  action = "mustLose";
                  rawReference = m[1].trim();
                }
              }

              if (!action) {
                rebuiltParts.push(part);
                continue;
              }

              const resolved =
                resolveHsReference(rawReference);

              if (resolved.status === "resolved") {

                const canonical =
                  resolved.item.club;

                const actionLabel =
                  action === "skip"
                    ? "Skip"
                    : action === "mustWin"
                      ? "Must Win"
                      : "Must Lose";

                const requestedDisplay =
                  normalizeClubName(rawReference) !==
                  normalizeClubName(canonical)
                    ? `**${rawReference}** → **${canonical}**`
                    : `**${canonical}**`;

                requestedControlLines.push(
                  `• ${actionLabel}: ${requestedDisplay}`
                );

                if (
                  normalizeClubName(rawReference) !==
                  normalizeClubName(canonical)
                ) {
                  resolvedReferenceLines.push(
                    `• **${rawReference}** → **${canonical}**`
                  );
                }

                if (action === "skip") {
                  rebuiltParts.push(
                    `skip ${canonical}`
                  );
                }

                if (action === "mustWin") {
                  rebuiltParts.push(
                    `${canonical} must win`
                  );
                }

                if (action === "mustLose") {
                  rebuiltParts.push(
                    `${canonical} must lose`
                  );
                }

                continue;
              }

              if (resolved.status === "ambiguous") {

                const names =
                  [...new Set(
                    resolved.matches
                      .map(item => item.club)
                  )]
                    .slice(0, 8)
                    .join(", ");

                referenceIssueLines.push(
                  `• **${rawReference}** — ambiguous. Matches: ${names}`
                );

                continue;
              }

              referenceIssueLines.push(
                `• **${rawReference}** — no matching club or president found.`
              );
            }

            directiveText =
              rebuiltParts.join("; ");

            const escapeHsRegex = value =>
              String(value || "")
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            const directiveEntries =
              (leaderboardData || [])
                .filter(item => item?.club)
                .slice()
                .sort(
                  (a, b) =>
                    String(b.club || "").length -
                    String(a.club || "").length
                );

            for (const item of directiveEntries) {

              const aliases =
                [
                  String(item.club || "").trim(),
                  String(item.president || "").trim()
                ]
                .filter(Boolean)
                .sort((a, b) => b.length - a.length);

              let skipDetected = false;
              let winDetected = false;
              let loseDetected = false;

              for (const alias of aliases) {

                const token =
                  escapeHsRegex(alias);

                const skipRe =
                  new RegExp(
                    `(?:^|[;,]\\s*)skip\\s+${token}(?=\\s*(?:[;,]|$))`,
                    "i"
                  );

                const winReA =
                  new RegExp(
                    `(?:^|[;,]\\s*)${token}\\s+must\\s+win(?=\\s*(?:[;,]|$))`,
                    "i"
                  );

                const winReB =
                  new RegExp(
                    `(?:^|[;,]\\s*)must\\s+win\\s+${token}(?=\\s*(?:[;,]|$))`,
                    "i"
                  );

                const loseReA =
                  new RegExp(
                    `(?:^|[;,]\\s*)${token}\\s+must\\s+lose(?=\\s*(?:[;,]|$))`,
                    "i"
                  );

                const loseReB =
                  new RegExp(
                    `(?:^|[;,]\\s*)must\\s+lose\\s+${token}(?=\\s*(?:[;,]|$))`,
                    "i"
                  );

                if (skipRe.test(directiveText)) {
                  skipDetected = true;
                }

                if (
                  winReA.test(directiveText) ||
                  winReB.test(directiveText)
                ) {
                  winDetected = true;
                }

                if (
                  loseReA.test(directiveText) ||
                  loseReB.test(directiveText)
                ) {
                  loseDetected = true;
                }
              }

              const key =
                normalizeClubName(item.club);

              if (skipDetected) {
                skipSet.add(key);
                skipSet.add(item.club);
                skippedNames.push(item.club);
              }

              if (winDetected) {
                mustWinSet.add(key);
                mustWinSet.add(item.club);
                mustWinNames.push(item.club);
              }

              if (loseDetected) {
                mustLoseSet.add(key);
                mustLoseSet.add(item.club);
                mustLoseNames.push(item.club);
              }
            }

            // HS PHASE 4.4 — conflict validation
            const conflictLines = [];

            const skippedKeys =
              new Set(
                skippedNames.map(name =>
                  normalizeClubName(name)
                )
              );

            const mustWinKeys =
              new Set(
                mustWinNames.map(name =>
                  normalizeClubName(name)
                )
              );

            const mustLoseKeys =
              new Set(
                mustLoseNames.map(name =>
                  normalizeClubName(name)
                )
              );

            const conflictedKeys = new Set();

            for (const name of mustWinNames) {
              const key = normalizeClubName(name);

              if (mustLoseKeys.has(key)) {
                conflictLines.push(
                  `• **${name}** — cannot be both Must Win and Must Lose.`
                );
                conflictedKeys.add(key);
              }

              if (skippedKeys.has(key)) {
                conflictLines.push(
                  `• **${name}** — Skip conflicts with Must Win.`
                );
                conflictedKeys.add(key);
              }
            }

            for (const name of mustLoseNames) {
              const key = normalizeClubName(name);

              if (skippedKeys.has(key)) {
                conflictLines.push(
                  `• **${name}** — Skip conflicts with Must Lose.`
                );
                conflictedKeys.add(key);
              }
            }

            // Remove conflicting win/lose controls before optimizer.
            for (const key of conflictedKeys) {
              for (const name of mustWinNames) {
                if (normalizeClubName(name) === key) {
                  mustWinSet.delete(name);
                  mustWinSet.delete(key);
                }
              }

              for (const name of mustLoseNames) {
                if (normalizeClubName(name) === key) {
                  mustLoseSet.delete(name);
                  mustLoseSet.delete(key);
                }
              }
            }

            // Skip still removes club from candidate pool.
            for (const name of skippedNames) {
              mustWinSet.delete(
                normalizeClubName(name)
              );
              mustWinSet.delete(name);

              mustLoseSet.delete(
                normalizeClubName(name)
              );
              mustLoseSet.delete(name);
            }

            const candidates =
              derbyRangeCandidates(
                minElo,
                maxElo,
                skipSet
              );

            // HS PHASE 4.2 — validate requested controls
            // against the actual available candidate pool.
            const candidateKeys =
              new Set(
                candidates.map(item =>
                  normalizeClubName(item.club)
                )
              );

            const appliedMustWinNames =
              mustWinNames.filter(name =>
                candidateKeys.has(
                  normalizeClubName(name)
                )
              );

            const appliedMustLoseNames =
              mustLoseNames.filter(name =>
                candidateKeys.has(
                  normalizeClubName(name)
                )
              );

            const rejectedMustWinNames =
              mustWinNames.filter(name => {
                const key =
                  normalizeClubName(name);

                return (
                  !candidateKeys.has(key) &&
                  !conflictedKeys.has(key)
                );
              });

            const rejectedMustLoseNames =
              mustLoseNames.filter(name => {
                const key =
                  normalizeClubName(name);

                return (
                  !candidateKeys.has(key) &&
                  !conflictedKeys.has(key)
                );
              });

            // Only valid controls are passed to optimizer.
            mustWinSet.clear();
            mustLoseSet.clear();

            for (const name of appliedMustWinNames) {
              mustWinSet.add(name);
              mustWinSet.add(
                normalizeClubName(name)
              );
            }

            for (const name of appliedMustLoseNames) {
              mustLoseSet.add(name);
              mustLoseSet.add(
                normalizeClubName(name)
              );
            }

            if (!candidates.length) {

              const rangeClubs =
                (leaderboardData || [])
                  .filter(item =>
                    item?.club &&
                    Number(item.elo) >= minElo &&
                    Number(item.elo) <= maxElo
                  )
                  .sort(
                    (a, b) =>
                      Number(b.elo) -
                      Number(a.elo)
                  );

              const isolationSources =
                new Map();

              for (const club of rangeClubs) {

                let source = "Unknown isolation";

                const op =
                  getWarOperation(club.club);

                if (
                  op &&
                  String(op.status || "AVAILABLE")
                    .toUpperCase() !== "AVAILABLE"
                ) {
                  source =
                    op.matchId
                      ? `${normalizeMatchId(op.matchId)} — ${warStateLabel(op.status)}`
                      : `War Operation — ${warStateLabel(op.status)}`;
                } else {

                  const timer =
                    (activeFowTimers || [])
                      .find(t =>
                        t?.sent?.end !== true &&
                        Array.isArray(t?.clubs) &&
                        t.clubs.some(c =>
                          normalizeClubName(c?.club) ===
                          normalizeClubName(club.club)
                        )
                      );

                  if (timer) {
                    source =
                      timer.matchId
                        ? normalizeMatchId(timer.matchId)
                        : "Active Timer";
                  }
                }

                isolationSources.set(
                  source,
                  (isolationSources.get(source) || 0) + 1
                );
              }

              const breakdown =
                [...isolationSources.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(
                    ([source, count]) =>
                      `• **${source}** — ${count} club${count === 1 ? "" : "s"}`
                  )
                  .join("\n");

              const zeroRequestedControlText =
                requestedControlLines.length
                  ? `\n**📋 Requested Controls**\n${requestedControlLines.join("\n")}\n`
                  : "";

              const zeroResolvedText =
                resolvedReferenceLines.length
                  ? `\n**🔎 Resolved References**\n${resolvedReferenceLines.join("\n")}\n`
                  : "";

              const zeroReferenceIssueText =
                referenceIssueLines.length
                  ? `\n**⚠️ Club Reference Issues**\n${referenceIssueLines.join("\n")}\n`
                  : "";

              const zeroConflictText =
                conflictLines.length
                  ? `\n**⚠️ Conflicting Controls**\n${conflictLines.join("\n")}\n`
                  : "";

              response =
                `⚔️ **HS Matchmaking Preview — Phase 4.9**\n\n` +
                `🎯 Range: **${minElo} - ${maxElo}**\n` +
                `🏰 Clubs in range: **${rangeClubs.length}**\n` +
                `🟢 Available: **0**\n` +
                `🚫 Isolated: **${rangeClubs.length}**\n` +
                zeroRequestedControlText +
                zeroResolvedText +
                zeroReferenceIssueText +
                zeroConflictText +
                `\n**Isolation Sources**\n` +
                `${breakdown || "• No isolation source found"}\n\n` +
                `No matchmaking preview generated because all clubs in this range are currently isolated.\n\n` +
                `🔒 Read-only preview. Nothing was changed.`;

            } else {

              const result =
                optimizeMatchmaking(
                  candidates,
                  mustWinSet,
                  mustLoseSet
                );

              const pairs =
                Array.isArray(result?.pairs)
                  ? result.pairs
                  : [];

              const unmatched =
                Array.isArray(result?.unmatched)
                  ? result.unmatched
                  : [];

                if (hsDraftId) {
                  const draft = hsControlRoomDrafts.get(hsDraftId);
                  if (draft) {
                    draft.previewResult = result;
                    draft.previewSkipped = [...skipSet].map(key => candidates.find(c => normalizeClubName(c.club) === key)).filter(Boolean);

                    // HS PHASE 6.2 — preserve resolved controls for refresh
                    draft.skipKeys = [...skipSet];
                    draft.mustWinKeys = [...mustWinSet];
                    draft.mustLoseKeys = [...mustLoseSet];

                    draft.updatedAt = Date.now();
                  }
                }

              const lines = [];

              // Display only — highest ELO pair first
              const displayPairs = [...pairs].sort((x, y) => {
                const xHigh = Math.max(
                  Number(x?.a?.elo) || 0,
                  Number(x?.b?.elo) || 0
                );
                const yHigh = Math.max(
                  Number(y?.a?.elo) || 0,
                  Number(y?.b?.elo) || 0
                );
                return yHigh - xHigh;
              });

              displayPairs.forEach((pair, index) => {

                if (!pair?.a || !pair?.b) return;

                const high =
                  Number(pair.a.elo) >= Number(pair.b.elo)
                    ? pair.a
                    : pair.b;

                const low =
                  high === pair.a
                    ? pair.b
                    : pair.a;

                const gap =
                  Math.abs(
                    Number(high.elo) -
                    Number(low.elo)
                  );

                const highKey =
                  normalizeClubName(high.club);

                const lowKey =
                  normalizeClubName(low.club);

                let winner = high;

                if (
                  mustWinSet.has(lowKey) ||
                  mustLoseSet.has(highKey)
                ) {
                  winner = low;
                }

                if (
                  mustWinSet.has(highKey) ||
                  mustLoseSet.has(lowKey)
                ) {
                  winner = high;
                }

                let rationale =
                  `Valid pairing within ${MATCHMAKING_MAX_GAP} ELO.`;

                if (mustWinSet.has(highKey)) {
                  rationale =
                    `Must Win constraint applied to ${high.club}.`;
                } else if (mustWinSet.has(lowKey)) {
                  rationale =
                    `Must Win constraint applied to ${low.club}.`;
                } else if (mustLoseSet.has(highKey)) {
                  rationale =
                    `Must Lose constraint applied to ${high.club}.`;
                } else if (mustLoseSet.has(lowKey)) {
                  rationale =
                    `Must Lose constraint applied to ${low.club}.`;
                }

                lines.push(
                  `**${index + 1}.** ${high.club} (${high.elo}) - ${high.president || "Not Set"}\n` +
                  `vs\n` +
                  `${low.club} (${low.elo}) - ${low.president || "Not Set"}\n` +
                  `Gap: **${gap}**`
                );
              });

              const controlLines = [];
              const rejectedControlLines = [];

              if (skippedNames.length) {
                controlLines.push(
                  `⏭️ Skip: **${skippedNames.join(", ")}**`
                );
              }

              if (appliedMustWinNames.length) {
                controlLines.push(
                  `🏆 Must Win: **${appliedMustWinNames.join(", ")}**`
                );
              }

              if (appliedMustLoseNames.length) {
                controlLines.push(
                  `🔻 Must Lose: **${appliedMustLoseNames.join(", ")}**`
                );
              }

              const hsUnavailableReason = name => {

                const op =
                  getWarOperation(name);

                if (
                  op &&
                  String(op.status || "AVAILABLE")
                    .toUpperCase() !== "AVAILABLE"
                ) {
                  return op.matchId
                    ? `${normalizeMatchId(op.matchId)} — ${warStateLabel(op.status)}`
                    : `War Operation — ${warStateLabel(op.status)}`;
                }

                const timer =
                  (activeFowTimers || [])
                    .find(t =>
                      t?.sent?.end !== true &&
                      Array.isArray(t?.clubs) &&
                      t.clubs.some(c =>
                        normalizeClubName(c?.club) ===
                        normalizeClubName(name)
                      )
                    );

                if (timer) {

                  if (timer.matchId) {
                    const linkedOp =
                      getWarOperation(name);

                    if (
                      linkedOp &&
                      String(linkedOp.status || "AVAILABLE")
                        .toUpperCase() !== "AVAILABLE"
                    ) {
                      return `${normalizeMatchId(timer.matchId)} — ${warStateLabel(linkedOp.status)}`;
                    }

                    return `${normalizeMatchId(timer.matchId)} — ACTIVE TIMER`;
                  }

                  return "Active Timer";
                }

                const dbClub =
                  (leaderboardData || [])
                    .find(item =>
                      item?.club &&
                      normalizeClubName(item.club) ===
                      normalizeClubName(name)
                    );

                if (
                  dbClub &&
                  (
                    Number(dbClub.elo) < minElo ||
                    Number(dbClub.elo) > maxElo
                  )
                ) {
                  return `Outside requested ELO range ${minElo}-${maxElo}`;
                }

                return "Not available in current matchmaking pool";
              };

              for (const name of rejectedMustWinNames) {

                const reason =
                  hsUnavailableReason(name);

                rejectedControlLines.push(
                  `• **${name}** — Must Win not applied\n  Reason: **${reason}**`
                );
              }

              for (const name of rejectedMustLoseNames) {

                const reason =
                  hsUnavailableReason(name);

                rejectedControlLines.push(
                  `• **${name}** — Must Lose not applied\n  Reason: **${reason}**`
                );
              }

              const requestedControlText =
                requestedControlLines.length
                  ? `\n**📋 Requested Controls**\n${requestedControlLines.join("\n")}\n`
                  : "";

              const controlText =
                controlLines.length
                  ? `\n**HS Controls**\n${controlLines.join("\n")}\n`
                  : "";

              const resolvedReferenceText =
                resolvedReferenceLines.length
                  ? `\n**🔎 Resolved References**\n${resolvedReferenceLines.join("\n")}\n`
                  : "";

              const referenceIssueText =
                referenceIssueLines.length
                  ? `\n**⚠️ Club Reference Issues**\n${referenceIssueLines.join("\n")}\n`
                  : "";

              const rejectedControlText =
                rejectedControlLines.length
                  ? `\n**⚠️ Controls Not Applied**\n${rejectedControlLines.join("\n")}\n`
                  : "";

              const conflictText =
                conflictLines.length
                  ? `\n**⚠️ Conflicting Controls**\n${conflictLines.join("\n")}\n`
                  : "";

              response =
                `⚔️ **HS Matchmaking Preview — Phase 4.9**\n\n` +
                `🎯 Range: **${minElo} - ${maxElo}**\n` +
                `🏰 Available Derby Clubs: **${candidates.length}**\n` +
                `🤝 Matched Clubs: **${pairs.length * 2}**\n` +
                `⚔️ Pairs: **${pairs.length}**\n` +
                `➖ Unmatched: **${unmatched.length}**\n` +
                `📏 Maximum Gap: **${MATCHMAKING_MAX_GAP}**\n` +
                requestedControlText +
                controlText +
                referenceIssueText +
                conflictText +
                rejectedControlText +
                `\n` +
                lines.join("\n\n");

              if (unmatched.length) {

                // HS PHASE 4.7 — explain unmatched clubs
                // Diagnostic only. Does not alter optimizer output.
                const pairedKeys = new Set();

                for (const pair of pairs) {
                  if (pair?.a?.club) {
                    pairedKeys.add(
                      normalizeClubName(pair.a.club)
                    );
                  }

                  if (pair?.b?.club) {
                    pairedKeys.add(
                      normalizeClubName(pair.b.club)
                    );
                  }
                }

                const unmatchedLines =
                  unmatched.map(club => {

                    const clubKey =
                      normalizeClubName(club.club);

                    const eligible =
                      candidates
                        .filter(other =>
                          other?.club &&
                          normalizeClubName(other.club) !== clubKey
                        )
                        .map(other => ({
                          ...other,
                          gap: Math.abs(
                            Number(club.elo) -
                            Number(other.elo)
                          )
                        }))
                        .filter(other =>
                          other.gap <= MATCHMAKING_MAX_GAP
                        )
                        .sort(
                          (a, b) =>
                            a.gap - b.gap ||
                            Number(b.elo) - Number(a.elo)
                        );

                    let reason;

                    if (!eligible.length) {

                      const nearestOutside =
                        candidates
                          .filter(other =>
                            other?.club &&
                            normalizeClubName(other.club) !== clubKey
                          )
                          .map(other => ({
                            ...other,
                            gap: Math.abs(
                              Number(club.elo) -
                              Number(other.elo)
                            )
                          }))
                          .sort(
                            (a, b) =>
                              a.gap - b.gap ||
                              Number(b.elo) - Number(a.elo)
                          )[0];

                      if (nearestOutside) {
                        reason =
                          `No opponent within ${MATCHMAKING_MAX_GAP} ELO.\n` +
                          `Nearest available opponent: ${nearestOutside.club} (${nearestOutside.elo})\n` +
                          `Gap: ${nearestOutside.gap}`;
                      } else {
                        reason =
                          `No opponent within ${MATCHMAKING_MAX_GAP} ELO.`;
                      }

                    } else {

                      const unusedEligible =
                        eligible.filter(other =>
                          !pairedKeys.has(
                            normalizeClubName(other.club)
                          )
                        );

                      if (!unusedEligible.length) {

                        const nearest =
                          eligible[0];

                        reason =
                          `Nearest eligible opponent: ${nearest.club} (${nearest.elo}), gap ${nearest.gap} — already used in selected pairing.`;

                      } else {

                        const nearest =
                          unusedEligible[0];

                        reason =
                          `Compatible opponent remained (${nearest.club}, gap ${nearest.gap}), but the optimizer left this club unmatched under the current pairing constraints.`;
                      }
                    }

                    return (
                      `**${club.club} (${club.elo})**\n` +
                      `Reason: ${reason}`
                    );
                  });

                response +=
                  `\n\n➖ **Unmatched**\n` +
                  unmatchedLines.join("\n\n");
              }

              if (hsDestination) {
                response +=
                  `\n\n🎛️ **Phase 6 — AI Control Room**\n` +
                  `📤 Destination: **${hsDestination.label}**`;
              }


              response +=
                `\n\n🔒 **READ-ONLY PREVIEW**\n` +
                `No Match ID created. No database changes.`;

            }

          } else {

            response =
              `⚔️ **Matchmaking Help**\n\n` +
              `Automatic: **/matchmaking**\n` +
              `Manual: **/manual_matchmaking**\n` +
              `Saved plans/status: **/match_list**\n\n` +
              `Preview example: **@HS matchmaking 5600-5900**\n\n` +
              `🔒 Preview only.`;
          }

        } else if (
          /\bhs\d{1,6}\b/i.test(q)
        ) {
          // HS-03.2: Match ID live lookup — READ ONLY
          const matchIdMatch = q.match(/\bhs\d{1,6}\b/i);
          const matchId = matchIdMatch
            ? normalizeMatchId(matchIdMatch[0])
            : null;

          const plan = matchId
            ? getMatchPlan(matchId)
            : null;

          if (!plan) {
            response =
              `🆔 **Match ID Lookup**\n\n` +
              `Match ID **${matchId || 'Unknown'}** was not found.\n\n` +
              `🔒 Read-only — no production data changed.`;

          } else if (
            String(plan.status || '').toUpperCase() === 'CANCELLED'
          ) {
            response =
              `🆔 **HS Match ID Status — Read Only**\n\n` +
              `Match ID: **${plan.id || matchId}**\n` +
              `Status: **❌ CANCELLED**\n` +
              (
                plan.cancelledAt
                  ? `Cancelled: <t:${Math.floor(Number(plan.cancelledAt) / 1000)}:F>\n`
                  : ''
              ) +
              (
                plan.cancelledBy
                  ? `Cancelled by: <@${plan.cancelledBy}>\n`
                  : ''
              ) +
              `\nLifecycle tracking has stopped.\n` +
              `Historical record is retained in Supabase.\n\n` +
              `🔒 Read-only — no production data changed.`;

          } else if (
            String(plan.status || '').toUpperCase() === 'CLOSED'
          ) {
            response =
              `🆔 **HS Match ID Status — Read Only**\n\n` +
              `Match ID: **${plan.id || matchId}**\n` +
              `Status: **✅ CLOSED**\n` +
              (
                plan.closedAt
                  ? `Closed: <t:${Math.floor(Number(plan.closedAt) / 1000)}:F>\n`
                  : ''
              ) +
              `\n✅ War lifecycle completed\n` +
              `✅ Match ID released\n` +
              `✅ No active Match-ID timer\n` +
              `✅ No active Match-ID war operation\n\n` +
              `🔒 Read-only — no production data changed.`;

          } else {
            const clubs = Array.isArray(plan.clubs)
              ? plan.clubs
              : [];

            const unique = [];
            const seen = new Set();

            for (const c of clubs) {
              const name = String(c?.club || '').trim();
              if (!name) continue;

              const key = normalizeClubName(name);
              if (seen.has(key)) continue;

              seen.add(key);

              const db = (leaderboardData || [])
                .find(x => areEquivalentClubNames(x.club, name));

              const rawOp = getWarOperation(name);

              const op =
                rawOp &&
                normalizeMatchId(rawOp?.matchId || '') === matchId
                  ? rawOp
                  : null;

              const timer = (activeFowTimers || [])
                .find(t =>
                  normalizeMatchId(t?.matchId || '') === matchId &&
                  !['completed', 'cancelled'].includes(
                    String(t?.status || '').toLowerCase()
                  ) &&
                  t?.sent?.end !== true &&
                  Array.isArray(t?.clubs) &&
                  t.clubs.some(tc =>
                    normalizeClubName(tc?.club) === key
                  )
                );

              // Match-ID scoped availability:
              // Do NOT use global isClubMatchmakingAvailable() here,
              // because the same club may be isolated by another Match ID.
              const scopedIsolated =
                Boolean(op) ||
                Boolean(timer);

              const available =
                !scopedIsolated;

              unique.push({
                club: db?.club || name,
                elo: Number(db?.elo ?? c?.elo ?? 0),
                president:
                  db?.president ||
                  c?.president ||
                  '',
                state:
                  op?.status
                    ? warStateLabel(op.status)
                    : timer
                      ? '🚫 TIMER ISOLATED'
                      : '🟢 RELEASED',
                isolated: scopedIsolated,
                event:
                  op?.eventType
                    ? warEventLabel(op.eventType)
                    : timer?.operationalMode
                      ? warEventLabel(timer.operationalMode)
                      : null,
                timer:
                  timer || null
              });
            }

            const isolatedCount =
              unique.filter(x => x.isolated).length;

            const availableCount =
              unique.filter(x => !x.isolated).length;

            const lines = unique
              .slice(0, 20)
              .map((x, i) => {
                const state =
                  x.isolated
                    ? '🚫'
                    : '🟢';

                return (
                  `${i + 1}. ${state} **${x.club}**` +
                  `${x.elo ? ` (${x.elo})` : ''}` +
                  ` — ${x.state}` +
                  `${x.event ? ` • ${x.event}` : ''}`
                );
              });

            response =
              `🆔 **HS Match ID Live Status — Read Only**\n\n` +
              `Match ID: **${plan.id || matchId}**\n` +
              `Status: **${
                plan.status
                  ? String(plan.status).toUpperCase()
                  : isolatedCount > 0
                    ? 'ACTIVE'
                    : 'PENDING'
              }**\n` +
              `Clubs: **${unique.length}**\n` +
              `🟢 Available: **${availableCount}**\n` +
              `🚫 Isolated: **${isolatedCount}**\n\n` +
              (
                lines.length
                  ? lines.join('\n')
                  : 'No clubs were found in this Match ID.'
              ) +
              (
                unique.length > 20
                  ? `\n\n…and ${unique.length - 20} more club(s).`
                  : ''
              ) +
              `\n\n🔒 Read-only — HS did not modify Match ID, ELO, War Monitor, timers, isolation or Supabase.`;
          }

        } else if (
          /isolation|isolated|isolate|\\bstatus\\b|\\bcheck\\b/.test(q)
        ) {
          // HS-03: LIVE READ-ONLY isolation / war status lookup.
          // Supports both a single-club lookup and a live list of all clubs
          // currently unavailable to matchmaking.
          reloadLatestDatabase();

          const qNorm = normalizeClubName(q);

          const mentionedClub = (leaderboardData || [])
            .filter(c => c?.club)
            .map(c => ({
              ...c,
              _norm: normalizeClubName(c.club)
            }))
            .filter(c => c._norm && qNorm.includes(c._norm))
            .sort((a, b) => b._norm.length - a._norm.length)[0] || null;

          const hsIsolationListRequest =
            !mentionedClub &&
            /\b(?:list|show|send|which|what|all|clubs?)\b/i.test(q) &&
            /\b(?:isolation|isolated|isolate|unavailable)\b/i.test(q);

          if (hsIsolationListRequest) {
            const isolatedClubs = (leaderboardData || [])
              .filter(item =>
                item?.club &&
                !isClubMatchmakingAvailable(item.club)
              )
              .map(item => {
                const op = getWarOperation(item.club);
                const clubKey = normalizeClubName(item.club);
                const timer = (activeFowTimers || []).find(t =>
                  !['completed', 'cancelled'].includes(
                    String(t?.status || '').toLowerCase()
                  ) &&
                  t?.sent?.end !== true &&
                  Array.isArray(t?.clubs) &&
                  t.clubs.some(c =>
                    normalizeClubName(c?.club) === clubKey
                  )
                );

                const state = op?.status
                  ? warStateLabel(op.status)
                  : timer
                    ? String(timer.type || timer.timerType || 'TIMER ISOLATED')
                    : 'ISOLATED';

                return {
                  club: item.club,
                  elo: Number(item.elo) || 0,
                  state
                };
              })
              .sort(
                (a, b) =>
                  b.elo - a.elo ||
                  a.club.localeCompare(b.club)
              );

            const isolationLines = isolatedClubs.map(
              (item, index) =>
                `${index + 1}. **${item.club}** (${item.elo}) — ${item.state}`
            );

            response =
              `🚫 **HS Live Isolation List**\n\n` +
              (
                isolationLines.length
                  ? isolationLines.join("\n")
                  : "No clubs are currently isolated."
              ) +
              `\n\nTotal Isolated: **${isolatedClubs.length}**\n\n` +
              `🔒 Live operational state • Read-only`;

          } else if (!mentionedClub) {
            response =
              `🚫 **Live Isolation Status**\n\n` +
              `I couldn't identify a club name from your message.\n\n` +
              `Try:\n` +
              `• @HS why FoW Neverland still isolated?\n` +
              `• @HS check isolation FoW Mystic Mages\n` +
              `• @HS send me list club under isolation\n\n` +
              `🔒 Read-only — no production state changed.`;

          } else {
            const club = mentionedClub.club;
            const op = getWarOperation(club);

            const clubKey = normalizeClubName(club);

            const timers = (activeFowTimers || [])
              .filter(t =>
                !['completed', 'cancelled'].includes(
                  String(t?.status || '').toLowerCase()
                ) &&
                t?.sent?.end !== true &&
                Array.isArray(t?.clubs) &&
                t.clubs.some(c =>
                  normalizeClubName(c?.club) === clubKey
                )
              );

            const timer = timers[0] || null;

            const matchmakingAvailable =
              isClubMatchmakingAvailable(club);

            const status =
              op?.status
                ? warStateLabel(op.status)
                : matchmakingAvailable
                  ? '🟢 AVAILABLE'
                  : '🚫 TIMER ISOLATED';

            const isolated =
              !matchmakingAvailable;

            const matchId =
              op?.matchId ||
              timer?.matchId ||
              null;

            const event =
              op?.eventType
                ? warEventLabel(op.eventType)
                : timer?.operationalMode
                  ? warEventLabel(timer.operationalMode)
                  : 'Not Set';

            const details = [];

            if (op?.preparationEndAt) {
              details.push(
                `⏳ Preparation ends: <t:${Math.floor(Number(op.preparationEndAt) / 1000)}:R>`
              );
            }

            if (op?.nextReminderAt) {
              details.push(
                `🔔 Next reminder: <t:${Math.floor(Number(op.nextReminderAt) / 1000)}:R>`
              );
            }

            if (op?.coolingEndAt) {
              details.push(
                `🧊 Cooling ends: <t:${Math.floor(Number(op.coolingEndAt) / 1000)}:R>`
              );
            }

            if (timer?.endAt) {
              details.push(
                `⏱️ Active timer ends: <t:${Math.floor(Number(timer.endAt) / 1000)}:R>`
              );
            }

            if (timer) {
              details.push(
                `⏱️ Timer: **${String(timer.type || timer.timerType || 'Active Timer')}**`
              );
            }

            let reason = '';

            if (op && String(op.status || '').toUpperCase() === 'PREPARATION') {
              reason =
                'The club is still in the preparation stage.';
            } else if (
              op &&
              ['WAR_ACTIVE', 'KO_ACTIVE'].includes(
                String(op.status || '').toUpperCase()
              )
            ) {
              reason =
                'The club is still inside an active war/KO state.';
            } else if (
              op &&
              String(op.status || '').toUpperCase() ===
                'AWAITING_COOLING_TIME'
            ) {
              reason =
                'The war has progressed to Normal cooling setup and is waiting for cooling time.';
            } else if (
              op &&
              String(op.status || '').toUpperCase() ===
                'COOLING_DOWN'
            ) {
              reason =
                'The club is still inside its cooling-down period.';
            } else if (timer && !op) {
              reason =
                'An active FoW timer is still isolating this club from matchmaking.';
            } else if (!isolated) {
              reason =
                'No active isolation was detected. The club is currently available for matchmaking.';
            } else {
              reason =
                'The club is currently unavailable for matchmaking based on its live operational state.';
            }

            response =
              `🔎 **HS Live Status — Read Only**\n\n` +
              `🏰 **${club}** (${mentionedClub.elo})\n` +
              `👤 ${mentionedClub.president || 'Not Set'}\n\n` +
              `🚫 Isolation: **${isolated ? 'ACTIVE' : 'NOT ACTIVE'}**\n` +
              `⚔️ State: **${status}**\n` +
              `⚡ Event: **${event}**\n` +
              `🆔 Match ID: **${matchId || 'None'}**\n` +
              `${details.length ? `\n${details.join('\n')}\n` : '\n'}` +
              `\n**Why:**\n${reason}\n\n` +
              `🔒 Read-only — HS did not change War Monitor, timers, isolation, ELO, Match ID or Supabase.`;
          }

        } else if (
          /elo|leaderboard/.test(q) ||
          /\btop\s+\d{1,3}\b/i.test(q) ||
          (/\b(?:club|clubs)\b/i.test(q) &&
            /\b(?:berapa|count|how many|jumlah|list|show)\b/i.test(q) &&
            (/\b(?:between|antara)\b/i.test(q) ||
              /\b\d{4,5}\s*(?:-|–|—|to|hingga)\s*\d{4,5}\b/i.test(q))) ||
          (/\bderby\b/i.test(q) &&
            /\b(?:club|clubs|excluded|top|berapa|how many)\b/i.test(q))
        ) {
          // HS PHASE 5.1 — LIVE ELO LOOKUP (READ ONLY)
          // Resolve a known club or president/pusher mentioned in the message.
            reloadLatestDatabase();

            const hsDerbyLeaderboard =
              /\bderby\b/i.test(q) && /\bleaderboard\b/i.test(q);
            const hsExcludedDerby =
              /\bexcluded\b/i.test(q) && /\bderby\b/i.test(q);
            const hsGeneralLeaderboard =
              /\bleaderboard\b/i.test(q) && !hsDerbyLeaderboard && !hsExcludedDerby;

            const hsLeaderboardRange =
              q.match(/\b(\d{4,5})\s*(?:-|–|—|to|hingga)\s*(\d{4,5})\b/i);
            const hsTopMatch =
              q.match(/\btop\s+(\d{1,3})\b/i);

          // HS LIVE LEADERBOARD READ V1 — unique insertion point
          const hsBetweenRange =
            q.match(/\b(?:between|antara)\s+(\d{4,5})\s+(?:and|dan|hingga|to)\s+(\d{4,5})\b/i);

          const hsRangeMatch =
            hsLeaderboardRange || hsBetweenRange;

          const hsCountRequest =
            /\b(?:berapa|count|how many|jumlah)\b/i.test(q);

          const hsDerbyRequest =
            /\bderby\b/i.test(q);

          const hsListRequest =
            hsGeneralLeaderboard ||
            hsDerbyLeaderboard ||
            hsExcludedDerby ||
            Boolean(hsTopMatch) ||
            hsCountRequest ||
            (Boolean(hsRangeMatch) &&
              /\b(?:list|show)\b/i.test(q));

          const qNorm = normalizeClubName(q);

          const hsContainsPresidentToken = president => {
            const value = String(president || "").trim();
            if (!value) return false;

            const escaped = value.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            );

            return new RegExp(
              `(^|[^a-z0-9])${escaped}($|[^a-z0-9])`,
              "i"
            ).test(q);
          };

          const hsStripClubPrefix = value =>
            String(value || "")
              .replace(/^(?:fow|forceofwar)/i, "");

          const hsClubLookupText = String(q || "")
            .replace(/\b(?:show|tell|give|find|check|what|whats|what's|is|the|me|club|clubs|elo|rating|rank|ranking|please|pls)\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

          const hsClubLookupNorm =
            normalizeClubName(hsClubLookupText);

          const hsLookupEntries = (leaderboardData || [])
            .filter(item => item?.club)
            .map(item => {
              const clubNorm = normalizeClubName(item.club);
              return {
                item,
                clubNorm,
                shortNorm: hsStripClubPrefix(clubNorm),
                presidentLength: String(item.president || "").length,
                presidentMatched: hsContainsPresidentToken(item.president)
              };
            });

          let mentionedClub = hsLookupEntries
            .filter(entry =>
              (entry.clubNorm && qNorm.includes(entry.clubNorm)) ||
              entry.presidentMatched
            )
            .sort((a, b) =>
              Math.max(b.clubNorm.length, b.presidentLength) -
              Math.max(a.clubNorm.length, a.presidentLength)
            )[0]?.item || null;

          let hsClubSuggestions = [];

          if (!mentionedClub && hsClubLookupNorm) {
            const hsPartialMatches = hsLookupEntries.filter(entry =>
              entry.shortNorm === hsClubLookupNorm ||
              entry.clubNorm === hsClubLookupNorm ||
              (hsClubLookupNorm.length >= 4 &&
                entry.shortNorm.length >= 3 &&
                entry.shortNorm.includes(hsClubLookupNorm))
            );

            if (hsPartialMatches.length === 1) {
              mentionedClub = hsPartialMatches[0].item;
            } else if (hsPartialMatches.length > 1) {
              hsClubSuggestions = hsPartialMatches
                .sort((a, b) =>
                  Number(b.item.elo || 0) - Number(a.item.elo || 0)
                )
                .slice(0, 5)
                .map(entry => entry.item);
            }
          }

          const hsEditDistance = (a, b) => {
            const x = String(a || "");
            const y = String(b || "");
            const dp = Array.from(
              { length: x.length + 1 },
              () => Array(y.length + 1).fill(0)
            );
            for (let i = 0; i <= x.length; i++) dp[i][0] = i;
            for (let j = 0; j <= y.length; j++) dp[0][j] = j;
            for (let i = 1; i <= x.length; i++) {
              for (let j = 1; j <= y.length; j++) {
                dp[i][j] = Math.min(
                  dp[i - 1][j] + 1,
                  dp[i][j - 1] + 1,
                  dp[i - 1][j - 1] +
                    (x[i - 1] === y[j - 1] ? 0 : 1)
                );
              }
            }
            return dp[x.length][y.length];
          };

          if (
            !mentionedClub &&
            !hsClubSuggestions.length &&
            hsClubLookupNorm.length >= 5
          ) {
            hsClubSuggestions = hsLookupEntries
              .map(entry => {
                const target = entry.shortNorm || entry.clubNorm;
                const distance =
                  hsEditDistance(hsClubLookupNorm, target);
                const maxLength =
                  Math.max(hsClubLookupNorm.length, target.length) || 1;
                return {
                  item: entry.item,
                  score: 1 - distance / maxLength,
                  distance
                };
              })
              .filter(result =>
                result.score >= 0.72 &&
                result.distance <= 4
              )
              .sort((a, b) =>
                b.score - a.score ||
                a.distance - b.distance ||
                Number(b.item.elo || 0) - Number(a.item.elo || 0)
              )
              .slice(0, 5)
              .map(result => result.item);
          }

          if (hsListRequest) {
            let hsLiveRows = (leaderboardData || [])
              .filter(item => item?.club)
              .map(item => ({
                club: item.club,
                president: item.president || "Not Set",
                elo: Number(item.elo) || 0
              }));

            if (hsExcludedDerby) {
              hsLiveRows = (leaderboardData || [])
                .filter(item => item?.club && !isDerbyClub(item))
                .map(item => ({
                  club: item.club,
                  president: item.president || "Not Set",
                  elo: Number(item.elo) || 0
                }));
            } else if (hsDerbyRequest) {
              hsLiveRows = (leaderboardData || [])
                .filter(item => item?.club && isDerbyClub(item))
                .map(item => ({
                  club: item.club,
                  president: item.president || "Not Set",
                  elo: Number(item.elo) || 0
                }));
            }

            if (hsRangeMatch) {
              const rangeA = Number(hsRangeMatch[1]);
              const rangeB = Number(hsRangeMatch[2]);
              const rangeMin = Math.min(rangeA, rangeB);
              const rangeMax = Math.max(rangeA, rangeB);

              hsLiveRows = hsLiveRows.filter(
                item =>
                  item.elo >= rangeMin &&
                  item.elo <= rangeMax
              );
            }

            hsLiveRows.sort(
              (a, b) =>
                b.elo - a.elo ||
                a.club.localeCompare(b.club)
            );

            if (hsTopMatch) {
              const limit = Math.max(
                1,
                Math.min(100, Number(hsTopMatch[1]) || 20)
              );
              hsLiveRows = hsLiveRows.slice(0, limit);
            }

            const hsRangeLabel = hsRangeMatch
              ? ` • ELO ${Math.min(Number(hsRangeMatch[1]), Number(hsRangeMatch[2]))}-${Math.max(Number(hsRangeMatch[1]), Number(hsRangeMatch[2]))}`
              : "";

            if (hsCountRequest) {
              response =
                `📊 **${hsDerbyRequest ? "Derby " : ""}Club Count${hsRangeLabel}**\n\n` +
                `Total: **${hsLiveRows.length} club${hsLiveRows.length === 1 ? "" : "s"}**\n\n` +
                `🔒 Live database • Read-only`;
            } else {
              const hsTitle = hsExcludedDerby
                ? "Excluded Derby Clubs"
                : hsDerbyRequest
                  ? "Derby Leaderboard"
                  : "Live ELO Leaderboard";

              const hsLines = hsLiveRows.map(
                (item, index) =>
                  `${index + 1}. ${item.club} (${item.elo}) - ${item.president}`
              );

              response =
                `🏆 **${hsTitle}${hsRangeLabel}**\n` +
                `📊 Total: **${hsLiveRows.length}**\n\n` +
                `${hsLines.length ? hsLines.join("\n") : "No clubs found."}\n\n` +
                `🔒 Live database • Read-only`;
            }
          } else if (mentionedClub) {
            const sorted = getSortedLeaderboard();
            const rank =
              sorted.findIndex(item =>
                normalizeClubName(item.club) ===
                normalizeClubName(mentionedClub.club)
              ) + 1;

            response =
              `🏆 **HS Live ELO — Read Only**\n\n` +
              `🏰 **${mentionedClub.club}**\n` +
              `👤 ${mentionedClub.president || "Not Set"}\n` +
              `🏆 ELO: **${mentionedClub.elo}**\n` +
              `📊 Rank: **${rank > 0 ? `#${rank}` : "Not available"}**\n\n` +
              `🔒 Read-only — no ELO or production data changed.`;
          } else if (hsClubSuggestions.length) {
            const hsSuggestionLines = hsClubSuggestions.map(
              (item, index) =>
                `${index + 1}. **${item.club}** (${Number(item.elo) || 0}) - ${item.president || "Not Set"}`
            );

            if (hsClubSuggestions.length === 1) {
              response =
                `🔎 **Did you mean ${hsClubSuggestions[0].club}?**\n\n` +
                `${hsSuggestionLines[0]}\n\n` +
                `Please send the club name again to confirm.\n\n` +
                `🔒 Suggestion only — no data changed.`;
            } else {
              response =
                `🔎 **I found several similar clubs. Did you mean:**\n\n` +
                `${hsSuggestionLines.join("\n")}\n\n` +
                `Please send the club name again to confirm.\n\n` +
                `🔒 Suggestion only — no data changed.`;
            }
          } else {
            response =
              `🏆 **ELO Help**\n\n` +
              `I couldn't identify a specific club or president/pusher from your message.\n\n` +
              `Try:\n` +
              `• @HS what is the ELO for FoW Neverland?\n` +
              `• @HS ELO ASH2\n\n` +
              `Leaderboard: **/leaderboard**\n` +
              `Full download: **/download**\n` +
              `Range download: **/download_elo**\n\n` +
              `🔒 HS does not update ELO.`;
          }

        } else {
          // ========================================================
          // HS PHASE 6.1B — CONVERSATIONAL INTENT OBSERVATION
          // Understand natural FoW requests before generic AI chat.
          // IMPORTANT: this block does NOT execute production writes.
          // ========================================================
          const hsConversation =
            getHsConversationSession(message);

          const hsConversationIntent =
            await interpretHsConversationIntent(
              cleaned,
              hsConversation
            );

          if (
            hsConversationIntent &&
            hsConversationIntent.intent !== "unknown"
          ) {
            hsConversation.lastIntent =
              hsConversationIntent.intent;
            hsConversation.updatedAt = Date.now();

            if (
              hsConversationIntent.min_elo !== null &&
              hsConversationIntent.min_elo !== undefined &&
              hsConversationIntent.max_elo !== null &&
              hsConversationIntent.max_elo !== undefined &&
              Number.isFinite(Number(hsConversationIntent.min_elo)) &&
              Number.isFinite(Number(hsConversationIntent.max_elo))
            ) {
              hsConversation.lastRange = {
                min: Math.min(
                  Number(hsConversationIntent.min_elo),
                  Number(hsConversationIntent.max_elo)
                ),
                max: Math.max(
                  Number(hsConversationIntent.min_elo),
                  Number(hsConversationIntent.max_elo)
                )
              };
            }

            if (hsConversationIntent.club) {
              hsConversation.lastClub =
                String(hsConversationIntent.club);
            }

            if (hsConversationIntent.match_id) {
              hsConversation.lastMatchId =
                normalizeMatchId(
                  hsConversationIntent.match_id
                );
            }

            if (
              hsConversationIntent.requires_clarification
            ) {
              response =
                `❓ **HS needs clarification**\n\n` +
                `${hsConversationIntent.clarification_question ||
                  "Please clarify what you want me to do."}\n\n` +
                `🔒 No production data changed.`;

            } else if (
              hsConversationIntent.intent === "transition_event" ||
              hsConversationIntent.intent === "start_event" ||
              hsConversationIntent.intent === "end_event"
            ) {
              let eventIntent = hsConversationIntent;

              if (hsConversationIntent.intent === "start_event") {
                eventIntent = {
                  ...hsConversationIntent,
                  from_event: getNaturalControlOperationalMode(),
                  to_event: hsConversationIntent.event_type
                };
              } else if (hsConversationIntent.intent === "end_event") {
                eventIntent = {
                  ...hsConversationIntent,
                  from_event: getNaturalControlOperationalMode(),
                  to_event: "normal"
                };
              }

              const eventResult = prepareHsEventTransition(message,eventIntent);
              response=eventResult.response;
              if (eventResult.components?.length) hsReplyComponents=eventResult.components;
              if (eventResult.ok) {
                hsConversation.pendingAction={type:"event_transition",draftId:eventResult.draft.id};
                hsConversation.updatedAt=Date.now();
              }

            } else if (
              hsConversationIntent.intent === "set_destination"
            ) {
              const destinationResult =
                prepareHsConversationalDestination(
                  message,
                  hsConversationIntent.destination
                );

              response = destinationResult.response;

              if (
                Array.isArray(destinationResult.components) &&
                destinationResult.components.length
              ) {
                hsReplyComponents =
                  destinationResult.components;
              }

              if (destinationResult.ok) {
                hsConversation.activeDraftId =
                  destinationResult.draft.id;

                hsConversation.updatedAt = Date.now();

                console.log(
                  `🎛️ HS conversational destination attached • draft=${destinationResult.draft.id} • destination=${destinationResult.destination.key} • user=${message.author.id}`
                );
              }

            } else {
              const hsIntentSummary = [
                `Intent: **${hsConversationIntent.intent}**`,
                hsConversationIntent.destination
                  ? `Destination: **${hsConversationIntent.destination}**`
                  : null,
                hsConversation.lastRange
                  ? `ELO context: **${hsConversation.lastRange.min}-${hsConversation.lastRange.max}**`
                  : null,
                hsConversationIntent.club
                  ? `Club: **${hsConversationIntent.club}**`
                  : null,
                hsConversationIntent.match_id
                  ? `Match ID: **${normalizeMatchId(hsConversationIntent.match_id)}**`
                  : null
              ].filter(Boolean);

              response =
                `🧠 **HS Conversational Control — Observation Mode**\n\n` +
                `${hsIntentSummary.join("\n")}\n\n` +
                `✅ I understood the operational request.\n` +
                `🧪 Execution is not connected yet.\n` +
                `🔒 No production data changed.`;
            }

            console.log(
              `🧠 HS conversational intent • intent=${hsConversationIntent.intent} • confidence=${hsConversationIntent.confidence} • user=${message.author.id}`
            );
          } else {
            // HS PHASE 5 — HYBRID READ-ONLY AI FALLBACK
            // Used only when no FoW conversational intent was identified.
            let aiResult = await askHsGeminiReadOnly(cleaned);

          if (!aiResult?.ok) {
            console.log(
              `🧠 HS Gemini unavailable • reason=${aiResult?.reason || "unknown"} • trying OpenAI`
            );
            aiResult = await askHsOpenAIReadOnly(cleaned);
          }

          if (aiResult?.ok) {
            const provider =
              aiResult.provider === "OPENAI" ? "OpenAI" : "Gemini";

            response =
              `🧠 **AI Response — ${provider}**\n\n` +
              `${String(aiResult.text || "").slice(0, 1650)}\n\n` +
              `🔒 Read-only — no production data changed.`;

            console.log(
              `🧠 HS Hybrid response • provider=${aiResult.provider} • user=${message.author.id}`
            );
          } else {
            response =
              `👤 Access detected: **${access}**\n\n` +
              `I received:\n> ${cleaned.slice(0, 900)}\n\n` +
              `⚠️ AI providers are temporarily unavailable.\n` +
              `LOCAL HS functions are still available.\n\n` +
              `🔒 No production data changed.`;

            console.warn(
              `⚠️ HS Hybrid unavailable • final=${aiResult?.reason || "unknown"}`
            );
          }
          }
        }

        const hsFullResponse =
          `🤖 **HS Assistant — Phase 5 Hybrid**\n\n${response}`;
        const hsResponseChunks =
          splitDiscordText(hsFullResponse, 1900);

        for (let i = 0; i < hsResponseChunks.length; i++) {
          const payload = {
            content: hsResponseChunks[i],
            allowedMentions: {
              repliedUser: false
            },
            components:
              i === 0 ? hsReplyComponents : []
          };

          if (i === 0) {
            await message.reply(payload);
          } else {
            await message.channel.send(payload);
          }
        }

      } catch (error) {
        console.error(
          "❌ HS Phase 2 handler failed:",
          error
        );
      }

      // Never allow an @HS request in the test channel to fall through
      // into Natural Control or automatic ELO processing.
      return;
    }

    cleanupNaturalControlSessions();
    const naturalKey = aiCommandSessionKey(message.guildId, message.channelId);
    const naturalSession = naturalControlSessions.get(naturalKey);
    if (naturalSession && String(naturalSession.userId) === String(message.author.id)) {
      try {
        const handled = await handleNaturalControlMessage(message, naturalSession);
        if (handled) return;
      } catch (error) {
        console.error("❌ Natural control processing failed:", error);
        await message.reply(`❌ Natural control failed: **${String(error?.message||error||"Unknown error").slice(0,220)}**`).catch(()=>{});
        return;
      }
    }

    const lines =
      content
        .split(/\r?\n/)
        .map(
          line =>
            line.trim()
        )
        .filter(
          Boolean
        );

    // STRICT AUTO-UPDATE FORMAT ONLY:
    //   Club Name (ELO)
    // Anything else is ignored, including:
    //   Club Name (ELO) - President
    //   Club Name | President (ELO)
    //   Club A (ELO) vs Club B (ELO)
    // First accept ONLY the exact update shape: Club Name (ELO).
    // Invalid formats stay completely silent/ignored.
    const strictEloEntries = [];

    for (const line of lines) {
      const strictMatch = line.match(
        /^(.+?)\s*\(\s*(\d{4,5})\s*\)\s*$/
      );

      if (!strictMatch) {
        continue;
      }

      const clubField = strictMatch[1].trim();
      const elo = Number(strictMatch[2]);

      // Reject leaderboard/president/matchmaking-style text.
      if (
        clubField.includes("|") ||
        /\s+-\s+/.test(clubField) ||
        /\s+vs\s+/i.test(clubField)
      ) {
        continue;
      }

      strictEloEntries.push({
        line,
        club: clubField,
        elo,
        known: findClubIndex(clubField) !== -1
      });
    }

    if (strictEloEntries.length === 0) {
      return;
    }

    const eloLines = strictEloEntries
      .filter(entry => entry.known)
      .map(entry => entry.line);

    const unknownClubs = strictEloEntries
      .filter(entry => !entry.known);

    // A correctly formatted but unknown club must never update the database.
    // If there are no recognized clubs, send only the requested notice.
    if (eloLines.length === 0) {
      const unknownList = unknownClubs
        .map(item => `- ${item.club} (${item.elo})`)
        .join("\n");

      await message.reply(
        `⚠️ **Kelab tiada didalam database list**\n${unknownList}`
      );
      return;
    }

    try {

      const result =
        parseAndUpdateElo(
          eloLines.join(
            "\n"
          )
        );

      let reply =
        "✅ **ELO DATABASE AUTO UPDATE**\n";

      if (
        result.updated.length >
        0
      ) {

        reply +=
          `\n📊 **Updated (${result.updated.length})**\n`;

        for (
          const item of
          result.updated
        ) {

          reply +=
            `${item.club}: ` +
            `${item.oldElo} → ` +
            `**${item.newElo}**\n`;

        }

      }

      if (
        result.unchanged.length >
        0
      ) {

        reply +=
          `\n➖ **No Change (${result.unchanged.length})**\n`;

        for (
          const item of
          result.unchanged
        ) {

          reply +=
            `${item.club}: ${item.elo}\n`;

        }

      }

      if (
        result.notFound.length >
        0
      ) {

        reply +=
          `\n⚠️ **Club Not Found (${result.notFound.length})**\n`;

        for (
          const item of
          result.notFound
        ) {

          reply +=
            `${item.club} (${item.elo})\n`;

        }

      }

      if (
        unknownClubs.length >
        0
      ) {

        reply +=
          `\n⚠️ **Kelab tiada didalam database list (${unknownClubs.length})**\n`;

        for (const item of unknownClubs) {
          reply += `${item.club} (${item.elo})\n`;
        }

      }

      if (
        result.updated.length >
        0
      ) {

        await flushSupabaseStateSave("elo_database");
        reply +=
          "\n💾 Database saved automatically." +
          "\n☁️ **Database synchronized with Supabase.**";

      } else {

        reply +=
          "\nℹ️ No ELO changes required.";

      }

      if (
        reply.length >
        1900
      ) {

        reply =
          reply.slice(
            0,
            1850
          ) +
          "\n\n...result shortened.";

      }

      await message.reply(
        reply
      );

    } catch (
      error
    ) {

      console.error(
        "❌ Auto ELO update error:",
        error
      );

      try {

        await message.reply(
          "❌ Failed to update ELO database."
        );

      } catch {}

    }

  }
);

// ============================================================
// INTERACTION IDEMPOTENCY GUARD
// Protects against accidental duplicate delivery inside the same process.
// Cross-process duplicates are prevented by the Supabase advisory lock.
// ============================================================
const recentlyHandledInteractionIds = new Map();
const INTERACTION_ID_TTL_MS = 15 * 60 * 1000;

function claimDiscordInteraction(interactionId) {
  const now = Date.now();
  for (const [id, timestamp] of recentlyHandledInteractionIds.entries()) {
    if (now - timestamp > INTERACTION_ID_TTL_MS) recentlyHandledInteractionIds.delete(id);
  }

  const id = String(interactionId || "");
  if (!id) return true;
  if (recentlyHandledInteractionIds.has(id)) return false;
  recentlyHandledInteractionIds.set(id, now);
  return true;
}

// ============================================================
// SLASH COMMAND HANDLER
// ============================================================

client.on(
  "interactionCreate",
  async interaction => {

    if (!claimDiscordInteraction(interaction.id)) {
      console.warn(`⚠️ Duplicate Discord interaction ignored: ${interaction.id}`);
      return;
    }

    cleanupMatchmakingSessions();
    cleanupFowTimerSetupSessions();
    cleanupDeleteClubSessions();
    cleanupDerbyManageSessions();
    cleanupMatchSuccessSessions();
    cleanupSimpleSessions(manualMatchSessions, MANUAL_MATCH_SESSION_TTL_MS);
    cleanupSimpleSessions(bulkAddSessions, BULK_ADD_SESSION_TTL_MS);
    cleanupAiCommandTestSessions();
    cleanupHsControlRoomDrafts();

    // v81.4.3 — /edit_club club-name autocomplete.
    if (interaction.isAutocomplete()) {
      try {
        if (interaction.commandName === "edit_club") {
          reloadLatestDatabase();
          const focused = String(interaction.options.getFocused() || "").trim().toLowerCase();
          const choices = leaderboardData
            .filter(item => !focused || String(item.club || "").toLowerCase().includes(focused))
            .sort((a,b) => Number(b.elo||0)-Number(a.elo||0))
            .slice(0,25)
            .map(item => ({
              name: `${item.club} — ${item.president || "Not Set"} (${Number(item.elo)||0})`.slice(0,100),
              value: String(item.club).slice(0,100)
            }));
          await interaction.respond(choices);
          return;
        }
        if (interaction.commandName === "war_monitor") {
          reloadLatestDatabase();
          const focused = String(interaction.options.getFocused() || "").trim().toLowerCase();
          const score = item => {
            const club=String(item.club||"").toLowerCase(), president=String(item.president||"").toLowerCase();
            if(!focused) return 5;
            if(club===focused) return 0;
            if(club.startsWith(focused)) return 1;
            if(club.includes(focused)) return 2;
            if(president===focused) return 3;
            if(president.includes(focused)) return 4;
            return 99;
          };
          const choices = leaderboardData.map(item=>({item,rank:score(item)})).filter(x=>x.rank<99)
            .sort((a,b)=>a.rank-b.rank || Number(b.item.elo||0)-Number(a.item.elo||0)).slice(0,25)
            .map(({item})=>({name:`${item.club} — ${item.president || "Not Set"} (${Number(item.elo)||0})`.slice(0,100),value:String(item.club).slice(0,100)}));
          await interaction.respond(choices);
          return;
        }
      } catch (error) {
        console.error("❌ Autocomplete error:", error);
        try { await interaction.respond([]); } catch {}
        return;
      }
    }

    // HS PHASE 6.0A — BUTTON SIMULATION
    if (
      interaction.isButton() &&
      String(interaction.customId || "").startsWith("hscr_")
    ) {
      const [action, draftId] =
        String(interaction.customId || "").split(":");

      await interaction.deferUpdate();
      cleanupHsControlRoomDrafts();

      const draft = hsControlRoomDrafts.get(draftId);

      if (!draft) {
        await interaction.followUp({
          content: "❌ HS draft expired. Create a new preview.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (String(interaction.user.id) !== String(draft.userId)) {
        await interaction.followUp({
          content: "❌ Only the original requester can use this button.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (action === "hscr_cancel") {
        hsControlRoomDrafts.delete(draftId);
        await interaction.editReply({ components: [] });
        await interaction.followUp({
          content: "❌ Draft cancelled.\n🔒 No production data changed.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (action === "hscr_confirm") {
        if (draft.destinationKey === "test") {
          if (!draft.previewResult) {
            await interaction.followUp({
              content: "❌ Stored preview is unavailable. Please create a new preview.",
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          const output =
            `🧪 **HS CONTROL ROOM — DRY RUN**\n` +
            `🔒 No Match ID • No database changes\n\n` +
            formatMatchmakingOutput(
              draft.previewResult,
              draft.minElo,
              draft.maxElo,
              draft.previewSkipped || [],
              null
            );

          const target =
            await interaction.client.channels.fetch(
              HS_TEST_DRY_RUN_CHANNEL_ID
            );

          for (const chunk of splitDiscordText(output, 1900)) {
            await target.send(chunk);
          }

          hsControlRoomDrafts.delete(draftId);
          await interaction.editReply({ components: [] });
          await interaction.followUp({
            content:
              `✅ **DRY-RUN SENT**\n` +
              `📤 TEST DRY-RUN\n` +
              `🔒 No Match ID or database changes.`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        if (!draft.previewResult?.pairs?.length) {
          await interaction.followUp({
            content: "❌ Stored preview has no valid pairs. Please create a new preview.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        // HS PHASE 6.1 — CONFIRM-TIME AVAILABILITY REVALIDATION
        const hsConfirmClubs = [];
        for (const pair of draft.previewResult.pairs) {
          for (const item of [pair.winner || pair.a, pair.loser || pair.b]) {
            if (item?.club) hsConfirmClubs.push(item);
          }
        }

        const hsUnavailableAtConfirm =
          hsConfirmClubs.filter(
            item => !isClubMatchmakingAvailable(item.club)
          );

        if (hsUnavailableAtConfirm.length) {
          const names = hsUnavailableAtConfirm
            .map(item => `• ${item.club}`)
            .join("\n");

          hsControlRoomDrafts.delete(draftId);
          await interaction.editReply({ components: [] });
          await interaction.followUp({
            content:
              `⚠️ **MATCHMAKING CHANGED — CONFIRM BLOCKED**\n\n` +
              `These club(s) are no longer available:\n${names}\n\n` +
              `Please create a new matchmaking preview.\n` +
              `🔒 No Match ID created. No production data changed.`,
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const target =
          await interaction.client.channels.fetch(
            draft.destinationChannelId
          ).catch(() => null);

        if (
          !target ||
          !target.isTextBased?.() ||
          typeof target.send !== "function"
        ) {
          await interaction.followUp({
            content: "❌ Production destination channel is unavailable.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const matchId = nextMatchId();
        const clubs = [];

        draft.previewResult.pairs.forEach((pair, i) => {
          const winner = pair.winner || pair.a;
          const loser = pair.loser || pair.b;

          for (const [role, item] of [
            ["win", winner],
            ["lose", loser]
          ]) {
            if (!item?.club) continue;
            clubs.push({
              club: item.club,
              president: item.president || "",
              elo: Number(item.elo) || 0,
              status: "pending",
              failedAt: null,
              failedBy: null,
              matchRole: role,
              pairNo: i + 1
            });
          }
        });

        const elos = clubs.map(x => Number(x.elo) || 0);
        const plan = {
          id: matchId,
          guildId: target.guildId || interaction.guildId,
          channelId: target.id,
          min: elos.length ? Math.min(...elos) : 0,
          max: elos.length ? Math.max(...elos) : 0,
          clubs,
          pairCount: draft.previewResult.pairs.length,
          createdAt: Date.now(),
          createdBy: interaction.user.id,
          updatedAt: Date.now(),
          updatedBy: interaction.user.id,
          eventId: getActiveEvent()?.id || null,
          manual: true,
          hsControlRoom: true
        };

        matchPlans.set(matchId, plan);
        await saveMatchPlansNow();

        const output = formatManualPlanOutput(plan);
        const chunks = splitDiscordText(output, 1900);

        let controlsMsg = null;

        for (let i = 0; i < chunks.length; i++) {
          const sentMsg = await target.send({
            content: chunks[i],
            components:
              i === chunks.length - 1
                ? [buildMatchPlanKoButton(matchId)]
                : []
          });

          if (i === chunks.length - 1) {
            controlsMsg = sentMsg;
          }
        }

        if (controlsMsg) {
          plan.matchControlsMessageId = controlsMsg.id;
          plan.matchControlsChannelId = controlsMsg.channelId || target.id;
          plan.updatedAt = Date.now();
          plan.updatedBy = interaction.user.id;

          matchPlans.set(matchId, plan);
          await saveMatchPlansNow();
        }

        hsControlRoomDrafts.delete(draftId);
        await interaction.editReply({ components: [] });
        await interaction.followUp({
          content:
            `✅ **MATCHMAKING SENT**\n` +
            `🆔 Match ID: **${matchId}**\n` +
            `🎯 ${draft.minElo} - ${draft.maxElo}\n` +
            `📤 ${draft.destinationLabel}\n` +
            `☁️ Database synchronized with Supabase.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "control") {
      cleanupNaturalControlSessions();
      const key = aiCommandSessionKey(interaction.guildId, interaction.channelId);
      const action = interaction.options.getString("action", true);
      if (action === "stop") {
        naturalControlSessions.delete(key);
        await interaction.reply({content:"🛑 **FoW NATURAL CONTROL STOPPED** in this channel/thread.",flags:MessageFlags.Ephemeral});
        return;
      }
      if (action === "status") {
        const existing = naturalControlSessions.get(key);
        if (!existing) {
          await interaction.reply({content:"ℹ️ FoW Natural Control is **INACTIVE** in this channel/thread.",flags:MessageFlags.Ephemeral});
          return;
        }
        const mins=Math.max(0,Math.ceil((NATURAL_CONTROL_TTL_MS-(Date.now()-Number(existing.updatedAt||existing.createdAt||0)))/60000));
        await interaction.reply({content:`🧠 **FoW NATURAL CONTROL — ACTIVE**\nOwner: <@${existing.userId}>\nLast Match ID: **${existing.lastMatchId||"None"}**\nSession expires after inactivity in about **${mins} min**.`,flags:MessageFlags.Ephemeral});
        return;
      }
      naturalControlSessions.set(key,{userId:interaction.user.id,guildId:interaction.guildId,channelId:interaction.channelId,createdAt:Date.now(),updatedAt:Date.now(),lastMatchId:null});
      await interaction.reply({content:"🧠 **FoW NATURAL CONTROL — ACTIVE**\nUse normal English FoW/war instructions in this channel/thread. LOCAL parser runs first; Gemini 3.5 Flash-Lite is fallback only when needed. Ordinary chat and emoji are ignored.\n\nExamples:\n`do matchmaking 5200-5600, Navy skip, June 2 must win, OC22 must lose`\n`KO timer start`\n`mark Xenon failed for HS021`\n`start Grease event`\n`show active timers`\n\nProduction data can be changed by operational instructions. Existing slash commands remain available as backup. Use `/control action:Stop` when finished.",flags:MessageFlags.Ephemeral});
      return;
    }

    // ========================================================
    // MODAL SUBMITS: manual matchmaking search + bulk add
    // ========================================================
    if (interaction.isModalSubmit()) {
      const customId = String(interaction.customId || "");

      if (customId.startsWith("man_paste_modal:")) {
        const [,sessionId]=customId.split(":");
        const session=manualMatchSessions.get(sessionId);
        if(!session||String(session.userId)!==String(interaction.user.id)){ await interaction.reply({content:"❌ This manual matchmaking session has expired.",flags:MessageFlags.Ephemeral}).catch(()=>{}); return; }
        try{
          await interaction.deferUpdate(); reloadLatestDatabase();
          const parsed=parseManualMatchPaste(interaction.fields.getTextInputValue('matches'));
          if(parsed.errors.length){ await interaction.followUp({content:`❌ **PASTE VALIDATION FAILED**\n${parsed.errors.slice(0,10).map(x=>`- ${x}`).join('\n')}`,flags:MessageFlags.Ephemeral}); if(!parsed.pairs.length) return; }
          session.pairs=parsed.pairs; session.draft={a:null,b:null,winnerSide:null}; session.editingPairIndex=null; session.updatedAt=Date.now();
          await interaction.editReply(buildManualMatchmakingView(session));
          if(parsed.warnings.length) await interaction.followUp({content:`⚠️ **Database validation notes**\n${parsed.warnings.slice(0,12).map(x=>`- ${x}`).join('\n')}`,flags:MessageFlags.Ephemeral});
        }catch(error){ console.error('❌ Manual paste modal error:',error); }
        return;
      }

      if (customId.startsWith("war_cooling:")) {
        const [,opId]=customId.split(":"); const op=findWarOperationById(opId);
        if(!op){await interaction.reply({content:'❌ War operation not found or expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}
        if(!isWarAdminInteraction(interaction)){await interaction.reply({content:'⛔ You are not authorized to manage this war status.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}
        const duration=parseManualDurationHrMin(interaction.fields.getTextInputValue('remaining'));const ms=duration?.ms||0;
        if(!duration){await interaction.reply({content:'❌ Invalid time. Use **XXh XXmin**, e.g. `07h 35min`.',flags:MessageFlags.Ephemeral});return;}
        if(ms>12*60*60*1000){await interaction.reply({content:'❌ Normal cooling cannot exceed **12h 00min**.',flags:MessageFlags.Ephemeral});return;}
        op.status='COOLING_DOWN';op.isolated=true;op.coolingEndAt=Date.now()+ms;op.warning15mSent=ms<=15*60*1000;op.completionSent=false;op.reminderPending=false;op.nextReminderAt=null;op.nextAckReminderAt=null;op.updatedAt=Date.now();recordWarAudit(op,'COOLING_STARTED',interaction.user.id,{remainingMs:ms});

        // Auto-close outstanding War Monitor messages when Cooling Down starts.
        if(op.channelId){
          try{
            const reminderChannel=await client.channels.fetch(String(op.channelId));
            if(reminderChannel?.isTextBased?.() && reminderChannel.messages?.fetch){
              const messageIds=[op.lastReminderMessageId,op.lastAckReminderMessageId].filter(Boolean);
              for(const messageId of [...new Set(messageIds)]){
                try{
                  const oldMessage=await reminderChannel.messages.fetch(String(messageId));
                  if(oldMessage) await oldMessage.delete();
                  console.log(`🧹 War Monitor message removed • ${op.club} • ${messageId}`);
                }catch(error){
                  if(error?.code!==10008) console.error(`⚠️ Failed to remove War Monitor message • ${op.club} • ${messageId}:`,error);
                }
              }
            }
          }catch(error){
            console.error(`⚠️ War Monitor Auto Close failed • ${op.club}:`,error);
          }
        }
        op.lastReminderMessageId=null;
        op.lastAckReminderMessageId=null;

        await interaction.reply({content:`🧊 **NORMAL COOLING DOWN STARTED**
━━━━━━━━━━━━━━━━━━━━

🏰 Club: **${op.club}**
🆔 Match ID: **${op.matchId||'N/A'}**
⏱️ Cooling Remaining: **${duration.text}**
🚫 Matchmaking: **ISOLATED**
🔔 Reminder: **15 minutes before end**
🕘 Ends: <t:${Math.floor(op.coolingEndAt/1000)}:F>`});
        return;
      }


      if(customId.startsWith('war_monitor_edit_modal:')){
        const parts=customId.split(':');
        const opId=parts[1];
        const messageId=parts[2];

        const op=findWarOperationById(opId);

        if(!op){
          await interaction.reply({
            content:'❌ War operation not found or expired.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        if(!isWarAdminInteraction(interaction)){
          await interaction.reply({
            content:'⛔ You are not authorized to edit this War Monitor.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        const clubInput=interaction.fields.getTextInputValue('club').trim();
        const db=leaderboardData.find(
          x=>areEquivalentClubNames(x.club,clubInput)
        );

        if(!db){
          await interaction.reply({
            content:`❌ Club not found: **${clubInput}**`,
            flags:MessageFlags.Ephemeral
          });
          return;
        }

        const oldClub=op.club;
        const oldKey=warOpKey(oldClub);
        const newKey=warOpKey(db.club);

        if(oldKey===newKey){
          await interaction.reply({
            content:`ℹ️ War Monitor is already assigned to **${db.club}**.`,
            flags:MessageFlags.Ephemeral
          });
          return;
        }

        const existing=warOperations[newKey];

        if(
          existing &&
          existing!==op &&
          String(existing.status||'AVAILABLE').toUpperCase()!=='AVAILABLE'
        ){
          await interaction.reply({
            content:`❌ **${db.club}** already has an active War Monitor / isolation.`,
            flags:MessageFlags.Ephemeral
          });
          return;
        }

        delete warOperations[oldKey];

        op.club=db.club;
        op.president=db.president||'';
        op.elo=Number(db.elo)||0;
        op.updatedAt=Date.now();
        op.editedBy=interaction.user.id;
        op.editedFromClub=oldClub;

        warOperations[newKey]=op;

        recordWarAudit(
          op,
          'WAR_MONITOR_CLUB_EDITED',
          interaction.user.id,
          {fromClub:oldClub,toClub:db.club}
        );

        saveWarOperations();

        try{
          const ch=await client.channels.fetch(String(op.channelId));
          const msg=await ch?.messages?.fetch?.(String(messageId));
          if(msg){
            await msg.edit({
              content:buildWarMonitorStartedContent(op),
              components:[buildWarMonitorStartedControls(op)]
            });
          }
        }catch(e){
          console.error('⚠️ Failed to refresh War Monitor control message:',e);
        }

        await interaction.reply({
          content:`✅ **WAR MONITOR CLUB UPDATED**

Previous: **${oldClub}**
New: **${op.club}**

⏱️ Existing event and preparation timing were preserved.
🚫 Isolation moved to the new club.`,
          flags:MessageFlags.Ephemeral
        });

        return;
      }

      if (customId.startsWith("man_modal:")) {
        const [, sessionId, side] = customId.split(":");
        const session = manualMatchSessions.get(sessionId);
        if (!session || String(session.userId) !== String(interaction.user.id)) {
          await interaction.reply({ content:"❌ This manual matchmaking session has expired.", flags:MessageFlags.Ephemeral }).catch(()=>{});
          return;
        }
        try {
          await interaction.deferUpdate();
          const query = interaction.fields.getTextInputValue("query");
          const used = manualSessionUsedKeys(session, session.editingPairIndex);
          const other = side === 'a' ? session.draft?.b : session.draft?.a;
          if (other?.club) used.add(normalizeClubName(other.club));
          const results = searchManualAllClubs(query, used);
          session.updatedAt = Date.now();
          if (!results.length) {
            await interaction.editReply({ content:`❌ No AVAILABLE club found for **${String(query).slice(0,100)}**.`, components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`man_back:${session.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary))] });
            return;
          }
          await interaction.editReply(buildManualSearchResults(session, side, results));
        } catch (error) {
          console.error("❌ Manual matchmaking search modal error:", error);
        }
        return;
      }

      if(customId.startsWith("range_modal:")){
        const session=manualMatchSessions.get(customId.split(":")[1]);if(!session||String(session.userId)!==String(interaction.user.id)){await interaction.reply({content:'❌ This manual matchmaking session has expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}
        await interaction.deferUpdate();const sm=Number(interaction.fields.getTextInputValue('source_min')),sx=Number(interaction.fields.getTextInputValue('source_max')),om=Number(interaction.fields.getTextInputValue('opp_min')),ox=Number(interaction.fields.getTextInputValue('opp_max'));
        if(![sm,sx,om,ox].every(Number.isInteger)||sm>sx||om>ox){await interaction.editReply({content:'❌ Invalid ELO ranges.',components:[]});return;}
        const used=manualSessionUsedKeys(session,session.editingPairIndex);session.range={sourceMin:sm,sourceMax:sx,oppMin:om,oppMax:ox,sourceKey:null};const c=derbyRangeCandidates(sm,sx,used);if(!c.length){await interaction.editReply({content:`❌ No AVAILABLE clubs in source range **${sm}-${sx}**.`,components:[]});return;}await interaction.editReply(buildRangeSourceResults(session,c));return;
      }

      if (customId.startsWith("bulk_modal:")) {
        try {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          reloadLatestDatabase();
          const parsed = parseBulkClubText(interaction.fields.getTextInputValue("clubs"));
          const session = { id:createShortSessionId(), userId:interaction.user.id, guildId:interaction.guildId, ...parsed, createdAt:Date.now(), updatedAt:Date.now() };
          bulkAddSessions.set(session.id, session);
          await interaction.editReply(buildBulkPreview(session));
        } catch (error) {
          console.error("❌ /bulk_add_club modal error:", error);
          try { await interaction.editReply({content:"❌ Failed to parse bulk club list.",components:[]}); } catch {}
        }
        return;
      }
    }

    // ========================================================
    // INTERACTIVE /matchmaking COMPONENTS
    // ========================================================

    if (
      interaction.isStringSelectMenu() ||
      interaction.isButton()
    ) {
      const customId =
        String(
          interaction.customId ||
          ""
        );

      if(customId.startsWith('hsev_confirm:') || customId.startsWith('hsev_cancel:')){
        cleanupHsEventTransitionDrafts();
        const [action,draftId]=customId.split(':');
        const draft=hsEventTransitionDrafts.get(draftId);

        if(!draft){
          await interaction.reply({content:"❌ This event confirmation has expired. Send the event request again.",flags:MessageFlags.Ephemeral}).catch(()=>{});
          return;
        }
        if(String(interaction.user.id)!==String(draft.userId)){
          await interaction.reply({content:"❌ Only the user who requested this event change can confirm it.",flags:MessageFlags.Ephemeral}).catch(()=>{});
          return;
        }
        if(draft.guildId && String(interaction.guildId||"")!==String(draft.guildId)){
          await interaction.reply({content:"❌ This event confirmation belongs to another server.",flags:MessageFlags.Ephemeral}).catch(()=>{});
          return;
        }

        if(action==='hsev_cancel'){
          hsEventTransitionDrafts.delete(draftId);
          await interaction.update({content:`❌ **Event change cancelled**\n\n${hsEventModeLabel(draft.fromMode)} remains unchanged.\n🔒 No production event data changed.`,components:[]});
          return;
        }

        try{
          await interaction.deferUpdate();
          const result=await applyHsEventTransition(draft,interaction.user.id);
          hsEventTransitionDrafts.delete(draftId);
          if(!result.ok){
            await interaction.editReply({content:result.message,components:[]});
            return;
          }

          const active=result.active;
          const detail=active
            ? `\nDuration: **${eventDurationDays(result.toMode)} days**\n${result.toMode==='grease'?'Preparation: **None**\nKO: **2 hours**':'Preparation: **6 hours**\nKO: **2 hours**'}`
            : `\nMode: **NORMAL**`;

          await interaction.editReply({
            content:
              `✅ **EVENT TRANSITION COMPLETE**\n\n` +
              `Closed: **${hsEventModeLabel(draft.fromMode)}**\n` +
              `Started: **${hsEventModeLabel(draft.toMode)}**` +
              detail +
              `\n\n☁️ **Event state synchronized with Supabase.**`,
            components:[]
          });
          return;
        }catch(error){
          console.error("❌ HS event transition failed:",error);
          hsEventTransitionDrafts.delete(draftId);
          try{await interaction.editReply({content:"❌ Event transition failed. Production state was not intentionally advanced further; check logs before retrying.",components:[]});}catch{}
          return;
        }
      }

            if(customId.startsWith('match_cancel_request:')){
        const id=normalizeMatchId(customId.split(':')[1]);
        const plan=getMatchPlan(id);

        if(!plan){
          await interaction.reply({
            content:`❌ Match ID **${id||'Unknown'}** not found.`,
            flags:MessageFlags.Ephemeral
          });
          return;
        }

        if(String(plan.status||'').toUpperCase()==='CANCELLED'){
          await interaction.reply({
            content:`⚠️ Match ID **${id}** is already CANCELLED.`,
            flags:MessageFlags.Ephemeral
          });
          return;
        }

        if(hasActiveTimerForMatch(id)){
          await interaction.reply({
            content:
              `❌ **MATCH ID CANNOT BE CANCELLED YET**\n\n` +
              `🆔 Match ID: **${id}**\n` +
              `⏱️ An active timer still exists for this Match ID.\n\n` +
              `Complete or cancel the active timer first.`,
            flags:MessageFlags.Ephemeral
          });
          return;
        }

        await interaction.reply({
          content:
            `⚠️ **CONFIRM MATCH ID CANCELLATION**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🆔 Match ID: **${id}**\n\n` +
            `This will mark the Match ID as **CANCELLED** and stop further lifecycle tracking.\n` +
            `The historical record will remain in Supabase.`,
          components:[
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`match_cancel_confirm:${id}`)
                .setLabel('🛑 YES, CANCEL MATCH ID')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`match_cancel_back:${id}`)
                .setLabel('← BACK')
                .setStyle(ButtonStyle.Secondary)
            )
          ],
          flags:MessageFlags.Ephemeral
        });
        return;
      }

      if(customId.startsWith('match_cancel_back:')){
        const id=normalizeMatchId(customId.split(':')[1]);
        await interaction.update({
          content:`✅ Cancellation aborted for **${id}**.\nNo Match ID state was changed.`,
          components:[]
        });
        return;
      }

      if(customId.startsWith('match_cancel_confirm:')){
        const id=normalizeMatchId(customId.split(':')[1]);
        const plan=getMatchPlan(id);

        if(!plan){
          await interaction.update({
            content:`❌ Match ID **${id||'Unknown'}** not found.`,
            components:[]
          });
          return;
        }

        if(String(plan.status||'').toUpperCase()==='CANCELLED'){
          await interaction.update({
            content:`⚠️ Match ID **${id}** is already CANCELLED.`,
            components:[]
          });
          return;
        }

        if(hasActiveTimerForMatch(id)){
          await interaction.update({
            content:
              `❌ **MATCH ID CANNOT BE CANCELLED**\n\n` +
              `🆔 Match ID: **${id}**\n` +
              `An active timer still exists. Complete or cancel the timer first.`,
            components:[]
          });
          return;
        }

        const now=Date.now();

        plan.status='CANCELLED';
        plan.cancelledAt=now;
        plan.cancelledBy=String(interaction.user.id);
        plan.lifecycleTrackingStoppedAt=now;
        plan.updatedAt=now;
        plan.updatedBy=String(interaction.user.id);

        matchPlans.set(plan.id,plan);
        await saveMatchPlansNow();

        await interaction.update({
          content:
            `❌ **MATCH ID CANCELLED**\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🆔 Match ID: **${id}**\n` +
            `📌 Status: **CANCELLED**\n` +
            `👤 Cancelled by: <@${interaction.user.id}>\n` +
            `🕒 Cancelled: <t:${Math.floor(now/1000)}:F>\n\n` +
            `Historical record has been retained.\n` +
            `No further Match ID lifecycle tracking will continue.\n\n` +
            `☁️ **Database synchronized with Supabase.**`,
          components:[],
          allowedMentions:{users:[]}
        });

        console.log(`❌ Match ID ${id} marked CANCELLED from Match Control and retained in Supabase.`);
        return;
      }

      if(customId.startsWith('match_controls_cancel:')){
        const id=normalizeMatchId(customId.split(':')[1]);
        await interaction.update({content:`🆔 **${id}** • Match controls closed.\nNo timer was started and no club state was changed.`,components:[]});
        return;
      }
      if(customId.startsWith('match_prep_start:')){const id=normalizeMatchId(customId.split(':')[1]),plan=getMatchPlan(id);if(!plan){await interaction.reply({content:`❌ Match ID **${id||'Unknown'}** not found.`,flags:MessageFlags.Ephemeral});return;}const mode=getEventTypeForPlan(plan),hours=eventPreparationHours(mode);if(!hours){await interaction.reply({content:'❌ This event mode has no preparation stage.',flags:MessageFlags.Ephemeral});return;}if(plan.preparationStartedAt&&!plan.preparationCompletedAt){await interaction.reply({content:`⚠️ ${hours}H preparation for **${id}** is already active.`,flags:MessageFlags.Ephemeral});return;}const session=openPreparationSetup(plan,interaction);await interaction.reply({...buildPreparationSetupView(session),flags:MessageFlags.Ephemeral});return;}
      if(customId.startsWith('prep_setup_')){const [action,sid]=customId.split(':');const session=preparationSetupSessions.get(sid);if(!session||String(session.userId)!==String(interaction.user.id)){await interaction.reply({content:'❌ Preparation setup expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}const plan=getMatchPlan(session.matchId);if(!plan){preparationSetupSessions.delete(sid);await interaction.update({content:'❌ Match ID not found.',components:[]}).catch(()=>{});return;}session.updatedAt=Date.now();if(action==='prep_setup_failed'){session.mode='failed';session.page=0;await interaction.update(buildPreparationSetupView(session));return;}if(action==='prep_setup_skip'){session.mode='skip';session.page=0;await interaction.update(buildPreparationSetupView(session));return;}if(action==='prep_setup_prev'){session.page=Math.max(0,session.page-1);await interaction.update(buildPreparationSetupView(session));return;}if(action==='prep_setup_next'){session.page++;await interaction.update(buildPreparationSetupView(session));return;}if(action==='prep_setup_done'){session.mode=null;session.page=0;await interaction.update(buildPreparationSetupView(session));return;}if(action==='prep_setup_clear'){if(session.mode==='failed')session.failed.clear();else session.skipped.clear();await interaction.update(buildPreparationSetupView(session));return;}if(action==='prep_setup_cancel'){preparationSetupSessions.delete(sid);await interaction.update({content:'❌ Preparation start cancelled. No state changed.',components:[]});return;}if(action==='prep_setup_select'&&interaction.isStringSelectMenu()){const pg=koSetupPageItems(plan,session.page),pageKeys=new Set(pg.items.map(c=>normalizeClubName(c.club))),target=session.mode==='failed'?session.failed:session.skipped,other=session.mode==='failed'?session.skipped:session.failed;for(const k of pageKeys)target.delete(k);for(const k of interaction.values){target.add(String(k));other.delete(String(k));}await interaction.update(buildPreparationSetupView(session));return;}if(action==='prep_setup_confirm'){await interaction.deferUpdate();const d=deriveKoSetup(plan,session),now=Date.now(),mode=getEventTypeForPlan(plan),hours=eventPreparationHours(mode);for(const c of plan.clubs||[]){const k=normalizeClubName(c.club);if(d.failed.has(k)){c.status='failed';c.failedAt=now;c.failedBy=interaction.user.id;}else if(d.skipped.has(k)||d.released.has(k)){c.status='excluded';c.failedAt=null;c.failedBy=null;}}plan.preparationStartedAt=now;plan.preparationEndAt=now+hours*3600000;plan.preparationCompletedAt=null;plan.updatedAt=now;plan.updatedBy=interaction.user.id;matchPlans.set(plan.id,plan);await saveMatchPlansNow();const t=createPreparationTimerForPlan(plan,interaction,d);preparationSetupSessions.delete(sid);if(!t){await interaction.editReply({content:'❌ No eligible clubs remain for preparation.',components:[]});return;}await flushSupabaseStateSave('active_fow_timers');const failedNames=[...d.failed].map(k=>(plan.clubs||[]).find(c=>normalizeClubName(c.club)===k)?.club).filter(Boolean),releasedNames=[...d.released].map(k=>(plan.clubs||[]).find(c=>normalizeClubName(c.club)===k)?.club).filter(Boolean),skipNames=[...d.skipped].map(k=>(plan.clubs||[]).find(c=>normalizeClubName(c.club)===k)?.club).filter(Boolean);try{const ch=await client.channels.fetch(String(interaction.channelId));if(ch?.isTextBased?.())await ch.send(`⏳ **FOW PREPARATION STARTED**\n━━━━━━━━━━━━━━━━━━━━\n\n🆔 Match ID: **${plan.id}**\n⚡ Event: **${warEventLabel(mode)}**\n⏱️ Preparation: **${hours} Hours**\n🕘 Ends: <t:${Math.floor(t.endAt/1000)}:F>\n🚫 Matchmaking: **ISOLATED**\n\n⚠️ Failed pending War Monitor: **${failedNames.length}**\n🟢 Released Opponents: **${releasedNames.length}**\n⏭️ Skipped / Available: **${skipNames.length}**`);}catch(e){console.error('❌ Prep public message failed:',e);}if(failedNames.length)try{const ch=await client.channels.fetch(String(CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID));if(ch?.isTextBased?.())await ch.send(`⚠️ **WAR MONITOR PENDING — PREPARATION ACTIVE**\n\n🆔 Match ID: **${plan.id}**\n⚡ Event: **${warEventLabel(mode)}**\n⏱️ Preparation: **${hours} Hours**\n\n${failedNames.map(x=>`• ${x}`).join('\\n')}\n\n🚫 Matchmaking: **ISOLATED**\n⏰ 2-hour reminders start after preparation ends.`);}catch(e){console.error('❌ Pending War Monitor message failed:',e);}await interaction.editReply({content:`✅ **${hours}H PREPARATION STARTED**\n\n🆔 Match ID: **${plan.id}**\n🏰 Isolated: **${t.clubs.length}**\n⚠️ Failed: **${failedNames.length}**\n🟢 Released: **${releasedNames.length}**\n⏭️ Skipped: **${skipNames.length}**`,components:[]});return;}}
      if(customId.startsWith('match_ko_start:')){
        const id=normalizeMatchId(customId.split(':')[1]),plan=getMatchPlan(id);
        if(!plan){await interaction.reply({content:`❌ Match ID **${id||'Unknown'}** not found.`,flags:MessageFlags.Ephemeral});return;}
        if(hasActiveTimerForMatch(id)){await interaction.reply({content:`⚠️ Isolation timer for **${id}** is already active.`,flags:MessageFlags.Ephemeral});return;}
        const session=openKoSetup(plan,interaction);session.sourceMatchControlMessageId=interaction.message?.id||null;await interaction.reply({...buildKoSetupView(session),flags:MessageFlags.Ephemeral});return;
      }
      if(customId.startsWith('ko_setup_')){
        const [action,sid]=customId.split(':');const session=koTimerSetupSessions.get(sid);
        if(!session||String(session.userId)!==String(interaction.user.id)){await interaction.reply({content:'❌ KO timer setup expired. Open Match Controls again.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}
        const plan=getMatchPlan(session.matchId);if(!plan){koTimerSetupSessions.delete(sid);await interaction.update({content:'❌ Match ID not found.',components:[]}).catch(()=>{});return;}session.updatedAt=Date.now();
        if(action==='ko_setup_failed'){session.mode='failed';session.page=0;await interaction.update(buildKoSetupView(session));return;}
        if(action==='ko_setup_skip'){session.mode='skip';session.page=0;await interaction.update(buildKoSetupView(session));return;}
        if(action==='ko_setup_prev'){session.page=Math.max(0,session.page-1);await interaction.update(buildKoSetupView(session));return;}
        if(action==='ko_setup_next'){session.page++;await interaction.update(buildKoSetupView(session));return;}
        if(action==='ko_setup_done'){session.mode=null;session.page=0;await interaction.update(buildKoSetupView(session));return;}
        if(action==='ko_setup_clear'){if(session.mode==='failed')session.failed.clear();else session.skipped.clear();await interaction.update(buildKoSetupView(session));return;}
        if(action==='ko_setup_cancel'){koTimerSetupSessions.delete(sid);await interaction.update({content:'❌ Timer start cancelled. No club state was changed.',components:[]});return;}
        if(action==='ko_setup_select'&&interaction.isStringSelectMenu()){const pg=koSetupPageItems(plan,session.page),pageKeys=new Set(pg.items.map(c=>normalizeClubName(c.club))),target=session.mode==='failed'?session.failed:session.skipped,other=session.mode==='failed'?session.skipped:session.failed;for(const k of pageKeys)target.delete(k);for(const k of interaction.values){target.add(String(k));other.delete(String(k));}await interaction.update(buildKoSetupView(session));return;}
        if(action==='ko_setup_confirm'){
          if(hasActiveTimerForMatch(plan.id)){koTimerSetupSessions.delete(sid);await interaction.update({content:`⚠️ Isolation timer for **${plan.id}** is already active.`,components:[]});return;}
          await interaction.deferUpdate();
          const d=deriveKoSetup(plan,session),now=Date.now();
          for(const c of plan.clubs||[]){const k=normalizeClubName(c.club);if(d.failed.has(k)){c.status='failed';c.failedAt=now;c.failedBy=interaction.user.id;}else if(d.skipped.has(k)||d.released.has(k)){c.status='excluded';c.failedAt=null;c.failedBy=null;}}
          plan.updatedAt=now;plan.updatedBy=interaction.user.id;matchPlans.set(plan.id,plan);await saveMatchPlansNow();
          const mode=getEventTypeForPlan(plan);const failedNames=[];for(const key of d.failed){const c=(plan.clubs||[]).find(x=>normalizeClubName(x.club)===key);if(!c)continue;startWarMonitoringForClub(c.club,mode,{channelId:CHATGPT_BRIDGE_WAR_STATUS_CHANNEL_ID,guildId:interaction.guildId,userId:interaction.user.id});failedNames.push(c.club);}
          const t=startKoTimerForMatchPlan(plan,interaction,d.clubs);
if(t){
  await flushSupabaseStateSave('active_fow_timers');

  if(session.sourceMatchControlMessageId){
    try{
      const ch=await client.channels.fetch(String(interaction.channelId));
      if(ch?.isTextBased?.() && ch.messages?.fetch){
        const oldMsg=await ch.messages.fetch(String(session.sourceMatchControlMessageId));
        if(oldMsg) await oldMsg.delete();
      }
      console.log(`🧹 Preparation Completed controls auto-deleted after KO + Cooling start • ${plan.id}`);
    }catch(error){
      if(error?.code!==10008){
        console.error(`⚠️ Failed to delete Preparation Completed controls • ${plan.id}:`,error);
      }
    }
  }
}
koTimerSetupSessions.delete(sid);
          const releasedNames=[...d.released].map(k=>(plan.clubs||[]).find(c=>normalizeClubName(c.club)===k)?.club).filter(Boolean);const skipNames=[...d.skipped].map(k=>(plan.clubs||[]).find(c=>normalizeClubName(c.club)===k)?.club).filter(Boolean);
          if(failedNames.length)await sendFailedClubWarMonitorPublic({plan,mode,failedNames,releasedNames,userId:interaction.user.id});
          if(!t){await interaction.editReply({content:`ℹ️ **NO KO TIMER STARTED**\n\n🆔 Match ID: **${plan.id}**\nNo eligible clubs remain for KO isolation.${failedNames.length?`\n⚠️ War Monitor: ${failedNames.join(', ')}`:''}${releasedNames.length?`\n🟢 Released: ${releasedNames.join(', ')}`:''}${skipNames.length?`\n⏭️ Skipped: ${skipNames.join(', ')}`:''}\n\n📢 War Monitor status was posted publicly.`,components:[]});return;}
          const publicPosted=await sendKoTimerStartedPublic(t,plan,{failedNames,releasedNames,skipNames});
          await interaction.editReply({content:`✅ **TIMER STARTED**\n\n🆔 Match ID: **${plan.id}**\n🏰 KO Isolation: **${t.clubs.length} club(s)**${failedNames.length?`\n⚠️ War Monitor: **${failedNames.length}**`:''}${releasedNames.length?`\n🟢 Released Opponents: **${releasedNames.length}**`:''}${skipNames.length?`\n⏭️ Skipped: **${skipNames.length}**`:''}\n\n${publicPosted?'📢 Start notification posted publicly in this channel.':'⚠️ Timer is active, but the public start notification could not be posted.'}`,components:[]});return;
        }
      }
      if(customId.startsWith('iso_override_')){
        const [action,sid]=customId.split(':');const session=isolationOverrideSessions.get(sid);if(!session||String(session.userId)!==String(interaction.user.id)){await interaction.reply({content:'❌ Isolation override session expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}session.updatedAt=Date.now();
        if(action==='iso_override_select'&&interaction.isStringSelectMenu()){const all=currentIsolatedClubRecords(),items=all.slice(session.page*25,session.page*25+25),keys=new Set(items.map(c=>normalizeClubName(c.club)));for(const k of keys)session.selected.delete(k);for(const k of interaction.values)session.selected.add(String(k));await interaction.update(buildIsolationOverrideView(session));return;}
        if(action==='iso_override_prev'){session.page=Math.max(0,session.page-1);await interaction.update(buildIsolationOverrideView(session));return;}
        if(action==='iso_override_next'){session.page++;await interaction.update(buildIsolationOverrideView(session));return;}
        if(action==='iso_override_clear'){session.selected.clear();await interaction.update(buildIsolationOverrideView(session));return;}
        if(action==='iso_override_cancel'){isolationOverrideSessions.delete(sid);await interaction.update({content:'❌ Master isolation override cancelled. No state was changed.',components:[]});return;}
        if(action==='iso_override_confirm'){if(!isWarAdminInteraction(interaction)){await interaction.reply({content:'⛔ You are not authorized to use master isolation override.',flags:MessageFlags.Ephemeral});return;}await interaction.deferUpdate();const released=await masterReleaseIsolation(session.selected,interaction);isolationOverrideSessions.delete(sid);await interaction.editReply({content:`🛡️ **MASTER ISOLATION OVERRIDE COMPLETE**\n\n🟢 Released: **${released.length} club(s)**${released.length?`\n${released.map(x=>`• ${x}`).join('\n')}`:''}\n\n✅ Removed from active timer/war isolation.\n✅ Eligible for matchmaking unless another independent restriction applies.\n👤 Override by: <@${interaction.user.id}>`,components:[],allowedMentions:{parse:['users']}});return;}
      }


      if(customId.startsWith('war_monitor_close:')){
        const opId=customId.split(':')[1];
        const op=findWarOperationById(opId);
        if(!op){
          await interaction.reply({
            content:'❌ War operation not found or expired.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        if(!isWarAdminInteraction(interaction)){
          await interaction.reply({
            content:'⛔ You are not authorized to manage this war status.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        await interaction.update({components:[]});
        return;
      }

      if(customId.startsWith('war_monitor_edit:')){
        const opId=customId.split(':')[1];
        const op=findWarOperationById(opId);

        if(!op){
          await interaction.reply({
            content:'❌ War operation not found or expired.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        if(!isWarAdminInteraction(interaction)){
          await interaction.reply({
            content:'⛔ You are not authorized to manage this war status.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        await interaction.showModal(
          createWarMonitorEditModal(op,interaction.message.id)
        );
        return;
      }

      if(customId.startsWith('war_monitor_cancel:')){
        const opId=customId.split(':')[1];
        const op=findWarOperationById(opId);

        if(!op){
          await interaction.reply({
            content:'❌ War operation not found or expired.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        if(!isWarAdminInteraction(interaction)){
          await interaction.reply({
            content:'⛔ You are not authorized to manage this war status.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        await interaction.update({
          content:`⚠️ **CANCEL WAR MONITOR?**

🏰 Club: **${op.club}**
⚡ Event: **${warEventLabel(op.eventType)}**

This will:
• Stop preparation / War Monitor
• Stop future War Reminders
• Release matchmaking isolation
• Set the club to AVAILABLE`,
          components:[
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`war_monitor_cancel_confirm:${op.id}`)
                .setLabel('✅ YES, CANCEL')
                .setStyle(ButtonStyle.Danger),

              new ButtonBuilder()
                .setCustomId(`war_monitor_cancel_back:${op.id}`)
                .setLabel('← BACK')
                .setStyle(ButtonStyle.Secondary)
            )
          ]
        });
        return;
      }

      if(customId.startsWith('war_monitor_cancel_back:')){
        const opId=customId.split(':')[1];
        const op=findWarOperationById(opId);

        if(!op){
          await interaction.update({
            content:'❌ War operation no longer exists.',
            components:[]
          }).catch(()=>{});
          return;
        }

        await interaction.update({
          content:buildWarMonitorStartedContent(op),
          components:[buildWarMonitorStartedControls(op)]
        });
        return;
      }

      if(customId.startsWith('war_monitor_cancel_confirm:')){
        const opId=customId.split(':')[1];
        const op=findWarOperationById(opId);

        if(!op){
          await interaction.update({
            content:'❌ War operation no longer exists.',
            components:[]
          }).catch(()=>{});
          return;
        }

        if(!isWarAdminInteraction(interaction)){
          await interaction.reply({
            content:'⛔ You are not authorized to cancel this War Monitor.',
            flags:MessageFlags.Ephemeral
          }).catch(()=>{});
          return;
        }

        op.status='AVAILABLE';
        op.isolated=false;
        op.monitorAfterPrep=false;
        op.preparationEndAt=null;
        op.preparation15mSent=true;
        op.reminderPending=false;
        op.nextReminderAt=null;
        op.nextAckReminderAt=null;
        op.coolingEndAt=null;
        op.warning15mSent=false;
        op.completionSent=true;
        op.updatedAt=Date.now();

        recordWarAudit(
          op,
          'WAR_MONITOR_CANCELLED',
          interaction.user.id
        );

        saveWarOperations();

        await interaction.update({
          content:`🛑 **WAR MONITOR CANCELLED**
━━━━━━━━━━━━━━━━━━━━

🏰 Club: **${op.club}**
⚡ Event: **${warEventLabel(op.eventType)}**

🟢 Status: **AVAILABLE**
✅ Matchmaking: **AVAILABLE**
⏰ Future War Reminders: **CANCELLED**

👤 Cancelled by: <@${interaction.user.id}>`,
          components:[],
          allowedMentions:{parse:['users']}
        });
        return;
      }

      if (customId.startsWith("war_ack:") || customId.startsWith("war_end:")) {
        const [action,opId]=customId.split(":"); const op=findWarOperationById(opId);
        if(!op){await interaction.reply({content:'❌ War operation not found or expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}
        if(!isWarAdminInteraction(interaction)){await interaction.reply({content:'⛔ You are not authorized to manage this war status.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}
        if(action==='war_ack'){
          op.lastAckBy=interaction.user.id;op.lastAckAt=Date.now();op.reminderPending=false;op.nextAckReminderAt=null;op.nextReminderAt=Date.now()+WAR_REMINDER_INTERVAL_MS;op.updatedAt=Date.now();recordWarAudit(op,'WAR_ACKNOWLEDGED',interaction.user.id);
          await interaction.update({content:`⚔️ **WAR STILL ON**\n\n🏙️ **${op.club}**\n🔴 Status: **WAR ACTIVE**\n👤 Acknowledged by: <@${interaction.user.id}>\n⏰ Next reminder: **2 hours**`,components:[],allowedMentions:{parse:['users']}});
          return;
        }
        if(action==='war_end'){
          const type=String(op.eventType||'normal').toLowerCase();
          op.reminderPending=false;op.nextAckReminderAt=null;op.nextReminderAt=null;op.updatedAt=Date.now();
          if(type==='normal'){
            op.status='AWAITING_COOLING_TIME';op.isolated=true;recordWarAudit(op,'WAR_ENDED_AWAITING_COOLING',interaction.user.id);
            await interaction.showModal(createCoolingModal(op)); return;
          }
          op.status='AVAILABLE';op.isolated=false;op.completionSent=true;recordWarAudit(op,'WAR_ENDED_AVAILABLE',interaction.user.id);
          const mentions=type==='grease'?getWarReminderMentions():[];
          await interaction.update({content:`✅ **${type==='grease'?'GREASE WAR DONE':'WAR DONE'}**\n\n🏙️ **${op.club}**\n⚔️ Event: **${warEventLabel(type)}**\n🟢 Status: **AVAILABLE**\n✅ Matchmaking: **AVAILABLE**\n👤 Acknowledged by: <@${interaction.user.id}>${mentions.length?`\n\n${mentions.join(' ')}`:''}`,components:[],allowedMentions:{parse:['users']}}); return;
        }
      }

      if(customId.startsWith('range_open:')){const session=manualMatchSessions.get(customId.split(':')[1]);if(!session||String(session.userId)!==String(interaction.user.id)){await interaction.reply({content:'❌ This manual matchmaking session has expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}await interaction.showModal(createManualRangeModal(session.id));return;}
      if(customId.startsWith('range_source:')&&interaction.isStringSelectMenu()){const session=manualMatchSessions.get(customId.split(':')[1]);if(!session?.range){await interaction.reply({content:'❌ Range search expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}await interaction.deferUpdate();const source=findClubByKey(interaction.values[0]);if(!source){await interaction.editReply({content:'❌ Source club is no longer available.',components:[]});return;}const used=manualSessionUsedKeys(session,session.editingPairIndex);used.add(normalizeClubName(source.club));session.range.sourceKey=normalizeClubName(source.club);const view=buildRangeOpponentResults(session,source,derbyRangeCandidates(session.range.oppMin,session.range.oppMax,used));if(!view){await interaction.editReply({content:`❌ No opponent within **${MATCHMAKING_MAX_GAP} ELO**.`,components:[]});return;}await interaction.editReply(view);return;}
      if(customId.startsWith('range_opponent:')&&interaction.isStringSelectMenu()){const session=manualMatchSessions.get(customId.split(':')[1]);if(!session?.range?.sourceKey){await interaction.reply({content:'❌ Range search expired.',flags:MessageFlags.Ephemeral}).catch(()=>{});return;}await interaction.deferUpdate();const a0=findClubByKey(session.range.sourceKey),b0=findClubByKey(interaction.values[0]);if(!a0||!b0){await interaction.editReply({content:'❌ Club no longer available.',components:[]});return;}const gap=Math.abs(Number(a0.elo)-Number(b0.elo));if(gap>MATCHMAKING_MAX_GAP){await interaction.editReply({content:`❌ Gap ${gap} exceeds ${MATCHMAKING_MAX_GAP}.`,components:[]});return;}const used=manualSessionUsedKeys(session,session.editingPairIndex);if(used.has(normalizeClubName(a0.club))||used.has(normalizeClubName(b0.club))){await interaction.editReply({content:'❌ One of these clubs is already used in this Match ID.',components:[]});return;}const a={club:a0.club,president:a0.president||'',elo:Number(a0.elo)||0},b={club:b0.club,president:b0.president||'',elo:Number(b0.elo)||0};const pair={a,b,winnerSide:Number(a.elo)>=Number(b.elo)?'a':'b',source:'range_search'};if(session.editingPairIndex!=null)session.pairs[session.editingPairIndex]=pair;else session.pairs.push(pair);session.editingPairIndex=null;session.draft={a:null,b:null,winnerSide:null};session.range=null;await interaction.editReply(buildManualMatchmakingView(session));return;}

      // Manual matchmaking / edit matchmaking controls.
      if (customId.startsWith("man_")) {
        const [action, sessionId, side] = customId.split(":");
        const session = manualMatchSessions.get(sessionId);
        if (!session || String(session.userId) !== String(interaction.user.id)) {
          try { await interaction.reply({content:"❌ This manual matchmaking session has expired.",flags:MessageFlags.Ephemeral}); } catch {}
          return;
        }
        session.updatedAt = Date.now();
        try {
          if (action === "man_paste" && interaction.isButton()) {
            await interaction.showModal(createManualPasteModal(session.id));
            return;
          }
          if (action === "man_search" && interaction.isButton()) {
            await interaction.showModal(createManualSearchModal(session.id, side));
            return;
          }
          await interaction.deferUpdate();
          if (action === "man_pair" && interaction.isStringSelectMenu()) {
            const idx=Number(interaction.values[0]);
            const pair=session.pairs[idx];
            if(!pair){ await interaction.followUp({content:"❌ Pair not found.",flags:MessageFlags.Ephemeral}); return; }
            session.editingPairIndex=idx;
            session.draft={a:{...pair.a},b:{...pair.b},winnerSide:pair.winnerSide||'a'};
            await interaction.editReply(buildManualMatchmakingView(session));
            return;
          }
          if (action === "man_select" && interaction.isStringSelectMenu()) {
            const club = findClubByKey(interaction.values[0]);
            if (!club || !isClubMatchmakingAvailable(club.club)) {
              await interaction.followUp({content:"❌ Club is no longer available for matchmaking.",flags:MessageFlags.Ephemeral});
              return;
            }
            session.draft = session.draft || {a:null,b:null,winnerSide:null};
            session.draft[side] = {club:club.club,president:club.president||'',elo:Number(club.elo)||0};
            if (session.draft.a && session.draft.b && normalizeClubName(session.draft.a.club)===normalizeClubName(session.draft.b.club)) {
              session.draft[side]=null;
              await interaction.followUp({content:"❌ Club A and Club B cannot be the same club.",flags:MessageFlags.Ephemeral});
            }
            await interaction.editReply(buildManualMatchmakingView(session));
            return;
          }
          if (action === "man_back" && interaction.isButton()) { await interaction.editReply(buildManualMatchmakingView(session)); return; }
          if (action === "man_win" && interaction.isButton()) { session.draft.winnerSide=side; await interaction.editReply(buildManualMatchmakingView(session)); return; }
          if (action === "man_add" && interaction.isButton()) {
            const d=session.draft;
            if(!(d?.a&&d?.b&&d?.winnerSide)){ await interaction.followUp({content:"❌ Select Club A, Club B and winner first.",flags:MessageFlags.Ephemeral}); return; }
            if(!isClubMatchmakingAvailable(d.a.club)||!isClubMatchmakingAvailable(d.b.club)){ await interaction.followUp({content:"❌ One of these clubs is currently isolated by war operations. Refresh the pair.",flags:MessageFlags.Ephemeral}); return; }
            const gap=Math.abs(Number(d.a.elo)-Number(d.b.elo));
            if(gap>MATCHMAKING_MAX_GAP){ await interaction.followUp({content:`❌ Gap is **${gap}**. Maximum allowed is **${MATCHMAKING_MAX_GAP}**.`,flags:MessageFlags.Ephemeral}); return; }
            const used=manualSessionUsedKeys(session, session.editingPairIndex);
            if(used.has(normalizeClubName(d.a.club))||used.has(normalizeClubName(d.b.club))){ await interaction.followUp({content:"❌ One of these clubs is already used in another pair.",flags:MessageFlags.Ephemeral}); return; }
            const savedPair={a:d.a,b:d.b,winnerSide:d.winnerSide};
            if(session.editingPairIndex != null) session.pairs[session.editingPairIndex]=savedPair; else session.pairs.push(savedPair);
            session.editingPairIndex=null;
            session.draft={a:null,b:null,winnerSide:null};
            await interaction.editReply(buildManualMatchmakingView(session));
            return;
          }
          if (action === "man_remove" && interaction.isButton()) {
            if(session.editingPairIndex != null) session.pairs.splice(session.editingPairIndex,1); else session.pairs.pop();
            session.editingPairIndex=null; session.draft={a:null,b:null,winnerSide:null};
            await interaction.editReply(buildManualMatchmakingView(session)); return;
          }
          if (action === "man_cancel" && interaction.isButton()) { manualMatchSessions.delete(session.id); await interaction.editReply({content:"❌ Manual matchmaking cancelled.",components:[]}); return; }
          if (action === "man_generate" && interaction.isButton()) {
            if(!session.pairs.length){ await interaction.followUp({content:"❌ Add at least one pair first.",flags:MessageFlags.Ephemeral}); return; }
            const plan=planFromManualSession(session,interaction);
            matchPlans.set(plan.id,plan); await saveMatchPlansNow(); manualMatchSessions.delete(session.id);
            const chunks=splitDiscordText(formatManualPlanOutput(plan));
            await interaction.editReply({content:`✅ ${session.mode==='edit'?'Matchmaking updated':'Manual matchmaking generated'}.\n🆔 Match ID: **${plan.id}**\n☁️ **Database synchronized with Supabase.**`,components:[]});
            for(const chunk of chunks) await interaction.followUp({content:chunk});
            const controlsMsg=await interaction.followUp({content:`🆔 **${plan.id}** • Match controls`,components:[buildMatchPlanKoButton(plan.id)]});
            plan.matchControlsMessageId=controlsMsg.id;
            plan.matchControlsChannelId=controlsMsg.channelId||interaction.channelId;
            plan.updatedAt=Date.now();
            matchPlans.set(plan.id,plan);
            await saveMatchPlansNow();
            return;
          }
        } catch(error){ console.error("❌ Manual matchmaking component error:",error); try{await interaction.followUp({content:"❌ Failed to process manual matchmaking.",flags:MessageFlags.Ephemeral});}catch{} }
        return;
      }

      // Bulk add confirmation controls.
      if (customId.startsWith("bulk_")) {
        const [action, sessionId] = customId.split(":");
        const session = bulkAddSessions.get(sessionId);
        try { await interaction.deferUpdate(); } catch { return; }
        if(!session || String(session.userId)!==String(interaction.user.id)){ await interaction.followUp({content:"❌ This bulk-add session has expired.",flags:MessageFlags.Ephemeral}); return; }
        if(action==="bulk_cancel"){ bulkAddSessions.delete(session.id); await interaction.editReply({content:"❌ Bulk add cancelled.",components:[]}); return; }
        if(action==="bulk_confirm"){
          reloadLatestDatabase();
          const actuallyAdded=[];
          for(const item of session.valid){ if(findClubIndex(item.club)===-1){ leaderboardData.push({...item}); actuallyAdded.push(item); } }
          if(!actuallyAdded.length){ bulkAddSessions.delete(session.id); await interaction.editReply({content:"ℹ️ No new clubs were added. They may already exist.",components:[]}); return; }
          if(!saveDatabase()){ await interaction.editReply({content:"❌ Failed to save bulk club addition.",components:[]}); return; }
          await flushSupabaseStateSave("elo_database"); bulkAddSessions.delete(session.id);
          await interaction.editReply({content:`✅ **BULK ADD COMPLETE**\n\n🏰 Clubs added: **${actuallyAdded.length}**\n☁️ **Database synchronized with Supabase.**`,components:[]});
          return;
        }
      }

      if (
        customId.startsWith(
          "dm_"
        )
      ) {
        const parts =
          customId.split(":");

        const action =
          parts[0];

        const sessionId =
          parts[1];

        try {
          await interaction.deferUpdate();
        } catch (error) {
          console.error("❌ Derby management component deferUpdate failed:", error);
          return;
        }

        const session =
          derbyManageSessions.get(
            sessionId
          );

        if (!session) {
          await interaction.followUp({
            content:
              "❌ This Derby list selection has expired. Run the command again.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          interaction.user.id !==
          session.userId
        ) {
          await interaction.followUp({
            content:
              "❌ Only the user who opened this Derby list menu can use it.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        session.updatedAt =
          Date.now();

        try {
          if (
            action === "dm_prev" &&
            interaction.isButton()
          ) {
            session.page =
              Math.max(
                0,
                session.page - 1
              );

            await interaction.editReply(
              buildDerbyManageView(
                session
              )
            );

            return;
          }

          if (
            action === "dm_next" &&
            interaction.isButton()
          ) {
            session.page =
              Math.min(
                getDerbyManagePageCount(
                  session
                ) - 1,
                session.page + 1
              );

            await interaction.editReply(
              buildDerbyManageView(
                session
              )
            );

            return;
          }

          if (
            action === "dm_cancel" &&
            interaction.isButton()
          ) {
            derbyManageSessions.delete(
              session.id
            );

            await interaction.editReply({
              content:
                "❌ Derby list update cancelled.",
              components: []
            });

            return;
          }

          if (
            action === "dm_select" &&
            interaction.isStringSelectMenu()
          ) {
            if (!(session.selectedKeys instanceof Set)) {
              session.selectedKeys = new Set();
            }

            const pageKeys = new Set(
              getDerbyManagePageItems(session).map(item => normalizeClubName(item.club))
            );

            // Replace only the selections visible on this page; preserve selections
            // made on other pages. Discord multi-select values represent the full
            // current selection for this page.
            for (const key of pageKeys) session.selectedKeys.delete(key);
            for (const key of interaction.values) session.selectedKeys.add(key);

            await interaction.editReply(buildDerbyManageView(session));
            return;
          }

          if (
            action === "dm_confirm" &&
            interaction.isButton()
          ) {
            if (!(session.selectedKeys instanceof Set) || session.selectedKeys.size === 0) {
              await interaction.followUp({
                content: "❌ Select at least one club first.",
                flags: MessageFlags.Ephemeral
              });
              return;
            }

            reloadLatestDatabase();

            const selectedClubs = leaderboardData.filter(item =>
              session.selectedKeys.has(normalizeClubName(item.club))
            );

            if (selectedClubs.length === 0) {
              derbyManageSessions.delete(session.id);
              await interaction.editReply({
                content: "❌ Selected clubs are no longer available in the ELO database.",
                components: []
              });
              return;
            }

            const before = [...derbyExcludedClubs];
            const changedClubs = [];

            for (const selected of selectedClubs) {
              const changed = session.mode === "add"
                ? addClubToDerbyList(selected.club)
                : removeClubFromDerbyList(selected.club);
              if (changed) changedClubs.push(selected);
            }

            if (changedClubs.length === 0) {
              derbyManageSessions.delete(session.id);
              await interaction.editReply({
                content: session.mode === "add"
                  ? "ℹ️ All selected clubs are already in the Derby list."
                  : "ℹ️ All selected clubs are already out of the Derby list.",
                components: []
              });
              return;
            }

            if (!saveDerbyConfig()) {
              derbyExcludedClubs = before;
              await interaction.editReply({
                content: "❌ Failed to save the Derby list changes.",
                components: []
              });
              return;
            }

            await flushSupabaseStateSave("derby_config");
            derbyManageSessions.delete(session.id);

            const derbyCount = getDerbyLeaderboard().length;
            const clubLines = changedClubs
              .sort((a,b) => Number(b.elo)-Number(a.elo))
              .map(item => `- ${item.club} (${item.elo}) - ${item.president || "Not Set"}`)
              .join("\n");

            await interaction.editReply({
              content:
                (session.mode === "add"
                  ? `✅ **${changedClubs.length} CLUB${changedClubs.length === 1 ? "" : "S"} ADDED TO DERBY LIST**`
                  : `✅ **${changedClubs.length} CLUB${changedClubs.length === 1 ? "" : "S"} REMOVED FROM DERBY LIST**`) +
                `\n\n${clubLines}` +
                `\n\n🏇 Current Derby clubs: **${derbyCount}**` +
                `\n☁️ **Database synchronized with Supabase.**` +
                `\n⚡ No GitHub redeploy triggered.`,
              components: []
            });
            return;
          }
        } catch (error) {
          console.error(
            "❌ Derby management component error:",
            error
          );

          try {
            if (
              interaction.replied ||
              interaction.deferred
            ) {
              await interaction.followUp({
                content:
                  "❌ Failed to process the Derby list update.",
                flags:
                  MessageFlags.Ephemeral
              });
            } else {
              await interaction.followUp({
                content:
                  "❌ Failed to process the Derby list update.",
                flags:
                  MessageFlags.Ephemeral
              });
            }
          } catch {}

          return;
        }
      }

      if (customId.startsWith("mss_")) {
        const [action,sessionId]=customId.split(":");
        try { await interaction.deferUpdate(); }
        catch(error){ console.error("❌ Match-success component deferUpdate failed:",error); return; }

        cleanupMatchSuccessSessions();
        const session=matchSuccessSessions.get(sessionId);
        if(!session){
          await interaction.followUp({content:"❌ This match-success selection has expired. Run /match_success again.",flags:MessageFlags.Ephemeral});
          return;
        }
        if(String(interaction.user.id)!==String(session.userId)){
          await interaction.followUp({content:"❌ Only the user who opened this menu can use it.",flags:MessageFlags.Ephemeral});
          return;
        }
        session.updatedAt=Date.now();

        try {
          if(action==="mss_select" && interaction.isStringSelectMenu()){
            const start=session.page*MATCH_SUCCESS_PAGE_SIZE;
            const pageItems=session.pairs.slice(start,start+MATCH_SUCCESS_PAGE_SIZE);
            for(const pair of pageItems) session.selected.delete(Number(pair.pairNo));
            for(const value of interaction.values) session.selected.add(Number(value));
            await interaction.editReply(buildMatchSuccessView(session));
            return;
          }
          if(action==="mss_prev" && interaction.isButton()){
            session.page=Math.max(0,session.page-1);
            await interaction.editReply(buildMatchSuccessView(session));
            return;
          }
          if(action==="mss_next" && interaction.isButton()){
            session.page=Math.min(Math.max(0,Math.ceil(session.pairs.length/MATCH_SUCCESS_PAGE_SIZE)-1),session.page+1);
            await interaction.editReply(buildMatchSuccessView(session));
            return;
          }
          if(action==="mss_clear" && interaction.isButton()){
            session.selected.clear();
            await interaction.editReply(buildMatchSuccessView(session));
            return;
          }
          if(action==="mss_cancel" && interaction.isButton()){
            matchSuccessSessions.delete(session.id);
            await interaction.editReply({content:"❌ Match-success update cancelled.",components:[]});
            return;
          }
          if(action==="mss_confirm" && interaction.isButton()){
            if(!session.selected.size){
              await interaction.followUp({content:"❌ Select at least one pair first.",flags:MessageFlags.Ephemeral});
              return;
            }
            const result=await applyMatchSuccessPairs(session.matchId,session.selected,interaction.user.id);
            matchSuccessSessions.delete(session.id);
            if(!result.ok){
              await interaction.editReply({content:"ℹ️ The selected pair(s) are no longer eligible to be marked SUCCESS. A club may already be FAILED, EXCLUDED or SUCCESS.",components:[]});
              return;
            }
            const lines=result.changedPairs.map(pair=>{
              const [a,b]=pair.clubs;
              return `- Pair ${pair.pairNo}: ${a.club} + ${b.club}`;
            }).join("\n");
            const event=getActiveEvent();
            const statsLine=(event && result.plan.eventId===event.id)
              ? `\n\n${formatEventStats(event)}`
              : "";
            await interaction.editReply({
              content:`✅ **MATCH SUCCESS UPDATED**\n🆔 Match ID: **${session.matchId}**\n\n${lines}\n\n☁️ **Database synchronized with Supabase.**${statsLine}`,
              components:[]
            });
            return;
          }
        } catch(error){
          console.error("❌ Match-success component error:",error);
          try{ await interaction.followUp({content:"❌ Failed to update successful pairs.",flags:MessageFlags.Ephemeral}); }catch{}
          return;
        }
      }

      if (customId.startsWith("mc_")) {
        const [action, sessionId] = customId.split(":");

        try {
          await interaction.deferUpdate();
        } catch (error) {
          console.error("❌ Cancel-matchmaking component deferUpdate failed:", error);
          return;
        }

        cleanupMatchCancelSessions();
        const session = matchCancelSessions.get(sessionId);
        if (!session) {
          await interaction.followUp({
            content: "❌ This cancel matchmaking selection has expired. Run /cancel_matchmaking again.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (String(interaction.user.id) !== String(session.userId)) {
          await interaction.followUp({
            content: "❌ Only the user who opened this menu can use it.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        session.updatedAt = Date.now();
        try {
          if (action === "mc_select" && interaction.isStringSelectMenu()) {
            session.selectedId = normalizeMatchId(interaction.values[0]);
            await interaction.editReply(buildMatchCancelView(session));
            return;
          }

          if (action === "mc_prev" && interaction.isButton()) {
            session.page = Math.max(0, session.page - 1);
            session.selectedId = null;
            await interaction.editReply(buildMatchCancelView(session));
            return;
          }

          if (action === "mc_next" && interaction.isButton()) {
            session.page = Math.min(getMatchCancelPageCount(session) - 1, session.page + 1);
            session.selectedId = null;
            await interaction.editReply(buildMatchCancelView(session));
            return;
          }

          if (action === "mc_cancel" && interaction.isButton()) {
            matchCancelSessions.delete(session.id);
            await interaction.editReply({ content: "❌ Cancel matchmaking menu closed.", components: [] });
            return;
          }

          if (action === "mc_confirm" && interaction.isButton()) {
            const matchId = normalizeMatchId(session.selectedId);
            if (!matchId) {
              await interaction.followUp({ content: "❌ Choose a Match ID first.", flags: MessageFlags.Ephemeral });
              return;
            }

            const currentPlan = getMatchPlan(matchId);
            if (!currentPlan) {
              matchCancelSessions.delete(session.id);
              await interaction.editReply({ content: `❌ Match ID **${matchId}** is no longer available.`, components: [] });
              return;
            }

            if (currentPlan.guildId && interaction.guildId && String(currentPlan.guildId) !== String(interaction.guildId)) {
              await interaction.followUp({ content: `❌ Match ID **${matchId}** does not belong to this server.`, flags: MessageFlags.Ephemeral });
              return;
            }

            const now = Date.now();

            currentPlan.status = 'CANCELLED';
            currentPlan.cancelledAt = now;
            currentPlan.cancelledBy = String(interaction.user.id);
            currentPlan.lifecycleTrackingStoppedAt = now;
            currentPlan.updatedAt = now;

            await saveMatchPlansNow();
            matchCancelSessions.delete(session.id);

            await interaction.editReply({
              content:
                `❌ **MATCH ID CANCELLED**\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🆔 Match ID: **${matchId}**\n` +
                `📌 Status: **CANCELLED**\n` +
                `👤 Cancelled by: <@${interaction.user.id}>\n` +
                `🕒 Cancelled: <t:${Math.floor(now / 1000)}:F>\n\n` +
                `Historical record has been retained.\n` +
                `No further Match ID lifecycle tracking will continue.\n\n` +
                `☁️ **Database synchronized with Supabase.**`,
              components: [],
              allowedMentions: { users: [] }
            });

            console.log(`❌ Match ID ${matchId} marked CANCELLED and retained in Supabase.`);
            return;
          }
        } catch (error) {
          console.error("❌ Cancel-matchmaking component error:", error);
          try {
            await interaction.followUp({ content: "❌ Failed to cancel Match ID.", flags: MessageFlags.Ephemeral });
          } catch {}
          return;
        }
      }

      if (customId.startsWith("ms_")) {
        const [action, sessionId] = customId.split(":");

        try {
          await interaction.deferUpdate();
        } catch (error) {
          console.error("❌ Match-status component deferUpdate failed:", error);
          return;
        }

        cleanupMatchStatusSessions();
        const session = matchStatusSessions.get(sessionId);
        if (!session) {
          await interaction.followUp({
            content: "❌ This Match ID status selection has expired. Run the command again.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (String(interaction.user.id) !== String(session.userId)) {
          await interaction.followUp({
            content: "❌ Only the user who opened this menu can use it.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        session.updatedAt = Date.now();
        try {
          if (action === "ms_select" && interaction.isStringSelectMenu()) {
            const pageKeys = new Set(getMatchStatusPageItems(session).map(item => normalizeClubName(item.club)));
            for (const key of pageKeys) session.selected.delete(key);
            for (const key of interaction.values) session.selected.add(String(key));
            await interaction.editReply(buildMatchStatusView(session));
            return;
          }

          if (action === "ms_prev" && interaction.isButton()) {
            session.page = Math.max(0, session.page - 1);
            await interaction.editReply(buildMatchStatusView(session));
            return;
          }

          if (action === "ms_next" && interaction.isButton()) {
            session.page = Math.min(getMatchStatusPageCount(session) - 1, session.page + 1);
            await interaction.editReply(buildMatchStatusView(session));
            return;
          }

          if (action === "ms_clear" && interaction.isButton()) {
            session.selected.clear();
            await interaction.editReply(buildMatchStatusView(session));
            return;
          }

          if (action === "ms_cancel" && interaction.isButton()) {
            matchStatusSessions.delete(session.id);
            await interaction.editReply({ content: "❌ Match status update cancelled.", components: [] });
            return;
          }

          if (action === "ms_confirm" && interaction.isButton()) {
            if (session.selected.size === 0) {
              await interaction.followUp({ content: "❌ Select at least one club first.", flags: MessageFlags.Ephemeral });
              return;
            }

            // Re-read the authoritative Match ID plan just before applying the
            // update, so a stale menu cannot overwrite a newer saved plan.
            const currentPlan = getMatchPlan(session.matchId);
            if (!currentPlan || !Array.isArray(currentPlan.clubs)) {
              matchStatusSessions.delete(session.id);
              await interaction.editReply({ content: `❌ Match ID **${session.matchId}** is no longer available.`, components: [] });
              return;
            }

            const changed = [];
            const now = Date.now();
            for (const club of currentPlan.clubs) {
              const key = normalizeClubName(club.club);
              if (!session.selected.has(key)) continue;

              if (session.mode === "fail") {
                if (String(club.status || "matched").toLowerCase() === "failed") continue;
                club.status = "failed";
                club.failedAt = now;
                club.failedBy = interaction.user.id;
                changed.push(club);
              } else {
                if (String(club.status || "matched").toLowerCase() !== "failed") continue;
                club.status = "pending";
                club.failedAt = null;
                club.failedBy = null;
                changed.push(club);
              }
            }

            if (changed.length === 0) {
              await interaction.editReply({
                content: session.mode === "fail"
                  ? "ℹ️ The selected clubs are already marked as failed."
                  : "ℹ️ The selected clubs are already active/matched.",
                components: []
              });
              matchStatusSessions.delete(session.id);
              return;
            }

            currentPlan.updatedAt = now;
            currentPlan.updatedBy = interaction.user.id;
            matchPlans.set(session.matchId, currentPlan);
            await saveMatchPlansNow();
            matchStatusSessions.delete(session.id);

            const activeCount = getMatchPlanActiveClubs(currentPlan).length;
            const failedCount = getMatchPlanFailedClubs(currentPlan).length;
            const lines = changed
              .sort((a, b) => Number(b.elo) - Number(a.elo))
              .map(item => `- ${item.club} (${Number(item.elo) || 0}) - ${item.president || "Not Set"}`)
              .join("\n");

            await interaction.editReply({
              content:
                `${session.mode === "fail" ? "❌ **MATCH FAILED UPDATED**" : "✅ **MATCH CLUBS RESTORED**"}\n` +
                `🆔 Match ID: **${session.matchId}**\n\n${lines}\n\n` +
                `✅ Active Clubs: **${activeCount}**\n` +
                `❌ Failed Clubs: **${failedCount}**\n` +
                `☁️ **Database synchronized with Supabase.**`,
              components: []
            });
            return;
          }
        } catch (error) {
          console.error("❌ Match-status component error:", error);
          try {
            await interaction.followUp({ content: "❌ Failed to update Match ID status.", flags: MessageFlags.Ephemeral });
          } catch {}
          return;
        }
      }

      if (
        customId.startsWith(
          "dc_"
        )
      ) {
        const parts =
          customId.split(":");

        const action =
          parts[0];

        const sessionId =
          parts[1];

        try {
          await interaction.deferUpdate();
        } catch (error) {
          console.error("❌ Delete-club component deferUpdate failed:", error);
          return;
        }

        const session =
          deleteClubSessions.get(
            sessionId
          );

        if (!session) {
          await interaction.followUp({
            content:
              "❌ This delete-club selection has expired. Run `/delete_club` again.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          interaction.user.id !==
          session.userId
        ) {
          await interaction.followUp({
            content:
              "❌ Only the user who opened this delete menu can use it.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        session.updatedAt =
          Date.now();

        try {
          if (
            action === "dc_prev" &&
            interaction.isButton()
          ) {
            session.page =
              Math.max(
                0,
                session.page - 1
              );

            await interaction.editReply(
              buildDeleteClubView(
                session
              )
            );

            return;
          }

          if (
            action === "dc_next" &&
            interaction.isButton()
          ) {
            session.page =
              Math.min(
                getDeleteClubPageCount(
                  session
                ) - 1,
                session.page + 1
              );

            await interaction.editReply(
              buildDeleteClubView(
                session
              )
            );

            return;
          }

          if (
            action === "dc_cancel" &&
            interaction.isButton()
          ) {
            deleteClubSessions.delete(
              session.id
            );

            await interaction.editReply({
              content:
                "❌ Delete club cancelled.",
              components: []
            });

            return;
          }

          if (action === "dc_select" && interaction.isStringSelectMenu()) {
            if (!(session.selectedKeys instanceof Set)) session.selectedKeys = new Set();
            const pageKeys = new Set(getDeleteClubPageItems(session).map(item => normalizeClubName(item.club)));
            for (const key of pageKeys) session.selectedKeys.delete(key);
            for (const key of interaction.values) session.selectedKeys.add(String(key));
            await interaction.editReply(buildDeleteClubView(session));
            return;
          }

          if (action === "dc_back" && interaction.isButton()) {
            session.confirming = false;
            await interaction.editReply(buildDeleteClubView(session));
            return;
          }

          if (action === "dc_confirm" && interaction.isButton()) {
            if (!(session.selectedKeys instanceof Set) || session.selectedKeys.size === 0) {
              await interaction.followUp({ content: "❌ Select at least one club first.", flags: MessageFlags.Ephemeral });
              return;
            }

            reloadLatestDatabase();
            const selected = leaderboardData.filter(item => session.selectedKeys.has(normalizeClubName(item.club)));
            if (!selected.length) {
              deleteClubSessions.delete(session.id);
              await interaction.editReply({ content: "❌ Selected clubs are no longer in the database.", components: [] });
              return;
            }

            // First click shows a confirmation preview. Second click performs deletion.
            if (!session.confirming) {
              session.confirming = true;
              const lines = selected.slice().sort((a,b)=>Number(b.elo)-Number(a.elo))
                .map(item => `- ${item.club} (${item.elo}) - ${item.president || "Not Set"}`).join("\n");
              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`dc_confirm:${session.id}`).setLabel("CONFIRM DELETE").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`dc_back:${session.id}`).setLabel("Back").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`dc_cancel:${session.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
              );
              await interaction.editReply({
                content: (`⚠️ **CONFIRM CLUB DELETION**\n\nSelected Clubs: **${selected.length}**\n\n${lines}\n\nThis will permanently remove all selected clubs from the ELO database.`).slice(0,1900),
                components:[row]
              });
              return;
            }

            const backup = cloneData(leaderboardData);
            leaderboardData = leaderboardData.filter(item => !session.selectedKeys.has(normalizeClubName(item.club)));
            if (!saveDatabase()) {
              leaderboardData = backup;
              await interaction.editReply({ content: "❌ Failed to save club deletion.", components: [] });
              return;
            }
            await flushSupabaseStateSave("elo_database");
            deleteClubSessions.delete(session.id);
            const lines = selected.slice().sort((a,b)=>Number(b.elo)-Number(a.elo))
              .map(item => `- ${item.club} (${item.elo}) - ${item.president || "Not Set"}`).join("\n");
            await interaction.editReply({
              content:(`✅ **${selected.length} CLUB${selected.length===1?"":"S"} DELETED**\n\n${lines}\n\n☁️ **Database synchronized with Supabase.**`).slice(0,1900),
              components:[]
            });
            return;
          }
        } catch (error) {
          console.error(
            "❌ /delete_club component error:",
            error
          );

          try {
            if (
              interaction.replied ||
              interaction.deferred
            ) {
              await interaction.followUp({
                content:
                  "❌ Failed to process club deletion.",
                flags:
                  MessageFlags.Ephemeral
              });
            } else {
              await interaction.followUp({
                content:
                  "❌ Failed to process club deletion.",
                flags:
                  MessageFlags.Ephemeral
              });
            }
          } catch {}

          return;
        }
      }

      if (
        customId.startsWith(
          "ft_cancel_timer_select:"
        ) &&
        interaction.isStringSelectMenu()
      ) {
        try {
          await interaction.deferUpdate();
          const ownerId =
            customId.split(":")[1];

          if (
            interaction.user.id !==
            ownerId
          ) {
            await interaction.followUp({
              content:
                "❌ Only the user who opened this menu can use it.",
              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          const timerId =
            interaction.values[0];

          const timerIndex =
            activeFowTimers.findIndex(
              timer =>
                timer.id === timerId &&
                timer.guildId ===
                  interaction.guildId &&
                getFowTimerDestinationId(
                  timer
                ) ===
                  interaction.channelId
            );

          if (
            timerIndex === -1
          ) {
            await interaction.editReply({
              content:
                "❌ This timer is no longer active.",
              components: []
            });

            return;
          }

          const [
            cancelledTimer
          ] =
            activeFowTimers.splice(
              timerIndex,
              1
            );

          // Persist the cancellation to both the local snapshot and Supabase
          // before confirming it to Discord. This prevents a cancelled timer
          // from reappearing after a redeploy/restart.
          saveFowTimers();
          await flushSupabaseStateSave("active_fow_timers");

          console.log(
            `🛑 Timer ${cancelledTimer.id} cancelled in destination ${interaction.channelId} and persisted • active timers: ${activeFowTimers.length}`
          );

          const typeLabel =
            cancelledTimer.type ===
              "test"
              ? `TEST ${
                  cancelledTimer.testNotification ===
                    "start"
                    ? "War Start"
                    : "War End"
                }`
              : cancelledTimer.type ===
                  "push"
                ? (
                    Number.isInteger(
                      Number(cancelledTimer.durationMinutes)
                    ) &&
                    Number(cancelledTimer.durationMinutes) > 0
                      ? (cancelledTimer.pushMode === "manual"
                          ? `${cancelledTimer.durationMinutes} Minutes Manual Preparation`
                          : `${cancelledTimer.durationMinutes} Minutes Push Test Preparation`)
                      : `${cancelledTimer.hours} Hours Preparation`
                  )
                : cancelledTimer.hours === 2
                  ? "2 Hours KO Timer"
                  : "14 Hours KO + Cooling Down";

          await interaction.editReply({
            content:
              "🛑 **FOW TIMER CANCELLED**\n\n" +
              `⏱️ Timer: **${typeLabel}**\n` +
              `🏰 Clubs: **${cancelledTimer.clubs.length}**\n\n` +
              "This timer has been stopped and no further reminders will be sent.",
            components: []
          });

        } catch (error) {
          console.error(
            "❌ Cancel timer error:",
            error
          );

          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.followUp({
              content:
                "❌ Failed to cancel the timer.",
              flags:
                MessageFlags.Ephemeral
            });
          } else {
            await interaction.followUp({
              content:
                "❌ Failed to cancel the timer.",
              flags:
                MessageFlags.Ephemeral
            });
          }
        }

        return;
      }

      if (
        customId.startsWith(
          "ft_"
        )
      ) {
        const parts =
          customId.split(":");

        const action =
          parts[0];

        const sessionId =
          parts[1];

        // Acknowledge the component immediately. Discord components have a
        // short acknowledgement window; recovery from Supabase must happen
        // only after the interaction has been acknowledged.
        try {
          await interaction.deferUpdate();
        } catch (error) {
          console.error("❌ Timer component deferUpdate failed:", error);
          return;
        }

        const session =
          await recoverFowTimerSetupSession(
            sessionId
          );

        if (!session) {
          await interaction.followUp({
            content:
              "❌ This timer setup has expired. Run the command again.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          interaction.user.id !==
          session.userId
        ) {
          await interaction.followUp({
            content:
              "❌ Only the user who started this timer can change it.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        session.updatedAt =
          Date.now();

        try {
          if (
            action === "ft_select" &&
            interaction.isStringSelectMenu()
          ) {
            const pageItems =
              getFowTimerSetupPageItems(
                session
              );

            const pageKeys =
              new Set(
                pageItems.map(
                  item =>
                    normalizeClubName(
                      item.club
                    )
                )
              );

            for (
              const key of pageKeys
            ) {
              session.selected.delete(
                key
              );
            }

            for (
              const key of
              interaction.values
            ) {
              session.selected.add(
                key
              );
            }

            await persistFowTimerSetupSession(session);

            await interaction.editReply(
              buildFowTimerSetupView(
                session
              )
            );

            return;
          }

          if (
            action === "ft_prev" &&
            interaction.isButton()
          ) {
            session.page =
              Math.max(
                0,
                session.page - 1
              );

            await persistFowTimerSetupSession(session);

            await interaction.editReply(
              buildFowTimerSetupView(
                session
              )
            );

            return;
          }

          if (
            action === "ft_next" &&
            interaction.isButton()
          ) {
            const pageCount =
              getFowTimerSetupPageCount(
                session
              );

            session.page =
              Math.min(
                pageCount - 1,
                session.page + 1
              );

            await persistFowTimerSetupSession(session);

            await interaction.editReply(
              buildFowTimerSetupView(
                session
              )
            );

            return;
          }

          if (
            action === "ft_clear" &&
            interaction.isButton()
          ) {
            session.selected.clear();

            await persistFowTimerSetupSession(session);

            await interaction.editReply(
              buildFowTimerSetupView(
                session
              )
            );

            return;
          }

          if (
            action === "ft_cancel" &&
            interaction.isButton()
          ) {
            await deleteFowTimerSetupSessionPersistent(session.id);

            await interaction.editReply({
              content:
                "❌ Timer setup cancelled.",
              components: []
            });

            return;
          }

          if (
            action === "ft_start" &&
            interaction.isButton()
          ) {
            // Refresh once more from the per-session Supabase snapshot before
            // starting. The previous select-menu interaction may have been
            // handled by a different/restarted worker.
            const latestRemoteSession =
              await loadFowTimerSetupSessionFromSupabase(session.id);
            if (
              latestRemoteSession &&
              Number(latestRemoteSession.updatedAt || 0) >= Number(session.updatedAt || 0)
            ) {
              session.selected = latestRemoteSession.selected;
              session.page = latestRemoteSession.page;
              session.updatedAt = latestRemoteSession.updatedAt;
              fowTimerSetupSessions.set(session.id, session);
            }

            // Last-resort recovery from the message currently visible in
            // Discord. buildFowTimerSetupView marks selected options as
            // default=true, so the button interaction can reconstruct the
            // visible selection even if a stale worker lost its Set.
            if (session.selected.size === 0 && interaction.message?.components) {
              for (const row of interaction.message.components) {
                for (const component of row.components || []) {
                  const cid = component.customId || component.data?.custom_id;
                  if (cid !== `ft_select:${session.id}`) continue;
                  for (const option of component.options || component.data?.options || []) {
                    const isDefault = option.default === true || option.data?.default === true;
                    const value = option.value ?? option.data?.value;
                    if (isDefault && value) session.selected.add(String(value));
                  }
                }
              }
            }

            if (
              session.selected.size === 0
            ) {
              await interaction.followUp({
                content:
                  "❌ Select at least one club first.",
                flags:
                  MessageFlags.Ephemeral
              });

              return;
            }

            const timer =
              createActiveFowTimer(
                session
              );

            // Do not acknowledge a successful START until the timer snapshot is
            // durably stored in Supabase. This closes the small redeploy/crash
            // window immediately after pressing START TIMER / START PUSH.
            await flushSupabaseStateSave("active_fow_timers");

            await deleteFowTimerSetupSessionPersistent(session.id);

            const clubList =
              timer.type === "push"
                ? formatFowTimerClubList(timer.clubs)
                : formatFowTimerClubListPlain(timer.clubs);

            const title =
              timer.type === "push"
                ? "🚀⚔️ FOW PUSH STARTED ⚔️🚀"
                : isKoOnlyTimer(timer)
                  ? "🥊 **FOW KO TIMER STARTED**"
                  : "🥊🧊 **FOW KO + COOLING DOWN STARTED**";

            const timerLine =
              timer.type === "push"
                ? (
                    Number.isInteger(
                      Number(timer.durationMinutes)
                    ) &&
                    Number(timer.durationMinutes) > 0
                      ? (timer.pushMode === "manual"
                          ? `⏳ Manual Preparation: **${timer.durationMinutes} Minute${Number(timer.durationMinutes) === 1 ? "" : "s"}**`
                          : `🧪⏳ Push Test Preparation: **${timer.durationMinutes} Minute${Number(timer.durationMinutes) === 1 ? "" : "s"}**`)
                      : `⏳ Preparation: **${timer.hours} Hours**`
                  )
                : timer.type === "war_done_manual"
                  ? (
                      timer.warDoneMode === "ko"
                        ? `🥊 KO Timer: **${timer.durationMinutes} Minute${timer.durationMinutes === 1 ? "" : "s"}**`
                        : `❄️🥊 KO + Cooling Down: **${timer.durationMinutes} Minute${timer.durationMinutes === 1 ? "" : "s"}**`
                    )
                  : timer.hours === 2
                    ? "🥊 KO Timer: **2 Hours**"
                    : "❄️🥊 KO + Cooling Down: **14 Hours**";

            await interaction.editReply({
              content:
                `${title}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `${timerLine}\n` +
                (timer.operationalMode && timer.type === "push" ? `🎮 Mode: **${getOperationalModeLabel(timer.operationalMode)}**\n` : ``) +
                (timer.matchId ? `🆔 Match ID: **${timer.matchId}**\n` : ``) +
                `🏰 Clubs: **${timer.clubs.length}**\n\n` +
                `${clubList}\n\n` +
                `🕘 Ends: <t:${Math.floor(timer.endAt / 1000)}:F>\n` +
                (
                  timer.type === "push" &&
                  Number.isFinite(Number(timer.durationMinutes)) &&
                  Number(timer.durationMinutes) > 0 &&
                  Number(timer.durationMinutes) < 15
                    ? `🔔 15-minute reminder: **Not scheduled** for a test shorter than 15 minutes.`
                    : `🔔 Reminder: **15 Minutes** before timer ends.`
                ) +
                (timer.type === "push" ? `` : `\n🚫 Matchmaking: **Isolated**`),
              components: []
            });

            return;
          }

        } catch (error) {
          console.error(
            "❌ FoW timer setup error:",
            error
          );

          try {
            if (
              interaction.deferred ||
              interaction.replied
            ) {
              await interaction.followUp({
                content:
                  "❌ Failed to process the timer setup.",
                flags:
                  MessageFlags.Ephemeral
              });
            } else {
              await interaction.reply({
                content:
                  "❌ Failed to process the timer setup.",
                flags:
                  MessageFlags.Ephemeral
              });
            }
          } catch {}

          return;
        }
      }

      if (
        customId.startsWith(
          "mm_"
        )
      ) {
        const parts = customId.split(":");
        const action = parts[0];
        const sessionId = parts[1];

        // Always acknowledge the component before any disk/Supabase work.
        try {
          await interaction.deferUpdate();
        } catch (error) {
          console.error("❌ Matchmaking component deferUpdate failed:", error);
          return;
        }

        const session = await recoverMatchmakingSession(sessionId);

        if (!session) {
          await interaction.followUp({
            content: "❌ This matchmaking selection has expired. Run `/matchmaking` again.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        if (interaction.user.id !== session.userId) {
          await interaction.followUp({
            content: "❌ Only the user who started this matchmaking can change these selections.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        session.updatedAt = Date.now();

        try {
          if (action === "mm_select" && interaction.isStringSelectMenu()) {
            const pageItems = getMatchmakingSessionPageItems(session);
            const pageKeys = new Set(pageItems.map(item => normalizeClubName(item.club)));
            const targetSet = getMatchmakingCategorySet(session);

            for (const key of pageKeys) targetSet.delete(key);
            for (const key of interaction.values) {
              removeClubFromOtherSelections(session, session.category, key);
              targetSet.add(key);
            }

            await persistMatchmakingSessionsNow();
            await interaction.editReply(buildMatchmakingSelectionView(session));
            return;
          }

          if (action === "mm_category" && interaction.isButton()) {
            const category = parts[2];
            if (["must_win", "must_lose", "skip"].includes(category)) {
              session.category = category;
              session.page = 0;
            }
            await persistMatchmakingSessionsNow();
            await interaction.editReply(buildMatchmakingSelectionView(session));
            return;
          }

          if (action === "mm_prev" && interaction.isButton()) {
            session.page = Math.max(0, session.page - 1);
            await persistMatchmakingSessionsNow();
            await interaction.editReply(buildMatchmakingSelectionView(session));
            return;
          }

          if (action === "mm_next" && interaction.isButton()) {
            const pageCount = getMatchmakingSessionPageCount(session);
            session.page = Math.min(pageCount - 1, session.page + 1);
            await persistMatchmakingSessionsNow();
            await interaction.editReply(buildMatchmakingSelectionView(session));
            return;
          }

          if (action === "mm_clear" && interaction.isButton()) {
            getMatchmakingCategorySet(session).clear();
            await persistMatchmakingSessionsNow();
            await interaction.editReply(buildMatchmakingSelectionView(session));
            return;
          }

          if (action === "mm_cancel" && interaction.isButton()) {
            await deleteMatchmakingSessionPersistent(session.id);
            await interaction.editReply({
              content: "❌ Matchmaking selection cancelled.",
              components: []
            });
            return;
          }

          if (action === "mm_generate" && interaction.isButton()) {
            const skipped = [];
            const available = [];

            for (const item of session.rangeData) {
              const key = normalizeClubName(item.club);
              if (session.skip.has(key)) skipped.push(item);
              else available.push(item);
            }

            const activeKeys = new Set(available.map(item => normalizeClubName(item.club)));
            const mustWinSet = new Set([...session.mustWin].filter(key => activeKeys.has(key)));
            const mustLoseSet = new Set([...session.mustLose].filter(key => activeKeys.has(key)));

            const result = optimizeMatchmaking(available, mustWinSet, mustLoseSet);

            const matchId = nextMatchId();
            const pairedClubMap = new Map();
            result.pairs.forEach((pair, pairIndex) => {
              // v54 winner rule:
              // 1) Must Win stays the winner.
              // 2) Opponent of Must Lose is the winner.
              // 3) Ordinary pairs: higher ELO is the winner.
              // Winner is stored internally for Match ID / Push filtering,
              // while Discord output only bolds the winner with no WIN text.
              let resolvedWinner = pair.winner || null;
              let resolvedLoser = pair.loser || null;

              if (!resolvedWinner || !resolvedLoser) {
                const aElo = Number(pair.a?.elo) || 0;
                const bElo = Number(pair.b?.elo) || 0;
                resolvedWinner = bElo > aElo ? pair.b : pair.a;
                resolvedLoser = resolvedWinner === pair.a ? pair.b : pair.a;
              }

              const winnerKey = resolvedWinner?.club
                ? normalizeClubName(resolvedWinner.club)
                : null;
              const loserKey = resolvedLoser?.club
                ? normalizeClubName(resolvedLoser.club)
                : null;

              for (const item of [pair.a, pair.b]) {
                if (!item || !item.club) continue;
                const itemKey = normalizeClubName(item.club);
                const matchRole = winnerKey === itemKey
                  ? "win"
                  : loserKey === itemKey
                    ? "lose"
                    : null;

                pairedClubMap.set(itemKey, {
                  club: item.club,
                  president: item.president || "",
                  elo: Number(item.elo) || 0,
                  status: "pending",
                  failedAt: null,
                  failedBy: null,
                  matchRole,
                  pairNo: pairIndex + 1
                });
              }
            });

            const matchPlan = {
              id: matchId,
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              min: session.min,
              max: session.max,
              clubs: [...pairedClubMap.values()].sort((a,b) => Number(b.elo)-Number(a.elo)),
              pairCount: result.pairs.length,
              createdAt: Date.now(),
              createdBy: interaction.user.id,
              eventId: getActiveEvent()?.id || null
            };
            matchPlans.set(matchId, matchPlan);
            await saveMatchPlansNow();

            let output = formatMatchmakingOutput(result, session.min, session.max, skipped, matchId);

            const unmatchedForced = result.unmatched.filter(item => {
              const key = normalizeClubName(item.club);
              return mustWinSet.has(key) || mustLoseSet.has(key);
            });

            if (unmatchedForced.length > 0) {
              output += `\n⚠️ **Forced clubs with no valid opponent within ${MATCHMAKING_MAX_GAP} ELO:**\n`;
              for (const item of unmatchedForced) {
                const key = normalizeClubName(item.club);
                output += `- ${item.club} (${item.elo}) — ${mustWinSet.has(key) ? "**MUST WIN / NO MATCH**" : "**MUST LOSE / NO MATCH**"}\n`;
              }
            }

            const chunks = splitDiscordText(output);
            await deleteMatchmakingSessionPersistent(session.id);

            await interaction.editReply({
              content: `✅ Selection completed. Matchmaking generated.\n🆔 Match ID: **${matchId}**\n☁️ **Database synchronized with Supabase.**`,
              components: []
            });

            for (const chunk of chunks) {
              await interaction.followUp({ content: chunk });
            }
            const controlsMsg=await interaction.followUp({content:`🆔 **${matchId}** • Match controls`,components:[buildMatchPlanKoButton(matchId)]});
            matchPlan.matchControlsMessageId=controlsMsg.id;
            matchPlan.matchControlsChannelId=controlsMsg.channelId||interaction.channelId;
            matchPlan.updatedAt=Date.now();
            matchPlans.set(matchId,matchPlan);
            await saveMatchPlansNow();

            console.log(
              `✅ Interactive /matchmaking completed: ${available.length} available, ${skipped.length} skipped, ${mustWinSet.size} must win, ${mustLoseSet.size} must lose`
            );
            return;
          }
        } catch (error) {
          console.error("❌ Interactive matchmaking error:", error);
          try {
            await interaction.followUp({
              content: "❌ Failed to process the matchmaking selection.",
              flags: MessageFlags.Ephemeral
            });
          } catch {}
          return;
        }
      }

      return;
    }

    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    console.log(
      `📥 Slash command received: /${interaction.commandName}`
    );

    // ========================================================
    // V77 WAR OPERATIONS COMMANDS
    // ========================================================
    if (interaction.commandName === "war_status") {
      try {
        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const dashboard = String(
          buildWarStatusDashboard() || ""
        );

        const chunks = [];
        let remaining = dashboard;

        while (remaining.length > 1900) {
          let cut = remaining.lastIndexOf("\n", 1900);

          if (cut <= 0) {
            cut = 1900;
          }

          chunks.push(
            remaining.slice(0, cut)
          );

          remaining =
            remaining.slice(cut).replace(/^\n/, "");
        }

        if (remaining.length) {
          chunks.push(remaining);
        }

        if (!chunks.length) {
          chunks.push(
            "ℹ️ No war status data available."
          );
        }

        await interaction.editReply({
          content: chunks[0]
        });

        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({
            content: chunks[i],
            flags: MessageFlags.Ephemeral
          });
        }

      } catch (error) {
        console.error(
          "❌ /war_status error:",
          error
        );

        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.editReply(
              "❌ Failed to load war status."
            );
          }
        } catch {}
      }

      return;
    }
    if (interaction.commandName === "war_monitor") {
      if(!isWarAdminInteraction(interaction)){await interaction.reply({content:'⛔ You are not authorized to manage war status.',flags:MessageFlags.Ephemeral});return;}
      const eventType=interaction.options.getString('event_type',true);
      const prepText=interaction.options.getString('preparation_time',false);
      let prepMs=null;
      if(eventType==='normal'||eventType==='lightning'){
        prepMs=parsePreparationDurationStrict(prepText);
        if(!prepMs){
          await interaction.reply({content:'❌ **Preparation time is required for Normal and Lightning.**\nUse format `XXh XXm` or `XXh XXmin`, for example `5h 30m` or `0h 45min`.',flags:MessageFlags.Ephemeral});
          return;
        }
      } else if(prepText){
        await interaction.reply({content:'❌ **Grease has no preparation timer.** Leave `preparation_time` empty.',flags:MessageFlags.Ephemeral});
        return;
      }
      const name=interaction.options.getString('club',true); const started=[],missing=[];
      const prepEndAt=(eventType==='normal'||eventType==='lightning') ? Date.now()+prepMs : null;
      {
        const db=leaderboardData.find(x=>areEquivalentClubNames(x.club,name));
        if(!db){missing.push(name);} else {
        if(eventType==='grease'){
          const op=startWarMonitoringForClub(db.club,eventType,{channelId:interaction.channelId,guildId:interaction.guildId,userId:interaction.user.id});
          await notifyGreaseWarStarted(op);
        }else{
          setWarOperation(db.club,{eventType,status:'PREPARATION',isolated:true,channelId:interaction.channelId,guildId:interaction.guildId,preparationEndAt:prepEndAt,monitorAfterPrep:true,preparation15mSent:false,nextReminderAt:null,reminderPending:false,nextAckReminderAt:null,lastAckBy:null,lastAckAt:null,coolingEndAt:null,warning15mSent:false,completionSent:false},interaction.user.id,'PREPARATION_STARTED_MANUAL');
        }
        started.push(db.club);
        }
      }
      const timingLine=eventType==='grease'
        ? 'Preparation: **NONE**\nFirst war status reminder: **in 2 hours**.'
        : `Preparation remaining: **<t:${Math.floor(prepEndAt/1000)}:R>**\nPreparation ends: **<t:${Math.floor(prepEndAt/1000)}:F>**\nWar status reminders: **start only after preparation ends**.\nFirst reminder after war starts: **2 hours later**.`;
      const controlOp=started.length ? getWarOperation(started[0]) : null;
      if(controlOp){
        await interaction.reply({
          content:buildWarMonitorStartedContent(controlOp),
          components:[buildWarMonitorStartedControls(controlOp)]
        });
      }else{
        await interaction.reply({
          content:`❌ War Monitor could not be started.${missing.length?`\nNot found: ${missing.join(', ')}`:''}`,
          flags:MessageFlags.Ephemeral
        });
      }
      return;
    }
    if (interaction.commandName === "war_override") {
      if(!isWarAdminInteraction(interaction)){await interaction.reply({content:'⛔ You are not authorized to manage war status.',flags:MessageFlags.Ephemeral});return;}
      const clubInput=interaction.options.getString('club',true); const db=leaderboardData.find(x=>areEquivalentClubNames(x.club,clubInput));
      if(!db){await interaction.reply({content:`❌ Club not found: **${clubInput}**`,flags:MessageFlags.Ephemeral});return;}
      const action=interaction.options.getString('action',true); const existing=getWarOperation(db.club); const type=existing?.eventType||'normal';
      if(action==='available'){ const op=setWarOperation(db.club,{status:'AVAILABLE',isolated:false,reminderPending:false,nextReminderAt:null,coolingEndAt:null,completionSent:true,channelId:existing?.channelId||interaction.channelId,guildId:interaction.guildId,eventType:type},interaction.user.id,'ADMIN_OVERRIDE_AVAILABLE'); await interaction.reply({content:`✅ **ADMIN OVERRIDE**\n${op.club} → AVAILABLE\nMatchmaking isolation removed.`,flags:MessageFlags.Ephemeral}); return; }
      if(action==='war_active'||action==='ko_active'){ const st=action==='war_active'?'WAR_ACTIVE':'KO_ACTIVE'; const op=setWarOperation(db.club,{status:st,isolated:true,channelId:existing?.channelId||interaction.channelId,guildId:interaction.guildId,eventType:type,reminderPending:false,nextReminderAt:Date.now()+WAR_REMINDER_INTERVAL_MS,coolingEndAt:null,completionSent:false},interaction.user.id,'ADMIN_OVERRIDE_ACTIVE'); await interaction.reply({content:`✅ **ADMIN OVERRIDE**\n${op.club} → ${st.replaceAll('_',' ')}\nMatchmaking: ISOLATED`,flags:MessageFlags.Ephemeral}); return; }
      if(action==='cooling'){ const mins=interaction.options.getInteger('minutes'); if(!mins){await interaction.reply({content:'❌ `minutes` is required for Cooling Down.',flags:MessageFlags.Ephemeral});return;} const op=setWarOperation(db.club,{status:'COOLING_DOWN',isolated:true,eventType:'normal',channelId:existing?.channelId||interaction.channelId,guildId:interaction.guildId,coolingEndAt:Date.now()+mins*60000,warning15mSent:mins<=15,completionSent:false,reminderPending:false,nextReminderAt:null},interaction.user.id,'ADMIN_OVERRIDE_COOLING'); await interaction.reply({content:`✅ **ADMIN OVERRIDE**\n${op.club} → COOLING DOWN\nRemaining: **${mins}m**\nMatchmaking: ISOLATED`,flags:MessageFlags.Ephemeral}); return; }
    }

    // ========================================================
    // /manual_matchmaking and /edit_matchmaking
    // ========================================================
    if (interaction.commandName === "manual_matchmaking" || interaction.commandName === "edit_matchmaking") {
      try {
        cleanupSimpleSessions(manualMatchSessions, MANUAL_MATCH_SESSION_TTL_MS);
        let pairs=[];
        let matchId=null;
        let originalCreatedAt=null;
        let originalCreatedBy=null;
        let eventId=getActiveEvent()?.id || null;
        const mode = interaction.commandName === "edit_matchmaking" ? "edit" : "create";

        if (mode === "edit") {
          matchId = normalizeMatchId(interaction.options.getString("match_id"));
          const plan = getMatchPlan(matchId);
          if (!plan || !Array.isArray(plan.clubs)) {
            await interaction.reply({content:`❌ Match ID **${matchId || "Unknown"}** was not found.`,flags:MessageFlags.Ephemeral});
            return;
          }
          if (plan.guildId && interaction.guildId && String(plan.guildId)!==String(interaction.guildId)) {
            await interaction.reply({content:`❌ Match ID **${matchId}** does not belong to this server.`,flags:MessageFlags.Ephemeral});
            return;
          }
          const grouped=new Map();
          for(const c of plan.clubs){ if(!grouped.has(c.pairNo))grouped.set(c.pairNo,[]); grouped.get(c.pairNo).push(c); }
          for(const [,arr] of [...grouped.entries()].sort((a,b)=>Number(a[0])-Number(b[0]))){
            if(arr.length!==2)continue;
            const a=arr[0],b=arr[1];
            const winnerSide=String(a.matchRole||'').toLowerCase()==='win'?'a':String(b.matchRole||'').toLowerCase()==='win'?'b':'a';
            pairs.push({a:{club:a.club,president:a.president||'',elo:Number(a.elo)||0},b:{club:b.club,president:b.president||'',elo:Number(b.elo)||0},winnerSide});
          }
          originalCreatedAt=plan.createdAt; originalCreatedBy=plan.createdBy; eventId=plan.eventId||eventId;
        }

        const session={id:createShortSessionId(),userId:interaction.user.id,guildId:interaction.guildId,channelId:interaction.channelId,mode,matchId,pairs,draft:{a:null,b:null,winnerSide:null},range:null,editingPairIndex:null,originalCreatedAt,originalCreatedBy,eventId,createdAt:Date.now(),updatedAt:Date.now()};
        manualMatchSessions.set(session.id,session);
        await interaction.reply({...buildManualMatchmakingView(session),flags:MessageFlags.Ephemeral});
      } catch(error){
        console.error(`❌ /${interaction.commandName} error:`,error);
        try{await interaction.reply({content:"❌ Failed to open manual matchmaking.",flags:MessageFlags.Ephemeral});}catch{}
      }
      return;
    }

    // ========================================================
    // /bulk_add_club
    // ========================================================
    if (interaction.commandName === "bulk_add_club") {
      try { await interaction.showModal(createBulkAddModal()); }
      catch(error){ console.error("❌ /bulk_add_club error:",error); }
      return;
    }

    // ========================================================
    // /match_list
    // ========================================================
    if (interaction.commandName === "match_list") {
      try {
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        const plans=[...matchPlans.values()].filter(p=>!p.guildId||!interaction.guildId||String(p.guildId)===String(interaction.guildId)).sort((a,b)=>(Number(String(b.id).replace(/\D/g,''))||0)-(Number(String(a.id).replace(/\D/g,''))||0));
        if(!plans.length){ await interaction.editReply("ℹ️ No saved Match IDs."); return; }
        const lines=plans.map(plan=>{
          const sts=(plan.clubs||[]).map(c=>String(c.status||'pending').toLowerCase());
          const pending=sts.filter(x=>!['success','failed','excluded'].includes(x)).length;
          const failed=sts.filter(x=>x==='failed').length;
          const success=sts.filter(x=>x==='success').length;
          const status=pending===0 && sts.length ? 'COMPLETED' : 'ACTIVE';
          return `${plan.id} — **${status}** — ${plan.pairCount || Math.floor((plan.clubs||[]).length/2)} pairs • ✅${success} ❌${failed} ⏳${pending}`;
        });
        const chunks=splitDiscordText(`🆔 **SAVED MATCH IDS**\n\n${lines.join('\n')}`);
        await interaction.editReply(chunks[0]); for(let i=1;i<chunks.length;i++) await interaction.followUp({content:chunks[i],flags:MessageFlags.Ephemeral});
      } catch(error){ console.error("❌ /match_list error:",error); try{await interaction.editReply("❌ Failed to load Match IDs.");}catch{} }
      return;
    }

    if(interaction.commandName==='ko_timer_start'){
      try{
        const id=normalizeMatchId(interaction.options.getString('match_id',true));const plan=getMatchPlan(id);
        if(!plan){await interaction.reply({content:`❌ Match ID **${id||'Unknown'}** not found.`,flags:MessageFlags.Ephemeral});return;}
        if(hasActiveTimerForMatch(id)){await interaction.reply({content:`⚠️ KO timer for **${id}** is already active.`,flags:MessageFlags.Ephemeral});return;}
        const session=openKoSetup(plan,interaction);await interaction.reply({...buildKoSetupView(session),flags:MessageFlags.Ephemeral});
      }catch(error){console.error('❌ /ko_timer_start error:',error);try{await interaction.reply({content:'❌ Failed to open KO timer confirmation.',flags:MessageFlags.Ephemeral});}catch{}}
      return;
    }

    if(interaction.commandName==='isolation_status'){try{await interaction.reply({content:buildIsolationTimerDashboard(),flags:MessageFlags.Ephemeral});}catch(error){console.error('❌ /isolation_status error:',error);}return;}
    if(interaction.commandName==='isolation_override'){
      try{if(!isWarAdminInteraction(interaction)){await interaction.reply({content:'⛔ You are not authorized to use master isolation override.',flags:MessageFlags.Ephemeral});return;}cleanupOpsSessions(isolationOverrideSessions);const session={id:opsSessionId('iso'),userId:String(interaction.user.id),page:0,selected:new Set(),createdAt:Date.now(),updatedAt:Date.now()};isolationOverrideSessions.set(session.id,session);await interaction.reply({...buildIsolationOverrideView(session),flags:MessageFlags.Ephemeral});}catch(error){console.error('❌ /isolation_override error:',error);try{await interaction.reply({content:'❌ Failed to open master isolation override.',flags:MessageFlags.Ephemeral});}catch{}}return;
    }

    // ========================================================
    // /timer_status - exact current channel/thread only
    // ========================================================
    if (interaction.commandName === "timer_status") {
      try {
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        const timers=getActiveFowTimersForDestination(interaction);
        if(!timers.length){ await interaction.editReply("ℹ️ No active FoW timer in this channel/thread."); return; }
        const lines=timers.map((t,i)=>{
          const remaining=Math.max(0,Number(t.endAt)-Date.now());
          const hrs=Math.floor(remaining/3600000), mins=Math.floor((remaining%3600000)/60000);
          return `${i+1}. **${getFowTimerCancelLabel(t)}**${t.matchId?` • ${t.matchId}`:''}\n   Clubs: ${Array.isArray(t.clubs)?t.clubs.length:0} • Remaining: **${hrs}h ${mins}m** • Ends <t:${Math.floor(Number(t.endAt)/1000)}:R>`;
        });
        await interaction.editReply(`⏱️ **ACTIVE TIMER STATUS**\n\n${lines.join('\n\n')}`);
      } catch(error){ console.error("❌ /timer_status error:",error); try{await interaction.editReply("❌ Failed to load timer status.");}catch{} }
      return;
    }

    // ========================================================
    // Event tracking
    // ========================================================
    if (interaction.commandName === "event_start") {try{await interaction.deferReply();autoExpireActiveEvent();if(getCurrentEventContext()){await interaction.editReply(`❌ Event **${getCurrentEventContext().name}** is already ${String(getCurrentEventContext().status||'active').toUpperCase()}.`);return;}const type=interaction.options.getString('event_type',true),days=eventDurationDays(type),name=type==='grease'?'Grease Lightning':type==='lightning'?'Lightning':'Normal',now=Date.now(),prep=eventPreparationHours(type);eventStore.active={id:`EV${now.toString(36).toUpperCase()}`,type,name,status:'active',startAt:now,endAt:days?now+days*86400000:null,createdBy:interaction.user.id};await saveEventStoreNow();await interaction.editReply(`⚡ **EVENT STARTED**\n\nEvent: **${name}**\nMaster Mode: **ACTIVE**\n${days?`Duration: **${days} days**\n`:'Duration: **Manual end**\n'}Preparation: **${prep?prep+' Hours':'None'}**\nPost-war: **${type==='normal'?'KO + Cooling':'2 Hours KO'}**\n\n✅ New Match IDs lock to this event automatically.`);}catch(error){console.error('❌ /event_start error:',error);try{await interaction.editReply('❌ Failed to start event.');}catch{}}return;}
    if (interaction.commandName === "event_status") {try{await interaction.deferReply();autoExpireActiveEvent();const ev=getCurrentEventContext();if(!ev){await interaction.editReply('ℹ️ No current event context.');return;}const plans=plansForEvent(ev.id),ids=new Set(plans.map(p=>p.id)),ops=Object.values(warOperations||{}).filter(o=>o&&String(o.status||'AVAILABLE').toUpperCase()!=='AVAILABLE'&&o.matchId&&ids.has(normalizeMatchId(o.matchId))),timers=(activeFowTimers||[]).filter(t=>t?.sent?.end!==true&&t.matchId&&ids.has(normalizeMatchId(t.matchId))),st=getEventStats(ev),prep=eventPreparationHours(ev.type),warCount=ops.filter(o=>['WAR_ACTIVE','KO_ACTIVE'].includes(String(o.status||'').toUpperCase())&&o.monitorAfterPrep!==false).length,isolated=new Set([...ops.map(o=>normalizeClubName(o.club)),...timers.flatMap(t=>(t.clubs||[]).map(c=>normalizeClubName(c.club)))]).size;await interaction.editReply(`⚡ **FOW EVENT STATUS**\n\nEvent: **${ev.name}**\nStatus: **${String(ev.status||'active').toUpperCase()}**\nPreparation: **${prep?prep+' Hours':'None'}**\nNew Matchmaking: **${ev.status==='active'?'ENABLED':'STOPPED'}**\n\n🆔 Match IDs: **${plans.length}**\n⏱️ Active Timers: **${timers.length}**\n⚔️ War Monitor: **${warCount} clubs**\n🚫 Total Isolated: **${isolated} clubs**\n\n✅ Successful: **${st.success}**\n❌ Failed: **${st.failed}**\n⏳ Pending: **${st.pending}**\n➖ Excluded: **${st.excluded}**`);}catch(error){console.error('❌ /event_status error:',error);try{await interaction.editReply('❌ Failed to load event status.');}catch{}}return;}
    if (interaction.commandName === "event_stop") {try{await interaction.deferReply();const ev=getCurrentEventContext();if(!ev){await interaction.editReply('ℹ️ No current event to stop.');return;}ev.status='stopped';ev.stoppedAt=Date.now();ev.stoppedBy=interaction.user.id;await saveEventStoreNow();await interaction.editReply(`⏸️ **EVENT STOPPED — ${ev.name.toUpperCase()}**\n\n🚫 No new Match IDs join this event.\n✅ Existing preparation, KO, cooling and War Monitor continue.\nUse **/event_status**, then **/event_end** when clear.`);}catch(error){console.error('❌ /event_stop error:',error);try{await interaction.editReply('❌ Failed to stop event.');}catch{}}return;}
    if (interaction.commandName === "event_stats") {try{await interaction.deferReply();autoExpireActiveEvent();const ev=getCurrentEventContext();if(ev){await interaction.editReply(formatEventStats(ev));return;}const latest=(eventStore.summaries||[]).slice().sort((a,b)=>Number(b.completedAt||0)-Number(a.completedAt||0))[0];if(!latest){await interaction.editReply('ℹ️ No event statistics found.');return;}await interaction.editReply(`⚡ **${latest.name.toUpperCase()} — FINAL SUMMARY**\n\nMatch IDs: **${latest.matchIds||0}**\n✅ Successful: **${latest.success||0}**\n❌ Failed: **${latest.failed||0}**\n⏳ Pending: **${latest.pending||0}**\n➖ Excluded: **${latest.excluded||0}**`);}catch(error){console.error('❌ /event_stats error:',error);try{await interaction.editReply('❌ Failed to load event statistics.');}catch{}}return;}
    if (interaction.commandName === "event_end") {try{await interaction.deferReply();const ev=getCurrentEventContext();if(!ev){await interaction.editReply('ℹ️ No current event to end.');return;}const plans=plansForEvent(ev.id),ids=new Set(plans.map(p=>p.id)),timers=(activeFowTimers||[]).filter(t=>t?.sent?.end!==true&&t.matchId&&ids.has(normalizeMatchId(t.matchId))),ops=Object.values(warOperations||{}).filter(o=>o&&String(o.status||'AVAILABLE').toUpperCase()!=='AVAILABLE'&&o.matchId&&ids.has(normalizeMatchId(o.matchId)));if(timers.length||ops.length){await interaction.editReply(`⚠️ **EVENT STILL HAS ACTIVE OPERATIONS**\n\n⏱️ Active Timers: **${timers.length}**\n⚔️ War / Cooling Operations: **${ops.length}**\n\nUse **/event_stop** and allow them to finish.`);return;}const summary=buildEventSummary(ev);summary.completedAt=Date.now();eventStore.summaries.push(summary);eventStore.active=null;await saveEventStoreNow();await interaction.editReply(`🏁 **EVENT ENDED — ${ev.name.toUpperCase()}**\n\n✅ Successful Clubs: **${summary.success}**\n❌ Failed Clubs: **${summary.failed}**\n⏳ Pending Clubs: **${summary.pending}**\n➖ Excluded Clubs: **${summary.excluded}**`);}catch(error){console.error('❌ /event_end error:',error);try{await interaction.editReply('❌ Failed to end event.');}catch{}}return;}

    // ========================================================
    // /edit_club
    // Add-on only: edits club name OR President / Pusher, ELO unchanged.
    // ========================================================

    if (
      interaction.commandName ===
      "edit_club"
    ) {

      try {

        await interaction.deferReply();

        const editType =
          interaction.options
            .getString(
              "type"
            );

        const currentClub =
          interaction.options
            .getString(
              "club"
            )
            .trim();

        const newValue =
          interaction.options
            .getString(
              "new_value"
            )
            .trim();

        if (!newValue) {
          await interaction.editReply({
            content:
              "❌ New value cannot be empty."
          });
          return;
        }

        // Reload latest server database before editing.
        reloadLatestDatabase();

        const index =
          findClubIndex(
            currentClub
          );

        if (index === -1) {
          await interaction.editReply({
            content:
              `❌ Club **${currentClub}** not found.`
          });
          return;
        }

        const target =
          leaderboardData[index];

        const before = {
          club: target.club,
          president: target.president,
          elo: target.elo
        };

        if (editType === "club") {
          const duplicateIndex =
            leaderboardData.findIndex(
              (item, itemIndex) =>
                itemIndex !== index &&
                normalizeClubName(
                  item.club
                ) ===
                normalizeClubName(
                  newValue
                )
            );

          if (duplicateIndex !== -1) {
            await interaction.editReply({
              content:
                `❌ Club name **${newValue}** already exists.`
            });
            return;
          }

          target.club =
            newValue;

        } else if (editType === "pusher") {
          target.president =
            newValue;

        } else {
          await interaction.editReply({
            content:
              "❌ Invalid edit type."
          });
          return;
        }

        const saved =
          saveDatabase();

        if (!saved) {
          target.club =
            before.club;

          target.president =
            before.president;

          target.elo =
            before.elo;

          await interaction.editReply({
            content:
              "❌ Failed to save changes."
          });
          return;
        }

        // Persist the edited live club database to Supabase immediately.
        // GitHub is deliberately not touched by normal club administration.
        await flushSupabaseStateSave(
          "elo_database"
        );

        if (editType === "club") {
          await interaction.editReply({
            content:
              `✅ **CLUB NAME UPDATED**\n\n` +
              `🏰 ${before.club} → **${target.club}**\n` +
              `👑 President / Pusher: **${target.president || "Not Set"}**\n` +
              `📊 ELO: **${target.elo}**` +
              `\n☁️ **Database synchronized with Supabase.**` +
              `\n⚡ No GitHub redeploy triggered.`
          });
        } else {
          await interaction.editReply({
            content:
              `✅ **PRESIDENT / PUSHER UPDATED**\n\n` +
              `🏰 Club: **${target.club}**\n` +
              `👑 ${before.president || "Not Set"} → **${target.president}**\n` +
              `📊 ELO: **${target.elo}**` +
              `\n☁️ **Database synchronized with Supabase.**` +
              `\n⚡ No GitHub redeploy triggered.`
          });
        }

      } catch (
        error
      ) {

        console.error(
          "❌ /edit_club error:",
          error
        );

        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.editReply({
              content:
                "❌ Failed to edit club."
            });
          }
        } catch {}

      }

      return;
    }

    // ========================================================
    // /derby_add_club and /derby_remove_club
    // Interactive Derby membership management.
    // ========================================================

    if (
      interaction.commandName ===
        "derby_add_club" ||
      interaction.commandName ===
        "derby_remove_club"
    ) {
      try {
        reloadLatestDatabase();

        const mode =
          interaction.commandName ===
            "derby_add_club"
            ? "add"
            : "remove";

        const clubs =
          leaderboardData
            .filter(
              item =>
                mode === "add"
                  ? !isDerbyClub(item)
                  : isDerbyClub(item)
            )
            .map(
              item => ({
                club:
                  item.club,
                president:
                  item.president || "",
                elo:
                  Number(item.elo) || 0
              })
            )
            .sort(
              (a, b) =>
                b.elo - a.elo ||
                a.club.localeCompare(
                  b.club
                )
            );

        if (
          clubs.length === 0
        ) {
          await interaction.reply({
            content:
              mode === "add"
                ? "ℹ️ There are no clubs currently outside the Derby list to add."
                : "ℹ️ There are no Derby clubs available to remove.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const session = {
          id:
            createDerbyManageSessionId(),
          userId:
            interaction.user.id,
          guildId:
            interaction.guildId,
          channelId:
            interaction.channelId,
          mode,
          page:
            0,
          selectedKeys:
            new Set(),
          updatedAt:
            Date.now(),
          clubs
        };

        derbyManageSessions.set(
          session.id,
          session
        );

        await interaction.reply(
          buildDerbyManageView(
            session
          )
        );
      } catch (error) {
        console.error(
          `❌ /${interaction.commandName} error:`,
          error
        );

        try {
          if (
            interaction.replied ||
            interaction.deferred
          ) {
            await interaction.followUp({
              content:
                "❌ Failed to open the Derby management menu.",
              flags:
                MessageFlags.Ephemeral
            });
          } else {
            await interaction.reply({
              content:
                "❌ Failed to open the Derby management menu.",
              flags:
                MessageFlags.Ephemeral
            });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /delete_club
    // Interactive club selection + confirmation.
    // ========================================================

    if (
      interaction.commandName ===
      "delete_club"
    ) {
      try {
        reloadLatestDatabase();

        if (
          leaderboardData.length === 0
        ) {
          await interaction.reply({
            content:
              "❌ The ELO database is empty.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const session = {
          id:
            createDeleteClubSessionId(),
          userId:
            interaction.user.id,
          guildId:
            interaction.guildId,
          channelId:
            interaction.channelId,
          page:
            0,
          selectedKeys:
            new Set(),
          updatedAt:
            Date.now(),
          clubs:
            leaderboardData
              .map(
                item => ({
                  club:
                    item.club,
                  president:
                    item.president || "",
                  elo:
                    Number(item.elo) || 0
                })
              )
              .sort(
                (a, b) =>
                  b.elo - a.elo ||
                  a.club.localeCompare(
                    b.club
                  )
              )
        };

        deleteClubSessions.set(
          session.id,
          session
        );

        await interaction.reply(
          buildDeleteClubView(
            session
          )
        );
      } catch (error) {
        console.error(
          "❌ /delete_club error:",
          error
        );

        try {
          if (
            interaction.replied ||
            interaction.deferred
          ) {
            await interaction.followUp({
              content:
                "❌ Failed to open the club deletion menu.",
              flags:
                MessageFlags.Ephemeral
            });
          } else {
            await interaction.reply({
              content:
                "❌ Failed to open the club deletion menu.",
              flags:
                MessageFlags.Ephemeral
            });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /test_timer
    // User chooses War Start / War End and delay in minutes.
    // Sends only the chosen final notification.
    // ========================================================

    if (
      interaction.commandName ===
      "test_timer"
    ) {
      try {
        const notification =
          interaction.options
            .getString(
              "notification",
              true
            );

        const minutes =
          interaction.options
            .getInteger(
              "minutes",
              true
            );

        if (
          ![
            "start",
            "end"
          ].includes(
            notification
          )
        ) {
          await interaction.reply({
            content:
              "❌ Invalid test notification type.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !Number.isInteger(
            minutes
          ) ||
          minutes < 1 ||
          minutes > 1440
        ) {
          await interaction.reply({
            content:
              "❌ Test timer must be between 1 and 1440 minutes.",
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const startAt =
          Date.now();

        const timer = {
          id:
            createFowTimerId(),
          type:
            "test",
          testNotification:
            notification,
          testMinutes:
            minutes,
          hours:
            0,
          userId:
            interaction.user.id,
          guildId:
            interaction.guildId,
          destinationId:
            interaction.channelId,
          channelId:
            interaction.channelId,
          clubs: [],
          startAt,
          endAt:
            startAt +
            minutes *
            60 *
            1000,
          sent: {
            oneHour:
              true,
            thirtyMinutes:
              true,
            fifteenMinutes:
              true,
            end:
              false
          }
        };

        activeFowTimers.push(
          timer
        );

        saveFowTimers();

        await interaction.reply({
          content:
            `🧪 **FOW TIMER TEST SET**\n\n` +
            `🔔 Notification: **${
              notification === "start"
                ? "War Start"
                : "War End"
            }**\n` +
            `⏱️ Delay: **${minutes} minute${minutes === 1 ? "" : "s"}**\n` +
            `📍 It will be sent in this ${
              interaction.channel &&
              typeof interaction.channel.isThread === "function" &&
              interaction.channel.isThread()
                ? "thread"
                : "channel"
            }.\n` +
            `🕒 Due: <t:${Math.floor(timer.endAt / 1000)}:F> ` +
            `(<t:${Math.floor(timer.endAt / 1000)}:R>)`
        });
      } catch (error) {
        console.error(
          "❌ /test_timer error:",
          error
        );

        try {
          if (
            interaction.replied ||
            interaction.deferred
          ) {
            await interaction.followUp({
              content:
                "❌ Failed to create the timer test.",
              flags:
                MessageFlags.Ephemeral
            });
          } else {
            await interaction.reply({
              content:
                "❌ Failed to create the timer test.",
              flags:
                MessageFlags.Ephemeral
            });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /sync_database
    // Upload/sync elo_database.json FROM PC TO SERVER.
    // This command does NOT push anything to GitHub.
    // Private response: only requester can see it.
    // ========================================================

    if (
      interaction.commandName ===
      "sync_database"
    ) {

      try {

        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        const attachment =
          interaction.options
            .getAttachment(
              "file"
            );

        if (!attachment) {
          await interaction.editReply({
            content:
              "❌ No database file was uploaded."
          });

          return;
        }

        const fileName =
          String(
            attachment.name || ""
          ).toLowerCase();

        if (
          !fileName.endsWith(
            ".json"
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Please upload a `.json` database file."
          });

          return;
        }

        const raw =
          await downloadTextFromUrl(
            attachment.url
          );

        let uploadedData;

        try {

          uploadedData =
            JSON.parse(raw);

        } catch {

          await interaction.editReply({
            content:
              "❌ The uploaded file is not valid JSON."
          });

          return;
        }

        const cleanedData =
          validateUploadedDatabase(
            uploadedData
          );

        // Keep a local rollback copy before replacing the live DB.
        if (
          fs.existsSync(
            DATABASE_FILE
          )
        ) {

          fs.copyFileSync(
            DATABASE_FILE,
            DATABASE_BACKUP_FILE
          );

          console.log(
            "🛡️ elo_database_backup.json updated before PC sync"
          );

        }

        // Replace the LIVE server database with the PC database.
        fs.writeFileSync(
          DATABASE_FILE,
          JSON.stringify(
            cleanedData,
            null,
            2
          ),
          "utf8"
        );

        // Keep in-memory data synchronized immediately.
        leaderboardData =
          cleanedData;

        // Keep the local default snapshot synchronized too.
        // This remains LOCAL ONLY and is not pushed to GitHub.
        writeDefaultSnapshot(
          leaderboardData
        );

        console.log(
          `💻 PC database synchronized: ${leaderboardData.length} clubs`
        );

        await interaction.editReply({
          content:
            `✅ **PC DATABASE SYNC COMPLETE**\n\n` +
            `📥 Source: **${attachment.name}**\n` +
            `🏰 Clubs loaded: **${leaderboardData.length}**\n` +
            `💾 Server **elo_database.json** replaced successfully.\n` +
            `🛡️ Previous server database saved as local backup.\n\n` +
            `☁️ **GitHub was NOT updated.**`
        });

      } catch (
        error
      ) {

        console.error(
          "❌ /sync_database error:",
          error
        );

        try {

          if (
            interaction.deferred ||
            interaction.replied
          ) {

            await interaction.editReply({
              content:
                `❌ **DATABASE SYNC FAILED**\n\n` +
                `${String(
                  error &&
                  error.message
                    ? error.message
                    : error
                ).slice(0, 1000)}`
            });

          }

        } catch {}

      }

      return;
    }

    // ========================================================
    // /sync_github
    // Private response: only the user who requested it sees the result.
    // ========================================================

    if (
      interaction.commandName ===
      "sync_github"
    ) {
      try {
        await interaction.deferReply({
          ephemeral: true
        });

        await syncDatabaseToGitHub(
          "manual /sync_github"
        );

        await interaction.editReply({
          content:
            "✅ **GITHUB API SYNC COMPLETE**\n\n" +
            "💾 `elo_database.json` synchronized\n" +
            "☁️ GitHub repository updated through API."
        });

      } catch (error) {
        console.error(
          "❌ /sync_github error:",
          error
        );

        const details =
          String(
            (error && error.message) ||
            "Unknown GitHub API error"
          )
            .trim()
            .slice(0, 1000);

        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.editReply({
              content:
                "❌ **GITHUB SYNC FAILED**\n\n" +
                "The bot could not update the database through GitHub API.\n" +
                "Check GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH and token Contents permission." +
                (details
                  ? `\n\n\`\`\`\n${details}\n\`\`\``
                  : "")
            });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /push
    // ========================================================

    if (
      interaction.commandName ===
      "push"
    ) {
      try {
        // Acknowledge Discord immediately so Hostinger latency does not
        // trigger "The application did not respond".
        await interaction.deferReply();
        const hours = Number(interaction.options.getString("preparation"));
        const operationalMode = interaction.options.getString("mode") || null;

        const { matchPlan, matchId } =
          resolveMatchPlanForTimer(interaction);

        if (matchId && !matchPlan) {
          await interaction.editReply({
            content: `❌ Match ID **${matchId}** was not found. Run /matchmaking again or check the ID.`
          });
          return;
        }

        if (matchPlan && !matchPlanHasWinLoseRoles(matchPlan)) {
          await interaction.editReply({
            content:
              `❌ Match ID **${matchId}** does not contain complete winner tracking data.
` +
              `Run **/matchmaking** again only if this Match ID cannot be repaired automatically.`
          });
          return;
        }

        if (operationalMode === "grease") {
          await interaction.editReply({content:"❌ Grease Lightning has no preparation timer. Use /war_done for the 2-hour KO timer after war."});
          return;
        }
        if (operationalMode === "lightning" && hours !== 6) {
          await interaction.editReply({content:"❌ Lightning mode uses **6 hours preparation**."}); return;
        }
        if (operationalMode === "normal" && hours !== 12) {
          await interaction.editReply({content:"❌ Normal / outside event mode uses **12 hours preparation**."}); return;
        }
        if (operationalMode === "external" && matchPlan) {
          await interaction.editReply({content:"❌ External mode does not use a Derby Match ID. Use ELO range to select clubs from the full database."}); return;
        }

        const { minElo, maxElo } = resolveTimerEloRange(interaction, matchPlan);

        if (
          ![6, 12].includes(
            hours
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid preparation timer."
        });

          return;
        }

        if (
          !matchPlan && (
            !Number.isInteger(minElo) ||
            !Number.isInteger(maxElo) ||
            minElo > maxElo
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid ELO range. `min_elo` must be lower than or equal to `max_elo`."
        });

          return;
        }

        const session =
          createFowTimerSetupSession(
            interaction,
            "push",
            hours,
            minElo,
            maxElo,
            null,
            null,
            null,
            matchPlan
          );
        applyOperationalModeToTimerSession(session, operationalMode, matchPlan);

        if (
          session.clubs.length === 0
        ) {
          fowTimerSetupSessions.delete(
            session.id
          );
          saveFowTimerSetupSessions();

          await interaction.editReply({
            content:
              matchPlan
                ? `❌ Match ID **${matchId}** has no active winning clubs available for Push.`
                : `❌ No ${operationalMode === "external" ? "clubs" : "Derby clubs"} found within ELO range ${minElo} - ${maxElo}.`
        });

          return;
        }

        await interaction.editReply(
          buildFowTimerSetupView(
            session
          )
        );

      } catch (error) {
        console.error(
          "❌ /push error:",
          error
        );

        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "❌ Failed to open push timer setup." });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /push_test
    // Same interactive club-selection flow and notification behavior as
    // /push, but the preparation duration is entered manually in MINUTES.
    // Useful for testing the full push timer flow without waiting 6/12 hours.
    // ========================================================

    if (
      interaction.commandName ===
      "push_test"
    ) {
      try {
        await interaction.deferReply();

        const minutes = interaction.options.getInteger("minutes");
        const operationalMode = interaction.options.getString("mode") || null;

        const { matchPlan, matchId } =
          resolveMatchPlanForTimer(interaction);

        if (matchId && !matchPlan) {
          await interaction.editReply({
            content: `❌ Match ID **${matchId}** was not found. Run /matchmaking again or check the ID.`
          });
          return;
        }

        if (matchPlan && !matchPlanHasWinLoseRoles(matchPlan)) {
          await interaction.editReply({
            content:
              `❌ Match ID **${matchId}** does not contain complete winner tracking data.
` +
              `Run **/matchmaking** again only if this Match ID cannot be repaired automatically.`
          });
          return;
        }

        const { minElo, maxElo } =
          resolveTimerEloRange(interaction, matchPlan);

        if (
          !Number.isInteger(minutes) ||
          minutes < 1 ||
          minutes > 1440
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid push test timer. Enter between 1 and 1440 minutes."
          });

          return;
        }

        if (
          !matchPlan && (
            !Number.isInteger(minElo) ||
            !Number.isInteger(maxElo) ||
            minElo > maxElo
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid ELO range. `min_elo` must be lower than or equal to `max_elo`."
          });

          return;
        }

        const session =
          createFowTimerSetupSession(
            interaction,
            "push",
            minutes / 60,
            minElo,
            maxElo,
            null,
            minutes,
            "test",
            matchPlan
          );
        applyOperationalModeToTimerSession(session, operationalMode, matchPlan);

        if (
          session.clubs.length === 0
        ) {
          fowTimerSetupSessions.delete(
            session.id
          );
          saveFowTimerSetupSessions();

          await interaction.editReply({
            content:
              matchPlan
                ? `❌ Match ID **${matchId}** has no active winning clubs available for Push.`
                : `❌ No ${operationalMode === "external" ? "clubs" : "Derby clubs"} found within ELO range ${minElo} - ${maxElo}.`
          });

          return;
        }

        await interaction.editReply(
          buildFowTimerSetupView(
            session
          )
        );
      } catch (error) {
        console.error(
          "❌ /push_test error:",
          error
        );

        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.editReply({
              content:
                "❌ Failed to open push test timer setup."
            });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /push_manual
    // Production push timer with the exact same club-selection, reminder,
    // persistence, cancellation and WAR START flow as /push. The only
    // difference is that preparation time is entered manually in MINUTES.
    // ========================================================

    if (
      interaction.commandName ===
      "push_manual"
    ) {
      try {
        await interaction.deferReply();

        const manualDuration=parseManualDurationHrMin(interaction.options.getString("duration",true));
        const minutes=manualDuration?.totalMinutes||0;
        const operationalMode = interaction.options.getString("mode") || null;

        const { matchPlan, matchId } =
          resolveMatchPlanForTimer(interaction);

        if (matchId && !matchPlan) {
          await interaction.editReply({
            content: `❌ Match ID **${matchId}** was not found. Run /matchmaking again or check the ID.`
          });
          return;
        }

        if (matchPlan && !matchPlanHasWinLoseRoles(matchPlan)) {
          await interaction.editReply({
            content:
              `❌ Match ID **${matchId}** does not contain complete winner tracking data.
` +
              `Run **/matchmaking** again only if this Match ID cannot be repaired automatically.`
          });
          return;
        }

        if (operationalMode === "grease") { await interaction.editReply({content:"❌ Grease Lightning has no preparation timer."}); return; }
        if (operationalMode === "external" && matchPlan) { await interaction.editReply({content:"❌ External mode does not use a Derby Match ID."}); return; }

        const { minElo, maxElo } =
          resolveTimerEloRange(interaction, matchPlan);

        if (!manualDuration || minutes > 720) {await interaction.editReply({content:"❌ Invalid manual preparation time. Use **XXh XXmin**, max **12h 00min**."});return;}

        if (
          !matchPlan && (
            !Number.isInteger(minElo) ||
            !Number.isInteger(maxElo) ||
            minElo > maxElo
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid ELO range. `min_elo` must be lower than or equal to `max_elo`."
          });

          return;
        }

        const session =
          createFowTimerSetupSession(
            interaction,
            "push",
            minutes / 60,
            minElo,
            maxElo,
            null,
            minutes,
            "manual",
            matchPlan
          );
        applyOperationalModeToTimerSession(session, operationalMode, matchPlan);

        if (
          session.clubs.length === 0
        ) {
          await deleteFowTimerSetupSessionPersistent(session.id);

          await interaction.editReply({
            content:
              matchPlan
                ? `❌ Match ID **${matchId}** has no active winning clubs available for Push.`
                : `❌ No ${operationalMode === "external" ? "clubs" : "Derby clubs"} found within ELO range ${minElo} - ${maxElo}.`
          });

          return;
        }

        await interaction.editReply(
          buildFowTimerSetupView(
            session
          )
        );
      } catch (error) {
        console.error(
          "❌ /push_manual error:",
          error
        );

        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.editReply({
              content:
                "❌ Failed to open manual push timer setup."
            });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /war_done
    // ========================================================

    if (
      interaction.commandName ===
      "war_done"
    ) {
      try {
        // Acknowledge Discord immediately so Hostinger latency does not
        // trigger "The application did not respond".
        await interaction.deferReply();
        const hours = Number(interaction.options.getString("timer"));
        const operationalMode = interaction.options.getString("mode") || null;

        const { matchPlan, matchId } =
          resolveMatchPlanForTimer(interaction);

        if (matchId && !matchPlan) {
          await interaction.editReply({
            content: `❌ Match ID **${matchId}** was not found. Run /matchmaking again or check the ID.`
          });
          return;
        }

        if (["grease","lightning"].includes(operationalMode) && hours !== 2) {
          await interaction.editReply({content:`❌ ${getOperationalModeLabel(operationalMode)} uses **2 hours KO**.`}); return;
        }
        if (operationalMode === "normal" && hours !== 14) {
          await interaction.editReply({content:"❌ Normal / outside event mode uses **2 hours KO + 12 hours Cooling Down = 14 hours**."}); return;
        }
        if (operationalMode === "external" && matchPlan) { await interaction.editReply({content:"❌ External mode does not use a Derby Match ID."}); return; }

        const { minElo, maxElo } = resolveTimerEloRange(interaction, matchPlan);

        if (
          ![2, 14].includes(
            hours
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid war done timer."
        });

          return;
        }

        if (
          !matchPlan && (
            !Number.isInteger(minElo) ||
            !Number.isInteger(maxElo) ||
            minElo > maxElo
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid ELO range. `min_elo` must be lower than or equal to `max_elo`."
        });

          return;
        }

        const session =
          createFowTimerSetupSession(
            interaction,
            "war_done",
            hours,
            minElo,
            maxElo,
            null,
            null,
            null,
            matchPlan
          );
        applyOperationalModeToTimerSession(session, operationalMode, matchPlan);

        if (
          session.clubs.length === 0
        ) {
          fowTimerSetupSessions.delete(
            session.id
          );
          saveFowTimerSetupSessions();

          await interaction.editReply({
            content:
              matchPlan
                ? `❌ Match ID **${matchId}** has no matched clubs.`
                : `❌ No ${operationalMode === "external" ? "clubs" : "Derby clubs"} found within ELO range ${minElo} - ${maxElo}.`
        });

          return;
        }

        await interaction.editReply(
          buildFowTimerSetupView(
            session
          )
        );

      } catch (error) {
        console.error(
          "❌ /war_done error:",
          error
        );

        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "❌ Failed to open war done timer setup." });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /war_done_manual
    // Same flow/content as /war_done, but duration is entered
    // manually in MINUTES. Original /war_done remains unchanged.
    // ========================================================

    if (
      interaction.commandName ===
      "war_done_manual"
    ) {
      try {
        // Acknowledge Discord immediately so Hostinger latency does not
        // trigger "The application did not respond".
        await interaction.deferReply();
        const warDoneMode =
          interaction.options
            .getString(
              "timer"
            );

        const manualDuration=parseManualDurationHrMin(interaction.options.getString("duration",true));
        const minutes=manualDuration?.totalMinutes||0;

        const { matchPlan, matchId } =
          resolveMatchPlanForTimer(interaction);

        if (matchId && !matchPlan) {
          await interaction.editReply({
            content: `❌ Match ID **${matchId}** was not found. Run /matchmaking again or check the ID.`
          });
          return;
        }

        const { minElo, maxElo } =
          resolveTimerEloRange(interaction, matchPlan);

        if (
          ![
            "ko",
            "ko_cooling"
          ].includes(
            warDoneMode
          ) ||
          !manualDuration ||
          minutes > 10080
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid manual war done timer. Use **XXh XXmin**, e.g. `02h 30min`."
        });

          return;
        }

        if (
          !matchPlan && (
            !Number.isInteger(minElo) ||
            !Number.isInteger(maxElo) ||
            minElo > maxElo
          )
        ) {
          await interaction.editReply({
            content:
              "❌ Invalid ELO range. `min_elo` must be lower than or equal to `max_elo`."
        });

          return;
        }

        const session =
          createFowTimerSetupSession(
            interaction,
            "war_done_manual",
            minutes / 60,
            minElo,
            maxElo,
            warDoneMode,
            minutes,
            null,
            matchPlan
          );

        if (
          session.clubs.length === 0
        ) {
          fowTimerSetupSessions.delete(
            session.id
          );
          saveFowTimerSetupSessions();

          await interaction.editReply({
            content:
              matchPlan
                ? `❌ Match ID **${matchId}** has no matched clubs.`
                : `❌ No Derby clubs found within ELO range ${minElo} - ${maxElo}.`
        });

          return;
        }

        await interaction.editReply(
          buildFowTimerSetupView(
            session
          )
        );
      } catch (error) {
        console.error(
          "❌ /war_done_manual error:",
          error
        );

        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "❌ Failed to open manual war done timer setup." });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /cancel_matchmaking
    // Interactive selection of one saved Match ID to remove.
    // ========================================================

    if (interaction.commandName === "cancel_matchmaking") {
      try {
        await interaction.deferReply();
        cleanupMatchCancelSessions();

        const plans = [...matchPlans.values()]
          .filter(plan => !plan?.guildId || !interaction.guildId || String(plan.guildId) === String(interaction.guildId))
          .sort((a, b) => {
            const aNum = Number(String(a?.id || '').replace(/^(?:HS|M)/, '')) || 0;
            const bNum = Number(String(b?.id || '').replace(/^(?:HS|M)/, '')) || 0;
            return bNum - aNum;
          });

        if (plans.length === 0) {
          await interaction.editReply({ content: "ℹ️ No saved Match IDs are available to cancel.", components: [] });
          return;
        }

        const session = {
          id: createMatchCancelSessionId(),
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          plans,
          selectedId: null,
          page: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        matchCancelSessions.set(session.id, session);
        await interaction.editReply(buildMatchCancelView(session));
        console.log(`🗑️ /cancel_matchmaking opened: ${plans.length} saved Match IDs.`);
      } catch (error) {
        console.error("❌ /cancel_matchmaking error:", error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "❌ Failed to open Match ID cancellation menu.", components: [] });
          }
        } catch {}
      }
      return;
    }

    // ========================================================
    // /match_success
    // Explicitly marks complete FoW-vs-FoW pairs as SUCCESS for event stats.
    // It never changes ELO and never starts/cancels timers.
    // ========================================================
    if (interaction.commandName === "match_success") {
      try {
        await interaction.deferReply();
        cleanupMatchSuccessSessions();
        const matchId=normalizeMatchId(interaction.options.getString("match_id"));
        const plan=getMatchPlan(matchId);
        if(!plan||!Array.isArray(plan.clubs)){
          await interaction.editReply({content:`❌ Match ID **${matchId||"Unknown"}** was not found.`,components:[]});
          return;
        }
        if(plan.guildId && interaction.guildId && String(plan.guildId)!==String(interaction.guildId)){
          await interaction.editReply({content:`❌ Match ID **${matchId}** does not belong to this server.`,components:[]});
          return;
        }
        const pairs=getSuccessEligiblePairs(plan);
        if(!pairs.length){
          await interaction.editReply({
            content:`ℹ️ Match ID **${matchId}** has no PENDING pair eligible for SUCCESS.\nA pair with FAILED/EXCLUDED club cannot be marked successful as the original pair.`,
            components:[]
          });
          return;
        }
        const session={
          id:createMatchSuccessSessionId(),userId:interaction.user.id,guildId:interaction.guildId,
          channelId:interaction.channelId,matchId,pairs,selected:new Set(),page:0,
          createdAt:Date.now(),updatedAt:Date.now()
        };
        matchSuccessSessions.set(session.id,session);
        await interaction.editReply(buildMatchSuccessView(session));
      } catch(error){
        console.error("❌ /match_success error:",error);
        try{ await interaction.editReply({content:"❌ Failed to open match-success menu.",components:[]}); }catch{}
      }
      return;
    }

    // ========================================================
    // /match_fail and /match_restore
    // Multi-select status control for clubs saved under a Match ID.
    // ========================================================

    if (
      interaction.commandName === "match_fail" ||
      interaction.commandName === "match_restore"
    ) {
      try {
        await interaction.deferReply();
        cleanupMatchStatusSessions();

        const matchId = normalizeMatchId(interaction.options.getString("match_id"));
        const plan = getMatchPlan(matchId);
        if (!plan || !Array.isArray(plan.clubs)) {
          await interaction.editReply({
            content: `❌ Match ID **${matchId || "Unknown"}** was not found. Run /matchmaking again or check the ID.`,
            components: []
          });
          return;
        }

        if (plan.guildId && interaction.guildId && String(plan.guildId) !== String(interaction.guildId)) {
          await interaction.editReply({ content: `❌ Match ID **${matchId}** does not belong to this server.`, components: [] });
          return;
        }

        const mode = interaction.commandName === "match_fail" ? "fail" : "restore";
        const clubs = (mode === "fail" ? getMatchPlanActiveClubs(plan) : getMatchPlanFailedClubs(plan))
          .map(item => ({
            club: item.club,
            president: item.president || "",
            elo: Number(item.elo) || 0,
            status: String(item.status || "matched").toLowerCase() === "failed" ? "failed" : "matched"
          }))
          .sort((a, b) => Number(b.elo) - Number(a.elo) || a.club.localeCompare(b.club));

        if (clubs.length === 0) {
          await interaction.editReply({
            content: mode === "fail"
              ? `ℹ️ Match ID **${matchId}** has no active clubs available to mark as failed.`
              : `ℹ️ Match ID **${matchId}** has no failed clubs to restore.`,
            components: []
          });
          return;
        }

        const session = {
          id: createMatchStatusSessionId(),
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          matchId,
          mode,
          plan,
          clubs,
          selected: new Set(),
          page: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        matchStatusSessions.set(session.id, session);
        await interaction.editReply(buildMatchStatusView(session));
        console.log(`🎛️ /${interaction.commandName} opened for ${matchId}: ${clubs.length} clubs`);
      } catch (error) {
        console.error(`❌ /${interaction.commandName} error:`, error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: "❌ Failed to open Match ID status menu.", components: [] });
          }
        } catch {}
      }
      return;
    }

    // ========================================================
    // /cancel_timer
    // ========================================================

    if (
      interaction.commandName ===
      "cancel_timer"
    ) {
      try {
        await showCancelTimerMenu(
          interaction
        );
      } catch (error) {
        console.error(
          "❌ /cancel_timer error:",
          error
        );

        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content: "❌ Failed to open active timer list.",
              components: []
            });
          } else {
            await interaction.reply({
              content: "❌ Failed to open active timer list.",
              flags: MessageFlags.Ephemeral
            });
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // /matchmaking
    // Interactive multi-select:
    //   🏆 Must Win
    //   💀 Must Lose
    //   ⏭️ Skip
    // ========================================================

    if (
      interaction.commandName ===
      "matchmaking"
    ) {

      try {

        await interaction.deferReply();

        const min =
          interaction.options
            .getInteger(
              "min_elo"
            );

        const max =
          interaction.options
            .getInteger(
              "max_elo"
            );

        if (min > max) {
          await interaction.editReply({
            content:
              "❌ Minimum ELO cannot be higher than Maximum ELO."
          });

          return;
        }

        // Matchmaking only uses clubs that belong to the Derby list.
        const rangeData =
          getDerbyFilteredLeaderboard(
            min,
            max
          );

        if (
          rangeData.length === 0
        ) {
          await interaction.editReply({
            content:
              `❌ No clubs found between **${min} - ${max} ELO**.`
          });

          return;
        }

        const sessionId =
          createMatchmakingSessionId();

        const session = {
          id:
            sessionId,

          userId:
            interaction.user.id,

          min,
          max,

          rangeData:
            [...rangeData]
              .sort(
                (a, b) =>
                  Number(b.elo) -
                  Number(a.elo)
              ),

          category:
            "must_win",

          page:
            0,

          mustWin:
            new Set(),

          mustLose:
            new Set(),

          skip:
            new Set(),

          createdAt:
            Date.now(),

          updatedAt:
            Date.now()
        };

        matchmakingSessions.set(
          sessionId,
          session
        );

        await persistMatchmakingSessionsNow();

        await interaction.editReply(
          buildMatchmakingSelectionView(
            session
          )
        );

        console.log(
          `🎛️ /matchmaking selection opened: ` +
          `${rangeData.length} Derby clubs, ` +
          `ELO ${min}-${max}`
        );

      } catch (
        error
      ) {

        console.error(
          "❌ /matchmaking error:",
          error
        );

        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content: "❌ Failed to open matchmaking selection.",
              components: []
            });
          } else {
            await interaction.reply({
              content: "❌ Failed to open matchmaking selection.",
              flags: MessageFlags.Ephemeral
            });
          }
        } catch {}

      }

      return;
    }

    // ========================================================
    // /derby_leaderboard
    // Show ALL Derby clubs only, highest ELO to lowest.
    // ========================================================

    if (
      interaction.commandName ===
      "derby_leaderboard"
    ) {

      try {

        await interaction.deferReply();

        const data =
          getDerbyLeaderboard();

        const derbyText =
          data.map(
            (item, index) =>
              `${index + 1}. ${item.club} (${item.elo}) - ${item.president}`
          ).join(
            "\n"
          );

        const derbyLeaderboardOutput =
          `🏇 **FoW Derby ELO Leaderboard**\n\n` +
          derbyText +
          `\n\nShowing all **${data.length} Derby clubs**.`;

        const derbyLeaderboardChunks =
          splitDiscordText(
            derbyLeaderboardOutput,
            1900
          );

        await interaction.editReply({
          content:
            derbyLeaderboardChunks[0]
        });

        for (
          let i = 1;
          i < derbyLeaderboardChunks.length;
          i++
        ) {
          await interaction.followUp({
            content:
              derbyLeaderboardChunks[i]
          });
        }

      } catch (
        error
      ) {

        console.error(
          "❌ /derby_leaderboard error:",
          error
        );

        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.editReply({
              content:
                "❌ Failed to load Derby leaderboard."
            });
          }
        } catch {}

      }

      return;
    }

    // ========================================================
    // /derby
    // Full ELO download excluding non-Derby clubs.
    // ========================================================

    if (
      interaction.commandName ===
      "derby"
    ) {

      try {

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const data =
          getDerbyLeaderboard();

        const html =
          generateHTML(
            data,
            "FoW Empire",
            "Derby ELO List"
          );

        const filePath =
          path.join(
            __dirname,
            `FoW_Derby_${Date.now()}.html`
          );

        fs.writeFileSync(
          filePath,
          html,
          "utf8"
        );

        const attachment =
          new AttachmentBuilder(
            filePath,
            {
              name:
                "FoW_Derby_ELO_Leaderboard.html"
            }
          );

        await interaction.editReply({
          content:
            `🏇 **FoW Derby ELO List**\n` +
            `🏰 Clubs: **${data.length}**\n` +
            `📈 Sorted: **Highest → Lowest**\n\n` +
            `📥 Download HTML below:`,
          files: [
            attachment
          ]
        });

        setTimeout(
          () => {

            try {

              if (
                fs.existsSync(
                  filePath
                )
              ) {

                fs.unlinkSync(
                  filePath
                );

              }

            } catch {}

          },
          10000
        );

        console.log(
          `✅ /derby completed: ${data.length} clubs`
        );

      } catch (
        error
      ) {

        console.error(
          "❌ /derby error:",
          error
        );

        try {

          if (
            interaction.deferred ||
            interaction.replied
          ) {

            await interaction.editReply({
              content:
                "❌ Failed to generate Derby ELO list."
            });

          }

        } catch {}

      }

      return;
    }

    // ========================================================
    // /leaderboard
    // ========================================================

    if (
      interaction.commandName ===
      "leaderboard"
    ) {

      try {

        await interaction.deferReply();

        reloadLatestDatabase();

        const data =
          getSortedLeaderboard();

        if (
          !Array.isArray(data) ||
          data.length === 0
        ) {

          await interaction.editReply(
            "❌ The ELO database is empty."
          );

          return;
        }

        const lines =
          data.map(
            (item, index) =>
              `${index + 1}. **${item.club}** (${Number(item.elo) || 0})` +
              `${item.president ? ` - ${item.president}` : ""}`
          );

        const header =
          `🏆 **FoW Empire ELO Leaderboard**\n` +
          `🏰 Clubs: **${data.length}**\n\n`;

        const chunks = [];
        let current = header;

        for (const line of lines) {

          if (
            (current + line + "\n").length >
            1900
          ) {

            chunks.push(current);
            current = "";

          }

          current += line + "\n";
        }

        if (current.trim()) {
          chunks.push(current);
        }

        await interaction.editReply({
          content: chunks[0]
        });

        for (
          let i = 1;
          i < chunks.length;
          i++
        ) {

          await interaction.followUp({
            content: chunks[i]
          });

        }

      } catch (error) {

        console.error(
          "❌ /leaderboard error:",
          error
        );

        try {

          if (
            interaction.deferred ||
            interaction.replied
          ) {

            await interaction.editReply(
              "❌ Failed to load leaderboard."
            );

          } else {

            await interaction.reply({
              content:
                "❌ Failed to load leaderboard.",
              flags:
                MessageFlags.Ephemeral
            });

          }

        } catch {}

      }

      return;
    }


    // ========================================================
    // /download
    // ========================================================

    if (
      interaction.commandName ===
      "download"
    ) {

      try {

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const data =
          getSortedLeaderboard();

        const html =
          generateHTML(
            data,
            "FoW Empire",
            "Global ELO Leaderboard"
          );

        const filePath =
          path.join(
            __dirname,
            `FoW_Full_${Date.now()}.html`
          );

        fs.writeFileSync(
          filePath,
          html,
          "utf8"
        );

        const attachment =
          new AttachmentBuilder(
            filePath,
            {
              name:
                "FoW_ELO_Leaderboard.html"
            }
          );

        await interaction.editReply({
          content:
            `📊 **FoW Empire ELO Leaderboard**\n` +
            `🏰 Clubs: **${data.length}**\n` +
            `📥 Download HTML below:`,
          files: [
            attachment
          ]
        });

        setTimeout(
          () => {

            try {

              if (
                fs.existsSync(
                  filePath
                )
              ) {

                fs.unlinkSync(
                  filePath
                );

              }

            } catch {}

          },
          10000
        );

      } catch (
        error
      ) {

        console.error(
          "❌ /download error:",
          error
        );

        try {

          if (
            interaction.deferred ||
            interaction.replied
          ) {

            await interaction.editReply({
              content:
                "❌ Failed to generate HTML."
            });

          }

        } catch {}

      }

      return;
    }

    // ========================================================
    // /download_elo
    // ========================================================

    if (
      interaction.commandName ===
      "download_elo"
    ) {

      try {

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const min =
          interaction.options
            .getInteger(
              "min"
            );

        const max =
          interaction.options
            .getInteger(
              "max"
            );

        if (
          min > max
        ) {

          await interaction.editReply({
            content:
              "❌ Minimum ELO cannot be higher than Maximum ELO."
          });

          return;
        }

        const data =
          getFilteredLeaderboard(
            min,
            max
          );

        if (
          data.length === 0
        ) {

          await interaction.editReply({
            content:
              `❌ No clubs found between **${min} - ${max} ELO**.`
          });

          return;
        }

        const html =
          generateHTML(
            data,
            "FoW Empire",
            `ELO ${min} - ${max}`
          );

        const filePath =
          path.join(
            __dirname,
            `FoW_ELO_${min}-${max}_${Date.now()}.html`
          );

        fs.writeFileSync(
          filePath,
          html,
          "utf8"
        );

        const attachment =
          new AttachmentBuilder(
            filePath,
            {
              name:
                `FoW_ELO_${min}-${max}.html`
            }
          );

        await interaction.editReply({
          content:
            `📊 **FoW ELO Range Download**\n` +
            `🎯 ELO: **${min} - ${max}**\n` +
            `🏰 Clubs Found: **${data.length}**\n` +
            `📈 Sorted: **Highest → Lowest**\n\n` +
            `📥 Download HTML below:`,
          files: [
            attachment
          ]
        });

        setTimeout(
          () => {

            try {

              if (
                fs.existsSync(
                  filePath
                )
              ) {

                fs.unlinkSync(
                  filePath
                );

              }

            } catch {}

          },
          10000
        );

      } catch (
        error
      ) {

        console.error(
          "❌ /download_elo error:",
          error
        );

        try {

          if (
            interaction.deferred ||
            interaction.replied
          ) {

            await interaction.editReply({
              content:
                "❌ Failed to generate ELO range HTML."
            });

          }

        } catch {}

      }

      return;
    }

  }
);

// ============================================================
// DISCORD GATEWAY CONNECTION EVENTS
// ============================================================
// These listeners are diagnostic only; normal short disconnects are left to
// discord.js. The watchdog handles only prolonged non-ready states.
client.on("shardDisconnect", (event, shardId) => {
  markDiscordDisconnected();
  console.warn(
    `⚠️ Discord shard ${shardId} disconnected` +
    `${event?.code ? ` • code ${event.code}` : ""}.`
  );
});

client.on("shardDisconnect", (event, shardId) => {
  markDiscordDisconnected();
  console.warn(
    `⚠️ Discord shard ${shardId} disconnected` +
    ` • code: ${event?.code ?? "unknown"}` +
    ` • process uptime: ${Math.round(process.uptime())}s`
  );
});

client.on("invalidated", () => {
  markDiscordDisconnected();
  console.error(
    `❌ Discord session invalidated • process uptime: ${Math.round(process.uptime())}s`
  );
});

client.on("shardReconnecting", shardId => {
  markDiscordDisconnected();
  console.log(`🔄 Discord shard ${shardId} reconnecting...`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  markDiscordHealthy();
  console.log(
    `✅ Discord shard ${shardId} resumed` +
    ` • replayed events: ${Number(replayedEvents) || 0}`
  );
});

client.on("shardReady", shardId => {
  markDiscordHealthy();
  console.log(`✅ Discord shard ${shardId} ready.`);
});

client.on("shardError", (error, shardId) => {
  markDiscordDisconnected();
  console.error(
    `❌ Discord shard ${shardId} error:`,
    error
  );
});

// ============================================================
// DISCORD ERRORS
// ============================================================

client.on(
  "error",
  error => {

    console.error(
      "❌ Discord client error:",
      error
    );

  }
);

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "❌ Unhandled rejection:",
      error
    );

  }
);

// Observe fatal synchronous errors for Runtime Logs without changing Node.js
// default crash behaviour. This is safer than swallowing uncaught exceptions,
// which could leave timers/database logic running in an unknown state.
process.on(
  "uncaughtExceptionMonitor",
  error => {
    console.error(
      "❌ Uncaught exception detected:",
      error
    );
  }
);

// ============================================================
// LOGIN
// ============================================================

let applicationStartInProgress = false;
let applicationStarted = false;
let discordLeadershipRetryInterval = null;
const DISCORD_LEADERSHIP_RETRY_MS = 15 * 1000;
const PROCESS_STARTED_AT = Date.now();
console.log(`🟢 Node process started • PID ${process.pid} • ${new Date(PROCESS_STARTED_AT).toISOString()}`);

function scheduleDiscordLeadershipRetry() {
  if (discordLeadershipRetryInterval) return;

  console.log(
    "🟡 Discord standby mode: another Hostinger process currently owns Discord. " +
    "Website remains online; takeover will be retried automatically every 15 seconds."
  );

  discordLeadershipRetryInterval = setInterval(() => {
    startDiscordLeader().catch(error => {
      console.error("❌ Discord standby takeover attempt failed:", error);
    });
  }, DISCORD_LEADERSHIP_RETRY_MS);

  if (typeof discordLeadershipRetryInterval.unref === "function") {
    discordLeadershipRetryInterval.unref();
  }
}

function clearDiscordLeadershipRetry() {
  if (!discordLeadershipRetryInterval) return;
  clearInterval(discordLeadershipRetryInterval);
  discordLeadershipRetryInterval = null;
}

async function startDiscordLeader() {
  if (applicationStarted || applicationStartInProgress || client.isReady()) return;
  applicationStartInProgress = true;

  try {
    if (!DISCORD_BOT_ENABLED) {
      clearDiscordLeadershipRetry();
      console.log("🌐 WEB_ONLY mode • DISCORD_BOT_ENABLED=false • Discord login and leader-lock acquisition disabled on this host.");
      return;
    }

    if (!TOKEN) {
      console.error("❌ DISCORD_TOKEN is missing.");
      console.log("🌐 Express website still running.");
      return;
    }

    const hasLeadership = await acquireDiscordInstanceLock();
    if (!hasLeadership) {
      scheduleDiscordLeadershipRetry();
      return;
    }

    clearDiscordLeadershipRetry();
    applicationStarted = true;

    try {
      await client.login(TOKEN);
      console.log(`👑 Discord leadership active • PID ${process.pid}`);
    } catch (error) {
      applicationStarted = false;
      console.error("❌ Discord login failed:", error);
      await releaseDiscordInstanceLock();
      scheduleDiscordLeadershipRetry();
    }
  } finally {
    applicationStartInProgress = false;
  }
}

async function startApplication() {
  // Restore all persistent state first. This does not change the startAt/endAt
  // of any running FoW timer. Only the Discord leader will process/send timers.
  await restoreRuntimeStateFromSupabaseBeforeDiscordStart();
  await startDiscordLeader();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    clearDiscordLeadershipRetry();
    try { client.destroy(); } catch {}
    await releaseDiscordInstanceLock();
    process.exit(0);
  });
}

startApplication().catch(error => {
  console.error("❌ Application startup failed:", error);
});

// Lightweight watchdog. It does not interfere with normal discord.js gateway
// reconnects and it never redeploys the Hostinger application. It only attempts
// a controlled Discord re-login after a prolonged offline state.
const discordRecoveryWatchdog = setInterval(() => {
  // Standby Hostinger processes must never attempt a Discord login/recovery.
  // Only the process holding the PostgreSQL advisory lock may own Discord.
  if (!discordInstanceLockClient) return;

  if (client.isReady()) {
    markDiscordHealthy();
    return;
  }

  markDiscordDisconnected();

  attemptDiscordSoftRecovery().catch(error => {
    console.error(
      "❌ Discord watchdog unexpected error:",
      error
    );
  });
}, DISCORD_RECOVERY_CHECK_INTERVAL_MS);

if (
  discordRecoveryWatchdog &&
  typeof discordRecoveryWatchdog.unref === "function"
) {
  discordRecoveryWatchdog.unref();
}

// Diagnostic heartbeat: proves whether the Node process itself stayed alive.
// If this restarts from a low uptime/PID every ~60 minutes, the hosting runtime
// is recycling the application rather than Discord merely disconnecting.
const processHeartbeat = setInterval(() => {
  console.log(
    `💓 Runtime heartbeat • PID ${process.pid}` +
    ` • uptime ${Math.round(process.uptime())}s` +
    ` • Discord ${client.isReady() ? "READY" : "OFFLINE"}` +
    ` • role ${discordInstanceLockClient ? "LEADER" : "STANDBY"}`
  );
}, 15 * 60 * 1000);
if (processHeartbeat && typeof processHeartbeat.unref === "function") {
  processHeartbeat.unref();
}
