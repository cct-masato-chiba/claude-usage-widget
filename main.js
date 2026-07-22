const { app, BrowserWindow, ipcMain, Tray, Menu, session, shell, Notification, safeStorage, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const Store = require('electron-store');
const { fetchViaWindow, fetchMultipleViaWindow } = require('./src/fetch-via-window');

const GITHUB_OWNER = 'SlavomirDurej';
const GITHUB_REPO = 'claude-usage-widget';

const isWsl = process.platform === 'linux' &&
  (require('os').release().toLowerCase().includes('microsoft') || Boolean(process.env.WSL_DISTRO_NAME));

// WSL's virtual GPU (dxgkrnl/D3D12) corrupts composited frames — windows render
// with an X-cross artifact. Software rendering avoids it. Transparency is also
// unsupported by WSLg, so the window falls back to opaque there.
if (isWsl) {
  app.disableHardwareAcceleration();
}

// Migration: Handle old encrypted config files from v1.7.0 and earlier
// Must happen BEFORE creating Store instance to prevent parse errors
const fs = require('fs');
const os = require('os');

// electron-store uses different paths per platform
let configPath;
if (process.platform === 'darwin') {
  configPath = path.join(os.homedir(), 'Library', 'Application Support', 'claude-usage-widget', 'config.json');
} else if (process.platform === 'win32') {
  configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-usage-widget', 'config.json');
} else {
  // Linux
  configPath = path.join(os.homedir(), '.config', 'claude-usage-widget', 'config.json');
}

try {
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath, 'utf-8');
    // Check if file looks encrypted (contains non-JSON garbage or doesn't start with {)
    if (rawData.includes('\u0000') || !rawData.trim().startsWith('{')) {
      console.log('[Migration] Detected old encrypted config from v1.7.0, deleting for fresh start');
      fs.unlinkSync(configPath);
    }
  }
} catch (err) {
  console.error('[Migration] Error checking config file:', err.message);
  // If we can't read it, try to delete it
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch {}
}

// Non-sensitive settings storage (no encryption needed)
const store = new Store();

// Debug mode: set DEBUG_LOG=1 env var or pass --debug flag to see verbose logs.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let sessionTray = null;  // Tray icon for Session usage
let weeklyTray = null;   // Tray icon for Weekly usage

const WIDGET_WIDTH = process.platform === 'darwin' ? 503 : 280;
const WIDGET_HEIGHT = 198; // includes the CPU/RAM system row + divider above the usage blocks
const HISTORY_RETENTION_DAYS = 8;
const CHART_DAYS = 7;
const MAX_HISTORY_SAMPLES = 10000; // Cap total samples to prevent unbounded growth

function storeUsageHistory(data) {
  // Skip write if the session is invalid — a live session always has resets_at timestamps.
  // Absent timestamps mean the API returned empty/zeroed data (dead session, removed device, etc.)
  if (!data.five_hour?.resets_at && !data.seven_day?.resets_at) {
    debugLog('[History] Skipping write — no reset timestamps, likely invalid session data');
    return;
  }

  const organizationId = store.get('organizationId');
  const historyKey = organizationId ? `usageHistory_${organizationId}` : 'usageHistory';

  const timestamp = Date.now();
  let history = store.get(historyKey, []);

  history.push({
    timestamp,
    session: data.five_hour?.utilization || 0,
    weekly: data.seven_day?.utilization || 0,
    sonnet: data.seven_day_sonnet?.utilization || 0,
    opus: data.seven_day_opus?.utilization || 0,
    cowork: data.seven_day_cowork?.utilization || 0,
    design: data.seven_day_omelette?.utilization || 0,
    oauthApps: data.seven_day_oauth_apps?.utilization || 0,
    extraUsage: data.extra_usage?.utilization || 0
  });

  // Rotation: apply both time-based and count-based limits
  const cutoff = timestamp - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  history = history.filter((entry) => entry.timestamp > cutoff);

  if (history.length > MAX_HISTORY_SAMPLES) {
    history = history.slice(history.length - MAX_HISTORY_SAMPLES);
  }

  store.set(historyKey, history);
}

// Migrate legacy single-key history to the per-org namespaced key at startup,
// so get-usage-history reads from the right place before any fetch has run.
function migrateUsageHistoryKey() {
  const organizationId = store.get('organizationId');
  if (!organizationId) return;
  const historyKey = `usageHistory_${organizationId}`;
  if (store.has(historyKey)) return;
  const legacy = store.get('usageHistory', []);
  if (legacy.length > 0) {
    store.set(historyKey, legacy);
    store.delete('usageHistory');
    debugLog('[History] Migrated legacy usageHistory →', historyKey);
  }
}

// Prune all per-org history keys at startup. Trims entries older than the retention
// window and deletes the key entirely if nothing remains — cleans up abandoned accounts.
function pruneStaleHistoryKeys() {
  const cutoff = Date.now() - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const allKeys = Object.keys(store.store);
  for (const key of allKeys) {
    if (!key.startsWith('usageHistory_') && key !== 'usageHistory') continue;
    const history = store.get(key, []);
    const fresh = history.filter((entry) => entry.timestamp > cutoff);
    if (fresh.length === 0) {
      store.delete(key);
      debugLog('[History] Deleted stale key:', key);
    } else if (fresh.length < history.length) {
      store.set(key, fresh);
      debugLog('[History] Pruned', history.length - fresh.length, 'old entries from', key);
    }
  }
}

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// Set sessionKey as a cookie in Electron's session
async function setSessionCookie(sessionKey) {
  await session.defaultSession.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true
  });
  debugLog('sessionKey cookie set in Electron session');
}

function createMainWindow() {
  const savedPosition = store.get('windowPosition');
  const windowOptions = {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    transparent: process.platform !== 'win32' && !isWsl,
    backgroundColor: '#1e1e2e',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : process.platform === 'linux' ? 'assets/logo.png' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (savedPosition) {
    windowOptions.x = savedPosition.x;
    windowOptions.y = savedPosition.y;
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('src/renderer/index.html');
  mainWindow.once('ready-to-show', () => {
    enforceAlwaysOnTop(store.get('settings.alwaysOnTop', true));
  });
  mainWindow.webContents.on('did-finish-load', () => {
    // did-finish-load fires on every (re)load; push fresh readings immediately
    // and start the timers once.
    systemTimer ? pollSystem() : startSystemPolling();
    weatherTimer ? pollWeather() : startWeatherPolling();
  });

  let positionSaveTimer = null;
  mainWindow.on('move', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      const position = mainWindow.getBounds();
      store.set('windowPosition', { x: position.x, y: position.y });
    }, 300);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // On WSL the PowerShell SetWindowPos enforcer keeps the window topmost without
  // the flicker that setAlwaysOnTop causes on RAIL, so skip this re-assertion.
  if (!isWsl) {
    mainWindow.on('blur', () => {
      if (store.get('settings.alwaysOnTop', true)) {
        setTimeout(() => enforceAlwaysOnTop(true), 50);
      }
    });
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Determine background color based on thresholds
 */
function getBackgroundColor(percent, isSession, warnThreshold, dangerThreshold) {
  if (percent >= dangerThreshold) {
    // Red #ef4444
    return { r: 239, g: 68, b: 68 };
  } else if (percent >= warnThreshold) {
    // Amber/Orange #f59e0b
    return { r: 245, g: 158, b: 11 };
  } else {
    // Default colors
    if (isSession) {
      // Purple #8b5cf6
      return { r: 139, g: 92, b: 246 };
    } else {
      // Blue #3b82f6
      return { r: 59, g: 130, b: 246 };
    }
  }
}

/**
 * Bold 8x11 bitmap font for numbers 0-9 (2-pixel strokes for bold look)
 * Each number is represented as an array of 11 rows, each row is 8 bits
 */
const BITMAP_FONT = {
  '0': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '1': [
    0b00011000,
    0b00111000,
    0b01111000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b01111110,
    0b01111110
  ],
  '2': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00011100,
    0b00111000,
    0b01110000,
    0b11100000,
    0b11111111,
    0b11111111
  ],
  '3': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00111100,
    0b00000110,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '4': [
    0b00000110,
    0b00001110,
    0b00011110,
    0b00110110,
    0b01100110,
    0b11111111,
    0b11111111,
    0b00000110,
    0b00000110,
    0b00000110,
    0b00000110
  ],
  '5': [
    0b11111111,
    0b11111111,
    0b11000000,
    0b11000000,
    0b11111100,
    0b00000110,
    0b00000011,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '6': [
    0b00111100,
    0b01111110,
    0b11100000,
    0b11000000,
    0b11111100,
    0b11100110,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '7': [
    0b11111111,
    0b11111111,
    0b00000011,
    0b00000110,
    0b00001100,
    0b00011000,
    0b00110000,
    0b00110000,
    0b01100000,
    0b01100000,
    0b01100000
  ],
  '8': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b01111110,
    0b00111100,
    0b01111110,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '9': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b01111111,
    0b00111111,
    0b00000011,
    0b00000111,
    0b01111110,
    0b00111100
  ]
};

/**
 * Narrow 6x11 bitmap font for 3-digit numbers (100%)
 * Bold version to match
 */
const BITMAP_FONT_NARROW = {
  '0': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '1': [
    0b001100,
    0b011100,
    0b111100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b111111,
    0b111111
  ]
};

/**
 * Draw a crisp bitmap character at position (x, y) in the buffer
 */
function drawChar(buffer, width, height, char, x, y, color, useNarrow = false) {
  const bitmap = useNarrow ? BITMAP_FONT_NARROW[char] : BITMAP_FONT[char];
  if (!bitmap) return useNarrow ? 6 : 8;
  
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const maxCol = useNarrow ? 5 : 7;
  
  for (let row = 0; row < charHeight; row++) {
    for (let col = 0; col < charWidth; col++) {
      if (bitmap[row] & (1 << (maxCol - col))) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = color.b;
          buffer[offset + 1] = color.g;
          buffer[offset + 2] = color.r;
          buffer[offset + 3] = color.a;
        }
      }
    }
  }
  return charWidth;
}

/**
 * Generate a single percentage badge icon with colored background and bitmap text
 * @param {number} percent - Usage percentage (0-100)
 * @param {object} bgColor - Background color {r, g, b}
 * @returns {NativeImage} Generated tray icon
 */
function generatePercentageIcon(percent, bgColor) {
  const width = 20;  // Back to 20x20
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Draw filled square background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = bgColor.b;
      buffer[offset + 1] = bgColor.g;
      buffer[offset + 2] = bgColor.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white text
  const percentText = Math.round(percent).toString();
  const textColor = { r: 255, g: 255, b: 255, a: 255 };
  
  // Use narrow font for 3-digit numbers (100%)
  const useNarrow = percentText.length >= 3;
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const gap = percentText.length >= 3 ? 0 : 1; // 1px gap for 1-2 digits, no gap for 100
  const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
  let startX = Math.floor((width - totalWidth) / 2);
  const startY = Math.floor((height - charHeight) / 2);
  
  // Draw each digit
  for (let i = 0; i < percentText.length; i++) {
    drawChar(buffer, width, height, percentText[i], startX, startY, textColor, useNarrow);
    startX += charWidth + gap;
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Generate a Red X icon for 99-100% usage (maxed out)
 * @returns {NativeImage} Generated red X tray icon
 */
function generateRedXIcon() {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Red background
  const red = { r: 220, g: 53, b: 69 }; // #dc3545
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = red.b;
      buffer[offset + 1] = red.g;
      buffer[offset + 2] = red.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white X (2 pixel thick lines)
  const white = { r: 255, g: 255, b: 255, a: 255 };
  
  // Diagonal line from top-left to bottom-right
  for (let i = 0; i < 11; i++) {
    const x1 = 5 + i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  // Diagonal line from top-right to bottom-left
  for (let i = 0; i < 11; i++) {
    const x1 = 15 - i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}



/**
 * Show the main window without the double-blink artifact on Windows.
 *
 * On Windows, transparent + alwaysOnTop + frameless windows re-enter the DWM
 * compositing pipeline in two steps when shown after hide(): an initial layered
 * window render (blink 1) followed by the alwaysOnTop z-order re-assertion
 * (blink 2). Setting opacity to 0 before show() masks those intermediate states;
 * the window is made opaque again after the DWM has had time to settle (~3 frames).
 * macOS and Linux do not have this issue so they just call show() directly.
 */
function showMainWindowClean() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  enforceAlwaysOnTop(store.get('settings.alwaysOnTop', true));
}

function enforceAlwaysOnTop(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (enabled) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.moveTop();
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
  if (isWsl) {
    enabled ? startWslTopmostEnforcer() : stopWslTopmostEnforcer();
  }
}

/*
 * WSLg limitation: windows are presented through RDP RAIL as regular Windows
 * windows, and the X11 always-on-top hint (_NET_WM_STATE_ABOVE) is not
 * translated to the Windows z-order. So the widget sinks below native Windows
 * apps even with setAlwaysOnTop(true).
 *
 * Workaround: keep a persistent powershell.exe child process (WSL interop)
 * that finds the widget's window by title on the Windows side and re-asserts
 * HWND_TOPMOST via SetWindowPos every few seconds. TOPMOST is sticky, but the
 * loop covers RAIL recreating the window (e.g. after hide/show).
 */
const WSL_TOPMOST_TITLE = 'Claude Usage Widget';
let wslTopmostProc = null;

function wslPsCommand(script) {
  // -EncodedCommand sidesteps quoting issues across the WSL/Windows boundary
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

// WSLg presents the window with the distro name appended to the title
// ("Claude Usage Widget (Ubuntu)"), so the lookup matches by prefix.
const WSL_WIN32_TYPE = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  public static IntPtr Find(string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().StartsWith(prefix)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
`;

function spawnPowershell(args, opts) {
  const { spawn } = require('child_process');
  // Fixed path first: powershell.exe is not on PATH when appendWindowsPath=false
  const fixed = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const exe = fs.existsSync(fixed) ? fixed : 'powershell.exe';
  const child = spawn(exe, args, opts);
  child.on('error', (err) => debugLog('WSL topmost: powershell unavailable: ' + err.message));
  return child;
}

function startWslTopmostEnforcer() {
  if (wslTopmostProc) return;
  // SWP flags 0x13 = NOSIZE | NOMOVE | NOACTIVATE
  const script = `${WSL_WIN32_TYPE}
while ($true) {
  $h = [W]::Find('${WSL_TOPMOST_TITLE}')
  if ($h -ne [IntPtr]::Zero) { [W]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x13) | Out-Null }
  Start-Sleep -Seconds 3
}`;
  wslTopmostProc = spawnPowershell(wslPsCommand(script), { stdio: 'ignore' });
  wslTopmostProc.on('exit', () => { wslTopmostProc = null; });
  debugLog('WSL topmost enforcer started');
}

function stopWslTopmostEnforcer() {
  if (wslTopmostProc) {
    wslTopmostProc.removeAllListeners('exit');
    wslTopmostProc.kill();
    wslTopmostProc = null;
  }
  // One-shot: drop the sticky TOPMOST flag ([IntPtr](-2) = HWND_NOTOPMOST)
  const script = `${WSL_WIN32_TYPE}
$h = [W]::Find('${WSL_TOPMOST_TITLE}')
if ($h -ne [IntPtr]::Zero) { [W]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x13) | Out-Null }`;
  spawnPowershell(wslPsCommand(script), { stdio: 'ignore' });
  debugLog('WSL topmost enforcer stopped');
}

/*
 * System stats (battery + CPU + RAM) reflect the Windows host, not the WSL VM.
 *
 * On WSL, Chromium's navigator.getBattery() has no backend (no UPower/sysfs) and
 * Node's os.cpus()/os.freemem() report the Linux VM, which is meaningless for a
 * desktop widget. So all three are read from the Windows host via a single
 * PowerShell interop call (amortising the ~1s process-spawn cost) and pushed to
 * the renderer. On native platforms battery comes from navigator.getBattery() in
 * the renderer, and CPU/RAM come from the Node os module (real machine there).
 */
const SYSTEM_POLL_MS = 30 * 1000;
let systemTimer = null;
let prevCpuSample = null; // for the native os.cpus() delta

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// WSL path: one PS call returns "SYS <cpu> <ram> <battery>". Uses CIM perf
// classes (not Get-Counter, which has localised counter names on e.g. Japanese
// Windows) and matches Task Manager's numbers:
//   CPU = Processor Information \ % Processor Utility (frequency-scaled, what
//         Task Manager shows; can exceed 100 under turbo, so clamp). Falls back
//         to PerfOS_Processor \ % Processor Time on older Windows lacking it.
//   RAM = (Total - AvailableMBytes) — AvailableMBytes counts standby cache as
//         free, matching Task Manager's "available"; FreePhysicalMemory doesn't.
function pollWslSystem() {
  const script = `$os = Get-CimInstance Win32_OperatingSystem
$pi = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq '_Total' }
if ($pi) {
  $cpu = [math]::Min(100, [math]::Round($pi.PercentProcessorUtility))
} else {
  $c = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' }
  $cpu = if ($c) { [math]::Round($c.PercentProcessorTime) } else { -1 }
}
$m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$totalMB = $os.TotalVisibleMemorySize / 1024
$ram = if ($m -and $totalMB -gt 0) { [math]::Round((($totalMB - $m.AvailableMBytes) / $totalMB) * 100) } else { -1 }
$bat = Get-CimInstance Win32_Battery | Select-Object -First 1
$b = if ($bat) { "$($bat.EstimatedChargeRemaining) $($bat.BatteryStatus)" } else { "none" }
Write-Output "SYS $cpu $ram $b"`;
  const child = spawnPowershell(wslPsCommand(script), { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const match = out.match(/^SYS (-?\d+) (-?\d+) (none|(\d+) (\d+))/m);
    if (!match) return;

    const cpu = Number(match[1]);
    const ram = Number(match[2]);
    const sysload = { available: true };
    if (cpu >= 0) sysload.cpu = cpu;
    if (ram >= 0) sysload.ram = ram;
    sendToRenderer('sysload-status', sysload);

    if (match[3] === 'none') {
      sendToRenderer('battery-status', { available: false });
    } else {
      const level = Number(match[4]);
      const status = Number(match[5]);
      // Win32_Battery.BatteryStatus: 1 = discharging, 4 = low, 5 = critical,
      // 10 = undefined; everything else means on AC / charging
      const charging = ![1, 4, 5, 10].includes(status);
      sendToRenderer('battery-status', { available: true, level, charging });
    }
  });
}

// Native path: CPU% from the delta between two os.cpus() snapshots, RAM from
// os.freemem/totalmem. Battery is handled by navigator.getBattery() in renderer.
function cpuTimesTotal() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

function pollNativeSystem() {
  const cur = cpuTimesTotal();
  const sysload = { available: true, ram: Math.round((1 - os.freemem() / os.totalmem()) * 100) };
  if (prevCpuSample) {
    const idleDiff = cur.idle - prevCpuSample.idle;
    const totalDiff = cur.total - prevCpuSample.total;
    if (totalDiff > 0) sysload.cpu = Math.round(100 - (idleDiff / totalDiff) * 100);
  }
  prevCpuSample = cur;
  sendToRenderer('sysload-status', sysload);
}

function pollSystem() {
  isWsl ? pollWslSystem() : pollNativeSystem();
}

function startSystemPolling() {
  if (systemTimer) return;
  pollSystem();
  systemTimer = setInterval(pollSystem, SYSTEM_POLL_MS);
}

/*
 * Weather comes from Open-Meteo (free, no API key). The main process geocodes
 * each configured location name to coordinates once (cached), then polls the
 * current-conditions endpoint. Runs on every platform.
 */
const WEATHER_POLL_MS = 30 * 60 * 1000;
let weatherTimer = null;
const geoCache = new Map(); // location query -> { lat, lon, name }

function httpsGetJson(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: 5000, headers: { 'User-Agent': 'claude-usage-widget' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function geocode(query) {
  if (geoCache.has(query)) return geoCache.get(query);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=ja&format=json`;
  const data = await httpsGetJson(url);
  const r = data && data.results && data.results[0];
  if (!r) return null;
  const geo = { lat: r.latitude, lon: r.longitude, name: r.name };
  geoCache.set(query, geo);
  return geo;
}

// Reverse-geocode the queried coordinates to a human address (for the tooltip),
// via OpenStreetMap Nominatim. Cached by coord — we poll at most a few points
// every 30 min, well within Nominatim's usage policy.
const reverseGeoCache = new Map(); // "lat,lon" -> address string
async function reverseGeocode(lat, lon) {
  const key = `${lat},${lon}`;
  if (reverseGeoCache.has(key)) return reverseGeoCache.get(key);
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=ja`;
  const data = await httpsGetJson(url);
  const address = data && data.display_name ? data.display_name : null;
  if (address) reverseGeoCache.set(key, address);
  return address;
}

// "lat,lon" (e.g. "35.7295,139.7109") is used verbatim — bypasses geocoding so
// exact spots survive Open-Meteo's imperfect place-name matching.
function parseCoords(query) {
  const m = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, name: query };
}

async function fetchWeatherFor(loc) {
  const geo = parseCoords(loc.query) || await geocode(loc.query);
  if (!geo) return null;
  // Whole day, hourly, in the location's local time so the 4-hour buckets align
  // to local 0-4/4-8/… boundaries.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&hourly=temperature_2m,weather_code&forecast_days=1&timezone=auto`;
  const data = await httpsGetJson(url);
  if (!data || !data.hourly) return null;
  const { time, temperature_2m: temps, weather_code: codes } = data.hourly;

  // Aggregate the 24 hourly samples into six 4-hour buckets.
  // temp = hottest hour in the bucket; code = worst (highest WMO code) in it.
  const buckets = [];
  for (let start = 0; start < 24; start += 4) {
    const t = [];
    const c = [];
    for (let i = 0; i < time.length; i++) {
      const hour = Number(time[i].slice(11, 13)); // "YYYY-MM-DDTHH:MM" → HH
      if (hour >= start && hour < start + 4) {
        t.push(temps[i]);
        c.push(codes[i]);
      }
    }
    if (!t.length) continue;
    buckets.push({ start, temp: Math.round(Math.max(...t)), code: Math.max(...c) });
  }
  const address = await reverseGeocode(geo.lat, geo.lon);
  return { label: loc.label || geo.name, address, buckets };
}

async function pollWeather() {
  const locations = store.get('settings.weatherLocations', []);
  const results = [];
  for (const loc of locations) {
    if (!loc || !loc.query) continue;
    try {
      const w = await fetchWeatherFor(loc);
      if (w) results.push(w);
    } catch (err) {
      debugLog('Weather fetch failed for', loc.query, err.message);
    }
  }
  sendToRenderer('weather-status', results);
}

function startWeatherPolling() {
  if (weatherTimer) clearInterval(weatherTimer);
  pollWeather();
  weatherTimer = setInterval(pollWeather, WEATHER_POLL_MS);
}

function createTray() {
  // Respect the tray stats setting even when createTray is called from generic refresh paths.
  if (!store.get('settings.showTrayStats', false)) {
    destroyTrayIcons();
    return;
  }

  // Rebuild from a clean state if only one of the two stats tray icons survived.
  const hasSessionTray = sessionTray && !sessionTray.isDestroyed();
  const hasWeeklyTray = weeklyTray && !weeklyTray.isDestroyed();
  if (hasSessionTray && hasWeeklyTray) return;
  if (hasSessionTray || hasWeeklyTray) destroyTrayIcons();

  try {
    const staticIconPath = path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : process.platform === 'linux' ? 'assets/tray-icon-linux.png' : 'assets/tray-icon.png');
    
    // Create Weekly tray icon FIRST (left position, blue)
    weeklyTray = new Tray(staticIconPath);
    weeklyTray.setToolTip('Weekly Usage');
    
    // Create Session tray icon SECOND (right position, purple)
    sessionTray = new Tray(staticIconPath);
    sessionTray.setToolTip('Session Usage');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Widget',
        click: () => {
          if (mainWindow) {
            showMainWindowClean();
          } else {
            createMainWindow();
          }
        }
      },
      {
        label: 'Refresh',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('refresh-usage');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Log Out',
        click: async () => {
          store.delete('sessionKey');
          store.delete('organizationId');
          // Clear all Claude.ai cookies and session storage
          const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
          for (const cookie of cookies) {
            await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
          }
          await session.defaultSession.clearStorageData({
            storages: ['localstorage', 'sessionstorage', 'cachestorage'],
            origin: 'https://claude.ai'
          });
          if (mainWindow) {
            mainWindow.webContents.send('session-expired');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          app.quit();
        }
      }
    ]);

    sessionTray.setContextMenu(contextMenu);
    weeklyTray.setContextMenu(contextMenu);

    // Click handlers - swapped order
        weeklyTray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
          mainWindow.hide();
        } else {
          showMainWindowClean();
        }
      }
    });
    
        sessionTray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
          mainWindow.hide();
        } else {
          showMainWindowClean();
        }
      }
    });
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function destroyTrayIcons() {
  // Centralized tray cleanup keeps Linux appindicator hosts from showing stale icons.
  const trays = [sessionTray, weeklyTray];
  sessionTray = null;
  weeklyTray = null;

  for (const tray of trays) {
    if (!tray || tray.isDestroyed()) continue;

    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');

      // On Linux, some appindicator hosts repaint stale tray entries lazily.
      // Clearing the image before destroy gives the host an explicit update.
      if (process.platform === 'linux') {
        tray.setImage(nativeImage.createEmpty());
      }
    } catch (error) {
      console.error('Failed to clear tray icon:', error);
    }

    try {
      tray.destroy();
    } catch (error) {
      console.error('Failed to destroy tray icon:', error);
    }
  }
}

/**
 * Format reset time for tray tooltip
 * @param {string} resetsAt - ISO timestamp string
 * @param {string} timeFormat - '12h' or '24h'
 * @param {boolean} includeDate - Whether to include the date (for weekly resets)
 * @returns {string} Formatted time string
 */
function formatResetTime(resetsAt, timeFormat, includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  
  const formatTime = () => {
    if (timeFormat === '24h') {
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${hours}:${minutes} ${ampm}`;
    }
  };
  
  if (includeDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[date.getMonth()];
    const dayNum = date.getDate();
    return `${monthStr} ${dayNum}, ${formatTime()}`;
  } else {
    return formatTime();
  }
}

/**
 * Update tray icons with current usage data
 * @param {Object} usageData - Usage data object containing session and weekly percentages
 */
function updateTrayIcon(usageData) {
  const showTrayStats = store.get('settings.showTrayStats', false);
  
  if (!showTrayStats) {
    // Destroy only weeklyTray, keeping sessionTray alive as a persistent restore
    // icon. Without it, hide() on Windows leaves no way to restore the window.
    // Apply the same Linux appindicator cleanup that destroyTrayIcons() uses.
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      try {
        weeklyTray.removeAllListeners();
        weeklyTray.setContextMenu(null);
        weeklyTray.setToolTip('');
        if (process.platform === 'linux') weeklyTray.setImage(nativeImage.createEmpty());
        weeklyTray.destroy();
      } catch (_) {}
      weeklyTray = null;
    }
    return;
  }

  // Recreate tray icons if they were destroyed
  if (!sessionTray || sessionTray.isDestroyed() || !weeklyTray || weeklyTray.isDestroyed()) {
    createTray();
  }

  if ((!sessionTray || sessionTray.isDestroyed()) && (!weeklyTray || weeklyTray.isDestroyed())) return;

  // Get threshold settings and time format
  const warnThreshold = store.get('settings.warnThreshold', 75);
  const dangerThreshold = store.get('settings.dangerThreshold', 90);
  const timeFormat = store.get('settings.timeFormat', '12h');

  // Extract percentages and reset times from usage data
  const sessionPercent = usageData?.five_hour?.utilization || 0;
  const sessionResetsAt = usageData?.five_hour?.resets_at;
  const weeklyPercent = usageData?.seven_day?.utilization || 0;
  const weeklyResetsAt = usageData?.seven_day?.resets_at;

  try {
    // Generate Weekly icon (blue background) - LEFT position
    let weeklyIcon;
    if (weeklyPercent >= 99) {
      weeklyIcon = generateRedXIcon();
    } else {
      const weeklyColor = getBackgroundColor(weeklyPercent, false, warnThreshold, dangerThreshold);
      weeklyIcon = generatePercentageIcon(weeklyPercent, weeklyColor);
    }
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      weeklyTray.setImage(weeklyIcon);
      let weeklyTooltip = `Weekly: ${Math.round(weeklyPercent)}%`;
      const weeklyResetTime = formatResetTime(weeklyResetsAt, timeFormat, true);
      if (weeklyResetTime) {
        weeklyTooltip += `\nResets: ${weeklyResetTime}`;
      }
      weeklyTray.setToolTip(weeklyTooltip);
    }
    
    // Generate Session icon (purple background) - RIGHT position
    let sessionIcon;
    if (sessionPercent >= 99) {
      sessionIcon = generateRedXIcon();
    } else {
      const sessionColor = getBackgroundColor(sessionPercent, true, warnThreshold, dangerThreshold);
      sessionIcon = generatePercentageIcon(sessionPercent, sessionColor);
    }
    if (sessionTray && !sessionTray.isDestroyed()) {
      sessionTray.setImage(sessionIcon);
      let sessionTooltip = `Session: ${Math.round(sessionPercent)}%`;
      const sessionResetTime = formatResetTime(sessionResetsAt, timeFormat, false);
      if (sessionResetTime) {
        sessionTooltip += `\nResets: ${sessionResetTime}`;
      }
      sessionTray.setToolTip(sessionTooltip);
    }
  } catch (error) {
    console.error('Failed to update tray icons:', error);
  }
}


// IPC Handlers
ipcMain.handle('get-credentials', () => {
  let sessionKey = null;
  // Try safeStorage first (OS keychain)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    // Fallback: plain storage (legacy or safeStorage unavailable)
    sessionKey = store.get('sessionKey');
  }
  return {
    sessionKey,
    organizationId: store.get('organizationId')
  };
});

ipcMain.handle('save-credentials', async (event, { sessionKey, organizationId }) => {
  // Store session key in OS keychain if available
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(sessionKey);
    store.set('sessionKey_encrypted', encrypted.toString('base64'));
    store.delete('sessionKey'); // Remove legacy plain storage
  } else {
    // Fallback: plain storage
    store.set('sessionKey', sessionKey);
  }
  if (organizationId) {
    store.set('organizationId', organizationId);
  }
  // Also set cookie in Electron session for window-based fetching
  await setSessionCookie(sessionKey);
  return true;
});

ipcMain.handle('delete-credentials', async () => {
  store.delete('sessionKey');
  store.delete('sessionKey_encrypted');
  store.delete('organizationId');
  // Remove all Claude.ai cookies
  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  for (const cookie of cookies) {
    await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
  }
  // Clear any cached data from the Electron session (storage, cache)
  // so nothing lingers on shared machines
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'sessionstorage', 'cachestorage'],
    origin: 'https://claude.ai'
  });
  return true;
});

// Validate a sessionKey by fetching org ID via hidden BrowserWindow
ipcMain.handle('validate-session-key', async (event, sessionKey) => {
  debugLog('Validating session key:', sessionKey.substring(0, 20) + '...');
  try {
    // Set the cookie in Electron's session first
    await setSessionCookie(sessionKey);

    // Fetch organizations using hidden BrowserWindow (bypasses Cloudflare)
    const data = await fetchViaWindow('https://claude.ai/api/organizations');

    if (data && Array.isArray(data) && data.length > 0) {
      // Filter to orgs with 'chat' capability (excludes API-only orgs)
      const chatOrgs = data.filter(org => 
        org.capabilities && org.capabilities.includes('chat')
      );

      if (chatOrgs.length === 0) {
        return { success: false, error: 'No chat-enabled organizations found' };
      }

      // Prioritize Teams org if present, otherwise use first chat org
      const defaultOrg = chatOrgs.find(org => org.raven_type === 'team') || chatOrgs[0];
      const orgId = defaultOrg.uuid || defaultOrg.id;
      
      debugLog(`Session key validated, found ${chatOrgs.length} chat org(s), default org ID:`, orgId);
      
      return { 
        success: true, 
        organizationId: orgId,
        organizations: chatOrgs.map(org => ({
          id: org.uuid || org.id,
          name: org.name,
          isTeam: org.raven_type === 'team'
        }))
      };
    }

    // Check if it's an error response
    if (data && data.error) {
      return { success: false, error: data.error.message || data.error };
    }

    return { success: false, error: 'No organization found' };
  } catch (error) {
    console.error('Session key validation failed:', error.message);
    // Clean up the invalid cookie
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
    return { success: false, error: error.message };
  }
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    if (process.platform === 'darwin') {
      mainWindow.minimize();
    } else {
      const minimizeToTray = store.get('settings.minimizeToTray', false);
      if (minimizeToTray) {
        mainWindow.hide();
      } else {
        mainWindow.minimize();
      }
    }
  }
});

ipcMain.on('close-window', () => {
  const showTrayStats = store.get('settings.showTrayStats', false);
  if (showTrayStats && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  } else {
    app.quit();
  }
});

ipcMain.on('resize-window', (event, height) => {
  if (mainWindow) {
    mainWindow.setContentSize(WIDGET_WIDTH, height);
  }
});

ipcMain.handle('get-window-position', () => {
  if (mainWindow) {
    return mainWindow.getBounds();
  }
  return null;
});

ipcMain.handle('set-window-position', (event, { x, y }) => {
  if (mainWindow) {
    mainWindow.setPosition(x, y);
    return true;
  }
  return false;
});

ipcMain.on('open-external', (event, url) => {
  // Trust boundary enforcement: duplicate allowlist check in main process
  const allowedDomains = ['claude.ai', 'github.com', 'paypal.me'];
  try {
    const parsedUrl = new URL(url);
    const isAllowed = allowedDomains.some(domain => 
      parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
    );
    if (isAllowed) {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked openExternal call to disallowed domain: ${parsedUrl.hostname}`);
    }
  } catch (err) {
    console.warn(`[Security] Blocked openExternal call with invalid URL: ${url}`);
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-usage-history', () => {
  const organizationId = store.get('organizationId');
  const historyKey = organizationId ? `usageHistory_${organizationId}` : 'usageHistory';
  const history = store.get(historyKey, []);
  const cutoff = Date.now() - (CHART_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((entry) => entry.timestamp > cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
});

// Show a native OS desktop notification (Windows toast, macOS NC, Linux libnotify)
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.show();
  }
});

// Resize window for compact vs normal mode
// Compact: 290px wide, normal: 530px wide. Height stays managed by renderer.
ipcMain.on('set-compact-mode', (event, compact) => {
  if (mainWindow) {
    const bounds = mainWindow.getBounds();
    const width = compact ? 290 : WIDGET_WIDTH;
    const height = compact ? 105 : WIDGET_HEIGHT;
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
  }
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    theme: store.get('settings.theme', 'dark'),
    warnThreshold: store.get('settings.warnThreshold', 75),
    dangerThreshold: store.get('settings.dangerThreshold', 90),
    timeFormat: store.get('settings.timeFormat', '12h'),
    weeklyDateFormat: store.get('settings.weeklyDateFormat', 'date'),
    usageAlerts: store.get('settings.usageAlerts', true),
    compactMode: store.get('settings.compactMode', false),
    refreshInterval: store.get('settings.refreshInterval', '300'),
    graphVisible: store.get('settings.graphVisible', false),
    expandedOpen: store.get('settings.expandedOpen', false),
    showTrayStats: store.get('settings.showTrayStats', false),
    weatherLocations: store.get('settings.weatherLocations', [])
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  const supportsLoginItems = process.platform !== 'linux';
  const autoStart = supportsLoginItems ? settings.autoStart : false;

  store.set('settings.autoStart', autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.theme', settings.theme);
  store.set('settings.warnThreshold', settings.warnThreshold);
  store.set('settings.dangerThreshold', settings.dangerThreshold);
  store.set('settings.timeFormat', settings.timeFormat);
  store.set('settings.weeklyDateFormat', settings.weeklyDateFormat);
  store.set('settings.usageAlerts', settings.usageAlerts);
  store.set('settings.compactMode', settings.compactMode);
  store.set('settings.refreshInterval', settings.refreshInterval);
  store.set('settings.graphVisible', settings.graphVisible);
  store.set('settings.expandedOpen', settings.expandedOpen);
  store.set('settings.showTrayStats', settings.showTrayStats);

  // Weather locations may have changed — refetch immediately (also picks up new
  // geocoding for any changed location query)
  if (Array.isArray(settings.weatherLocations)) {
    store.set('settings.weatherLocations', settings.weatherLocations);
    startWeatherPolling();
  }

  const isPortable = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;

  // openAtLogin is not supported on Linux — Electron silently ignores it.
  // Skip the call entirely to avoid misleading behaviour.
  // Also skip for portable builds — autorun via registry is unreliable when the
  // exe path changes with each version. Users should use shell:startup instead.
  if (supportsLoginItems && !isPortable) {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      ...(process.platform !== 'darwin' && { path: app.getPath('exe') })
    });
  }

  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (settings.minimizeToTray) { app.dock.hide(); } else { app.dock.show(); }
    } else {
      mainWindow.setSkipTaskbar(settings.minimizeToTray);
    }
    enforceAlwaysOnTop(settings.alwaysOnTop);
  }

  if (!settings.showTrayStats) {
    // Remove tray icons immediately when the setting is turned off from the UI.
    destroyTrayIcons();
  } else {
    // Refresh tray icons immediately with new threshold settings
    const latestUsageData = store.get('latestUsageData');
    if (latestUsageData) {
      updateTrayIcon(latestUsageData);
    } else {
      // Create empty tray icons now; the next usage refresh will draw the stats.
      createTray();
    }
  }

  return true;
});

// Open a visible BrowserWindow for the user to log in to Claude.ai.
//
// Why we don't embed login directly in the app:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins.
// Instead, we open a standalone browser window, let the user authenticate
// normally, then capture the sessionKey cookie once login completes.
// Do NOT attempt to "fix" this back to an embedded login without verifying
// that Claude.ai/Cloudflare no longer blocks it.
//
// SECURITY: Navigation is restricted to trusted domains (claude.ai and OAuth
// providers) to prevent phishing attacks. Popup windows are blocked. Current
// URL is displayed in the window title bar for transparency.
ipcMain.handle('detect-session-key', async () => {
  // Clear any leftover sessionKey cookie
  try {
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) { /* ignore */ }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Claude Login - https://claude.ai/login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let resolved = false;

    // Security: restrict navigation to trusted domains only
    const allowedLoginDomains = [
      'claude.ai',
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com'
    ];

    loginWin.webContents.on('will-navigate', (event, url) => {
      try {
        const hostname = new URL(url).hostname;
        const isAllowed = allowedLoginDomains.some(domain =>
          hostname === domain || hostname.endsWith('.' + domain)
        );
        if (!isAllowed) {
          event.preventDefault();
          console.warn('[Security] Blocked login navigation to untrusted domain:', url);
        } else {
          // Update title bar to show current URL (read-only)
          loginWin.setTitle(`Claude Login - ${url}`);
        }
      } catch (err) {
        event.preventDefault();
        console.warn('[Security] Blocked login navigation with invalid URL:', url);
      }
    });

    // Update title on OAuth redirects and in-page navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    loginWin.webContents.on('did-navigate-in-page', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    // Security: block popup windows from login page
    loginWin.webContents.setWindowOpenHandler(() => {
      console.warn('[Security] Blocked popup window attempt from login page');
      return { action: 'deny' };
    });

    // Listen for sessionKey cookie being set after login
    const onCookieChanged = (event, cookie, cause, removed) => {
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        resolved = true;
        session.defaultSession.cookies.removeListener('changed', onCookieChanged);
        loginWin.close();
        resolve({ success: true, sessionKey: cookie.value });
      }
    };

    session.defaultSession.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' });
      }
    });

    loginWin.loadURL('https://claude.ai/login');
  });
});

// Check GitHub releases for a newer version
ipcMain.handle('check-for-update', () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'claude-usage-widget',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tag = (data.tag_name || '').replace(/^v/, '');
          const current = app.getVersion();
          if (tag && isNewerVersion(tag, current)) {
            resolve({ hasUpdate: true, version: tag });
          } else {
            resolve({ hasUpdate: false, version: null });
          }
        } catch {
          resolve({ hasUpdate: false, version: null });
        }
      });
    });

    req.on('error', () => resolve({ hasUpdate: false, version: null }));
    req.on('timeout', () => { req.destroy(); resolve({ hasUpdate: false, version: null }); });
    req.end();
  });
});

function isNewerVersion(remote, local) {
  try {
    const parseVersion = (ver) => {
      const [mainVer, preRelease] = ver.split('-');
      const parts = mainVer.split('.').map(Number);
      return {
        major: parts[0] || 0,
        minor: parts[1] || 0,
        patch: parts[2] || 0,
        preRelease: preRelease || null
      };
    };

    const r = parseVersion(remote);
    const l = parseVersion(local);

    // Never notify about pre-release versions (rc, beta, alpha, etc.)
    if (r.preRelease !== null) return false;

    // Compare major.minor.patch
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;

    // Same version numbers — notify if local is a pre-release and remote is stable
    // e.g. local=1.7.5-rc.1, remote=1.7.5 → user should be told stable is out
    return l.preRelease !== null;
  } catch { return false; }
}

ipcMain.handle('fetch-usage-data', async (event, options = {}) => {
  // Use the same credential retrieval logic as get-credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  const organizationId = store.get('organizationId');

  if (!sessionKey || !organizationId) {
    throw new Error('Missing credentials');
  }

  // Ensure cookie is set
  await setSessionCookie(sessionKey);

  // Conditional API polling: Only fetch overage/prepaid if the expand panel is open
  // or if compact mode is disabled (normal mode). This reduces API calls when the
  // user won't see the extra usage data anyway.
  // If forceExtended is passed (e.g., when user clicks expand), use that instead of saved setting
  const expandedOpen = options.forceExtended !== undefined ? options.forceExtended : store.get('settings.expandedOpen', false);
  const compactMode = store.get('settings.compactMode', false);
  const shouldFetchExtended = expandedOpen;

  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;
  const overageUrl = `https://claude.ai/api/organizations/${organizationId}/overage_spend_limit`;
  const prepaidUrl = `https://claude.ai/api/organizations/${organizationId}/prepaid/credits`;

  // Build URL array based on UI state
  const urls = [usageUrl];
  if (shouldFetchExtended) {
    urls.push(overageUrl, prepaidUrl);
    debugLog('[Conditional Polling] Fetching extended data (overage + prepaid) - panel is visible');
  } else {
    debugLog('[Conditional Polling] Skipping extended data - panel not visible');
  }

  // Fetch endpoints sequentially using a single reused BrowserWindow.
  // This reduces memory overhead compared to creating 3 separate windows.
  // Usage is always required; overage and prepaid are conditional based on UI state.
  let usageResult, overageResult, prepaidResult;
  
  try {
    const results = await fetchMultipleViaWindow(urls);
    
    // Always have usage result (first in array)
    usageResult = { status: 'fulfilled', value: results[0] };
    
    // Conditionally map overage/prepaid results
    if (shouldFetchExtended) {
      overageResult = { status: 'fulfilled', value: results[1] };
      prepaidResult = { status: 'fulfilled', value: results[2] };
    } else {
      // Mark as skipped (not an error, just not fetched)
      overageResult = { status: 'skipped', reason: 'UI panel not visible' };
      prepaidResult = { status: 'skipped', reason: 'UI panel not visible' };
    }
  } catch (error) {
    // If any fetch fails, determine which one and set appropriate result statuses
    // For now, if the batch fails, treat usage as failed (required endpoint)
    usageResult = { status: 'rejected', reason: error };
    overageResult = { status: 'rejected', reason: error };
    prepaidResult = { status: 'rejected', reason: error };
  }

  // Usage endpoint is mandatory
  if (usageResult.status === 'rejected') {
    const error = usageResult.reason;
    debugLog('API request failed:', error.message);
    const isBlocked = error.message.startsWith('CloudflareBlocked')
      || error.message.startsWith('CloudflareChallenge')
      || error.message.startsWith('UnexpectedHTML');
    if (isBlocked) {
      store.delete('sessionKey');
      store.delete('organizationId');
      if (mainWindow) {
        mainWindow.webContents.send('session-expired');
      }
      throw new Error('SessionExpired');
    }
    throw error;
  }

  const data = usageResult.value;

  // Merge overage spending data into data.extra_usage
  if (overageResult.status === 'fulfilled' && overageResult.value) {
    const overage = overageResult.value;
    const limit = overage.monthly_credit_limit ?? overage.spend_limit_amount_cents;
    const used = overage.used_credits ?? overage.balance_cents;
    const enabled = overage.is_enabled !== undefined ? overage.is_enabled : (limit != null);

    if (enabled && typeof limit === 'number' && limit > 0 && typeof used === 'number') {
      data.extra_usage = {
        utilization: (used / limit) * 100,
        resets_at: null,
        used_cents: used,
        limit_cents: limit,
        is_enabled: true,
        currency: overage.currency || 'USD',
      };
    } else if (!enabled) {
      // Extra usage is off — still pass the flag so the renderer can show status
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.is_enabled = false;
      data.extra_usage.currency = overage.currency || 'USD';
    }
  } else {
    debugLog('Overage fetch skipped or failed:', overageResult.reason?.message || 'no data');
  }

  // Merge prepaid balance into data.extra_usage
  if (prepaidResult.status === 'fulfilled' && prepaidResult.value) {
    const prepaid = prepaidResult.value;
    if (typeof prepaid.amount === 'number') {
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.balance_cents = prepaid.amount;
      // Use prepaid currency if overage didn't already set one
      if (!data.extra_usage.currency && prepaid.currency) {
        data.extra_usage.currency = prepaid.currency;
      }
    }
  } else {
    debugLog('Prepaid fetch skipped or failed:', prepaidResult.reason?.message || 'no data');
  }

  storeUsageHistory(data);

  // Store latest usage data for settings refresh
  store.set('latestUsageData', data);

  // Update tray icon with current usage data
  updateTrayIcon(data);

  // Re-assert always-on-top after hidden BrowserWindows from fetchViaWindow
  // are destroyed — creating/destroying BrowserWindows can temporarily disrupt
  // the main window's z-order on some OS/window manager combinations.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const alwaysOnTop = store.get('settings.alwaysOnTop', true);
    if (alwaysOnTop) {
      enforceAlwaysOnTop(true);
    }
  }

  return data;
});

// App lifecycle
app.whenReady().then(async () => {
  // Restore session cookie if we have stored credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key on startup:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  if (sessionKey) {
    await setSessionCookie(sessionKey);
  }

  migrateUsageHistoryKey();
  pruneStaleHistoryKeys();

  createMainWindow();
  // Avoid creating temporary tray icons during startup when tray stats are disabled.
  if (store.get('settings.showTrayStats', false)) {
    createTray();
  }

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  const alwaysOnTop = store.get('settings.alwaysOnTop', true);
  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (minimizeToTray) app.dock.hide();
    } else {
      if (minimizeToTray) mainWindow.setSkipTaskbar(true);
    }
    enforceAlwaysOnTop(alwaysOnTop);
  }

  // Periodic always-on-top re-assertion to recover from z-order disruptions
  // (hidden window spawns, window manager shortcuts, alt-tab, etc.)
  //
  // Skipped on WSL: setAlwaysOnTop re-layers the RAIL window every tick, which
  // WSLg renders as a visible flicker. The PowerShell SetWindowPos enforcer keeps
  // the window topmost non-disruptively there, so this loop is redundant on WSL.
  if (!isWsl) {
    setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const alwaysOnTopSetting = store.get('settings.alwaysOnTop', true);
        if (alwaysOnTopSetting) {
          enforceAlwaysOnTop(true);
        }
      }
    }, 5000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray
  }
});

app.on('quit', () => {
  if (wslTopmostProc) {
    wslTopmostProc.removeAllListeners('exit');
    wslTopmostProc.kill();
    wslTopmostProc = null;
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
