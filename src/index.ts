import "dotenv/config";
import express from "express";
import { Pool } from "pg";
import Redis from "ioredis";

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// NEW: connect to Redis.
// enableOfflineQueue:false = if Redis is down, fail fast instead of waiting forever
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

// NEW: without this, a Redis error could crash the whole server
redis.on("error", (err) => console.error("Redis error:", err.message));

// NEW: keep cached links for at most 1 hour
const CACHE_TTL_SECONDS = 3600;

const app = express();
app.use(express.json());

const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function toBase62(n: number): string {
  let result = "";
  do {
    result = ALPHABET[n % 62] + result;
    n = Math.floor(n / 62);
  } while (n > 0);
  return result;
}

const RESERVED = ["health", "shorten", "api", "admin"];
const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{3,30}$/;

app.get("/", (_req, res) => {
  res.send("URL Shortener API is running. Use POST /shorten to create a link.");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/shorten", async (req, res) => {
  try {
    const { url, alias, expiresInMinutes } = req.body;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return res.status(400).json({ error: "Only http and https URLs allowed" });
    }

    let expiresAt: Date | null = null;
    if (expiresInMinutes !== undefined) {
      const minutes = Number(expiresInMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return res
          .status(400)
          .json({ error: "expiresInMinutes must be a positive number" });
      }
      expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    }

    if (alias !== undefined) {
      if (!ALIAS_PATTERN.test(alias)) {
        return res.status(400).json({
          error: "Alias must be 3-30 characters: letters, digits, - or _",
        });
      }
      if (RESERVED.includes(alias.toLowerCase())) {
        return res.status(400).json({ error: "This alias is reserved" });
      }

      try {
        await pool.query(
          "INSERT INTO urls (code, long_url, expires_at) VALUES ($1, $2, $3)",
          [alias, url, expiresAt]
        );
        return res.status(201).json({ short: `${BASE_URL}/${alias}` });
      } catch (err: any) {
        if (err.code === "23505") {
          return res.status(409).json({ error: "Alias already taken" });
        }
        throw err;
      }
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const idResult = await pool.query("SELECT nextval('urls_id_seq') AS id");
      const code = toBase62(Number(idResult.rows[0].id) + 1000000);

      try {
        await pool.query(
          "INSERT INTO urls (id, code, long_url, expires_at) VALUES ($1, $2, $3, $4)",
          [idResult.rows[0].id, code, url, expiresAt]
        );
        return res.status(201).json({ short: `${BASE_URL}/${code}` });
      } catch (err: any) {
        if (err.code !== "23505") throw err;
      }
    }

    return res.status(500).json({ error: "Could not generate a unique code" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// CHANGED: the redirect route now checks Redis first
app.get("/:code", async (req, res) => {
  const code = req.params.code;
  const cacheKey = `url:${code}`; // Redis key, e.g. "url:my-google"

  try {
    // STEP A: look in Redis first
    let cached: string | null = null;
    try {
      cached = await redis.get(cacheKey);
    } catch {
      // If Redis fails, we do NOT fail the request. We fall back to the database.
      console.error("Redis read failed, falling back to database");
    }

    // STEP B: cache hit
    if (cached) {
      const { longUrl, expiresAt } = JSON.parse(cached);
      if (expiresAt && new Date(expiresAt) < new Date()) {
        return res.status(410).send("This link has expired");
      }
      res.set("X-Cache", "HIT"); // header so we can SEE it working
      return res.redirect(302, longUrl);
    }

    // STEP C: cache miss, ask PostgreSQL
    const { rows } = await pool.query(
      "SELECT long_url, expires_at FROM urls WHERE code = $1",
      [code]
    );

    if (rows.length === 0) {
      return res.status(404).send("Not found");
    }

    const longUrl: string = rows[0].long_url;
    const expiresAt: Date | null = rows[0].expires_at;

    if (expiresAt && new Date(expiresAt) < new Date()) {
      return res.status(410).send("This link has expired");
    }

    // STEP D: save in Redis for next time.
    // TTL = 1 hour, or less if the link expires sooner.
    let ttl = CACHE_TTL_SECONDS;
    if (expiresAt) {
      const secondsLeft = Math.floor(
        (new Date(expiresAt).getTime() - Date.now()) / 1000
      );
      ttl = Math.min(ttl, secondsLeft);
    }
    if (ttl > 0) {
      try {
        await redis.set(cacheKey, JSON.stringify({ longUrl, expiresAt }), "EX", ttl);
      } catch {
        console.error("Redis write failed, continuing without cache");
      }
    }

    res.set("X-Cache", "MISS");
    res.redirect(302, longUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});