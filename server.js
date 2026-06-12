require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const SpotifyWebApi = require('spotify-web-api-node');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// ── Pexels API key — vul hier je eigen key in (gratis op pexels.com/api) ──
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';

app.use(express.static('public'));

// ── Pexels proxy route (key nooit zichtbaar in frontend) ──────────────────
app.get('/api/pexels', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing query' });
  if (!PEXELS_API_KEY) return res.status(503).json({ error: 'no_key' });

  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=6&orientation=landscape`;
  const options = { headers: { Authorization: PEXELS_API_KEY } };

  https.get(url, options, r => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        const photos = (json.photos || []).map(p => ({
          thumb: p.src.medium,
          full: p.src.large,
          alt: p.alt || '',
          photographer: p.photographer,
          pexels_url: p.url
        }));
        res.json({ photos });
      } catch(e) {
        res.status(500).json({ error: 'parse_error' });
      }
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

// ── Spotify preview search route ──────────────────────────────────────────
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const api = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
  });
  const data = await api.clientCredentialsGrant();
  spotifyToken = data.body['access_token'];
  spotifyTokenExpiry = Date.now() + (data.body['expires_in'] - 60) * 1000;
  return spotifyToken;
}

app.get('/api/spotify-search', async (req, res) => {
  const q = req.query.q;
  const artist = req.query.artist || '';
  if (!q) return res.status(400).json({ error: 'missing query' });
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET)
    return res.status(503).json({ error: 'no_key' });
  try {
    const token = await getSpotifyToken();
    const api = new SpotifyWebApi();
    api.setAccessToken(token);

    const query = artist ? `track:${q} artist:${artist}` : q;
    const result = await api.searchTracks(query, { limit: 10 });
    const tracks = result.body.tracks.items.map(t => ({
      name: `${t.name} - ${t.artists.map(a => a.name).join(', ')}`,
      spotifyUrl: t.external_urls.spotify,
      previewUrl: t.preview_url || null,
      albumName: t.album.name,
      releaseDate: t.album.release_date,
      popularity: t.popularity,
    }));
    res.json({ tracks });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────
function makeCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function levenshtein(a, b) {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function fuzzyMatch(answer, correct) {
  const a = answer.toLowerCase().trim();
  const c = correct.toLowerCase().trim();
  if (!c) return { match: 'exact', ok: true };
  if (a === c) return { match: 'exact', ok: true };
  const dist = levenshtein(a, c);
  const threshold = Math.max(1, Math.floor(c.length * 0.25));
  if (dist <= threshold) return { match: 'close', ok: true };
  if (dist <= threshold * 2) return { match: 'partial', ok: false };
  return { match: 'none', ok: false };
}

// ── state ─────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(hostId) {
  const code = makeCode();
  rooms[code] = {
    code, hostId,
    players: {},      // socketId → { name, score, answers: [] }
    quiz: null,
    current: -1,
    timer: null,
    phase: 'lobby',
    scoreboardMode: 'always',
    showFeedback: true,
    pendingGrades: {},
  };
  return code;
}

function getScoreboard(room) {
  return Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ name: p.name, score: p.score, rank: i + 1 }));
}

// ── socket ────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('host:create', ({ quiz, scoreboardMode, showFeedback }) => {
    const code = createRoom(socket.id);
    const room = rooms[code];
    room.quiz = quiz;
    room.scoreboardMode = scoreboardMode || 'always';
    room.showFeedback = showFeedback !== false;
    socket.join(code);
    socket.emit('host:created', { code });
  });

  socket.on('player:join', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Kamer niet gevonden.');
    if (room.phase !== 'lobby') return socket.emit('error', 'Quiz is al begonnen.');
    if (Object.values(room.players).some(p => p.name === name))
      return socket.emit('error', 'Naam al in gebruik.');
    room.players[socket.id] = { name, score: 0, answers: [] };
    socket.join(code);
    socket.emit('player:joined', { name });
    io.to(code).emit('lobby:update', {
      players: Object.values(room.players).map(p => p.name)
    });
  });

  socket.on('host:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    sendQuestion(room, 0);
  });

  socket.on('host:next', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const nextIdx = room.current + 1;
    if (nextIdx >= room.quiz.length) return endQuiz(room);
    sendQuestion(room, nextIdx);
  });

  socket.on('host:show_scoreboard', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    io.to(code).emit('scoreboard:show', {
      scoreboard: getScoreboard(room),
      isLast: room.current >= room.quiz.length - 1
    });
  });

  socket.on('host:skip_scoreboard', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const nextIdx = room.current + 1;
    if (nextIdx >= room.quiz.length) return endQuiz(room);
    sendQuestion(room, nextIdx);
  });

  // ── Multiple choice answer ──────────────────────────────────────────────
  socket.on('player:answer', ({ code, answer, timeLeft }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'question') return;
    const q = room.quiz[room.current];
    if (q.type !== 'multiple') return;
    const player = room.players[socket.id];
    if (!player || player.answers[room.current] !== undefined) return;

    const correct = answer === q.correctAnswer;
    const pts = correct ? Math.max(100, Math.round(500 * (timeLeft / q.timeLimit))) : 0;
    player.score += pts;
    player.answers[room.current] = { answer, correct, pts };

    socket.emit('player:answer_ack', {
      correct, pts,
      correctAnswer: correct ? null : q.correctAnswer,
      correctText: correct ? null : q.answers[q.correctAnswer],
      showFeedback: room.showFeedback
    });

    const answered = Object.values(room.players)
      .filter(p => p.answers[room.current] !== undefined).length;
    if (answered >= Object.keys(room.players).length) {
      clearTimeout(room.timer);
      endQuestion(room);
    }
  });

  // ── Open answer ─────────────────────────────────────────────────────────
  socket.on('player:open_answer', ({ code, answer }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'question') return;
    const q = room.quiz[room.current];
    if (q.type !== 'open') return;
    const player = room.players[socket.id];
    if (!player || player.answers[room.current] !== undefined) return;

    const result = fuzzyMatch(answer, q.correctAnswer);
    player.answers[room.current] = { answer, result, pts: 0 };
    socket.emit('player:open_received', {});

    if (!room.pendingGrades[room.current]) room.pendingGrades[room.current] = {};
    room.pendingGrades[room.current][socket.id] = { name: player.name, answer, result, graded: false };

    emitReviewUpdate(room);
  });

  // ── Music answer (artiest + titel) ──────────────────────────────────────
  socket.on('player:music_answer', ({ code, artist, title }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'question') return;
    const q = room.quiz[room.current];
    if (q.type !== 'music') return;
    const player = room.players[socket.id];
    if (!player || player.answers[room.current] !== undefined) return;

    const artistResult = fuzzyMatch(artist, q.correctArtist);
    const titleResult  = fuzzyMatch(title,  q.correctTitle);

    player.answers[room.current] = { artist, title, artistResult, titleResult, pts: 0 };
    socket.emit('player:open_received', {});

    if (!room.pendingGrades[room.current]) room.pendingGrades[room.current] = {};
    room.pendingGrades[room.current][socket.id] = {
      name: player.name, artist, title, artistResult, titleResult, graded: false, isMusic: true
    };

    emitReviewUpdate(room);
  });

  // ── Grade ───────────────────────────────────────────────────────────────
  socket.on('host:grade', ({ code, playerId, correct, pts }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const player = room.players[playerId];
    if (!player) return;
    const grade = room.pendingGrades[room.current]?.[playerId];
    if (!grade) return;

    grade.graded = true;
    const awarded = correct ? (pts !== undefined ? pts : 500) : 0;
    player.score += awarded;
    player.answers[room.current].pts = awarded;
    player.answers[room.current].correct = correct;

    io.to(playerId).emit('player:grade_update', { correct, pts: awarded, showFeedback: room.showFeedback });
  });

  socket.on('host:review_done', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    endQuestion(room);
  });

  // ── Host signals music has stopped → start timer now ───────────────────
  socket.on('host:music_done', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'music_playing') return;
    const q = room.quiz[room.current];
    const timeLimit = q.timeLimit || (q.type === 'open' ? 30 : q.type === 'music' ? 45 : 15);
    room.phase = 'question';
    // Tell everyone the timer is now starting
    io.to(room.code).emit('question:timer_start', { timeLimit });
    room.timer = setTimeout(() => {
      const t = room.quiz[room.current].type;
      if (t === 'open' || t === 'music') {
        room.phase = 'review';
        io.to(room.hostId).emit('host:start_review');
      } else {
        endQuestion(room);
      }
    }, timeLimit * 1000);
  });

  socket.on('host:end_question', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    clearTimeout(room.timer);
    const type = room.quiz[room.current].type;
    if (type === 'open' || type === 'music') {
      room.phase = 'review';
      io.to(room.hostId).emit('host:start_review');
    } else {
      endQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (room.hostId === socket.id) {
        io.to(code).emit('error', 'Host heeft de verbinding verbroken.');
        delete rooms[code];
      } else if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(code).emit('lobby:update', {
          players: Object.values(room.players).map(p => p.name)
        });
      }
    }
  });
});

function emitReviewUpdate(room) {
  const grades = Object.entries(room.pendingGrades[room.current] || {}).map(([sid, g]) => ({
    socketId: sid, ...g
  }));
  io.to(room.hostId).emit('host:review_update', { grades });
}

function startQuestionTimer(room, timeLimit) {
  room.timer = setTimeout(() => {
    const t = room.quiz[room.current].type;
    if (t === 'open' || t === 'music') {
      room.phase = 'review';
      io.to(room.hostId).emit('host:start_review');
    } else {
      endQuestion(room);
    }
  }, timeLimit * 1000);
}

function sendQuestion(room, idx) {
  room.current = idx;
  const q = room.quiz[idx];
  const isLast = idx === room.quiz.length - 1;
  const timeLimit = q.timeLimit || (q.type === 'open' ? 30 : q.type === 'music' ? 45 : 15);
  const hasAudio = !!q.audio;

  // If audio present: hold in music_playing phase; timer starts only after host:music_done
  room.phase = hasAudio ? 'music_playing' : 'question';

  const base = { idx, total: room.quiz.length, text: q.text, type: q.type, timeLimit, isLast,
                 image: q.image || null, hasAudio };
  const hostPkt   = { ...base, audio: q.audio || null,
                      correctAnswer: q.correctAnswer, correctArtist: q.correctArtist,
                      correctTitle: q.correctTitle, answers: q.answers };
  const playerPkt = { ...base, audio: null,
                      answers: q.type === 'multiple' ? q.answers : null };

  io.to(room.hostId).emit('question:start', hostPkt);
  Object.keys(room.players).forEach(pid => io.to(pid).emit('question:start', playerPkt));

  if (!hasAudio) startQuestionTimer(room, timeLimit);
  // With audio: timer starts when host fires host:music_done
}

function endQuestion(room) {
  room.phase = 'scoreboard';
  const q = room.quiz[room.current];
  const isLast = room.current >= room.quiz.length - 1;
  const scoreboard = getScoreboard(room);

  io.to(room.code).emit('question:end', {
    type: q.type,
    correctAnswer: q.correctAnswer,
    correctText: q.type === 'multiple' ? q.answers[q.correctAnswer] : q.correctAnswer,
    correctArtist: q.correctArtist,
    correctTitle: q.correctTitle,
    scoreboard, isLast
  });

  if (room.scoreboardMode === 'always') {
    io.to(room.code).emit('scoreboard:show', { scoreboard, isLast });
  } else if (room.scoreboardMode === 'host') {
    io.to(room.hostId).emit('host:scoreboard_decision', { scoreboard, isLast });
  }
}

function endQuiz(room) {
  room.phase = 'end';
  const scoreboard = getScoreboard(room);

  Object.entries(room.players).forEach(([pid, player]) => {
    const history = room.quiz.map((q, i) => {
      const ans = player.answers[i];
      let yourAnswer = '—';
      let correctAnswer = '';
      if (q.type === 'multiple') {
        yourAnswer = ans ? q.answers[ans.answer] : '—';
        correctAnswer = q.answers[q.correctAnswer];
      } else if (q.type === 'music') {
        yourAnswer = ans ? `${ans.artist} / ${ans.title}` : '—';
        correctAnswer = `${q.correctArtist} / ${q.correctTitle}`;
      } else {
        yourAnswer = ans ? ans.answer : '—';
        correctAnswer = q.correctAnswer;
      }
      return { text: q.text, yourAnswer, correct: ans?.correct || false, correctAnswer, pts: ans?.pts || 0 };
    });
    io.to(pid).emit('quiz:end', { scoreboard, history });
  });

  io.to(room.hostId).emit('quiz:end', { scoreboard, history: null });
}

server.listen(PORT, () => console.log(`QuizBuzz v6.2 running on :${PORT}`));
