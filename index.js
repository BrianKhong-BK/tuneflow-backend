let express = require("express");
let path = require("path");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const YoutubeMusicApi = require("youtube-music-api");
const stringSimilarity = require("string-similarity");
require("dotenv").config();

const { Pool } = require("pg");
const { DATABASE_URL, SECRET_KEY } = process.env;

let app = express();
app.use(cors());
app.use(express.json());

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;

let spotifyToken = null;

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

// 🔁 Refresh Spotify Token
async function refreshSpotifyToken() {
  const authString = Buffer.from(`${client_id}:${client_secret}`).toString(
    "base64"
  );

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authString}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  const data = await response.json();
  spotifyToken = data.access_token;
  console.log("✅ Spotify token refreshed");
}

refreshSpotifyToken();
setInterval(refreshSpotifyToken, 55 * 60 * 1000);

// ✅ Normalize utility
function normalize(text) {
  return text
    .replace(/\((\s*prod\.|feat\.|ft\.).*?\)/i, "")
    .replace(/[\[\]\(\)]/g, "")
    .toLowerCase()
    .trim();
}

// ✅ Spotify Search
app.get("/api/spotify-search", async (req, res) => {
  const query = req.query.q;
  const offset = parseInt(req.query.offset) || 0;

  if (!query) return res.status(400).json({ error: "Missing query" });

  const searchURL = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
    query
  )}&type=track&limit=30&offset=${offset}`;

  try {
    const response = await fetch(searchURL, {
      headers: { Authorization: `Bearer ${spotifyToken}` },
    });

    const data = await response.json();

    if (!data.tracks?.items || data.tracks.items.length === 0) {
      return res.status(404).json({ error: "No results found" });
    }

    const results = data.tracks.items.map((item) => ({
      id: item.id,
      title: item.name,
      cover: item.album.images[2]?.url || item.album.images[0]?.url || "",
      artist: item.artists.map((artist) => artist.name).join(", "),
    }));

    res.json({
      items: results,
      nextOffset: offset + 30,
      hasNextPage: data.tracks.next !== null,
    });
  } catch (err) {
    console.error("❌ Spotify search failed:", err);
    res.status(500).json({ error: "Spotify search failed" });
  }
});

function parseInput(input) {
  const parts = input.split(" : ");
  return {
    song: parts[0],
    artist: parts[1],
  };
}

// ✅ YouTube Music API Search
app.get("/api/youtube-search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query" });

  const spotifyInput = parseInput(query);

  const api = new YoutubeMusicApi();

  try {
    await api.initalize();
    const response = await api.search(
      `${normalize(spotifyInput.song)} ${spotifyInput.artist}`,
      "song"
    );
    const results = response.content;

    const scoredResults = results
      .map((track) => {
        const videoId = track.videoId;
        const name = track.name;
        const artist =
          track.artist.length === 0
            ? track.album.name
            : Array.isArray(track.artist)
            ? track.artist.map((a) => a.name).toString()
            : track.artist.name;
        const thumbnails = track.thumbnails[0].url;

        const score = calculateMatchScore(track, spotifyInput);
        return {
          videoId,
          name,
          artist,
          thumbnails,
          score,
        };
      })
      .sort((a, b) => b.score - a.score);

    res.json({ results: scoredResults });
  } catch (err) {
    console.error("❌ YouTube Music API failed:", err);
    res.status(500).json({ error: "YouTube search failed" });
  }
});

// --- Scoring Logic ---
function calculateMatchScore(youtubeTrack, spotifyInput) {
  let score = 0;

  // 1. Title Match (Case-Insensitive)
  const youtubeTitle = normalize(youtubeTrack.name);
  const youtubeArtist =
    youtubeTrack.artist.length === 0
      ? youtubeTrack.album.name
      : Array.isArray(youtubeTrack.artist)
      ? youtubeTrack.artist.map((a) => a.name).toString()
      : youtubeTrack.artist.name;
  const spotifyTitle = normalize(spotifyInput.song);
  const spotifyArtist = spotifyInput.artist;

  if (youtubeTitle === spotifyTitle) score += 20;
  if (youtubeArtist === spotifyArtist) score += 15;

  spotifyTitle.split(" ").forEach((word) => {
    if (youtubeTitle.includes(word)) score += 5;
    else score -= 5;
  });

  spotifyArtist.split(",").forEach((word) => {
    if (youtubeArtist.includes(word)) score += 4;
    else score -= 4;
  });

  youtubeTitle.split(" ").forEach((word) => {
    if (spotifyTitle.includes(word)) score += 5;
    else score -= 5;
  });

  youtubeArtist.split(",").forEach((word) => {
    if (spotifyArtist.includes(word)) score += 4;
    else score -= 4;
  });

  const titleSimilarity = stringSimilarity.compareTwoStrings(
    youtubeTitle,
    spotifyTitle
  );
  const artistSimilarity = stringSimilarity.compareTwoStrings(
    youtubeArtist,
    spotifyArtist
  );

  if (titleSimilarity > 0.8) score += 15;
  else score -= 15;

  if (artistSimilarity > 0.8) score += 10;
  else score -= 10;

  return score;
}

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

app.get("/api/playlists/:id/songs", async (req, res) => {
  const playlistId = req.params.id;

  const client = await pool.connect();
  try {
    const response = await client.query(
      `SELECT * FROM playlist_songs WHERE playlist_id = $1`,
      [playlistId]
    );
    res.json(response.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete("/api/playlists/:playlistid/songs/:songid", async (req, res) => {
  const playlistId = req.params.playlistid;
  const songId = req.params.songid;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `DELETE FROM playlist_songs WHERE playlist_id = $1 AND id = $2`,
      [playlistId, songId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Song not found in playlist" });
    }

    res.status(200).json({ message: "Song removed from playlist" });
  } catch (err) {
    console.error("Error deleting song:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
