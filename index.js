let express = require("express");
let path = require("path");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
require("dotenv").config();

const { Pool } = require("pg");
const { DATABASE_URL, SECRET_KEY } = process.env;

let app = express();
app.use(cors());
app.use(express.json());

// ✅ Fix: rejectUnauthorized = false for Supabase
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Test the connection
async function getPostgresVersion() {
  const client = await pool.connect();
  try {
    const response = await client.query("SELECT version()");
    console.log("✅ Connected to Supabase:", response.rows[0]);
  } catch (err) {
    console.error("❌ Connection failed:", err);
  } finally {
    client.release();
  }
}

getPostgresVersion();

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware to verify Firebase token
app.use(async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).send("No token");
  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // contains uid, email, etc.
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
});

// Example route: create playlist
app.post("/api/playlists", async (req, res) => {
  const { name, is_public, description } = req.body;
  const userId = req.user.uid;
  const email = req.user.email;
  const userName = req.user.name;
  const client = await pool.connect();

  // Ensure user exists in your DB
  try {
    await client.query(
      `INSERT INTO users (id, email, username)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
      [userId, email, userName]
    );

    const result = await client.query(
      `INSERT INTO playlists (user_id, name, is_public, description)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
      [userId, name, is_public, description]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get("/api/playlists", async (req, res) => {
  const userId = req.user.uid;
  const client = await pool.connect();

  try {
    const response = await client.query(
      "SELECT * FROM playlists WHERE user_id = $1",
      [userId]
    );

    res.json(response.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/playlists/:id/songs", async (req, res) => {
  const playlistId = req.params.id;
  const { title, artist, youtubeId, thumbnail } = req.body;

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO playlist_songs (playlist_id, title, artist, youtube_id, thumbnail)
       VALUES ($1, $2, $3, $4, $5)`,
      [playlistId, title, artist, youtubeId, thumbnail]
    );
    res.status(201).json({ message: "Song added to playlist" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
