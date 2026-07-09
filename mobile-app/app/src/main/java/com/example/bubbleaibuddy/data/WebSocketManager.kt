package com.example.bubbleaibuddy.data

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject

class WebSocketManager(
    private val onConnectionChanged: (Boolean) -> Unit,
    private val onMessageReceived: (String) -> Unit
) {
    private val client = OkHttpClient()
    private var webSocket: WebSocket? = null
    var isConnected = false
        private set

    fun connect(url: String) {
        disconnect()
        
        Log.d("WebSocketManager", "Connecting to $url")
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                Log.d("WebSocketManager", "Connection opened successfully")
                isConnected = true
                onConnectionChanged(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Log.d("WebSocketManager", "Message received: $text")
                onMessageReceived(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // Not using binary messages
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("WebSocketManager", "Connection closed: $reason ($code)")
                isConnected = false
                onConnectionChanged(false)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                Log.e("WebSocketManager", "Connection failure: ${t.message}", t)
                isConnected = false
                onConnectionChanged(false)
            }
        })
    }

    fun sendMessage(type: String, content: String): Boolean {
        if (!isConnected || webSocket == null) {
            Log.w("WebSocketManager", "Cannot send message, WebSocket not connected")
            return false
        }
        
        return try {
            val json = JSONObject().apply {
                put("type", type)
                put("content", content)
            }
            val payload = json.toString()
            Log.d("WebSocketManager", "Sending payload of type $type")
            webSocket?.send(payload) ?: false
        } catch (e: Exception) {
            Log.e("WebSocketManager", "Failed to build or send message JSON", e)
            false
        }
    }

    fun sendBrowserSearch(query: String): Boolean {
        if (!isConnected || webSocket == null) {
            Log.w("WebSocketManager", "Cannot send browser search, WebSocket not connected")
            return false
        }
        
        return try {
            val json = JSONObject().apply {
                put("type", "browser_search")
                put("query", query)
            }
            val payload = json.toString()
            Log.d("WebSocketManager", "Sending browser search payload")
            webSocket?.send(payload) ?: false
        } catch (e: Exception) {
            Log.e("WebSocketManager", "Failed to build or send browser search JSON", e)
            false
        }
    }

    fun disconnect() {
        if (webSocket != null) {
            Log.d("WebSocketManager", "Disconnecting")
            webSocket?.close(1000, "Client disconnect request")
            webSocket = null
        }
        isConnected = false
        onConnectionChanged(false)
    }
}
