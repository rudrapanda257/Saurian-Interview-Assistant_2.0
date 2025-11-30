// main.js FILE - ELECTRON MAIN PROCESS - UPDATED VERSION

const { app, BrowserWindow, ipcMain, systemPreferences, desktopCapturer } = require('electron')
const path = require('path');
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json');
const fs = require('fs')
const remote = require('@electron/remote/main');
remote.initialize();
const speech = require('@google-cloud/speech')
const record = require('node-record-lpcm16')
const textToSpeech = require('@google-cloud/text-to-speech')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { globalShortcut } = require('electron');



// Global variables
let mainWindow = null
let recording = null
let isRecording = false
let recognizeStream = null
let currentTranscript = ''
let answerDebounceTimer = null

// Create a backup of window position and size for restoring
let windowState = {
  width: 500,
  height: 400,
  x: null,
  y: null
};

// Add this to track if we're in screen sharing mode
let isInScreenSharingMode = false;

// ============================================
// GOOGLE GEMINI API CONFIGURATION (FREE!)
// Get your free API key from: https://aistudio.google.com/app/apikey
// ============================================
const GEMINI_API_KEY = ''; // ← PUT YOUR NEW API KEY HERE



// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

// Initialize Google Gemini AI (100% FREE with vision support!)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Add this near the top with other platform-specific code
const isWindows = process.platform === 'win32';

// Function to get credentials path that works in both dev and production
function getCredentialsPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
  } else {
    return path.join(__dirname, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
  }
}

// Initialize Google clients
const speechClient = new speech.SpeechClient({
  keyFilename: getCredentialsPath()
})

const ttsClient = new textToSpeech.TextToSpeechClient({
  keyFilename: getCredentialsPath()
})

// Update the createWindow function to handle Windows-specific settings
function createWindow() {
  const windowOptions = {
    width: 700,
    height: 700,
    minWidth: 400,           // ← ADD THIS LINE
    minHeight: 300,          // ← ADD THIS LINE
    resizable: true,
    alwaysOnTop: true,
    transparent: false,
    frame: true,
    // focusable: false, 
    skipTaskbar: true,
    icon: path.join(__dirname, isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png'),
    
     // CHANGED: Fully transparent background
     backgroundColor: '#1e1e1e',
     show: false,
    titleBarStyle: 'default',
    webPreferences: {
   preload: require('path').join(__dirname, 'preload.js'),
   nodeIntegration: true,
   contextIsolation: false,
   backgroundThrottling: false,
   enableRemoteModule: true,
   webSecurity: false
   }
  };
  
  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false); 

    // Make window invisible to focus detection
  mainWindow.setSkipTaskbar(true);
  
  // Prevent focus events from affecting other windows
  mainWindow.on('focus', () => {
    mainWindow.setIgnoreMouseEvents(false);
  });

  // // Prevent blur events from affecting the window
  // mainWindow.on('blur', () => {
  //   // Keep window interactable even when blurred
  //   mainWindow.setIgnoreMouseEvents(false);
  // });
  
  // For Windows: Remove from Alt+Tab
  if (isWindows) {
    mainWindow.setSkipTaskbar(true);
    // Windows-specific: Set extended window style to hide from Alt+Tab
    mainWindow.once('ready-to-show', () => {
      const { setWindowExStyle } = require('electron');
      try {
        // WS_EX_TOOLWINDOW removes from Alt+Tab
        mainWindow.setSkipTaskbar(true);
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      } catch (e) {
        console.log('Could not apply Windows-specific settings');
      }
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  remote.enable(mainWindow.webContents); 
  
  if (process.platform === 'darwin') {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setWindowButtonVisibility(true);
      app.dock.show();
      mainWindow.moveTop();
    });
  } else if (isWindows) {
    mainWindow.setSkipTaskbar(false);
    app.setAppUserModelId('com.lazyjobseeker.angel');
  }
  
  console.log('Main window created with transparency enabled');
}

function createRecognizeStream() {
  const request = {
    config: {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      model: 'default',
      useEnhanced: true,
      metadata: {
        interactionType: 'DISCUSSION',
        microphoneDistance: 'NEARFIELD',
        originalMediaType: 'AUDIO'
      },
      enableVoiceActivityDetection: false,
      maxAlternatives: 1
    },
    singleUtterance: false,
    interimResults: true
  }

  return speechClient
    .streamingRecognize(request)
    .on('error', error => {
      console.error('Error:', error)
      if (error.code === 11 && isRecording) {
        console.log('Stream timeout, creating new stream while preserving transcript')
        if (recognizeStream) {
          recognizeStream = createRecognizeStream()
        }
      }
      if (mainWindow) {
        mainWindow.webContents.send('transcript', currentTranscript)
      }
    })
    .on('data', data => {
      if (data.results[0]) {
        const result = data.results[0]
        const transcript = result.alternatives[0].transcript
        
        if (result.isFinal) {
          currentTranscript = (currentTranscript + ' ' + transcript).trim()
          if (mainWindow) {
            mainWindow.webContents.send('transcript', currentTranscript)
          }
        } else {
          if (mainWindow) {
            const interimTranscript = (currentTranscript + ' ' + transcript).trim()
            mainWindow.webContents.send('transcript', interimTranscript)
          }
        }
      }
    })
}

ipcMain.on('toggle-recording', async (event, isStarting) => {
  if (answerDebounceTimer) {
    clearTimeout(answerDebounceTimer);
    answerDebounceTimer = null;
  }

  if (isStarting) {
    console.log('Starting new recording session');
    isRecording = true;
    currentTranscript = '';
    recognizeStream = createRecognizeStream();
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-started');
      mainWindow.webContents.send('transcript', '');
    }
  } else {
    console.log('Stopping recording and generating answer');
    isRecording = false;
    
    if (recognizeStream) {
      try {
        recognizeStream.end();
        recognizeStream = null;
      } catch (error) {
        console.error('Error ending recognizeStream:', error);
      }
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-stopped');
      
      if (currentTranscript && currentTranscript.trim().length > 0) {
        try {
          mainWindow.webContents.send('answer-status', 'Generating answer...');
          await getGeminiAnswer(currentTranscript);
        } catch (error) {
          console.error('Error generating answer:', error);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer', 'Error generating answer. Please try again.');
          }
        }
      } else {
        mainWindow.webContents.send('answer', 'No speech detected. Please try again.');
      }
    }
  }
});

ipcMain.on('stream-audio-chunk', async (event, audioChunk) => {
  try {
    if (!isRecording) return;
    
    if (!recognizeStream || recognizeStream.destroyed) {
      recognizeStream = createRecognizeStream();
      isRecording = true;
    }
    
    if (recognizeStream && !recognizeStream.destroyed) {
      const audioBuffer = Buffer.from(audioChunk, 'base64');
      
      try {
        recognizeStream.write(audioBuffer);
      } catch (error) {
        console.error('Stream write error:', error);
      }
    }
  } catch (error) {
    console.error('Error processing audio chunk:', error);
  }
});

// ============================================
// UPDATED GEMINI AI FUNCTION - WITH CODE FORMATTING
// Now requests code in proper markdown format like ChatGPT
// ===========================================
async function getGeminiAnswer(transcript, imageData = null, history = []) {
  try {

    // Build a compact conversation context from history (keep it small if very long)
    let conversationContext = '';
    try {
      if (Array.isArray(history) && history.length > 0) {
        // history is the renderer's messages array: { text, isUser, screenshotData }
        // We'll include only text entries and limit to last N items to avoid huge prompts.
        const LAST_N = 12; // adjust if needed
        const recent = history.slice(-LAST_N);
        conversationContext = recent.map(m => {
          const who = m.isUser ? 'User' : 'Assistant';
          // sanitize newlines to single lines for context
          const txt = (m.text || '').replace(/\n+/g, ' ').trim();
          return `${who}: ${txt}`;
        }).join('\n');
      }
    } catch (e) {
      console.warn('Could not build conversation context from history', e);
      conversationContext = '';
    }

    if (!transcript || transcript.trim().length === 0) {
      console.log('Empty transcript, not sending to Gemini');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('answer', 'I couldn\'t hear anything. Please try again.');
      }
      return;
    }

    // Prepare the final prompt by including the conversation context (if any)
    let promptPrefix = '';
    if (conversationContext) {
      promptPrefix = `Conversation history:\n${conversationContext}\n\n`;
    }

    const finalQuestion = `${promptPrefix}User: ${transcript}\nAssistant:`;

    console.log('Sending to Google Gemini with context. Transcript:', transcript);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('answer-status', 'Generating answer.');
    }

    const modelName = "gemini-2.0-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

   let result;
if (imageData) {
  // ====================================
  // IMAGE/SCREENSHOT ANALYSIS
  // ====================================
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  let mimeType = 'image/png';
  if (imageData.startsWith('data:image/jpeg') || imageData.startsWith('data:image/jpg')) mimeType = 'image/jpeg';
  else if (imageData.startsWith('data:image/webp')) mimeType = 'image/webp';
  else if (imageData.startsWith('data:image/gif')) mimeType = 'image/gif';

  const imagePart = {
    inlineData: { data: base64Data, mimeType }
  };

  const textPart = {
    text: `You are an interview preparation assistant analyzing a screenshot.

RESPONSE RULES:
1. If it's a coding/DSA question: Provide FULL working Java code first in a code block
2. Include time/space complexity analysis for algorithms
3. Structure answer in bullet points
4. Add step-by-step explanation after code
5. Use simple, speakable language
6. End with "Key Points" summary

Question: ${finalQuestion}

Provide complete code solution with detailed explanation.`
  };

  result = await model.generateContent([textPart, imagePart]);
} else {
  // ====================================
  // TEXT-BASED QUESTIONS
  // ====================================
  
  // Detect if it's an interview question
  const interviewKeywords = [
  'interview', 'explain', 'difference between', 'what is', 
  'how does', 'tell me about', 'describe', 'implement', 
  'solve', 'algorithm', 'code', 'program', 'reverse', 'write',
  'find', 'search', 'sort', 'calculate', 'design', 'create',
  'build', 'optimize', 'problem', 'question', 'approach'
];

// Check if it's a coding problem (needs full code solution)
const codingProblemKeywords = ['solve', 'implement', 'write', 'code', 'reverse', 'find', 'search', 'sort', 'algorithm', 'problem'];
const isCodingProblem = codingProblemKeywords.some(keyword => 
  finalQuestion.toLowerCase().includes(keyword)
);

const isInterviewQuestion = interviewKeywords.some(keyword => 
  finalQuestion.toLowerCase().includes(keyword)
);
  
  let systemPrompt;
  
  if (isInterviewQuestion) {
  systemPrompt = `You are an interview preparation assistant. Help someone answer questions naturally and confidently.

${isCodingProblem ? `
CODING PROBLEM FORMAT (STRICT):
1. **Approach/Algorithm** (2-3 bullet points explaining the logic)
2. **Complete Working Java Code** (full solution in one code block)
3. **Code Explanation** (explain key parts line-by-line)
4. **Time & Space Complexity** (Big O notation)
5. **Key Points to Remember** (2-3 takeaways)
` : ''}

RESPONSE STYLE:
- Write each bullet point as a COMPLETE SENTENCE that flows naturally when spoken
- Use simple, everyday language - avoid jargon unless necessary
- Structure everything in bullet points, but make each point feel like a full thought
- Bold (**text**) key terms for quick scanning
- Keep it conversational and professional

CRITICAL RULES - MUST FOLLOW:
- Write the answer AS IF THE CANDIDATE IS SPEAKING in first person
- Use "I", "my", "mine" - NEVER "you", "your", "yours"
- Wrong: "You put the code in a try block"
- Correct: "I put the code in a try block"
- Wrong: "You handle errors using..."
- Correct: "I handle errors using..."

LANGUAGE STYLE:
- Use conversational words: "So" not "Therefore", "But" not "However", "Also" not "Moreover"
- Use simple verbs: "Use" not "Utilize", "Start" not "Commence", "Show" not "Demonstrate"
- Speak naturally: "I think it's better to..." not "It is recommended"

BULLET POINT RULES:
- Each point should be 1-2 complete sentences (not just keywords)
- Should read like someone speaking in an interview
- Example: "Polymorphism means one method can behave in different ways depending on the object that calls it."
- NOT: "Polymorphism - multiple forms"

${finalQuestion}

Provide interview-ready answer with full sentences in bullet format.`;
}else {
    // ====================================
    // REGULAR CONVERSATIONAL PROMPT
    // ====================================
    systemPrompt = `You are a helpful AI assistant. Be brief, natural, and use bullet points when helpful.

${finalQuestion}

Provide a clear, concise answer.`;
  }
  
  result = await model.generateContent(systemPrompt);
}

    //stop here
    const response = await result.response;
    const answer = response.text();

    if (answer && answer.trim()) {
      console.log('Received answer from Gemini:', answer);
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (imageData) {
          mainWindow.webContents.send('screenshot-answer', answer);
        } else {
          mainWindow.webContents.send('answer', answer);
        }
      }
    } else {
      console.error('No answer content in Gemini response');
      if (mainWindow && !mainWindow.isDestroyed()) {
        const errorMsg = 'Could not generate an answer. Please try again.';
        if (imageData) {
          mainWindow.webContents.send('screenshot-answer', errorMsg);
        } else {
          mainWindow.webContents.send('answer', errorMsg);
        }
      }
    }
  } catch (error) {
    console.error('Gemini API error:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      let errorMessage = `AI Error: ${error.message || 'Unknown error'}. Make sure your API key is valid.`;
      if (imageData) {
        mainWindow.webContents.send('screenshot-answer', errorMessage);
      } else {
        mainWindow.webContents.send('answer', errorMessage);
      }
    }
  }
}


// Handle text input messages
ipcMain.on('text-input-message', async (event, text, history = []) => {
  console.log('Received text input:', text);
  console.log('Conversation history length:', Array.isArray(history) ? history.length : 'no history');

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('answer-status', 'Generating answer...');
      // pass the history to the answer function
      await getGeminiAnswer(text, null, history);
    } catch (error) {
      console.error('Error processing text input:', error);
      mainWindow.webContents.send('answer', 'Error generating answer. Please try again.');
    }
  }
});


// Handle screenshot capture
ipcMain.on('capture-screenshot', async (event) => {
  try {
    console.log('Screenshot capture requested');
    
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    
    if (sources.length === 0) {
      console.error('No screen sources available');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcription-error', 'No screen available for capture');
      }
      return;
    }
    
    const primaryScreen = sources[0];
    const screenshot = primaryScreen.thumbnail;
    const screenshotData = screenshot.toDataURL();
    
    console.log('Screenshot captured successfully');
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screenshot-captured', screenshotData);
    }
    
  } catch (error) {
    console.error('Error capturing screenshot:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcription-error', `Screenshot error: ${error.message}`);
    }
  }
});

// Handle screenshot with question
ipcMain.on('screenshot-with-question', async (event, data) => {
  console.log('Received screenshot with question:', data.question);
  const history = data.history || [];
  
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('answer-status', 'Analyzing screenshot with Gemini...');
      await getGeminiAnswer(data.question, data.screenshot, history);
    } catch (error) {
      console.error('Error processing screenshot with question:', error);
      mainWindow.webContents.send('screenshot-answer', 'Error analyzing screenshot. Please try again.');
    }
  }
});

ipcMain.on('stop-audio-stream', () => {
  if (recognizeStream && !recognizeStream.destroyed) {
    isRecording = false;
    recognizeStream.end();
    recognizeStream = null;
  }
});

ipcMain.on('reset-transcript', () => {
  currentTranscript = '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcript', '');
  }
});

// Screen sharing mode toggle handler
ipcMain.on('toggle-screen-sharing-mode', (event, isScreenSharing) => {
  if (!isInScreenSharingMode && mainWindow) {
    const position = mainWindow.getPosition();
    const size = mainWindow.getSize();
    windowState = {
      width: size[0],
      height: size[1],
      x: position[0],
      y: position[1]
    };
  }
  
  isInScreenSharingMode = isScreenSharing;
  
  if (mainWindow) {
    if (isScreenSharing) {
      if (process.platform === 'darwin') {
        try {
          mainWindow.setContentProtection(true);
          console.log('Screen sharing exclusion activated on macOS');
          mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          mainWindow.setAlwaysOnTop(true, "floating", 1);
          mainWindow.setWindowButtonVisibility(false);
          mainWindow.setOpacity(0.99);
          
          const bounds = mainWindow.getBounds();
          mainWindow.setBounds({ 
            x: bounds.x, 
            y: bounds.y, 
            width: bounds.width + 1, 
            height: bounds.height 
          });
          
          setTimeout(() => {
            mainWindow.setBounds(bounds);
          }, 10);
          
          mainWindow.setVibrancy('popover');
          setTimeout(() => {
            mainWindow.setVibrancy(null);
          }, 50);
        } catch (error) {
          console.error('Failed to apply screen sharing protection on macOS:', error);
        }
      } else if (process.platform === 'win32') {
        try {
          mainWindow.setContentProtection(true);
          mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
          console.log('Screen sharing exclusion activated on Windows');
        } catch (error) {
          console.error('Failed to apply screen sharing protection on Windows:', error);
        }
      }
      
      mainWindow.webContents.send('screen-sharing-active', true);
    } else {
      try {
        mainWindow.setOpacity(1.0);
        
        if (process.platform === 'darwin') {
          mainWindow.setWindowButtonVisibility(true);
          mainWindow.setVisibleOnAllWorkspaces(false);
        }
        
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setContentProtection(false);
        
        if (process.platform === 'darwin') {
          const bounds = mainWindow.getBounds();
          mainWindow.setBounds({ 
            x: bounds.x, 
            y: bounds.y, 
            width: bounds.width + 1, 
            height: bounds.height 
          });
          setTimeout(() => {
            mainWindow.setBounds(bounds);
          }, 10);
        }
        
        mainWindow.webContents.send('screen-sharing-active', false);
        console.log('Screen sharing exclusion deactivated');
      } catch (error) {
        console.error('Error disabling screen sharing protection:', error);
      }
    }
  }
});

ipcMain.on('get-answer', async (event, transcript) => {
  await getGeminiAnswer(transcript || currentTranscript)
})

ipcMain.on('new-chat', () => {
  currentTranscript = ''
  if (isRecording) {
    isRecording = false
    if (recording) {
      record.stop()
      recording = null
    }
    if (recognizeStream) {
      recognizeStream.end()
      recognizeStream = null
    }
    if (mainWindow) {
      mainWindow.webContents.send('recording-stopped')
    }
  }
  if (mainWindow) {
    mainWindow.webContents.send('transcript', '')
  }
})

ipcMain.on('recording-stopped', () => {
  if (mainWindow) {
    mainWindow.webContents.send('update-recording-status', false)
  }
})

// Handle audio data from renderer process
ipcMain.on('audio-data', async (event, base64Audio) => {
  try {
    if (!base64Audio || base64Audio.length < 100) {
      mainWindow.webContents.send('answer', 'No audio received. Please try again.');
      return;
    }

    console.log('Received audio, size:', base64Audio.length);
    mainWindow.webContents.send('answer-status', 'Transcribing audio...');
    
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const result = await model.generateContent([
      { text: "Transcribe this audio exactly. Output ONLY the spoken words, nothing else. If no clear speech, respond with just: NO_SPEECH" },
      { inlineData: { data: base64Audio, mimeType: 'audio/webm' } }
    ]);
    
    const response = await result.response;
    const transcript = response.text().trim();
    
    console.log('Transcription:', transcript);
    
    if (transcript && !transcript.includes('NO_SPEECH') && transcript.length > 2) {
      mainWindow.webContents.send('transcript', transcript);
      currentTranscript = transcript;
      mainWindow.webContents.send('answer-status', 'Generating answer...');
      await getGeminiAnswer(transcript);
    } else {
      mainWindow.webContents.send('answer', 'No speech detected. Please speak clearly and try again.');
    }
  } catch (error) {
    console.error('Audio error:', error);
    mainWindow.webContents.send('answer', `Error: ${error.message}`);
  }
});

// Window control shortcuts
ipcMain.on('minimize-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
    }
});

ipcMain.on('toggle-maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

// Global shortcut registration
app.whenReady().then(() => {
    createWindow();
    
    // Global shortcut - works from anywhere (Ctrl+Shift+A to show/focus app)
    globalShortcut.register('CommandOrControl+Shift+A', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error)
})