const path = require("path");
const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const { EventEmitter } = require("events");

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/crowdcourt";
const PRESENCE_TTL_MINUTES = 90;
const HEARTBEAT_EXTENSION_MINUTES = 20;
const PROXIMITY_THRESHOLD_METERS = 120;
const RATE_LIMIT_MS = 20_000;
const MAX_MOVEMENT_SPEED_MPS = 45;
const SOFT_BLOCK_WINDOW_MS = 10 * 60 * 1000;
const SOFT_BLOCK_MAX_DISTINCT_SPOTS = 8;
const SOFT_BLOCK_DURATION_MS = 10 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname)));
const agentBus = new EventEmitter();

const pool = new Pool({
  connectionString: DATABASE_URL,
});

const rateLimitStore = new Map();
const memoryPresence = new Map();
const memoryEvents = [];
const movementStore = new Map();
const softBlockStore = new Map();
const qualityMetrics = {
  acceptedSignals: 0,
  rejectedSignals: 0,
  rejectedByReason: {
    rate_limit: 0,
    soft_block: 0,
    distance: 0,
    speed: 0,
    invalid_coordinates: 0,
  },
};
let runtimeMode = "postgres";

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function validateCoordinates(values) {
  return values.every((v) => isFiniteNumber(v));
}

function toBucket(count) {
  if (count >= 9) {
    return "high";
  }
  if (count >= 4) {
    return "medium";
  }
  return "low";
}

function toConfidence(count, freshnessSeconds, activeContributors) {
  const fresh = typeof freshnessSeconds === "number" ? freshnessSeconds : Number.MAX_SAFE_INTEGER;
  if (activeContributors >= 10 || (fresh <= 300 && activeContributors >= 5)) {
    return "high";
  }
  if (count >= 2 && count <= 9 && fresh <= 900) {
    return "medium";
  }
  return "low";
}

function haversineMeters(aLat, aLon, bLat, bLon) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function toSportLabel(key) {
  if (key === "soccer") {
    return "Fussball";
  }
  if (key === "tennis") {
    return "Tennis";
  }
  if (key === "volleyball") {
    return "Volleyball";
  }
  if (key === "table_tennis") {
    return "Tischtennis";
  }
  return key;
}

function parseSportsList(rawSports) {
  if (!Array.isArray(rawSports) || rawSports.length === 0) {
    return ["soccer", "tennis", "volleyball", "table_tennis"];
  }
  const allowed = new Set(["soccer", "tennis", "volleyball", "table_tennis"]);
  const filtered = rawSports.filter((sport) => allowed.has(sport));
  return filtered.length > 0 ? filtered : ["soccer", "tennis", "volleyball", "table_tennis"];
}

async function fetchInnsbruckSportsPlaces({ sports, limit }) {
  const sportsList = parseSportsList(sports);
  const maxResults = Math.max(1, Math.min(Number(limit) || 20, 80));
  const overpassQuery = `
[out:json][timeout:20];
(
  node["leisure"="pitch"]["sport"~"${sportsList.join("|")}"](around:15000,47.2692,11.4041);
  way["leisure"="pitch"]["sport"~"${sportsList.join("|")}"](around:15000,47.2692,11.4041);
  node["leisure"="sports_centre"]["sport"~"${sportsList.join("|")}"](around:15000,47.2692,11.4041);
  way["leisure"="sports_centre"]["sport"~"${sportsList.join("|")}"](around:15000,47.2692,11.4041);
);
out center tags;
`;
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: overpassQuery,
      });
      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      const mapped = (data.elements || [])
        .map((item) => {
          const lat = Number(item.lat ?? item.center?.lat);
          const lon = Number(item.lon ?? item.center?.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return null;
          }
          const sportsRaw = String(item.tags?.sport || "");
          const tagsSports = sportsRaw
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean);
          const matchedSports = tagsSports.filter((sport) => sportsList.includes(sport));
          return {
            id: `${item.type}/${item.id}`,
            name: item.tags?.name || "Unbenannter Sportplatz",
            lat,
            lon,
            sports: matchedSports.length > 0 ? matchedSports : sportsList,
          };
        })
        .filter(Boolean)
        .slice(0, maxResults);
      if (mapped.length > 0) {
        return mapped;
      }
    } catch {
      // Try next endpoint.
    }
  }

  const fallbackPlaces = [
    { id: "fallback/1", name: "Sportzentrum Universität Innsbruck", lat: 47.2634, lon: 11.3435 },
    { id: "fallback/2", name: "Tennisclub Innsbruck", lat: 47.2717, lon: 11.3998 },
    { id: "fallback/3", name: "Sportanlage Tivoli", lat: 47.2571, lon: 11.4179 },
    { id: "fallback/4", name: "Beachvolleyball Rapoldipark", lat: 47.2663, lon: 11.4099 },
  ];
  return fallbackPlaces.slice(0, maxResults).map((place) => ({
    ...place,
    sports: sportsList,
  }));
}

function buildPlanFromPlaces(places, options = {}) {
  const {
    startHour = "17:00",
    maxStops = 3,
    focus = null,
    travelMode = "zu Fuss",
  } = options;
  const filtered = focus
    ? places.filter((place) => place.sports.includes(focus))
    : places;
  const selected = filtered.slice(0, Math.max(1, Math.min(Number(maxStops) || 3, 6)));
  return {
    title: "Sport-Session Innsbruck",
    startHour,
    travelMode,
    stops: selected.map((place, index) => ({
      order: index + 1,
      placeId: place.id,
      placeName: place.name,
      coords: { lat: place.lat, lon: place.lon },
      activity: `Spiele ${toSportLabel(place.sports[0] || "sport")}`,
      durationMinutes: 60,
    })),
  };
}

function checkRateLimit(key, minIntervalMs = RATE_LIMIT_MS) {
  const now = Date.now();
  const last = rateLimitStore.get(key);
  if (last && now - last < minIntervalMs) {
    return false;
  }
  rateLimitStore.set(key, now);
  return true;
}

function getRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) {
    return forwarded;
  }
  return req.ip || "unknown";
}

function metricReject(reason) {
  qualityMetrics.rejectedSignals += 1;
  if (qualityMetrics.rejectedByReason[reason] != null) {
    qualityMetrics.rejectedByReason[reason] += 1;
  }
}

function metricAccept() {
  qualityMetrics.acceptedSignals += 1;
}

function isSoftBlocked(identityKey) {
  const entry = softBlockStore.get(identityKey);
  if (!entry) {
    return false;
  }
  if (entry.blockedUntil > Date.now()) {
    return true;
  }
  softBlockStore.delete(identityKey);
  return false;
}

function registerPresenceSignal(identityKey, spotId) {
  const now = Date.now();
  const entry = softBlockStore.get(identityKey) || {
    blockedUntil: 0,
    visits: [],
  };
  entry.visits = entry.visits.filter((visit) => now - visit.at <= SOFT_BLOCK_WINDOW_MS);
  entry.visits.push({ spotId, at: now });
  const distinctSpots = new Set(entry.visits.map((visit) => visit.spotId)).size;
  if (distinctSpots > SOFT_BLOCK_MAX_DISTINCT_SPOTS) {
    entry.blockedUntil = now + SOFT_BLOCK_DURATION_MS;
  }
  softBlockStore.set(identityKey, entry);
}

function validateMovementPlausibility(userId, userLat, userLon) {
  const now = Date.now();
  const previous = movementStore.get(userId);
  movementStore.set(userId, { lat: userLat, lon: userLon, at: now });
  if (!previous) {
    return true;
  }
  const elapsedSeconds = Math.max(1, (now - previous.at) / 1000);
  const distance = haversineMeters(previous.lat, previous.lon, userLat, userLon);
  const speedMps = distance / elapsedSeconds;
  return speedMps <= MAX_MOVEMENT_SPEED_MPS;
}

function invalidBodyResponse(res, message) {
  return res.status(400).json({ ok: false, error: message });
}

function memoryKey(userId, spotId) {
  return `${userId}::${spotId}`;
}

function cleanupExpiredMemoryPresence() {
  const now = Date.now();
  for (const [key, value] of memoryPresence.entries()) {
    if (value.expiresAt <= now) {
      memoryPresence.delete(key);
      memoryEvents.push({
        userId: value.userId,
        spotId: value.spotId,
        eventType: "expired_cleanup",
        createdAt: new Date().toISOString(),
      });
    }
  }
}

function memorySpotCount(spotId) {
  return memorySpotStats(spotId).count;
}

function memorySpotStats(spotId) {
  cleanupExpiredMemoryPresence();
  let count = 0;
  let lastSeenAt = null;
  const contributors = new Set();
  for (const value of memoryPresence.values()) {
    if (value.spotId === spotId) {
      count += 1;
      contributors.add(value.userId);
      if (!lastSeenAt || value.lastSeenAt > lastSeenAt) {
        lastSeenAt = value.lastSeenAt;
      }
    }
  }
  const freshnessSeconds = lastSeenAt ? Math.max(0, Math.round((Date.now() - lastSeenAt) / 1000)) : null;
  return { count, freshnessSeconds, activeContributors: contributors.size };
}

async function cleanupExpiredPresence(client) {
  if (runtimeMode === "memory") {
    cleanupExpiredMemoryPresence();
    return;
  }
  await client.query("DELETE FROM active_presence WHERE expires_at < NOW()");
}

async function logEvent(client, userId, spotId, eventType) {
  if (runtimeMode === "memory") {
    memoryEvents.push({
      userId,
      spotId,
      eventType,
      createdAt: new Date().toISOString(),
    });
    return;
  }
  await client.query(
    "INSERT INTO presence_events (user_id, spot_id, event_type) VALUES ($1, $2, $3)",
    [userId, spotId, eventType]
  );
}

async function getSpotCount(client, spotId) {
  if (runtimeMode === "memory") {
    return memorySpotCount(spotId);
  }
  const result = await client.query(
    "SELECT COUNT(*)::int AS count FROM active_presence WHERE spot_id = $1 AND expires_at >= NOW()",
    [spotId]
  );
  return result.rows[0]?.count || 0;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: runtimeMode,
    message:
      runtimeMode === "postgres"
        ? "Backend läuft mit PostgreSQL"
        : "Backend läuft im In-Memory-Fallback (Daten nicht persistent)",
  });
});

app.post("/api/presence/checkin", async (req, res) => {
  const { userId, spotId, spotLat, spotLon, userLat, userLon } = req.body || {};
  const identityKey = `${userId}:${getRequestIp(req)}`;
  if (!userId || !spotId) {
    return invalidBodyResponse(res, "userId und spotId sind erforderlich");
  }
  if (!validateCoordinates([spotLat, spotLon, userLat, userLon])) {
    metricReject("invalid_coordinates");
    return invalidBodyResponse(res, "Ungültige Koordinaten");
  }
  if (!checkRateLimit(`checkin:${identityKey}`)) {
    metricReject("rate_limit");
    return res.status(429).json({ ok: false, error: "Zu viele Anfragen" });
  }
  if (isSoftBlocked(identityKey)) {
    metricReject("soft_block");
    return res.status(429).json({ ok: false, error: "Zu viele Spot-Wechsel in kurzer Zeit. Bitte kurz warten." });
  }
  const distance = haversineMeters(userLat, userLon, spotLat, spotLon);
  if (distance > PROXIMITY_THRESHOLD_METERS) {
    metricReject("distance");
    return res.status(403).json({ ok: false, error: "Du bist zu weit vom Spot entfernt." });
  }
  if (!validateMovementPlausibility(userId, userLat, userLon)) {
    metricReject("speed");
    return res.status(403).json({ ok: false, error: "Bewegung unplausibel. Bitte erneut versuchen." });
  }
  registerPresenceSignal(identityKey, spotId);

  const expiresAt = new Date(Date.now() + PRESENCE_TTL_MINUTES * 60 * 1000);

  if (runtimeMode === "memory") {
    cleanupExpiredMemoryPresence();
    const key = memoryKey(userId, spotId);
    const existing = memoryPresence.get(key);
    memoryPresence.set(key, {
      userId,
      spotId,
      lat: userLat,
      lon: userLon,
      lastSeenAt: Date.now(),
      expiresAt: expiresAt.getTime(),
    });
    memoryEvents.push({
      userId,
      spotId,
      eventType: existing ? "heartbeat" : "checkin",
      createdAt: new Date().toISOString(),
    });
    const activeNow = memorySpotCount(spotId);
    metricAccept();
    return res.json({
      ok: true,
      spotId,
      activeNow,
      bucket: toBucket(activeNow),
      expiresAt: expiresAt.toISOString(),
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await cleanupExpiredPresence(client);
    const existing = await client.query(
      "SELECT 1 FROM active_presence WHERE user_id = $1 AND spot_id = $2 LIMIT 1",
      [userId, spotId]
    );
    await client.query(
      `INSERT INTO active_presence (user_id, spot_id, lat, lon, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + ($5 || ' minutes')::interval)
       ON CONFLICT (user_id, spot_id)
       DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, last_seen_at = NOW(), expires_at = NOW() + ($5 || ' minutes')::interval`,
      [userId, spotId, userLat, userLon, PRESENCE_TTL_MINUTES]
    );
    const eventType = existing.rowCount > 0 ? "heartbeat" : "checkin";
    await logEvent(client, userId, spotId, eventType);
    const activeNow = await getSpotCount(client, spotId);
    await client.query("COMMIT");
    metricAccept();
    return res.json({
      ok: true,
      spotId,
      activeNow,
      bucket: toBucket(activeNow),
      expiresAt: expiresAt.toISOString(),
    });
  } catch {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: "Checkin fehlgeschlagen" });
  } finally {
    client.release();
  }
});

app.post("/api/presence/checkout", async (req, res) => {
  const { userId, spotId } = req.body || {};
  if (!userId || !spotId) {
    return invalidBodyResponse(res, "userId und spotId sind erforderlich");
  }

  if (runtimeMode === "memory") {
    memoryPresence.delete(memoryKey(userId, spotId));
    memoryEvents.push({
      userId,
      spotId,
      eventType: "checkout",
      createdAt: new Date().toISOString(),
    });
    return res.json({ ok: true });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM active_presence WHERE user_id = $1 AND spot_id = $2", [
      userId,
      spotId,
    ]);
    await logEvent(client, userId, spotId, "checkout");
    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: "Checkout fehlgeschlagen" });
  } finally {
    client.release();
  }
});

app.post("/api/presence/heartbeat", async (req, res) => {
  const { userId, spotId, spotLat, spotLon, userLat, userLon } = req.body || {};
  const identityKey = `${userId}:${getRequestIp(req)}`;
  if (!userId || !spotId) {
    return invalidBodyResponse(res, "userId und spotId sind erforderlich");
  }
  if (!validateCoordinates([spotLat, spotLon, userLat, userLon])) {
    metricReject("invalid_coordinates");
    return invalidBodyResponse(res, "Ungültige Koordinaten");
  }
  if (!checkRateLimit(`heartbeat:${identityKey}`, 10_000)) {
    metricReject("rate_limit");
    return res.status(429).json({ ok: false, error: "Zu viele Anfragen" });
  }
  if (isSoftBlocked(identityKey)) {
    metricReject("soft_block");
    return res.status(429).json({ ok: false, error: "Temporär blockiert. Bitte kurz warten." });
  }
  const distance = haversineMeters(userLat, userLon, spotLat, spotLon);
  if (distance > PROXIMITY_THRESHOLD_METERS) {
    metricReject("distance");
    return res.status(403).json({ ok: false, error: "Du bist zu weit vom Spot entfernt." });
  }
  if (!validateMovementPlausibility(userId, userLat, userLon)) {
    metricReject("speed");
    return res.status(403).json({ ok: false, error: "Bewegung unplausibel. Bitte erneut versuchen." });
  }
  registerPresenceSignal(identityKey, spotId);

  const expiresAt = new Date(Date.now() + HEARTBEAT_EXTENSION_MINUTES * 60 * 1000);

  if (runtimeMode === "memory") {
    memoryPresence.set(memoryKey(userId, spotId), {
      userId,
      spotId,
      lat: userLat,
      lon: userLon,
      lastSeenAt: Date.now(),
      expiresAt: expiresAt.getTime(),
    });
    await logEvent(null, userId, spotId, "heartbeat");
    metricAccept();
    return res.json({ ok: true, expiresAt: expiresAt.toISOString() });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await cleanupExpiredPresence(client);
    const result = await client.query(
      `INSERT INTO active_presence (user_id, spot_id, lat, lon, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + ($5 || ' minutes')::interval)
       ON CONFLICT (user_id, spot_id)
       DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, last_seen_at = NOW(), expires_at = NOW() + ($5 || ' minutes')::interval
       RETURNING expires_at`,
      [userId, spotId, userLat, userLon, HEARTBEAT_EXTENSION_MINUTES]
    );
    await logEvent(client, userId, spotId, "heartbeat");
    await client.query("COMMIT");
    metricAccept();
    return res.json({ ok: true, expiresAt: result.rows[0].expires_at });
  } catch {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: "Heartbeat fehlgeschlagen" });
  } finally {
    client.release();
  }
});

app.get("/api/crowd", async (req, res) => {
  const spotIdsRaw = String(req.query.spotIds || "");
  const spotIds = spotIdsRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 200);

  if (spotIds.length === 0) {
    return invalidBodyResponse(res, "spotIds query parameter ist erforderlich");
  }

  const updatedAt = new Date().toISOString();

  if (runtimeMode === "memory") {
    cleanupExpiredMemoryPresence();
    const spots = {};
    spotIds.forEach((spotId) => {
      const stats = memorySpotStats(spotId);
      const confidence = toConfidence(stats.count, stats.freshnessSeconds, stats.activeContributors);
      spots[spotId] = {
        count: stats.count,
        bucket: toBucket(stats.count),
        confidence,
        freshnessSeconds: stats.freshnessSeconds,
        activeContributors: stats.activeContributors,
      };
    });
    return res.json({ updatedAt, spots });
  }

  const client = await pool.connect();
  try {
    await cleanupExpiredPresence(client);
    const queryResult = await client.query(
      `SELECT spot_id,
              COUNT(*)::int AS count,
              COUNT(DISTINCT user_id)::int AS active_contributors,
              MAX(last_seen_at) AS last_seen
       FROM active_presence
       WHERE spot_id = ANY($1::text[]) AND expires_at >= NOW()
       GROUP BY spot_id`,
      [spotIds]
    );
    const counts = {};
    queryResult.rows.forEach((row) => {
      counts[row.spot_id] = {
        count: row.count,
        lastSeen: row.last_seen,
        activeContributors: row.active_contributors,
      };
    });
    const spots = {};
    spotIds.forEach((id) => {
      const value = counts[id];
      const count = value?.count || 0;
      const freshnessSeconds = value?.lastSeen
        ? Math.max(0, Math.round((Date.now() - new Date(value.lastSeen).getTime()) / 1000))
        : null;
      const activeContributors = value?.activeContributors || 0;
      spots[id] = {
        count,
        bucket: toBucket(count),
        confidence: toConfidence(count, freshnessSeconds, activeContributors),
        freshnessSeconds,
        activeContributors,
      };
    });
    return res.json({ updatedAt, spots });
  } catch {
    return res.status(500).json({ ok: false, error: "Crowd konnte nicht geladen werden" });
  } finally {
    client.release();
  }
});

app.get("/api/crowd/top-spots", async (_req, res) => {
  if (runtimeMode === "memory") {
    cleanupExpiredMemoryPresence();
    const map = new Map();
    for (const value of memoryPresence.values()) {
      map.set(value.spotId, (map.get(value.spotId) || 0) + 1);
    }
    const spots = [...map.entries()]
      .map(([spot_id, count]) => ({ spot_id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return res.json({ spots });
  }

  const client = await pool.connect();
  try {
    await cleanupExpiredPresence(client);
    const result = await client.query(
      `SELECT spot_id, COUNT(*)::int AS count
       FROM active_presence
       WHERE expires_at >= NOW()
       GROUP BY spot_id
       ORDER BY count DESC
       LIMIT 10`
    );
    return res.json({ spots: result.rows });
  } catch {
    return res.status(500).json({ ok: false, error: "Top Spots nicht verfügbar" });
  } finally {
    client.release();
  }
});

app.get("/api/crowd/metrics", (_req, res) => {
  const totalSignals = qualityMetrics.acceptedSignals + qualityMetrics.rejectedSignals;
  const rejectionRate = totalSignals > 0 ? qualityMetrics.rejectedSignals / totalSignals : 0;
  res.json({
    ok: true,
    metrics: {
      ...qualityMetrics,
      totalSignals,
      rejectionRate,
    },
  });
});

app.post("/api/agents/sports-places", async (req, res) => {
  const { sports, limit } = req.body || {};
  try {
    const places = await fetchInnsbruckSportsPlaces({ sports, limit });
    return res.json({
      ok: true,
      agent: "sports",
      city: "Innsbruck",
      count: places.length,
      places,
    });
  } catch {
    return res.status(502).json({
      ok: false,
      error: "Sports-Agent konnte Sportplätze nicht laden",
    });
  }
});

app.post("/api/agents/planner", (req, res) => {
  const { places, options } = req.body || {};
  if (!Array.isArray(places) || places.length === 0) {
    return invalidBodyResponse(res, "places ist erforderlich");
  }
  const plan = buildPlanFromPlaces(places, options);
  return res.json({
    ok: true,
    agent: "planner",
    plan,
  });
});

app.post("/api/agents/compose-plan", async (req, res) => {
  const { sports, limit, options } = req.body || {};
  const requestId = randomUUID();
  const eventName = `sports-ready:${requestId}`;

  const plannerResultPromise = new Promise((resolve) => {
    agentBus.once(eventName, (payload) => {
      resolve(buildPlanFromPlaces(payload.places, options));
    });
  });

  try {
    const places = await fetchInnsbruckSportsPlaces({ sports, limit });
    agentBus.emit(eventName, { places });
    const plan = await plannerResultPromise;
    return res.json({
      ok: true,
      linkedAgents: ["sports", "planner"],
      city: "Innsbruck",
      places,
      plan,
    });
  } catch {
    return res.status(502).json({
      ok: false,
      error: "Agent-Verkettung fehlgeschlagen",
    });
  }
});

app.use((_req, res) => {
  res.sendFile(path.resolve(__dirname, "index.html"));
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS active_presence (
        user_id TEXT NOT NULL,
        spot_id TEXT NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (user_id, spot_id)
      );
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_active_presence_spot_id ON active_presence (spot_id);"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_active_presence_expires_at ON active_presence (expires_at);"
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS presence_events (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        spot_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('checkin','checkout','heartbeat','expired_cleanup')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

async function startServer() {
  try {
    await initDb();
    runtimeMode = "postgres";
    console.log("DB connected. Running in postgres mode.");
  } catch (error) {
    runtimeMode = "memory";
    console.warn("DB init failed, switching to in-memory fallback mode.");
    console.warn(error.message);
  }
  app.listen(PORT, () => {
    console.log(`CrowdCourt API running on http://localhost:${PORT} (${runtimeMode})`);
  });
}

startServer();
