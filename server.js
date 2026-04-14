const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

// SSE clients for live updates
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ─── SSE endpoint ────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Get all players with team info ──────────────────────────────────────────
app.get('/api/players', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.strokes_day1, p.strokes_day2, t.name as team_name, t.id as team_id
      FROM players p JOIN teams t ON p.team_id = t.id
      ORDER BY t.id, p.name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get courses ─────────────────────────────────────────────────────────────
app.get('/api/courses', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, json_agg(h ORDER BY h.hole_number) as holes
      FROM courses c JOIN holes h ON h.course_id = c.id
      GROUP BY c.id ORDER BY c.day
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get tee times for a day ──────────────────────────────────────────────────
app.get('/api/tee-times/:day', async (req, res) => {
  try {
    const { day } = req.params;
    const ttResult = await pool.query(
      'SELECT * FROM tee_times WHERE day=$1 ORDER BY id', [day]
    );
    const teeTimes = ttResult.rows;

    for (const tt of teeTimes) {
      const players = await pool.query(`
        SELECT p.id, p.name, t.name as team_name
        FROM tee_time_players ttp
        JOIN players p ON p.id = ttp.player_id
        JOIN teams t ON t.id = p.team_id
        WHERE ttp.tee_time_id = $1
      `, [tt.id]);
      tt.players = players.rows;
    }

    res.json(teeTimes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create tee times for a day ───────────────────────────────────────────────
app.post('/api/tee-times', async (req, res) => {
  try {
    const { day } = req.body;
    // Delete existing tee times for this day
    await pool.query('DELETE FROM tee_times WHERE day=$1', [day]);

    const created = [];
    for (let i = 1; i <= 4; i++) {
      const token = crypto.randomBytes(6).toString('hex');
      const result = await pool.query(
        'INSERT INTO tee_times (day, label, unique_token) VALUES ($1,$2,$3) RETURNING *',
        [day, `Tee Time ${i}`, token]
      );
      created.push(result.rows[0]);
    }
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Assign players to a tee time ────────────────────────────────────────────
app.post('/api/tee-times/:id/players', async (req, res) => {
  try {
    const { id } = req.params;
    const { player_ids } = req.body;

    await pool.query('DELETE FROM tee_time_players WHERE tee_time_id=$1', [id]);
    for (const pid of player_ids) {
      await pool.query(
        'INSERT INTO tee_time_players (tee_time_id, player_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, pid]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get tee time by token ────────────────────────────────────────────────────
app.get('/api/tee-time/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const ttResult = await pool.query(
      'SELECT * FROM tee_times WHERE unique_token=$1', [token]
    );
    if (!ttResult.rows.length) return res.status(404).json({ error: 'Not found' });

    const tt = ttResult.rows[0];
    const players = await pool.query(`
      SELECT p.id, p.name, p.strokes_day1, p.strokes_day2, t.name as team_name
      FROM tee_time_players ttp
      JOIN players p ON p.id = ttp.player_id
      JOIN teams t ON t.id = p.team_id
      WHERE ttp.tee_time_id = $1
    `, [tt.id]);
    tt.players = players.rows;

    const course = await pool.query(`
      SELECT c.*, json_agg(h ORDER BY h.hole_number) as holes
      FROM courses c JOIN holes h ON h.course_id = c.id
      WHERE c.day = $1
      GROUP BY c.id
    `, [tt.day]);
    tt.course = course.rows[0];

    // Get existing scores for these players
    if (tt.players.length) {
      const playerIds = tt.players.map(p => p.id);
      const scores = await pool.query(`
        SELECT s.*, h.hole_number
        FROM scores s
        JOIN holes h ON h.id = s.hole_id
        WHERE s.player_id = ANY($1) AND s.day = $2
      `, [playerIds, tt.day]);
      tt.scores = scores.rows;
    } else {
      tt.scores = [];
    }

    res.json(tt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Submit scores for a hole ─────────────────────────────────────────────────
app.post('/api/scores', async (req, res) => {
  try {
    const { day, hole_id, entries } = req.body;
    // entries = [{ player_id, gross_strokes }]

    // Get hole par and stroke_index
    const holeResult = await pool.query('SELECT * FROM holes WHERE id=$1', [hole_id]);
    const hole = holeResult.rows[0];

    for (const entry of entries) {
      if (entry.gross_strokes === null || entry.gross_strokes === undefined) continue;

      // Get player strokes for this day
      const playerResult = await pool.query('SELECT * FROM players WHERE id=$1', [entry.player_id]);
      const player = playerResult.rows[0];
      const totalStrokes = day === 1 ? player.strokes_day1 : player.strokes_day2;

      // Calculate strokes received on this hole
      const strokesOnHole = calcStrokesOnHole(totalStrokes, hole.stroke_index);
      const net = entry.gross_strokes - strokesOnHole;
      const diff = net - hole.par;
      const points = calcStableford(diff, entry.gross_strokes, hole.par, strokesOnHole);

      await pool.query(`
        INSERT INTO scores (player_id, hole_id, day, gross_strokes, net_strokes, stableford_points)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (player_id, hole_id, day)
        DO UPDATE SET gross_strokes=$4, net_strokes=$5, stableford_points=$6, updated_at=NOW()
      `, [entry.player_id, hole_id, day, entry.gross_strokes, net, points]);
    }

    // Broadcast update
    const leaderboard = await getLeaderboard();
    broadcast({ type: 'score_update', leaderboard });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get leaderboard ──────────────────────────────────────────────────────────
app.get('/api/leaderboard/:day', async (req, res) => {
  try {
    const { day } = req.params;
    const data = await getLeaderboard(parseInt(day));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const data = await getLeaderboard();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getLeaderboard(day = null) {
  const dayFilter = day ? 'AND s.day = $1' : '';
  const params = day ? [day] : [];

  const result = await pool.query(`
    SELECT
      t.id as team_id,
      t.name as team_name,
      p.id as player_id,
      p.name as player_name,
      s.day,
      h.hole_number,
      s.gross_strokes,
      s.net_strokes,
      s.stableford_points
    FROM teams t
    JOIN players p ON p.team_id = t.id
    LEFT JOIN scores s ON s.player_id = p.id ${dayFilter}
    LEFT JOIN holes h ON h.id = s.hole_id
    ORDER BY t.id, p.name, s.day, h.hole_number
  `, params);

  // Structure by team
  const teams = {};
  for (const row of result.rows) {
    if (!teams[row.team_id]) {
      teams[row.team_id] = {
        team_id: row.team_id,
        team_name: row.team_name,
        total_points: 0,
        day1_points: 0,
        day2_points: 0,
        players: {}
      };
    }
    if (!teams[row.team_id].players[row.player_id]) {
      teams[row.team_id].players[row.player_id] = {
        player_id: row.player_id,
        player_name: row.player_name,
        total_points: 0,
        day1_points: 0,
        day2_points: 0,
        holes: []
      };
    }
    if (row.stableford_points !== null) {
      const pts = row.stableford_points;
      teams[row.team_id].total_points += pts;
      teams[row.team_id].players[row.player_id].total_points += pts;
      if (row.day === 1) {
        teams[row.team_id].day1_points += pts;
        teams[row.team_id].players[row.player_id].day1_points += pts;
      } else {
        teams[row.team_id].day2_points += pts;
        teams[row.team_id].players[row.player_id].day2_points += pts;
      }
      teams[row.team_id].players[row.player_id].holes.push({
        hole_number: row.hole_number,
        day: row.day,
        gross: row.gross_strokes,
        net: row.net_strokes,
        points: pts
      });
    }
  }

  // Convert players obj to array
  for (const t of Object.values(teams)) {
    t.players = Object.values(t.players);
  }

  return Object.values(teams);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcStrokesOnHole(totalStrokes, strokeIndex) {
  // Base stroke: everyone with strokes >= strokeIndex gets 1
  // Extra stroke: if totalStrokes > 18, extra goes to hardest holes first
  let strokes = 0;
  if (totalStrokes >= strokeIndex) strokes = 1;
  const extra = totalStrokes - 18;
  if (extra > 0 && strokeIndex <= extra) strokes = 2;
  return strokes;
}

function calcStableford(diffFromPar, grossStrokes, par, strokesReceived) {
  // Check for hole in one (gross 1 on any hole)
  if (grossStrokes === 1) return 10;

  // Points based on NET score vs par
  if (diffFromPar <= -3) return 5; // albatross or better
  if (diffFromPar === -2) return 4; // eagle
  if (diffFromPar === -1) return 3; // birdie
  if (diffFromPar === 0)  return 2; // par
  if (diffFromPar === 1)  return 1; // bogey
  return 0; // double bogey or worse
}

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/score/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Golf app running on port ${PORT}`));
