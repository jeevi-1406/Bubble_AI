const express = require('express');
const path = require('path');
const fs = require('fs');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.VISION_PORT || 3003;
const RTSP_URL = process.env.RTSP_URL || 'rtsp://localhost:554/stream';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

app.use(express.json());

app.post('/api/vision/scan', async (req, res) => {
  console.log(`[Vision Service] Scan request received. Connecting to RTSP: ${RTSP_URL}`);
  const tempFile = path.join(__dirname, `capture_${Date.now()}.jpg`);
  
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(RTSP_URL)
        .inputOptions([
          '-rtsp_transport tcp', // Force TCP transport for RTSP streaming stability
          '-stimeout 5000000'    // Set 5 seconds socket timeout
        ])
        .seekInput('00:00:01')   // Seek 1 second to ensure keyframes are fully decoded
        .frames(1)
        .output(tempFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[Vision Service] Frame captured to: ${tempFile}`);
    const imgData = fs.readFileSync(tempFile);
    const base64 = imgData.toString('base64');
    
    // Clean up temporary capture file immediately
    try { fs.unlinkSync(tempFile); } catch (e) {}

    console.log(`[Vision Service] Sending frame to LLaVA at ${OLLAMA_URL}`);
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llava',
        prompt: 'Describe what you see in front of you clearly and concisely. Focus on identifying the key objects, documents, or scenery in the image.',
        images: [base64],
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama response not ok: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`[Vision Service] Scene described successfully`);
    res.json({ success: true, description: data.response });

  } catch (err) {
    console.error(`[Vision Service Error]`, err);
    // Cleanup temp file if still exists
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`RTSP Camera Vision Service running on port ${PORT}`);
});
