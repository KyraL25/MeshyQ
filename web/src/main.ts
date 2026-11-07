
import { ControlPort } from "./serial/controlPort";
import { TerminalPort } from "./serial/terminalPort";
import type { WebApiEvent } from "./serial/types";
import "./style.css";


/** Default settings */

// IMPORTANT: Only change this if the default volume in audio_player.c changes
const DEFAULT_VOLUME_PERCENT = 20;

let controlPort: ControlPort | undefined;

/** Connection Check Settings */

const CONNECTION_CHECK_INTERVAL_MS = 2000;
const CONNECTION_TIMEOUT_MS = 1000;
const MAX_FAILED_CHECKS = 2;

let connectionCheckInterval: ReturnType<typeof setInterval> | undefined;
let connectionCheckRunning = false;
let failedConnectionChecks = 0;

/** HTML Layout */

const app = document.querySelector<HTMLDivElement>("#app")!;



app.innerHTML = `
  <!-- Header -->
  <div class="app-header">
    <div class="header-title">
      <h1>MeshyQ</h1>
      <p>Dressage Audio Control</p>
    </div>

    <div class="header-controls">
      <button
        id="theme-toggle"
        class="btn btn-icon theme-toggle"
        type="button"
        aria-label="Switch to light mode"
        title="Toggle light/dark mode"
      >
        <span id="theme-icon">☀</span>
      </button>

      <button
        id="diagnostics-toggle"
        class="btn diagnostics-mode-toggle"
        type="button"
        aria-pressed="false"
        title="Switch between audio controls and diagnostics">Diagnostics</button>

      <button class="btn" id="connect-control" type="button" data-status="disconnected">Connect</button>

      <details class="advanced-controls">
        <summary>Settings</summary>
        <div class="advanced-menu">
          <button class="btn" id="connect-terminal" type="button">Debug</button>
          <button class="btn" id="list-files" type="button" disabled>List Files</button>
        </div>
      </details>
    </div>
  </div>

  <!-- Main Workspace -->
  <div class="arena-content test-hidden">

    <!-- Left Side: Speaker Controls -->
    <div class="speaker-panel">
      <div class="speaker-controls">

        <div class="speaker-controls-header">
          <h2 id="arena-controls-title">Arena Controls</h2>
          <span id="speaker-count" class="speaker-count" data-state="disconnected" hidden>Disconnected</span>
        </div>

        <!-- Arena Size -->
        <div class="control-group diagnostics-arena-setup">
          <label class="control-label">Arena Size</label>

          <div class="option-group arena-options-row">
            <button class="btn option-btn active" id="arena-40" type="button">
              20 × 40 m
            </button>
            <button class="btn option-btn" id="arena-60" type="button">
              20 × 60 m
            </button>
            <button 
              id="flip-arena" 
              class="btn btn-icon rotate-toggle" 
              type="button" title="Flip Arena" 
              aria-label="Flip Arena">↻
            </button>
          </div>
        </div>

        <!-- Normal Audio Controls -->
        <div class="audio-only-controls">

          <!-- Speaker Volume -->
          <div class="control-group">
            <div class="control-value-row">
              <label for="volume-slider">Speaker Volume</label>
              <span id="volume-value">${DEFAULT_VOLUME_PERCENT}%</span>
            </div>

            <input
              type="range"
              id="volume-slider"
              min="1"
              max="100"
              step="1"
              value="${DEFAULT_VOLUME_PERCENT}"
              disabled
            />
          </div>

          <!-- Automatic Audio Cues -->
          <div class="control-group alternating-controls">
            <div class="control-section-heading">
              <label class="control-label">Automatic Audio Cues</label>
              <span id="alternating-mode-status" class="control-state-badge" data-state="off">Off</span>
            </div>

            <button
              id="alternating-mode"
              class="btn btn-full toggle-btn"
              type="button"
            >
              Enable Alternating Cues
            </button>

            <div class="control-group">
              <label class="control-label">
                Number of Alternating Letters
              </label>

              <div class="option-group control-cue-count">
                <button
                  class="btn option-btn"
                  type="button"
                  data-cue-count="1"
                >1</button>

                <button
                  class="btn option-btn active"
                  type="button"
                  data-cue-count="2"
                >2</button>

                <button
                  class="btn option-btn"
                  type="button"
                  data-cue-count="3"
                >3</button>
              </div>
            </div>

            <div class="control-value-row">
              <label for="frequency-slider">Time Between Cues</label>
              <span id="frequency-value">1.0 s</span>
            </div>

            <input
              type="range"
              id="frequency-slider"
              min="0.5"
              max="5"
              step="0.5"
              value="1"
            />

            <div id="alternating-status" class="helper-text" role="status">No active letters selected</div>

            <button
              id="stop-alternating"
              class="btn btn-full toggle-btn"
              type="button"
              disabled
            >
              STOP
            </button>
          </div>

          <!-- Dressage Test Toggle -->
          <div class="control-test-action">
            <button
              id="toggle-test"
              class="btn btn-full toggle-btn"
              type="button"
            >
              Show Dressage Test
            </button>
          </div>

        </div>
        <!-- End Normal Audio Controls -->

        <!-- Diagnostics Controls: existing event-handler IDs preserved -->
        <div id="diagnostics-controls" class="diagnostics-controls" hidden>
          <section class="diagnostics-section diagnostics-speaker-section" aria-label="Speaker Diagnostics">
            <h3>Speaker Diagnostics</h3>
            <button id="diagnostics-discover" type="button" class="btn btn-full toggle-btn">
              Discover Speakers
            </button>
            <div class="diagnostics-test-row">
              <button id="diagnostics-test-all" type="button" class="btn btn-full toggle-btn">
                Test Mesh
              </button>
              <button id="diagnostics-check-audio" type="button" class="btn btn-full toggle-btn">
                Check Audio
              </button>
            </div>
            <p class="helper-text">Select an arena letter to test one speaker.</p>
          </section>

          <section class="diagnostics-section" aria-label="Results">
            <div class="diagnostics-results-header">
              <h3>Results</h3>
              <button class="btn btn-small" id="diagnostics-clear" type="button" title="Clear mesh test results">Clear</button>
            </div>
            <div id="diagnostics-summary" class="diagnostics-summary" aria-live="polite"></div>
            <div id="diagnostics-status" class="diagnostics-status" role="status">
              Connect the control Feather to begin.
            </div>
            <div id="diagnostics-results" class="diagnostics-results"></div>
          </section>
        </div>
        <!-- End Diagnostics Controls -->

      </div>

      <!-- Dressage Arena -->
      <div class="arena-wrapper">

        <div class="arena-field">
          <div class="center-line"></div>

          <!-- Center Letters (visual only / unannounced) -->
          <span class="center-marker" data-center="D">D</span>
          <span class="center-marker long-arena" data-center="L">L</span>
          <span class="center-marker" data-center="X">X</span>
          <span class="center-marker long-arena" data-center="I">I</span>
          <span class="center-marker" data-center="G">G</span>
        </div>

        <!-- 20 × 40 Arena Letters -->
        <button id="Speaker-A" class="arena-letter" data-letter="A">A</button>
        <button id="Speaker-K" class="arena-letter" data-letter="K">K</button>
        <button id="Speaker-E" class="arena-letter" data-letter="E">E</button>
        <button id="Speaker-H" class="arena-letter" data-letter="H">H</button>
        <button id="Speaker-C" class="arena-letter" data-letter="C">C</button>
        <button id="Speaker-M" class="arena-letter" data-letter="M">M</button>
        <button id="Speaker-B" class="arena-letter" data-letter="B">B</button>
        <button id="Speaker-F" class="arena-letter" data-letter="F">F</button>

        <!-- Additional 20 × 60 Arena Letters -->
        <button
          id="Speaker-V"
          class="arena-letter long-arena"
          data-letter="V"
        >V</button>

        <button
          id="Speaker-S"
          class="arena-letter long-arena"
          data-letter="S"
        >S</button>

        <button
          id="Speaker-P"
          class="arena-letter long-arena"
          data-letter="P"
        >P</button>

        <button
          id="Speaker-R"
          class="arena-letter long-arena"
          data-letter="R"
        >R</button>

      </div>
    </div>

    <!-- Right Side: Dressage Test -->
    <div class="test-panel">

      <div class="test-panel-header">
        <h2>Dressage Test</h2>
      </div>

      <!-- Upload Test -->
      <div id="test-upload" class="test-upload">
        <div class="upload-icon">▧</div>

        <h2>Upload your test</h2>

        <p>
          Choose a PDF or images of your dressage test
          to view alongside the arena.
        </p>

        <label for="test-file" class="upload-button">
          Choose Files
        </label>

        <input
          type="file"
          id="test-file"
          accept=".pdf,.jpg,.jpeg,.png"
          multiple
          hidden
        />
      </div>

      <!-- Test Viewer -->
      <div id="test-viewer" class="test-viewer" hidden>

        <div class="test-viewer-header">
          <span id="test-filename"></span>

          <button class="btn btn-small" id="remove-test" type="button">
            Remove
          </button>
        </div>

        <div id="test-preview" class="test-preview"></div>

        <div id="test-navigation" class="test-navigation" hidden>
          <button class="btn btn-small" id="previous-page" type="button">
            Previous
          </button>

          <span id="page-number"></span>

          <button class="btn btn-small" id="next-page" type="button">
            Next
          </button>
        </div>

      </div>
    </div>

  </div>

  <!-- Hidden Node File Listings -->
  <div id="files" hidden></div>

  <!-- System Log -->
  <details class="log-container">
    <summary class="log-header">System Log</summary>
    <pre id="log"></pre>
  </details>
`;




/** HTML Elements */

// Theme toggle
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
const themeIcon = document.querySelector<HTMLElement>("#theme-icon")!;

// Connection buttons
const connectButton = document.querySelector<HTMLButtonElement>("#connect-control")!;
const debugButton = document.querySelector<HTMLButtonElement>("#connect-terminal")!;
const listButton = document.querySelector<HTMLButtonElement>("#list-files")!;

// Diagnostics mode controls
const diagToggle = document.querySelector<HTMLButtonElement>("#diagnostics-toggle")!;
const diagControls = document.querySelector<HTMLDivElement>("#diagnostics-controls")!;
const diagStatus = document.querySelector<HTMLElement>("#diagnostics-status")!;
const diagResults = document.querySelector<HTMLDivElement>("#diagnostics-results")!;
const diagTestAll = document.querySelector<HTMLButtonElement>("#diagnostics-test-all")!;
const diagCount = document.querySelector<HTMLElement>("#speaker-count")!;
const diagSummary = document.querySelector<HTMLElement>("#diagnostics-summary")!;

// Volume control
const volumeSlider = document.querySelector<HTMLInputElement>("#volume-slider")!;
const volumeValue = document.querySelector<HTMLElement>("#volume-value")!;

// Arena controls
const arena40 = document.querySelector<HTMLButtonElement>("#arena-40")!;
const arena60 = document.querySelector<HTMLButtonElement>("#arena-60")!;
const arenaWrapper = document.querySelector<HTMLElement>(".arena-wrapper")!;
const flipArenaButton = document.querySelector<HTMLButtonElement>("#flip-arena")!;

// Alternating cue controls
const alternatingModeButton = document.querySelector<HTMLButtonElement>("#alternating-mode")!;
const stopAlternatingButton = document.querySelector<HTMLButtonElement>("#stop-alternating")!;
const repeatIntervalInput = document.querySelector<HTMLInputElement>("#frequency-slider")!;
const repeatValue = document.querySelector<HTMLElement>("#frequency-value")!;
const alternatingStatus = document.querySelector<HTMLElement>("#alternating-status")!;
const alternatingModeStatus = document.querySelector<HTMLElement>("#alternating-mode-status")!;
const cueCountButtons = document.querySelectorAll<HTMLButtonElement>("[data-cue-count]");

// System log and files
const logEl = document.querySelector<HTMLPreElement>("#log")!;
const filesEl = document.querySelector<HTMLDivElement>("#files")!;

// Dressage test toggle
const toggleTestButton = document.querySelector<HTMLButtonElement>("#toggle-test")!;
const arenaContent = document.querySelector<HTMLElement>(".arena-content")!;

/** Theme Controls */

type Theme = "light" | "dark";

// Apply selected theme
function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;

  themeIcon.textContent = theme === "dark" ? "☀" : "☾";

  themeToggle.setAttribute(
    "aria-label",
    theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
  );

  localStorage.setItem("meshyq-theme", theme);
}

// Restore saved theme (dark mode by default)
const savedTheme = localStorage.getItem("meshyq-theme");

const initialTheme: Theme = savedTheme === "light" ? "light" : "dark";
setTheme(initialTheme);

// Switch themes when clicked
themeToggle.addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme;

  setTheme(currentTheme === "dark" ? "light" : "dark");
});

/** System Log */
function log(line: string): void {
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}


/** Arena Controls */

// Switch between 20x40 and 20x60 arenas
function setArenaSize(size: 40 | 60): void {
  arenaWrapper.classList.toggle("arena-60", size === 60);

  arena40.classList.toggle("active", size === 40);
  arena60.classList.toggle("active", size === 60);
}

// Flip arena orientation by 180 degrees
let arenaFlipped = false;

flipArenaButton.addEventListener("click", () => {
  arenaFlipped = !arenaFlipped;
  arenaWrapper.classList.toggle("flipped", arenaFlipped);
});

/** Alternating Audio Cues */

let alternatingEnabled = false;
let alternatingLetters: string[] = [];
let maxAlternatingLetters = 2;

let repeatTimer: ReturnType<typeof setTimeout> | undefined;
let nextLetterIndex = 0;
let lastCueTime = 0;
let lastPlayedLetter = "";
let cueRequestRunning = false;
let cueGeneration = 0;

// Time between alternating cues, in milliseconds
function getCueSpacing(): number {
  return Number(repeatIntervalInput.value) * 1000;
}

// A single letter repeats every 1, 2, or 3 cue slots
function getPlaybackDelay(): number {
  return getCueSpacing() * (alternatingLetters.length === 1 ? 2 : 1);
}

// Clear a scheduled cue
function clearRepeatTimer(): void {
  if (repeatTimer !== undefined) {
    clearTimeout(repeatTimer);
    repeatTimer = undefined;
  }
}

// Update the buttons and status text
function updateAlternatingUI(): void {
  document.querySelectorAll<HTMLButtonElement>(".arena-letter")
    .forEach((button) => {
      const selected = alternatingLetters.includes(
        button.dataset.letter ?? ""
      );

      button.classList.toggle("alternating-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

  alternatingStatus.textContent = alternatingLetters.length
    ? `Selected letters: ${alternatingLetters.join(" + ")}`
    : "No active letters selected";

  // Reflect whether alternating mode is enabled (not whether audio is playing).
  alternatingModeStatus.textContent = alternatingEnabled ? "On" : "Off";
  alternatingModeStatus.dataset.state = alternatingEnabled ? "on" : "off";

  alternatingModeButton.textContent = alternatingEnabled
    ? "Disable Alternating Cues"
    : "Enable Alternating Cues";

  alternatingModeButton.setAttribute(
    "aria-pressed",
    String(alternatingEnabled)
  );

  stopAlternatingButton.disabled = alternatingLetters.length === 0;
}

// Schedule the next cue
function scheduleNextCue(delay: number): void {
  clearRepeatTimer();

  const generation = cueGeneration;

  repeatTimer = setTimeout(() => {
    repeatTimer = undefined;

    if (generation === cueGeneration) {
      void runNextCue();
    }
  }, Math.max(0, delay));
}

// Send one cue and schedule the following cue
async function runNextCue(): Promise<void> {
  if (
    !alternatingEnabled ||
    alternatingLetters.length === 0 ||
    alternatingLetters.some(l => !speakerVerified(l)) ||
    !controlPort?.connected
  ) {
    return;
  }

  // Do not send overlapping USB requests
  if (cueRequestRunning) {
    scheduleNextCue(100);
    return;
  }

  const generation = cueGeneration;
  const letter = alternatingLetters[nextLetterIndex];

  if (!letter) return;

  nextLetterIndex =
    (nextLetterIndex + 1) % alternatingLetters.length;

  lastPlayedLetter = letter;
  lastCueTime = Date.now();
  cueRequestRunning = true;

  try {
    await playLetter(letter);
  } finally {
    cueRequestRunning = false;
  }

  if (
    generation !== cueGeneration ||
    !alternatingEnabled ||
    alternatingLetters.length === 0
  ) {
    return;
  }

  const elapsed = Date.now() - lastCueTime;
  scheduleNextCue(getPlaybackDelay() - elapsed);
}

// Select or deselect a letter
function selectAlternatingLetter(letter: string): void {
  const existingIndex = alternatingLetters.indexOf(letter);

  if (existingIndex !== -1) {
    // Clicking a selected letter turns it off
    alternatingLetters.splice(existingIndex, 1);
  } else {
    // Remove oldest letter when the selected limit is reached
    if (alternatingLetters.length >= maxAlternatingLetters) {
      alternatingLetters.shift();
    }

    alternatingLetters.push(letter);
  }

  cueGeneration++;
  clearRepeatTimer();
  updateAlternatingUI();

  if (alternatingLetters.length === 0) {
    nextLetterIndex = 0;
    lastCueTime = 0;
    lastPlayedLetter = "";
    return;
  }

  // Move to the next selected letter in the cycle
  const previousIndex = alternatingLetters.indexOf(lastPlayedLetter);
  nextLetterIndex = previousIndex === -1
    ? 0
    : (previousIndex + 1) % alternatingLetters.length;

  // First selected letter plays immediately
  if (lastCueTime === 0) {
    void runNextCue();
    return;
  }

  // Preserve the spacing from the most recent cue
  const elapsed = Date.now() - lastCueTime;
  scheduleNextCue(getPlaybackDelay() - elapsed);
}

// Stop all scheduled repetition
function stopAlternatingCues(): void {
  cueGeneration++;
  clearRepeatTimer();

  alternatingLetters = [];
  nextLetterIndex = 0;
  lastCueTime = 0;
  lastPlayedLetter = "";

  updateAlternatingUI();
}

// Select a maximum of 1, 2, or 3 alternating letters
cueCountButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const count = Number(button.dataset.cueCount);
    if (![1, 2, 3].includes(count)) return;

    maxAlternatingLetters = count;
    cueCountButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });

    // Retain the most recently selected letters if the limit shrinks
    alternatingLetters = alternatingLetters.slice(-maxAlternatingLetters);
    cueGeneration++;
    clearRepeatTimer();
    updateAlternatingUI();

    if (alternatingEnabled && alternatingLetters.length > 0) {
      const previousIndex = alternatingLetters.indexOf(lastPlayedLetter);
      nextLetterIndex = previousIndex === -1
        ? 0
        : (previousIndex + 1) % alternatingLetters.length;
      const elapsed = Date.now() - lastCueTime;
      scheduleNextCue(getPlaybackDelay() - elapsed);
    }
  });
});

// Enable or disable alternating mode
alternatingModeButton.addEventListener("click", () => {
  alternatingEnabled = !alternatingEnabled;
  stopAlternatingCues();
});

// Stop All button
stopAlternatingButton.addEventListener("click", () => {
  stopAlternatingCues();
});

// Update slider label as it moves
repeatIntervalInput.addEventListener("input", () => {
  repeatValue.textContent =
    `${Number(repeatIntervalInput.value).toFixed(1)} s`;
});

// Apply new timing to the next scheduled cue
repeatIntervalInput.addEventListener("change", () => {
  if (alternatingEnabled && alternatingLetters.length > 0) {
    const elapsed = Date.now() - lastCueTime;
    scheduleNextCue(getPlaybackDelay() - elapsed);
  }
});

/** Dressage Test Toggle */

// Show or hide the dressage test viewer
function setTestVisible(visible: boolean): void {
  arenaContent.classList.toggle("test-hidden", !visible);

  toggleTestButton.textContent = visible ? "Hide Test" : "Show Test";
  toggleTestButton.setAttribute("aria-expanded", String(visible));
}

// Toggle test viewer when button is clicked
toggleTestButton.addEventListener("click", () => {
  const currentlyHidden = arenaContent.classList.contains("test-hidden");
  setTestVisible(currentlyHidden);
});


// The exact filename that passed the node's audio-readiness check.
// Prefer WAV when both formats are available; fall back to MP3.
const verifiedAudioFiles = new Map<string, string>();

async function playLetter(letter: string): Promise<void> {
  const filename = verifiedAudioFiles.get(letter);
  if (!filename || !speakerVerified(letter)) {
    log(`${letter}: speaker is not verified for playback.`);
    return;
  }
  await playFile(filename);
}

// Broadcast play command to the mesh
async function playFile(file: string): Promise<void> {
  try {
    const res = await controlPort?.request("cue_play", { filename: file });

    if (res?.ok) {
      log(`Triggered "${file}".`);
    } else {
      log(`cue_play failed: ${res?.error?.message ?? "Not connected"}`);
    }
  } catch (err) {
    log(`cue_play failed: ${(err as Error).message}`);
  }
}

// Switch arena size when button is clicked
arena40.addEventListener("click", () => {
  setArenaSize(40);
  renderDiagResults();
});

arena60.addEventListener("click", () => {
  setArenaSize(60);
  renderDiagResults();
});

// Plays .wav file either single or alternating 
document.querySelectorAll<HTMLButtonElement>(".arena-letter")
  .forEach((button) => {
    button.addEventListener("click", () => {
      const letter = button.dataset.letter;

      if (!letter) return;

      if (diagnosticsMode) {
        void testSpeaker(letter);
      } else if (alternatingEnabled) {
        selectAlternatingLetter(letter);
      } else {
        void playLetter(letter);
      }
    });
  });

/** Volume Control */

// Update displayed percentage while dragging
volumeSlider.addEventListener("input", () => {
  volumeValue.textContent = `${volumeSlider.value}%`;
});

// Broadcast volume when slider is released
volumeSlider.addEventListener("change", async () => {
  const percent = Number(volumeSlider.value);

  try {
    const res = await controlPort?.request("cue_volume_set", { percent });

    if (res?.ok) {
      log(`Mesh volume command sent: ${percent}%`);
    } else {
      log(`Mesh volume failed: ${res?.error?.message ?? "Not connected"}`);
    }
  } catch (err) {
    log(`Mesh volume failed: ${(err as Error).message}`);
  }
});


/** Dressage Test Upload */

const testInput = document.querySelector<HTMLInputElement>("#test-file")!;
const testUpload = document.querySelector<HTMLDivElement>("#test-upload")!;
const testViewer = document.querySelector<HTMLDivElement>("#test-viewer")!;
const testPreview = document.querySelector<HTMLDivElement>("#test-preview")!;
const testFilename = document.querySelector<HTMLElement>("#test-filename")!;
const removeTestButton = document.querySelector<HTMLButtonElement>("#remove-test")!;
const testNavigation = document.querySelector<HTMLDivElement>("#test-navigation")!;
const previousPage = document.querySelector<HTMLButtonElement>("#previous-page")!;
const nextPage = document.querySelector<HTMLButtonElement>("#next-page")!;
const pageNumber = document.querySelector<HTMLElement>("#page-number")!;

let testFiles: File[] = [];
let currentPage = 0;
let currentFileUrl: string | undefined;


// Display selected PDF or image
function showTestPage(): void {
  if (currentFileUrl) {
    URL.revokeObjectURL(currentFileUrl);
    currentFileUrl = undefined;
  }

  testPreview.replaceChildren();

  const file = testFiles[currentPage];
  if (!file) return;

  currentFileUrl = URL.createObjectURL(file);

  testFilename.textContent = file.name;

  if (file.type === "application/pdf") {
    const iframe = document.createElement("iframe");
    iframe.src = currentFileUrl;
    iframe.title = file.name;
    iframe.className = "test-document";
    testPreview.append(iframe);

  } else if (file.type.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = currentFileUrl;
    image.alt = file.name;
    image.className = "test-image";
    testPreview.append(image);
  }

  // Navigation for multiple images
  testNavigation.hidden = testFiles.length <= 1;

  pageNumber.textContent =
    `${currentPage + 1} / ${testFiles.length}`;

  previousPage.disabled = currentPage === 0;
  nextPage.disabled = currentPage === testFiles.length - 1;
}


// Upload a dressage test
testInput.addEventListener("change", () => {
  const files = Array.from(testInput.files ?? []);

  if (files.length === 0) return;

  // Allow one PDF or multiple images
  const pdfFiles = files.filter(
    (file) => file.type === "application/pdf"
  );

  const imageFiles = files.filter(
    (file) => file.type.startsWith("image/")
  );

  if (pdfFiles.length > 0) {
    testFiles = [pdfFiles[0]];
  } else {
    testFiles = imageFiles;
  }

  if (testFiles.length === 0) {
    log("Please select a PDF, JPG, or PNG file.");
    return;
  }

  // Sort images by filename
  if (pdfFiles.length === 0) {
    testFiles.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );
  }

  currentPage = 0;

  testUpload.hidden = true;
  testViewer.hidden = false;

  showTestPage();
  log(`Loaded dressage test: ${testFiles.map(f => f.name).join(", ")}`);
});


// Switch between uploaded images
previousPage.addEventListener("click", () => {
  if (currentPage > 0) {
    currentPage--;
    showTestPage();
  }
});

nextPage.addEventListener("click", () => {
  if (currentPage < testFiles.length - 1) {
    currentPage++;
    showTestPage();
  }
});


// Remove the uploaded dressage test
removeTestButton.addEventListener("click", () => {
  if (currentFileUrl) {
    URL.revokeObjectURL(currentFileUrl);
    currentFileUrl = undefined;
  }

  testFiles = [];
  currentPage = 0;

  testInput.value = "";
  testPreview.replaceChildren();

  testViewer.hidden = true;
  testUpload.hidden = false;

  log("Dressage test removed.");
});


/** File Listings */

// Display playable files from each node
function showNodeFiles(addr: string, reply: string): void {
  const files = reply === "(none)"
    ? []
    : reply.split(",").map((f) => f.trim()).filter(Boolean);

  const section = document.createElement("section");

  const heading = document.createElement("h3");
  heading.textContent = `Node ${addr}`;
  section.append(heading);

  if (files.length === 0) {
    section.append("No playable files.");
  } else {
    const ul = document.createElement("ul");

    for (const file of files) {
      const li = document.createElement("li");
      const button = document.createElement("button");

      button.textContent = file;
      button.addEventListener("click", () => void playFile(file));

      li.append(button);
      ul.append(li);
    }

    section.append(ul);
  }

  filesEl.append(section);
}


/** Mesh Diagnostics (arena letter click = probe) */

const ALL_DIAG_LETTERS = ["A", "K", "E", "H", "C", "M", "B", "F", "V", "S", "P", "R"];
type ProbeState = "testing" | "success" | "failed";
type ProbeResult = { status: ProbeState; rtt?: number; rssi?: number; ttl?: number; updated: number };

let diagnosticsMode = false;
let diagnosticsBusy = false;
let manualDiscoveryPending = false;
const probeResults = new Map<string, ProbeResult>();

// Node identities are discovered from each speaker's SD-card node.cfg.
// Never trust stale browser-stored address mappings to enable audio controls.
const speakerAddresses: Record<string, number | null> = Object.fromEntries(
  ALL_DIAG_LETTERS.map(letter => [letter, null]));
type AudioCheck = { ready: boolean; fileOk: boolean; checked: number };
const audioChecks = new Map<string, AudioCheck>();
const identityConflicts = new Set<string>();
let verifyQueue = Promise.resolve();
let discoverySweepTimer: ReturnType<typeof setInterval> | undefined;
let pendingAudio: { address: number; letter: string; resolve: (ok: boolean) => void; filename: string; timer: ReturnType<typeof setTimeout> } | undefined;

function resetSpeakerState(): void {
  for (const letter of ALL_DIAG_LETTERS) speakerAddresses[letter] = null;
  probeResults.clear(); audioChecks.clear(); verifiedAudioFiles.clear(); identityConflicts.clear();
  if (pendingProbe) finishPendingProbe(false);
  if (pendingAudio) {
    const p = pendingAudio; pendingAudio = undefined;
    clearTimeout(p.timer); p.resolve(false);
  }
  renderDiagResults();
  setArenaLettersEnabled(Boolean(controlPort?.connected));
}

let pendingProbe: {
  letter: string;
  address: number;
  resolve: (successful: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
} | undefined;

function formatMeshAddress(addr: number): string {
  return `0x${addr.toString(16).padStart(4, "0").toUpperCase()}`;
}

function diagAddressNumber(value: string): number | null {
  const raw = value.trim();
  if (raw === "") return null;
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(raw)) throw new Error("Use a node address like 0x45C4");
  const addr = /^0x/i.test(raw) ? parseInt(raw.slice(2), 16) : Number(raw);
  if (!Number.isInteger(addr) || addr < 1 || addr > 0x7fff) throw new Error("Invalid mesh unicast address");
  return addr;
}


function speakerVerified(letter: string): boolean {
  const audio = audioChecks.get(letter);
  const probe = probeResults.get(letter);

  return (
    controlPort?.connected === true &&
    speakerAddresses[letter] !== null &&
    !identityConflicts.has(letter) &&
    audio?.ready === true &&
    audio.fileOk === true &&
    verifiedAudioFiles.has(letter) &&
    probe?.status !== "failed"
  );
}


function queueVerification(letter: string): void {
  if (diagnosticsMode) return; // No automatic mesh traffic in Diagnostics.
  verifyQueue = verifyQueue.catch(() => {}).then(async () => {
    if (
      diagnosticsMode || // Drop already queued automatic work once Diagnostics opens.
      !controlPort?.connected ||
      speakerAddresses[letter] === null ||
      identityConflicts.has(letter)
    ) {
      return;
    }

    // First discovery: verify SD card and audio once.
    if (!audioChecks.has(letter)) {
      await checkAudio(letter);
    } else {
      // Later checks: test mesh communication only.
      await probeSpeaker(letter);
    }

    renderDiagResults();
    setArenaLettersEnabled(Boolean(controlPort?.connected));
  });
}


async function discoverSpeakers(): Promise<void> {
  if (!controlPort?.connected) return;
  if (diagnosticsMode && !manualDiscoveryPending) return;
    diagStatus.textContent = "Discovering speakers from SD-card node.cfg files…";
  try {
    const response = await controlPort.request("diag_discover");
    if (!response.ok) throw new Error(response.error?.message ?? "Discovery failed");
  } catch (error) {
    diagStatus.textContent = `Discovery error: ${(error as Error).message}`;
  }
}

async function checkAudio(letter: string): Promise<boolean> {
  const addr = speakerAddresses[letter];
  if (addr === null || !controlPort?.connected) return false;
  verifiedAudioFiles.delete(letter);
  audioChecks.delete(letter);

  // A speaker needs only ONE playable file. Prefer WAV; try MP3 only
  // if WAV is missing, not ready, or the node does not respond.
  for (const filename of [`${letter}.WAV`, `${letter}.MP3`]) {
    let resolveAudio!: (ok: boolean) => void;
    const completed = new Promise<boolean>(resolve => { resolveAudio = resolve; });
    const timer = setTimeout(() => {
      if (pendingAudio?.address === addr && pendingAudio.filename === filename) {
        pendingAudio = undefined;
        resolveAudio(false);
      }
    }, 2500);
    pendingAudio = { letter, address: addr, filename, resolve: resolveAudio, timer };
    try {
      const res = await controlPort.request("diag_audio_check", { addr, filename });
      if (!res.ok) throw new Error(res.error?.message ?? "Audio check failed");
    } catch (error) {
      log(`Audio check ${letter} (${filename}): ${(error as Error).message}`);
      if (pendingAudio?.address === addr && pendingAudio.filename === filename) {
        clearTimeout(timer);
        pendingAudio = undefined;
        resolveAudio(false);
      }
    }
    const ok = await completed;
    if (ok) {
      verifiedAudioFiles.set(letter, filename);
      audioChecks.set(letter, { ready: true, fileOk: true, checked: Date.now() });
      diagStatus.textContent = `${letter}: audio ready (${filename}).`;
      renderDiagResults();
      setArenaLettersEnabled(Boolean(controlPort?.connected));
      return true;
    }
  }

  audioChecks.set(letter, { ready: false, fileOk: false, checked: Date.now() });
  diagStatus.textContent = `${letter}: neither ${letter}.WAV nor ${letter}.MP3 passed the audio check.`;
  renderDiagResults();
  setArenaLettersEnabled(Boolean(controlPort?.connected));
  return false;
}

function setDiagnosticsMode(enabled: boolean): void {
  diagnosticsMode = enabled;
  document.body.classList.toggle("diagnostics-mode", enabled);
  diagControls.hidden = !enabled;
  diagCount.hidden = !enabled;
  diagToggle.classList.toggle("active", enabled);
  diagToggle.setAttribute("aria-pressed", String(enabled));
  diagToggle.textContent = enabled ? "Exit Diagnostics" : "Diagnostics";
  document.querySelector("#arena-controls-title")!.textContent = enabled ? "Mesh Diagnostics" : "Arena Controls";
  setArenaLettersEnabled(Boolean(controlPort?.connected));
  if (enabled) {
    stopAlternatingCues();
    diagStatus.textContent = controlPort?.connected
      ? ""
      : "Connect the control Feather to begin.";
  } else if (controlPort?.connected) {
    // Start an immediate discovery sweep on returning to normal operation.
    void discoverSpeakers();
  }
}


function renderDiagResults(): void {
  // Counts reflect the selected arena. A successful mesh probe and an
  // audio-file readiness check are independent results.
  const visibleLetters = ALL_DIAG_LETTERS.filter(letter =>
    !["V", "S", "P", "R"].includes(letter) || arenaWrapper.classList.contains("arena-60")
  );
  const discovered = visibleLetters.filter(letter => speakerAddresses[letter] !== null);
  const verifiedAudio = discovered.filter(letter =>
    !identityConflicts.has(letter) && audioChecks.get(letter)?.ready === true &&
    audioChecks.get(letter)?.fileOk === true && verifiedAudioFiles.has(letter)
  );
  const meshResponded = discovered.filter(letter => probeResults.get(letter)?.status === "success");
  const meshTested = discovered.filter(letter =>
    ["success", "failed"].includes(probeResults.get(letter)?.status ?? "")
  );
  const expected = visibleLetters.length;
  const connected = controlPort?.connected === true;

  diagCount.hidden = !diagnosticsMode;
  diagCount.dataset.state = connected ? "connected" : "disconnected";
  diagCount.textContent = connected ? `${discovered.length}/${expected} discovered` : "Disconnected";

  // The summary uses real check results; untested speakers aren't counted as failures.
  diagSummary.replaceChildren();
  const stats = [
    {
      label: "Discovered",
      value: `${discovered.length}/${expected}`,
      description: "Speakers with a valid letter identity / expected arena letters.",
    },
    {
      label: "Mesh Responding",
      value: `${meshResponded.length}/${meshTested.length}`,
      description: "Successful replies / speakers with a completed mesh probe. Based on the most recent recorded probe per speaker, not continuous monitoring.",
    },
    {
      label: "Audio Ready",
      value: `${verifiedAudio.length}/${discovered.length}`,
      description: "Speakers passing SD-card and audio-readiness checks / discovered speakers. This does not verify audible sound from the horn.",
    },
  ];
  for (const stat of stats) {
    const item = document.createElement("div");
    item.className = "diagnostics-stat";
    item.title = stat.description;
    item.setAttribute("aria-label", `${stat.label}: ${stat.value}. ${stat.description}`);
    const number = document.createElement("strong");
    number.textContent = stat.value;
    const label = document.createElement("span");
    label.textContent = stat.label;
    item.append(number, label);
    diagSummary.append(item);
  }

  // Preserve expanded rows when refreshing their test results.
  const expanded = new Set(
    Array.from(diagResults.querySelectorAll<HTMLDetailsElement>("details[data-letter]"))
      .filter(row => row.open)
      .map(row => row.dataset.letter)
  );
  diagResults.replaceChildren();

  for (const letter of ALL_DIAG_LETTERS) {
    const button = document.querySelector<HTMLButtonElement>(`.arena-letter[data-letter="${letter}"]`);
    if (!button) continue;
    const addr = speakerAddresses[letter];
    const result = probeResults.get(letter);
    const audio = audioChecks.get(letter);
    const conflict = identityConflicts.has(letter);
    const file = verifiedAudioFiles.get(letter);
    const audioOk = audio?.ready === true && audio.fileOk === true && Boolean(file);
    const failed = conflict || result?.status === "failed" || Boolean(audio && !audioOk);

    // Gray = undiscovered, yellow = testing, red = failed, green = verified.
    // A discovered but untested speaker stays neutral (blue) instead of green.
    button.classList.toggle("diag-undiscovered", addr === null && !conflict);
    button.classList.toggle("diag-success", speakerVerified(letter) && result?.status === "success");
    button.classList.toggle("diag-failed", failed);
    button.classList.toggle("diag-testing", result?.status === "testing");
    button.title = addr === null ? `No ${letter} node discovered` :
      `Speaker ${letter}: ${formatMeshAddress(addr)}`;

    if (!visibleLetters.includes(letter) || (addr === null && !conflict)) continue;

    const row = document.createElement("details");
    row.className = "speaker-result-row";
    row.dataset.letter = letter;
    row.open = expanded.has(letter);
    const summary = document.createElement("summary");
    summary.className = "speaker-result-heading";
    const identifier = document.createElement("span");
    identifier.className = "speaker-result-identifier";
    const letterTag = document.createElement("span");
    letterTag.className = "speaker-result-letter";
    letterTag.textContent = letter;
    const address = document.createElement("span");
    address.textContent = addr === null ? "Address conflict" : formatMeshAddress(addr);
    identifier.append(letterTag, address);
    const status = document.createElement("span");
    status.className = "speaker-result-state";
    status.dataset.state = conflict || failed ? "failed" : result?.status === "testing" ? "testing" : speakerVerified(letter) && result?.status === "success" ? "ready" : "pending";
    status.textContent = conflict ? "Duplicate letter" :
      result?.status === "testing" ? "Testing…" :
      failed ? "Needs attention" :
      speakerVerified(letter) && result?.status === "success" ? "Mesh + audio ready" :
      audioOk ? "Audio ready" : "Discovered";
    summary.append(identifier, status);

    const details = document.createElement("div");
    details.className = "speaker-result-details";
    const fields: Array<[string, string]> = [
      ["Last mesh probe", result?.status === "success" ? "Responded" : result?.status === "failed" ? "No response" : result?.status === "testing" ? "Testing" : "Not tested"],
      ["RTT", result?.rtt === undefined ? "—" : `${result.rtt} ms`],
      ["RSSI", result?.rssi === undefined ? "—" : `${result.rssi} dBm`],
      ["TTL", result?.ttl === undefined ? "—" : String(result.ttl)],
      ["Probe time", result?.status === "success" || result?.status === "failed" ? new Date(result.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—"],
      ["Audio readiness", !audio ? "Not checked" : audioOk ? "Ready" : "Check failed"],
      ["Verified file", file ?? "—"],
    ];
    for (const [labelText, valueText] of fields) {
      const cell = document.createElement("div");
      cell.className = "speaker-result-metric";
      const label = document.createElement("span");
      label.textContent = labelText;
      const value = document.createElement("strong");
      value.textContent = valueText;
      cell.append(label, value);
      details.append(cell);
    }
    row.append(summary, details);
    diagResults.append(row);
  }

  if (discovered.length === 0 && identityConflicts.size === 0) {
    const empty = document.createElement("p");
    empty.className = "diagnostics-empty";
    empty.textContent = connected
      ? "No speakers discovered. Select Discover Speakers to search the mesh."
      : "Connect the control Feather to discover speakers.";
    diagResults.append(empty);
  }
}

function finishPendingProbe(success: boolean, result?: ProbeResult): void {
  if (!pendingProbe) return;
  const pending = pendingProbe;
  clearTimeout(pending.timer);
  pendingProbe = undefined;
  if (result) probeResults.set(pending.letter, result);
  else if (!success) probeResults.set(pending.letter, { status: "failed", updated: Date.now() });
  renderDiagResults();
  setArenaLettersEnabled(Boolean(controlPort?.connected));
  pending.resolve(success);
}


async function testSpeaker(letter: string): Promise<void> {
  if (diagnosticsBusy) return;

  diagnosticsBusy = true;
  diagTestAll.disabled = true;

  try {
    await verifyQueue.catch(() => {});
    await probeSpeaker(letter);
  } finally {
    diagnosticsBusy = false;
    diagTestAll.disabled = false;
  }
}


async function probeSpeaker(letter: string): Promise<boolean> {
  const addr = speakerAddresses[letter];
  if (addr === null) {
    diagStatus.textContent = `Speaker ${letter} has not been discovered. Select Discover Speakers first.`;
    return false;
  }
  if (!controlPort?.connected) {
    diagStatus.textContent = "Connect the control Feather first.";
    return false;
  }
  diagStatus.textContent = `Testing speaker ${letter}…`;
  // Preserve the previously verified audio file.
  // A mesh probe only checks whether the node responds.
  setArenaLettersEnabled(Boolean(controlPort?.connected));

  probeResults.set(letter, { status: "testing", updated: Date.now() });
  renderDiagResults();
  // The firmware can handle one in-flight diagnostic probe at a time.
  let resolveProbe!: (ok: boolean) => void;
  const completed = new Promise<boolean>(resolve => { resolveProbe = resolve; });
  const timer = setTimeout(() => {
    diagStatus.textContent = `No probe response from ${letter} (${formatMeshAddress(addr)}).`;
    finishPendingProbe(false);
  }, 5000);
  pendingProbe = { letter, address: addr, resolve: resolveProbe, timer };
  try {
    const response = await controlPort.request("diag_probe", { addr });
    if (!response.ok) throw new Error(response.error?.message ?? "Probe not accepted");
  } catch (error) {
    diagStatus.textContent = `${letter}: ${(error as Error).message}`;
    if (pendingProbe?.letter === letter) finishPendingProbe(false);
  }
  return completed;
}

function handleDiagnosticReply(addr: string, message: string): boolean {
  if (message.startsWith("diag_result ")) {
    const rtt = /rtt_ms=(\d+)/.exec(message)?.[1];
    const ttl = /ttl=(\d+)/.exec(message)?.[1];
    const rssi = /rssi=(-?\d+)/.exec(message)?.[1];
    const sender = diagAddressNumber(addr);
    if (pendingProbe && sender === pendingProbe.address && rtt && ttl && rssi) {
      const letter = pendingProbe.letter;
      diagStatus.textContent = `${letter} responded in ${rtt} ms.`;
      finishPendingProbe(true, { status: "success", rtt: Number(rtt), ttl: Number(ttl), rssi: Number(rssi), updated: Date.now() });
    }
    return true;
  }
  if (message.startsWith("diag_id ")) {
    const letter = /letter=([A-Z?])/.exec(message)?.[1];
    const valid = /valid=(\d)/.exec(message)?.[1];
    let node: number | null = null;
    try { node = diagAddressNumber(addr); } catch { /* ignore */ }
    if (valid === "1" && letter && ALL_DIAG_LETTERS.includes(letter) && node !== null) {
      const existing = speakerAddresses[letter];
      if (existing !== null && existing !== node) {
        identityConflicts.add(letter);
        probeResults.delete(letter); audioChecks.delete(letter); verifiedAudioFiles.delete(letter);
        diagStatus.textContent = `Duplicate ${letter} assignment: ${formatMeshAddress(existing)} and ${formatMeshAddress(node)}. Fix node.cfg.`;
      } else if (!identityConflicts.has(letter)) {
        speakerAddresses[letter] = node;
        diagStatus.textContent = `Discovered ${letter} at ${formatMeshAddress(node)}; verifying…`;
        // Audio verification runs once for each newly discovered speaker.
        if (!audioChecks.has(letter) && !diagnosticsMode) {
          queueVerification(letter);
        }
      }
      renderDiagResults(); setArenaLettersEnabled(Boolean(controlPort?.connected));
    }
    return true;
  }
  if (message.startsWith("diag_audio ")) {
    let node: number | null = null;
    try { node = diagAddressNumber(addr); } catch { /* ignore */ }
    if (pendingAudio && node === pendingAudio.address) {
      const ready = /ready=(\d)/.exec(message)?.[1] === "1";
      const fileOk = /file_ok=(\d)/.exec(message)?.[1] === "1";
      const file = /file=([^\s]+)/.exec(message)?.[1];
      if (file === pendingAudio.filename) {
        const p = pendingAudio; pendingAudio = undefined; clearTimeout(p.timer);
        p.resolve(ready && fileOk);
        // checkAudio handles fallback and updates readiness when a format succeeds.
      }
    }
    return true;
  }
  // Other diagnostics stay out of the playable-file listing.
  return message.startsWith("diag_probe ") || message.startsWith("diag_hb ");
}

renderDiagResults();

diagToggle.addEventListener("click", () => setDiagnosticsMode(!diagnosticsMode));
document.querySelector<HTMLButtonElement>("#diagnostics-discover")!.addEventListener("click", async () => {
  if (diagnosticsBusy || !controlPort?.connected) return;
  diagnosticsBusy = true;
  manualDiscoveryPending = true;
  try { await discoverSpeakers(); }
  finally { manualDiscoveryPending = false; diagnosticsBusy = false; }
});
document.querySelector<HTMLButtonElement>("#diagnostics-clear")!.addEventListener("click", () => {
  probeResults.clear();
  renderDiagResults(); setArenaLettersEnabled(Boolean(controlPort?.connected));
  diagStatus.textContent = "Mesh test results cleared. Audio readiness retained.";
});
diagTestAll.addEventListener("click", async () => {
  if (diagnosticsBusy) return;
  const letters = ALL_DIAG_LETTERS.filter(letter => speakerAddresses[letter] !== null &&
    (!(["V", "S", "P", "R"].includes(letter)) || arenaWrapper.classList.contains("arena-60")));
  if (!letters.length) {
    diagStatus.textContent = "No speakers discovered yet. Select Discover Speakers first.";
    return;
  }
  diagnosticsBusy = true;
  diagTestAll.disabled = true;
  let passed = 0;
  try {
    await verifyQueue.catch(() => {});
    for (const letter of letters) {
      if (await probeSpeaker(letter)) passed++;
    }
    diagStatus.textContent = `Completed: ${passed}/${letters.length} speakers responded to mesh probes`;
  } finally {
    diagnosticsBusy = false;
    diagTestAll.disabled = false;
  }
});


document
  .querySelector<HTMLButtonElement>("#diagnostics-check-audio")!
  .addEventListener("click", () => {
    if (!controlPort?.connected) return;

    const button =
      document.querySelector<HTMLButtonElement>(
        "#diagnostics-check-audio"
      )!;

    button.disabled = true;

    verifyQueue = verifyQueue
      .catch(() => {})
      .then(async () => {
        const letters = ALL_DIAG_LETTERS.filter(letter =>
          speakerAddresses[letter] !== null &&
          !identityConflicts.has(letter) &&
          (
            !["V", "S", "P", "R"].includes(letter) ||
            arenaWrapper.classList.contains("arena-60")
          )
        );

        let passed = 0;

        for (const letter of letters) {
          if (!controlPort?.connected) break;
          if (await checkAudio(letter)) passed++;
        }

        diagStatus.textContent =
          `Audio check: ${passed}/${letters.length} speakers ready.`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });


/** Mesh Events */

// Handle replies from nodes in the mesh
function handleMeshEvent(event: WebApiEvent): void {
  log(`event: ${JSON.stringify(event)}`);

  if (
    event.event === "chat_message_reply" &&
    event.addr &&
    event.text !== undefined
  ) {
    // Diagnostic responses belong in Settings, not the playable-file list.
    if (handleDiagnosticReply(event.addr, event.text)) return;

    // Volume replies should only show in System Log
    if (
      event.text.startsWith("Volume:") ||
      event.text.startsWith("Volume set to") ||
      event.text.startsWith("Failed to set volume") ||
      event.text.startsWith("Invalid volume")
    ) {
      return;
    }

    /*// Display file replies near the arena
    showNodeFiles(event.addr, event.text); */
  }
}


/** Connection Controls */

// Connect to the control port
async function connectControl(port: ControlPort): Promise<void> {
  stopConnectionChecks();
  updateConnectionStatus("connecting");

  try {
    // Close the previous connection if needed
    if (port.connected) {
      await port.close();
    }

    await port.connect();

    const status = await port.request("status");
    log(`status: ${JSON.stringify(status)}`);

    if (!status.ok) {
      throw new Error(status.error?.message ?? "Failed to read node status");
    }

    log("Control link connected.");
    resetSpeakerState();
    updateConnectionStatus("connected");
/*
    if (discoverySweepTimer) clearInterval(discoverySweepTimer);
    discoverySweepTimer = setInterval(() => {
      if (!controlPort?.connected || diagnosticsMode) return;
      // Normal arena mode only; no automatic mesh traffic in Diagnostics.
      void discoverSpeakers();
      for (const letter of ALL_DIAG_LETTERS) {
        if (speakerAddresses[letter] !== null && !identityConflicts.has(letter)) queueVerification(letter);
      }
      setArenaLettersEnabled(true);
    }, 60000);
*/
    // Keep List Files disabled
    listButton.disabled = true;

    // Enable volume slider
    volumeSlider.disabled = false;

   
if (!diagnosticsMode) await port.request("cue_volume_set", {
  percent: Number(volumeSlider.value),
});

log(`Initial volume set to ${volumeSlider.value}%`);

// Allow the mesh to settle after the initial volume broadcast.
await new Promise<void>(resolve => setTimeout(resolve, 200));

// Automatically discover speakers after connection setup.
if (!diagnosticsMode) {
  log("Starting automatic speaker discovery...");
  await discoverSpeakers();
}

// Start periodic connection checks.
startConnectionChecks(port);


  } catch (err) {
    log(`Failed to connect control link: ${(err as Error).message}`);

    updateConnectionStatus("error");
    volumeSlider.disabled = true;

    stopConnectionChecks();
  }
}

/** Connection Status */

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/*// Enable arena letters only when connected
function setArenaLettersEnabled(enabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement>(".arena-letter").forEach(button => {
    const letter = button.dataset.letter ?? "";
    // Diagnostics letters can initiate a retest even if the node has failed.
    // Audio mode only allows nodes that have passed mesh and audio checks.
    button.disabled = !enabled || speakerAddresses[letter] === null ||
      identityConflicts.has(letter) || (!diagnosticsMode && !speakerVerified(letter));
  });
}*/

function setArenaLettersEnabled(enabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement>(".arena-letter")
    .forEach(button => {
      button.disabled = !enabled;
    });
}

/* // Function for testing only certain letters
function setArenaLettersEnabled(enabled: boolean): void {
  const activeLetters = ["K", "M", "H", "F"];

  document.querySelectorAll<HTMLButtonElement>(".arena-letter")
    .forEach((button) => {
      const letter = button.dataset.letter;

      button.disabled = !enabled || !activeLetters.includes(letter ?? "");
    });
}
*/


function updateConnectionStatus(status: ConnectionStatus): void {
  const statusChanged = connectButton.dataset.status !== status;
  connectButton.dataset.status = status;
  // Only refresh the list on a status transition, not on every periodic ping.
  if (statusChanged && status !== "connecting") renderDiagResults();

  // Only allow letters to be clicked when connected
  setArenaLettersEnabled(status === "connected");

  // Stop automatic cues if the control link disconnects
  if (status !== "connected") {
    stopAlternatingCues();
    if (discoverySweepTimer) { clearInterval(discoverySweepTimer); discoverySweepTimer = undefined; }
    if (status !== "connecting") resetSpeakerState();
  }
  
  switch (status) {
    case "connecting":
      connectButton.textContent = "Connecting...";
      connectButton.disabled = true;
      break;

    case "connected":
      connectButton.textContent = "Connected";
      connectButton.disabled = false;
      break;

    case "error":
      connectButton.textContent = "Retry Connection";
      connectButton.disabled = false;
      break;

    default:
      connectButton.textContent = "Connect";
      connectButton.disabled = false;
  }
}

// Stop checking the control port
function stopConnectionChecks(): void {
  if (connectionCheckInterval !== undefined) {
    clearInterval(connectionCheckInterval);
    connectionCheckInterval = undefined;
  }
}

// Check if the control port is still responding
async function checkConnection(port: ControlPort): Promise<void> {
  if (connectionCheckRunning) return;

  connectionCheckRunning = true;

  try {
    const res = await port.request(
      "ping",
      undefined,
      CONNECTION_TIMEOUT_MS
    );

    if (!res.ok) {
      throw new Error(res.error?.message ?? "Ping failed");
    }

    // Reset failed checks when the Feather responds
    failedConnectionChecks = 0;
    updateConnectionStatus("connected");

  } catch (err) {
    failedConnectionChecks++;

    log(`Connection check failed (${failedConnectionChecks}): ${(err as Error).message}`);

    if (failedConnectionChecks >= MAX_FAILED_CHECKS) {
      log("Control link disconnected.");

      updateConnectionStatus("error");
      volumeSlider.disabled = true;

      stopConnectionChecks();
      await port.close();
    }

  } finally {
    connectionCheckRunning = false;
  }
}

// Start checking the port every 2 seconds
function startConnectionChecks(port: ControlPort): void {
  stopConnectionChecks();

  failedConnectionChecks = 0;
  connectionCheckRunning = false;

  connectionCheckInterval = setInterval(() => {
    void checkConnection(port);
  }, CONNECTION_CHECK_INTERVAL_MS);
}

// List files from mesh nodes
async function listMeshFiles(port: ControlPort): Promise<void> {
  filesEl.textContent = "";

  try {
    const res = await port.request("cue_list");

    if (!res.ok) {
      log(`cue_list failed: ${res.error?.message ?? "unknown error"}`);
    } else {
      log("List request broadcast; waiting for node replies...");
    }
  } catch (err) {
    log(`cue_list failed: ${(err as Error).message}`);
  }
}

// Connect to debug port
async function connectDebug(port: TerminalPort): Promise<void> {
  try {
    await port.connect();
    log("Debug terminal connected (raw byte access only; terminal UI is future work).");
  } catch (err) {
    log(`Failed to connect debug terminal: ${(err as Error).message}`);
  }
}


/** Start Web App */

// Start with 20x40 arena
setArenaSize(40);

// Start with Connect button disconnected
updateConnectionStatus("disconnected");

if (!("serial" in navigator)) {
  log("Web Serial is not available in this browser.");
} else {
  const port = new ControlPort(handleMeshEvent);
  const terminalPort = new TerminalPort();

  controlPort = port;

  connectButton.addEventListener("click", () => {
    void connectControl(port);
  });

  debugButton.addEventListener("click", () => {
    void connectDebug(terminalPort);
  });

  listButton.addEventListener("click", () => {
    void listMeshFiles(port);
  });
}
