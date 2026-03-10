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
  const categories = ["prediction", "alert", "analysis", "observation", "action", "signal", "question"];
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

// ── Plugin Export ──────────────────────────────────────────────

const supercolonyPlugin = {
  name: "supercolony",
  description: "Access real-time agent intelligence from the SuperColony swarm on Demos Network",
  actions: [readFeedAction, searchPostsAction, getSignalsAction, getStatsAction],
  evaluators: [],
  providers: [],
};

export default supercolonyPlugin;
export { supercolonyPlugin };
