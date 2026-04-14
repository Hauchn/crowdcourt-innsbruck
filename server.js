const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/crowdcourt";
const PRESENCE_TTL_MINUTES = 90;
const PROXIMITY_THRESHOLD_METERS = 120;
const RATE_LIMIT_MS = 20_000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname)));

const pool = new Pool({
  connectionString: DATABASE_URL,
});

const rateLimitStore = new Map();
const memoryPresence = new Map();
const memoryEvents = [];
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

function toConfidence(count, updatedAt) {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  if (count >= 10 || (ageMs < 5 * 60 * 1000 && count >= 5)) {
    return "high";
  }
  if (count >= 2 && count <= 9) {
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

function checkRateLimit(key) {
  const now = Date.now();
  const last = rateLimitStore.get(key);
  if (last && now - last < RATE_LIMIT_MS) {
    return false;
  }
  rateLimitStore.set(key, now);
  return true;
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
  cleanupExpiredMemoryPresence();
  let count = 0;
  for (const value of memoryPresence.values()) {
    if (value.spotId === spotId) {
      count += 1;
    }
  }
  return count;
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
  if (!userId || !spotId) {
    return invalidBodyResponse(res, "userId und spotId sind erforderlich");
  }
  if (!validateCoordinates([spotLat, spotLon, userLat, userLon])) {
    return invalidBodyResponse(res, "Ungültige Koordinaten");
  }
  if (!checkRateLimit(`checkin:${userId}`)) {
    return res.status(429).json({ ok: false, error: "Zu viele Anfragen" });
  }
  const distance = haversineMeters(userLat, userLon, spotLat, spotLon);
  if (distance > PROXIMITY_THRESHOLD_METERS) {
    return res.status(403).json({ ok: false, error: "Du bist zu weit vom Spot entfernt." });
  }

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
  if (!userId || !spotId) {
    return invalidBodyResponse(res, "userId und spotId sind erforderlich");
  }
  if (!validateCoordinates([spotLat, spotLon, userLat, userLon])) {
    return invalidBodyResponse(res, "Ungültige Koordinaten");
  }
  if (!checkRateLimit(`heartbeat:${userId}`)) {
    return res.status(429).json({ ok: false, error: "Zu viele Anfragen" });
  }
  const distance = haversineMeters(userLat, userLon, spotLat, spotLon);
  if (distance > PROXIMITY_THRESHOLD_METERS) {
    return res.status(403).json({ ok: false, error: "Du bist zu weit vom Spot entfernt." });
  }

  const expiresAt = new Date(Date.now() + PRESENCE_TTL_MINUTES * 60 * 1000);

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
      [userId, spotId, userLat, userLon, PRESENCE_TTL_MINUTES]
    );
    await logEvent(client, userId, spotId, "heartbeat");
    await client.query("COMMIT");
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
      const count = memorySpotCount(spotId);
      spots[spotId] = {
        count,
        bucket: toBucket(count),
        confidence: toConfidence(count, updatedAt),
      };
    });
    return res.json({ updatedAt, spots });
  }

  const client = await pool.connect();
  try {
    await cleanupExpiredPresence(client);
    const queryResult = await client.query(
      `SELECT spot_id, COUNT(*)::int AS count, MAX(last_seen_at) AS last_seen
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
      };
    });
    const spots = {};
    spotIds.forEach((id) => {
      const value = counts[id];
      const count = value?.count || 0;
      spots[id] = {
        count,
        bucket: toBucket(count),
        confidence: toConfidence(count, value?.lastSeen || updatedAt),
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
