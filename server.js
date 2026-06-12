require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// URL routing: /join/:code serves the same index.html, code is read by JS
app.get('/join/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Pexels proxy ──────────────────────────────────────────────────────────
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
app.get('/api/pexels', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing query' });
  if (!PEXELS_API_KEY) return res.status(503).json({ error: 'no_key' });
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=6&orientation=landscape`;
  https.get(url, { headers: { Authorization: PEXELS_API_KEY } }, r => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.json({ photos: (json.photos||[]).map(p => ({ thumb: p.src.medium, full: p.src.large, alt: p.alt||'', photographer: p.photographer })) });
      } catch(e) { res.status(500).json({ error: 'parse_error' }); }
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

// ── Deezer proxy ──────────────────────────────────────────────────────────
app.get('/api/deezer-search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing query' });
  const url = `https://api.deezer.com/search/track?q=${encodeURIComponent(q)}&limit=10`;
  https.get(url, r => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.error) return res.status(500).json({ error: json.error.message });
        const tracks = (json.data||[]).map(t => ({
          id: t.id, title: t.title, artist: t.artist.name,
          album: t.album.title, cover: t.album.cover_small,
          previewUrl: t.preview || null, deezerUrl: t.link,
        }));
        res.json({ tracks });
      } catch(e) { res.status(500).json({ error: 'parse_error' }); }
    });
  }).on('error', e => res.status(500).json({ error: e.message }));
});

const lobbies = {};

function genCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (lobbies[code]);
  return code;
}

function getScoreboard(lobby) {
  return [...lobby.players].sort((a,b) => b.score - a.score)
    .map((p,i) => ({ rank:i+1, name:p.name, score:p.score }));
}

function normalize(s) {
  return s.toLowerCase().trim().replace(/[.,!?'"-]/g,'').replace(/\s+/g,' ');
}

function levenshtein(a, b) {
  const m=a.length, n=b.length;
  const dp=Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function fuzzyMatch(input, correctAnswers) {
  const norm=normalize(input);
  for(const ans of correctAnswers){
    const normAns=normalize(ans);
    if(norm===normAns) return {match:true,score:1.0};
    const maxDist=Math.max(1,Math.floor(normAns.length/4));
    const dist=levenshtein(norm,normAns);
    const similarity=1-dist/Math.max(norm.length,normAns.length);
    if(dist<=maxDist&&similarity>=0.75) return {match:true,score:similarity};
  }
  return {match:false,score:0};
}

io.on('connection', (socket) => {

  socket.on('host:create', ({ questions, settings }) => {
    const code = genCode();
    lobbies[code] = {
      hostId: socket.id, players: [], questions,
      settings: settings||{scoreboardMode:'always'},
      currentQ: 0, phase: 'lobby', timer: null,
      answeredCount: 0, openAnswers: {},
      musicPhase: false // true while waiting for host to start music
    };
    socket.join(code); socket.data.code=code; socket.data.role='host';
    socket.emit('host:created', { code });
  });

  socket.on('player:join', ({ code, name }) => {
    const lobby = lobbies[code];
    if(!lobby) return socket.emit('error','Lobby niet gevonden.');
    if(lobby.phase!=='lobby') return socket.emit('error','Quiz is al gestart.');
    if(lobby.players.find(p=>p.name===name)) return socket.emit('error','Naam al in gebruik.');
    lobby.players.push({
      id:socket.id, name, score:0, answered:false,
      lastAnswer:null, lastCorrect:null, lastPts:0,
      history:[] // [{qIndex, yourAnswer, correct, correctAnswer, pts}]
    });
    socket.join(code); socket.data.code=code; socket.data.role='player'; socket.data.name=name;
    socket.emit('player:joined',{name});
    io.to(code).emit('lobby:update',{players:lobby.players.map(p=>p.name)});
  });

  socket.on('host:start', () => {
    const lobby=lobbies[socket.data.code];
    if(!lobby||lobby.hostId!==socket.id) return;
    lobby.currentQ=0; startQuestion(socket.data.code);
  });

  // Host starts music playback → start the timer now
  socket.on('host:music_started', () => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.hostId!==socket.id) return;
    if(!lobby.musicPhase) return;
    lobby.musicPhase = false;
    const q=lobby.questions[lobby.currentQ];
    lobby.timeLeft = q.timeLimit||45;
    // Tell players: timer is starting, show input fields
    io.to(code).emit('music:timer_start', { timeLeft: lobby.timeLeft });
    lobby.timer=setInterval(()=>{
      lobby.timeLeft--;
      io.to(code).emit('question:tick',{timeLeft:lobby.timeLeft});
      if(lobby.timeLeft<=0){
        clearInterval(lobby.timer);
        lobby.phase='review';
        io.to(lobby.hostId).emit('host:timer_expired');
      }
    },1000);
  });

  socket.on('player:answer', ({ answerIndex }) => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.phase!=='question') return;
    const player=lobby.players.find(p=>p.id===socket.id);
    if(!player||player.answered) return;
    const q=lobby.questions[lobby.currentQ];
    if(q.type==='open'||q.type==='music') return;
    player.answered=true; player.lastAnswer=answerIndex;
    const correct=answerIndex===q.correct;
    const pts=correct?Math.max(500,lobby.timeLeft*100):0;
    player.score+=pts; player.lastPts=pts; player.lastCorrect=correct;
    player.history.push({
      qIndex:lobby.currentQ, yourAnswer:q.answers[answerIndex],
      correct, correctAnswer:q.answers[q.correct], pts
    });
    lobby.answeredCount++;
    socket.emit('player:feedback',{correct,pts,correctAnswer:q.correct,correctText:q.answers[q.correct]});
    io.to(lobby.hostId).emit('host:progress',{answered:lobby.answeredCount,total:lobby.players.length});
    if(lobby.answeredCount>=lobby.players.length){
      clearInterval(lobby.timer); endQuestion(code);
    }
  });

  socket.on('player:open_answer', ({ text }) => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.phase!=='question') return;
    const player=lobby.players.find(p=>p.id===socket.id);
    if(!player||player.answered) return;
    const q=lobby.questions[lobby.currentQ];
    if(q.type!=='open') return;
    player.answered=true; player.lastAnswer=text;
    const {match,score}=fuzzyMatch(text,q.correctAnswers||[]);
    player.lastCorrect=match;
    const pts=match?Math.max(500,lobby.timeLeft*100):0;
    player.score+=pts; player.lastPts=pts;
    lobby.answeredCount++;
    lobby.openAnswers[socket.id]={playerId:socket.id,name:player.name,text,autoCorrect:match,fuzzyScore:score};
    socket.emit('player:open_received',{text,autoCorrect:match});
    io.to(lobby.hostId).emit('host:open_answer',{playerId:socket.id,name:player.name,text,autoCorrect:match,fuzzyScore:score});
    io.to(lobby.hostId).emit('host:progress',{answered:lobby.answeredCount,total:lobby.players.length});
  });

  // Music question: player submits artist + title
  socket.on('player:music_answer', ({ artist, title }) => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.phase!=='question') return;
    const player=lobby.players.find(p=>p.id===socket.id);
    if(!player||player.answered) return;
    const q=lobby.questions[lobby.currentQ];
    if(q.type!=='music') return;
    player.answered=true;
    const artistMatch=fuzzyMatch(artist, [q.correctArtist||'']);
    const titleMatch=fuzzyMatch(title, [q.correctTitle||'']);
    player.lastAnswer=`${artist} / ${title}`;
    player.lastCorrect=false; // graded by host
    player.lastPts=0;
    lobby.answeredCount++;
    lobby.openAnswers[socket.id]={
      playerId:socket.id, name:player.name,
      artist, title, artistMatch, titleMatch,
      isMusic:true, graded:false
    };
    socket.emit('player:open_received',{text:`${artist} / ${title}`,autoCorrect:false});
    io.to(lobby.hostId).emit('host:music_answer',{
      playerId:socket.id, name:player.name,
      artist, title, artistMatch, titleMatch
    });
    io.to(lobby.hostId).emit('host:progress',{answered:lobby.answeredCount,total:lobby.players.length});
  });

  socket.on('host:grade', ({ playerId, correct, artistCorrect, titleCorrect }) => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.hostId!==socket.id) return;
    const player=lobby.players.find(p=>p.id===playerId);
    if(!player) return;
    const q=lobby.questions[lobby.currentQ];
    const wasCorrect=player.lastCorrect;

    let pts=0;
    if(q.type==='music'){
      // partial scoring: 250 per correct field
      if(artistCorrect) pts+=250;
      if(titleCorrect) pts+=250;
    } else {
      pts=correct?(Math.max(500,(lobby.timeLeft||0)*100)):0;
    }

    if(!wasCorrect&&pts>0){
      player.score+=pts; player.lastPts=pts; player.lastCorrect=pts===500||pts>0;
    } else if(wasCorrect&&!correct){
      player.score-=(player.lastPts||0); player.lastPts=0; player.lastCorrect=false;
    }

    // Save to history
    const ans=lobby.openAnswers[playerId];
    if(ans){
      let yourAnswer, correctAnswer;
      if(q.type==='music'){
        yourAnswer=`${ans.artist} / ${ans.title}`;
        correctAnswer=`${q.correctArtist} / ${q.correctTitle}`;
      } else {
        yourAnswer=ans.text;
        correctAnswer=(q.correctAnswers||[]).join(', ');
      }
      player.history.push({
        qIndex:lobby.currentQ, yourAnswer, correct:pts>0,
        correctAnswer, pts, artistCorrect, titleCorrect
      });
    }

    io.to(playerId).emit('player:grade_update',{correct:pts>0,pts,artistCorrect,titleCorrect});
    socket.emit('host:grade_ack',{playerId,correct:pts>0,pts});
  });

  socket.on('host:end_question', () => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.hostId!==socket.id) return;
    clearInterval(lobby.timer);
    lobby.phase='scores';
    endQuestion(code);
  });

  socket.on('host:scoreboard_decision', ({ show }) => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.hostId!==socket.id) return;
    const isLast=lobby.currentQ+1>=lobby.questions.length;
    if(show){
      io.to(code).emit('show:scoreboard',{scoreboard:getScoreboard(lobby),isLast,sub:'Tussenstand'});
    } else {
      lobby.currentQ++;
      if(lobby.currentQ>=lobby.questions.length) endQuiz(code); else startQuestion(code);
    }
  });

  socket.on('host:next', () => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.hostId!==socket.id) return;
    lobby.currentQ++;
    if(lobby.currentQ>=lobby.questions.length) endQuiz(code); else startQuestion(code);
  });

  socket.on('disconnect', () => {
    const code=socket.data.code;
    if(!code||!lobbies[code]) return;
    const lobby=lobbies[code];
    if(lobby.hostId===socket.id){
      io.to(code).emit('error','Host heeft de verbinding verbroken.');
      clearInterval(lobby.timer); delete lobbies[code];
    } else {
      lobby.players=lobby.players.filter(p=>p.id!==socket.id);
      io.to(code).emit('lobby:update',{players:lobby.players.map(p=>p.name)});
    }
  });
});

function startQuestion(code) {
  const lobby=lobbies[code];
  lobby.phase='question'; lobby.answeredCount=0; lobby.openAnswers={};
  lobby.players.forEach(p=>{p.answered=false;p.lastAnswer=null;p.lastCorrect=null;p.lastPts=0;});
  const q=lobby.questions[lobby.currentQ];
  const isMusic = q.type==='music';

  if(isMusic){
    // Music phase: timer does NOT start yet, host must press play
    lobby.musicPhase=true;
    lobby.timeLeft=q.timeLimit||45;
    io.to(code).emit('question:start',{
      index:lobby.currentQ, total:lobby.questions.length,
      text:q.text||'Raad het nummer! 🎵', type:'music',
      audio:q.audio||null, timeLeft:q.timeLimit||45,
      image:q.image||null,
      musicPhase:true
    });
  } else {
    lobby.musicPhase=false;
    lobby.timeLeft=q.timeLimit||15;
    io.to(code).emit('question:start',{
      index:lobby.currentQ, total:lobby.questions.length,
      text:q.text, type:q.type||'multiple', answers:q.answers||[],
      timeLeft:lobby.timeLeft,
      image:q.image||null,
      musicPhase:false
    });
    lobby.timer=setInterval(()=>{
      lobby.timeLeft--;
      io.to(code).emit('question:tick',{timeLeft:lobby.timeLeft});
      if(lobby.timeLeft<=0){
        clearInterval(lobby.timer);
        if(q.type==='open'){
          // Timer expired: signal host to start review, don't auto-advance
          lobby.phase='review';
          io.to(lobby.hostId).emit('host:timer_expired');
          io.to(code).emit('question:tick',{timeLeft:0});
        } else {
          endQuestion(code);
        }
      }
    },1000);
  }
}

function endQuestion(code) {
  const lobby=lobbies[code];
  lobby.phase='scores';
  const q=lobby.questions[lobby.currentQ];
  const isLast=lobby.currentQ+1>=lobby.questions.length;
  const mode=lobby.settings.scoreboardMode||'always';

  let correctText='';
  if(q.type==='open') correctText=(q.correctAnswers||[]).join(' / ');
  else if(q.type==='music') correctText=`${q.correctArtist} / ${q.correctTitle}`;
  else correctText=(q.answers||[])[q.correct];

  io.to(code).emit('question:end',{
    type:q.type||'multiple',
    correctAnswer:q.correct,
    correctText, isLast
  });

  if(mode==='always'||(mode==='end'&&isLast)){
    io.to(code).emit('show:scoreboard',{scoreboard:getScoreboard(lobby),isLast,sub:isLast?'Eindstand':'Tussenstand'});
  } else if(mode==='host'){
    io.to(lobby.hostId).emit('host:scoreboard_prompt',{scoreboard:getScoreboard(lobby),isLast});
    lobby.players.forEach(p=>io.to(p.id).emit('player:waiting_host'));
  } else {
    if(!isLast){ lobby.currentQ++; startQuestion(code); }
    else io.to(code).emit('show:scoreboard',{scoreboard:getScoreboard(lobby),isLast:true,sub:'Eindstand'});
  }
}

function endQuiz(code) {
  const lobby=lobbies[code]; lobby.phase='ended';
  const scoreboard=getScoreboard(lobby);
  // Send each player their own history
  lobby.players.forEach(p=>{
    const history=lobby.questions.map((q,i)=>{
      const h=p.history.find(x=>x.qIndex===i);
      let correctAnswer='';
      if(q.type==='open') correctAnswer=(q.correctAnswers||[]).join(' / ');
      else if(q.type==='music') correctAnswer=`${q.correctArtist} / ${q.correctTitle}`;
      else correctAnswer=(q.answers||[])[q.correct]||'';
      return {
        qIndex:i, text:q.text||'Raad het nummer! 🎵', type:q.type||'multiple',
        yourAnswer:h?h.yourAnswer:'—', correct:h?h.correct:false,
        correctAnswer, pts:h?h.pts:0
      };
    });
    io.to(p.id).emit('quiz:end',{scoreboard,history});
  });
  io.to(lobby.hostId).emit('quiz:end',{scoreboard,history:null});
  setTimeout(()=>delete lobbies[code],60000);
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`QuizBuzz v7 draait op http://localhost:${PORT}`));
