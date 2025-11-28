// Word list will be loaded from external JSON
let originalWords = [];
let words = [];
let wordData = []; // Store the full word objects for scoring

// DOM elements
let stage, thresholdSlider, tval, logDiv, sendBatchBtn;

// Initialize the application
async function initApp() {
  // Get DOM elements
  stage = document.getElementById('stage');
  thresholdSlider = document.getElementById('threshold');
  tval = document.getElementById('tval');
  logDiv = document.getElementById('log');
  sendBatchBtn = document.getElementById('sendBatch');

  // Load word list from JSON file
  await loadWordList();

  // Setup event listeners
  tval.textContent = thresholdSlider.value;
  thresholdSlider.addEventListener('input', () => { 
    tval.textContent = Number(thresholdSlider.value).toFixed(3); 
  });

  // Initialize the rest of the application
  initSlots();
  initMic();
  setupEventListeners();
  showProgress();
}

// Load word list from JSON file
async function loadWordList() {
  try {
    // Get the JSON file path from data attribute or use default
    const jsonPath = document.getElementById('stage').dataset.wordsJson || 'h_words.json';
    
    const response = await fetch(jsonPath);
    if (!response.ok) {
      throw new Error(`Failed to load word list: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Handle the h_words.json format
    if (data.words && Array.isArray(data.words)) {
      wordData = data.words;
      originalWords = wordData.map(item => item.word);
    } else {
      throw new Error('Invalid JSON format for word list');
    }
    
    console.log(`Loaded ${originalWords.length} words from ${jsonPath}`);
    
    // Create modified word list with blank entries every 5 words
    for (let i = 0; i < originalWords.length; i++) {
      words.push(originalWords[i]);
      if ((i + 1) % 5 === 0 && i < originalWords.length - 1) {
        words.push(""); // Insert blank word
      }
    }
    
    console.log(`Created ${words.length} slots with ${words.filter(w => w === "").length} blank separators`);
    
  } catch (error) {
    console.error('Error loading word list:', error);
    // Fallback to default words
    originalWords = (`uhe aha uho ohi ahe ahi oha eho uhu iha aha uhi iha ihe uho
    ihu uhe eho oha uhi oha eha ihi ihi eho uhi uhe ihe ohi oha`).split(/\s+/);
    
    // Create modified word list with blank entries
    for (let i = 0; i < originalWords.length; i++) {
      words.push(originalWords[i]);
      if ((i + 1) % 5 === 0 && i < originalWords.length - 1) {
        words.push(""); // Insert blank word
      }
    }
    
    console.log('Using fallback word list');
  }
}

// Application state variables
let currentIdx = 0;
let slots = [];
let mediaStream, audioContext, mediaRecorder;
let armed = true;
let currentBatchAudioChunks = [];
const displayedWords = [];
// const API_URL="http://127.0.0.1:8000/transcribe";
const API_URL="https://speech.michaelwoodcock.duckdns.org/transcribe";
// Batch management variables
let currentBatchNumber = 1;
let currentBatchWords = [];
let currentBatchWordObjects = []; // Store the actual word objects for this batch
let wordsSinceLastSubmission = 0;
const SUBMISSION_INTERVAL = 5;
let isUploading = false;
let uploadQueue = [];
let isInBatchPause = false;
let batchPauseTimeout = null;
let batchAudioBlobs = []; // Store complete batch audio blobs
let autoScrollTimeout = null; // For auto-scrolling blank words
let batchStartTime = null; // Track when batch recording starts
let silenceStartTime = null; // Track when silence begins
let isProcessingBatch = false; // Prevent multiple batch completions

// --- Carousel functions ---
function makeSlot(idx,posClass){
  const el=document.createElement('div');
  el.className='slot';
  if(posClass==='pos-left'||posClass==='pos-right') el.classList.add('side');
  if(words[idx] === "") el.classList.add('blank');
  el.dataset.idx=idx;
  el.textContent=words[idx];
  el.classList.add(posClass);
  stage.appendChild(el);
  slots.push({el,idx});
  return el;
}

function findSlotByIdx(idx){ return slots.find(s=>s.idx===idx); }

function initSlots(){
  stage.innerHTML=''; slots=[]; currentIdx=0;
  makeSlot(0,'pos-center');
  if(words[1]) makeSlot(1,'pos-right');
  if(words[2]) makeSlot(2,'pos-off-right');
}

// --- Microphone init + RMS scrolling ---
async function initMic(){
  try{
    // Get MAXIMUM quality audio - try without specific sample rate first
    const audioConstraints = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };

    // Try with preferred sample rates
    for (const sampleRate of [48000, 44100, 16000]) {
      try {
        const constraintsWithSampleRate = {
          ...audioConstraints,
          sampleRate: { ideal: sampleRate, max: sampleRate }
        };
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: constraintsWithSampleRate
        });
        console.log(`Acquired microphone at ${sampleRate}Hz`);
        break;
      } catch (e) {
        console.log(`Failed to get ${sampleRate}Hz, trying next...`);
      }
    }
    
    if (!mediaStream) {
      // Final fallback - let browser choose without sample rate constraint
      mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: audioConstraints 
      });
      console.log("Using browser-default audio quality");
    }
    
    // Start the FIRST batch recording
    startNewBatchRecording();
    
    // Setup audio context for RMS detection
    const track = mediaStream.getAudioTracks()[0];
    const settings = track.getSettings();
    const actualSampleRate = settings.sampleRate || 48000;
    
    audioContext = new (window.AudioContext||window.webkitAudioContext)({
      sampleRate: actualSampleRate,
      latencyHint: 'playback'
    });
    
    console.log(`Audio context running at ${audioContext.sampleRate}Hz`);
    
    const source = audioContext.createMediaStreamSource(mediaStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3; // Faster response for silence detection
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    let triggerCooldown = false;
    let lastRMS = 0;

    function check(){
      if (!audioContext) return;
      
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for(let i = 0; i < data.length; i++){ 
        const v = (data[i] - 128) / 128; 
        sum += v * v; 
      }
      const rms = Math.sqrt(sum / data.length);
      const thr = parseFloat(thresholdSlider.value);
      
      // Detect silence for batch completion
      if (rms < thr * 0.3 && lastRMS > thr * 0.5) {
        // Just became quiet after being loud
        if (!silenceStartTime && currentBatchWords.length > 0) {
          silenceStartTime = Date.now();
          console.log("Silence detected, starting timer...");
        }
      } else if (rms > thr * 0.5) {
        // Became loud again, reset silence timer
        silenceStartTime = null;
      }
      
      // If we've been silent for 400ms and have words, complete the batch
      if (silenceStartTime && (Date.now() - silenceStartTime) > 400 && currentBatchWords.length > 0) {
        console.log("Silence threshold reached, completing batch");
        completeCurrentBatch();
        silenceStartTime = null;
      }
      
      if(rms > thr && armed && !triggerCooldown){ 
        console.log("Triggering scroll - RMS:", rms, "Threshold:", thr);
        triggerScroll(); 
        armed = false;
        triggerCooldown = true;
        
        setTimeout(() => { 
          triggerCooldown = false; 
        }, 300);
        
        setTimeout(() => { 
          armed = true; 
        }, 600);
      }
      else if(rms < thr * 0.4) {
        armed = true;
      }
      
      lastRMS = rms;
      requestAnimationFrame(check);
    }
    check();
  }catch(e){ 
    console.error("Microphone initialization failed:", e);
    alert("Could not access microphone. Please check permissions and try again.");
  }
}

// --- Start NEW MediaRecorder for each batch ---
function startNewBatchRecording() {
  currentBatchAudioChunks = [];
  batchStartTime = Date.now();
  
  if (mediaStream) {
    // Use FFmpeg-compatible formats in priority order
    const formatPriority = [
      'audio/wav',                 // PCM WAV (easy for Whisper)
      'audio/webm;codecs=opus',    // fallback
      'audio/mp4'
    ];
    
    let selectedFormat = '';
    for (const format of formatPriority) {
      if (MediaRecorder.isTypeSupported(format)) {
        selectedFormat = format;
        console.log(`Using format: ${format}`);
        break;
      }
    }
    
    if (!selectedFormat) {
      selectedFormat = ''; // Let browser choose
      console.log("No preferred format supported, using browser default");
    }
    
    const options = {
      mimeType: selectedFormat,
      audioBitsPerSecond: 128000 // Good quality for speech
    };
    
    mediaRecorder = new MediaRecorder(mediaStream, options);
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        currentBatchAudioChunks.push(event.data);
        console.log(`Received audio chunk: ${event.data.size} bytes`);
      }
    };
    
    mediaRecorder.onstop = () => {
      console.log("MediaRecorder stopped, processing batch...");
      
      // Create the complete batch audio blob from ALL chunks
      if (currentBatchAudioChunks.length > 0 && currentBatchWords.length > 0) {
        const batchBlob = new Blob(currentBatchAudioChunks, { type: options.mimeType });
        const duration = ((Date.now() - batchStartTime) / 1000).toFixed(2);
        console.log(`Batch ${currentBatchNumber} complete: ${batchBlob.size} bytes, ${duration}s`);
        
        // Store batch
        batchAudioBlobs[currentBatchNumber - 1] = batchBlob;
        
        // Log batch audio immediately
        logBatchAudio(currentBatchNumber, batchBlob, currentBatchWords);
        
        // Upload batch INSTANTLY
        uploadBatchAsync(currentBatchNumber, batchBlob, currentBatchWords);
        
        console.log("Batch processed");
        showStatus("Batch processed");
      }
      
      // Start next batch recording after a clean break
      setTimeout(() => {
        currentBatchNumber++;
        currentBatchWords = [];
        currentBatchWordObjects = [];
        startNewBatchRecording();
      }, 100); // Small delay to ensure clean separation
    };
    
    // Start recording WITHOUT timeslice for cleaner batch separation
    mediaRecorder.start();
    console.log(`Started NEW MediaRecorder for batch ${currentBatchNumber} (${selectedFormat || 'browser-default'})`);
  }
}

// --- Complete current batch immediately ---
function completeCurrentBatch() {
  if (mediaRecorder && mediaRecorder.state === 'recording' && currentBatchWords.length > 0) {
    console.log("Completing batch immediately via stop() in 400ms...");
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop(); // triggers onstop which processes the batch
        console.log("Batch stop triggered after delay");
      }
    }, 1000); // <-- 1000ms delay before stopping
  }
}

// --- Upload batch ASYNC and handle transcription ---
async function uploadBatchAsync(batchNumber, blob, words) {
  // Determine file extension based on MIME type
  let extension = 'webm'; // default
  if (blob.type.includes('mp4')) extension = 'mp4';
  if (blob.type.includes('ogg')) extension = 'ogg';
  if (blob.type.includes('opus')) extension = 'opus';
  
  const formData = new FormData();
  const wordsString = words.join('_');
  const filename = `batch_${batchNumber}_${wordsString}.${extension}`;
  
  formData.append("file", blob, filename);

  console.log(`INSTANT Upload: ${filename} (${blob.size} bytes)`);
  
  // Fire and await the transcription response
  try {
    const response = await fetch(API_URL, {
      method: "POST", 
      body: formData
    });
    
    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    
    const data = await response.json();
    console.log(`Batch ${batchNumber} upload complete:`, data);
    
    // Extract only what we need from the response
    const transcriptionData = {
      text: data.text || "",
      segments: data.segments || []
    };
    
    // Update the batch entry with transcription results
    updateBatchWithTranscription(batchNumber, transcriptionData, currentBatchWordObjects);
    
    showStatus(`Batch ${batchNumber} transcribed!`);
    
  } catch (error) {
    console.error(`Upload failed for batch ${batchNumber}:`, error);
    showStatus(`Batch ${batchNumber} failed!`);
  }
}

// --- Check if transcribed text matches patterns ---
function evaluateTranscription(transcribedText, wordObject) {
  const normalizedText = transcribedText.toLowerCase().trim();
  
  // Check correct patterns first
  if (wordObject.correct && Array.isArray(wordObject.correct)) {
    for (const pattern of wordObject.correct) {
      // Convert simple string to regex pattern (escape special chars and make case insensitive)
      const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedPattern}$`, 'i');
      if (regex.test(normalizedText)) {
        return { 
          correct: true, 
          matchedPattern: pattern,
          message: "Correct pronunciation!"
        };
      }
    }
  }
  
  // Check incorrect patterns
  if (wordObject.incorrect && Array.isArray(wordObject.incorrect)) {
    for (const pattern of wordObject.incorrect) {
      const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedPattern}$`, 'i');
      if (regex.test(normalizedText)) {
        return { 
          correct: false, 
          matchedPattern: pattern,
          message: "Incorrect pronunciation detected"
        };
      }
    }
  }
  
  // If no patterns matched, consider it incorrect but with unknown pattern
  return { 
    correct: false, 
    matchedPattern: null,
    message: "No matching pattern found - check pronunciation"
  };
}




// --- Update batch entry with transcription results ---
// --- Update batch entry with transcription results ---
// --- Update batch entry with transcription results ---
function updateBatchWithTranscription(batchNumber, transcriptionData, originalWordObjects) {
  // Find the batch entry in the log
  const batchEntries = document.querySelectorAll('.batch-entry');
  const batchEntry = batchEntries[batchNumber - 1];
  
  if (!batchEntry) {
    console.warn(`Batch entry ${batchNumber} not found`);
    return;
  }
  
  // Remove loading indicator
  const loadingDiv = batchEntry.querySelector('.transcription-loading');
  if (loadingDiv) {
    loadingDiv.remove();
  }
  
  // Create transcription table
  const table = document.createElement('table');
  table.className = 'transcription-table';
  
  // Create table header
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>#</th>
      <th>Expected</th>
      <th>You pronounced</th>
      <th>Start</th>
      <th>End</th>
      <th>Confidence</th>
      <th>Result</th>
    </tr>
  `;
  table.appendChild(thead);
  
  // Create table body
  const tbody = document.createElement('tbody');
  
  // Extract all words from segments with their timestamps
  const allTranscribedWords = [];
  transcriptionData.segments.forEach(segment => {
    if (segment.words && Array.isArray(segment.words)) {
      segment.words.forEach(word => {
        allTranscribedWords.push({
          word: word.word ? word.word.trim() : "",
          start: word.start || 0,
          end: word.end || 0,
          confidence: word.probability || word.confidence || "N/A"
        });
      });
    }
  });
  
  console.log(`All transcribed words with timestamps:`, allTranscribedWords);
  console.log(`Expected words for this batch:`, originalWordObjects);
  console.log(`Displayed words with timestamps:`, displayedWords);
  
  // Calculate accuracy score using regex evaluation
  let correctCount = 0;
  
  // Find the displayed words that belong to this batch
  const batchStartIdx = (batchNumber - 1) * SUBMISSION_INTERVAL;
  const batchDisplayedWords = displayedWords.filter(dw => 
    dw.idx >= batchStartIdx && dw.idx < batchStartIdx + SUBMISSION_INTERVAL
  );
  
  console.log(`Batch displayed words:`, batchDisplayedWords);
  
  // Match transcribed words to expected words based on timing
  originalWordObjects.forEach((expectedWordObj, index) => {
    const displayedWord = batchDisplayedWords[index];
    
    if (!displayedWord) {
      console.warn(`No displayed word found for expected word: ${expectedWordObj.word}`);
      return;
    }
    
    // Find transcribed words that were spoken during the time this word was displayed
    // The word was displayed from displayedWord.time until the next word's time (or end of batch)
    const wordDisplayStart = displayedWord.time;
    const wordDisplayEnd = batchDisplayedWords[index + 1] ? batchDisplayedWords[index + 1].time : batchStartTime + ((Date.now() - batchStartTime));
    
    // Convert to seconds (from milliseconds)
    const displayStartSec = (wordDisplayStart - batchStartTime) / 1000;
    const displayEndSec = (wordDisplayEnd - batchStartTime) / 1000;
    
    console.log(`Word "${expectedWordObj.word}" was displayed from ${displayStartSec.toFixed(2)}s to ${displayEndSec.toFixed(2)}s`);
    
    // Find transcribed words that overlap with this display time
    const matchingTranscribedWords = allTranscribedWords.filter(tw => {
      const wordMidpoint = (tw.start + tw.end) / 2;
      return wordMidpoint >= displayStartSec && wordMidpoint <= displayEndSec;
    });
    
    // Use the best matching transcribed word (highest confidence) or the first one
    const bestTranscribedWord = matchingTranscribedWords.length > 0 
      ? matchingTranscribedWords.reduce((best, current) => 
          (current.confidence > best.confidence) ? current : best
        )
      : { word: "—", start: 0, end: 0, confidence: "N/A" };
    
    // Clean up the transcribed word (remove punctuation, etc.)
    let transcribedText = bestTranscribedWord.word.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "").trim().toLowerCase();
    if (transcribedText === "") transcribedText = "—";
    
    // Evaluate the transcription against the word object's patterns
    const evaluation = evaluateTranscription(transcribedText, expectedWordObj);
    
    if (evaluation.correct) {
      correctCount++;
    }
    
    const row = document.createElement('tr');
    
    const confidence = bestTranscribedWord.confidence !== "N/A" && bestTranscribedWord.confidence > 0 
      ? (bestTranscribedWord.confidence * 100).toFixed(1) + "%" 
      : "N/A";
    
    row.innerHTML = `
      <td class="time-cell">${index + 1}</td>
      <td class="word-cell"><strong>${expectedWordObj.word}</strong></td>
      <td class="word-cell">${bestTranscribedWord.word}</td>
      <td class="time-cell">${bestTranscribedWord.start ? bestTranscribedWord.start.toFixed(2) + "s" : "—"}</td>
      <td class="time-cell">${bestTranscribedWord.end ? bestTranscribedWord.end.toFixed(2) + "s" : "—"}</td>
      <td class="time-cell">${confidence}</td>
      <td class="word-cell">${evaluation.correct ? "✅" : "❌"}</td>
    `;
    
    // Add visual feedback and tooltip
    if (evaluation.correct) {
      row.style.background = 'rgba(0, 255, 0, 0.1)';
      row.title = evaluation.message + (evaluation.matchedPattern ? ` (matched: ${evaluation.matchedPattern})` : "");
    } else if (bestTranscribedWord.word === "—") {
      row.style.background = 'rgba(128, 128, 128, 0.1)';
      row.title = "No transcription for this word";
    } else {
      row.style.background = 'rgba(255, 0, 0, 0.2)';
      row.title = evaluation.message + (evaluation.matchedPattern ? ` (matched: ${evaluation.matchedPattern})` : "");
    }
    
    tbody.appendChild(row);
  });
  
  // Add any extra transcribed words that didn't match expected words
  const matchedTranscribedWords = originalWordObjects.map((_, index) => {
    const displayedWord = batchDisplayedWords[index];
    if (!displayedWord) return null;
    
    const wordDisplayStart = displayedWord.time;
    const wordDisplayEnd = batchDisplayedWords[index + 1] ? batchDisplayedWords[index + 1].time : batchStartTime + ((Date.now() - batchStartTime));
    const displayStartSec = (wordDisplayStart - batchStartTime) / 1000;
    const displayEndSec = (wordDisplayEnd - batchStartTime) / 1000;
    
    const matchingTranscribedWords = allTranscribedWords.filter(tw => {
      const wordMidpoint = (tw.start + tw.end) / 2;
      return wordMidpoint >= displayStartSec && wordMidpoint <= displayEndSec;
    });
    
    return matchingTranscribedWords.length > 0 ? matchingTranscribedWords[0] : null;
  });
  
  const unmatchedTranscribedWords = allTranscribedWords.filter(tw => 
    !matchedTranscribedWords.includes(tw)
  );
  
  unmatchedTranscribedWords.forEach((transcribed, index) => {
    const row = document.createElement('tr');
    
    const confidence = transcribed.confidence !== "N/A" && transcribed.confidence > 0 
      ? (transcribed.confidence * 100).toFixed(1) + "%" 
      : "N/A";
    
    row.innerHTML = `
      <td class="time-cell">—</td>
      <td class="word-cell">—</td>
      <td class="word-cell">${transcribed.word}</td>
      <td class="time-cell">${transcribed.start ? transcribed.start.toFixed(2) + "s" : "—"}</td>
      <td class="time-cell">${transcribed.end ? transcribed.end.toFixed(2) + "s" : "—"}</td>
      <td class="time-cell">${confidence}</td>
      <td class="word-cell">—</td>
    `;
    
    row.style.background = 'rgba(255, 165, 0, 0.1)';
    row.title = "Extra transcribed word not in expected list";
    
    tbody.appendChild(row);
  });
  
  table.appendChild(tbody);
  
  // Calculate accuracy percentage
  const accuracy = originalWordObjects.length > 0 ? (correctCount / originalWordObjects.length) * 100 : 0;
  
  // Create score display
  const scoreDiv = document.createElement('div');
  scoreDiv.className = 'batch-score';
  
  let scoreClass = 'score-poor';
  if (accuracy >= 80) scoreClass = 'score-perfect';
  else if (accuracy >= 60) scoreClass = 'score-good';
  
  scoreDiv.classList.add(scoreClass);
  scoreDiv.innerHTML = `<strong>Pronunciation Accuracy: ${accuracy.toFixed(1)}%</strong> (${correctCount}/${originalWordObjects.length} words correct)`;
  
  // Insert the elements before the waveform
  const waveform = batchEntry.querySelector('.waveform');
  if (waveform) {
    batchEntry.insertBefore(scoreDiv, waveform);
    batchEntry.insertBefore(table, waveform);
  } else {
    batchEntry.appendChild(scoreDiv);
    batchEntry.appendChild(table);
  }
}



// --- Word tracking (no individual audio) ---
function trackWord(idx){
  if(!mediaStream) return;
  
  // Only track actual words, not blank separators
  if (words[idx] !== "") {
    currentBatchWords.push(words[idx]);
    
    // Find the corresponding word object from wordData
    const wordObject = wordData.find(w => w.word === words[idx]);
    if (wordObject) {
      currentBatchWordObjects.push(wordObject);
    } else {
      // Fallback if word not found in data
      currentBatchWordObjects.push({ word: words[idx] });
    }
    
    displayedWords.push({word:words[idx], idx, time:performance.now()});
    console.log(`📝 Tracked word: ${words[idx]} for batch ${currentBatchNumber}`);
    
    // Reset silence detection when we get a new word
    silenceStartTime = null;
    
    // Check if we've reached the submission interval
    if (currentBatchWords.length >= SUBMISSION_INTERVAL) {
      console.log("📦 5 words reached, completing batch");
      setTimeout(() => completeCurrentBatch(), 100); // Small delay to capture final audio
    }
  }
}

// --- Log complete batch audio ---
function logBatchAudio(batchNumber, blob, words) {
  const batchEntry = document.createElement('div');
  batchEntry.className = "batch-entry";
  
  const batchTitle = document.createElement("div");
  batchTitle.className = "batch-title";
  batchTitle.textContent = `Batch ${batchNumber}: ${words.join(' ')}`;
  
  const playBtn = document.createElement("button");
  playBtn.textContent = "Play Batch";
  playBtn.className = "playBtn";
  
  const waveDiv = document.createElement("div");
  waveDiv.className = "waveform";

  // Create loading indicator for transcription
  const loadingDiv = document.createElement('div');
  loadingDiv.className = "transcription-loading";
  loadingDiv.textContent = "Transcribing...";
  loadingDiv.style.margin = '10px 0';

  batchEntry.appendChild(batchTitle);
  batchEntry.appendChild(playBtn);
  batchEntry.appendChild(loadingDiv); // Add loading indicator
  batchEntry.appendChild(waveDiv);
  
  // Try WaveSurfer
  try {
    const ws = WaveSurfer.create({
      container: waveDiv,
      waveColor: '#ffa500',
      progressColor: '#ffcc00',
      height: 80,
      normalize: true,
      barWidth: 2,
      barGap: 1
    });
    
    ws.loadBlob(blob);
    playBtn.onclick = () => ws.playPause();
  } catch (error) {
    console.error("WaveSurfer failed:", error);
    // Fallback to audio element
    const audioUrl = URL.createObjectURL(blob);
    const audioElement = document.createElement('audio');
    audioElement.src = audioUrl;
    audioElement.controls = true;
    batchEntry.appendChild(audioElement);
  }
  
  logDiv.appendChild(batchEntry);
  logDiv.scrollTop = logDiv.scrollHeight;
}

// --- Carousel scroll ---
let animating=false;
function triggerScroll(){
  if(animating || currentIdx>=words.length) return;
  animating=true;
  trackWord(currentIdx);

  const newOffRightIdx = currentIdx+3;
  if(words[newOffRightIdx] && !findSlotByIdx(newOffRightIdx)) makeSlot(newOffRightIdx,'pos-off-right');

  slots.forEach(s=>{
    const el=s.el; el.classList.remove('pos-left','pos-center','pos-right','pos-off-right','pos-off-left');
    const idx=s.idx;
    if(idx===currentIdx-1) el.classList.add('pos-off-left');
    else if(idx===currentIdx) el.classList.add('pos-left','side');
    else if(idx===currentIdx+1) el.classList.add('pos-center');
    else if(idx===currentIdx+2) el.classList.add('pos-right','side');
    else if(idx===currentIdx+3) el.classList.add('pos-off-right');
    else el.classList.add('pos-off-left');
  });

  setTimeout(()=>{
    slots = slots.filter(s=>{ if(s.el.classList.contains('pos-off-left')){ stage.removeChild(s.el); return false; } return true; });
    currentIdx++;
    slots.forEach(s=>{
      s.el.classList.remove('pos-left','pos-center','pos-right','pos-off-right','pos-off-left');
      if(s.idx===currentIdx-1) s.el.classList.add('pos-left','side');
      if(s.idx===currentIdx) s.el.classList.add('pos-center');
      if(s.idx===currentIdx+1) s.el.classList.add('pos-right','side');
      if(s.idx===currentIdx+2) s.el.classList.add('pos-off-right');
    });
    animating=false;
    
    // Check if we've reached a blank word (batch separator)
    if (currentIdx < words.length && words[currentIdx] === "") {
      // Auto-scroll after 1 second (faster!)
      console.log("Blank word - auto-scrolling in 1 second");
      showStatus("Auto-advancing in 1 second");
      autoScrollTimeout = setTimeout(() => {
        console.log("Auto-scrolling from blank word");
        triggerScroll();
      }, 500); // NOTE: THIS IS THE time before scrolling
    }
    
    showProgress();
  }, 450);
}

// --- Show status message ---
function showStatus(message) {
  let statusDiv = document.querySelector('.status');
  if (!statusDiv) {
    statusDiv = document.createElement('div');
    statusDiv.className = 'status';
    document.body.appendChild(statusDiv);
  }
  statusDiv.textContent = message;
  setTimeout(() => {
    if (statusDiv.textContent === message) {
      statusDiv.remove();
    }
  }, 1000); // Shorter status display
}

// --- Show progress ---
function showProgress() {
  let progressDiv = document.querySelector('.progress');
  if (!progressDiv) {
    progressDiv = document.createElement('div');
    progressDiv.className = 'progress';
    document.body.appendChild(progressDiv);
  }
  
  let batchDiv = document.querySelector('.batch-indicator');
  if (!batchDiv) {
    batchDiv = document.createElement('div');
    batchDiv.className = 'batch-indicator';
    document.body.appendChild(batchDiv);
  }
  
  const actualWordCount = words.filter((word, idx) => idx <= currentIdx && word !== "").length;
  const nextBatchIn = SUBMISSION_INTERVAL - (currentBatchWords.length % SUBMISSION_INTERVAL);
  
  progressDiv.textContent = `Words: ${actualWordCount}/${originalWords.length} | Next batch in: ${nextBatchIn} words`;
  batchDiv.textContent = `Current Batch: ${currentBatchNumber} (${currentBatchWords.length} words)`;
}

// --- Setup event listeners ---
function setupEventListeners() {
  // Send full audio to server
  sendBatchBtn.onclick = async ()=>{
    if(!mediaRecorder) return alert("No recording active!");
    sendBatchBtn.disabled=true;

    try {
      // Complete current batch if it has words
      if (currentBatchWords.length > 0) {
        completeCurrentBatch();
      }
      
      showStatus("Final batch requested...");
      
    }catch(e){ 
      console.error("Upload failed:", e);
      showStatus("Upload failed!");
      alert("Upload failed: " + e.message);
    }
    finally{ 
      sendBatchBtn.disabled=false; 
    }
  };

  // Start microphone & scrolling
  stage.addEventListener('click',()=>triggerScroll());
  window.addEventListener('keydown', e=>{
    if(e.code==='Space'){
      e.preventDefault(); 
      triggerScroll();
    }
  });
}

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', initApp);