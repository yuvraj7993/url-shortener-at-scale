// 1. Read the .env file FIRST so process.env has our settings
import "dotenv/config";

// 2. Bring in the web server library
import express from "express";

// 3. Bring in the database connection pool tool
import { Pool } from "pg";

// 4. Read settings from .env
//    "|| 3000" means: if PORT is missing, use 3000
const PORT = Number(process.env.PORT) || 3000;

//    If BASE_URL is missing, build one from the port
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// 5. Create the database pool using the URL from .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 6. Create the web server
const app = express();

// 7. Let the server understand JSON sent in requests
app.use(express.json());

// 8. The 62 characters used in short codes
const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// 9. Convert a number into a short code
function toBase62(n: number): string {
  let result = "";
  do {
    result = ALPHABET[n % 62] + result;
    n = Math.floor(n / 62);
  } while (n > 0);
  return result;
}

// ROUTE: home page (so "/" doesn't say "Cannot GET /")
app.get("/", (_req, res) => {
  res.send("URL Shortener API is running. Use POST /shorten to create a link.");
});

// ROUTE: health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ROUTE: create a short link
app.post("/shorten", async (req, res) => {
  const { url } = req.body;

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const { rows } = await pool.query(
    "INSERT INTO urls (long_url) VALUES ($1) RETURNING id",
    [url]
  );

  const code = toBase62(Number(rows[0].id) + 1000000);

  await pool.query("UPDATE urls SET code = $1 WHERE id = $2", [
    code,
    rows[0].id,
  ]);

  res.json({ short: `${BASE_URL}/${code}` });
});

// ROUTE: open a short link (must stay LAST among the GET routes)
app.get("/:code", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT long_url FROM urls WHERE code = $1",
    [req.params.code]
  );

  if (rows.length === 0) {
    return res.status(404).send("Not found");
  }

  res.redirect(302, rows[0].long_url);
});

// 10. Start the server
app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});