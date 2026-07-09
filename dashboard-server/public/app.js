// Establish WebSocket connection
let ws;
let activeClientsCount = 0;

// LocalStorage State Keys
const CONVS_STORAGE_KEY = 'bubble_conversations';
const TASKS_STORAGE_KEY = 'bubble_tasks';

// Active Session State
let conversations = [];
let activeConvId = null;
let tasks = [];
let localMeetings = [];
let lastTodayPayload = [];
let lastUpcomingPayload = [];

// DOM Elements
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const calDot = document.getElementById('cal-dot');
const micDot = document.getElementById('mic-dot');
const micStatusText = document.getElementById('mic-status-text');
const activeModelName = document.getElementById('active-model-name');

const latencyVal = document.getElementById('latency-val');
const terminalLogs = document.getElementById('terminal-logs');
const feedContainer = document.getElementById('feed-container');
const emptyState = document.getElementById('empty-state');
const wsServerAddress = document.getElementById('ws-server-address');
const copyBtn = document.getElementById('copy-btn');
const clearFeedBtn = document.getElementById('clear-feed-btn');

// New UI Elements
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const expandSidebarBtn = document.getElementById('expand-sidebar-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const searchHistory = document.getElementById('search-history');
const chatInput = document.getElementById('chat-input');
const sendMessageBtn = document.getElementById('send-message-btn');
const attachImageBtn = document.getElementById('attach-image-btn');
const imageFileInput = document.getElementById('image-file-input');
const micInputBtn = document.getElementById('mic-input-btn');
const todayDateStr = document.getElementById('today-date-str');
const tasksList = document.getElementById('tasks-list');
const addTaskBtn = document.getElementById('add-task-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const toggleLogsBtn = document.getElementById('toggle-logs-btn');
const terminalLogsWrapper = document.getElementById('terminal-logs-wrapper');
const chatPlaceholder = document.getElementById('chat-placeholder');

// Web Speech Recognition
let recognition = null;
let isRecognizing = false;

// Initialize Web Speech API
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechGen = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechGen();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    isRecognizing = true;
    if (micInputBtn) micInputBtn.classList.add('active');
    updateMicTextStatus('LISTENING');
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    if (transcript.trim()) {
      chatInput.value = transcript;
      sendChatMessage('speech');
    }
  };

  recognition.onerror = (err) => {
    console.error('Speech recognition error:', err);
    isRecognizing = false;
    if (micInputBtn) micInputBtn.classList.remove('active');
    updateMicTextStatus('STANDBY');
  };

  recognition.onend = () => {
    isRecognizing = false;
    if (micInputBtn) micInputBtn.classList.remove('active');
    updateMicTextStatus('STANDBY');
  };
}

// Log Event to System logs
function logEvent(category, text) {
  if (!terminalLogs) return;
  const line = document.createElement('div');
  const date = new Date();
  const timeStr = date.toTimeString().split(' ')[0];
  line.className = `log-line ${category}`;
  line.textContent = `[${timeStr}] [${category.toUpperCase()}] ${text}`;
  terminalLogs.appendChild(line);
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

// Connect WebSocket
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = window.location.port || '3000';
  const wsUrl = `${protocol}//${window.location.hostname}:${port}?role=dashboard`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    logEvent('system', 'Connected to Bubble AI core server');
    if (connDot) {
      connDot.className = 'status-dot active';
      connText.textContent = 'CONNECTED';
    }
    const chromeDot = document.getElementById('chrome-status-dot');
    if (chromeDot) chromeDot.classList.add('active');
  };
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'status') {
        updateClientCount(data.connectedClients);
      } else if (data.type === 'mic_status') {
        updateMicStatus(data.status);
      } else if (data.type === 'input') {
        // Append input item to conversation history
        addFeedItem(data);
      } else if (data.type === 'ollama_status') {
        updateOllamaStatus(data.status, data.detail, data.models);
      } else if (data.type === 'calendar_status') {
        updateCalendarStatus(data.connected);
      } else if (data.type === 'calendar_log') {
        updateCalendarLogs(data.logs);
      } else if (data.type === 'calendar_data') {
        updateCalendarData(data.today, data.upcoming, data.next);
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  };
  
  ws.onclose = () => {
    logEvent('error', 'WebSocket connection closed. Reconnecting in 3s...');
    if (connDot) {
      connDot.className = 'status-dot inactive';
      connText.textContent = 'OFFLINE';
    }
    updateClientCount(0);
    const chromeDot = document.getElementById('chrome-status-dot');
    if (chromeDot) chromeDot.classList.remove('active');
    const gemmaDot = document.getElementById('gemma-status-dot');
    const llavaDot = document.getElementById('llava-status-dot');
    const calDot = document.getElementById('calendar-status-dot');
    const gmailDot = document.getElementById('gmail-status-dot');
    if (gemmaDot) gemmaDot.classList.remove('active');
    if (llavaDot) llavaDot.classList.remove('active');
    if (calDot) calDot.classList.remove('active');
    if (gmailDot) gmailDot.classList.remove('active');
    setTimeout(connect, 3000);
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    ws.close();
  };
}

// Update client connection telemetry
function updateClientCount(count) {
  activeClientsCount = count;
  const connPill = document.getElementById('conn-pill');
  if (connPill) {
    if (count > 0) {
      connPill.style.color = 'var(--accent-green)';
      connPill.title = `${count} companion APK connected`;
    } else {
      connPill.style.color = 'var(--text-secondary)';
      connPill.title = 'No companion APK connected';
    }
  }
}

// Update Mic Pipeline Status
function updateMicTextStatus(text) {
  if (micStatusText) {
    micStatusText.textContent = text;
  }
  if (micDot) {
    if (text === 'LISTENING') {
      micDot.className = 'status-dot active';
      micDot.style.backgroundColor = 'var(--danger)';
    } else if (text === 'THINKING') {
      micDot.className = 'status-dot active';
      micDot.style.backgroundColor = 'var(--accent-cyan)';
    } else {
      micDot.className = 'status-dot inactive';
      micDot.style.backgroundColor = '';
    }
  }
}

function updateMicStatus(status) {
  if (status === 'listening') {
    updateMicTextStatus('LISTENING');
  } else if (status === 'processing') {
    updateMicTextStatus('THINKING');
  } else {
    updateMicTextStatus('STANDBY');
  }
}

// Update Active AI model & Settings list
function getShortModelName(modelName) {
  let cleanName = modelName.trim().toUpperCase();
  if (cleanName.endsWith(':LATEST')) {
    cleanName = cleanName.replace(':LATEST', '');
  }
  return cleanName;
}

function updateOllamaStatus(status, detail, models) {
  // Update model top bar display
  if (status === 'online') {
    let activeModel = 'ONLINE';
    const match = detail.match(/"([^"]+)"/);
    if (match && match[1]) {
      activeModel = getShortModelName(match[1]);
    }
    if (activeModelName) {
      activeModelName.textContent = activeModel;
    }
  } else {
    if (activeModelName) {
      activeModelName.textContent = 'STANDBY';
    }
  }

  // Update Brain Dot inside settings modal
  const brainDot = document.getElementById('brain-dot');
  if (brainDot) {
    brainDot.className = status === 'online' ? 'status-dot active' : 'status-dot inactive';
  }

  // Update shortcut chip status dots
  const gemmaDot = document.getElementById('gemma-status-dot');
  const llavaDot = document.getElementById('llava-status-dot');
  if (gemmaDot) {
    if (status === 'online') gemmaDot.classList.add('active');
    else gemmaDot.classList.remove('active');
  }
  if (llavaDot) {
    if (status === 'online') llavaDot.classList.add('active');
    else llavaDot.classList.remove('active');
  }
}

// Google Calendar status & Data renderer
function updateCalendarStatus(connected) {
  const statusBadge = document.getElementById('cal-connection-status');
  const actionArea = document.getElementById('cal-action-area');
  const calBadgeDot = document.getElementById('cal-dot');
  
  if (calBadgeDot) {
    calBadgeDot.className = connected ? 'status-dot active' : 'status-dot inactive';
  }
  
  // Update shortcut chip status dots
  const calDot = document.getElementById('calendar-status-dot');
  const gmailDot = document.getElementById('gmail-status-dot');
  if (calDot) {
    if (connected) calDot.classList.add('active');
    else calDot.classList.remove('active');
  }
  if (gmailDot) {
    if (connected) gmailDot.classList.add('active');
    else gmailDot.classList.remove('active');
  }
  
  if (!statusBadge || !actionArea) return;
  
  if (connected) {
    statusBadge.textContent = 'CONNECTED';
    statusBadge.className = 'status-badge status-online';
    actionArea.innerHTML = `<span style="color: #10b981; font-size: 0.75rem; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 0.25rem;">✓ SYNCED WITH GOOGLE</span>`;
  } else {
    statusBadge.textContent = 'DISCONNECTED';
    statusBadge.className = 'status-badge status-offline';
    actionArea.innerHTML = `<a href="/auth/google" class="btn btn-primary btn-full" target="_blank">Connect Calendar</a>`;
  }
}

function updateCalendarLogs(logs) {
  const logsBox = document.getElementById('calendar-logs');
  if (!logsBox) return;
  logsBox.innerHTML = '';
  if (!logs || logs.length === 0) {
    logsBox.innerHTML = '<div class="log-line system">[CALENDAR] Standby...</div>';
    return;
  }
  logs.forEach(log => {
    const line = document.createElement('div');
    line.className = 'log-line system';
    if (log.toLowerCase().includes('error')) {
      line.className = 'log-line error';
    } else if (log.toLowerCase().includes('successful') || log.toLowerCase().includes('fetched')) {
      line.className = 'log-line reply';
    }
    line.textContent = log;
    logsBox.appendChild(line);
  });
}

function formatTime(dateIso) {
  const date = new Date(dateIso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateIso) {
  const date = new Date(dateIso);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimeRange(startIso, endIso) {
  if (!startIso) return '';
  if (startIso.length === 10) {
    return 'All Day';
  }
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : null;
  const formatOpt = { hour: '2-digit', minute: '2-digit' };
  const startStr = start.toLocaleTimeString([], formatOpt);
  if (end) {
    const endStr = end.toLocaleTimeString([], formatOpt);
    return `${startStr} – ${endStr}`;
  }
  return startStr;
}

function formatTimeStr(dateIso) {
  if (!dateIso) return '';
  const date = new Date(dateIso);
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${hours}:${minutes} ${ampm}`;
}

function getCategoryBadges(title) {
  const t = title.toLowerCase();
  const badges = [];
  if (t.includes('dev') || t.includes('code') || t.includes('bug') || t.includes('api') || t.includes('engineering') || t.includes('technical')) {
    badges.push('DEV');
  }
  if (t.includes('sales') || t.includes('client') || t.includes('demo') || t.includes('market') || t.includes('pitch')) {
    badges.push('SALES');
  }
  if (t.includes('design') || t.includes('ui') || t.includes('ux') || t.includes('sketch') || t.includes('product')) {
    badges.push('DESIGN');
  }
  if (t.includes('hr') || t.includes('interview') || t.includes('hire') || t.includes('recruiting') || t.includes('meeting') || t.includes('sync')) {
    badges.push('HR');
  }
  if (badges.length === 0) {
    const options = ['DEV', 'SALES', 'DESIGN', 'HR'];
    const index = title.length % options.length;
    badges.push(options[index]);
  }
  return badges;
}

function updateCalendarData(today, upcoming, next) {
  if (today) lastTodayPayload = today;
  if (upcoming) lastUpcomingPayload = upcoming;

  const upcomingList = document.getElementById('upcoming-meetings-list');
  if (!upcomingList) return;

  // Combine and sort meetings
  const allMeetings = [...localMeetings];
  if (lastTodayPayload) {
    lastTodayPayload.forEach(event => {
      if (!allMeetings.some(e => e.id === event.id)) {
        allMeetings.push(event);
      }
    });
  }
  if (lastUpcomingPayload) {
    lastUpcomingPayload.forEach(event => {
      if (!allMeetings.some(e => e.id === event.id)) {
        allMeetings.push(event);
      }
    });
  }

  // Sort by start time
  allMeetings.sort((a, b) => new Date(a.start) - new Date(b.start));

  if (allMeetings.length > 0) {
    upcomingList.innerHTML = allMeetings.map(event => {
      const startStr = formatTimeStr(event.start);
      const endStr = formatTimeStr(event.end || event.start);
      const badges = getCategoryBadges(event.summary || 'Meeting');
      const badgesHtml = badges.map(b => `<span class="category-badge badge-${b.toLowerCase()}">${b}</span>`).join('');
      const meetLink = event.hangoutLink ? `<a href="${event.hangoutLink}" target="_blank" class="planner-meet-link"><img src="chat.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(1); vertical-align: middle; margin-right: 4px;">Join Google Meet</a>` : '';

      return `
        <div class="planner-meeting-card">
          <div class="meeting-card-title">${escapeHTML(event.summary)}</div>
          <div class="meeting-card-badges">${badgesHtml}</div>
          <div class="meeting-card-duration">
            <span class="duration-time">${startStr}</span>
            <span class="duration-line"></span>
            <span class="duration-time">${endStr}</span>
          </div>
          ${meetLink}
        </div>
      `;
    }).join('');
  } else {
    upcomingList.innerHTML = '<div class="no-events">No upcoming meetings.</div>';
  }
}

// Conversation Management (ChatGPT layout)
function initConversations() {
  const data = localStorage.getItem(CONVS_STORAGE_KEY);
  if (data) {
    try {
      conversations = JSON.parse(data);
    } catch (e) {
      conversations = [];
    }
  }
  
  if (conversations.length === 0) {
    createNewConversation();
  } else {
    // Set active conversation to first
    activeConvId = conversations[0].id;
    renderHistorySidebar();
    loadActiveConversationFeed();
  }
}

function saveConversations() {
  localStorage.setItem(CONVS_STORAGE_KEY, JSON.stringify(conversations));
}

function createNewConversation() {
  const newId = 'conv_' + Date.now();
  const newConv = {
    id: newId,
    title: 'New Conversation',
    type: 'text',
    lastUpdated: new Date().toISOString(),
    messages: []
  };
  conversations.unshift(newConv);
  activeConvId = newId;
  saveConversations();
  renderHistorySidebar();
  loadActiveConversationFeed();
  chatInput.focus();
}

function selectConversation(id) {
  activeConvId = id;
  loadActiveConversationFeed();
  renderHistorySidebar();
}

function deleteConversation(id, event) {
  if (event) event.stopPropagation();
  conversations = conversations.filter(c => c.id !== id);
  saveConversations();
  if (activeConvId === id) {
    if (conversations.length > 0) {
      activeConvId = conversations[0].id;
    } else {
      createNewConversation();
      return;
    }
  }
  renderHistorySidebar();
  loadActiveConversationFeed();
}

// Group conversations by date
function groupConversations(convs) {
  const groups = { today: [], yesterday: [], week: [], older: [] };
  const now = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  
  convs.forEach(c => {
    const updated = new Date(c.lastUpdated);
    const diff = now - updated;
    
    if (diff < oneDay && now.getDate() === updated.getDate()) {
      groups.today.push(c);
    } else if (diff < 2 * oneDay) {
      groups.yesterday.push(c);
    } else if (diff < 7 * oneDay) {
      groups.week.push(c);
    } else {
      groups.older.push(c);
    }
  });
  return groups;
}

// Render conversations sidebar history
function renderHistorySidebar(searchFilter = '') {
  let filteredConvs = conversations;
  if (searchFilter) {
    filteredConvs = conversations.filter(c => 
      c.title.toLowerCase().includes(searchFilter.toLowerCase())
    );
  }
  
  const groups = groupConversations(filteredConvs);
  
  const ids = ['today', 'yesterday', 'week', 'older'];
  ids.forEach(groupId => {
    const container = document.getElementById(`history-${groupId}`);
    if (!container) return;
    
    container.innerHTML = '';
    const items = groups[groupId];
    
    if (items && items.length > 0) {
      container.parentElement.style.display = 'block';
      items.forEach(c => {
        const item = document.createElement('div');
        item.className = `history-item ${c.id === activeConvId ? 'active' : ''}`;
        item.onclick = () => selectConversation(c.id);
        
        let typeIcon = `<img src="chat.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(0.8); vertical-align: middle;">`;
        if (c.type === 'speech') typeIcon = `<img src="chat.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(0.8); vertical-align: middle;">`;
        if (c.type === 'image') typeIcon = `<img src="chat.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(0.8); vertical-align: middle;">`;
        
        item.innerHTML = `
          <span class="history-item-icon">${typeIcon}</span>
          <div class="history-item-details">
            <span class="history-item-title">${escapeHTML(c.title)}</span>
            <span class="history-item-time">${new Date(c.lastUpdated).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
          </div>
          <button class="icon-btn delete-conv-btn" style="opacity: 0; padding: 0.1rem; color: var(--text-secondary);" title="Delete Chat">&times;</button>
        `;
        
        // Show delete button on hover
        item.onmouseenter = () => { item.querySelector('.delete-conv-btn').style.opacity = '1'; };
        item.onmouseleave = () => { item.querySelector('.delete-conv-btn').style.opacity = '0'; };
        item.querySelector('.delete-conv-btn').onclick = (e) => deleteConversation(c.id, e);
        
        container.appendChild(item);
      });
    } else {
      container.parentElement.style.display = 'none';
    }
  });
}

function loadActiveConversationFeed() {
  if (!feedContainer) return;
  feedContainer.innerHTML = '';
  
  const activeConv = conversations.find(c => c.id === activeConvId);
  if (!activeConv || activeConv.messages.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  
  if (emptyState) emptyState.style.display = 'none';
  
  activeConv.messages.forEach(msg => {
    appendMessageToFeedUI(msg);
  });
  
  feedContainer.scrollTop = feedContainer.scrollHeight;
}

function appendMessageToFeedUI(msg) {
  if (emptyState) emptyState.style.display = 'none';
  
  const wrapper = document.createElement('div');
  const isUser = msg.role === 'user';
  wrapper.className = `chat-bubble-wrapper ${isUser ? 'user-align' : 'bubble-align'}`;
  
  const formattedTime = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  let labelText = isUser ? 'YOU' : getShortModelName(msg.model || 'Gemma');
  let labelClass = isUser ? 'user-label' : 'model-label';
  let badgeIcon = isUser 
    ? `<img src="chat.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(1); vertical-align: middle; margin-right: 4px;">` 
    : `<img src="brain.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(1); vertical-align: middle; margin-right: 4px;">`;
  
  let mediaHtml = '';
  if (msg.image) {
    mediaHtml = `<img src="${msg.image}" alt="Uploaded image prompt">`;
  }
  
  wrapper.innerHTML = `
    <div class="bubble-model-header ${labelClass}">
      <span>${badgeIcon}${labelText}</span>
      <span class="bubble-timestamp">${formattedTime}</span>
    </div>
    <div class="chat-bubble ${isUser ? 'user' : 'bubble'}">
      <div class="chat-content">
        <p class="${msg.inputType === 'speech' ? 'speech-content' : ''}">${escapeHTML(msg.content)}</p>
        ${mediaHtml}
      </div>
    </div>
  `;
  
  feedContainer.appendChild(wrapper);
}

// Append message item generated dynamically
function addFeedItem(data) {
  const isUser = data.inputType !== 'bubble';
  const roleStr = isUser ? 'user' : 'assistant';
  
  const newMsg = {
    role: roleStr,
    content: data.content,
    inputType: data.inputType,
    image: data.image || null,
    model: data.model || 'Gemma',
    timestamp: data.timestamp || new Date().toISOString()
  };
  
  // Save message to active conversation
  const activeConv = conversations.find(c => c.id === activeConvId);
  if (activeConv) {
    // If it is the first message, dynamically rename the conversation title
    if (activeConv.messages.length === 0 && isUser) {
      activeConv.title = data.content.length > 25 ? data.content.substring(0, 25) + '...' : data.content;
      activeConv.type = data.inputType;
    }
    
    activeConv.messages.push(newMsg);
    activeConv.lastUpdated = new Date().toISOString();
    saveConversations();
    renderHistorySidebar();
    
    // If conversation is selected, append message to feed UI
    appendMessageToFeedUI(newMsg);
    feedContainer.scrollTop = feedContainer.scrollHeight;
  }
}

// Send Text Chat Message
function sendChatMessage(inputType = 'text', imageB64 = null) {
  const text = chatInput.value.trim();
  if (!text && !imageB64) return;
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'dashboard_chat',
      content: text || 'Uploaded image snapshot analysis request',
      inputType: inputType,
      image: imageB64
    }));
    
    chatInput.value = '';
    chatInput.style.height = 'auto';
  } else {
    logEvent('error', 'Failed to transmit prompt: websocket is disconnected.');
  }
}

// Task Manager CRUD
function initTasks() {
  const data = localStorage.getItem(TASKS_STORAGE_KEY);
  if (data) {
    try {
      tasks = JSON.parse(data);
    } catch (e) {
      tasks = [];
    }
  }
  renderTasks();
}

function saveTasks() {
  localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
}

function renderTasks() {
  if (!tasksList) return;
  tasksList.innerHTML = '';

  if (tasks.length === 0) {
    tasksList.innerHTML = `
      <div class="planner-task-placeholder">
        <div class="placeholder-item"><span class="task-num">1.</span> Schedule a meeting</div>
        <div class="placeholder-item"><span class="task-num">2.</span> Enter a task</div>
        <div class="placeholder-item"><span class="task-num">3.</span> Type here...</div>
      </div>
    `;
    return;
  }

  tasks.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = `planner-task-item ${t.completed ? 'completed' : ''}`;
    
    item.innerHTML = `
      <span class="task-num">${i + 1}.</span>
      <input type="checkbox" class="task-checkbox" ${t.completed ? 'checked' : ''}>
      <span class="task-title ${t.completed ? 'completed' : ''}">${escapeHTML(t.title)}</span>
      <button class="delete-task-btn" title="Delete Task">&times;</button>
    `;

    item.querySelector('.task-checkbox').onchange = () => toggleTask(i);
    item.querySelector('.task-title').onclick = () => toggleTask(i);
    item.querySelector('.delete-task-btn').onclick = (e) => {
      e.stopPropagation();
      deleteTask(i);
    };

    tasksList.appendChild(item);
  });
}

function addTask() {
  const title = prompt('Enter task details:');
  if (title && title.trim()) {
    tasks.push({
      title: title.trim(),
      completed: false
    });
    saveTasks();
    renderTasks();
  }
}

function toggleTask(index) {
  tasks[index].completed = !tasks[index].completed;
  saveTasks();
  renderTasks();
}

function deleteTask(index) {
  tasks.splice(index, 1);
  saveTasks();
  renderTasks();
}

// HTML Helper function to escape text
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Wire Event Listeners
if (toggleSidebarBtn) {
  toggleSidebarBtn.onclick = () => {
    sidebar.classList.add('collapsed');
    expandSidebarBtn.classList.remove('hidden');
  };
}

if (expandSidebarBtn) {
  expandSidebarBtn.onclick = () => {
    sidebar.classList.remove('collapsed');
    expandSidebarBtn.classList.add('hidden');
  };
}

if (newChatBtn) {
  newChatBtn.onclick = createNewConversation;
}

const addMeetingBtn = document.getElementById('add-meeting-btn');
if (addMeetingBtn) {
  addMeetingBtn.onclick = () => {
    const summary = prompt('Enter meeting title:');
    if (!summary || !summary.trim()) return;
    const startTime = prompt('Enter start time (e.g. 10:00 AM):');
    if (!startTime || !startTime.trim()) return;
    const endTime = prompt('Enter end time (e.g. 11:30 AM):');
    
    const start = new Date();
    const end = new Date();
    
    const parseTime = (str, dateObj) => {
      try {
        const match = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (match) {
          let hours = parseInt(match[1]);
          const minutes = parseInt(match[2]);
          const ampm = match[3].toUpperCase();
          if (ampm === 'PM' && hours < 12) hours += 12;
          if (ampm === 'AM' && hours === 12) hours = 0;
          dateObj.setHours(hours, minutes, 0, 0);
        }
      } catch(e) {}
    };
    parseTime(startTime, start);
    if (endTime) parseTime(endTime, end);
    else end.setHours(start.getHours() + 1, start.getMinutes(), 0, 0);
    
    localMeetings.push({
      id: 'local-' + Date.now(),
      summary: summary.trim(),
      start: start.toISOString(),
      end: end.toISOString(),
      hangoutLink: null,
      location: null
    });
    
    updateCalendarData();
  };
}

if (searchHistory) {
  searchHistory.oninput = (e) => {
    renderHistorySidebar(e.target.value);
  };
}

// Textarea auto-sizing & submission listeners
if (chatInput) {
  chatInput.oninput = () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = (chatInput.scrollHeight) + 'px';
  };
  
  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage('text');
    }
  };
}

if (sendMessageBtn) {
  sendMessageBtn.onclick = () => sendChatMessage('text');
}

// File Attachment Handler
if (attachImageBtn) {
  attachImageBtn.onclick = () => imageFileInput.click();
}

if (imageFileInput) {
  imageFileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result;
      // Immediately send as image input type
      sendChatMessage('image', base64);
      imageFileInput.value = '';
    };
    reader.onerror = (err) => console.error('FileReader error:', err);
    reader.readAsDataURL(file);
  };
}

// Voice Trigger Button
if (micInputBtn) {
  micInputBtn.onclick = () => {
    if (!recognition) {
      alert('Speech synthesis or recognition is not supported in this browser.');
      return;
    }
    if (isRecognizing) {
      recognition.stop();
    } else {
      recognition.start();
    }
  };
}

// Model shortcuts chips wiring
const chips = document.querySelectorAll('.shortcut-chip');
chips.forEach(chip => {
  chip.onclick = () => {
    const mode = chip.getAttribute('data-mode');
    if (mode === 'gemma') {
      chatInput.value = '';
      chatInput.focus();
    } else if (mode === 'llava') {
      if (imageFileInput) imageFileInput.click();
    } else if (mode === 'calendar') {
      chatInput.value = 'what is scheduled today';
      chatInput.focus();
    } else if (mode === 'gmail') {
      chatInput.value = 'send an email to ';
      chatInput.focus();
    } else if (mode === 'chrome') {
      chatInput.value = 'search for ';
      chatInput.focus();
    }
  };
});

// Modal Dialog settings managers
if (settingsBtn) {
  settingsBtn.onclick = () => settingsModal.classList.remove('hidden');
}

if (closeSettingsBtn) {
  closeSettingsBtn.onclick = () => settingsModal.classList.add('hidden');
}

window.onclick = (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add('hidden');
  }
};

// Collapsible logs wiring inside modal
if (toggleLogsBtn) {
  toggleLogsBtn.onclick = () => {
    const isExpanded = terminalLogsWrapper.classList.contains('expanded');
    if (isExpanded) {
      terminalLogsWrapper.classList.remove('expanded');
      toggleLogsBtn.textContent = 'Show System Logs';
    } else {
      terminalLogsWrapper.classList.add('expanded');
      toggleLogsBtn.textContent = 'Hide System Logs';
    }
  };
}

// Fetch host IP endpoints
async function fetchIps() {
  try {
    const res = await fetch('/api/ips');
    const data = await res.json();
    if (data.ips && data.ips.length > 0) {
      const mainIp = data.ips[0].address;
      const port = window.location.port || '3000';
      const connectionUrl = `ws://${mainIp}:${port}?role=client`;
      if (wsServerAddress) {
        wsServerAddress.textContent = connectionUrl;
      }
      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(connectionUrl);
          copyBtn.textContent = 'COPIED';
          setTimeout(() => { copyBtn.textContent = 'COPY'; }, 2000);
        };
      }
    }
  } catch (err) {
    console.warn('Failed to fetch IPs from server', err);
  }
}

// Display date header
function renderTodayDate() {
  const dateEl = document.getElementById('planner-date');
  if (dateEl) {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
    dateEl.textContent = `${day}/${month}/${year} - ${dayName}`;
  }
}

// Initialize App
connect();
fetchIps();
renderTodayDate();
initConversations();
initTasks();

// ==========================================
// Conversation Backups History Screen Logic
// ==========================================
// Backup History Variables
let selectedBackupDateVal = null;

// DOM Elements for Backup History
const backupHistoryBtn = document.getElementById('backup-history-btn');
const historyBackupsModal = document.getElementById('history-backups-modal');
const closeBackupsBtn = document.getElementById('close-backups-btn');
const backupSearchInput = document.getElementById('backup-search-input');
const backupSearchBtn = document.getElementById('backup-search-btn');
const backupDatesList = document.getElementById('backup-dates-list');
const selectedBackupDate = document.getElementById('selected-backup-date');
const backupActions = document.getElementById('backup-actions');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportTxtBtn = document.getElementById('export-txt-btn');
const backupMessagesFeed = document.getElementById('backup-messages-feed');

// Show/Hide Modal
if (backupHistoryBtn && historyBackupsModal) {
  backupHistoryBtn.addEventListener('click', () => {
    historyBackupsModal.classList.remove('hidden');
    if (settingsModal) {
      settingsModal.classList.add('hidden');
    }
    loadBackupDates();
  });
}

if (closeBackupsBtn && historyBackupsModal) {
  closeBackupsBtn.addEventListener('click', () => {
    historyBackupsModal.classList.add('hidden');
  });
}

// Close on clicking overlay
window.addEventListener('click', (e) => {
  if (e.target === historyBackupsModal) {
    historyBackupsModal.classList.add('hidden');
  }
});

// Load dates from server API
async function loadBackupDates() {
  try {
    const res = await fetch('/api/history/dates');
    const data = await res.json();
    if (data.success && data.dates) {
      renderBackupDates(data.dates);
    }
  } catch (err) {
    console.error('Failed to load backup dates:', err);
  }
}

// Render date list
function renderBackupDates(dates) {
  if (!backupDatesList) return;
  backupDatesList.innerHTML = '';
  
  if (dates.length === 0) {
    backupDatesList.innerHTML = '<div style="padding: 15px; color: var(--text-secondary); text-align: center; font-size: 0.85rem;">No backups found</div>';
    return;
  }
  
  dates.forEach(date => {
    const item = document.createElement('div');
    item.className = 'dates-list-item';
    if (date === selectedBackupDateVal) item.classList.add('active');
    item.innerHTML = `
      <span><img src="calendar.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(1); vertical-align: middle; margin-right: 6px;">${date}</span>
      <span>➔</span>
    `;
    item.addEventListener('click', () => {
      document.querySelectorAll('.dates-list-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      selectedBackupDateVal = date;
      loadBackupMessages(date);
    });
    backupDatesList.appendChild(item);
  });
}

// Load messages for a date
async function loadBackupMessages(date) {
  try {
    if (selectedBackupDate) {
      selectedBackupDate.textContent = `DATE: ${date}`;
    }
    if (backupActions) {
      backupActions.classList.remove('hidden');
    }
    if (backupMessagesFeed) {
      backupMessagesFeed.innerHTML = '<div class="empty-backup-state">Loading messages...</div>';
    }
    
    const res = await fetch(`/api/history/messages?date=${date}`);
    const data = await res.json();
    if (data.success && data.messages) {
      renderBackupMessages(data.messages);
    }
  } catch (err) {
    console.error('Failed to load backup messages:', err);
    if (backupMessagesFeed) {
      backupMessagesFeed.innerHTML = '<div class="empty-backup-state" style="color: var(--danger);">Failed to load messages</div>';
    }
  }
}

// Render message logs
function renderBackupMessages(messages) {
  if (!backupMessagesFeed) return;
  backupMessagesFeed.innerHTML = '';
  
  if (messages.length === 0) {
    backupMessagesFeed.innerHTML = '<div class="empty-backup-state">No messages logged for this date</div>';
    return;
  }
  
  messages.forEach(msg => {
    const isUser = msg.sender === 'user';
    const isServer = msg.sender === 'server';
    
    const item = document.createElement('div');
    item.className = `chat-bubble-wrapper ${isUser ? 'user' : (isServer ? 'server' : 'assistant')}`;
    
    let bubbleClass = 'chat-bubble';
    if (isUser) {
      bubbleClass += ' user-bubble';
    } else if (isServer) {
      bubbleClass += ' server-bubble';
    } else {
      bubbleClass += ' assistant-bubble';
    }
    
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const senderName = isUser ? 'YOU' : (isServer ? 'SYSTEM' : 'BUBBLE');
    const modelTag = msg.model ? `<span class="message-model-tag" style="background: rgba(0, 240, 255, 0.1); color: var(--accent-cyan); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; margin-left: 8px; font-weight: 500;">${msg.model}</span>` : '';
    
    item.innerHTML = `
      <div class="message-meta" style="margin-bottom: 4px; display: flex; align-items: center; font-size: 0.75rem; color: var(--text-secondary);">
        <span class="message-sender" style="font-weight: 600; color: ${isUser ? 'var(--text-primary)' : 'var(--accent-cyan)'};">${senderName}</span>
        ${modelTag}
        <span class="message-time" style="margin-left: auto; opacity: 0.6;">${time}</span>
      </div>
      <div class="${bubbleClass}" style="max-width: 90%; background: ${isUser ? 'rgba(0, 240, 255, 0.05)' : 'var(--bg-surface)'}; border: 1px solid ${isUser ? 'rgba(0, 240, 255, 0.2)' : 'var(--border-color)'}; padding: 0.75rem 1rem; border-radius: 8px;">
        <p style="margin: 0; color: var(--text-primary); font-size: 0.85rem; line-height: 1.4;">${msg.content}</p>
      </div>
    `;
    backupMessagesFeed.appendChild(item);
  });
  
  backupMessagesFeed.scrollTop = backupMessagesFeed.scrollHeight;
}

// Exports
if (exportJsonBtn) {
  exportJsonBtn.addEventListener('click', () => {
    if (selectedBackupDateVal) {
      window.open(`/api/history/export?date=${selectedBackupDateVal}&format=json`, '_blank');
    }
  });
}
if (exportTxtBtn) {
  exportTxtBtn.addEventListener('click', () => {
    if (selectedBackupDateVal) {
      window.open(`/api/history/export?date=${selectedBackupDateVal}&format=txt`, '_blank');
    }
  });
}

// Search backups
if (backupSearchBtn && backupSearchInput) {
  backupSearchBtn.addEventListener('click', performBackupSearch);
  backupSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performBackupSearch();
  });
}

async function performBackupSearch() {
  const query = backupSearchInput.value.trim();
  if (!query) {
    loadBackupDates();
    return;
  }
  
  try {
    if (backupMessagesFeed) {
      backupMessagesFeed.innerHTML = '<div class="empty-backup-state">Searching backups...</div>';
    }
    
    const res = await fetch(`/api/history/search?query=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (data.success && data.results) {
      renderSearchResults(data.results);
    }
  } catch (err) {
    console.error('Search failed:', err);
  }
}

function renderSearchResults(results) {
  if (!backupMessagesFeed) return;
  backupMessagesFeed.innerHTML = '';
  
  if (selectedBackupDate) {
    selectedBackupDate.textContent = 'SEARCH RESULTS';
  }
  if (backupActions) {
    backupActions.classList.add('hidden');
  }
  
  if (results.length === 0) {
    backupMessagesFeed.innerHTML = '<div class="empty-backup-state">No matching messages found across history</div>';
    return;
  }
  
  // Group results by date
  const groups = {};
  results.forEach(res => {
    if (!groups[res.date]) groups[res.date] = [];
    groups[res.date].push(res);
  });
  
  Object.keys(groups).forEach(date => {
    const groupContainer = document.createElement('div');
    groupContainer.className = 'search-result-group';
    
    const header = document.createElement('div');
    header.className = 'search-result-date-header';
    header.innerHTML = `<img src="calendar.svg" class="icon-svg-inline" style="width: 12px; height: 12px; filter: invert(1); vertical-align: middle; margin-right: 6px;">Date: ${date} (${groups[date].length} matches)`;
    header.addEventListener('click', () => {
      selectedBackupDateVal = date;
      loadBackupMessages(date);
      // Select date in sidebar
      document.querySelectorAll('.dates-list-item').forEach(el => {
        if (el.textContent.includes(date)) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    });
    groupContainer.appendChild(header);
    
    const msgList = document.createElement('div');
    msgList.style.padding = '0.75rem';
    msgList.style.display = 'flex';
    msgList.style.flexDirection = 'column';
    msgList.style.gap = '0.5rem';
    
    groups[date].forEach(msg => {
      const isUser = msg.sender === 'user';
      const isServer = msg.sender === 'server';
      
      const item = document.createElement('div');
      item.className = `chat-bubble-wrapper ${isUser ? 'user' : (isServer ? 'server' : 'assistant')}`;
      
      let bubbleClass = 'chat-bubble';
      if (isUser) {
        bubbleClass += ' user-bubble';
      } else if (isServer) {
        bubbleClass += ' server-bubble';
      } else {
        bubbleClass += ' assistant-bubble';
      }
      
      const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const senderName = isUser ? 'YOU' : (isServer ? 'SYSTEM' : 'BUBBLE');
      const modelTag = msg.model ? `<span class="message-model-tag" style="background: rgba(0, 240, 255, 0.1); color: var(--accent-cyan); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; margin-left: 8px; font-weight: 500;">${msg.model}</span>` : '';
      
      item.innerHTML = `
        <div class="message-meta" style="margin-bottom: 4px; display: flex; align-items: center; font-size: 0.75rem; color: var(--text-secondary);">
          <span class="message-sender" style="font-weight: 600; color: ${isUser ? 'var(--text-primary)' : 'var(--accent-cyan)'};">${senderName}</span>
          ${modelTag}
          <span class="message-time" style="margin-left: auto; opacity: 0.6;">${time}</span>
        </div>
        <div class="${bubbleClass}" style="max-width: 90%; background: ${isUser ? 'rgba(0, 240, 255, 0.05)' : 'var(--bg-surface)'}; border: 1px solid ${isUser ? 'rgba(0, 240, 255, 0.2)' : 'var(--border-color)'}; padding: 0.75rem 1rem; border-radius: 8px;">
          <p style="margin: 0; color: var(--text-primary); font-size: 0.85rem; line-height: 1.4;">${msg.content}</p>
        </div>
      `;
      msgList.appendChild(item);
    });
    
    groupContainer.appendChild(msgList);
    backupMessagesFeed.appendChild(groupContainer);
  });
}

// ==========================================
// Rotating Placeholder Text Logic
// ==========================================
const placeholders = [
  "Ask Bubble anything...",
  "Search the web, schedule meetings, or send emails...",
  "What's on your agenda today?",
  "Need help with your calendar, tasks, or research?",
  "Try: \"What's on my calendar today?\""
];
let currentPlaceholderIndex = 0;
let placeholderIntervalId = null;

function startPlaceholderRotation() {
  if (placeholderIntervalId) return;
  placeholderIntervalId = setInterval(() => {
    if (chatInput.value.length > 0) return; // don't rotate if user is typing
    if (!chatPlaceholder) return;
    
    // Step 1: Fade out
    chatPlaceholder.classList.add('fade-out');
    
    setTimeout(() => {
      // Step 2: Change text
      currentPlaceholderIndex = (currentPlaceholderIndex + 1) % placeholders.length;
      chatPlaceholder.textContent = placeholders[currentPlaceholderIndex];
      // Step 3: Fade in
      chatPlaceholder.classList.remove('fade-out');
    }, 400); // matches CSS transition duration
  }, 3500); // cycle every 3.5 seconds
}

function stopPlaceholderRotation() {
  if (placeholderIntervalId) {
    clearInterval(placeholderIntervalId);
    placeholderIntervalId = null;
  }
}

function updatePlaceholderState() {
  if (!chatPlaceholder) return;
  if (chatInput.value.length > 0) {
    chatPlaceholder.style.display = 'none';
    stopPlaceholderRotation();
  } else {
    chatPlaceholder.style.display = 'block';
    startPlaceholderRotation();
  }
}

if (chatInput) {
  chatInput.addEventListener('input', updatePlaceholderState);
  chatInput.addEventListener('change', updatePlaceholderState);
  chatInput.addEventListener('keyup', updatePlaceholderState);

  // Override the native value property descriptor to intercept programmatic modifications
  try {
    const originalValueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(chatInput, 'value', {
      get() {
        return originalValueDescriptor.get.call(this);
      },
      set(val) {
        originalValueDescriptor.set.call(this, val);
        updatePlaceholderState();
      }
    });
  } catch (err) {
    console.warn('Could not override value descriptor:', err);
  }

  // Initialize placeholder rotation
  updatePlaceholderState();
}
