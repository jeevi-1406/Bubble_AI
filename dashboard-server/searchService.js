const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const browserSearchService = require('./browserSearchService');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.SEARCH_PORT || 3002;

app.use(express.json());

// Health check route
app.get('/health', (req, res) => {
  res.json({ success: true, service: 'search', status: 'healthy' });
});

// Manual Test route
app.post('/test-chrome', async (req, res) => {
  try {
    const success = await browserSearchService.testChrome();
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// REST API for direct calls (optional/fallback)
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Query is required" });
  try {
    const parsed = parseQuery(query);
    const success = await browserSearchService.executeSearch(parsed.siteName, parsed.query);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper parser same as main server fallback
function parseQuery(prompt) {
  const lower = prompt.toLowerCase().trim();
  const registeredKeys = ['youtube', 'linkedin', 'swiggy', 'amazon', 'flipkart', 'github', 'reddit', 'stackoverflow', 'netflix', 'spotify'];
  let siteName = 'google';
  let query = prompt;

  for (const key of registeredKeys) {
    const regex = new RegExp(`\\b${key}\\b`, 'i');
    if (regex.test(prompt)) {
      siteName = key;
      const matchA = prompt.match(new RegExp(`\\b${siteName}\\b.*\\bfor\\b\\s+(.*)`, 'i'));
      if (matchA) {
        query = matchA[1].trim();
      } else {
        query = prompt.replace(new RegExp(`\\b${siteName}\\b`, 'gi'), '')
                      .replace(/\b(search|find|open|go to|look up|lookup|on|in|inside|at|for|and)\b/gi, '')
                      .replace(/\s+/g, ' ')
                      .trim();
      }
      break;
    }
  }
  return { siteName, query };
}

// WebSocket server for real-time status streaming
wss.on('connection', (ws) => {
  console.log('[Search Service] New WebSocket client connected');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { siteName, query } = data;
      console.log(`[Search Service] Real-time search requested for: ${siteName} -> "${query}"`);
      
      // Inject ws so status messages send back directly to Main Server
      const success = await browserSearchService.executeSearch(siteName, query, ws);
      ws.send(JSON.stringify({ type: 'search_complete', success }));
    } catch (err) {
      console.error("[Search Service Socket Error]", err);
      ws.send(JSON.stringify({ type: 'chrome_error', error: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[Search Service] WebSocket client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`[Chrome Service] Chrome Search service is running on port ${PORT}`);
});
