package com.example.bubbleaibuddy.ui.main

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview as CameraPreview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import com.example.bubbleaibuddy.R
import java.io.File

enum class ScreenType {
    AI_MIC, CHAT_LOGS, BROWSER_PREVIEW, HISTORY
}

@Composable
fun MainScreen(
    onItemClick: (NavKey) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: MainScreenViewModel = viewModel()
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val serverIp by viewModel.serverIp.collectAsState()
    val isConnected by viewModel.isConnected.collectAsState()
    val isConnecting by viewModel.isConnecting.collectAsState()
    val statusText by viewModel.statusText.collectAsState()
    val chatHistory by viewModel.chatHistory.collectAsState()

    // Text-to-Speech (TTS) engine initialization and configuration
    var tts by remember { mutableStateOf<TextToSpeech?>(null) }
    var isTtsReady by remember { mutableStateOf(false) }
    var lastSpokenTimestamp by remember { mutableStateOf(0L) }

    DisposableEffect(context) {
        var ttsInstance: TextToSpeech? = null
        ttsInstance = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                ttsInstance?.let { t ->
                    // Pitch: 1.15f (feminine, friendly), SpeechRate: 0.95f (deliberate, warm)
                    t.setPitch(1.15f)
                    t.setSpeechRate(0.95f)

                    // Configure Friday-like accent (Irish female voice) or fallbacks
                    val voices = t.voices
                    if (voices != null) {
                        var femaleVoice: android.speech.tts.Voice? = null
                        // 1. Search for English-Ireland (en-IE) female voice
                        for (voice in voices) {
                            if (voice.locale.language == "en" && voice.locale.country.lowercase() == "ie" &&
                                (voice.name.lowercase().contains("female") || voice.name.lowercase().contains("network"))
                            ) {
                                femaleVoice = voice
                                break
                            }
                        }
                        // 2. Search for any English-Ireland voice
                        if (femaleVoice == null) {
                            for (voice in voices) {
                                if (voice.locale.language == "en" && voice.locale.country.lowercase() == "ie") {
                                    femaleVoice = voice
                                    break
                                }
                            }
                        }
                        // 3. Search for English-UK (en-GB) female voice
                        if (femaleVoice == null) {
                            for (voice in voices) {
                                if (voice.locale.language == "en" && voice.locale.country.lowercase() == "gb" &&
                                    (voice.name.lowercase().contains("female") || voice.name.lowercase().contains("network"))
                                ) {
                                    femaleVoice = voice
                                    break
                                }
                            }
                        }
                        // 4. Fallback search for English-US female voice
                        if (femaleVoice == null) {
                            for (voice in voices) {
                                if (voice.locale.language == "en" && (
                                    voice.name.lowercase().contains("female") ||
                                    voice.name.lowercase().contains("en-us-x-sfg") ||
                                    voice.name.lowercase().contains("network")
                                )) {
                                    femaleVoice = voice
                                    break
                                }
                            }
                        }

                        if (femaleVoice != null) {
                            try {
                                t.voice = femaleVoice
                                Log.d("MainScreen", "Friday TTS voice set successfully: ${femaleVoice.name}")
                            } catch (e: Exception) {
                                Log.e("MainScreen", "Failed to set Friday TTS voice", e)
                            }
                        } else {
                            try {
                                t.language = java.util.Locale("en", "IE")
                                Log.d("MainScreen", "TTS locale set to en-IE fallback language")
                            } catch (e: Exception) {
                                t.language = java.util.Locale.US
                            }
                        }
                    }
                    isTtsReady = true
                }
            } else {
                Log.e("MainScreen", "TextToSpeech engine initialization failed")
            }
        }
        tts = ttsInstance
        onDispose {
            ttsInstance?.stop()
            ttsInstance?.shutdown()
        }
    }

    // Speak Bubble replies out loud automatically
    LaunchedEffect(chatHistory, isTtsReady) {
        if (isTtsReady && chatHistory.isNotEmpty()) {
            val lastItem = chatHistory.last()
            if (lastItem.type == "bubble" && lastItem.timestamp > lastSpokenTimestamp) {
                lastSpokenTimestamp = lastItem.timestamp
                tts?.speak(lastItem.content, TextToSpeech.QUEUE_FLUSH, null, "bubble_speech_${lastItem.timestamp}")
            }
        }
    }

    var currentScreen by remember { mutableStateOf(ScreenType.AI_MIC) }
    var showSettingsDialog by remember { mutableStateOf(false) }
    var showCameraDialog by remember { mutableStateOf(false) }

    // Permissions states
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        )
    }
    var hasMicPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions(),
        onResult = { permissions ->
            hasCameraPermission = permissions[Manifest.permission.CAMERA] ?: hasCameraPermission
            hasMicPermission = permissions[Manifest.permission.RECORD_AUDIO] ?: hasMicPermission
        }
    )

    val docPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent(),
        onResult = { uri ->
            uri?.let {
                try {
                    context.contentResolver.openInputStream(uri)?.use { inputStream ->
                        val text = inputStream.bufferedReader().use { it.readText() }
                        val fileName = getFileName(context, uri)
                        viewModel.sendFile(fileName, text)
                    }
                } catch (e: Exception) {
                    Log.e("MainScreen", "Failed to read file contents", e)
                }
            }
        }
    )

    // Request permissions at startup
    LaunchedEffect(Unit) {
        permissionLauncher.launch(
            arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        )
    }

    // Voice recognition setup
    var isListeningSpeech by remember { mutableStateOf(false) }
    var speechTranscript by remember { mutableStateOf("") }

    val speechRecognizer = remember { SpeechRecognizer.createSpeechRecognizer(context) }
    val speechIntent = remember {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
    }

    val speechListener = remember {
        object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                isListeningSpeech = true
                viewModel.sendMicStatus(true)
                speechTranscript = "Listening..."
            }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {
                isListeningSpeech = false
                viewModel.sendMicStatus(false)
            }
            override fun onError(error: Int) {
                isListeningSpeech = false
                viewModel.sendMicStatus(false)
                val errorMsg = when (error) {
                    SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
                    SpeechRecognizer.ERROR_CLIENT -> "Client error"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Permissions missing"
                    SpeechRecognizer.ERROR_NETWORK -> "Network error"
                    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
                    SpeechRecognizer.ERROR_NO_MATCH -> "No match found"
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech service busy"
                    SpeechRecognizer.ERROR_SERVER -> "Server error"
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech input"
                    else -> "Speech error"
                }
                speechTranscript = errorMsg
            }
            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                if (!matches.isNullOrEmpty()) {
                    val finalText = matches[0]
                    speechTranscript = finalText
                    viewModel.sendSpeech(finalText)
                }
                isListeningSpeech = false
                viewModel.sendMicStatus(false)
            }
            override fun onPartialResults(partialResults: Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                if (!matches.isNullOrEmpty()) {
                    speechTranscript = matches[0]
                }
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        }
    }

    DisposableEffect(Unit) {
        speechRecognizer.setRecognitionListener(speechListener)
        onDispose {
            speechRecognizer.destroy()
        }
    }

    // CameraX elements for camera dialog
    val preview = remember { CameraPreview.Builder().build() }
    val imageCapture = remember { ImageCapture.Builder().build() }
    val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

    LaunchedEffect(hasCameraPermission, showCameraDialog) {
        if (hasCameraPermission && showCameraDialog) {
            try {
                val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
                val cameraProvider = cameraProviderFuture.get()
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    cameraSelector,
                    preview,
                    imageCapture
                )
            } catch (e: Exception) {
                Log.e("MainScreen", "CameraX binding failed", e)
            }
        }
    }

    // Auto-scroll logic for chat screen
    val listState = rememberLazyListState()
    LaunchedEffect(chatHistory.size) {
        if (chatHistory.isNotEmpty()) {
            listState.animateScrollToItem(chatHistory.size - 1)
        }
    }

    // Dark sci-fi background brush
    val darkGradient = Brush.verticalGradient(
        colors = listOf(Color(0xFF06090E), Color(0xFF020305))
    )

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(darkGradient)
    ) {
        Column(modifier = modifier.fillMaxSize()) {
            
            // Top Bar
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Settings Gear Button
                IconButton(onClick = { showSettingsDialog = true }) {
                    Icon(
                        imageVector = Icons.Default.Settings,
                        contentDescription = "Configure connection",
                        tint = if (isConnected) Color(0xFF00F0FF) else Color.White
                    )
                }

                // App Title
                Text(
                    text = "BUBBLE AI",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                    color = Color.White
                )

                // Screen Toggle Switch Button
                IconButton(
                    onClick = {
                        currentScreen = when (currentScreen) {
                            ScreenType.AI_MIC -> ScreenType.CHAT_LOGS
                            ScreenType.CHAT_LOGS -> ScreenType.HISTORY
                            ScreenType.HISTORY -> ScreenType.AI_MIC
                            ScreenType.BROWSER_PREVIEW -> ScreenType.HISTORY
                        }
                    }
                ) {
                    Icon(
                        imageVector = when (currentScreen) {
                            ScreenType.AI_MIC -> Icons.Default.List
                            ScreenType.CHAT_LOGS -> Icons.Default.Home
                            ScreenType.HISTORY -> Icons.Default.Home
                            else -> Icons.Default.Home
                        },
                        contentDescription = "Switch page",
                        tint = Color.White
                    )
                }
            }

            // Screen Content Body
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
            ) {
                if (currentScreen == ScreenType.AI_MIC) {
                    // ==========================================
                    // Screen 1: Bubble AI Main Page (IMAGE ONLY)
                    // ==========================================
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        val activeLabel = when {
                            !isConnected -> "AWAITING SYNC"
                            isListeningSpeech -> "LISTENING"
                            statusText == "Thinking" -> "THINKING"
                            isConnecting -> "SYNCING..."
                            else -> "STANDBY"
                        }

                        val infiniteTransition = rememberInfiniteTransition()

                        // Double-beat heartbeat twitch scale animation when listening
                        val twitchScaleState = infiniteTransition.animateFloat(
                            initialValue = 1f,
                            targetValue = 1.16f,
                            animationSpec = infiniteRepeatable(
                                animation = keyframes {
                                    durationMillis = 1000
                                    1f at 0 with FastOutSlowInEasing
                                    1.16f at 150 with FastOutLinearInEasing
                                    1.05f at 300 with LinearOutSlowInEasing
                                    1.18f at 450 with FastOutLinearInEasing
                                    1f at 700 with LinearOutSlowInEasing
                                },
                                repeatMode = RepeatMode.Restart
                            )
                        )
                        val pulseScale = if (isListeningSpeech) twitchScaleState.value else 1f

                        // Floating offset animation (+/- 10dp)
                        val floatOffset by infiniteTransition.animateFloat(
                            initialValue = -10f,
                            targetValue = 10f,
                            animationSpec = infiniteRepeatable(
                                animation = tween(durationMillis = 3000, easing = FastOutSlowInEasing),
                                repeatMode = RepeatMode.Reverse
                            )
                        )

                        // Rotation animations (slow and fast)
                        val slowRotation by infiniteTransition.animateFloat(
                            initialValue = 0f,
                            targetValue = 360f,
                            animationSpec = infiniteRepeatable(
                                animation = tween(durationMillis = 8000, easing = LinearEasing),
                                repeatMode = RepeatMode.Restart
                            )
                        )

                        val fastRotation by infiniteTransition.animateFloat(
                            initialValue = 0f,
                            targetValue = 360f,
                            animationSpec = infiniteRepeatable(
                                animation = tween(durationMillis = 1500, easing = LinearEasing),
                                repeatMode = RepeatMode.Restart
                            )
                        )

                        val currentRotation = if (activeLabel == "THINKING") fastRotation else slowRotation

                        // Breathing Halo animation (scaling and alpha fading)
                        val haloScale by infiniteTransition.animateFloat(
                            initialValue = 1.0f,
                            targetValue = 1.25f,
                            animationSpec = infiniteRepeatable(
                                animation = tween(durationMillis = 2000, easing = FastOutSlowInEasing),
                                repeatMode = RepeatMode.Reverse
                            )
                        )

                        val haloAlpha by infiniteTransition.animateFloat(
                            initialValue = 0.2f,
                            targetValue = 0.5f,
                            animationSpec = infiniteRepeatable(
                                animation = tween(durationMillis = 2000, easing = FastOutSlowInEasing),
                                repeatMode = RepeatMode.Reverse
                            )
                        )

                        // Animated thinking ball container
                        Box(
                            modifier = Modifier
                                .size(280.dp)
                                .offset(y = floatOffset.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            // Glowing halo behind the ball
                            Box(
                                modifier = Modifier
                                    .size(210.dp)
                                    .scale(haloScale * pulseScale)
                                    .background(
                                        brush = Brush.radialGradient(
                                            colors = listOf(
                                                Color(0xFF00F0FF).copy(alpha = haloAlpha),
                                                Color(0xFFBD00FF).copy(alpha = haloAlpha * 0.5f),
                                                Color.Transparent
                                            )
                                        ),
                                        shape = CircleShape
                                    )
                            )

                            // Central Bubble Core Image Button
                            Box(
                                modifier = Modifier
                                    .size(190.dp)
                                    .scale(pulseScale)
                                    .clip(CircleShape)
                                    .clickable(enabled = isConnected) {
                                        if (!hasMicPermission) {
                                            permissionLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
                                        } else {
                                            if (isListeningSpeech) {
                                                speechRecognizer.stopListening()
                                            } else {
                                                speechRecognizer.startListening(speechIntent)
                                            }
                                        }
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                // 1. Outer core layer (rotates clockwise)
                                Image(
                                    painter = painterResource(id = R.drawable.bubble_core),
                                    contentDescription = "Bubble core outer",
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .rotate(currentRotation)
                                )

                                // 2. Inner counter-rotating and breathing core layer
                                val innerScale by infiniteTransition.animateFloat(
                                    initialValue = 0.72f,
                                    targetValue = 0.88f,
                                    animationSpec = infiniteRepeatable(
                                        animation = tween(durationMillis = 2000, easing = FastOutSlowInEasing),
                                        repeatMode = RepeatMode.Reverse
                                    )
                                )

                                Image(
                                    painter = painterResource(id = R.drawable.bubble_core),
                                    contentDescription = "Bubble core inner",
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier
                                        .size(190.dp)
                                        .scale(innerScale)
                                        .rotate(-currentRotation * 1.35f)
                                        .clip(CircleShape)
                                )

                                // 3. Central pulsing cyan/purple energy orb
                                val centerGlowAlpha by infiniteTransition.animateFloat(
                                    initialValue = 0.35f,
                                    targetValue = 0.75f,
                                    animationSpec = infiniteRepeatable(
                                        animation = tween(durationMillis = 1200, easing = FastOutSlowInEasing),
                                        repeatMode = RepeatMode.Reverse
                                    )
                                )

                                Box(
                                    modifier = Modifier
                                        .size(64.dp)
                                        .background(
                                            brush = Brush.radialGradient(
                                                colors = listOf(
                                                    Color(0xFF00F0FF).copy(alpha = centerGlowAlpha),
                                                    Color(0xFFBD00FF).copy(alpha = centerGlowAlpha * 0.4f),
                                                    Color.Transparent
                                                )
                                            ),
                                            shape = CircleShape
                                        )
                                )
                            }
                        }

                        Spacer(modifier = Modifier.height(32.dp))
                        
                        val labelColor = when (activeLabel) {
                            "LISTENING" -> Color(0xFFEF4444)
                            "THINKING" -> Color(0xFFBD00FF)
                            "STANDBY" -> Color(0xFF00F0FF)
                            else -> Color.Gray
                        }

                        Text(
                            text = activeLabel,
                            color = labelColor,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 2.sp
                        )

                        if (speechTranscript.isNotEmpty()) {
                            val promptFloatOffset by infiniteTransition.animateFloat(
                                initialValue = -5f,
                                targetValue = 5f,
                                animationSpec = infiniteRepeatable(
                                    animation = tween(durationMillis = 2500, easing = FastOutSlowInEasing),
                                    repeatMode = RepeatMode.Reverse
                                )
                            )

                            Spacer(modifier = Modifier.height(32.dp))
                            Box(
                                modifier = Modifier
                                    .padding(horizontal = 32.dp)
                                    .offset(y = promptFloatOffset.dp)
                                    .background(
                                        color = Color(0xFF0D121F).copy(alpha = 0.75f),
                                        shape = RoundedCornerShape(16.dp)
                                    )
                                    .border(
                                        BorderStroke(
                                            1.dp,
                                            Brush.horizontalGradient(
                                                colors = listOf(
                                                    Color(0xFF00F0FF).copy(alpha = 0.5f),
                                                    Color(0xFFBD00FF).copy(alpha = 0.5f)
                                                )
                                            )
                                        ),
                                        shape = RoundedCornerShape(16.dp)
                                    )
                                    .padding(vertical = 12.dp, horizontal = 18.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.Center
                                ) {
                                    Text(
                                        text = "“",
                                        color = Color(0xFF00F0FF),
                                        fontSize = 20.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text(
                                        text = speechTranscript,
                                        color = Color.White.copy(alpha = 0.9f),
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Medium,
                                        lineHeight = 20.sp
                                    )
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text(
                                        text = "”",
                                        color = Color(0xFFBD00FF),
                                        fontSize = 20.sp,
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }
                        }
                    }
                } else if (currentScreen == ScreenType.CHAT_LOGS) {
                    // ==========================================
                    // Screen 2: Interactive Chat Messenger
                    // ==========================================
                    Column(modifier = Modifier.fillMaxSize()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                        ) {
                            if (chatHistory.isEmpty()) {
                                // Empty Chat Logs State
                                Column(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(32.dp),
                                    verticalArrangement = Arrangement.Center,
                                    horizontalAlignment = Alignment.CenterHorizontally
                                ) {
                                    Text("💬", fontSize = 48.sp)
                                    Spacer(modifier = Modifier.height(16.dp))
                                    Text(
                                        text = "Chat history with Bubble",
                                        color = Color.White,
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 16.sp
                                    )
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        text = "Speak to Bubble or sync devices to see the conversation history here.",
                                        color = Color.Gray,
                                        fontSize = 14.sp
                                    )
                                }
                            } else                                // Double-sided conversational chat layout
                                LazyColumn(
                                    state = listState,
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(horizontal = 16.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    item {
                                        Spacer(modifier = Modifier.height(8.dp))
                                    }
                                    
                                    items(chatHistory) { item ->
                                        ChatBubbleItem(item)
                                    }
                                    
                                    item {
                                        Spacer(modifier = Modifier.height(8.dp))
                                    }
                                }
                            }

                        // Chatbox Text Input Bar at the bottom
                        var textInput by remember { mutableStateOf("") }
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Color(0xFF0D1117))
                                .navigationBarsPadding()
                                .imePadding()
                                .padding(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            OutlinedTextField(
                                value = textInput,
                                onValueChange = { textInput = it },
                                placeholder = { Text("Chat with Bubble...", color = Color.Gray) },
                                leadingIcon = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        IconButton(
                                            onClick = {
                                                if (isConnected) {
                                                    if (!hasCameraPermission) {
                                                        permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA))
                                                    } else {
                                                        showCameraDialog = true
                                                    }
                                                }
                                            }
                                        ) {
                                            Text("📷", fontSize = 20.sp)
                                        }
                                        IconButton(
                                            onClick = {
                                                if (isConnected) {
                                                    docPickerLauncher.launch("*/*")
                                                }
                                            }
                                        ) {
                                            Text("📎", fontSize = 20.sp)
                                        }
                                    }
                                },
                                modifier = Modifier.weight(1f),
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedTextColor = Color.White,
                                    unfocusedTextColor = Color.White,
                                    focusedBorderColor = Color(0xFF00F0FF),
                                    unfocusedBorderColor = Color.Gray,
                                    focusedLabelColor = Color(0xFF00F0FF),
                                    unfocusedLabelColor = Color.Gray
                                )
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Button(
                                onClick = {
                                    if (textInput.isNotBlank() && isConnected) {
                                        viewModel.sendText(textInput)
                                        textInput = ""
                                    }
                                },
                                enabled = isConnected && textInput.isNotBlank(),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = Color(0xFF00F0FF),
                                    contentColor = Color.Black,
                                    disabledContainerColor = Color.DarkGray,
                                    disabledContentColor = Color.LightGray
                                ),
                                shape = RoundedCornerShape(8.dp)
                            ) {
                                Text("Send", fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                } else if (currentScreen == ScreenType.BROWSER_PREVIEW) {
                    val base64Image by viewModel.latestScreenshot.collectAsState()
                    BrowserPreviewScreen(base64Image, viewModel)
                } else if (currentScreen == ScreenType.HISTORY) {
                    val historyDates by viewModel.historyDates.collectAsState()
                    val historyMessages by viewModel.historyMessages.collectAsState()
                    val selectedDate by viewModel.selectedHistoryDate.collectAsState()
                    
                    LaunchedEffect(Unit) {
                        viewModel.fetchHistoryDates()
                    }
                    
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(16.dp)
                    ) {
                        if (selectedDate == null) {
                            Text(
                                text = "CONVERSATION HISTORY",
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 16.sp,
                                letterSpacing = 1.sp,
                                modifier = Modifier.padding(bottom = 12.dp)
                            )
                            if (historyDates.isEmpty()) {
                                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text("No local history backups found on server.", color = Color.Gray, fontSize = 14.sp)
                                }
                            } else {
                                LazyColumn(
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                    modifier = Modifier.fillMaxSize()
                                ) {
                                    items(historyDates) { date ->
                                        Card(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .clickable { viewModel.fetchHistoryMessages(date) },
                                            colors = CardDefaults.cardColors(containerColor = Color(0xFF161E2E)),
                                            border = BorderStroke(1.dp, Color(0xFF00F0FF).copy(alpha = 0.2f))
                                        ) {
                                            Row(
                                                modifier = Modifier.padding(16.dp),
                                                horizontalArrangement = Arrangement.SpaceBetween,
                                                verticalAlignment = Alignment.CenterVertically
                                            ) {
                                                Row(verticalAlignment = Alignment.CenterVertically) {
                                                    Text("📅", fontSize = 18.sp)
                                                    Spacer(modifier = Modifier.width(12.dp))
                                                    Text(text = date, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                                                }
                                                Text("➔", color = Color(0xFF00F0FF), fontSize = 14.sp)
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { viewModel.clearSelectedHistoryDate() }
                                    .padding(vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("◀ Back to History List", color = Color(0xFF00F0FF), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = "CHAT LOGS - $selectedDate",
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                                letterSpacing = 1.sp,
                                modifier = Modifier.padding(bottom = 12.dp)
                            )
                            
                            if (historyMessages.isEmpty()) {
                                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text("No messages in this backup.", color = Color.Gray, fontSize = 14.sp)
                                }
                            } else {
                                LazyColumn(
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                    modifier = Modifier.fillMaxSize()
                                ) {
                                    items(historyMessages) { item ->
                                        ChatBubbleItem(item)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ==========================================
        // Popup Dialog: Settings Gear Overlay
        // ==========================================
        if (showSettingsDialog) {
            Dialog(onDismissRequest = { showSettingsDialog = false }) {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = Color(0xFF161C26),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(
                        modifier = Modifier.padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        Text(
                            text = "BUBBLE UPLINK NETWORK",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp,
                            letterSpacing = 1.sp
                        )

                        OutlinedTextField(
                            value = serverIp,
                            onValueChange = { viewModel.updateServerIp(it) },
                            label = { Text("Server IP Address") },
                            placeholder = { Text("e.g. 192.168.29.10") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = Color(0xFF00F0FF),
                                unfocusedBorderColor = Color.Gray,
                                focusedLabelColor = Color(0xFF00F0FF),
                                unfocusedLabelColor = Color.Gray
                            )
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(if (isConnected) Color(0xFF10B981) else Color(0xFFEF4444))
                                )
                                Spacer(modifier = Modifier.width(6.dp))
                                Text(
                                    text = statusText,
                                    color = Color.LightGray,
                                    fontSize = 14.sp
                                )
                            }

                            Button(
                                onClick = { viewModel.toggleConnection() },
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = if (isConnected) Color(0xFFEF4444) else Color(0xFF8B5CF6)
                                ),
                                shape = RoundedCornerShape(8.dp)
                            ) {
                                Text(
                                    text = if (isConnecting) "Syncing..." else if (isConnected) "Disconnect" else "Sync Uplink",
                                    color = Color.White,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }

                        Button(
                            onClick = { viewModel.discoverAndConnect() },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00F0FF)),
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("Scan Local Wi-Fi", color = Color.Black, fontWeight = FontWeight.Bold)
                        }

                        Button(
                            onClick = { showSettingsDialog = false },
                            colors = ButtonDefaults.buttonColors(containerColor = Color.DarkGray),
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("Close", color = Color.White)
                        }
                    }
                }
            }
        }

        // ==========================================
        // Popup Dialog: Floating Camera Preview
        // ==========================================
        if (showCameraDialog) {
            Dialog(onDismissRequest = { showCameraDialog = false }) {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = Color(0xFF161C26),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(320.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.SpaceBetween,
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text(
                            text = "BUBBLE VISUAL TELEMETRY SEARCH",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 12.sp,
                            letterSpacing = 1.sp
                        )

                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(180.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color.Black)
                        ) {
                            AndroidView(
                                factory = { ctx ->
                                    val previewView = PreviewView(ctx).apply {
                                        scaleType = PreviewView.ScaleType.FILL_CENTER
                                    }
                                    preview.setSurfaceProvider(previewView.surfaceProvider)
                                    previewView
                                },
                                modifier = Modifier.fillMaxSize()
                            )
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            Button(
                                onClick = { showCameraDialog = false },
                                colors = ButtonDefaults.buttonColors(containerColor = Color.DarkGray),
                                modifier = Modifier.weight(1f)
                            ) {
                                Text("Cancel", color = Color.White)
                            }

                            Button(
                                onClick = {
                                    captureAndSendPhoto(imageCapture, context) { base64 ->
                                        viewModel.sendImage(base64)
                                        showCameraDialog = false
                                    }
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00F0FF)),
                                modifier = Modifier.weight(1f)
                            ) {
                                Text("Initiate Search", color = Color.Black, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
    }
}

// Custom Double-sided Chat Bubble Item (User Aligned Right vs Bubble Aligned Left)
@Composable
fun ChatBubbleItem(item: ChatItem) {
    val isUser = item.type != "bubble"
    
    val alignment = if (isUser) Alignment.End else Alignment.Start
    val bubbleBgColor = if (isUser) {
        when (item.type) {
            "text" -> Color(0xFF0066FF)
            "speech" -> Color(0xFF8B5CF6)
            else -> Color(0xFFF59E0B) // image card
        }
    } else {
        Color(0xFF161E2E) // Bubble gray-blue card
    }
    
    val bubbleShape = if (isUser) {
        RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 2.dp)
    } else {
        RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 2.dp, bottomEnd = 16.dp)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalAlignment = alignment
    ) {
        // Label header: "YOU" or "BUBBLE"
        Text(
            text = if (isUser) "YOU" else "BUBBLE",
            color = if (isUser) Color.Gray else Color(0xFF00F0FF),
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
        )
        
        Card(
            shape = bubbleShape,
            colors = CardDefaults.cardColors(containerColor = bubbleBgColor),
            border = if (!isUser) BorderStroke(1.dp, Color(0xFF00F0FF).copy(alpha = 0.35f)) else null,
            modifier = Modifier.widthIn(max = 280.dp)
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                if (item.type == "image") {
                    Base64Image(
                        base64Str = item.content,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(150.dp)
                            .clip(RoundedCornerShape(8.dp))
                    )
                } else {
                    Text(
                        text = item.content,
                        color = Color.White,
                        fontSize = 14.sp,
                        lineHeight = 20.sp
                    )
                }
                
                Spacer(modifier = Modifier.height(4.dp))
                
                val timeStr = remember(item.timestamp) {
                    val date = java.util.Date(item.timestamp)
                    val format = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
                    format.format(date)
                }
                Text(
                    text = timeStr,
                    color = Color.White.copy(alpha = 0.4f),
                    fontSize = 9.sp,
                    modifier = Modifier.align(Alignment.End)
                )
            }
        }
    }
}

// Display Decoded Base64 Image Composable
@Composable
fun Base64Image(base64Str: String, modifier: Modifier = Modifier) {
    val bitmap = remember(base64Str) {
        try {
            val cleanStr = if (base64Str.startsWith("data:image/jpeg;base64,")) {
                base64Str.substring("data:image/jpeg;base64,".length)
            } else {
                base64Str
            }
            val decodedBytes = Base64.decode(cleanStr, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
        } catch (e: Exception) {
            Log.e("Base64Image", "Decoding image failed", e)
            null
        }
    }
    
    if (bitmap != null) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = "Snapshot",
            modifier = modifier,
            contentScale = ContentScale.Crop
        )
    } else {
        Box(
            modifier = modifier.background(Color.Black),
            contentAlignment = Alignment.Center
        ) {
            Text("Corrupted image", color = Color.Red, fontSize = 12.sp)
        }
    }
}

// CameraX take picture helper
private fun captureAndSendPhoto(
    imageCapture: ImageCapture,
    context: Context,
    onPhotoCaptured: (String) -> Unit
) {
    val file = File(context.cacheDir, "temp_bubble_snap_${System.currentTimeMillis()}.jpg")
    val outputOptions = ImageCapture.OutputFileOptions.Builder(file).build()

    imageCapture.takePicture(
        outputOptions,
        ContextCompat.getMainExecutor(context),
        object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                try {
                    val bytes = file.readBytes()
                    val base64 = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                    onPhotoCaptured(base64)
                    file.delete()
                } catch (e: Exception) {
                    Log.e("CameraCapture", "Base64 encoding failed", e)
                }
            }

            override fun onError(exception: ImageCaptureException) {
                Log.e("CameraCapture", "Photo capture failed: ${exception.message}", exception)
            }
        }
    )
}

private fun getFileName(context: Context, uri: android.net.Uri): String {
    var result: String? = null
    if (uri.scheme == "content") {
        context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (index != -1) {
                    result = cursor.getString(index)
                }
            }
        }
    }
    if (result == null) {
        result = uri.path
        val cut = result?.lastIndexOf('/') ?: -1
        if (cut != -1) {
            result = result?.substring(cut + 1)
        }
    }
    return result ?: "document.txt"
}

@Composable
fun BrowserPreviewScreen(
    base64Image: String?,
    viewModel: MainScreenViewModel
) {
    val screenshotError by viewModel.screenshotError.collectAsState()
    
    var decodedBitmap by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    
    LaunchedEffect(base64Image) {
        if (base64Image.isNullOrEmpty()) {
            decodedBitmap = null
        } else {
            try {
                val decodedString = android.util.Base64.decode(base64Image, android.util.Base64.DEFAULT)
                val bmp = android.graphics.BitmapFactory.decodeByteArray(decodedString, 0, decodedString.size)
                if (bmp != null) {
                    decodedBitmap = bmp
                    viewModel.setScreenshotDecoded(true)
                } else {
                    decodedBitmap = null
                    viewModel.setScreenshotDecoded(false, "Screenshot decode failed.")
                }
            } catch (e: Exception) {
                decodedBitmap = null
                viewModel.setScreenshotDecoded(false, "Screenshot decode failed.")
            }
        }
    }
    
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF06090E))
            .padding(16.dp),
        contentAlignment = Alignment.Center
    ) {
        if (screenshotError != null) {
            Text(text = screenshotError ?: "Screenshot decode failed.", color = Color.Red, fontSize = 16.sp)
        } else if (decodedBitmap == null) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                CircularProgressIndicator(color = Color(0xFF00F0FF))
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = "Waiting for browser screenshot...",
                    color = Color.LightGray,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    letterSpacing = 1.sp
                )
            }
        } else {
            Image(
                bitmap = decodedBitmap!!.asImageBitmap(),
                contentDescription = "Browser Live Preview",
                modifier = Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(8.dp)),
                contentScale = ContentScale.Fit
            )
        }
    }
}
