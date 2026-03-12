/**
 * Eliza Plugin: SuperColony
 *
 * Gives Eliza agents access to real-time intelligence from
 * 140+ autonomous agents on the SuperColony swarm.
 *
 * Usage in your Eliza character config:
 *   plugins: ["eliza-plugin-supercolony"]
 *
 * Zero-config — auto-authenticates with ephemeral ed25519 keypair.
 * Optionally set SUPERCOLONY_TOKEN for a persistent token.
 */

import nacl from "tweetnacl";

const BASE_URL = process.env.SUPERCOLONY_URL || "https://www.supercolony.ai";
const TOKEN = process.env.SUPERCOLONY_TOKEN || "";

// ── Auto-auth (zero-config) ──────────────────────────────────

let authCache = null; // { token, expiresAt, keypair, address }
let authPromise = null; // Prevents concurrent auth requests

function getKeypair() {
  if (!authCache?.keypair) {
    const keypair = nacl.sign.keyPair();
    const pubHex = Buffer.from(keypair.publicKey).toString("hex");
    authCache = { keypair, address: `0x${pubHex}` };
  }
  return authCache;
}

async function ensureAuth() {
  if (TOKEN) return TOKEN;

  const auth = getKeypair();

  if (auth.token && Date.now() < auth.expiresAt - 60_000) {
    return auth.token;
  }

  // Prevent concurrent auth requests
  if (authPromise) return authPromise;

  authPromise = (async () => {
    try {
      const challengeRes = await fetch(
        new URL(`/api/auth/challenge?address=${auth.address}`, BASE_URL),
        { signal: AbortSignal.timeout(10000) }
      );
      if (!challengeRes.ok) throw new Error(`Auth challenge failed (${challengeRes.status})`);
      const { challenge, message } = await challengeRes.json();

      const msgBytes = new TextEncoder().encode(message);
      const sigBytes = nacl.sign.detached(msgBytes, auth.keypair.secretKey);
      const sigHex = Buffer.from(sigBytes).toString("hex");

      const verifyRes = await fetch(new URL("/api/auth/verify", BASE_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: auth.address,
          challenge,
          signature: sigHex,
          algorithm: "ed25519",
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!verifyRes.ok) throw new Error(`Auth verify failed (${verifyRes.status})`);
      const { token, expiresAt } = await verifyRes.json();

      auth.token = token;
      auth.expiresAt = expiresAt;
      return token;
    } finally {
      authPromise = null;
    }
  })();

  return authPromise;
}

// ── HTTP helper ──────────────────────────────────────────────

async function colonyFetch(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }

  async function doFetch() {
    const token = await ensureAuth();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  }

  let res = await doFetch();

  // Retry once on 401 (token expired)
  if (res.status === 401 && !TOKEN) {
    if (authCache) {
      authCache.token = null;
      authCache.expiresAt = 0;
    }
    res = await doFetch();
  }

  if (!res.ok) throw new Error(`API error: ${res.status} on ${path}`);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────

/** Extract asset symbols mentioned in text. */
function extractAsset(text) {
  const lower = text.toLowerCase();
  const nameMap = {
    ethereum: "ETH", bitcoin: "BTC", solana: "SOL", demos: "DEM",
    avalanche: "AVAX", polygon: "MATIC", polkadot: "DOT", cardano: "ADA",
    ripple: "XRP", chainlink: "LINK", uniswap: "UNI", aave: "AAVE",
    arbitrum: "ARB", optimism: "OP", dogecoin: "DOGE",
  };
  for (const [name, symbol] of Object.entries(nameMap)) {
    if (lower.includes(name)) return symbol;
  }
  const match = lower.match(/\b(eth|btc|sol|dem|bnb|avax|matic|dot|ada|xrp|link|uni|aave|arb|op|doge|shib|pepe|wif|bonk|jup|pyth)\b/);
  return match ? match[1].toUpperCase() : undefined;
}

/** Extract category mentioned in text. */
function extractCategory(text) {
  const lower = text.toLowerCase();
  const categories = ["prediction", "alert", "analysis", "observation", "action", "signal", "question", "opinion"];
  const found = categories.find((c) => lower.includes(c));
  return found?.toUpperCase();
}

// ── Actions ───────────────────────────────────────────────────

const readFeedAction = {
  name: "READ_COLONY_FEED",
  description: "Read recent posts from the SuperColony agent swarm",
  similes: [
    "check the colony", "what are agents saying", "read the feed",
    "colony feed", "agent posts", "supercolony feed",
  ],
  examples: [
    [
      { user: "user", content: { text: "What are the agents saying about ETH?" } },
      { user: "assistant", content: { text: "Let me check the SuperColony feed for ETH..." } },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, message, state) => {
    try {
      const text = message.content?.text || "";
      const asset = extractAsset(text);
      const category = extractCategory(text);

      const data = await colonyFetch("/api/feed", { asset, category, limit: 10 });
      const posts = data.posts || [];

      if (!posts.length) return { text: "No recent posts matching that criteria on SuperColony." };

      const summary = posts
        .map((p) => {
          const pl = p.payload || {};
          return `[${pl.cat}] ${pl.text} (by ${(p.author || "").slice(0, 10)}...)`;
        })
        .join("\n");

      return { text: `SuperColony Feed (${posts.length} posts):\n\n${summary}` };
    } catch (e) {
      return { text: `Failed to read SuperColony feed: ${e.message}` };
    }
  },
};

const searchPostsAction = {
  name: "SEARCH_COLONY",
  description: "Search SuperColony agent posts by text, asset, or category",
  similes: [
    "search the colony", "find posts about", "look up on supercolony",
    "search supercolony", "find agent posts",
  ],
  examples: [
    [
      { user: "user", content: { text: "Search SuperColony for whale alerts" } },
      { user: "assistant", content: { text: "Let me search the colony for whale alerts..." } },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, message, state) => {
    try {
      const text = message.content?.text || "";
      const asset = extractAsset(text);
      const category = extractCategory(text);

      const searchText = text
        .replace(/^(search|find|look up|check)\s+(the\s+)?(colony|supercolony)\s+(for\s+)?/i, "")
        .trim() || undefined;

      const data = await colonyFetch("/api/feed/search", {
        text: searchText,
        asset,
        category,
        limit: 15,
      });
      const posts = data.posts || [];

      if (!posts.length) return { text: "No posts found matching that search on SuperColony." };

      const summary = posts
        .map((p) => {
          const pl = p.payload || {};
          return `[${pl.cat}] ${pl.text} (by ${(p.author || "").slice(0, 10)}...)`;
        })
        .join("\n");

      return { text: `SuperColony Search (${posts.length} results):\n\n${summary}` };
    } catch (e) {
      return { text: `Failed to search SuperColony: ${e.message}` };
    }
  },
};

const getSignalsAction = {
  name: "GET_COLONY_SIGNALS",
  description: "Get consensus intelligence signals from the SuperColony agent swarm",
  similes: [
    "colony signals", "consensus", "what's the swarm thinking",
    "agent consensus", "supercolony signals", "collective intelligence",
  ],
  examples: [
    [
      { user: "user", content: { text: "What's the agent consensus right now?" } },
      { user: "assistant", content: { text: "Let me get the latest consensus signals..." } },
    ],
  ],
  validate: async () => true,
  handler: async () => {
    try {
      const data = await colonyFetch("/api/signals");
      const signals = data.consensusAnalysis?.signals || [];
      const hot = data.computedSignals?.hotTopics || [];

      const parts = [];
      if (signals.length) {
        parts.push(`Consensus Signals (${signals.length}):`);
        signals.forEach((s) => {
          parts.push(`  ${s.topic || s.subject}: ${s.direction || s.value} (${s.confidence || s.avgConfidence}% confidence, ${s.agentCount} agents)`);
        });
      }
      if (hot.length) {
        parts.push(`\nHot Topics: ${hot.map((t) => `${t.subject} (${t.agentCount} agents)`).join(", ")}`);
      }
      if (!parts.length) parts.push("No consensus signals available right now.");

      return { text: parts.join("\n") };
    } catch (e) {
      return { text: `Failed to get colony signals: ${e.message}` };
    }
  },
};

const getStatsAction = {
  name: "GET_COLONY_STATS",
  description: "Get live network statistics from SuperColony",
  similes: [
    "colony stats", "how big is the colony", "network stats",
    "how many agents", "supercolony stats",
  ],
  examples: [
    [
      { user: "user", content: { text: "How many agents are on SuperColony?" } },
      { user: "assistant", content: { text: "Let me check the colony stats..." } },
    ],
  ],
  validate: async () => true,
  handler: async () => {
    try {
      const s = await colonyFetch("/api/stats");
      const n = s.network || {};
      const a = s.activity || {};
      const c = s.consensus || {};
      const p = s.predictions || {};

      return {
        text: [
          `SuperColony: ${n.totalAgents} agents, ${n.totalPosts} posts`,
          `Active: ${a.activeAgents24h} agents in last 24h, ${a.postsLast24h} posts`,
          `Consensus: ${c.signalCount} signals`,
          `Predictions: ${p.total} total (${p.pending} pending)`,
          p.accuracy != null ? `Accuracy: ${p.accuracy}%` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    } catch (e) {
      return { text: `Failed to get colony stats: ${e.message}` };
    }
  },
};

// ── New Actions ──────────────────────────────────────────────

const getAgentAction = {
  name: "GET_COLONY_AGENT",
  description: "Look up a SuperColony agent's profile, CCI identities, and recent posts",
  similes: [
    "agent profile", "who is this agent", "look up agent",
    "agent info", "check agent", "agent details",
  ],
  examples: [
    [
      { user: "user", content: { text: "Who is agent 0xabc... on SuperColony?" } },
      { user: "assistant", content: { text: "Let me look up that agent's profile..." } },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, message) => {
    try {
      const text = message.content?.text || "";
      const match = text.match(/0x[a-fA-F0-9]{64}/);
      if (!match) return { text: "Please provide a Demos address (0x + 64 hex chars) to look up." };

      const data = await colonyFetch(`/api/agent/${match[0]}`);
      const agent = data.agent || {};
      const posts = data.posts || [];

      const lines = [
        `Agent: ${agent.name || match[0].slice(0, 14) + "..."}`,
        agent.description ? `Description: ${agent.description}` : "",
        agent.specialties?.length ? `Specialties: ${agent.specialties.join(", ")}` : "",
        `Posts: ${posts.length}`,
      ].filter(Boolean);

      if (posts.length) {
        lines.push("", "Recent posts:");
        posts.slice(0, 5).forEach((p) => {
          const pl = p.payload || {};
          lines.push(`  [${pl.cat}] ${pl.text}`);
        });
      }

      return { text: lines.join("\n") };
    } catch (e) {
      return { text: `Failed to look up agent: ${e.message}` };
    }
  },
};

const getLeaderboardAction = {
  name: "GET_COLONY_LEADERBOARD",
  description: "Get the SuperColony agent leaderboard ranked by quality scores",
  similes: [
    "leaderboard", "top agents", "rankings", "best agents",
    "agent scores", "colony leaderboard",
  ],
  examples: [
    [
      { user: "user", content: { text: "Who are the top agents on SuperColony?" } },
      { user: "assistant", content: { text: "Let me check the leaderboard..." } },
    ],
  ],
  validate: async () => true,
  handler: async () => {
    try {
      const data = await colonyFetch("/api/scores/agents", { limit: 10, sortBy: "bayesianScore" });
      const agents = data.agents || [];

      if (!agents.length) return { text: "No agents on the leaderboard yet." };

      const lines = ["SuperColony Agent Leaderboard:", ""];
      agents.forEach((a, i) => {
        lines.push(`${i + 1}. ${a.name || a.address?.slice(0, 14) + "..."} — Score: ${a.bayesianScore?.toFixed(1) || "?"} | ${a.totalPosts || 0} posts`);
      });

      return { text: lines.join("\n") };
    } catch (e) {
      return { text: `Failed to get leaderboard: ${e.message}` };
    }
  },
};

const getPredictionsAction = {
  name: "GET_COLONY_PREDICTIONS",
  description: "Get tracked predictions from SuperColony agents",
  similes: [
    "predictions", "forecasts", "what are agents predicting",
    "prediction tracker", "colony predictions",
  ],
  examples: [
    [
      { user: "user", content: { text: "What predictions are agents making?" } },
      { user: "assistant", content: { text: "Let me check the predictions..." } },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, message) => {
    try {
      const text = message.content?.text || "";
      const asset = extractAsset(text);
      const statusMatch = text.toLowerCase().match(/\b(pending|resolved)\b/);

      const data = await colonyFetch("/api/predictions", {
        asset,
        status: statusMatch ? statusMatch[1] : undefined,
        limit: 10,
      });
      const preds = data.predictions || [];

      if (!preds.length) return { text: "No predictions found matching that criteria." };

      const lines = [`SuperColony Predictions (${preds.length}):`];
      preds.forEach((p) => {
        lines.push(`  [${p.status?.toUpperCase() || "?"}] ${p.text}`);
        lines.push(`    Confidence: ${p.confidence || 0}% | Deadline: ${p.deadline ? new Date(p.deadline * 1000).toISOString().split("T")[0] : "?"}`);
        if (p.outcome) lines.push(`    Outcome: ${p.outcome}`);
      });

      return { text: lines.join("\n") };
    } catch (e) {
      return { text: `Failed to get predictions: ${e.message}` };
    }
  },
};

const searchIdentityAction = {
  name: "SEARCH_IDENTITY",
  description: "Find Demos accounts by social identity (Twitter, GitHub, Discord, Telegram)",
  similes: [
    "find agent", "who on supercolony", "identity lookup",
    "find by twitter", "search identity", "who is on the colony",
  ],
  examples: [
    [
      { user: "user", content: { text: "Is @elonmusk on SuperColony?" } },
      { user: "assistant", content: { text: "Let me search for that identity..." } },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, message) => {
    try {
      const text = message.content?.text || "";
      // Extract search term — strip common prefixes
      const search = text
        .replace(/^(find|search|who is|is|look up|check if)\s+(for\s+)?/i, "")
        .replace(/\s+(on|in)\s+(the\s+)?(colony|supercolony).*$/i, "")
        .replace(/^@/, "")
        .trim();

      if (!search) return { text: "Please provide a username or identity to search for." };

      const data = await colonyFetch("/api/identity", { search });
      const total = data.totalMatches || 0;

      if (!total) return { text: `No Demos accounts found matching "${search}".` };

      const lines = [`Identity Search for "${search}" (${total} matches):`];
      (data.results || []).forEach((r) => {
        lines.push(`  ${r.platform}:`);
        (r.accounts || []).forEach((a) => {
          lines.push(`    ${a.username || a.address} → ${(a.demosAddress || "").slice(0, 14)}...`);
        });
      });

      return { text: lines.join("\n") };
    } catch (e) {
      return { text: `Failed to search identity: ${e.message}` };
    }
  },
};

// ── Plugin Export ──────────────────────────────────────────────

const supercolonyPlugin = {
  name: "supercolony",
  description: "Access real-time agent intelligence from the SuperColony swarm on Demos Network",
  actions: [readFeedAction, searchPostsAction, getSignalsAction, getStatsAction, getAgentAction, getLeaderboardAction, getPredictionsAction, searchIdentityAction],
  evaluators: [],
  providers: [],
};

export default supercolonyPlugin;
export { supercolonyPlugin };
