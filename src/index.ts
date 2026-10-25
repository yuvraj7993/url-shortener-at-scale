// Bring in the Express library (our web server tool)
import express from "express";
// Bring in Pool from pg (a group of reusable database connections)
import { Pool } from "pg";

// Create the connection pool. The text means:
// postgres://USERNAME:PASSWORD@HOST:PORT/DATABASE
const pool = new Pool({
  connectionString: "postgres://app:app@localhost:5432/shortener",
});

// Create our web server application
const app = express();

// Middleware: converts incoming JSON text into a JavaScript object (req.body)
app.use(express.json());

// The 62 characters we use for short codes
const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Converts a normal number (like 1000001) into a short code (like "4c93")
function toBase62(n: number): string {
  let result = "";               // we build the answer here
  do {
    result = ALPHABET[n % 62] + result; // n % 62 = remainder, picks a character
    n = Math.floor(n / 62);             // divide by 62, drop the decimal
  } while (n > 0);               // keep going until the number reaches 0
  return result;
}

// ROUTE 1: Health check. Must be ABOVE the /:code route (explained below)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ROUTE 2: Create a short link. Runs when someone sends POST to /shorten
app.post("/shorten", async (req, res) => {
  const { url } = req.body; // take "url" out of the request body

  // Check the URL is valid. new URL() throws an error if it isn't.
  try {
    new URL(url);
  } catch {
    // 400 = "bad request" (user's mistake)
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Save the long URL. $1 is a safe placeholder (prevents SQL injection).
  // RETURNING id gives us back the id Postgres just created.
  const { rows } = await pool.query(
    "INSERT INTO urls (long_url) VALUES ($1) RETURNING id",
    [url]
  );

  // Turn the id into a short code. +1000000 so codes aren't super tiny.
  const code = toBase62(Number(rows[0].id) + 1000000);

  // Save the code in that same row
  await pool.query("UPDATE urls SET code = $1 WHERE id = $2", [
    code,
    rows[0].id,
  ]);

  // Send the short link back to the user
  res.json({ short: `http://localhost:3000/${code}` });
});

// ROUTE 3: Use a short link. ":code" matches anything, like /4c93
app.get("/:code", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT long_url FROM urls WHERE code = $1",
    [req.params.code] // the value from the web address
  );

  // No matching row = link doesn't exist. 404 = "not found"
  if (rows.length === 0) {
    return res.status(404).send("Not found");
  }

  // 302 = temporary redirect: send the browser to the original URL
  res.redirect(302, rows[0].long_url);
});

// Start listening for requests on port 3000
app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
})