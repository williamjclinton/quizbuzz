const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// ── helpers ──────────────────────────────────────────────────────────────────
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
  if (a === c) return { match: 'exact', ok: true };
  const dist = levenshtein(a, c);
  const threshold = Math.max(1, Math.floor(c.length * 0.25));
  if (dist <= threshold) return { match: 'close', ok: true };
  if (dist <= threshold * 2) return { match: 'partial', ok: false };
  return { match: 'none', ok: false };
}

// ── state ─────────────────────────────────────────────────────────────────────
const rooms = {}; // code → room

function createRoom(hostId) {
  const code = makeCode();
  rooms[code] = {
    code,
    hostId,
    players: {}, // socketId → { name, score, answers: [] }
    quiz: null,
    current: -1,
    timer: null,
    phase: 'lobby', // lobby | question | review | scoreboard | end
    scoreboardMode: 'always', // always | host | end
    showFeedback: true,
    pendingGrades: {}, // qIdx → { socketId → { answer, result } }
  };
  return code;
}

function getScoreboard(room) {
  return Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ name: p.name, score: p.score, rank: i + 1 }));
}

// ── socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {

  // ── HOST: create quiz ──────────────────────────────────────────────────────
  socket.on('host:create', ({ quiz, scoreboardMode, showFeedback }) => {
    const code = createRoom(socket.id);
    const room = rooms[code];
    room.quiz = quiz;
    room.scoreboardMode = scoreboardMode || 'always';
    room.showFeedback = showFeedback !== false;
    socket.join(code);
    socket.emit('host:created', { code });
  });

  // ── PLAYER: join ──────────────────────────────────────────────────────────
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

  // ── HOST: start quiz ───────────────────────────────────────────────────────
  socket.on('host:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    sendQuestion(room, 0);
  });

  // ── HOST: next question ────────────────────────────────────────────────────
  socket.on('host:next', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const nextIdx = room.current + 1;
    if (nextIdx >= room.quiz.length) return endQuiz(room);
    sendQuestion(room, nextIdx);
  });

  // ── HOST: show scoreboard then next ───────────────────────────────────────
  socket.on('host:show_scoreboard', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    io.to(code).emit('scoreboard:show', {
      scoreboard: getScoreboard(room),
      isLast: room.current >= room.quiz.length - 1
    });
  });

  // ── HOST: skip scoreboard ──────────────────────────────────────────────────
  socket.on('host:skip_scoreboard', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const nextIdx = room.current + 1;
    if (nextIdx >= room.quiz.length) return endQuiz(room);
    sendQuestion(room, nextIdx);
  });

  // ── PLAYER: answer (multiple choice) ──────────────────────────────────────
  socket.on('player:answer', ({ code, answer, timeLeft }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'question') return;
    const q = room.quiz[room.current];
    if (q.type !== 'multiple') return;
    const player = room.players[socket.id];
    if (!player) return;
    // prevent double answer
    if (player.answers[room.current] !== undefined) return;

    const correct = answer === q.correctAnswer;
    const pts = correct ? Math.max(100, Math.round(500 * (timeLeft / q.timeLimit))) : 0;
    player.score += pts;
    player.answers[room.current] = { answer, correct, pts };

    socket.emit('player:answer_ack', {
      correct,
      pts,
      correctAnswer: correct ? null : q.correctAnswer,
      correctText: correct ? null : q.answers[q.correctAnswer],
      showFeedback: room.showFeedback
    });

    // Check if all players answered
    const answered = Object.values(room.players).filter(p => p.answers[room.current] !== undefined).length;
    if (answered >= Object.keys(room.players).length) {
      clearTimeout(room.timer);
      endQuestion(room);
    }
  });

  // ── PLAYER: open answer ────────────────────────────────────────────────────
  socket.on('player:open_answer', ({ code, answer }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'question') return;
    const q = room.quiz[room.current];
    if (q.type !== 'open') return;
    const player = room.players[socket.id];
    if (!player || player.answers[room.current] !== undefined) return;

    const result = fuzzyMatch(answer, q.correctAnswer);
    player.answers[room.current] = { answer, result, pts: 0 };
    socket.emit('player:open_received', { text: answer });

    // Store for host review
    if (!room.pendingGrades[room.current]) room.pendingGrades[room.current] = {};
    room.pendingGrades[room.current][socket.id] = {
      name: player.name,
      answer,
      result,
      graded: false
    };

    // Send updated review panel to host
    io.to(room.hostId).emit('host:review_update', {
      grades: Object.values(room.pendingGrades[room.current]).map(g => ({
        socketId: Object.entries(room.pendingGrades[room.current])
          .find(([, v]) => v === g)[0],
        ...g
      }))
    });
  });

  // ── HOST: grade open answer ────────────────────────────────────────────────
  socket.on('host:grade', ({ code, playerId, correct }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const player = room.players[playerId];
    if (!player) return;
    const q = room.quiz[room.current];
    const grade = room.pendingGrades[room.current]?.[playerId];
    if (!grade) return;

    grade.graded = true;
    grade.override = correct;

    if (correct) {
      const pts = 500;
      player.score += pts;
      player.answers[room.current].pts = pts;
      player.answers[room.current].correct = true;
    } else {
      player.answers[room.current].correct = false;
    }

    io.to(playerId).emit('player:grade_update', { correct, showFeedback: room.showFeedback });
  });

  // ── HOST: done reviewing open question ────────────────────────────────────
  socket.on('host:review_done', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    endQuestion(room);
  });

  // ── HOST: end question manually ───────────────────────────────────────────
  socket.on('host:end_question', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    clearTimeout(room.timer);
    if (room.quiz[room.current].type === 'open') {
      room.phase = 'review';
      io.to(room.hostId).emit('host:start_review');
    } else {
      endQuestion(room);
    }
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
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

// ── helpers ───────────────────────────────────────────────────────────────────
function sendQuestion(room, idx) {
  room.current = idx;
  room.phase = 'question';
  const q = room.quiz[idx];
  const isLast = idx === room.quiz.length - 1;

  // Build question packet (no correct answer sent to players)
  const base = {
    idx,
    total: room.quiz.length,
    text: q.text,
    type: q.type,
    timeLimit: q.timeLimit || (q.type === 'open' ? 30 : 15),
    isLast,
    image: q.image || null,
    audio: q.audio || null,
  };

  const hostPkt = { ...base, correctAnswer: q.correctAnswer, answers: q.answers };
  const playerPkt = { ...base, answers: q.type === 'multiple' ? q.answers : null };

  io.to(room.hostId).emit('question:start', hostPkt);
  Object.keys(room.players).forEach(pid => {
    io.to(pid).emit('question:start', playerPkt);
  });

  // Timer
  room.timer = setTimeout(() => {
    if (q.type === 'open') {
      room.phase = 'review';
      io.to(room.hostId).emit('host:start_review');
    } else {
      endQuestion(room);
    }
  }, base.timeLimit * 1000);
}

function endQuestion(room) {
  room.phase = 'scoreboard';
  const q = room.quiz[room.current];
  const isLast = room.current >= room.quiz.length - 1;
  const scoreboard = getScoreboard(room);

  const pkt = {
    type: q.type,
    correctAnswer: q.correctAnswer,
    correctText: q.type === 'multiple' ? q.answers[q.correctAnswer] : q.correctAnswer,
    scoreboard,
    isLast
  };

  io.to(room.code).emit('question:end', pkt);

  if (room.scoreboardMode === 'always') {
    io.to(room.code).emit('scoreboard:show', { scoreboard, isLast });
  } else if (room.scoreboardMode === 'host') {
    io.to(room.hostId).emit('host:scoreboard_decision', { scoreboard, isLast });
  }
  // 'end' → nothing shown yet
}

function endQuiz(room) {
  room.phase = 'end';
  const scoreboard = getScoreboard(room);

  // Build answer histories for players
  Object.entries(room.players).forEach(([pid, player]) => {
    const history = room.quiz.map((q, i) => {
      const ans = player.answers[i];
      return {
        text: q.text,
        yourAnswer: ans ? (q.type === 'multiple' ? q.answers[ans.answer] : ans.answer) : '—',
        correct: ans ? ans.correct : false,
        correctAnswer: q.type === 'multiple' ? q.answers[q.correctAnswer] : q.correctAnswer,
        pts: ans ? ans.pts : 0,
      };
    });
    io.to(pid).emit('quiz:end', { scoreboard, history });
  });

  io.to(room.hostId).emit('quiz:end', { scoreboard, history: null });
}

server.listen(PORT, () => console.log(`QuizBuzz v6 running on :${PORT}`));
