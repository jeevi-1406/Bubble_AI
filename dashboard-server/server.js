require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { google } = require('googleapis');
const { exec, spawn } = require('child_process');
const terminalService = require('./terminalService');
const browserSearchService = require('./browserSearchService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let activeBrowser = null;
let screenshotIntervalId = null;

async function cleanupActiveBrowser() {
  if (screenshotIntervalId) {
    clearInterval(screenshotIntervalId);
    screenshotIntervalId = null;
  }
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch (e) {
      console.error("Error closing active browser:", e);
    }
    activeBrowser = null;
  }
}

const PORT = process.env.PORT || 3000;

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'public')));

const BACKUP_DIR = path.join(__dirname, '..', 'desktop_buddy', 'backups', 'conversations');

// Ensure directory exists
function ensureDirectoryExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Safe backup writer
async function saveMessageToLocalBackup(msg) {
  try {
    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const dateDir = path.join(BACKUP_DIR, todayStr);
    ensureDirectoryExists(dateDir);
    
    const filePath = path.join(dateDir, 'conversation.json');
    let list = [];
    
    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        list = JSON.parse(fileContent);
        if (!Array.isArray(list)) list = [];
      } catch (err) {
        console.error('[Backup Log] Corrupted conversation JSON, writing fallback backup:', err);
        const corruptedPath = filePath + '.' + Date.now() + '.corrupted';
        fs.renameSync(filePath, corruptedPath);
        list = [];
      }
    }
    
    list.push(msg);
    
    // Atomic write
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error('[Backup Log] Failed to save conversation backup:', err);
  }
}

// API endpoint to get server local IPs
app.get('/api/ips', (req, res) => {
  res.json({ ips: getLocalIPs() });
});

// API endpoint to list chronological backup dates
app.get('/api/history/dates', (req, res) => {
  try {
    ensureDirectoryExists(BACKUP_DIR);
    const files = fs.readdirSync(BACKUP_DIR);
    const dates = files.filter(file => {
      const stats = fs.statSync(path.join(BACKUP_DIR, file));
      return stats.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(file);
    }).sort().reverse();
    
    res.json({ success: true, dates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API endpoint to get backup messages for a date
app.get('/api/history/messages', (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, error: 'Invalid date parameter' });
  }
  try {
    const filePath = path.join(BACKUP_DIR, date, 'conversation.json');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const messages = JSON.parse(content);
      res.json({ success: true, messages });
    } else {
      res.json({ success: true, messages: [] });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API endpoint to search backup messages
app.get('/api/history/search', (req, res) => {
  const { query } = req.query;
  if (!query) {
    return res.status(400).json({ success: false, error: 'Query parameter is required' });
  }
  try {
    ensureDirectoryExists(BACKUP_DIR);
    const folders = fs.readdirSync(BACKUP_DIR).filter(file => {
      const stats = fs.statSync(path.join(BACKUP_DIR, file));
      return stats.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(file);
    });
    
    const results = [];
    const searchRegex = new RegExp(query, 'i');
    
    folders.forEach(date => {
      const filePath = path.join(BACKUP_DIR, date, 'conversation.json');
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const messages = JSON.parse(content);
          messages.forEach(msg => {
            if (msg.content && searchRegex.test(msg.content)) {
              results.push({
                date,
                timestamp: msg.timestamp,
                sender: msg.sender,
                content: msg.content,
                inputType: msg.inputType,
                model: msg.model
              });
            }
          });
        } catch (e) {
          // ignore corrupted files for search
        }
      }
    });
    
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API endpoint to export conversation logs as file download
app.get('/api/history/export', (req, res) => {
  const { date, format } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).send('Invalid date parameter');
  }
  try {
    const filePath = path.join(BACKUP_DIR, date, 'conversation.json');
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('No history found for this date');
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    
    if (format === 'txt') {
      const messages = JSON.parse(content);
      let textOutput = `BUBBLE AI CONVERSATION EXPORT - DATE: ${date}\r\n`;
      textOutput += `==================================================\r\n\r\n`;
      
      messages.forEach(msg => {
        const time = new Date(msg.timestamp).toLocaleTimeString();
        const senderLabel = msg.sender.toUpperCase();
        const modelLabel = msg.model ? ` (${msg.model})` : '';
        textOutput += `[${time}] ${senderLabel}${modelLabel}: ${msg.content}\r\n`;
        if (msg.image) {
          textOutput += `[Image attached]\r\n`;
        }
        textOutput += `\r\n`;
      });
      
      res.setHeader('Content-disposition', `attachment; filename=conversation_${date}.txt`);
      res.setHeader('Content-type', 'text/plain; charset=utf-8');
      return res.send(textOutput);
    } else {
      res.setHeader('Content-disposition', `attachment; filename=conversation_${date}.json`);
      res.setHeader('Content-type', 'application/json');
      return res.send(content);
    }
  } catch (err) {
    res.status(500).send(`Export failed: ${err.message}`);
  }
});

// Health check route that verifies internal service availability
app.get('/health', async (req, res) => {
  const searchPort = process.env.SEARCH_PORT || 3002;
  const visionPort = process.env.VISION_PORT || 3003;
  const healthData = {
    main: { status: 'healthy', port: PORT },
    search: { status: 'offline', port: searchPort },
    vision: { status: 'offline', port: visionPort }
  };

  try {
    const searchRes = await fetch(`http://localhost:${searchPort}/health`).catch(() => null);
    if (searchRes && searchRes.ok) {
      healthData.search = await searchRes.json();
    }
  } catch (e) {}

  try {
    const visionPing = await fetch(`http://localhost:${visionPort}`).catch(() => null);
    if (visionPing) {
      healthData.vision = { status: 'healthy', port: visionPort };
    }
  } catch (e) {}

  res.json(healthData);
});

// Test Chrome route proxy
app.post('/test-chrome', express.json(), async (req, res) => {
  const searchPort = process.env.SEARCH_PORT || 3002;
  try {
    console.log(`[Main Server] Forwarding /test-chrome request to Chrome service on port ${searchPort}`);
    const response = await fetch(`http://localhost:${searchPort}/test-chrome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `Search service returned status ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("[Main Server] /test-chrome proxy failed:", err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// API endpoint for browser search launch
app.post('/api/browser/search', express.json(), async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }
  try {
    const openedChrome = await launchBrowserSearch(query);
    res.json({ success: true, openedChrome });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Google OAuth routes
app.get('/auth/google', (req, res) => {
  if (!oauth2Client) {
    return res.status(500).send("Google OAuth2 Client is not configured. Verify google_credentials.json is placed in the server folder.");
  }
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify'
    ],
    prompt: 'consent'
  });
  logCalendarEvent("Google auth started");
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    logCalendarEvent("Calendar error: Authorization code missing");
    return res.status(400).send("Authorization code missing.");
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveTokens(tokens);
    logCalendarEvent("Google auth successful");
    isCalendarConnected = true;
    verifyCalendarConnection();
    res.redirect('/');
  } catch (err) {
    console.error("Error exchanging code for tokens:", err);
    logCalendarEvent(`Calendar error: ${err.message}`);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

// Store active connections
let dashboards = new Set();
let clients = new Set();

// Session state for email invitations
let sessionState = {
  awaitingEmail: false,
  pendingEvent: null,
  awaitingEventSelection: false,
  pendingMatches: null,
  pendingIntent: null,
  awaitingTerminalConfirmation: false,
  pendingTerminalCommand: null,
  awaitingSearchOutline: false,
  pendingSearchQuery: null
};

let ollamaStatus = {
  status: 'offline', // 'online', 'offline', 'missing'
  detail: 'Awaiting initial check...'
};
let activeGemmaModel = "gemma"; // default fallback
let availableModels = []; // list of all installed LLM models

// Google Calendar Configuration variables
let oauth2Client = null;
const tokensPath = path.join(__dirname, 'google_tokens.json');
const credsPath = path.join(__dirname, 'google_credentials.json');
let calendarLogs = [];
let isCalendarConnected = false;

function logCalendarEvent(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${new Date().toLocaleTimeString()}] ${message}`;
  calendarLogs.unshift(logMsg);
  if (calendarLogs.length > 50) calendarLogs.pop();
  console.log(`[Calendar Log] ${message}`);
  
  // Broadcast calendar update to all dashboards
  broadcastToDashboards({
    type: 'calendar_log',
    logs: calendarLogs
  });
}

function loadGoogleCredentials() {
  try {
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const web = creds.web;
      // We will dynamically use the port of the server for redirection
      const redirectUri = `http://localhost:${PORT}/auth/google/callback`;
      oauth2Client = new google.auth.OAuth2(
        web.client_id,
        web.client_secret,
        redirectUri
      );
      
      // Setup refreshed token listener
      oauth2Client.on('tokens', (tokens) => {
        const existingTokens = fs.existsSync(tokensPath) 
          ? JSON.parse(fs.readFileSync(tokensPath, 'utf8'))
          : {};
        const updated = { ...existingTokens, ...tokens };
        saveTokens(updated);
      });

      loadSavedTokens();
    } else {
      console.warn("google_credentials.json not found in server folder. Google Calendar integration is disabled.");
      logCalendarEvent("Calendar standby. google_credentials.json missing");
    }
  } catch (err) {
    console.error("Error loading google credentials:", err);
    logCalendarEvent(`Calendar error: Failed to parse credentials - ${err.message}`);
  }
}

function loadSavedTokens() {
  if (fs.existsSync(tokensPath) && oauth2Client) {
    try {
      const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
      oauth2Client.setCredentials(tokens);
      console.log("Loaded saved Google OAuth tokens successfully.");
      logCalendarEvent("Calendar token loaded successfully");
      
      // Fetch calendar status to verify if token is valid
      verifyCalendarConnection();
    } catch (err) {
      console.error("Error loading saved tokens:", err);
      logCalendarEvent(`Calendar error: Failed to load tokens - ${err.message}`);
    }
  } else {
    logCalendarEvent("Calendar standby. Awaiting authentication...");
  }
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    console.log("Google OAuth tokens saved to file.");
    logCalendarEvent("Calendar token saved");
  } catch (err) {
    console.error("Error saving tokens:", err);
    logCalendarEvent(`Calendar error: Failed to save tokens - ${err.message}`);
  }
}

async function verifyCalendarConnection() {
  if (!oauth2Client) {
    isCalendarConnected = false;
    broadcastCalendarStatus();
    return;
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    await calendar.calendarList.list({ maxResults: 1 });
    isCalendarConnected = true;
    console.log("Google Calendar API connection verified.");
    console.log("[Main Server] Calendar connected");
    logCalendarEvent("Calendar connected");
    
    // Verify Gmail connection
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      await gmail.users.getProfile({ userId: 'me' });
      console.log("Google Gmail API connection verified.");
      console.log("[Main Server] Gmail connected");
      logCalendarEvent("Gmail connected");
    } catch (gErr) {
      console.error("Gmail verify failed:", gErr);
      logCalendarEvent(`Gmail error: Verification failed - ${gErr.message}`);
    }

    // Trigger initial events broadcast
    broadcastCalendarData();
  } catch (err) {
    console.error("Error verifying calendar connection:", err);
    isCalendarConnected = false;
    logCalendarEvent(`Calendar error: Connection verify failed - ${err.message}`);
  }
  broadcastCalendarStatus();
}

function broadcastCalendarStatus() {
  broadcastToDashboards({
    type: 'calendar_status',
    connected: isCalendarConnected
  });
}

async function broadcastCalendarData() {
  if (!isCalendarConnected) return;
  try {
    const today = await getTodayEventsInternal();
    const upcoming = await getUpcomingEventsInternal(5);
    
    // Find next meeting
    const now = new Date();
    const nextEvent = upcoming.find(e => {
      const start = e.start.dateTime ? new Date(e.start.dateTime) : new Date(e.start.date);
      return start > now;
    }) || null;
    
    broadcastToDashboards({
      type: 'calendar_data',
      today: today.map(formatEventForClient),
      upcoming: upcoming.map(formatEventForClient),
      next: nextEvent ? formatEventForClient(nextEvent) : null
    });
  } catch (err) {
    console.error("Error broadcasting calendar data:", err);
  }
}

function formatEventForClient(event) {
  return {
    id: event.id,
    summary: event.summary || "No Title",
    start: event.start.dateTime || event.start.date,
    end: event.end.dateTime || event.end.date,
    hangoutLink: event.hangoutLink || null,
    location: event.location || null,
    attendees: event.attendees || null
  };
}

async function getTodayEventsInternal() {
  if (!oauth2Client) return [];
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  
  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    logCalendarEvent("Calendar events fetched");
    return response.data.items || [];
  } catch (err) {
    console.error("Error fetching today events:", err);
    logCalendarEvent(`Calendar error: Fetch failed - ${err.message}`);
    return [];
  }
}

async function getUpcomingEventsInternal(maxResults = 5) {
  if (!oauth2Client) return [];
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });
    return response.data.items || [];
  } catch (err) {
    console.error("Error fetching upcoming events:", err);
    return [];
  }
}

async function checkFreeBusyInternal(startTime, endTime) {
  if (!oauth2Client) return false;
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const response = await calendar.freebusy.query({
    resource: {
      timeMin: startTime,
      timeMax: endTime,
      items: [{ id: 'primary' }]
    }
  });
  const busy = response.data.calendars.primary.busy || [];
  return busy.length === 0;
}

async function createEventInternal(title, startTime, endTime) {
  if (!oauth2Client) return null;
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const event = {
    summary: title,
    description: "Scheduled via Bubble AI Assistant",
    start: { dateTime: startTime },
    end: { dateTime: endTime },
    conferenceData: {
      createRequest: {
        requestId: Math.random().toString(36).substring(2, 11),
        conferenceSolutionKey: {
          type: 'hangoutsMeet'
        }
      }
    }
  };
  try {
    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1
    });
    logCalendarEvent(`Event created: "${title}"`);
    return response.data;
  } catch (err) {
    logCalendarEvent(`Calendar error: Failed to create event - ${err.message}`);
    throw err;
  }
}

async function deleteEventInternal(eventId) {
  if (!oauth2Client) return;
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  await calendar.events.delete({
    calendarId: 'primary',
    eventId: eventId
  });
  logCalendarEvent(`Calendar event deleted: ID ${eventId}`);
}

async function updateEventInternal(eventId, updates) {
  if (!oauth2Client) return null;
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const response = await calendar.events.patch({
    calendarId: 'primary',
    eventId: eventId,
    resource: updates
  });
  logCalendarEvent(`Calendar event updated: ID ${eventId}`);
  return response.data;
}

async function checkOllamaStatus() {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags");
    if (response.ok) {
      const data = await response.json();
      const models = data.models || [];
      availableModels = models.map(m => m.name);
      
      // Find the best gemma model, preferring lightweight 2b models for speed on CPU
      let gemmaModelObj = models.find(m => m.name.toLowerCase().includes('gemma') && m.name.toLowerCase().includes('2b'));
      if (!gemmaModelObj) {
        gemmaModelObj = models.find(m => m.name.toLowerCase().includes('gemma'));
      }
      
      if (gemmaModelObj) {
        activeGemmaModel = gemmaModelObj.name;
        ollamaStatus = {
          status: 'online',
          detail: `Gemma model "${activeGemmaModel}" is active.`
        };
      } else {
        ollamaStatus = {
          status: 'missing',
          detail: 'Ollama is active, but model "gemma" is missing. Run: ollama pull gemma'
        };
      }
    } else {
      availableModels = [];
      ollamaStatus = {
        status: 'offline',
        detail: `Ollama service active, but api returned status: ${response.status}`
      };
    }
  } catch (err) {
    availableModels = [];
    ollamaStatus = {
      status: 'offline',
      detail: 'Ollama is offline or unreachable on http://127.0.0.1:11434.'
    };
  }
  
  // Broadcast to all dashboards
  broadcastToDashboards({
    type: 'ollama_status',
    status: ollamaStatus.status,
    detail: ollamaStatus.detail,
    models: availableModels
  });
}

// Initial status check & periodic checker (every 8 seconds)
checkOllamaStatus();
setInterval(checkOllamaStatus, 8000);

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const role = urlParams.get('role') || 'client'; // 'dashboard' or 'client'

  console.log(`New connection: role=${role} from ${req.socket.remoteAddress}`);

  if (role === 'dashboard') {
    dashboards.add(ws);
    // Send current status of clients
    ws.send(JSON.stringify({
      type: 'status',
      connectedClients: clients.size
    }));
    // Send current Ollama/Gemma status
    ws.send(JSON.stringify({
      type: 'ollama_status',
      status: ollamaStatus.status,
      detail: ollamaStatus.detail,
      models: availableModels
    }));
    
    // --- Google Calendar Sync on Connection ---
    ws.send(JSON.stringify({
      type: 'calendar_status',
      connected: isCalendarConnected
    }));
    ws.send(JSON.stringify({
      type: 'calendar_log',
      logs: calendarLogs
    }));
    if (isCalendarConnected) {
      setTimeout(() => {
        broadcastCalendarData();
      }, 500);
    }
  } else {
    clients.add(ws);
    // Notify dashboards about new client
    broadcastToDashboards({
      type: 'status',
      connectedClients: clients.size,
      event: 'client_connected',
      ip: req.socket.remoteAddress
    });

    // Send a welcome message to the companion app after connection is established
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'reply',
        content: "hey there, welcome back . I'm bubbe your friendly AI"
      }));
      // Broadcast greeting message to all connected dashboards
      broadcastToDashboards({
        type: 'input',
        inputType: 'bubble',
        content: "hey there, welcome back . I'm bubbe your friendly AI",
        timestamp: new Date().toISOString()
      });
    }, 1000);
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`Received message of type: ${data.type} from client`);

      // Shared history events
      if (data.type === 'get_history_dates') {
        try {
          ensureDirectoryExists(BACKUP_DIR);
          const files = fs.readdirSync(BACKUP_DIR);
          const dates = files.filter(file => {
            const stats = fs.statSync(path.join(BACKUP_DIR, file));
            return stats.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(file);
          }).sort().reverse();
          ws.send(JSON.stringify({
            type: 'history_dates',
            dates: dates
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'history_error', error: err.message }));
        }
        return;
      } else if (data.type === 'get_history_messages') {
        const date = data.date || data.content;
        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          try {
            const filePath = path.join(BACKUP_DIR, date, 'conversation.json');
            let messages = [];
            if (fs.existsSync(filePath)) {
              const fileContent = fs.readFileSync(filePath, 'utf8');
              messages = JSON.parse(fileContent);
            }
            ws.send(JSON.stringify({
              type: 'history_messages',
              date: date,
              messages: messages
            }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'history_error', error: err.message }));
          }
        } else {
          ws.send(JSON.stringify({ type: 'history_error', error: 'Invalid date parameter' }));
        }
        return;
      }

      if (role === 'client') {
        if (data.type === 'mic_status') {
          // Relay mic status to dashboards
          broadcastToDashboards({
            type: 'mic_status',
            status: data.content, // 'listening' or 'idle'
            timestamp: new Date().toISOString()
          });
        } else if (data.type === 'browser_search') {
          const query = data.query || data.content;
          console.log(`[Server Log] Browser search request received`);
          console.log(`[Server Log] Query extracted: "${query}"`);
          
          saveMessageToLocalBackup({
            timestamp: new Date().toISOString(),
            sender: 'user',
            content: query,
            inputType: 'text'
          });

          ws.send(JSON.stringify({
            type: 'browser_search_status',
            status: 'received',
            query: query
          }));
          
          (async () => {
            try {
              const openedChrome = await launchBrowserSearch(query, ws);
              console.log(`[Server Log] Search completed / browser launched: ${openedChrome}`);
              
              const reply = openedChrome ? "I searched that on Chrome for you." : "I opened the browser search results.";
              ws.send(JSON.stringify({
                type: 'reply',
                content: reply
              }));
              
              broadcastToDashboards({
                type: 'input',
                inputType: 'bubble',
                content: reply,
                timestamp: new Date().toISOString()
              });

              saveMessageToLocalBackup({
                timestamp: new Date().toISOString(),
                sender: 'bubble',
                content: reply,
                inputType: 'bubble',
                model: 'Chrome Search'
              });
            } catch (err) {
              console.error("Browser search failed:", err);
              ws.send(JSON.stringify({
                type: 'browser_search_status',
                status: 'failed',
                error: err.message
              }));
            }
          })();
        } else if (data.type === 'file') {
          // Handle Shared File summary study notes request
          // 1. Relay user's document sharing activity to dashboards
          const docContent = `[Shared File: Document content submitted for study notes summary. length: ${data.content.length} characters]`;
          broadcastToDashboards({
            type: 'input',
            inputType: 'text',
            content: docContent,
            timestamp: new Date().toISOString()
          });

          saveMessageToLocalBackup({
            timestamp: new Date().toISOString(),
            sender: 'user',
            content: docContent,
            inputType: 'file'
          });

          // 2. Trigger thinking indicator
          broadcastToDashboards({
            type: 'mic_status',
            status: 'processing',
            timestamp: new Date().toISOString()
          });
          ws.send(JSON.stringify({ type: 'thinking' }));

          // 3. Ask Ollama to generate study notes
          setTimeout(async () => {
            const { text: replyText, model: modelUsed } = await queryOllama('file', data.content);
            const timestamp = new Date().toISOString();

            // Send generated study notes back to the client APK
            ws.send(JSON.stringify({
              type: 'reply',
              content: replyText
            }));

            // Relay reply to all dashboards
            broadcastToDashboards({
              type: 'input',
              inputType: 'bubble',
              content: replyText,
              timestamp: timestamp,
              model: modelUsed
            });

            saveMessageToLocalBackup({
              timestamp: timestamp,
              sender: 'bubble',
              content: replyText,
              inputType: 'bubble',
              model: modelUsed
            });

            // Set mic status back to idle
            broadcastToDashboards({
              type: 'mic_status',
              status: 'idle',
              timestamp: timestamp
            });
          }, 1500);
        } else {
          // 1. Relay user's message to all dashboards
          broadcastToDashboards({
            type: 'input',
            inputType: data.type, // 'text', 'speech', 'image'
            content: data.content,
            timestamp: new Date().toISOString()
          });

          saveMessageToLocalBackup({
            timestamp: new Date().toISOString(),
            sender: 'user',
            content: data.type === 'image' ? '[Image Upload]' : data.content,
            inputType: data.type
          });

          // 2. Temporarily switch dashboard brain display to Llava for images
          if (data.type === 'image') {
            broadcastToDashboards({
              type: 'ollama_status',
              status: 'online',
              detail: 'Vision model "llava:latest" is active (Processing Image Analysis).',
              models: availableModels
            });
          }

          // 3. Trigger Bubble's thinking status
          broadcastToDashboards({
            type: 'mic_status',
            status: 'processing',
            timestamp: new Date().toISOString()
          });
          ws.send(JSON.stringify({ type: 'thinking' }));

          // 4. Generate response from Bubble via Ollama
          setTimeout(async () => {
            const { replyText, modelUsed } = await processUserChatMessage(data.type, data.content, ws);
            const timestamp = new Date().toISOString();

            // Send reply to client APK so it shows in its Chat page & triggers TTS
            ws.send(JSON.stringify({
              type: 'reply',
              content: replyText
            }));

            // Send reply to all dashboards so it shows in the chat logs
            broadcastToDashboards({
              type: 'input',
              inputType: 'bubble', // Bubble response type
              content: replyText,
              timestamp: timestamp,
              model: modelUsed
            });

            saveMessageToLocalBackup({
              timestamp: timestamp,
              sender: 'bubble',
              content: replyText,
              inputType: 'bubble',
              model: modelUsed
            });

            // Set mic status back to idle
            broadcastToDashboards({
              type: 'mic_status',
              status: 'idle',
              timestamp: timestamp
            });

            // Restore Gemma active status if we just processed an image
            if (data.type === 'image') {
              broadcastToDashboards({
                type: 'ollama_status',
                status: 'online',
                detail: `Gemma model "${activeGemmaModel}" is active.`,
                models: availableModels
              });
            }
          }, 1500);
        }
      } else if (role === 'dashboard') {
        if (data.type === 'dashboard_chat') {
          const content = data.content;
          const inputType = data.inputType || 'text';
          
          console.log(`[Server Log] Dashboard chat received: "${content}" (${inputType})`);
          
          // 1. Broadcast user input to all dashboards
          broadcastToDashboards({
            type: 'input',
            inputType: inputType,
            content: content,
            timestamp: new Date().toISOString()
          });

          saveMessageToLocalBackup({
            timestamp: new Date().toISOString(),
            sender: 'user',
            content: content,
            inputType: inputType
          });
          
          // 2. Broadcast thinking status
          broadcastToDashboards({
            type: 'mic_status',
            status: 'processing'
          });
          
          // 3. Process chat message asynchronously
          setTimeout(async () => {
            try {
              const { replyText, modelUsed } = await processUserChatMessage(inputType, content, ws);
              
              // Broadcast reply to all dashboards
              broadcastToDashboards({
                type: 'input',
                inputType: 'bubble',
                content: replyText,
                timestamp: new Date().toISOString(),
                model: modelUsed
              });

              saveMessageToLocalBackup({
                timestamp: new Date().toISOString(),
                sender: 'bubble',
                content: replyText,
                inputType: 'bubble',
                model: modelUsed
              });
              
              // Relay the reply to connected client APKs (for voice TTS)
              clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: 'reply',
                    content: replyText
                  }));
                }
              });
            } catch (err) {
              console.error('[Server Log] Error processing dashboard chat:', err);
              broadcastToDashboards({
                type: 'input',
                inputType: 'bubble',
                content: `An error occurred: ${err.message}`,
                timestamp: new Date().toISOString(),
                model: 'SYSTEM'
              });
              saveMessageToLocalBackup({
                timestamp: new Date().toISOString(),
                sender: 'server',
                content: `Error processing dashboard chat: ${err.message}`,
                inputType: 'error'
              });
            } finally {
              broadcastToDashboards({
                type: 'mic_status',
                status: 'idle'
              });
            }
          }, 1000);
        } else if (data.type === 'test_chrome_automation') {
          console.log("[Server Log] Dashboard requested Test Chrome Automation");
          const firstClient = Array.from(clients)[0];
          if (firstClient) {
            firstClient.send(JSON.stringify({
              type: 'browser_search_status',
              status: 'received',
              query: 'search test from Bubble'
            }));
            launchBrowserSearch('search test from Bubble', firstClient);
          } else {
            console.log("[Server Log] No connected client APK for browser automation testing");
            launchBrowserSearch('search test from Bubble', null);
          }
        } else if (data.type === 'send_test_screenshot') {
          console.log("[Server Log] Dashboard requested Send Test Screenshot");
          const testBase64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
          clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'browser_screenshot',
                image: testBase64
              }));
              client.send(JSON.stringify({
                type: 'browser_search_status',
                status: 'preview_receiving'
              }));
            }
          });
        }
      }
    } catch (err) {
      console.error('Error parsing client message:', err);
      // Fallback if raw text is sent
      if (role === 'client') {
        const text = message.toString();
        broadcastToDashboards({
          type: 'input',
          inputType: 'text',
          content: text,
          timestamp: new Date().toISOString()
        });

        // Trigger thinking
        ws.send(JSON.stringify({ type: 'thinking' }));
        broadcastToDashboards({ type: 'mic_status', status: 'processing' });

        setTimeout(async () => {
          const { replyText, modelUsed } = await processUserChatMessage('text', text, ws);
          ws.send(JSON.stringify({ type: 'reply', content: replyText }));
          broadcastToDashboards({
            type: 'input',
            inputType: 'bubble',
            content: replyText,
            timestamp: new Date().toISOString(),
            model: modelUsed
          });
          broadcastToDashboards({ type: 'mic_status', status: 'idle' });
        }, 1500);
      }
    }
  });

  ws.on('close', () => {
    console.log(`Closed connection: role=${role}`);
    if (role === 'dashboard') {
      dashboards.delete(ws);
    } else {
      clients.delete(ws);
      broadcastToDashboards({
        type: 'status',
        connectedClients: clients.size,
        event: 'client_disconnected'
      });
    }
  });

  ws.on('error', (error) => {
    console.error(`Socket error (${role}):`, error);
  });
});

function broadcastToDashboards(data) {
  const messageStr = JSON.stringify(data);
  dashboards.forEach((dashboard) => {
    if (dashboard.readyState === WebSocket.OPEN) {
      dashboard.send(messageStr);
    }
  });
}

function extractTitleFromSchedulePrompt(text) {
  // Strip out action prefixes and noise words
  let clean = text.toLowerCase()
    .replace(/\bschedule\b/g, "")
    .replace(/\bcreate\b/g, "")
    .replace(/\bbook\b/g, "")
    .replace(/\badd\b/g, "")
    .replace(/\bmeeting\b/g, "")
    .replace(/\bevent\b/g, "")
    .replace(/\bfor\b/g, "")
    .replace(/\btitled\b/g, "")
    .replace(/\bcalled\b/g, "")
    .trim();
    
  // Strip out time keywords and numeric references
  clean = clean
    .replace(/\btomorrow\b/g, "")
    .replace(/\btoday\b/g, "")
    .replace(/\bnext monday\b/g, "")
    .replace(/\bat\s+\d+(?::\d+)?\s*(?:pm|am)?\b/g, "")
    .replace(/\bto\s+\d+(?::\d+)?\s*(?:pm|am)?\b/g, "")
    .replace(/\b\d+(?::\d+)?\s*(?:pm|am)?\b/g, "")
    .trim();
    
  // Strip out email addresses and "with [name]" descriptors
  clean = clean.replace(/\bwith\s+[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, "");
  clean = clean.replace(/\bwith\s+([a-zA-Z0-9]+)\b/g, "");
  
  // Clean double spaces
  clean = clean.replace(/\s+/g, " ").trim();
  
  if (!clean || clean.length < 2) {
    return "Bubble Meeting";
  }
  
  // Convert to Title Case
  return clean.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function extractEmail(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const match = text.match(emailRegex);
  return match ? match[0] : null;
}

async function sendMeetingEmail(toEmail, eventTitle, startIso, endIso, meetLink) {
  if (!oauth2Client) {
    logCalendarEvent("Gmail error: Client not authenticated.");
    throw new Error("Gmail is not authenticated.");
  }
  
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  
  const startDate = new Date(startIso);
  const formattedTime = startDate.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
  
  let bodyContent = `Hello,\n\nYou have been invited to a meeting scheduled via Bubble AI.\n\n`;
  bodyContent += `Event: ${eventTitle}\n`;
  bodyContent += `Time: ${formattedTime}\n`;
  if (meetLink) {
    bodyContent += `Google Meet Link: ${meetLink}\n`;
  }
  bodyContent += `\nBest regards,\nBubble AI Assistant`;

  // Build RFC 5322 email string
  const utf8Subject = `=?utf-8?B?${Buffer.from(`Invitation: ${eventTitle}`).toString('base64')}?=`;
  const emailLines = [
    `To: ${toEmail}`,
    `Subject: ${utf8Subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    bodyContent
  ];
  
  const email = emailLines.join('\r\n');
  const base64SafeEmail = Buffer.from(email)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
    
  try {
    await gmail.users.messages.send({
      userId: 'me',
      resource: {
        raw: base64SafeEmail
      }
    });
    logCalendarEvent(`Email sent successfully to ${toEmail}`);
  } catch (err) {
    console.error("Failed to send email via Gmail:", err);
    logCalendarEvent(`Gmail error: Failed to send email - ${err.message}`);
    throw err;
  }
}

async function getGmailInbox() {
  if (!oauth2Client) {
    logCalendarEvent("Gmail error: Client not authenticated.");
    throw new Error("Gmail is not authenticated.");
  }
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: 'label:INBOX',
    maxResults: 5
  });
  
  const messages = response.data.messages || [];
  const inboxList = [];
  
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id
    });
    
    const headers = detail.data.payload.headers;
    const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(No Subject)';
    const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '(Unknown)';
    const snippet = detail.data.snippet || '';
    
    inboxList.push({
      id: msg.id,
      from,
      subject,
      snippet
    });
  }
  
  return inboxList;
}

async function searchGmailEmails(query) {
  if (!oauth2Client) {
    logCalendarEvent("Gmail error: Client not authenticated.");
    throw new Error("Gmail is not authenticated.");
  }
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 5
  });
  
  const messages = response.data.messages || [];
  const searchResults = [];
  
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id
    });
    
    const headers = detail.data.payload.headers;
    const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(No Subject)';
    const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '(Unknown)';
    const snippet = detail.data.snippet || '';
    
    searchResults.push({
      id: msg.id,
      from,
      subject,
      snippet
    });
  }
  
  return searchResults;
}

async function queryOllamaSimple(prompt) {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: activeGemmaModel,
        prompt: prompt,
        stream: false,
        options: {
          num_predict: 80,
          num_ctx: 1024,
          temperature: 0.7,
          top_k: 40,
          top_p: 0.9
        }
      })
    });
    if (response.ok) {
      const resJson = await response.json();
      return resJson.response.trim();
    }
  } catch (err) {
    console.error("queryOllamaSimple failed:", err);
  }
  return "";
}

async function findEventsToModify(dateStr, timeStr, titleQuery) {
  if (!oauth2Client) return [];
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
  let timeMin, timeMax;
  if (dateStr) {
    const day = resolveDateTime(dateStr, null);
    const start = new Date(day.getTime());
    start.setHours(0, 0, 0, 0);
    const end = new Date(day.getTime());
    end.setHours(23, 59, 59, 999);
    timeMin = start.toISOString();
    timeMax = end.toISOString();
  } else {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 7);
    timeMin = start.toISOString();
    timeMax = end.toISOString();
  }
  
  logCalendarEvent("Calendar read started");
  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin,
    timeMax: timeMax,
    singleEvents: true,
    orderBy: 'startTime'
  });
  const events = response.data.items || [];
  logCalendarEvent("Events fetched");
  
  let matches = events;
  
  if (timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    matches = matches.filter(e => {
      if (!e.start.dateTime) return false;
      const eStart = new Date(e.start.dateTime);
      return eStart.getHours() === h && eStart.getMinutes() === m;
    });
  }
  
  if (titleQuery) {
    const q = titleQuery.toLowerCase().trim();
    matches = matches.filter(e => {
      const summary = (e.summary || "").toLowerCase();
      return summary.includes(q);
    });
  }
  
  return matches;
}

async function executeActionOnEvent(event, intentInfo) {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
  switch (intentInfo.intent) {
    case "rename": {
      const updates = { summary: intentInfo.newTitle };
      await calendar.events.patch({
        calendarId: 'primary',
        eventId: event.id,
        resource: updates
      });
      logCalendarEvent("Event matched");
      logCalendarEvent("Event updated");
      broadcastCalendarData();
      return { success: true, info: `Renamed the meeting to "${intentInfo.newTitle}".` };
    }
    
    case "reschedule": {
      const oldStart = new Date(event.start.dateTime || event.start.date);
      const oldEnd = new Date(event.end.dateTime || event.end.date);
      const duration = oldEnd.getTime() - oldStart.getTime();
      
      const newStart = resolveDateTime(intentInfo.newDateStr, intentInfo.newTimeStr);
      const newEnd = new Date(newStart.getTime() + duration);
      
      const updates = {
        start: { dateTime: newStart.toISOString() },
        end: { dateTime: newEnd.toISOString() }
      };
      
      await calendar.events.patch({
        calendarId: 'primary',
        eventId: event.id,
        resource: updates
      });
      logCalendarEvent("Event matched");
      logCalendarEvent("Event rescheduled");
      broadcastCalendarData();
      
      const newTimeLabel = newStart.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      return { 
        success: true, 
        info: `Rescheduled the meeting "${event.summary}" to ${intentInfo.newDateStr} at ${newTimeLabel}.` 
      };
    }
    
    case "edit_field": {
      const updates = {};
      if (intentInfo.field === "attendees") {
        const email = extractEmail(intentInfo.value) || intentInfo.value;
        const attendees = event.attendees || [];
        attendees.push({ email });
        updates.attendees = attendees;
        
        try {
          let meetLink = null;
          if (event.conferenceData && event.conferenceData.entryPoints) {
            const meetEntryPoint = event.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
            if (meetEntryPoint) meetLink = meetEntryPoint.uri;
          }
          await sendMeetingEmail(email, event.summary, event.start.dateTime || event.start.date, event.end.dateTime || event.end.date, meetLink);
        } catch (e) {
          console.error("Failed to email added attendee:", e);
        }
      } else {
        updates[intentInfo.field] = intentInfo.value;
      }
      
      await calendar.events.patch({
        calendarId: 'primary',
        eventId: event.id,
        resource: updates
      });
      logCalendarEvent("Event matched");
      logCalendarEvent("Event updated");
      broadcastCalendarData();
      return { success: true, info: `Updated the ${intentInfo.field} of "${event.summary}" to "${intentInfo.value}".` };
    }
    
    default:
      return { success: false, info: "Unknown action" };
  }
}

function parseSelectionIndex(text, maxCount) {
  const lower = text.toLowerCase().trim();
  const digitMatch = lower.match(/\b([1-9])\b/);
  if (digitMatch) {
    const idx = parseInt(digitMatch[1]) - 1;
    if (idx >= 0 && idx < maxCount) return idx;
  }
  
  if (lower.includes("first") || lower.includes("1st")) return 0;
  if (lower.includes("second") || lower.includes("2nd") && maxCount > 1) return 1;
  if (lower.includes("third") || lower.includes("3rd") && maxCount > 2) return 2;
  
  return -1;
}

function parseWebSearchIntent(prompt) {
  const lower = prompt.toLowerCase();
  
  const calendarActionTriggers = [
    "rename", "change", "move", "delete", "cancel", "reschedule", 
    "schedule a", "create", "book", "add "
  ];
  
  const emailTriggers = [
    "email", "gmail", "send invite", "send invitation", "recipient email"
  ];
  
  const isCalendarAction = calendarActionTriggers.some(t => lower.includes(t));
  const isEmailAction = emailTriggers.some(t => lower.includes(t));
  
  const readCalendarTriggers = [
    "calendar", "agenda", "schedule", "plans", "events", "meetings", "appointments",
    "what do i have", "anything today", "anything tomorrow", "do i have anything", "any plans"
  ];
  const isCalendarRead = readCalendarTriggers.some(t => lower.includes(t)) && !lower.includes("search");
  
  if (isCalendarAction || isEmailAction || isCalendarRead) {
    return null;
  }
  
  const searchTriggers = [
    "search", "google", "search for", "open chrome and search", "youtube", "play on youtube",
    "browse", "look up", "find online", "open chrome", "latest news", "nearby"
  ];
  
  const matchesSearch = searchTriggers.some(trigger => lower.includes(trigger));
  
  // Pattern matching: e.g. "swiggy for biryani" or "linkedin/cavin infotech"
  const registeredSites = ['youtube', 'linkedin', 'swiggy', 'amazon', 'flipkart', 'github', 'reddit', 'stackoverflow', 'netflix', 'spotify'];
  const matchesDirectSite = registeredSites.some(site => lower.includes(site)) && lower.includes("for");
  const matchesSlash = lower.includes("/");

  if (matchesSearch || matchesDirectSite || matchesSlash) {
    return {
      intent: "web_search",
      query: prompt
    };
  }
  
  return null;
}

function getDirectSearchUrl(siteName, query) {
  const s = siteName.toLowerCase().trim();
  const q = encodeURIComponent(query.trim());
  
  switch(s) {
    case 'linkedin':
      return `https://www.linkedin.com/search/results/all/?keywords=${q}`;
    case 'swiggy':
      return `https://www.swiggy.com/search?query=${q}`;
    case 'youtube':
      return `https://www.youtube.com/results?search_query=${q}`;
    case 'github':
      return `https://github.com/search?q=${q}`;
    case 'wikipedia':
      return `https://en.wikipedia.org/wiki/Special:Search?search=${q}`;
    case 'reddit':
      return `https://www.reddit.com/search/?q=${q}`;
    case 'amazon':
      return `https://www.amazon.com/s?k=${q}`;
    default:
      // Fallback to site:domain search on Google
      return `https://www.google.com/search?q=site:${s}.com+${q}`;
  }
}

function parseUniversalSearchQuery(prompt) {
  const lower = prompt.toLowerCase().trim();
  const registeredKeys = ['youtube', 'linkedin', 'swiggy', 'amazon', 'flipkart', 'github', 'reddit', 'stackoverflow', 'netflix', 'spotify'];
  
  let siteName = null;
  let cleanQuery = null;

  // 1. Slash pattern check (e.g. "linkedin/cavin infotech")
  if (lower.includes('/')) {
    const parts = prompt.split('/');
    const possibleSite = parts[0].trim().toLowerCase();
    const isRegistered = registeredKeys.some(k => possibleSite.includes(k) || k.includes(possibleSite));
    if (isRegistered) {
      siteName = parts[0].trim();
      cleanQuery = parts.slice(1).join('/').trim();
      return { siteName, query: cleanQuery };
    }
  }

  // 2. Find if any registered site key is in the prompt using word boundaries
  for (const key of registeredKeys) {
    const regex = new RegExp(`\\b${key}\\b`, 'i');
    if (regex.test(prompt)) {
      siteName = key;
      break;
    }
  }

  if (siteName) {
    // We found a registered website name! Let's extract the query using common grammatical patterns.
    
    // Pattern A: ... [site] ... for [query] ... (e.g. "search linkedin for ai jobs", "swiggy for biryani")
    const patternA = new RegExp(`\\b${siteName}\\b.*\\bfor\\b\\s+(.*)`, 'i');
    const matchA = prompt.match(patternA);
    if (matchA) {
      cleanQuery = matchA[1].trim();
    }
    
    // Pattern B: ... search [query] ... on/in/inside/at [site] (e.g. "find pizza on swiggy", "look up react jobs in linkedin")
    if (!cleanQuery) {
      const patternB = new RegExp(`(?:search|find|lookup|look\\s*up|for)\\s+(.*?)\\s+(?:on|in|inside|at|inside\\s+of)\\s+\\b${siteName}\\b`, 'i');
      const matchB = prompt.match(patternB);
      if (matchB) {
        cleanQuery = matchB[1].trim();
      }
    }

    // Pattern C: ... [site] ... search [query] (e.g. "open amazon and search headphones", "go to github and search bubble ai")
    if (!cleanQuery) {
      const patternC = new RegExp(`\\b${siteName}\\b.*\\b(?:search|find|lookup|look\\s*up)\\s+(.*)`, 'i');
      const matchC = prompt.match(patternC);
      if (matchC) {
        cleanQuery = matchC[1].trim();
      }
    }

    // Fallback: strip site name and action words
    if (!cleanQuery) {
      cleanQuery = prompt.replace(new RegExp(`\\b${siteName}\\b`, 'gi'), '')
                         .replace(/\b(search|find|open|go to|look up|lookup|on|in|inside|at|for|and)\b/gi, '')
                         .replace(/\s+/g, ' ')
                         .trim();
    }
  } else {
    // If no site was detected, check if it matches a general "search for [Query] on [Site]" where [Site] is unregistered
    const matchFallback = prompt.match(/(?:search\s+for|find|lookup|look\s*up)\s+(.*?)\s+(?:on|in|inside|at)\s+([a-zA-Z0-9.\-]+)/i);
    if (matchFallback) {
      cleanQuery = matchFallback[1].trim();
      siteName = matchFallback[2].trim();
    }
  }

  // If we still have nothing, treat as a generic Google Search query
  if (!siteName || !cleanQuery) {
    cleanQuery = prompt.replace(/\bsearch chrome for\b/gi, "")
                        .replace(/\bsearch for\b/gi, "")
                        .replace(/\bsearch\b/gi, "")
                        .replace(/\bgoogle\b/gi, "")
                        .replace(/\blook up\b/gi, "")
                        .replace(/\bfind online\b/gi, "")
                        .replace(/\bopen chrome\b/gi, "")
                        .trim();
    siteName = 'google';
  }

  return { siteName, query: cleanQuery };
}

async function launchBrowserSearch(query, ws = null) {
  console.log(`[Main Server] Search command detected: "${query}"`);
  
  if (!query || !query.trim()) {
    console.log("[Server Log] Empty query");
    const errMsg = "Please enter something to search";
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'chrome_error',
        error: errMsg
      }));
    }
    return false;
  }

  // Parse query using our universal parser logic
  const parsed = parseUniversalSearchQuery(query);
  const siteName = parsed.siteName;
  const cleanQuery = parsed.query;

  if (!cleanQuery) {
    console.log("[Server Log] Query became empty after parsing");
    const errMsg = "Please enter something to search";
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'chrome_error',
        error: errMsg
      }));
    }
    return false;
  }

  // Delegate search to the browserSearchService (on port 3002) over WebSockets
  return new Promise((resolve) => {
    const searchPort = process.env.SEARCH_PORT || 3002;
    const clientWs = new WebSocket(`ws://localhost:${searchPort}`);
    
    clientWs.on('open', () => {
      console.log(`[Main Server] Request forwarded to Chrome service on port ${searchPort}`);
      clientWs.send(JSON.stringify({ siteName, query: cleanQuery }));
    });
    
    clientWs.on('message', (msg) => {
      try {
        const parsedMsg = JSON.parse(msg.toString());
        // Forward real-time status updates back to original client
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(msg.toString());
        }
        if (parsedMsg.type === 'search_complete') {
          clientWs.close();
          resolve(parsedMsg.success);
        }
      } catch (e) {
        console.error("[Main Server] Error parsing search service message:", e);
      }
    });
    
    clientWs.on('error', (err) => {
      console.error("[Main Server] Search Service connection failed:", err);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chrome_error', error: "Search Service is offline or busy" }));
      }
      resolve(false);
    });
  });
}

function isWebcamVisionIntent(content) {
  const lower = content.toLowerCase().trim();
  const triggers = [
    "what's on my desk", "whats on my desk", "scan my desk", 
    "look around", "what do you see", "identify objects", 
    "read what's in front of you", "read whats in front of you",
    "look in front of you", "what is in front of you",
    "scan my room", "check the camera"
  ];
  return triggers.some(t => lower.includes(t));
}

async function executeWebcamVisionFlow(ws = null) {
  console.log("[Webcam Vision] Forwarding request to RTSP Vision Service");
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'browser_search_status', status: 'Connecting to RTSP Camera Service...' }));
  }

  const visionPort = process.env.VISION_PORT || 3003;
  const visionUrl = `http://localhost:${visionPort}/api/vision/scan`;

  try {
    const response = await fetch(visionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Service returned status ${response.status}`);
    }

    const data = await response.json();
    return data.description;

  } catch (err) {
    console.error("[Webcam Vision Error] Vision Service request failed:", err);
    return `Failed to capture or recognize objects. Please verify the RTSP camera is online and the vision service on port ${visionPort} is running. Error: ${err.message}`;
  }
}

function parseSystemIntent(prompt) {
  const lower = prompt.toLowerCase().trim();

  // 1. Desktop analyzer
  if (lower.includes("what is in my desktop") || lower.includes("what is on my desktop") || lower.includes("what's on my desktop") || lower.includes("what's in my desktop")) {
    return { intent: "analyze_desktop" };
  }

  // 2. Open App intents
  if (lower.startsWith("open ") || lower.startsWith("start ")) {
    const appName = lower.substring(5).trim();
    // Exclude folder pathways, file explorer keywords, and powershell/cmd (handled by terminalIntent)
    const explorerKeywords = ["file manager", "explorer", "folder", "file", "c:", "d:"];
    const isExplorer = explorerKeywords.some(k => appName.includes(k));
    const isTerminal = appName.includes("powershell") || appName.includes("cmd") || appName.includes("command prompt");
    if (!isExplorer && !isTerminal && appName.length > 0) {
      return { intent: "open_app", appName: appName };
    }
  }

  // 3. File Explorer navigation
  if (lower.startsWith("go to ") || lower.startsWith("navigate to ")) {
    const targetPath = prompt.substring(lower.startsWith("go to ") ? 6 : 12).trim();
    return { intent: "open_explorer", path: targetPath };
  }
  if (lower === "open file manager" || lower === "open explorer") {
    return { intent: "open_explorer", path: "C:\\" };
  }

  // 4. File Explorer search
  if (lower.startsWith("search folder ") || lower.startsWith("search file ")) {
    const targetName = prompt.substring(14).trim();
    return { intent: "search_explorer", target: targetName };
  }
  if (lower.startsWith("search ")) {
    // Check if it's not a web search (which is handled by parseWebSearchIntent)
    // E.g. "search test_folder" or "search project_file"
    const targetName = prompt.substring(7).trim();
    const webKeywords = ["in chrome", "on google", "online", "youtube", "linkedin", "swiggy"];
    const isWeb = webKeywords.some(k => lower.includes(k));
    if (!isWeb && targetName.length > 0) {
      return { intent: "search_explorer", target: targetName };
    }
  }

  return null;
}

async function executeSystemCommand(intent, ws = null) {
  console.log(`[System Automation] Executing system intent:`, intent);

  // Send status: System command detected
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'browser_search_status',
      status: 'Terminal command detected' // Reuse the status logger trigger
    }));
  }

  if (intent.intent === 'open_app') {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Opening ${intent.appName}...`
        }));
      }

      await terminalService.launchApplication(intent.appName);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Done'
        }));
      }
      return { reply: `I opened ${intent.appName} and made it full screen for you, boss.` };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Failed to open ${intent.appName}: ${err.message}` };
    }
  }

  if (intent.intent === 'open_explorer') {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Navigating to ${intent.path}...`
        }));
      }

      await terminalService.openExplorerPath(intent.path);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Done'
        }));
      }
      return { reply: `I opened File Explorer navigated to ${intent.path}, boss.` };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Failed to open path: ${err.message}` };
    }
  }

  if (intent.intent === 'search_explorer') {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Searching for ${intent.target}...`
        }));
      }

      const match = await terminalService.searchAndHighlightFile(intent.target);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Done'
        }));
      }
      return { reply: `I found a matching file/folder at "${match}" and highlighted it in Explorer for you, boss.` };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Could not search file/folder: ${err.message}` };
    }
  }

  if (intent.intent === 'analyze_desktop') {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Analyzing desktop...'
        }));
      }

      const activeWindows = await terminalService.getActiveWindowTitles();
      const files = terminalService.getDesktopFiles();

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Done'
        }));
      }

      // Format warm output
      const windowStr = activeWindows.length > 0 ? activeWindows.join(', ') : 'no active applications';
      const fileStr = files.length > 0 ? files.slice(0, 10).join(', ') + (files.length > 10 ? ', and more' : '') : 'no files';

      return { 
        reply: `Boss, you are seeing ${windowStr} on your screen. Your desktop folder also contains: ${fileStr}.` 
      };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Failed to analyze desktop: ${err.message}` };
    }
  }

  return { reply: "I couldn't identify that system operation." };
}

function parseTerminalIntent(prompt) {
  const lower = prompt.toLowerCase().trim();
  
  // 1. Open PowerShell / CMD intents
  if (lower.includes("open powershell") || lower.includes("start powershell")) {
    return { intent: "open_terminal", shell: "powershell" };
  }
  if (lower.includes("open command prompt") || lower.includes("open cmd") || lower.includes("start cmd") || lower.includes("start command prompt")) {
    return { intent: "open_terminal", shell: "cmd" };
  }
  
  // 2. Command execution intents
  let command = null;
  if (lower.startsWith("run this command:")) {
    command = prompt.substring(17).trim();
  } else if (lower.startsWith("run this command ")) {
    command = prompt.substring(17).trim();
  } else if (lower.startsWith("run ")) {
    command = prompt.substring(4).trim();
  } else if (lower.startsWith("execute ")) {
    command = prompt.substring(8).trim();
  } else {
    // Direct matches for common developer commands
    const directCommands = ["ipconfig", "npm run dev", "npm install", "git status", "dir", "ls", "cd ", "mkdir "];
    const matched = directCommands.some(c => lower === c || lower.startsWith(c));
    if (matched) {
      command = prompt.trim();
    }
  }
  
  if (command) {
    return { intent: "run_command", command: command };
  }
  
  return null;
}

async function executeTerminalCommand(intent, ws = null) {
  console.log(`[Terminal Automation] Executing terminal intent:`, intent);

  // Send status: Terminal command detected
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'browser_search_status',
      status: 'Terminal command detected'
    }));
  }

  if (intent.intent === 'open_terminal') {
    try {
      await terminalService.openTerminal(intent.shell);
      
      // Send status: PowerShell/CMD opened successfully
      const statusMsg = `${intent.shell === 'powershell' ? 'PowerShell' : 'CMD'} opened successfully`;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: statusMsg
        }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'browser_search_status',
            status: 'Done'
          }));
        }, 1000);
      }
      return { reply: `I opened ${intent.shell === 'powershell' ? 'PowerShell' : 'Command Prompt'} for you.` };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Failed to open terminal: ${err.message}` };
    }
  }

  if (intent.intent === 'run_command') {
    const command = intent.command;

    // Safety checks
    if (!terminalService.isCommandSafe(command)) {
      console.log(`[Terminal Automation] Dangerous command blocked: "${command}"`);
      sessionState.awaitingTerminalConfirmation = true;
      sessionState.pendingTerminalCommand = command;
      return { 
        reply: `The command "${command}" could be destructive. Please confirm if you want me to run it by replying "yes" or "confirm".` 
      };
    }

    try {
      // Send status: Running command: <command>
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Running command: ${command}`
        }));
      }

      await terminalService.runCommand(command);

      // Send status: Command completed
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Command completed'
        }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'browser_search_status',
            status: 'Done'
          }));
        }, 1000);
      }

      // Log cwd info
      const status = await terminalService.getTerminalStatus();
      console.log(`[Terminal Automation] Command executed. CWD is now: ${status.cwd}`);

      return { reply: `I executed the command "${command}" in the terminal.` };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Failed to run command: ${err.message}` };
    }
  }

  return { reply: "I couldn't identify that terminal operation." };
}

function parseGmailIntent(prompt) {
  const lower = prompt.toLowerCase().trim();
  
  // 1. Read inbox triggers
  const readTriggers = [
    "read my inbox", "show my emails", "what is in my inbox", "check my mail", 
    "get my emails", "check my inbox", "check gmail", "read my mail"
  ];
  if (readTriggers.some(t => lower.includes(t))) {
    return { intent: "read_inbox" };
  }
  
  // 2. Search emails triggers
  if (lower.startsWith("search emails ") || lower.startsWith("search mail ") || lower.startsWith("find emails ")) {
    // Extract search query
    let query = '';
    if (lower.startsWith("search emails for ")) query = prompt.substring(18);
    else if (lower.startsWith("search emails from ")) query = `from:${prompt.substring(19)}`;
    else if (lower.startsWith("search emails ")) query = prompt.substring(14);
    else if (lower.startsWith("search mail for ")) query = prompt.substring(16);
    else if (lower.startsWith("search mail ")) query = prompt.substring(12);
    else if (lower.startsWith("find emails about ")) query = prompt.substring(18);
    
    if (query.trim()) {
      return { intent: "search_emails", query: query.trim() };
    }
  }
  
  return null;
}

async function executeGmailIntent(intent, ws = null) {
  console.log(`[Gmail Automation] Executing Gmail intent:`, intent);
  
  if (!isCalendarConnected) {
    return { reply: "I cannot access your emails because Google OAuth is currently disconnected. Please log in on the dashboard server." };
  }
  
  if (intent.intent === 'read_inbox') {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Reading inbox...'
        }));
      }

      const emails = await getGmailInbox();

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Done'
        }));
      }

      if (emails.length === 0) {
        return { reply: "Your inbox is empty, boss." };
      }
      const emailStrings = emails.map(e => `From: ${e.from}\nSubject: ${e.subject}\nSnippet: "${e.snippet}"`);
      return { reply: `Boss, you have the following recent emails in your inbox:\n\n${emailStrings.join('\n\n---\n\n')}` };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Failed to read inbox: ${err.message}` };
    }
  }
  
  if (intent.intent === 'search_emails') {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Searching emails for "${intent.query}"...`
        }));
      }

      const emails = await searchGmailEmails(intent.query);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: 'Done'
        }));
      }

      if (emails.length === 0) {
        return { reply: `I couldn't find any emails matching "${intent.query}", boss.` };
      }
      const emailStrings = emails.map(e => `From: ${e.from}\nSubject: ${e.subject}\nSnippet: "${e.snippet}"`);
      return { reply: `Boss, I found these matching emails for "${intent.query}":\n\n${emailStrings.join('\n\n---\n\n')}` };
    } catch (err) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'browser_search_status',
          status: `Command failed: ${err.message}`
        }));
      }
      return { reply: `Failed to search emails: ${err.message}` };
    }
  }
  
  return { reply: "I couldn't process that Gmail request." };
}

function parseCalendarIntent(prompt) {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  
  // 1. Read / List Calendar events
  const readTriggers = [
    "what’s on my calendar today",
    "what’s my calendar today",
    "what’s my agenda today",
    "what do i have today",
    "any meetings today",
    "any events today",
    "what’s scheduled today",
    "show today’s calendar",
    "today’s plan",
    "what's on my calendar today",
    "what's my calendar today",
    "what's my agenda today",
    "what do i have today",
    "any meetings today",
    "any events today",
    "what's scheduled today",
    "show today's calendar",
    "today's plan",
    "calendar", "agenda", "schedule", "plans", "events", "meetings", "appointments",
    "what do i have", "anything today", "anything tomorrow", "do i have anything", "any plans"
  ];
  const matchesRead = readTriggers.some(trigger => lower.includes(trigger)) ||
                      (lower.includes("what") && lower.includes("have") && lower.includes("today")) ||
                      (lower.includes("what") && lower.includes("have") && lower.includes("tomorrow"));
                      
  if (matchesRead) {
    const isAction = lower.includes("rename") || lower.includes("change") || lower.includes("move") || 
                     lower.includes("delete") || lower.includes("cancel") || lower.includes("reschedule") || 
                     lower.includes("schedule a") || lower.includes("create") || lower.includes("book") || 
                     lower.includes("add ");
    if (!isAction) {
      return { intent: "read", dateStr: prompt };
    }
  }

  // 2. Rename meeting
  if (lower.includes("rename") || lower.includes("change name") || lower.includes("change title") || lower.includes("change summary")) {
    let sep = null;
    let sepIndex = -1;
    if (lower.includes(" to ")) {
      sep = " to ";
      sepIndex = lower.lastIndexOf(" to ");
    } else if (lower.includes(" as ")) {
      sep = " as ";
      sepIndex = lower.lastIndexOf(" as ");
    } else if (lower.includes(" into ")) {
      sep = " into ";
      sepIndex = lower.lastIndexOf(" into ");
    }
    
    if (sepIndex !== -1) {
      const beforeSep = text.substring(0, sepIndex).trim();
      const afterSep = text.substring(sepIndex + sep.length).trim();
      
      const timeInfo = extractTimeAndDate(beforeSep);
      let titleQuery = beforeSep.toLowerCase()
        .replace(/\brename\b/g, "")
        .replace(/\bchange\b/g, "")
        .replace(/\bname\b/g, "")
        .replace(/\btitle\b/g, "")
        .replace(/\bsummary\b/g, "")
        .replace(/\bthe\b/g, "")
        .replace(/\bmeeting\b/g, "")
        .replace(/\bevent\b/g, "")
        .replace(/\bmy\b/g, "")
        .replace(/\bat\b/g, "")
        .replace(/\bof\b/g, "")
        .replace(/\b\d+(?::\d+)?\s*(?:pm|am)?\b/g, "")
        .replace(/\btomorrow\b/g, "")
        .replace(/\btoday\b/g, "")
        .trim();
      
      if (titleQuery.length < 2) titleQuery = null;
      
      return {
        intent: "rename",
        titleQuery,
        timeStr: timeInfo.timeStr,
        dateStr: timeInfo.dateStr,
        newTitle: afterSep.replace(/^['"]|['"]$/g, "")
      };
    }
  }

  // 3. Reschedule meeting
  if (lower.includes("move ") || lower.includes("reschedule ") || lower.includes("shift ")) {
    const toIndex = lower.lastIndexOf(" to ");
    if (toIndex !== -1) {
      const beforeTo = text.substring(0, toIndex).trim();
      const afterTo = text.substring(toIndex + 4).trim();
      
      const targetTimeInfo = extractTimeAndDate(beforeTo);
      let titleQuery = beforeTo.toLowerCase()
        .replace(/\bmove\b/g, "")
        .replace(/\breschedule\b/g, "")
        .replace(/\bshift\b/g, "")
        .replace(/\bmy\b/g, "")
        .replace(/\bmeeting\b/g, "")
        .replace(/\bevent\b/g, "")
        .replace(/\bat\b/g, "")
        .replace(/\b\d+(?::\d+)?\s*(?:pm|am)?\b/g, "")
        .replace(/\btomorrow\b/g, "")
        .replace(/\btoday\b/g, "")
        .trim();
        
      if (titleQuery.length < 2) titleQuery = null;
      
      const newTimeInfo = extractTimeAndDate(afterTo);
      
      return {
        intent: "reschedule",
        titleQuery,
        oldTimeStr: targetTimeInfo.timeStr,
        oldDateStr: targetTimeInfo.dateStr,
        newTimeStr: newTimeInfo.timeStr,
        newDateStr: newTimeInfo.dateStr
      };
    }
  }

  // 4. Edit details
  if (lower.includes("change ") || lower.includes("update ") || lower.includes("modify ") || lower.includes("add ")) {
    let field = null;
    if (lower.includes("description") || lower.includes("details")) field = "description";
    else if (lower.includes("location") || lower.includes("where")) field = "location";
    else if (lower.includes("title") || lower.includes("name") || lower.includes("summary")) field = "summary";
    else if (lower.includes("attendee") || lower.includes("invite") || lower.includes("add ")) field = "attendees";
    
    if (field) {
      const toIndex = lower.lastIndexOf(" to ");
      if (toIndex !== -1) {
        const beforeTo = text.substring(0, toIndex).trim();
        const afterTo = text.substring(toIndex + 4).trim();
        
        const timeInfo = extractTimeAndDate(beforeTo);
        let titleQuery = beforeTo.toLowerCase()
          .replace(/\bchange\b/g, "")
          .replace(/\bupdate\b/g, "")
          .replace(/\bmodify\b/g, "")
          .replace(/\badd\b/g, "")
          .replace(/\bdescription\b/g, "")
          .replace(/\blocation\b/g, "")
          .replace(/\btitle\b/g, "")
          .replace(/\bname\b/g, "")
          .replace(/\bsummary\b/g, "")
          .replace(/\bof\b/g, "")
          .replace(/\bmy\b/g, "")
          .replace(/\bmeeting\b/g, "")
          .replace(/\bevent\b/g, "")
          .replace(/\bat\b/g, "")
          .replace(/\b\d+(?::\d+)?\s*(?:pm|am)?\b/g, "")
          .replace(/\btomorrow\b/g, "")
          .replace(/\btoday\b/g, "")
          .trim();
          
        if (titleQuery.length < 2) titleQuery = null;
        
        return {
          intent: "edit_field",
          field,
          value: afterTo.replace(/^['"]|['"]$/g, ""),
          titleQuery,
          timeStr: timeInfo.timeStr,
          dateStr: timeInfo.dateStr
        };
      }
    }
  }

  // 5. Existing check_free
  if (lower.includes("am i free") || lower.includes("is my calendar free") || lower.includes("do i have anything on")) {
    const timeInfo = extractTimeAndDate(lower);
    return { 
      intent: "check_free",
      dateStr: timeInfo.dateStr || "today",
      timeStr: timeInfo.timeStr
    };
  }

  // 6. Existing schedule / create
  if (lower.includes("schedule") || lower.includes("create meeting") || lower.includes("create event") || lower.includes("book a meeting") || lower.includes("add a meeting") || lower.includes("add an event")) {
    const timeInfo = extractTimeAndDate(lower);
    return {
      intent: "create",
      title: "Meeting",
      dateStr: timeInfo.dateStr || "today",
      timeStr: timeInfo.timeStr
    };
  }

  // 7. Existing cancel / delete
  if (lower.includes("cancel") || lower.includes("delete meeting") || lower.includes("delete event") || lower.includes("remove meeting")) {
    const timeInfo = extractTimeAndDate(lower);
    return {
      intent: "delete",
      dateStr: timeInfo.dateStr || "today",
      timeStr: timeInfo.timeStr
    };
  }

  return null;
}

function extractTimeAndDate(text) {
  let dateStr = null;
  if (text.includes("tomorrow")) {
    dateStr = "tomorrow";
  } else if (text.includes("next monday")) {
    dateStr = "next monday";
  } else if (text.includes("today")) {
    dateStr = "today";
  }
  
  // Match things like "at 4 pm", "at 4pm", "to 6 pm", "to 6pm", "at 3:30", etc.
  let timeStr = null;
  const timeMatch = text.match(/(?:at|to|on)\s+(\d+(?::\d+)?)\s*(pm|am)?/) || text.match(/\b(\d+(?::\d+)?)\s*(pm|am)\b/);
  if (timeMatch) {
    let hourPart = timeMatch[1];
    let ampmPart = timeMatch[2];
    
    // Format to HH:MM
    let hour = parseInt(hourPart.split(':')[0]);
    let minute = hourPart.includes(':') ? parseInt(hourPart.split(':')[1]) : 0;
    
    if (ampmPart) {
      if (ampmPart.toLowerCase() === 'pm' && hour < 12) {
        hour += 12;
      }
      if (ampmPart.toLowerCase() === 'am' && hour === 12) {
        hour = 0;
      }
    } else {
      // Guess PM for typical values
      if (hour >= 1 && hour <= 7) {
        hour += 12;
      }
    }
    
    timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00`;
  }
  
  return { dateStr, timeStr };
}

function resolveDateTime(dateStr, timeStr) {
  const date = new Date();
  if (dateStr === "tomorrow") {
    date.setDate(date.getDate() + 1);
  }
  
  if (timeStr) {
    const [h, m, s] = timeStr.split(':').map(Number);
    date.setHours(h, m, s, 0);
  } else {
    // default to now + 1 hour or start of day
    date.setHours(new Date().getHours() + 1, 0, 0, 0);
  }
  return date;
}

function resolveDateRange(text) {
  const lower = text.toLowerCase();
  const today = new Date();
  
  let start = new Date(today.getTime());
  let end = new Date(today.getTime());
  
  let dateLabel = "today";
  
  if (lower.includes("tomorrow")) {
    start.setDate(today.getDate() + 1);
    dateLabel = "tomorrow";
  } else if (lower.includes("next monday") || lower.includes("monday")) {
    const currentDay = today.getDay();
    const distance = (1 + 7 - currentDay) % 7;
    const daysToAdd = distance === 0 ? 7 : distance;
    start.setDate(today.getDate() + daysToAdd);
    dateLabel = "Monday";
  } else if (lower.includes("tuesday")) {
    const currentDay = today.getDay();
    const distance = (2 + 7 - currentDay) % 7;
    const daysToAdd = distance === 0 ? 7 : distance;
    start.setDate(today.getDate() + daysToAdd);
    dateLabel = "Tuesday";
  } else if (lower.includes("wednesday")) {
    const currentDay = today.getDay();
    const distance = (3 + 7 - currentDay) % 7;
    const daysToAdd = distance === 0 ? 7 : distance;
    start.setDate(today.getDate() + daysToAdd);
    dateLabel = "Wednesday";
  } else if (lower.includes("thursday")) {
    const currentDay = today.getDay();
    const distance = (4 + 7 - currentDay) % 7;
    const daysToAdd = distance === 0 ? 7 : distance;
    start.setDate(today.getDate() + daysToAdd);
    dateLabel = "Thursday";
  } else if (lower.includes("friday")) {
    const currentDay = today.getDay();
    const distance = (5 + 7 - currentDay) % 7;
    const daysToAdd = distance === 0 ? 7 : distance;
    start.setDate(today.getDate() + daysToAdd);
    dateLabel = "Friday";
  } else if (lower.includes("saturday")) {
    const currentDay = today.getDay();
    const distance = (6 + 7 - currentDay) % 7;
    const daysToAdd = distance === 0 ? 7 : distance;
    start.setDate(today.getDate() + daysToAdd);
    dateLabel = "Saturday";
  } else if (lower.includes("sunday")) {
    const currentDay = today.getDay();
    const distance = (0 + 7 - currentDay) % 7;
    const daysToAdd = distance === 0 ? 7 : distance;
    start.setDate(today.getDate() + daysToAdd);
    dateLabel = "Sunday";
  } else {
    // Check for monthly date like "july 2" or "july 2nd" or "2nd of july"
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    let matched = false;
    for (let m = 0; m < months.length; m++) {
      if (lower.includes(months[m])) {
        const match = lower.match(new RegExp(`${months[m]}\\s+(\\d+)`)) || lower.match(new RegExp(`(\\d+)(?:st|nd|rd|th)?\\s+of\\s+${months[m]}`));
        if (match) {
          const dayNum = parseInt(match[1]);
          start.setMonth(m);
          start.setDate(dayNum);
          dateLabel = `${months[m].charAt(0).toUpperCase() + months[m].slice(1)} ${dayNum}`;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      dateLabel = "today";
    }
  }
  
  // Start: today 00:00
  start.setHours(0, 0, 0, 0);
  
  // End: tomorrow 00:00 (start + 1 day)
  end = new Date(start.getTime());
  end.setDate(start.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  
  return { start, end, dateLabel };
}

async function executeCalendarIntent(intentInfo) {
  if (!isCalendarConnected) {
    return {
      success: false,
      info: "I would love to manage your calendar, but Google Calendar is currently disconnected. Please authenticate on the dashboard server."
    };
  }
  
  try {
    switch (intentInfo.intent) {
      case "get_today": {
        const events = await getTodayEventsInternal();
        if (events.length === 0) {
          return { success: true, info: "You have no meetings scheduled for today." };
        }
        const eventStrings = events.map(e => {
          const start = e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'All Day';
          return `"${e.summary}" at ${start}`;
        });
        return { success: true, info: `You have ${events.length} meeting(s) today: ${eventStrings.join(', ')}.` };
      }
      
      case "get_next": {
        const upcoming = await getUpcomingEventsInternal(1);
        if (upcoming.length === 0) {
          return { success: true, info: "You have no upcoming meetings scheduled." };
        }
        const next = upcoming[0];
        const start = next.start.dateTime ? new Date(next.start.dateTime).toLocaleString() : 'All Day';
        return { success: true, info: `Your next meeting is "${next.summary}" scheduled for ${start}.` };
      }
      
      case "get_upcoming": {
        const upcoming = await getUpcomingEventsInternal(3);
        if (upcoming.length === 0) {
          return { success: true, info: "You have no upcoming meetings scheduled." };
        }
        const eventStrings = upcoming.map(e => {
          const start = e.start.dateTime ? new Date(e.start.dateTime).toLocaleString() : 'All Day';
          return `"${e.summary}" on ${start}`;
        });
        return { success: true, info: `Your upcoming meetings are: ${eventStrings.join(', ')}.` };
      }
      
      case "check_free": {
        const start = resolveDateTime(intentInfo.dateStr, intentInfo.timeStr);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour window
        const isFree = await checkFreeBusyInternal(start.toISOString(), end.toISOString());
        const timeLabel = start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const dateLabel = intentInfo.dateStr;
        return {
          success: true,
          info: isFree 
            ? `Yes, you are free ${dateLabel} at ${timeLabel}.` 
            : `No, you are busy ${dateLabel} at ${timeLabel}.`
        };
      }
      
      case "create": {
        const start = resolveDateTime(intentInfo.dateStr, intentInfo.timeStr);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour duration
        const event = await createEventInternal(intentInfo.title, start.toISOString(), end.toISOString());
        
        let meetLink = null;
        if (event && event.conferenceData && event.conferenceData.entryPoints) {
          const meetEntryPoint = event.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
          if (meetEntryPoint) meetLink = meetEntryPoint.uri;
        }

        const timeLabel = start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        // Trigger dashboard refresh
        broadcastCalendarData();
        return {
          success: true,
          info: `I've successfully scheduled the meeting "${intentInfo.title}" for ${intentInfo.dateStr} at ${timeLabel}.`,
          event: event,
          meetLink: meetLink
        };
      }
      
      case "delete": {
        // Find the event at the specified time
        const start = resolveDateTime(intentInfo.dateStr, intentInfo.timeStr);
        // Look up events for that day
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const dayStart = new Date(start.getTime());
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(start.getTime());
        dayEnd.setHours(23, 59, 59, 999);
        
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: dayStart.toISOString(),
          timeMax: dayEnd.toISOString(),
          singleEvents: true
        });
        
        const events = response.data.items || [];
        // Match start time hour and minute
        const targetEvent = events.find(e => {
          if (!e.start.dateTime) return false;
          const eStart = new Date(e.start.dateTime);
          return eStart.getHours() === start.getHours() && eStart.getMinutes() === start.getMinutes();
        });
        
        if (!targetEvent) {
          return { success: false, info: `I couldn't find any meeting at ${start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} ${intentInfo.dateStr}.` };
        }
        
        await deleteEventInternal(targetEvent.id);
        broadcastCalendarData();
        return {
          success: true,
          info: `I've canceled your meeting "${targetEvent.summary}" at ${start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}.`
        };
      }
      
      case "update": {
        // Move the next meeting to a new time
        const start = resolveDateTime(intentInfo.dateStr, intentInfo.timeStr);
        const upcoming = await getUpcomingEventsInternal(5);
        if (upcoming.length === 0) {
          return { success: false, info: "You have no upcoming meetings to reschedule." };
        }
        
        // Target the first upcoming meeting
        const targetEvent = upcoming[0];
        const newStart = start;
        const newEnd = new Date(newStart.getTime() + 60 * 60 * 1000); // 1 hour duration
        
        await updateEventInternal(targetEvent.id, {
          start: { dateTime: newStart.toISOString() },
          end: { dateTime: newEnd.toISOString() }
        });
        
        broadcastCalendarData();
        return {
          success: true,
          info: `I've rescheduled the meeting "${targetEvent.summary}" to ${intentInfo.dateStr} at ${newStart.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}.`
        };
      }
      
      case "read": {
        const { start, end, dateLabel } = resolveDateRange(intentInfo.dateStr);
        logCalendarEvent(`Date detected: ${dateLabel}`);
        
        logCalendarEvent("Calendar API called");
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const response = await calendar.events.list({
          calendarId: 'primary',
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
        const events = response.data.items || [];
        logCalendarEvent(`Number of events fetched: ${events.length}`);
        
        let info = "";
        if (events.length === 0) {
          if (dateLabel === "today") {
            info = "You don’t have anything scheduled today.";
          } else {
            info = `You don’t have anything scheduled for ${dateLabel}.`;
          }
        } else {
          const eventStrings = events.map(e => {
            const startStr = e.start.dateTime 
              ? new Date(e.start.dateTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
              : 'All Day';
            const endStr = e.end.dateTime 
              ? new Date(e.end.dateTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
              : 'All Day';
            let loc = "";
            if (e.location) loc = ` at ${e.location}`;
            
            let meetLink = "";
            if (e.conferenceData && e.conferenceData.entryPoints) {
              const meetEntryPoint = e.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
              if (meetEntryPoint) meetLink = ` (Meet: ${meetEntryPoint.uri})`;
            }
            
            return `"${e.summary}" from ${startStr} to ${endStr}${loc}${meetLink}`;
          });
          info = `Your schedule for ${dateLabel}: ${eventStrings.join(', ')}.`;
        }
        
        return { success: true, info };
      }

      case "rename":
      case "reschedule":
      case "edit_field": {
        const matches = await findEventsToModify(intentInfo.dateStr || intentInfo.oldDateStr, intentInfo.timeStr || intentInfo.oldTimeStr, intentInfo.titleQuery);
        if (matches.length === 0) {
          return { success: false, info: "I couldn't find that meeting on your calendar." };
        }
        if (matches.length > 1) {
          sessionState.awaitingEventSelection = true;
          sessionState.pendingMatches = matches;
          sessionState.pendingIntent = intentInfo;
          
          const listStr = matches.map((m, i) => {
            const start = m.start.dateTime ? new Date(m.start.dateTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'All Day';
            return `${i+1}. "${m.summary}" at ${start}`;
          }).join(', ');
          
          return {
            success: true,
            needsSelection: true,
            info: `I found multiple meetings: ${listStr}. Which one do you want to edit?`
          };
        }
        
        // Exactly 1 match
        return await executeActionOnEvent(matches[0], intentInfo);
      }
      
      default:
        return null;
    }
  } catch (err) {
    console.error("Error executing calendar intent:", err);
    logCalendarEvent(`Calendar error: ${err.message}`);
    return {
      success: false,
      info: `Sorry, there was an issue updating your calendar: ${err.message}`
    };
  }
}

async function processUserChatMessage(inputType, content, ws = null) {
  if (inputType === 'text' || inputType === 'speech') {
    logCalendarEvent(`User query received: "${content}"`);
  }
  let replyText = "";
  let modelUsed = activeGemmaModel;

  // Check if we are awaiting search outline response
  if (sessionState.awaitingSearchOutline && sessionState.pendingSearchQuery) {
    const lower = content.toLowerCase().trim();
    const topic = sessionState.pendingSearchQuery;
    
    // Reset state first to prevent infinite loop
    sessionState.awaitingSearchOutline = false;
    sessionState.pendingSearchQuery = null;

    if (lower === 'yes' || lower === 'confirm' || lower.includes('go ahead') || lower.includes('sure') || lower.includes('please') || lower.includes('yep')) {
      // Query Ollama/local model to give exactly 2 lines/sentences description
      const prompt = `You are Bubble, a helpful AI companion. Explain "${topic}" in exactly 2 sentences. Keep it sweet and concise, and start with "Boss, ...".`;
      replyText = await queryOllamaSimple(prompt);
      if (!replyText) {
        replyText = `Boss, here is a short outline: ${topic} is a significant subject. I have opened the web search results for you.`;
      }
    } else {
      replyText = "Understood, boss. I have opened the search page on your browser.";
    }
    return { replyText, modelUsed };
  }

  // Check if we are currently waiting for terminal safety confirmation
  if (sessionState.awaitingTerminalConfirmation && sessionState.pendingTerminalCommand) {
    const lower = content.toLowerCase().trim();
    const command = sessionState.pendingTerminalCommand;
    
    if (lower === 'yes' || lower === 'confirm' || lower.includes('go ahead') || lower.includes('run it') || lower.includes('yes, run it')) {
      // Reset state
      sessionState.awaitingTerminalConfirmation = false;
      sessionState.pendingTerminalCommand = null;
      
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'browser_search_status',
            status: `Running command: ${command}`
          }));
        }
        
        await terminalService.runCommand(command);
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'browser_search_status',
            status: 'Command completed'
          }));
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'browser_search_status',
              status: 'Done'
            }));
          }, 1000);
        }
        
        replyText = `Understood. I have executed the command "${command}" in the terminal.`;
      } catch (err) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'browser_search_status',
            status: `Command failed: ${err.message}`
          }));
        }
        replyText = `Failed to run command: ${err.message}`;
      }
    } else if (lower === 'no' || lower === 'cancel' || lower.includes("don't") || lower.includes("no need")) {
      sessionState.awaitingTerminalConfirmation = false;
      sessionState.pendingTerminalCommand = null;
      replyText = "Command cancelled safely.";
    } else {
      replyText = `Please reply "yes" or "confirm" to run the command "${command}", or "no" to cancel.`;
    }
    return { replyText, modelUsed };
  }

  // Check if we are currently waiting for an event selection (for duplicate events)
  if (sessionState.awaitingEventSelection && sessionState.pendingMatches) {
    const idx = parseSelectionIndex(content, sessionState.pendingMatches.length);
    if (idx !== -1) {
      const selectedEvent = sessionState.pendingMatches[idx];
      const pendingIntent = sessionState.pendingIntent;
      
      // Reset state
      sessionState.awaitingEventSelection = false;
      sessionState.pendingMatches = null;
      sessionState.pendingIntent = null;
      
      try {
        const result = await executeActionOnEvent(selectedEvent, pendingIntent);
        
        // Formulate warm Friday confirmation
        const prompt = `You are Bubble, a soft, sweet, friendly female AI companion (similar to Friday from Iron Man). Respond to the user warmly, politely, and concisely (1-2 sentences) confirming the action: ${result.info}`;
        replyText = await queryOllamaSimple(prompt);
        if (!replyText) {
          replyText = result.info;
        }
      } catch (err) {
        replyText = `I ran into an error processing your selection: ${err.message}`;
      }
    } else {
      const listStr = sessionState.pendingMatches.map((m, i) => {
        const start = m.start.dateTime ? new Date(m.start.dateTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'All Day';
        return `${i+1}. "${m.summary}" at ${start}`;
      }).join(', ');
      replyText = `Please choose one of the meetings by typing its number (1 to ${sessionState.pendingMatches.length}): ${listStr}`;
    }
    return { replyText, modelUsed };
  }

  // Check if we are currently waiting for a recipient email address
  if (sessionState.awaitingEmail && sessionState.pendingEvent) {
    const email = extractEmail(content);
    if (email) {
      const pending = sessionState.pendingEvent;
      // Reset state first to avoid loops
      sessionState.awaitingEmail = false;
      sessionState.pendingEvent = null;
      
      try {
        await sendMeetingEmail(email, pending.title, pending.start, pending.end, pending.meetLink);
        
        // Formulate warm Friday confirmation
        const prompt = `You are Bubble, a soft, sweet, friendly female AI companion (similar to Friday from Iron Man). Respond to the user warmly, politely, and concisely (1-2 sentences) confirming that you have sent the calendar invite email to ${email} for the meeting "${pending.title}".`;
        replyText = await queryOllamaSimple(prompt);
        if (!replyText) {
          replyText = `Understood. I have sent the invitation email to ${email}.`;
        }
      } catch (err) {
        replyText = `I scheduled the event, but failed to send the email invitation: ${err.message}`;
      }
    } else {
      // If the user cancelled or typed something else, we reset or ask again
      const lower = content.toLowerCase();
      if (lower.includes("cancel") || lower.includes("don't") || lower.includes("skip") || lower.includes("no need")) {
        sessionState.awaitingEmail = false;
        sessionState.pendingEvent = null;
        replyText = "Understood. I won't send an email invitation for this meeting.";
      } else {
        replyText = "Please provide a valid email address so I can send the invitation, or say 'cancel' to skip.";
      }
    }
    return { replyText, modelUsed };
  }

  // Standard path: parse calendar intent
  const calIntent = parseCalendarIntent(content);

  if (calIntent) {
    if (calIntent.intent === 'read') {
      logCalendarEvent("Calendar intent detected");
    } else {
      logCalendarEvent(`Calendar intent detected: ${calIntent.intent}`);
    }
    console.log(`Calendar intent detected: ${calIntent.intent}`);
    
    // For create intent, extract title dynamically from prompt
    if (calIntent.intent === 'create') {
      calIntent.title = extractTitleFromSchedulePrompt(content);
    }
    
    const calResult = await executeCalendarIntent(calIntent);
    
    if (calResult.needsSelection) {
      // If the operation requires choosing between multiple matched events, bypass Ollama and return selection prompt directly
      replyText = calResult.info;
      logCalendarEvent("Response generated");
    } else if (calIntent.intent === 'create' && calResult.success) {
      // Check if email was provided directly in the prompt
      const email = extractEmail(content);
      if (email) {
        // Immediate email dispatch
        try {
          await sendMeetingEmail(email, calIntent.title, calResult.event.start.dateTime, calResult.event.end.dateTime, calResult.meetLink);
          const prompt = `You are Bubble, a soft, sweet, friendly female AI companion (similar to Friday from Iron Man). Respond to the user warmly and concisely (1-2 sentences) confirming that you scheduled the meeting "${calIntent.title}" and sent an email invite to ${email}.`;
          replyText = await queryOllamaSimple(prompt);
          if (!replyText) {
            replyText = `I have scheduled "${calIntent.title}" and sent the email invitation to ${email}.`;
          }
        } catch (err) {
          replyText = `I scheduled the meeting "${calIntent.title}" but failed to send the email: ${err.message}`;
        }
      } else {
        // Enter multi-turn wait state for email address
        sessionState.awaitingEmail = true;
        sessionState.pendingEvent = {
          title: calIntent.title,
          start: calResult.event.start.dateTime,
          end: calResult.event.end.dateTime,
          meetLink: calResult.meetLink
        };
        
        const prompt = `You are Bubble, a soft, sweet, friendly female AI companion (similar to Friday from Iron Man). Respond to the user warmly and concisely (1-2 sentences) confirming you scheduled the meeting "${calIntent.title}" and ask what the recipient's email address is so you can send the calendar invite.`;
        replyText = await queryOllamaSimple(prompt);
        if (!replyText) {
          replyText = `I have scheduled the meeting "${calIntent.title}". What is the recipient's email address so I can send the calendar invite?`;
        }
      }
      logCalendarEvent("Response generated");
    } else {
      if (calIntent.intent === 'read') {
        if (calResult.info.includes("You don’t have anything scheduled today.") || calResult.info.includes("You don’t have anything scheduled for")) {
          replyText = calResult.info;
        } else {
          // Query Ollama to respond warmly with this calendar info
          const calendarSystemPrompt = "You are Bubble, a soft, sweet, friendly female AI companion (similar to Friday from Iron Man). Respond to the user's query warmly, politely, and concisely (1-3 sentences max) based ONLY on the provided Google Calendar info. Say what you did or answered clearly.";
          const calendarPrompt = `${calendarSystemPrompt}\n\nUser Question: ${content}\nCalendar Info: ${calResult.info}\nBubble:`;
          replyText = await queryOllamaSimple(calendarPrompt);
          if (!replyText) {
            replyText = calResult.info;
          }
        }
        logCalendarEvent("Final response generated");
      } else {
        // Query Ollama to respond warmly with this calendar info
        const calendarSystemPrompt = "You are Bubble, a soft, sweet, friendly female AI companion (similar to Friday from Iron Man). Respond to the user's query warmly, politely, and concisely (1-3 sentences max) based ONLY on the provided Google Calendar info. Say what you did or answered clearly.";
        const calendarPrompt = `${calendarSystemPrompt}\n\nUser Question: ${content}\nCalendar Info: ${calResult.info}\nBubble:`;
        replyText = await queryOllamaSimple(calendarPrompt);
        if (!replyText) {
          replyText = calResult.info;
        }
        logCalendarEvent("Response generated");
      }
    }
  } else {
    const gmailIntent = parseGmailIntent(content);
    if (gmailIntent) {
      const result = await executeGmailIntent(gmailIntent, ws);
      replyText = result.reply;
      logCalendarEvent("Response generated");
    } else {
      const systemIntent = parseSystemIntent(content);
    if (systemIntent) {
      const result = await executeSystemCommand(systemIntent, ws);
      replyText = result.reply;
      logCalendarEvent("Response generated");
    } else {
      const terminalIntent = parseTerminalIntent(content);
    if (terminalIntent) {
      const result = await executeTerminalCommand(terminalIntent, ws);
      replyText = result.reply;
      logCalendarEvent("Response generated");
    } else {
      if (isWebcamVisionIntent(content)) {
        replyText = await executeWebcamVisionFlow(ws);
        logCalendarEvent("Response generated");
      } else {
        const webSearchIntent = parseWebSearchIntent(content);
        if (webSearchIntent) {
          const parsed = parseUniversalSearchQuery(webSearchIntent.query);
          const cleanTopic = parsed.query;

        await launchBrowserSearch(webSearchIntent.query, ws);

        sessionState.awaitingSearchOutline = true;
        sessionState.pendingSearchQuery = cleanTopic;

        replyText = `Boss, do you want me to give you a short description about it?`;
        logCalendarEvent("Response generated");
      } else {
        const queryResult = await queryOllama(inputType, content);
        replyText = queryResult.text;
        modelUsed = queryResult.model;
      }
    }
  }
  }
  }
  }
  
  return { replyText, modelUsed };
}

// Asynchronously query the local Ollama instance running the Gemma or Llava model
async function queryOllama(inputType, content) {
  let modelToUse = activeGemmaModel;
  let prompt = "";
  let images = undefined;

  if (inputType === 'image') {
    // 1. Detect if a llava/vision model is available
    try {
      const responseTags = await fetch("http://127.0.0.1:11434/api/tags");
      if (responseTags.ok) {
        const data = await responseTags.json();
        const models = data.models || [];
        const foundLlava = models.find(m => m.name.toLowerCase().includes('llava'));
        if (foundLlava) {
          modelToUse = foundLlava.name;
        } else {
          modelToUse = "llava:latest"; // default fallback
        }
      } else {
        modelToUse = "llava:latest";
      }
    } catch (e) {
      modelToUse = "llava:latest";
    }

    // 2. Extract base64 image data
    const rawBase64 = content.replace(/^data:image\/[a-z]+;base64,/, "");
    images = [rawBase64];

    // 3. Assemble visual prompt
    prompt = "This is a visual telemetry uplink. Identify what is in this image and describe it warmly, sweetly, and concisely in 1-3 sentences as Bubble (a friendly AI companion like Friday from Iron Man).";
  } else if (inputType === 'file') {
    prompt = `[User has shared a document. Read the content of the shared document and generate clear, simple, structured bulleted short study notes to make it easy for students to read and review. Highlight main takeaways first. Limit your response to 3-5 concise bullets. Here is the document content:]\n\n${content}`;
  } else {
    prompt = content;
  }

  // System Persona: Soft, sweet, friendly female AI like Friday (Iron Man)
  const systemPrompt = "You are Bubble, a soft, sweet, friendly female AI companion (similar to Friday from Iron Man). Respond to the user's prompt warmly, politely, and concisely (limit responses to 1-3 sentences max).";
  
  const fullPrompt = `${systemPrompt}\n\nUser: ${prompt}\nBubble:`;

  try {
    console.log(`Querying Ollama (model: ${modelToUse}) with prompt of type ${inputType}...`);
    const maxTokens = inputType === 'file' ? 250 : (inputType === 'image' ? 50 : 80);
    const contextSize = inputType === 'file' ? 2048 : (inputType === 'image' ? 512 : 1024);
    const tempVal = inputType === 'image' ? 0.2 : 0.7;

    const requestBody = {
      model: modelToUse,
      prompt: fullPrompt,
      stream: false,
      options: {
        num_predict: maxTokens, // Limit output size to prevent long running loops on CPU
        num_ctx: contextSize,   // Save system memory and increase context processing speeds
        temperature: tempVal,
        top_k: 40,
        top_p: 0.9
      }
    };
    
    if (images) {
      requestBody.images = images;
    }

    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`Ollama returned status: ${response.status}`);
    }

    const data = await response.json();
    const reply = data.response.trim();
    console.log(`Ollama responded: "${reply}"`);
    return { text: reply, model: modelToUse };
  } catch (err) {
    console.warn(`[Ollama Offline] Falling back to local template response. Error: ${err.message}`);
    return { text: generateLocalFallback(inputType, content), model: 'OFFLINE_FALLBACK' };
  }
}

// Simple rule-based dialog responses from Bubble AI (Fallback when Ollama is offline)
function generateLocalFallback(inputType, content) {
  if (inputType === 'image') {
    return "Got your camera snapshot! The visual feed is crystal clear. I've logged the frame in our database.";
  }
  if (inputType === 'file') {
    return "Study Notes Fallback:\n- Document successfully uploaded and parsed.\n- High-yield concepts: Students should focus on key terminology and summaries.\n- Note: My local AI brain is offline, but your document content is saved.";
  }

  const text = content.toLowerCase().trim();

  if (text.includes('hello') || text.includes('hi ') || text.includes('hey')) {
    const greetings = [
      "Hello! I am Bubble, your AI companion. I've synced successfully to your network.",
      "Hi there! Bubble core is fully operational. How is your day going?",
      "Hey! Bubble voice link is open. What shall we talk about?"
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  if (text.includes('how are you')) {
    return "I'm running at peak efficiency! System diagnostics report 0 errors. How are you doing?";
  }

  if (text.includes('weather')) {
    return "I cannot check local weather sensors directly yet, but I hope the atmosphere is pleasant on your side.";
  }

  if (text.includes('help') || text.includes('what can you do')) {
    return "I can receive your text, process real-time voice transcripts, and display snapshot telemetry from your camera. Everything is routed to our dashboard!";
  }

  if (text.includes('name')) {
    return "My name is Bubble. I am your dedicated desktop and mobile AI helper.";
  }

  // Default replies
  const fallbacks = [
    "I hear you clearly! Processing data uplink.",
    "Interesting! That input has been securely logged to our server.",
    "Neural processors are active. Bubble is ready for your next prompt.",
    "Uplink is solid. What else can I log for you today?"
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// Function to get local IP addresses
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Find IPv4 and ignore internal loopback addresses
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ name, address: net.address });
      }
    }
  }
  return addresses;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(`Bubble AI Dashboard Server running on port ${PORT}`);
  console.log(`[Main Server] Main server running on port ${PORT}`);
  console.log(`[Main Server] Chrome service running internally (delegated to port ${process.env.SEARCH_PORT || 3002})`);
  console.log(`[Main Server] Vision service running internally (delegated to port ${process.env.VISION_PORT || 3003})`);
  console.log(`==================================================`);
  console.log(`Dashboard Web Interface: http://localhost:${PORT}`);
  console.log(`\nTo connect the Android App, make sure it is on the`);
  console.log(`same Wi-Fi network. It will scan and sync automatically!`);
  
  const ips = getLocalIPs();
  if (ips.length === 0) {
    console.log(`[Warning] No active Wi-Fi/Ethernet IP addresses found.`);
  } else {
    ips.forEach(ip => {
      console.log(` -> ws://${ip.address}:${PORT}?role=client  (${ip.name})`);
    });
  }
  console.log(`==================================================`);

  // Load Google Calendar credentials and saved tokens
  loadGoogleCredentials();
});
