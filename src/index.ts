import "dotenv/config";
import express from "express";
import { Pool } from "pg";

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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

// NEW: words users are not allowed to use as an alias,
// because they are already real routes in our app
const RESERVED = ["health", "shorten", "api", "admin"];

// NEW: alias rules: 3 to 30 characters, only letters, digits, - and _
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

    // 1. Validate the URL
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    // NEW: only allow http and https links
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return res.status(400).json({ error: "Only http and https URLs allowed" });
    }

    // 2. NEW: work out the expiry time (or null = never expires)
    let expiresAt: Date | null = null;
    if (expiresInMinutes !== undefined) {
      const minutes = Number(expiresInMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return res.status(400).json({ error: "expiresInMinutes must be a positive number" });
      }
      expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    }

    // 3. NEW: custom alias path
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
        // 23505 = Postgres code for "unique violation" (alias already taken)
        if (err.code === "23505") {
          return res.status(409).json({ error: "Alias already taken" });
        }
        throw err;
      }
    }

    // 4. NEW: auto-generated code path (one INSERT instead of two steps)
    for (let attempt = 0; attempt < 3; attempt++) {
      // Ask the database for the next unique id
      const idResult = await pool.query("SELECT nextval('urls_id_seq') AS id");
      const code = toBase62(Number(idResult.rows[0].id) + 1000000);

      try {
        await pool.query(
          "INSERT INTO urls (id, code, long_url, expires_at) VALUES ($1, $2, $3, $4)",
          [idResult.rows[0].id, code, url, expiresAt]
        );
        return res.status(201).json({ short: `${BASE_URL}/${code}` });
      } catch (err: any) {
        // If someone already took this code as a custom alias, try again
        if (err.code !== "23505") throw err;
      }
    }

    return res.status(500).json({ error: "Could not generate a unique code" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/:code", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT long_url, expires_at FROM urls WHERE code = $1",
      [req.params.code]
    );

    if (rows.length === 0) {
      return res.status(404).send("Not found");
    }

    // NEW: if an expiry exists and it is in the past, the link is dead
    const expiresAt = rows[0].expires_at;
    if (expiresAt && new Date(expiresAt) < new Date()) {
      return res.status(410).send("This link has expired");
    }

    res.redirect(302, rows[0].long_url);
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});