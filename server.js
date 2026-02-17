const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// --- HTTP server to serve HTML files ---
const httpServer = http.createServer((req, res) => {
  let filePath;
  if (req.url === '/' || req.url === '/speaker') {
    filePath = path.join(__dirname, 'speaker.html');
  } else if (req.url === '/viewer') {
    filePath = path.join(__dirname, 'viewer.html');
  } else {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

// --- WebSocket server for internal relay ---
const wss = new WebSocket.Server({ server: httpServer });

let openaiWs = null;
let speakerSocket = null;
const viewers = new Set();
const conversationItemIds = [];

wss.on('connection', (clientWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');

  if (role === 'speaker') {
    handleSpeaker(clientWs);
  } else {
    handleViewer(clientWs);
  }
});

function handleSpeaker(clientWs) {
  if (speakerSocket) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'A speaker is already connected.' }));
    clientWs.close();
    return;
  }

  speakerSocket = clientWs;

  clientWs.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.type === 'start') {
      connectToOpenAI(msg.apiKey);
    } else if (msg.type === 'audio') {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.audio
        }));
      }
    } else if (msg.type === 'commit') {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        openaiWs.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions: 'Translate the user audio from Spanish to English. Output ONLY the English translation. If the audio is unclear or empty, output nothing. Do NOT generate any text unless there is clear Spanish speech to translate. Do NOT make up content. Do NOT have a conversation.'
          }
        }));
      }
    } else if (msg.type === 'stop') {
      disconnectOpenAI();
      broadcast({ type: 'session_ended' });
    }
  });

  clientWs.on('close', () => {
    speakerSocket = null;
    disconnectOpenAI();
    broadcast({ type: 'session_ended' });
    broadcast({ type: 'status', message: 'Speaker disconnected' });
  });
}

function handleViewer(clientWs) {
  viewers.add(clientWs);

  clientWs.send(JSON.stringify({
    type: 'status',
    message: speakerSocket ? 'Connected — waiting for speech...' : 'Waiting for speaker to connect...'
  }));

  clientWs.on('close', () => {
    viewers.delete(clientWs);
  });
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const viewer of viewers) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(msg);
    }
  }
  if (speakerSocket && speakerSocket.readyState === WebSocket.OPEN) {
    speakerSocket.send(msg);
  }
}

// --- OpenAI Realtime API connection ---
function connectToOpenAI(apiKey) {
  disconnectOpenAI();

  const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';

  openaiWs = new WebSocket(url, {
    headers: {
      'Authorization': 'Bearer ' + apiKey,
    }
  });

  openaiWs.on('open', () => {
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: 'You are a real-time Spanish to English translator. The user speaks in Spanish. Translate everything they say into natural, fluent English. Output ONLY the English translation. Do not repeat the Spanish. Do not add commentary.',
        output_modalities: ['text'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'whisper-1' },
            turn_detection: null
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'alloy'
          }
        }
      }
    }));

    broadcast({ type: 'status', message: 'Connected — speak in Spanish...' });
  });

  openaiWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript && msg.transcript.trim()) {
          broadcast({ type: 'spanish', text: msg.transcript.trim() });
        }
        break;

      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.text.delta':
      case 'response.output_text.delta':
        if (msg.delta) {
          broadcast({ type: 'english_delta', delta: msg.delta });
        }
        break;

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
      case 'response.text.done':
      case 'response.output_text.done':
        broadcast({ type: 'english_done' });
        break;

      case 'conversation.item.created':
        if (msg.item && msg.item.id) {
          conversationItemIds.push(msg.item.id);
        }
        break;

      case 'response.done':
        while (conversationItemIds.length > 0) {
          const itemId = conversationItemIds.shift();
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.delete',
            item_id: itemId
          }));
        }
        broadcast({ type: 'status', message: 'Listening — speak in Spanish...' });
        break;

      case 'error':
        broadcast({ type: 'error', message: msg.error?.message || 'OpenAI error' });
        break;
    }
  });

  openaiWs.on('error', () => {
    broadcast({ type: 'error', message: 'OpenAI connection error' });
  });

  openaiWs.on('close', () => {
    openaiWs = null;
  });
}

function disconnectOpenAI() {
  if (openaiWs) {
    openaiWs.close();
    openaiWs = null;
  }
}

httpServer.listen(PORT, () => {
  console.log(`\n  Live Translation Server running on port ${PORT}\n`);
  console.log(`  Speaker:  http://localhost:${PORT}/speaker`);
  console.log(`  Viewer:   http://localhost:${PORT}/viewer\n`);
});
