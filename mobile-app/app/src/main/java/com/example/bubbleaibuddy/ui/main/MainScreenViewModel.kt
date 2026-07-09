package com.example.bubbleaibuddy.ui.main

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.bubbleaibuddy.data.WebSocketManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket

data class ChatItem(
    val type: String, // "text", "speech", "image" (from User) or "bubble" (from Bubble)
    val content: String,
    val timestamp: Long = System.currentTimeMillis()
)

class MainScreenViewModel(application: Application) : AndroidViewModel(application) {
    private val sharedPrefs = application.getSharedPreferences("bubble_ai_buddy_prefs", Context.MODE_PRIVATE)

    private val _serverIp = MutableStateFlow(sharedPrefs.getString("server_ip", "") ?: "")
    val serverIp: StateFlow<String> = _serverIp.asStateFlow()

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    private val _isConnecting = MutableStateFlow(false)
    val isConnecting: StateFlow<Boolean> = _isConnecting.asStateFlow()

    private val _statusText = MutableStateFlow("Disconnected")
    val statusText: StateFlow<String> = _statusText.asStateFlow()

    // Local chat history list flow
    private val _chatHistory = MutableStateFlow<List<ChatItem>>(emptyList())
    val chatHistory: StateFlow<List<ChatItem>> = _chatHistory.asStateFlow()

    // Server-stored conversation backups flow (for date-wise history screen)
    private val _historyDates = MutableStateFlow<List<String>>(emptyList())
    val historyDates: StateFlow<List<String>> = _historyDates.asStateFlow()

    private val _historyMessages = MutableStateFlow<List<ChatItem>>(emptyList())
    val historyMessages: StateFlow<List<ChatItem>> = _historyMessages.asStateFlow()

    private val _selectedHistoryDate = MutableStateFlow<String?>(null)
    val selectedHistoryDate: StateFlow<String?> = _selectedHistoryDate.asStateFlow()

    private val _latestScreenshot = MutableStateFlow<String?>(null)
    val latestScreenshot: StateFlow<String?> = _latestScreenshot.asStateFlow()

    private val _isScreenshotDecoded = MutableStateFlow(false)
    val isScreenshotDecoded: StateFlow<Boolean> = _isScreenshotDecoded.asStateFlow()

    private val _screenshotError = MutableStateFlow<String?>(null)
    val screenshotError: StateFlow<String?> = _screenshotError.asStateFlow()

    private var hasLoggedPreviewReceiving = false

    fun setScreenshotDecoded(success: Boolean, errorMsg: String? = null) {
        if (success) {
            _screenshotError.value = null
            _isScreenshotDecoded.value = true
            if (!hasLoggedPreviewReceiving) {
                addChatHistory("bubble", "Browser preview receiving")
                hasLoggedPreviewReceiving = true
            }
        } else {
            _screenshotError.value = errorMsg
            _isScreenshotDecoded.value = false
            if (errorMsg != null) {
                addChatHistory("bubble", errorMsg)
            }
        }
    }

    private val wsManager = WebSocketManager(
        onConnectionChanged = { connected ->
            _isConnected.value = connected
            _isConnecting.value = false
            if (connected) {
                _statusText.value = "Connected"
                sharedPrefs.edit().putString("server_ip", _serverIp.value).apply()
                addChatHistory("bubble", "Server connected")
            } else {
                _statusText.value = "Disconnected"
                _latestScreenshot.value = null
                _isScreenshotDecoded.value = false
                _screenshotError.value = null
                hasLoggedPreviewReceiving = false
            }
        },
        onMessageReceived = { message ->
            Log.d("MainScreenViewModel", "Received socket msg: $message")
            try {
                val json = JSONObject(message)
                val type = json.optString("type")
                val content = json.optString("content")
                if (type == "thinking") {
                    _statusText.value = "Thinking"
                } else if (type == "reply") {
                    _statusText.value = "Connected"
                    addChatHistory("bubble", content) // add Bubble response to logs!
                } else if (type == "browser_search_status") {
                    val status = json.optString("status")
                    val query = json.optString("query")
                    val error = json.optString("error")
                    when (status) {
                        "received" -> {
                            _latestScreenshot.value = null
                            _isScreenshotDecoded.value = false
                            _screenshotError.value = null
                            hasLoggedPreviewReceiving = false
                            addChatHistory("bubble", "Laptop server received query: \"$query\"")
                        }
                        "chrome_opened", "Chrome search started" -> {
                            addChatHistory("bubble", "Chrome search started")
                        }
                        "search_completed", "Search opened on laptop" -> {
                            addChatHistory("bubble", "Search opened on laptop")
                        }
                        "failed" -> {
                            addChatHistory("bubble", "Search failed: $error")
                        }
                        "Done" -> {
                            addChatHistory("bubble", "Done")
                        }
                        else -> {
                            if (status.isNotEmpty()) {
                                addChatHistory("bubble", status)
                            }
                        }
                    }
                } else if (type == "browser_screenshot") {
                    val base64Image = json.optString("image")
                    _latestScreenshot.value = base64Image
                } else if (type == "chrome_error") {
                    val error = json.optString("error")
                    addChatHistory("bubble", "Chrome Error: $error")
                } else if (type == "history_dates") {
                    val jsonArray = json.optJSONArray("dates")
                    val dateList = mutableListOf<String>()
                    if (jsonArray != null) {
                        for (i in 0 until jsonArray.length()) {
                            dateList.add(jsonArray.getString(i))
                        }
                    }
                    _historyDates.value = dateList
                } else if (type == "history_messages") {
                    val jsonArray = json.optJSONArray("messages")
                    val msgList = mutableListOf<ChatItem>()
                    if (jsonArray != null) {
                        for (i in 0 until jsonArray.length()) {
                            val msgObj = jsonArray.getJSONObject(i)
                            val sender = msgObj.optString("sender")
                            val contentStr = msgObj.optString("content")
                            val timestampVal = msgObj.optLong("timestamp", System.currentTimeMillis())
                            val inputTypeVal = msgObj.optString("inputType", "text")
                            
                            val itemType = if (sender == "user") inputTypeVal else "bubble"
                            val modelVal = msgObj.optString("model")
                            val displayContent = if (sender == "bubble" && modelVal.isNotEmpty()) {
                                "[$modelVal] $contentStr"
                            } else {
                                contentStr
                            }
                            
                            msgList.add(ChatItem(itemType, displayContent, timestampVal))
                        }
                    }
                    _historyMessages.value = msgList
                }
            } catch (e: Exception) {
                Log.e("MainScreenViewModel", "Error parsing server message", e)
            }
        }
    )

    init {
        // Trigger auto discovery when app opens
        discoverAndConnect()
    }

    // Helper to fetch own Wi-Fi IP
    private fun getLocalWifiIpAddress(): String? {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val networkInterface = interfaces.nextElement()
                if (networkInterface.isLoopback || !networkInterface.isUp) continue
                val addresses = networkInterface.inetAddresses
                while (addresses.hasMoreElements()) {
                    val address = addresses.nextElement()
                    val hostAddress = address.hostAddress
                    if (!address.isLoopbackAddress && hostAddress != null && hostAddress.indexOf(':') < 0) {
                        return hostAddress
                    }
                }
            }
        } catch (e: Exception) {
            Log.e("MainScreenViewModel", "Error getting local IP", e)
        }
        return null
    }

    // Low-overhead TCP port probe (timeout 200ms)
    private suspend fun probeIp(ip: String, port: Int): Boolean = withContext(Dispatchers.IO) {
        try {
            val socket = Socket()
            socket.connect(InetSocketAddress(ip, port), 200)
            socket.close()
            true
        } catch (e: Exception) {
            false
        }
    }

    // Wi-Fi /24 Subnet Scan for Port 3000
    fun discoverAndConnect() {
        viewModelScope.launch(Dispatchers.Default) {
            _isConnecting.value = true
            _statusText.value = "Scanning Wi-Fi for Bubble Server..."
            
            val localIp = getLocalWifiIpAddress()
            
            // Emulator testing fallback
            if (localIp == "10.0.2.15") {
                _statusText.value = "Emulator detected. Syncing to host..."
                if (probeIp("10.0.2.2", 3001)) {
                    _serverIp.value = "10.0.2.2"
                    connect()
                    return@launch
                }
            }

            if (localIp == null) {
                // Try last stored IP if wifi check fails
                val stored = sharedPrefs.getString("server_ip", "") ?: ""
                if (stored.isNotEmpty()) {
                    _statusText.value = "Wi-Fi offline. Trying stored IP..."
                    _serverIp.value = stored
                    connect()
                } else {
                    _isConnecting.value = false
                    _statusText.value = "Wi-Fi offline. Open Settings."
                }
                return@launch
            }

            val parts = localIp.split(".")
            if (parts.size != 4) {
                _isConnecting.value = false
                _statusText.value = "Subnet resolution failed. Open Settings."
                return@launch
            }

            val prefix = "${parts[0]}.${parts[1]}.${parts[2]}."
            
            // Concurrently probe all 254 subnet addresses
            val jobs = (1..254).map { i ->
                async {
                    val targetIp = prefix + i
                    if (probeIp(targetIp, 3001)) targetIp else null
                }
            }

            val foundIps = jobs.awaitAll().filterNotNull()
            if (foundIps.isNotEmpty()) {
                val serverIp = foundIps[0]
                _statusText.value = "Server found at $serverIp. Syncing..."
                _serverIp.value = serverIp
                connect()
            } else {
                // Last try: connect to last working IP
                val stored = sharedPrefs.getString("server_ip", "") ?: ""
                if (stored.isNotEmpty() && probeIp(stored, 3001)) {
                    _statusText.value = "Found stored server. Syncing..."
                    _serverIp.value = stored
                    connect()
                } else {
                    _isConnecting.value = false
                    _statusText.value = "Bubble not found. Configure in Settings."
                }
            }
        }
    }

    fun updateServerIp(ip: String) {
        _serverIp.value = ip
    }

    fun toggleConnection() {
        if (_isConnected.value) {
            disconnect()
        } else {
            connect()
        }
    }

    fun connect() {
        var ip = _serverIp.value.trim()
        if (ip.isEmpty()) {
            _statusText.value = "Please enter an IP address"
            return
        }

        if (!ip.startsWith("ws://") && !ip.startsWith("wss://")) {
            ip = "ws://$ip"
        }
        
        if (!ip.substring(5).contains(":")) {
            ip = "$ip:3001"
        }
        
        if (!ip.contains("role=")) {
            ip = if (ip.contains("?")) {
                "$ip&role=client"
            } else {
                "$ip?role=client"
            }
        }

        _isConnecting.value = true
        _statusText.value = "Connecting..."
        
        viewModelScope.launch {
            try {
                wsManager.connect(ip)
            } catch (e: Exception) {
                Log.e("MainScreenViewModel", "Connect error", e)
                _isConnected.value = false
                _isConnecting.value = false
                _statusText.value = "Connection failed: ${e.message}"
            }
        }
    }

    private fun disconnect() {
        wsManager.disconnect()
    }

    fun addChatHistory(type: String, content: String) {
        val newItem = ChatItem(type, content)
        _chatHistory.value = _chatHistory.value + listOf(newItem) // chronological: append to bottom
    }

    private fun isWebSearchIntent(text: String): Boolean {
        val lower = text.lowercase()
        
        val calendarActionTriggers = listOf(
            "rename", "change", "move", "delete", "cancel", "reschedule", 
            "schedule a", "create", "book", "add "
        )
        val emailTriggers = listOf(
            "email", "gmail", "send invite", "send invitation", "recipient email"
        )
        val readCalendarTriggers = listOf(
            "calendar", "agenda", "schedule", "plans", "events", "meetings", "appointments",
            "what do i have", "anything today", "anything tomorrow", "do i have anything", "any plans"
        )
        
        val isCalendarAction = calendarActionTriggers.any { lower.contains(it) }
        val isEmailAction = emailTriggers.any { lower.contains(it) }
        val isCalendarRead = readCalendarTriggers.any { lower.contains(it) } && !lower.contains("search")
        
        if (isCalendarAction || isEmailAction || isCalendarRead) {
            return false
        }
        
        val searchTriggers = listOf(
            "search", "google", "search for", "open chrome and search", "youtube", "play on youtube",
            "browse", "look up", "find online", "open chrome", "latest news", "nearby"
        )
        return searchTriggers.any { lower.contains(it) }
    }

    fun sendText(text: String) {
        viewModelScope.launch {
            if (text.isNotBlank()) {
                if (isWebSearchIntent(text)) {
                    _latestScreenshot.value = null
                    _isScreenshotDecoded.value = false
                    _screenshotError.value = null
                    hasLoggedPreviewReceiving = false
                    addChatHistory("text", text)
                    addChatHistory("bubble", "Search command detected")
                    addChatHistory("bubble", "Search command sent")
                    val sent = wsManager.sendBrowserSearch(text)
                    if (!sent) {
                        _statusText.value = "Failed to send search (not connected)"
                    }
                } else {
                    val sent = wsManager.sendMessage("text", text)
                    if (sent) {
                        addChatHistory("text", text)
                    } else {
                        _statusText.value = "Failed to send text (not connected)"
                    }
                }
            }
        }
    }

    fun sendSpeech(transcript: String) {
        viewModelScope.launch {
            if (transcript.isNotBlank()) {
                if (isWebSearchIntent(transcript)) {
                    _latestScreenshot.value = null
                    _isScreenshotDecoded.value = false
                    _screenshotError.value = null
                    hasLoggedPreviewReceiving = false
                    addChatHistory("speech", transcript)
                    addChatHistory("bubble", "Search command detected")
                    addChatHistory("bubble", "Search command sent")
                    val sent = wsManager.sendBrowserSearch(transcript)
                    if (!sent) {
                        _statusText.value = "Failed to send voice search (not connected)"
                    }
                } else {
                    val sent = wsManager.sendMessage("speech", transcript)
                    if (sent) {
                        addChatHistory("speech", transcript)
                    } else {
                        _statusText.value = "Failed to send voice (not connected)"
                    }
                }
            }
        }
    }

    fun sendImage(base64Image: String) {
        viewModelScope.launch {
            val sent = wsManager.sendMessage("image", base64Image)
            if (sent) {
                addChatHistory("image", base64Image)
            } else {
                _statusText.value = "Failed to send snapshot (not connected)"
            }
        }
    }

    fun sendFile(fileName: String, fileContent: String) {
        viewModelScope.launch {
            if (fileContent.isNotBlank()) {
                val sent = wsManager.sendMessage("file", fileContent)
                if (sent) {
                    addChatHistory("text", "Shared file: $fileName")
                } else {
                    _statusText.value = "Failed to send file (not connected)"
                }
            }
        }
    }

    // Notify the server about microphone recording status
    fun sendMicStatus(isListening: Boolean) {
        viewModelScope.launch {
            val status = if (isListening) "listening" else "idle"
            wsManager.sendMessage("mic_status", status)
        }
    }

    fun clearChatHistory() {
        _chatHistory.value = emptyList()
    }

    fun fetchHistoryDates() {
        viewModelScope.launch {
            wsManager.sendMessage("get_history_dates", "")
        }
    }

    fun fetchHistoryMessages(date: String) {
        viewModelScope.launch {
            _selectedHistoryDate.value = date
            wsManager.sendMessage("get_history_messages", date)
        }
    }

    fun clearSelectedHistoryDate() {
        _selectedHistoryDate.value = null
        _historyMessages.value = emptyList()
    }

    override fun onCleared() {
        super.onCleared()
        wsManager.disconnect()
    }
}
