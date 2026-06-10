const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const lobbies = {};

function genCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (lobbies[code]);
  return code;
}

function getScoreboard(lobby) {
  return [...lobby.players].sort((a,b) => b.score-a.score).map((p,i) => ({ rank:i+1, name:p.name, score:p.score }));
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
    const sim=1-dist/Math.max(norm.length,normAns.length);
    if(dist<=maxDist&&sim>=0.75) return {match:true,score:sim};
  }
  return {match:false,score:0};
}

io.on('connection', (socket) => {

  socket.on('host:create', ({ questions, settings }) => {
    const code = genCode();
    lobbies[code] = {
      hostId:socket.id, players:[], questions,
      settings: settings||{scoreboardMode:'always', showFeedback:true},
      currentQ:0, phase:'lobby', timer:null, answeredCount:0, openAnswers:{}
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
      id:socket.id, name, score:0,
      answered:false, lastAnswer:null, lastCorrect:null, lastPts:0,
      history:[] // {qIndex, qText, playerAnswer, correctAnswer, correct}
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

  socket.on('player:answer', ({ answerIndex }) => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.phase!=='question') return;
    const player=lobby.players.find(p=>p.id===socket.id);
    if(!player||player.answered) return;
    const q=lobby.questions[lobby.currentQ];
    if(q.type==='open') return;
    player.answered=true; player.lastAnswer=answerIndex;
    const correct=answerIndex===q.correct;
    const pts=correct?Math.max(500,lobby.timeLeft*100):0;
    player.score+=pts; player.lastPts=pts; player.lastCorrect=correct;
    lobby.answeredCount++;
    // Store history
    player.history.push({
      qIndex:lobby.currentQ, qText:q.text, type:'multiple',
      playerAnswer:q.answers[answerIndex], correctAnswer:q.answers[q.correct], correct
    });
    const showFeedback=lobby.settings.showFeedback!==false;
    socket.emit('player:feedback',{
      correct, pts,
      correctAnswer: showFeedback?q.correct:null,
      correctText: showFeedback?q.answers[q.correct]:null,
      showFeedback
    });
    io.to(lobby.hostId).emit('host:progress',{answered:lobby.answeredCount,total:lobby.players.length});
    if(lobby.answeredCount>=lobby.players.length){ clearInterval(lobby.timer); endQuestion(code); }
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
    // Store history (correct answer set after grading, pre-fill now)
    player.history.push({
      qIndex:lobby.currentQ, qText:q.text, type:'open',
      playerAnswer:text, correctAnswer:(q.correctAnswers||[]).join(' / '), correct:match
    });
    lobby.openAnswers[socket.id]={playerId:socket.id,name:player.name,text,autoCorrect:match,fuzzyScore:score};
    socket.emit('player:open_received',{text,autoCorrect:match,showFeedback:lobby.settings.showFeedback!==false});
    io.to(lobby.hostId).emit('host:open_answer',{playerId:socket.id,name:player.name,text,autoCorrect:match,fuzzyScore:score});
    io.to(lobby.hostId).emit('host:progress',{answered:lobby.answeredCount,total:lobby.players.length});
  });

  socket.on('host:grade', ({ playerId, correct }) => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.hostId!==socket.id) return;
    const player=lobby.players.find(p=>p.id===playerId);
    if(!player) return;
    const wasCorrect=player.lastCorrect;
    if(correct&&!wasCorrect){
      const pts=Math.max(500,(lobby.timeLeft||0)*100);
      player.score+=pts; player.lastPts=pts; player.lastCorrect=true;
    } else if(!correct&&wasCorrect){
      player.score-=(player.lastPts||0); player.lastPts=0; player.lastCorrect=false;
    }
    // Update history
    const h=player.history[player.history.length-1];
    if(h) h.correct=correct;
    const showFeedback=lobby.settings.showFeedback!==false;
    io.to(playerId).emit('player:grade_update',{correct,showFeedback});
    socket.emit('host:grade_ack',{playerId,correct});
  });

  socket.on('host:end_question', () => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby||lobby.hostId!==socket.id) return;
    clearInterval(lobby.timer); endQuestion(code);
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

  // Player requests their own history
  socket.on('player:get_history', () => {
    const code=socket.data.code; const lobby=lobbies[code];
    if(!lobby) return;
    const player=lobby.players.find(p=>p.id===socket.id);
    if(!player) return;
    socket.emit('player:history',{history:player.history,name:player.name,score:player.score});
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
  lobby.timeLeft=q.timeLimit||15;
  io.to(code).emit('question:start',{
    index:lobby.currentQ,total:lobby.questions.length,
    text:q.text,type:q.type||'multiple',answers:q.answers||[],
    youtubeId:q.youtubeId||null,timeLeft:lobby.timeLeft
  });
  lobby.timer=setInterval(()=>{
    lobby.timeLeft--;
    io.to(code).emit('question:tick',{timeLeft:lobby.timeLeft,maxTime:q.timeLimit||15});
    if(lobby.timeLeft<=0){clearInterval(lobby.timer);endQuestion(code);}
  },1000);
}

function endQuestion(code) {
  const lobby=lobbies[code]; lobby.phase='scores';
  const q=lobby.questions[lobby.currentQ];
  const isLast=lobby.currentQ+1>=lobby.questions.length;
  const mode=lobby.settings.scoreboardMode||'always';
  io.to(code).emit('question:end',{
    type:q.type||'multiple',correctAnswer:q.correct,
    correctText:q.type==='open'?(q.correctAnswers||[]).join(' / '):(q.answers||[])[q.correct],
    isLast
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
  // Send each player their personal history token
  lobby.players.forEach(p=>{
    io.to(p.id).emit('quiz:end',{
      scoreboard:getScoreboard(lobby),
      history:p.history, name:p.name, score:p.score
    });
  });
  io.to(lobby.hostId).emit('quiz:end',{scoreboard:getScoreboard(lobby),history:null});
  setTimeout(()=>delete lobbies[code],60000);
}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`QuizBuzz draait op http://localhost:${PORT}`));
