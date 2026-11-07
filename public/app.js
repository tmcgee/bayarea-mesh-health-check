const SESSION_STORAGE_KEY = 'mesh-health-check-session-id';
const SESSION_HISTORY_STORAGE_KEY = 'mesh-health-check-session-history';
const OBSERVER_ALLOWLIST_STORAGE_KEY = 'mesh-health-check-observer-allowlist';
const UI_THEME_STORAGE_KEY = 'mesh-health-check-ui-theme';
// Last minute before a code stops being accepted, when the useful thing to say
// changes from "here is your code" to "send it now or take a fresh one".
const CODE_EXPIRING_SOON_MS = 60000;
const MAX_CLOCK_SKEW_MS = 86400000;
const CODE_LIFE_TICK_MS = 1000;
const ANALYZER_BASE_URL = 'https://analyzer.letsmesh.net/packets?packet_hash=';
const SHARE_ROUTE_PREFIX = '/share/';
let deferredInstallPrompt = null;

const ui = {
  mqttPill: document.querySelector('#mqtt-pill'),
  installAppButton: document.querySelector('#install-app-button'),
  newSessionButton: document.querySelector('#new-session-button'),
  copySessionCodeButton: document.querySelector('#copy-session-code'),
  shareSessionButton: document.querySelector('#share-session'),
  sessionCode: document.querySelector('#session-code'),
  sessionCodeExpiry: document.querySelector('#session-code-expiry'),
  sessionCodeLabel: document.querySelector('#session-code-label'),
  sessionInstructions: document.querySelector('#session-instructions'),
  sessionStepChannel: document.querySelector('#session-step-channel'),
  channelQr: document.querySelector('#channel-qr'),
  sessionShareNote: document.querySelector('#session-share-note'),
  sessionStatus: document.querySelector('#session-status'),
  sessionHash: document.querySelector('#session-hash'),
  healthLabel: document.querySelector('#health-label'),
  healthPercent: document.querySelector('#health-percent'),
  observedCount: document.querySelector('#observed-count'),
  regionCoverage: document.querySelector('#region-coverage'),
  healthNote: document.querySelector('#health-note'),
  healthScope: document.querySelector('#health-scope'),
  regionCoverageCard: document.querySelector('#region-coverage-card'),
  repeaterCount: document.querySelector('#repeater-count'),
  longestPacketDistance: document.querySelector('#longest-packet-distance'),
  senderName: document.querySelector('#sender-name'),
  channelName: document.querySelector('#channel-name'),
  heroEyebrow: document.querySelector('#hero-eyebrow'),
  heroTitle: document.querySelector('#hero-title'),
  heroDescriptionPrefix: document.querySelector('#hero-description-prefix'),
  heroDescriptionSuffix: document.querySelector('#hero-description-suffix'),
  heroChannel: document.querySelector('#hero-channel'),
  brokerName: document.querySelector('#broker-name'),
  externalLink: document.querySelector('#external-link'),
  repoNoteLink: document.querySelector('#repo-note-link'),
  siteVersionNote: document.querySelector('#site-version-note'),
  messagePreview: document.querySelector('#message-preview'),
  observerAllowlistNote: document.querySelector('#observer-allowlist-note'),
  regionFilter: document.querySelector('#region-filter'),
  uiThemeToggle: document.querySelector('#ui-theme-toggle'),
  mapObserverNote: document.querySelector('#map-observer-note'),
  mapEmpty: document.querySelector('#map-empty'),
  additionalInfo: document.querySelector('#additional-info'),
  additionalInfoLabel: document.querySelector('#additional-info-label'),
  additionalInfoToggle: document.querySelector('#additional-info-toggle'),
  observerMap: document.querySelector('#observer-map'),
  receiptsEmpty: document.querySelector('#receipts-empty'),
  receiptsFilter: document.querySelector('#receipts-filter'),
  receipts: document.querySelector('#receipts'),
  sessionHistory: document.querySelector('#session-history'),
  networkWindow: document.querySelector('#network-window'),
  networkState: document.querySelector('#network-state'),
  observerDensity: document.querySelector('#observer-density'),
  observerDensityLabel: document.querySelector('#observer-density-label'),
  observerDensityDetail: document.querySelector('#observer-density-detail'),
  observerSparkline: document.querySelector('#observer-sparkline'),
  observerLoadSparkline: document.querySelector('#observer-load-sparkline'),
  signalQuality: document.querySelector('#signal-quality'),
  signalQualityLabel: document.querySelector('#signal-quality-label'),
  signalSparkline: document.querySelector('#signal-sparkline'),
  latencyScore: document.querySelector('#latency-score'),
  latencyLabel: document.querySelector('#latency-label'),
  latencySparkline: document.querySelector('#latency-sparkline'),
  detailDrawer: document.querySelector('#detail-drawer'),
  drawerScrim: document.querySelector('#drawer-scrim'),
  drawerMeta: document.querySelector('#drawer-meta'),
  drawerTitle: document.querySelector('#drawer-title'),
  drawerBody: document.querySelector('#drawer-body'),
  drawerClose: document.querySelector('#drawer-close'),
};

const pageMode = document.body?.dataset?.pageMode || 'app';
const mapObserverScope = document.body?.dataset?.mapObserverScope === 'directory'
  ? 'directory'
  : 'expected';

localStorage.removeItem(SESSION_STORAGE_KEY);
localStorage.removeItem(SESSION_HISTORY_STORAGE_KEY);

const state = {
  snapshot: null,
  currentSessionId: sessionStorage.getItem(SESSION_STORAGE_KEY) || '',
  sharedSessionId: sharedSessionIdFromLocation(),
  sharedSessionMissing: false,
  trackedSessionIds: loadTrackedSessionIds(),
  // The selected place code from snapshot.regionTree (1.2.0), or null for All.
  // One field at any depth: its path in the tree says which chips are open.
  // Never in the URL: links and the address bar carry no region, so a shared
  // link, a reload and a bookmark all open on All (1.1.0 decision).
  selectedPlace: null,
  // 'all' | 'heard' | 'unheard'. Visibility only, like the region chips: it
  // never changes what this code is scored against.
  receiptHeardFilter: 'all',
  // Location opt-in (1.1.0): which button is waiting and the sentence
  // describing the last pick. The outlines are the map's own (1.2.0).
  // Never stored, so a reload opens on All again.
  locate: { pending: '', status: null, row: null },
  uiTheme: loadUiTheme(),
  // Difference between the server's clock and ours, refreshed from every
  // snapshot. The server decides when a code stops being accepted, so a
  // countdown measured against an unsynced phone clock would be confidently
  // wrong in whichever direction that phone is drifting.
  serverSkewMs: 0,
  sessions: new Map(),
  socket: null,
  socketRetryTimer: 0,
  refreshInFlight: false,
  map: {
    instance: null,
    layer: null,
    layerTheme: '',
    tiles: null,
    tileSignature: '',
    markers: new Map(),
    boundsKey: '',
    // Region outlines (1.2.0), fetched one tree level at a time: the features
    // so far, the tree key they belong to, the levels (parent codes, '' for the
    // top) already fetched, the ones in flight so a slow fetch is not repeated
    // on every poll, whether the locator has loaded every level at once, and
    // the drawn shapes with the status they were built for. regionFull holds the
    // codes whose full-detail outline has replaced the coarse one.
    regionFeatures: [],
    regionFull: new Set(),
    regionKey: '',
    regionLevels: new Set(),
    regionPending: new Set(),
    regionComplete: false,
    regionPane: '',
    regionFaintPane: '',
    regionShapes: new Map(),
    regionFaint: new Map(),
    // The selected receipt's path (see renderReceiptPathLayer): its own pane,
    // the drawn layer group, and the signature it was built from.
    pathPane: '',
    pathLayer: null,
    pathSignature: '',
  },
  // Which receipt's path is drawn on the coverage map, by observer key, and the
  // session it belongs to so a new code never inherits the old selection.
  receiptPath: {
    key: '',
    sessionId: '',
  },
  drawer: {
    kind: '',
    key: '',
  },
};

function loadTrackedSessionIds() {
  try {
    const raw = sessionStorage.getItem(SESSION_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveTrackedSessionIds() {
  sessionStorage.setItem(
    SESSION_HISTORY_STORAGE_KEY,
    JSON.stringify(state.trackedSessionIds),
  );
}

// The observer checkbox picker was removed: every code now scores against the
// active set. A selection persisted by an earlier build would otherwise sit in
// sessionStorage forever with nothing to read it, so drop it on load.
function clearStoredObserverSelection() {
  try {
    sessionStorage.removeItem(OBSERVER_ALLOWLIST_STORAGE_KEY);
  } catch {
    // Private-mode sessionStorage can throw; nothing reads the key anyway.
  }
}

function loadUiTheme() {
  const stored = localStorage.getItem(UI_THEME_STORAGE_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

function saveUiTheme() {
  localStorage.setItem(UI_THEME_STORAGE_KEY, state.uiTheme);
}

function applyUiTheme() {
  const activeTheme = state.uiTheme === 'dark' ? 'dark' : 'light';
  document.body.dataset.uiTheme = activeTheme;
  document.documentElement.style.colorScheme = activeTheme;
  if (ui.uiThemeToggle) {
    ui.uiThemeToggle.textContent = activeTheme === 'dark' ? 'Light Mode' : 'Dark Mode';
  }
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', activeTheme === 'dark' ? '#07111d' : '#e9f2ff');
  }
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// The step-2 sentence is the one place a visitor has to copy something by hand,
// so the code inside it is emphasised. Built as markup rather than assigned as
// text, which means both halves are escaped before they go anywhere near
// innerHTML - the sentence comes from the server and the code from the session.
function renderInstruction(element, text, code) {
  if (!element) {
    return;
  }
  const safeText = escapeHtml(String(text || ''));
  const safeCode = escapeHtml(String(code || ''));
  element.innerHTML = safeCode
    ? safeText.split(safeCode).join(`<strong>${safeCode}</strong>`)
    : safeText;
}


function sharedSessionIdFromLocation() {
  const path = window.location.pathname || '';
  if (!path.startsWith(SHARE_ROUTE_PREFIX)) {
    return '';
  }
  const encodedId = path.slice(SHARE_ROUTE_PREFIX.length).split('/')[0] || '';
  try {
    return decodeURIComponent(encodedId).trim();
  } catch {
    return encodedId.trim();
  }
}

function isSharedRoute() {
  return Boolean(state.sharedSessionId);
}

function isSharePage() {
  return pageMode === 'share';
}

function updateInstallButton() {
  ui.installAppButton.classList.toggle('hidden', !deferredInstallPrompt);
}

function observerDirectory() {
  if (Array.isArray(state.snapshot?.observerDirectory) && state.snapshot.observerDirectory.length > 0) {
    return state.snapshot.observerDirectory;
  }
  return Array.isArray(state.snapshot?.activeObservers) ? state.snapshot.activeObservers : [];
}

function configuredDefaultObserverKeys() {
  const defaults = Array.isArray(state.snapshot?.defaultObserverKeys)
    ? state.snapshot.defaultObserverKeys
    : [];
  return dedupe(defaults);
}

function shortObserverKey(key) {
  const value = String(key || '').trim().toUpperCase();
  if (value.length <= 12) {
    return value || '--';
  }
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

// The width is per observer: a node's `path.hash.mode` is its own firmware
// setting, so an observer with a confirmed 2- or 3-byte advert gets that many
// bytes shown. observerHashBytes falls back to the global display default when
// the server has no confirmed width for the node.
function observerHashBytes(observer) {
  const declared = Number(observer?.hashBytes);
  if (Number.isInteger(declared) && declared >= 1 && declared <= 3) {
    return declared;
  }
  return Math.max(1, Math.min(3, Number(state.snapshot?.observerStats?.hashDisplayBytes || 1)));
}

function observerHashPrefix(key, observer = null) {
  const value = String(key || '').trim().toUpperCase();
  const displayLength = observerHashBytes(observer) * 2;
  return value.slice(0, displayLength) || '--';
}

function fallbackObserverRecord(key) {
  return {
    key,
    hash: observerHashPrefix(key),
    hashBytes: null,
    hashBytesConfirmed: false,
    label: shortObserverKey(key),
    name: null,
    lat: null,
    lon: null,
    hasLocation: false,
    place: null,
    placePath: [],
    shortKey: shortObserverKey(key),
    packetCount: 0,
    firstSeenAt: 0,
    lastPacketAt: 0,
    isRetained: false,
    isActive: false,
  };
}

function configuredDefaultObservers() {
  const defaults = Array.isArray(state.snapshot?.defaultObservers)
    ? state.snapshot.defaultObservers.filter((observer) => observer?.key)
    : [];
  if (defaults.length > 0) {
    return defaults;
  }
  return configuredDefaultObserverKeys().map((key) => fallbackObserverRecord(key));
}

function observerDisplayLabel(observer) {
  const name = String(observer?.name || '').trim();
  if (name) {
    return name;
  }
  const label = String(observer?.label || '').trim();
  if (label) {
    return label;
  }
  return shortObserverKey(observer?.key);
}

function selectableObservers() {
  const merged = new Map();
  for (const observer of configuredDefaultObservers()) {
    merged.set(observer.key, { ...observer, isDefaultTarget: true });
  }
  for (const observer of observerDirectory()) {
    const existing = merged.get(observer.key) || {};
    merged.set(observer.key, {
      ...existing,
      ...observer,
      isDefaultTarget: Boolean(existing.isDefaultTarget),
    });
  }
  return [...merged.values()].map((observer) => ({
    ...observer,
    label: observerDisplayLabel(observer),
    shortKey: observer.shortKey || shortObserverKey(observer.key),
  }));
}


function defaultObserverKeys() {
  return configuredDefaultObserverKeys();
}


// There is no longer a set to be the default of, so the word is gone.
function observerTargetSummary() {
  const source = String(state.snapshot?.defaultObserverSource || '');
  const count = defaultObserverKeys().length;
  if (source === 'configured') {
    return `${count} observer${count === 1 ? '' : 's'}.`;
  }
  // This branch only runs when no roster is configured and nothing was heard in
  // the active window, so the target was picked by 7-day ranking rather than by
  // live activity. The old wording - "Top 10 observers over 7 days." - stated the
  // rule without saying it was the scoring rule, which read as a stray statistic.
  if (source === 'top-window') {
    const days = Math.max(1, Number(state.snapshot?.observerStats?.topWindowDays || 7));
    return `Scored against the ${count} observer${count === 1 ? '' : 's'} most active over the last ${days} day${days === 1 ? '' : 's'}.`;
  }
  const windowSeconds = Math.max(1, Number(state.snapshot?.observerStats?.windowSeconds || 900));
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  return `${count} observer${count === 1 ? '' : 's'} active in the last ${minutes} min.`;
}

// Says out loud why a grade is missing. Silence would read as a rendering bug,
// and the old behaviour - a confident 100% next to "1 / 1" - was worse than
// either. Only shown when there is something to explain.
function renderHealthNote(score, healthMeasured, healthRated) {
  if (!ui.healthNote) {
    return;
  }
  if (!healthMeasured || healthRated) {
    ui.healthNote.textContent = '';
    ui.healthNote.classList.add('hidden');
    return;
  }
  const target = Number(score?.expectedCount) || 0;
  const minimum = Number(score?.minScoringSet) || 3;
  const where = score?.scopeLabel ? ` in ${score.scopeLabel}` : '';
  if (target === 0) {
    ui.healthNote.textContent = `No observers${where} were active when this code was created, so there is nothing to score here.`;
  } else if (score?.healthUnratedReason === 'target-too-small') {
    ui.healthNote.textContent = `${target} observer${target === 1 ? '' : 's'}${where} ${target === 1 ? 'was' : 'were'} active, fewer than the ${minimum} needed for a grade. The percentage is what was heard.`;
  } else {
    ui.healthNote.textContent = 'Not rated: this code cannot be scored.';
  }
  ui.healthNote.classList.remove('hidden');
}

// The score is a view over the receipts: All by default, or the place picked in
// the region filter, at any depth. Picking one never touches the code or
// the session; it reads that scope's score from session.scopeScores, which the
// server computes over the observers placed there when the code was created
// plus any that reported. A scope missing from scopeScores had nobody active.
// A payload from an older server has no scopeScores, so it always shows All.
function selectedScopeKey() {
  return state.selectedPlace || null;
}

function scoreForSelectedScope(session) {
  const minScoringSet = session?.minScoringSet;
  const scopeKey = selectedScopeKey();
  if (!scopeKey || !session?.scopeScores || typeof session.scopeScores !== 'object') {
    return { ...session, scopeKind: 'all', scopeLabel: null, minScoringSet };
  }
  // 'leaf' hides Regions Reached: a place with nothing below it has nothing to reach.
  const scopeKind = (regionNode(scopeKey)?.children.length || 0) > 0 ? 'place' : 'leaf';
  const scopeLabel = activeRegionScopeLabel();
  const entry = session.scopeScores[scopeKey];
  if (!entry) {
    const healthMeasured = isHealthMeasured(session);
    return {
      observedCount: 0,
      expectedCount: 0,
      healthPercent: 0,
      healthMeasured,
      healthRated: false,
      healthUnratedReason: healthMeasured ? 'no-active-observers' : null,
      healthLabel: healthMeasured ? 'NOT RATED' : 'WAITING',
      regionCoverage: null,
      scopeKind,
      scopeLabel,
      minScoringSet,
    };
  }
  return { ...entry, scopeKind, scopeLabel, minScoringSet };
}

function renderHealthScope(score) {
  if (!ui.healthScope) {
    return;
  }
  ui.healthScope.textContent = score?.scopeLabel
    ? `Scored for ${score.scopeLabel}`
    : 'Scored for all observers';
}

function headlineFor(score, healthMeasured, healthRated) {
  if (!healthMeasured) {
    return 'Waiting';
  }
  if (healthRated) {
    return score.healthLabel;
  }
  const target = Number(score?.expectedCount) || 0;
  if (target === 0) {
    return 'No active observers';
  }
  if (score?.healthUnratedReason === 'target-too-small') {
    return `Small sample: ${target} observer${target === 1 ? '' : 's'}`;
  }
  return 'Not rated';
}

// Region coverage answers a different question from the observer percentage:
// not "how many of the reachable radios heard me" but "how much of the map did
// I light up". A group with no located observer in the scoring set is left out
// of the total entirely - it cannot be reached, so counting it as a miss would
// punish the sender for a hole in the observer network.
function renderRegionCoverage(session, healthMeasured) {
  if (!ui.regionCoverage) {
    return;
  }
  // A place with no children has nothing below it to reach.
  if (ui.regionCoverageCard) {
    ui.regionCoverageCard.classList.toggle('hidden', session?.scopeKind === 'leaf');
  }
  const coverage = session?.regionCoverage;
  if (!healthMeasured || !coverage || !Number(coverage.total)) {
    ui.regionCoverage.textContent = '--';
    ui.regionCoverage.removeAttribute('title');
    return;
  }
  ui.regionCoverage.textContent = `${coverage.reached} / ${coverage.total}`;
  const places = Array.isArray(coverage.places) ? coverage.places : [];
  const reached = places.filter((entry) => Number(entry.seenCount) > 0);
  const missed = places.filter((entry) => !Number(entry.seenCount));
  const lines = [];
  if (reached.length > 0) {
    lines.push(`Reached: ${reached.map((entry) => `${entry.name} (${entry.seenCount}/${entry.observerCount})`).join(', ')}`);
  }
  if (missed.length > 0) {
    lines.push(`No report: ${missed.map((entry) => `${entry.name} (0/${entry.observerCount})`).join(', ')}`);
  }
  if (lines.length > 0) {
    ui.regionCoverage.title = lines.join('\n');
  } else {
    ui.regionCoverage.removeAttribute('title');
  }
}

function upsertTrackedSession(session) {
  if (!session?.id) {
    return;
  }
  state.sessions.set(session.id, session);
  state.trackedSessionIds = [
    session.id,
    ...state.trackedSessionIds.filter((id) => id !== session.id),
  ].slice(0, 8);
  saveTrackedSessionIds();
}

function removeTrackedSession(sessionId) {
  state.sessions.delete(sessionId);
  state.trackedSessionIds = state.trackedSessionIds.filter((id) => id !== sessionId);
  saveTrackedSessionIds();
  if (state.currentSessionId === sessionId) {
    state.currentSessionId = '';
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

async function apiFetch(url, options = {}) {
  return fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return 'Pending';
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDateTime(timestamp) {
  if (!timestamp) {
    return 'Pending';
  }
  return new Date(timestamp).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatElapsed(ms) {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) {
    return `${value} ms`;
  }
  if (value < 60000) {
    const seconds = value / 1000;
    return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  if (seconds === 60) {
    return `${minutes + 1} min`;
  }
  return `${minutes} min ${seconds}s`;
}

function formatWindow(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value >= 3600) {
    const hours = value / 3600;
    return Number.isInteger(hours) ? `${hours}h window` : `${hours.toFixed(1)}h window`;
  }
  if (value >= 60) {
    const minutes = value / 60;
    return Number.isInteger(minutes) ? `${minutes}m window` : `${minutes.toFixed(1)}m window`;
  }
  return `${value}s window`;
}

function renderSparkline(element, points, tone = 'neutral') {
  if (!element) {
    return;
  }
  const source = Array.isArray(points) && points.length > 0
    ? points
    : [10, 12, 11, 14, 13, 12, 15, 12];
  const normalized = source.map((point) => clamp(point, 8, 100));
  const signature = `${tone}|${normalized.join(',')}`;
  if (element.dataset.sparklineSignature === signature) {
    return;
  }

  element.innerHTML = '';
  element.dataset.tone = tone;
  element.dataset.sparklineSignature = signature;
  for (const [index, point] of normalized.entries()) {
    const bar = document.createElement('span');
    bar.className = 'sparkline-bar';
    bar.style.height = `${point}%`;
    bar.style.animationDelay = `${index * 40}ms`;
    element.appendChild(bar);
  }
}

function scoreTone(score) {
  if (!Number.isFinite(score)) {
    return 'neutral';
  }
  if (score >= 72) {
    return 'good';
  }
  if (score >= 45) {
    return 'warning';
  }
  return 'critical';
}

function scoreLabel(score) {
  if (!Number.isFinite(score)) {
    return 'Awaiting telemetry';
  }
  if (score >= 72) {
    return 'Nominal signal window';
  }
  if (score >= 45) {
    return 'Degraded signal window';
  }
  return 'Critical signal window';
}

function receiptSignalScore(receipt) {
  const components = [];
  if (Number.isFinite(receipt?.rssi)) {
    components.push(clamp(((Number(receipt.rssi) + 120) / 75) * 100, 0, 100));
  }
  if (Number.isFinite(receipt?.snr)) {
    components.push(clamp(((Number(receipt.snr) + 20) / 40) * 100, 0, 100));
  }
  if (components.length === 0) {
    return null;
  }
  return Math.round(components.reduce((sum, value) => sum + value, 0) / components.length);
}

function transportSummary(snapshot) {
  const activeCount = Number(snapshot?.observerStats?.activeCount || 0);
  const windowSeconds = Number(snapshot?.observerStats?.windowSeconds || 0);
  const directory = Array.isArray(snapshot?.observerDirectory) ? snapshot.observerDirectory : [];
  const configuredCount = Math.max(directory.length, Number(snapshot?.observerStats?.configuredCount || 0));
  const maxPacketCount = Math.max(
    1,
    ...directory.map((observer) => Number(observer?.packetCount || 0)),
  );
  const activityBars = directory.slice(0, 8).map((observer) => {
    const packetCount = Number(observer?.packetCount || 0);
    return clamp((packetCount / maxPacketCount) * 100, 10, 100);
  });
  const stateLabel = snapshot?.mqtt?.connected ? 'Live' : (isSharePage() ? 'Shared' : 'Offline');
  return {
    stateLabel,
    tone: directory.length > 0
      ? (snapshot?.mqtt?.connected ? 'good' : (isSharePage() ? 'warning' : 'warning'))
      : 'neutral',
    activityBars,
    density: `${activeCount} / ${configuredCount || 0}`,
    summary: directory.length > 0
      ? `${activeCount} active nodes · ${formatWindow(windowSeconds)}`
      : 'Awaiting observer directory.',
    detail: directory.length > 0
      ? `${directory.length} known observer${directory.length === 1 ? '' : 's'} on file.`
      : 'No observer telemetry yet.',
  };
}

function signalSummary(session) {
  const receipts = Array.isArray(session?.receipts) ? [...session.receipts] : [];
  const points = receipts
    .map((receipt) => receiptSignalScore(receipt))
    .filter((value) => Number.isFinite(value));
  if (points.length === 0) {
    // Upstream 6126ea28: once a message has landed, no reading means the
    // receipts carried no RSSI/SNR, not that telemetry is still on its way.
    return {
      value: '--',
      label: session && isHealthMeasured(session) ? 'Signal data unavailable.' : 'Awaiting telemetry.',
      tone: 'neutral',
      points: [],
    };
  }
  const average = Math.round(points.reduce((sum, value) => sum + value, 0) / points.length);
  return {
    value: `${average}%`,
    label: scoreLabel(average),
    tone: scoreTone(average),
    points,
  };
}

function latencySummary(session) {
  const receipts = Array.isArray(session?.receipts)
    ? [...session.receipts]
        .filter((receipt) => receipt?.firstSeenAt)
        .sort((left, right) => left.firstSeenAt - right.firstSeenAt)
    : [];
  if (receipts.length === 0) {
    return {
      value: '--',
      label: 'Awaiting receipt spread.',
      tone: 'neutral',
      points: [],
    };
  }
  const firstSeenAt = receipts[0].firstSeenAt;
  const lastSeenAt = receipts[receipts.length - 1].firstSeenAt;
  const spread = Math.max(0, lastSeenAt - firstSeenAt);
  const points = receipts.map((receipt) => {
    if (spread <= 0) {
      return 100;
    }
    return clamp(((receipt.firstSeenAt - firstSeenAt) / spread) * 100, 10, 100);
  });
  return {
    value: spread > 0 ? `+${formatElapsed(spread)}` : '0 ms',
    label: spread > 0
      ? `${receipts.length} observers across ${formatElapsed(spread)}`
      : `${receipts.length} observer${receipts.length === 1 ? '' : 's'} at the same moment`,
    tone: spread > 45000 ? 'critical' : spread > 12000 ? 'warning' : 'good',
    points,
  };
}

function renderGlanceMetrics(session) {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }

  const transport = transportSummary(snapshot);
  const signal = signalSummary(session);
  const latency = latencySummary(session);

  if (ui.networkWindow) {
    ui.networkWindow.textContent = transport.summary;
  }
  if (ui.networkState) {
    ui.networkState.textContent = transport.stateLabel;
  }
  if (ui.observerDensity) {
    ui.observerDensity.textContent = transport.density;
  }
  if (ui.observerDensityLabel) {
    ui.observerDensityLabel.textContent = transport.summary;
  }
  if (ui.observerDensityDetail) {
    ui.observerDensityDetail.textContent = transport.detail;
  }
  if (ui.signalQuality) {
    ui.signalQuality.textContent = signal.value;
  }
  if (ui.signalQualityLabel) {
    ui.signalQualityLabel.textContent = signal.label;
  }
  if (ui.latencyScore) {
    ui.latencyScore.textContent = latency.value;
  }
  if (ui.latencyLabel) {
    ui.latencyLabel.textContent = latency.label;
  }

  renderSparkline(ui.observerSparkline, transport.activityBars, transport.tone);
  renderSparkline(ui.observerLoadSparkline, transport.activityBars.slice().reverse(), transport.tone);
  renderSparkline(ui.signalSparkline, signal.points, signal.tone);
  renderSparkline(ui.latencySparkline, latency.points, latency.tone);
}

function retentionNote() {
  const seconds = Number(state.snapshot?.results?.retentionSeconds || 0);
  if (!seconds) {
    return 'Shared links stay available for a limited time.';
  }
  const days = seconds / 86400;
  if (Number.isInteger(days) && days >= 1) {
    return `Shared links are kept for ${days} day${days === 1 ? '' : 's'}.`;
  }
  return `Shared links are kept for ${formatElapsed(seconds * 1000)}.`;
}

function cleanConfigValue(value) {
  const text = String(value || '').trim();
  if (!text || /^\{\{.*\}\}$/.test(text)) {
    return '';
  }
  return text;
}

function normalizeCoreScopeBaseUrl(value) {
  const raw = cleanConfigValue(value);
  if (!raw) {
    return '';
  }
  const base = raw.replace(/#\/?$/, '').replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) ? base : '';
}

function buildCoreScopePacketLink(hash) {
  const base = normalizeCoreScopeBaseUrl(state.snapshot?.site?.coreScopeUrl);
  const value = String(hash || '').trim();
  if (!base || !value) {
    return '';
  }
  const normalizedValue = /^[0-9a-f]+$/i.test(value) ? value.toLowerCase() : value;
  return `${base}/#/packets/${encodeURIComponent(normalizedValue)}`;
}

// CoreScope holds the same public key under two routes and both are
// case-sensitive: an observer is looked up by the UPPERCASE key, a node by the
// lowercase one. /api/observers/<lowercase> and /api/nodes/<UPPERCASE> both
// answer 404, so the casing below is load-bearing, not cosmetic.
function coreScopePublicKey(key) {
  const value = String(key || '').trim();
  return /^[0-9a-f]{64}$/i.test(value) ? value : '';
}

function buildCoreScopeObserverLink(key) {
  const base = normalizeCoreScopeBaseUrl(state.snapshot?.site?.coreScopeUrl);
  const value = coreScopePublicKey(key);
  if (!base || !value) {
    return '';
  }
  return `${base}/#/observers/${value.toUpperCase()}`;
}

function buildCoreScopeNodeLink(key) {
  const base = normalizeCoreScopeBaseUrl(state.snapshot?.site?.coreScopeUrl);
  const value = coreScopePublicKey(key);
  if (!base || !value) {
    return '';
  }
  return `${base}/#/nodes/${value.toLowerCase()}`;
}

// Wraps already-escaped text in an external link, or returns it untouched when
// there is no URL. Every caller passes escaped text, so nothing here escapes
// twice.
function externalLinkMarkup(url, escapedText, className, title) {
  if (!url) {
    return escapedText;
  }
  return `<a class="${className}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${
    title ? ` title="${escapeHtml(title)}"` : ''
  }>${escapedText}</a>`;
}

function packetHashLink(hash) {
  const coreScopeUrl = buildCoreScopePacketLink(hash);
  if (coreScopeUrl) {
    return coreScopeUrl;
  }
  return `${ANALYZER_BASE_URL}${encodeURIComponent(hash)}`;
}

// The matched message, linked to the same packet page as the Message Packet
// hash once there is a message. Placeholder text ("Waiting for...", "No
// message was heard...") stays plain.
function setMessagePreview(text, hash = '') {
  const value = String(hash || '').trim();
  ui.messagePreview.title = '';
  if (!value) {
    ui.messagePreview.textContent = text;
    return;
  }
  const link = document.createElement('a');
  link.className = 'hash-link';
  link.href = packetHashLink(value);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  ui.messagePreview.replaceChildren(link);
  ui.messagePreview.title = text;
}

function setSessionHash(hash) {
  const value = String(hash || '').trim();
  if (!value) {
    ui.sessionHash.textContent = '--';
    ui.sessionHash.href = '#';
    ui.sessionHash.classList.add('pending');
    ui.sessionHash.removeAttribute('target');
    ui.sessionHash.removeAttribute('rel');
    return;
  }

  ui.sessionHash.textContent = value;
  ui.sessionHash.href = packetHashLink(value);
  ui.sessionHash.classList.remove('pending');
  ui.sessionHash.setAttribute('target', '_blank');
  ui.sessionHash.setAttribute('rel', 'noopener noreferrer');
}

function healthClass(label) {
  if (label === 'VERY HEALTHY' || label === 'GOOD') {
    return 'status-good';
  }
  if (label === 'FAIR') {
    return 'status-fair';
  }
  // Not yet measured is not a failing grade: leave it in the default text colour.
  if (isHealthPending(label)) {
    return '';
  }
  return 'status-poor';
}

function isHealthPending(label) {
  return !label
    || label === 'WAITING'
    || label === 'Waiting'
    // Heard, but scored against too small a target set to grade. Neither a pass
    // nor a failure, so it gets the same neutral treatment as WAITING.
    || label === 'NOT RATED'
    || label === 'Not rated';
}

// Whether a message actually landed on this code. healthMeasured is absent on
// cached payloads from an older server, so fall back to the label. render() and
// renderCodeLife both gate on this and must not drift apart, hence one helper.
function isHealthMeasured(session) {
  return session?.healthMeasured != null
    ? Boolean(session.healthMeasured)
    : !isHealthPending(session?.healthLabel);
}

function isHealthRated(entry) {
  if (entry?.healthRated != null) {
    return Boolean(entry.healthRated);
  }
  // Payloads from an older server have no healthRated; fall back to the label.
  return !isHealthPending(entry?.healthLabel);
}

function historyHealthPending(entry) {
  if (entry?.healthRated != null) {
    return !entry.healthRated;
  }
  return entry?.healthMeasured != null
    ? !entry.healthMeasured
    : isHealthPending(entry?.healthLabel);
}

function historyHealthLabel(entry) {
  if (!historyHealthPending(entry)) {
    return entry.healthLabel;
  }
  const measured = entry?.healthMeasured != null
    ? Boolean(entry.healthMeasured)
    : false;
  return measured ? 'Not rated' : 'Waiting';
}

function historyHealthScore(entry) {
  return historyHealthPending(entry) ? '--' : `${entry.healthPercent}%`;
}

// Placeholder markup for an unmeasured score: '--' with no percent sign, matching
// the other pending metrics.
function healthScoreMarkup(percent, measured) {
  return measured
    ? `<span class="score-num">${percent}</span><span class="score-unit">%</span>`
    : '<span class="score-num score-num--pending">--</span>';
}

function ringColor(label) {
  if (label === 'VERY HEALTHY' || label === 'GOOD') return 'var(--good)';
  if (label === 'FAIR') return 'var(--fair)';
  if (isHealthPending(label)) return 'var(--accent-strong)';
  return 'var(--poor)';
}

function updateRing(percent, label) {
  const color = ringColor(label);
  const circumference = 314.16;
  const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
  document.documentElement.style.setProperty('--ring-color', color);
  const fill = document.querySelector('.score-ring__fill');
  if (fill) {
    fill.style.stroke = color;
    fill.style.strokeDashoffset = offset;
  }
}

function redirectToLanding() {
  window.location.href = '/';
}

async function registerPwa() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch {
      // ignore registration failures
    }
  }
}

async function installApp() {
  if (!deferredInstallPrompt) {
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice.catch(() => null);
  if (choice?.outcome === 'accepted') {
    deferredInstallPrompt = null;
  }
  updateInstallButton();
}

async function copyCurrentCode() {
  const session = currentSession();
  const code = session?.code || '';
  if (!code) {
    return;
  }
  // Defence in depth. The button is already disabled for a dead code, but a
  // programmatic click, a stale attribute or a mid-flight death must not put
  // an unsendable code on the clipboard either. Shared results are exempt for
  // the same reason they never render as dead: the code is a historical
  // record, not something the reader is being asked to send.
  if (!isSharePage() && !isSharedRoute() && !isCodeSendable(session)) {
    return;
  }

  await copyText(code);
  flashButtonText(ui.copySessionCodeButton, 'Copied');
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'absolute';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
}

function flashButtonText(button, text) {
  const originalText = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = originalText;
  }, 1200);
}

async function copySessionShareLink() {
  const session = currentSession();
  const shareUrl = String(session?.shareUrl || '').trim();
  if (!shareUrl) {
    return;
  }

  const shareData = {
    title: document.title,
    url: shareUrl,
  };

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share(shareData);
      flashButtonText(ui.shareSessionButton, 'Shared');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') {
        return;
      }
    }
  }

  await copyText(shareUrl);
  flashButtonText(ui.shareSessionButton, 'Link Copied');
}

async function createSession() {
  ui.newSessionButton.disabled = true;
  try {
    const response = await apiFetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // No expectedObserverKeys: the server picks the active set. The API still
      // accepts an explicit allowlist for scripted probes, but the UI never
      // sends one, so a code cannot be silently narrowed.
      body: '{}',
    });
    const session = await response.json();
    if (response.status === 403 && session.error === 'turnstile_required') {
      redirectToLanding();
      return;
    }
    if (!response.ok) {
      throw new Error(session.error || 'Failed to create session');
    }
    state.sharedSessionId = '';
    state.sharedSessionMissing = false;
    state.currentSessionId = session.id;
    sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);
    if (window.location.pathname !== '/app') {
      window.history.replaceState({}, '', '/app');
    }
    upsertTrackedSession(session);
    render();
  } catch (error) {
    ui.sessionInstructions.textContent = error.message;
  } finally {
    ui.newSessionButton.disabled = false;
  }
}

function currentSession() {
  const sessionId = state.sharedSessionId || state.currentSessionId;
  if (!sessionId) {
    return null;
  }
  return state.sessions.get(sessionId) || null;
}

// Every snapshot carries the server's own clock. Anything inside a day is
// treated as real drift and corrected for; anything wilder is a malformed or
// missing field rather than a plausible clock, and correcting by it would do
// more damage than ignoring it.
function updateServerSkew(snapshot) {
  const serverTime = Number(snapshot?.serverTime);
  if (!Number.isFinite(serverTime) || serverTime <= 0) {
    return;
  }
  const skew = serverTime - Date.now();
  state.serverSkewMs = Math.abs(skew) > MAX_CLOCK_SKEW_MS ? 0 : skew;
}

function serverNow() {
  return Date.now() + state.serverSkewMs;
}

// A code has two independent ways to stop being accepted and they are
// different facts. Running out of time and running out of uses send someone
// looking for different things, so they are never collapsed into one word.
// Uses are checked first: a code that was consumed three times demonstrably
// worked, and saying "expired" about it would point at the wrong problem.
function sessionCodeLife(session) {
  if (!session) {
    return { state: 'none', msLeft: 0 };
  }
  const expiresAt = Number(session.expiresAt);
  const timed = Number.isFinite(expiresAt) && expiresAt > 0;
  const msLeft = timed ? expiresAt - serverNow() : Infinity;
  const usesRemaining = Number(session.usesRemaining);
  if (Number.isFinite(usesRemaining) && usesRemaining <= 0) {
    return { state: 'used-up', msLeft };
  }
  if (timed && msLeft <= 0) {
    return { state: 'expired', msLeft };
  }
  if (timed && msLeft <= CODE_EXPIRING_SOON_MS) {
    return { state: 'expiring', msLeft };
  }
  return { state: 'live', msLeft };
}

// Single source of truth for "may this code still be sent". Both the Copy
// button's disabled state and the copy handler's own guard read it, so the
// two cannot drift apart the way the health headline and renderCodeLife did.
function isCodeSendable(session) {
  if (!session?.code) {
    return false;
  }
  const { state } = sessionCodeLife(session);
  return state !== 'expired' && state !== 'used-up';
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Owns everything that depends on how much life the code has left: the
// countdown line, the styling on the code itself, and - only once the code is
// dead - the instruction and status text that render() wrote a moment ago.
// Deliberately cheap, because the one-second ticker calls it too.
function renderCodeLife() {
  if (!ui.sessionCodeExpiry || !ui.sessionCode) {
    return;
  }
  const session = currentSession();
  const life = sessionCodeLife(session);
  // A shared result is a historical record. Its code expired long ago and
  // saying so would report a fault where there is none.
  const suppressed = isSharePage() || isSharedRoute() || life.state === 'none';
  const dead = life.state === 'expired' || life.state === 'used-up';

  // Copy follows the code that is actually on screen, derived every render and
  // every ticker tick rather than remembered. That is what makes the awkward
  // cases fall out for free: a dead-but-unused code is replaced before first
  // paint, so the fresh code re-enables the button, while a dead code that
  // survives a reload keeps it disabled - with no persisted flag to get out of
  // step. It is also why a failed New Code mint cannot wrongly re-enable it,
  // since nothing re-enables the button except a live code being rendered.
  // Set before the early returns below so every dashboard path reaches it.
  if (ui.copySessionCodeButton && !isSharePage() && !isSharedRoute()) {
    ui.copySessionCodeButton.disabled = !isCodeSendable(session);
  }

  ui.sessionCodeExpiry.classList.toggle('is-expiring', !suppressed && life.state === 'expiring');
  ui.sessionCodeExpiry.classList.toggle('is-dead', !suppressed && dead);
  ui.sessionCode.classList.toggle('is-expiring', !suppressed && life.state === 'expiring');
  ui.sessionCode.classList.toggle('is-dead', !suppressed && dead);

  if (suppressed) {
    ui.sessionCodeExpiry.hidden = true;
    ui.sessionCodeExpiry.textContent = '';
    return;
  }

  // The label sits directly above the code and is the one piece of the block
  // that would otherwise still call a struck-through code "Active". Two
  // adjacent elements disagreeing about the same code is the failure this
  // whole change exists to remove, so it moves with the rest.
  if (ui.sessionCodeLabel) {
    if (life.state === 'used-up') {
      ui.sessionCodeLabel.textContent = 'Used-Up Code';
    } else if (life.state === 'expired') {
      ui.sessionCodeLabel.textContent = 'Expired Code';
    } else {
      ui.sessionCodeLabel.textContent = 'Active Code';
    }
  }

  ui.sessionCodeExpiry.hidden = false;
  if (life.state === 'used-up') {
    ui.sessionCodeExpiry.textContent = 'Used up';
  } else if (life.state === 'expired') {
    ui.sessionCodeExpiry.textContent = 'Expired';
  } else {
    ui.sessionCodeExpiry.textContent = `Expires in ${formatCountdown(life.msLeft)}`;
  }

  if (!dead) {
    return;
  }
  // Ends with the send, not with the diagnosis. This sentence is step 2 of a
  // numbered list whose step 3 is "Return to this page to see your results" -
  // stopping at "press New Code" left that step promising a result for a code
  // that was never going to be sent. Pointing step 2 back at the channel makes
  // step 3 true again, which is cheaper than rewriting step 3 in two files.
  ui.sessionInstructions.textContent = life.state === 'used-up'
    ? 'This code has already been used the maximum number of times. Press New Code and send the fresh one.'
    : 'This code is no longer accepted. Press New Code and send the fresh one.';
  ui.sessionStatus.textContent = life.state === 'used-up' ? 'USED UP' : 'EXPIRED';

  // A dead code does not invalidate a result it already earned: a code used its
  // full three times has a real grade, and overwriting that would throw away
  // the measurement. Only the never-measured case is corrected, where the
  // headline was promising a result that can no longer arrive.
  if (isHealthMeasured(session)) {
    return;
  }
  ui.healthLabel.textContent = 'No result';
  ui.healthLabel.className = '';
  setMessagePreview(life.state === 'used-up'
    ? 'No message was heard on this code.'
    : 'No message was heard before this code expired.');
}

// ---------- Region tree (1.2.0) ----------
// snapshot.regionTree lists every place holding at least one observer, at any
// depth: { code, name, parent, depth, count, inferredCount, children }, sorted
// by depth then name. Codes are the MeshCore scope names, so they are stable
// across renames. Observers carry placePath (top level first), which is all the
// filter needs: an observer is in a place when the code is on its path.
let regionIndexCache = { tree: null, byCode: new Map() };

function regionTreeNodes(snapshot = state.snapshot) {
  return Array.isArray(snapshot?.regionTree) ? snapshot.regionTree : [];
}

function regionIndex(snapshot = state.snapshot) {
  const tree = regionTreeNodes(snapshot);
  if (regionIndexCache.tree !== tree) {
    regionIndexCache = { tree, byCode: new Map(tree.map((node) => [node.code, node])) };
  }
  return regionIndexCache.byCode;
}

function regionNode(code, snapshot = state.snapshot) {
  return code ? regionIndex(snapshot).get(code) || null : null;
}

// Codes from the top level down to code, inclusive. Empty for All.
function regionAncestry(code, snapshot = state.snapshot) {
  const byCode = regionIndex(snapshot);
  const path = [];
  let node = code ? byCode.get(code) : null;
  while (node && path.length < 32) {
    path.unshift(node.code);
    node = node.parent ? byCode.get(node.parent) : null;
  }
  return path;
}

function observerPlacePath(observer) {
  return Array.isArray(observer?.placePath) ? observer.placePath : [];
}

function nodeTotal(node) {
  return (Number(node?.count) || 0) + (Number(node?.inferredCount) || 0);
}

// Builds { byPlace: Map<code, {seen,total}>, allTally } from the observer
// directory (which knows each observer's placePath) cross-referenced against the
// current session's expectedObservers (which knows which of those observers
// actually heard this message). An observer counts for every place on its path.
// Places with no expected observers are left out of the map entirely, which
// regionStatusFromTally treats as 'unknown': nothing to report yet, not a zero.
function regionSeenTallies(session) {
  const byPlace = new Map();
  const allTally = { seen: 0, total: 0 };
  // Same gate the Current Health score uses: healthMeasured means a message
  // actually landed for this session. Before that, expectedObservers may
  // already be populated (the target set) but every seen flag is a stale
  // 'not yet' rather than a real result, so region dots must read as the
  // gray placeholder, not red.
  const healthMeasured = session && (session.healthMeasured != null
    ? Boolean(session.healthMeasured)
    : !isHealthPending(session.healthLabel));
  const expected = Array.isArray(session?.expectedObservers) ? session.expectedObservers : [];
  if (!healthMeasured || expected.length === 0) {
    return { byPlace, allTally };
  }
  const seenByKey = new Map(expected.map((observer) => [observer.key, Boolean(observer.seen)]));
  for (const observer of observerDirectory()) {
    if (!seenByKey.has(observer.key)) continue;
    // Only observers placed somewhere feed the chips, so only those count
    // toward the "All regions" tally too.
    const path = observerPlacePath(observer);
    if (path.length === 0) continue;
    const seen = seenByKey.get(observer.key);
    allTally.total += 1;
    if (seen) allTally.seen += 1;
    for (const code of path) {
      const entry = byPlace.get(code) || { seen: 0, total: 0 };
      entry.total += 1;
      if (seen) entry.seen += 1;
      byPlace.set(code, entry);
    }
  }
  return { byPlace, allTally };
}

function regionStatusFromTally(tally) {
  if (!tally || tally.total === 0) return 'unknown';
  if (tally.seen === 0) return 'none';
  if (tally.seen === tally.total) return 'all';
  return 'some';
}

// One row of top-level places, then one row per level of the selected path
// that has children, each led by "All <place>". A row is indented under the
// one above it, so depth reads as nesting rather than as more chips. A chip on
// the selected path but above the selection is marked within (not active).
function renderRegionFilter(session = currentSession()) {
  if (!ui.regionFilter) return;
  const nodes = regionTreeNodes();
  const topLevel = nodes.filter((node) => !node.parent);

  if (topLevel.length === 0) {
    ui.regionFilter.classList.add('hidden');
    ui.regionFilter.innerHTML = '';
    return;
  }
  ui.regionFilter.classList.remove('hidden');
  ui.regionFilter.innerHTML = '';

  const { byPlace, allTally } = regionSeenTallies(session);
  const path = regionAncestry(state.selectedPlace);
  const select = (code) => {
    state.selectedPlace = code;
    applyRegionSelection();
  };
  const placeButton = (node, className) => createRegionButton({
    className: `${className}${path.includes(node.code) && node.code !== state.selectedPlace ? ' region-btn--within' : ''}`,
    active: state.selectedPlace === node.code,
    label: node.name,
    count: node.count,
    inferredCount: node.inferredCount || 0,
    status: regionStatusFromTally(byPlace.get(node.code)),
    code: node.code,
    onClick: () => select(node.code),
  });

  const topRow = document.createElement('div');
  topRow.className = 'region-filter__row';
  topRow.dataset.depth = '1';
  topRow.appendChild(createRegionButton({
    className: 'region-btn--all',
    active: state.selectedPlace === null,
    label: nodes.some((node) => node.parent) || topLevel.length > 1 ? 'All regions' : 'All',
    count: topLevel.reduce((sum, node) => sum + (node.count || 0), 0),
    inferredCount: topLevel.reduce((sum, node) => sum + (node.inferredCount || 0), 0),
    status: regionStatusFromTally(allTally),
    onClick: () => select(null),
  }));
  topLevel.forEach((node) => topRow.appendChild(placeButton(node, 'region-btn--group')));
  ui.regionFilter.appendChild(topRow);

  for (const code of path) {
    const node = regionNode(code);
    const children = (node?.children || []).map((child) => regionNode(child)).filter(Boolean);
    if (children.length === 0) continue;
    const row = document.createElement('div');
    row.className = 'region-filter__row region-filter__row--subregions';
    row.dataset.depth = String((node.depth || 1) + 1);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', node.name);
    row.appendChild(createRegionButton({
      className: 'region-btn--child region-btn--all-of',
      active: state.selectedPlace === node.code,
      label: `All ${node.name}`,
      count: node.count,
      inferredCount: node.inferredCount || 0,
      status: regionStatusFromTally(byPlace.get(node.code)),
      onClick: () => select(node.code),
    }));
    children.forEach((child) => row.appendChild(placeButton(child, 'region-btn--child')));
    ui.regionFilter.appendChild(row);
  }
}

function createRegionButton({
  className, active, label, count, inferredCount = 0, status = 'unknown', code = '', onClick,
}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `region-btn ${className}${active ? ' active' : ''}`;
  if (code) btn.dataset.place = code;
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');

  const total = (Number.isFinite(count) ? count : 0) + (Number.isFinite(inferredCount) ? inferredCount : 0);

  if (total > 0) {
    const dotEl = document.createElement('span');
    dotEl.className = `region-btn__status region-btn__status--${status}`;
    dotEl.setAttribute('aria-hidden', 'true');
    dotEl.title = {
      all: 'All observers in this region heard the message.',
      some: 'Some observers in this region heard the message.',
      none: 'No observers in this region heard the message.',
      unknown: 'No results yet.',
    }[status];
    btn.appendChild(dotEl);
  }

  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  btn.appendChild(labelEl);

  // The mapped/uplink-inferred split is an implementation detail (whether an
  // observer has coordinates), not something meaningful to a region count, so
  // both fold into one total. The title still discloses the split on hover.
  if (total > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'region-btn__count';
    countEl.textContent = String(total);
    if (inferredCount > 0) {
      countEl.title = `${total} observer${total === 1 ? '' : 's'} total: ${count} mapped by coordinates, ${inferredCount} grouped by uplink code only (no map marker, no Regions Reached credit, but scored the same).`;
    }
    btn.appendChild(countEl);
  }

  btn.addEventListener('click', onClick);
  return btn;
}

// A selection whose place has lost its last observer falls back to the nearest
// ancestor that still has one, then to All.
function reconcileRegionSelection(snapshot) {
  if (state.selectedPlace === null) return;
  if (regionNode(state.selectedPlace, snapshot)) return;
  const previous = regionNode(state.selectedPlace, state.snapshot);
  let parent = previous?.parent || '';
  while (parent && !regionNode(parent, snapshot)) {
    parent = regionNode(parent, state.snapshot)?.parent || '';
  }
  state.selectedPlace = parent || null;
}

// The region filter narrows what the observer list shows and which scope the
// score is read for (scoreForSelectedScope). It never narrows the target: it
// used to set an allowlist, which meant clicking a region silently redefined
// the code - picking North Bay, one located observer, produced a session
// reporting "1 / 1, 100% VERY HEALTHY" off a single receipt. Now the code always
// targets everyone, every scope is scored, and a scope below the minimum reads
// "Small sample" rather than a grade.
function applyRegionSelection() {
  // A chip click overrides whatever the location picked, so its note goes.
  state.locate.status = null;
  render();
}

// ---------- Location opt-in (1.1.0) ----------
// "Use my location" and "Use map center" pick the deepest place a point falls
// in and select its chip, exactly as a click would. Nothing asks for location
// until the button is pressed, and the point is tested here against the map's
// own outlines (all levels, /api/region-locator): the server never sees the coordinates. The pick
// stays in this page: links and the address bar never carry a region.
const LOCATE_APPROXIMATE_METERS = 1000;

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInGeometry(lon, lat, geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates || [];
  return polygons.some((rings) => Array.isArray(rings) && rings.length > 0
    && pointInRing(lon, lat, rings[0])
    && !rings.slice(1).some((hole) => pointInRing(lon, lat, hole)));
}

function locateCapabilities() {
  return {
    device: Boolean(window.isSecureContext && navigator.geolocation),
    center: Boolean(state.map.instance),
  };
}

function renderRegionLocate() {
  if (!ui.regionFilter || ui.regionFilter.classList.contains('hidden')) return;
  if (!state.locate.row) {
    const wrap = document.createElement('div');
    wrap.className = 'region-locate';
    wrap.id = 'region-locate';
    const row = document.createElement('div');
    row.className = 'region-filter__row region-locate__buttons';
    [['device', 'Use my location'], ['center', 'Use map center']].forEach(([source, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'region-btn region-btn--locate';
      btn.dataset.locate = source;
      btn.textContent = label;
      btn.addEventListener('click', () => locateRegion(source));
      row.appendChild(btn);
    });
    const status = document.createElement('div');
    status.className = 'region-locate__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    wrap.append(row, status);
    state.locate.row = wrap;
  }
  const wrap = state.locate.row;
  const can = locateCapabilities();
  wrap.querySelectorAll('[data-locate]').forEach((btn) => {
    btn.hidden = !can[btn.dataset.locate];
    btn.disabled = Boolean(state.locate.pending);
  });
  wrap.hidden = !can.device && !can.center;

  const statusEl = wrap.querySelector('.region-locate__status');
  const status = state.locate.status;
  const signature = JSON.stringify(status || null);
  if (statusEl.dataset.signature !== signature) {
    statusEl.dataset.signature = signature;
    statusEl.replaceChildren();
    if (status?.text) {
      const line = document.createElement('p');
      line.className = 'region-locate__text';
      line.textContent = status.text;
      if (status.widen) {
        const widen = document.createElement('button');
        widen.type = 'button';
        widen.className = 'region-locate__widen';
        widen.textContent = `Widen to ${status.widen.name} (${status.widen.count} observers)`;
        widen.addEventListener('click', () => {
          state.selectedPlace = status.widen.code;
          state.locate.status = { text: `${status.widen.name}, widened from ${status.widen.from}.` };
          render();
        });
        line.append(' ', widen);
      }
      statusEl.appendChild(line);
    }
    if (status?.channel) {
      const channel = document.createElement('p');
      channel.className = 'region-locate__text';
      channel.append(`Testing ${status.channel.place}? Send to `);
      const code = document.createElement('code');
      code.textContent = `#${status.channel.name}`;
      channel.append(code, '.');
      statusEl.appendChild(channel);
    }
  }
  if (wrap.parentNode !== ui.regionFilter) {
    ui.regionFilter.appendChild(wrap);
  }
}

function devicePosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }),
      (error) => reject(Object.assign(new Error('geolocation'), {
        userMessage: error?.code === 1
          ? 'Location permission was declined. Try Use map center.'
          : 'Location not available. Try Use map center.',
      })),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  });
}

// Turns a point into a selection and the sentence that explains it. Pure apart
// from setting state.selectedPlace, so a point outside the map leaves the
// current selection alone. The outlines are every place with observers plus its observer-less children (empty: true), so
// the deepest outline containing the point is the most specific answer.
function placeFromPoint(point, features, source) {
  const where = source === 'device' ? 'your location' : 'the map center';
  const hits = features
    .filter((feature) => pointInGeometry(point.lon, point.lat, feature.geometry))
    .sort((left, right) => (Number(right.properties?.depth) || 0) - (Number(left.properties?.depth) || 0));
  const deepest = hits[0]?.properties || null;
  // An empty child names where the point is; the selection goes to the nearest
  // place above it that has observers. Simplified neighbours can leave a sliver
  // between them, which the dissolved parent outline still covers.
  let target = null;
  for (const hit of hits) {
    if (!hit.properties?.empty && regionNode(hit.properties?.code)) {
      target = regionNode(hit.properties.code);
      break;
    }
  }
  if (!target) {
    return {
      text: source === 'device'
        ? 'Your location is outside the regions on the map.'
        : 'The map center is outside the regions on the map.',
    };
  }
  state.selectedPlace = target.code;

  let text = deepest?.empty
    ? `No observers in ${deepest.name} yet, so showing ${target.name}.`
    : `${target.name}, from ${where}.`;
  if (source === 'device' && Number(point.accuracy) > LOCATE_APPROXIMATE_METERS) {
    text += ` Approximate location (about ${Math.round(point.accuracy / 1000)} km).`;
  }

  const minimum = Number(currentSession()?.minScoringSet) || 3;
  const parent = regionNode(target.parent);
  const widen = parent && nodeTotal(target) < minimum && nodeTotal(parent) > nodeTotal(target)
    ? { code: parent.code, name: parent.name, count: nodeTotal(parent), from: target.name }
    : null;

  // The regional channel only helps someone about to send a test, so the
  // shared result page leaves it out. It follows the deepest outline, empty or
  // not: someone in Lake County still tests on Lake's channel.
  let channel = null;
  const scope = deepest?.scope;
  const base = state.snapshot?.testChannel?.name || '';
  const names = state.snapshot?.testChannel?.regional?.names || [];
  if (!isSharePage() && scope && base && names.includes(`${scope}-${base}`)) {
    channel = { place: deepest.name, name: `${scope}-${base}` };
  }
  return { text, widen, channel };
}

async function locateRegion(source) {
  if (state.locate.pending) return;
  state.locate.pending = source;
  state.locate.status = {
    text: source === 'device' ? 'Finding your location...' : 'Checking the map center...',
  };
  renderRegionLocate();
  try {
    let point;
    if (source === 'device') {
      point = await devicePosition();
    } else {
      const center = state.map.instance?.getCenter();
      if (!center) {
        throw Object.assign(new Error('no map'), { userMessage: 'The map is not ready yet.' });
      }
      point = { lat: center.lat, lon: center.lng };
    }
    const features = await refineNearBorder(point, await allRegionFeatures());
    state.locate.status = placeFromPoint(point, features, source);
  } catch (error) {
    state.locate.status = { text: error?.userMessage || 'Location not available. Try Use map center.' };
  } finally {
    state.locate.pending = '';
  }
  render();
}

// Human label for the active region filter, or null when nothing is filtered.
// Used to word the map note and empty state so a narrowed view never reads as
// missing data, and to say which scope the score is for.
function activeRegionScopeLabel() {
  return regionNode(state.selectedPlace)?.name || null;
}

// Visibility only. An observer is in a place when the place is on its path, so
// an uplink-inferred observer (placed at the place its code maps to) shows
// there and above, and disappears under a narrower chip - which is exactly
// right: that place is all its uplink code can tell us.
function observersMatchingRegionFilter(observers) {
  if (!state.selectedPlace) {
    return observers;
  }
  return observers.filter((observer) => observerPlacePath(observer).includes(state.selectedPlace));
}

// Everything that used to be split between the scrollable "Observers" list and
// the "Score Against" grid, in one place. The two panels had become two views of
// the same set that disagreed on both membership and detail, and reconciling them
// was left to the reader. There is one list now: the observers this code is
// scored against, each stating its own region, position status and receipt state.
function observerDetailLine(observer) {
  const parts = [];
  const path = observerPlacePath(observer);
  const name = (code) => regionNode(code)?.name || code;
  if (path.length === 0) {
    parts.push('no region');
  } else if (observer.regionInferred) {
    // The place is the metro of the uplink gateway, so name the code that
    // supplied it rather than implying we know where the node is.
    parts.push(`${name(path[path.length - 1])} via ${observer.uplinkCode || 'uplink'}`);
  } else {
    // The place and the one above it: "Sonoma County, North Bay".
    parts.push(path.slice(-2).reverse().map(name).join(', '));
  }
  parts.push(observer.hasLocation ? 'mapped' : 'no coordinates');
  if (observer.isRetained === false) {
    parts.push('not recently heard');
  }
  return parts.join(' \u00b7 ');
}

// "path hash" is upstream's own name for the setting -- docs.meshcore.io calls
// `path.hash.mode 1` a 2-byte path hash -- so the card matches what an operator
// sees in the app. The bytes are a public-key prefix rather than a digest of the
// route, but "prefix" alone would read as an annotation on the truncated key
// printed just before this note, and would drop the reason the width matters.
//
// Rendered as its own element rather than appended to the detail string, because
// .observer-detail sets overflow-wrap: anywhere for long region names and that
// happily split "2-BYTE PATH" after the hyphen. Only stated when the node's own
// advert confirmed the width: a prefix seen inside somebody else's forwarded
// path is not evidence of that node's setting.
function observerHashModeNote(observer) {
  if (!observer?.hashBytesConfirmed) {
    return '';
  }
  return `${observerHashBytes(observer)}-byte path hash`;
}

// The one roster the reports list is built from, and the only one now: the
// Observers chip panel that used to be the second view of this set has been
// deleted. It previously lived inside renderObservers while renderReceipts built
// its list from session.receipts instead, so the two could disagree on both
// membership and per-observer detail. A receipt is now an attribute of a roster
// row, not the thing that creates the row.
//
// Every row carries its own region and position, so nothing downstream needs to
// re-look-up observerDirectory() to work out what an observer is.
function mergedObserverRoster(session) {
  const expected = Array.isArray(session?.expectedObservers)
    ? session.expectedObservers.filter((observer) => observer?.key)
    : [];
  const seenByKey = new Map(expected.map((observer) => [observer.key, Boolean(observer.seen)]));
  // With no session yet this previews what the next code will target, so a cold
  // load shows the roster instead of an empty box.
  const targeted = new Set(
    expected.length > 0 ? expected.map((observer) => observer.key) : defaultObserverKeys(),
  );

  const merged = new Map(selectableObservers().map((observer) => [observer.key, observer]));
  for (const observer of expected) {
    if (!merged.has(observer.key)) {
      merged.set(observer.key, { ...fallbackObserverRecord(observer.key), ...observer });
    }
  }

  // Scored observers first so the target reads as one block, then anything known
  // but not currently being scored. Nothing is dropped for being quiet.
  const all = [...merged.values()].sort((left, right) => {
    const byTarget = Number(targeted.has(right.key)) - Number(targeted.has(left.key));
    if (byTarget !== 0) {
      return byTarget;
    }
    return observerDisplayLabel(left).localeCompare(observerDisplayLabel(right));
  });
  return { all, targeted, seenByKey };
}

const UNSCORED_EXPLANATION = 'Not scored: these observers were not active when this test started, so they do not count toward its score.';

// Heard / not heard / not scored, decided from the roster alone so both lists
// answer the question the same way.
function observerHeardState(observer, targeted, seenByKey) {
  if (!targeted.has(observer.key)) {
    return 'unscored';
  }
  return seenByKey.get(observer.key) ? 'heard' : 'unheard';
}

function applySiteBranding(snapshot) {
  const site = snapshot?.site || {};
  applyMapTileConfig(site.map);
  const title = site.title || 'Mesh Health Check';
  const version = String(site.version || '').trim() || '0.0.0';
  const eyebrow = site.eyebrow || 'MeshCore Observer Coverage';
  const headline = site.headline || 'Check your mesh reach.';
  const repoUrl = site.repoUrl || 'https://github.com/tmcgee/bayarea-mesh-health-check';
  const changesUrl = site.changesUrl || `${repoUrl}/blob/main/CHANGES.md`;
  const upstreamBase = (version.match(/\+upstream\.(\d+\.\d+\.\d+)$/) || [])[1] || '';
  const externalUrl = String(site.externalLinkUrl || '').trim();
  const externalLabel = String(site.externalLinkLabel || '').trim() || 'External Link';
  const description = site.description
    || 'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.';
  const [prefix, ...suffixParts] = description.split('configured channel');
  const suffix = suffixParts.join('configured channel');

  document.title = isSharePage() ? `${title} Shared Result` : title;
  ui.repoNoteLink.href = repoUrl;
  ui.siteVersionNote.href = changesUrl;
  ui.siteVersionNote.textContent = `Version: v${version}`;
  ui.siteVersionNote.title = upstreamBase
    ? `Based on yellowcooln/meshcore-health-check v${upstreamBase} (MIT)`
    : 'Based on yellowcooln/meshcore-health-check (MIT)';
  if (externalUrl) {
    ui.externalLink.href = externalUrl;
    ui.externalLink.textContent = externalLabel;
    ui.externalLink.classList.remove('hidden');
  } else {
    ui.externalLink.href = '#';
    ui.externalLink.textContent = 'External Link';
    ui.externalLink.classList.add('hidden');
  }
  if (isSharePage()) {
    ui.heroEyebrow.textContent = 'Shared Result';
    ui.heroTitle.textContent = 'Observer coverage someone shared with you.';
    setHeroSentence(
      'This page is read-only. Review the result from',
      'or open the full dashboard to run your own check.',
    );
    return;
  }
  ui.heroEyebrow.textContent = eyebrow;
  ui.heroTitle.textContent = headline;
  // The channel chip only has a home when the description contains the literal
  // phrase "configured channel" to split on. Without it the sentence stands
  // alone, so hide the chip instead of trailing a bare channel name after it.
  const hasChannelSlot = suffixParts.length > 0;
  setHeroSentence(
    (prefix || '').trimEnd() || 'Generate a test code, send it to',
    suffix || '',
  );
  if (ui.heroChannel) {
    ui.heroChannel.hidden = !hasChannelSlot;
  }
}

// The channel chip is an inline element between two text spans that carry no
// whitespace of their own in the markup, so the spacing belongs here. The suffix
// usually resumes the sentence with punctuation (", and watch ..."), which has
// to sit flush against the chip: a space in front of it both prints "#channel ,"
// and offers the browser a line break that leaves a line starting with a comma.
function setHeroSentence(prefixText, suffixText) {
  const prefix = String(prefixText || '').trimEnd();
  const suffix = String(suffixText || '').trimStart();
  ui.heroDescriptionPrefix.textContent = prefix ? `${prefix} ` : '';
  ui.heroDescriptionSuffix.textContent = suffix && !/^[,.;:!?)\]]/.test(suffix)
    ? ` ${suffix}`
    : suffix;
}

function mapKnownObservers(session) {
  const directory = observerDirectory();
  const mergedDirectory = new Map();
  for (const observer of configuredDefaultObservers()) {
    mergedDirectory.set(observer.key, observer);
  }
  for (const observer of directory) {
    const existing = mergedDirectory.get(observer.key) || {};
    mergedDirectory.set(observer.key, {
      ...existing,
      ...observer,
    });
  }
  let source = [...mergedDirectory.values()];
  if (mapObserverScope === 'expected') {
    const directoryByKey = new Map(source.map((observer) => [observer.key, observer]));
    const expected = Array.isArray(session?.expectedObservers)
      ? session.expectedObservers.filter((observer) => observer?.key)
      : [];
    if (expected.length > 0) {
      source = expected.map((observer) => {
        const known = directoryByKey.get(observer.key) || fallbackObserverRecord(observer.key);
        return {
          ...known,
          ...observer,
          lat: known.lat,
          lon: known.lon,
          hasLocation: known.hasLocation,
        };
      });
    }
  }
  const seenKeys = new Set(
    Array.isArray(session?.receipts) ? session.receipts.map((receipt) => receipt.observerKey) : [],
  );
  // The region filter now governs the map as well as the lists. Region is read
  // from the merged directory record rather than from `observer`, because the
  // 'expected' scope above spreads session.expectedObservers last and those
  // entries can carry a null region that would shadow the directory value.
  return source
    .filter((observer) => {
      const regionRecord = mergedDirectory.get(observer.key) || observer;
      return observersMatchingRegionFilter([regionRecord]).length > 0;
    })
    .filter((observer) => {
      const lat = Number(observer.lat);
      const lon = Number(observer.lon);
      return observer.lat != null
        && observer.lon != null
        && Number.isFinite(lat)
        && Number.isFinite(lon)
        && Math.abs(lat) <= 90
        && Math.abs(lon) <= 180
        && !(lat === 0 && lon === 0);
    })
    .map((observer) => ({
      ...observer,
      seen: Boolean(observer.seen) || seenKeys.has(observer.key),
    }));
}

function ensureObserverMap() {
  if (state.map.instance || !ui.observerMap || !window.L) {
    return state.map.instance;
  }
  state.map.instance = window.L.map(ui.observerMap, {
    zoomControl: true,
    attributionControl: true,
  });
  state.map.instance.setView([20, 0], 2);
  // moveend follows every zoom too.
  state.map.instance.on('moveend', () => { ensureRegionDetail(); });
  return state.map.instance;
}

// Tile URLs come from the server (site.map) so the CARTO API key stays in .env
// instead of being hard-coded here. Falls back to the historical defaults.
function applyMapTileConfig(tiles) {
  if (!tiles || typeof tiles !== 'object') {
    return;
  }
  const signature = `${tiles.darkTileUrl || ''}|${tiles.lightTileUrl || ''}`;
  if (signature === state.map.tileSignature) {
    return;
  }
  state.map.tiles = tiles;
  state.map.tileSignature = signature;
  // Force renderObserverMap() to swap in a layer built from the new URLs.
  state.map.layerTheme = '';
}

function currentTileLayer() {
  if (!window.L) {
    return null;
  }
  const tiles = state.map.tiles || {};
  const light = state.uiTheme === 'light';
  const url = (light ? tiles.lightTileUrl : tiles.darkTileUrl)
    || (light
      ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
      : 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png');
  const attribution = (light ? tiles.lightAttribution : tiles.darkAttribution)
    || (url.includes('cartocdn.com')
      ? '&copy; OpenStreetMap contributors &copy; CARTO'
      : '&copy; OpenStreetMap contributors');
  return window.L.tileLayer(url, {
    maxZoom: 19,
    subdomains: tileSubdomains(url),
    // Upstream dc3fe057: a website-restricted CARTO key checks the Referer, and
    // the page-wide no-referrer policy sends none. Send the origin only, never
    // the path or query; other providers keep no-referrer.
    ...(url.includes('cartocdn.com') ? { referrerPolicy: 'strict-origin' } : {}),
    attribution,
  });
}

// CARTO serves its raster tiles from a, b, c and d; OpenStreetMap only from a, b
// and c - d.tile.openstreetmap.org has no address at all. Both URLs used to
// share a hardcoded 'abcd', so roughly a quarter of tile requests failed with
// ERR_NAME_NOT_RESOLVED whenever the app took the OSM fallback, leaving visible
// holes in the map. Anything unrecognised gets the safe three, which every
// {s}-style tile service supports.
function tileSubdomains(url) {
  return String(url).includes('cartocdn.com') ? 'abcd' : 'abc';
}

function markerIcon(observer) {
  return window.L.divIcon({
    className: 'observer-map-icon-shell',
    html: `<span class="observer-map-icon ${observer.seen ? 'seen' : 'missed'}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// The set of places whose outlines belong on the map, as a stable key: the
// codes in the region tree. Geometry is refetched exactly when a place gains
// its first observer or loses its last. A directory with no places yields an
// empty key and no outlines, which is correct: there are no regions to draw.
function regionBoundaryKey(snapshot = state.snapshot) {
  return regionTreeNodes(snapshot).map((node) => `${node.code}${node.expand ? '+' : ''}`).sort().join('|');
}

// The levels the map needs now: the top level, and every level down the
// selected path, so the selection's own outline (for framing) and its
// children's (for drawing) are both at hand.
function regionLevelsWanted() {
  const parent = regionOutlineParent();
  const bold = regionBoldParents();
  // The faint lines are the children of every bold outline. The tree names the
  // bold places with observers; observer-less ones are counties, which have no
  // children, so the tree is enough to ask for everything in one request.
  const drawn = regionTreeNodes()
    .filter((node) => bold.includes(node.parent || '') && !regionExpandedTop(node) && node.children.length > 0)
    .map((node) => node.code);
  return [...new Set(['', ...(parent ? regionAncestry(parent) : []), ...bold, ...drawn])];
}

// A top-level place the overrides file expands (`expand`, 1.2.0): under All the
// map shows it subdivided, as if it were selected, and the rest whole.
function regionExpandedTop(node) {
  return Boolean(node?.expand) && !node.parent;
}

// The parents whose children are drawn as the bold, status-coloured outlines:
// the selection's level, or under All the top level plus each expanded place.
function regionBoldParents() {
  const parent = regionOutlineParent();
  if (parent) return [parent];
  return ['', ...regionTreeNodes().filter(regionExpandedTop).map((node) => node.code)];
}

function resetRegionOutlines(key) {
  state.map.regionKey = key;
  state.map.regionFeatures = [];
  state.map.regionLevels = new Set();
  state.map.regionFull = new Set();
  state.map.regionComplete = false;
}

// Coarse outlines never replace full ones: once a place has its full outline
// (zoomed in, or from the locator) it keeps it.
function mergeRegionFeatures(features, { full = false } = {}) {
  const byCode = new Map(state.map.regionFeatures.map((feature) => [feature.properties?.code, feature]));
  for (const feature of Array.isArray(features) ? features : []) {
    const code = feature?.properties?.code;
    if (!code || (!full && state.map.regionFull.has(code))) continue;
    byCode.set(code, feature);
    if (full) state.map.regionFull.add(code);
  }
  state.map.regionFeatures = [...byCode.values()];
}

// Levels are fetched coarse (~400 m, ?detail=coarse): opening the page costs
// the levels it draws, and a drill-down just the level it opens. Full detail
// is fetched per outline, for the ones in view, once the map is zoomed in
// (ensureRegionDetail). Both 1.1.0 payloads together were 470 KB; the whole
// 1.2.0 tree at full detail is about as large, so it is never sent up front.
async function ensureRegionBoundaries() {
  const key = regionBoundaryKey();
  if (!key) {
    return;
  }
  if (key !== state.map.regionKey) {
    resetRegionOutlines(key);
  }
  if (state.map.regionComplete) {
    return;
  }
  const missing = regionLevelsWanted().filter((level) => !state.map.regionLevels.has(level)
    && !state.map.regionPending.has(`${key}#${level}`));
  if (missing.length === 0) {
    return;
  }
  // One request for every missing level (a comma list; codes never hold commas).
  await (async () => {
    const pendingKeys = missing.map((level) => `${key}#${level}`);
    pendingKeys.forEach((pendingKey) => state.map.regionPending.add(pendingKey));
    try {
      const response = await fetch(`/api/region-boundaries?detail=coarse&parent=${missing.map(encodeURIComponent).join(',')}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      // A newer tree arrived while this was in flight: its geometry is stale.
      if (state.map.regionKey !== key) return;
      mergeRegionFeatures(payload?.features);
      missing.forEach((level) => state.map.regionLevels.add(level));
      // The fetch resolves after the render that asked for it, so draw now. The
      // re-entered render finds the level loaded and does not fetch again.
      renderObserverMap(currentSession());
    } catch {
      // A missing or broken outline must not take the map with it. Leaving the
      // level unloaded lets a later poll retry.
    } finally {
      pendingKeys.forEach((pendingKey) => state.map.regionPending.delete(pendingKey));
    }
  })();
}

// From this zoom the coarse outlines' ~400 m steps start to show (a pixel is
// about 300 m at zoom 9 here), so the outlines in view are swapped for full detail.
const REGION_FULL_DETAIL_ZOOM = 9;

// Full detail for the drawn outlines (bold and faint) that touch the view, in
// one request by code. Runs after every pan and zoom and every redraw; an
// outline already full or on its way is not asked for again.
async function ensureRegionDetail() {
  const mapInstance = state.map.instance;
  const key = state.map.regionKey;
  if (!mapInstance || !key || mapInstance.getZoom() < REGION_FULL_DETAIL_ZOOM) return;
  const view = mapInstance.getBounds().pad(0.25);
  const codes = [];
  for (const [code, entry] of [...state.map.regionShapes.entries(), ...state.map.regionFaint.entries()]) {
    if (state.map.regionFull.has(code) || state.map.regionPending.has(`${key}@${code}`)) continue;
    const bounds = entry.shape.getBounds();
    if (bounds.isValid() && view.intersects(bounds)) codes.push(code);
  }
  if (codes.length === 0) return;
  const pendingKeys = codes.map((code) => `${key}@${code}`);
  pendingKeys.forEach((pendingKey) => state.map.regionPending.add(pendingKey));
  try {
    const response = await fetch(`/api/region-boundaries?code=${codes.map(encodeURIComponent).join(',')}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (state.map.regionKey !== key) return;
    mergeRegionFeatures(payload?.features, { full: true });
    renderObserverMap(currentSession());
  } catch {
    // Coarse outlines stay on screen; the next pan or zoom asks again.
  } finally {
    pendingKeys.forEach((pendingKey) => state.map.regionPending.delete(pendingKey));
  }
}

// The locator needs every level at once, as in 1.1.0 it fetched the locator
// outlines on the first click. They join the map's own, so nothing is fetched
// twice. It loads them coarse (~400 m, 99 KB raw / 22 KB gzipped against
// 432 KB / 113 KB at full detail); refineNearBorder then fetches full detail
// for just the places whose edge passes near the point.
async function allRegionFeatures() {
  const key = regionBoundaryKey();
  if (key && key === state.map.regionKey && state.map.regionComplete) {
    return state.map.regionFeatures;
  }
  const response = await fetch('/api/region-locator?detail=coarse', { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      userMessage: 'Region outlines are not available right now.',
    });
  }
  const payload = await response.json();
  if (key !== state.map.regionKey) resetRegionOutlines(key);
  mergeRegionFeatures(payload?.features);
  state.map.regionComplete = true;
  return state.map.regionFeatures;
}

// A coarse edge lies within the coarse tolerance (0.004 degrees, server.js
// REGION_OUTLINE_COARSE_TOLERANCE) of the true one, so a point farther than
// that from every coarse edge gets the same answer at full detail. 0.006 adds
// a margin. Measured in plain degrees, as the thinning is.
const LOCATE_REFINE_DEGREES = 0.006;

function segmentDistance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function geometryNear(lon, lat, geometry, limit) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates || [];
  return polygons.some((rings) => (rings || []).some((ring) => (ring || []).some((point, index) => (
    index > 0 && segmentDistance(lon, lat, ring[index - 1], point) <= limit
  ))));
}

// Near a border the coarse outlines can put a point on the wrong side, so the
// places whose edge passes within the margin are fetched at full detail (by
// code, as the zoomed-in map does) before the point is tested. Elsewhere
// nothing more is fetched. A failure keeps the coarse answer.
async function refineNearBorder(point, features) {
  const codes = features
    .filter((feature) => !state.map.regionFull.has(feature.properties?.code)
      && geometryNear(point.lon, point.lat, feature.geometry, LOCATE_REFINE_DEGREES))
    .map((feature) => feature.properties.code);
  if (codes.length === 0) return features;
  const key = state.map.regionKey;
  try {
    const response = await fetch(`/api/region-locator?code=${codes.map(encodeURIComponent).join(',')}`, { headers: { accept: 'application/json' } });
    if (!response.ok) return features;
    const payload = await response.json();
    if (key !== state.map.regionKey) return features;
    mergeRegionFeatures(payload?.features, { full: true });
    return state.map.regionFeatures;
  } catch {
    return features;
  }
}

// A dedicated pane keeps the outlines strictly between the tiles and the
// markers. Leaflet's defaults are tilePane 200, overlayPane 400, shadowPane 500,
// markerPane 600; 350 therefore draws above the basemap but below every marker,
// so an outline can never cover an observer point.
function ensureRegionPane(mapInstance) {
  if (state.map.regionPane) {
    return state.map.regionPane;
  }
  const name = 'observerRegions';
  const pane = mapInstance.createPane(name);
  pane.style.zIndex = '350';
  // Belt and braces alongside interactive:false below: the pane swallows no
  // pointer events at all, so marker taps, popups and drag/zoom are untouched.
  pane.style.pointerEvents = 'none';
  state.map.regionPane = name;
  return name;
}

// The outlines drawn are one level of the tree: the top-level places under All,
// and under a selected place its children, including observer-less ones in
// gray, so the place reads as subdivided. A selected place with no children
// keeps its parent's level on screen (as a county did under its group in
// 1.1.0), so a drill-down to a leaf does not empty the map.
function regionOutlineParent() {
  const node = regionNode(state.selectedPlace);
  if (!node) return '';
  return node.children.length > 0 ? node.code : node.parent || '';
}

function regionBoundaryVisible(properties) {
  const parent = regionOutlineParent();
  if (parent) {
    return properties?.parent === parent;
  }
  // Under All: the top level, except an expanded place, which is drawn as its
  // children instead (observer-less ones in gray, as when it is selected).
  if (!properties?.parent) {
    return !properties?.empty && !regionExpandedTop(regionNode(properties?.code));
  }
  return regionExpandedTop(regionNode(properties.parent));
}

// Least to most urgent: later entries draw on top.
const REGION_STROKE_ORDER = { unknown: 0, all: 1, some: 2, none: 3 };

// Unique ids for the <mask> elements (see maskToInnerStroke).
let regionMaskSequence = 0;

// Width of the stroke that grows each mask past its polygon: half of it,
// 0.5px, on either side.
const REGION_MASK_GROW_PX = 1;

// Leaflet thins every path on its own as it draws (smoothFactor), which would
// give two outlines different pixels along the border they share. The server
// already thinned them together, so drawing every vertex keeps a shared border
// one line.
const REGION_SMOOTH_FACTOR = 0;

// The second pane, under the bold outlines, for the faint next-level lines.
// The 0.45 opacity is the pane's, not each line's, so where two children's
// identical borders overlap they read as one line, not a darker one.
function ensureRegionFaintPane(mapInstance) {
  if (state.map.regionFaintPane) return state.map.regionFaintPane;
  const name = 'observerRegionsFaint';
  const pane = mapInstance.createPane(name);
  pane.style.zIndex = '349';
  pane.style.pointerEvents = 'none';
  pane.style.opacity = '0.45';
  state.map.regionFaintPane = name;
  return name;
}

function regionEdgeKey(a, b) {
  const from = `${a[0]},${a[1]}`;
  const to = `${b[0]},${b[1]}`;
  return from < to ? `${from}|${to}` : `${to}|${from}`;
}

function regionFeatureRings(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === 'Polygon') return geometry.coordinates;
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

// The stretches of a drawn outline whose other side is a neighbour with a
// different status, as Leaflet polylines. Everywhere else a shared border is
// one 2px line in the colour both sides agree on; here each side gets 1px.
function regionSplitRuns(code, status, rings, owners) {
  const runs = [];
  for (const ring of rings) {
    const n = ring.length - 1; // closed: the last point repeats the first
    if (n < 2) continue;
    const split = [];
    for (let i = 0; i < n; i += 1) {
      const others = owners.get(regionEdgeKey(ring[i], ring[i + 1])) || [];
      split.push(others.some((other) => other.code !== code && other.status !== status));
    }
    // Walk from an edge that is not split, so no run wraps past the ring's start.
    const start = split.indexOf(false);
    let run = null;
    for (let step = 0; step < n; step += 1) {
      const i = (Math.max(start, 0) + step) % n;
      if (!split[i]) {
        run = null;
        continue;
      }
      if (!run) {
        run = [[ring[i][1], ring[i][0]]];
        runs.push(run);
      }
      run.push([ring[i + 1][1], ring[i + 1][0]]);
    }
  }
  return runs;
}

// Shared borders are drawn once (1.2.0). Each outline is stroked 2px centred
// on its boundary; neighbours share exact vertices, so where they agree on a
// status their strokes land on the same pixels and read as one 2px line, at
// an outer edge too. Where two neighbours' statuses differ, a split overlay on
// just that stretch is masked to each side (maskToInnerStroke), so the line is
// 1px of each colour, still 2px in all. In 1.1.0 every outline was an inner
// stroke, which made every shared border two 2px lines side by side.
//
// Stroke colour lives in CSS (.region-shape--*) against the same custom
// properties as the region filter dots, so the palette is defined once. The
// set is small and changes only with the selection or a session's results, so
// any change rebuilds it.
function renderRegionBoundaries(mapInstance, session) {
  const features = Array.isArray(state.map.regionFeatures) ? state.map.regionFeatures : [];
  // Coloured by the place's own tally, so an outline always agrees with its
  // chip. An observer-less child has no tally and draws as unknown.
  const { byPlace } = regionSeenTallies(session);
  const wanted = new Map();
  for (const feature of features) {
    const code = feature?.properties?.code;
    if (!code || !regionBoundaryVisible(feature.properties)) continue;
    wanted.set(code, { feature, status: regionStatusFromTally(byPlace.get(code)) });
  }
  renderRegionFaintLines(mapInstance, new Set(wanted.keys()), features);

  const same = wanted.size === state.map.regionShapes.size
    && [...wanted].every(([code, next]) => {
      const entry = state.map.regionShapes.get(code);
      return entry && entry.status === next.status && entry.feature === next.feature;
    });
  if (same) return;
  for (const entry of state.map.regionShapes.values()) {
    entry.shape.remove();
    entry.split?.remove();
    entry.masks.forEach(releaseInnerStroke);
  }
  state.map.regionShapes.clear();
  if (wanted.size === 0) return;

  const pane = ensureRegionPane(mapInstance);
  const owners = new Map();
  for (const [code, { feature, status }] of wanted) {
    for (const ring of regionFeatureRings(feature)) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const key = regionEdgeKey(ring[i], ring[i + 1]);
        if (!owners.has(key)) owners.set(key, []);
        owners.get(key).push({ code, status });
      }
    }
  }
  // Least urgent first, so where strokes overlap (a shared border before its
  // split overlay, or a corner) the more urgent status is on top.
  const ordered = [...wanted].sort(([, left], [, right]) => (REGION_STROKE_ORDER[left.status] ?? 0) - (REGION_STROKE_ORDER[right.status] ?? 0));
  const splits = [];
  for (const [code, { feature, status }] of ordered) {
    const shape = window.L.geoJSON(feature, {
      pane,
      interactive: false,
      smoothFactor: REGION_SMOOTH_FACTOR,
      // Fill is off outright rather than transparent, so the interior paints
      // nothing and cannot become a hit target.
      style: { fill: false, className: `region-shape region-shape--${status}` },
    }).addTo(mapInstance);
    // Name the drawn path so the outline set is identifiable from the DOM, which
    // is what the smoke test asserts against.
    let outline = null;
    shape.eachLayer((sub) => {
      const element = sub.getElement();
      if (!element) return;
      element.setAttribute('data-region-place', code);
      outline = outline || element;
    });
    const entry = { shape, status, feature, masks: [], split: null };
    const runs = regionSplitRuns(code, status, regionFeatureRings(feature), owners);
    if (runs.length && outline) splits.push({ code, status, runs, outline, entry });
    state.map.regionShapes.set(code, entry);
  }
  // Split overlays above every outline, each masked to its own region.
  for (const { code, status, runs, outline, entry } of splits) {
    const split = window.L.polyline(runs, {
      pane,
      interactive: false,
      smoothFactor: REGION_SMOOTH_FACTOR,
      fill: false,
      className: `region-split region-shape--${status}`,
    }).addTo(mapInstance);
    const element = split.getElement();
    if (element) {
      element.setAttribute('data-region-split', code);
      // No overhang: the centred stroke underneath already fills the seam, and
      // growing the mask would let the urgent side cover half its neighbour's 1px.
      const mask = maskToInnerStroke(element, outline, 0);
      if (mask) entry.masks.push(mask);
    }
    entry.split = split;
  }
}

// Faint next-level lines (1.2.0): inside each bold outline, its children drawn
// thin and neutral, so a region shows how it divides without being selected.
// They carry no status (the bold outline and its chip do). They sit in their
// own pane under the bold outlines: a child's edge on its parent's boundary is
// the same line, hidden under the 2px stroke, and two children's shared border
// is one 1px line (see ensureRegionFaintPane).
function renderRegionFaintLines(mapInstance, boldCodes, features) {
  const wanted = new Map();
  for (const feature of features) {
    const code = feature?.properties?.code;
    if (code && boldCodes.has(feature.properties.parent) && !boldCodes.has(code)) {
      wanted.set(code, feature);
    }
  }
  for (const [code, entry] of state.map.regionFaint.entries()) {
    if (wanted.get(code) !== entry.feature) {
      entry.shape.remove();
      state.map.regionFaint.delete(code);
    }
  }
  if (wanted.size === 0) {
    return;
  }
  const pane = ensureRegionFaintPane(mapInstance);
  for (const [code, feature] of wanted.entries()) {
    if (state.map.regionFaint.has(code)) continue;
    const shape = window.L.geoJSON(feature, {
      pane,
      interactive: false,
      smoothFactor: REGION_SMOOTH_FACTOR,
      style: { fill: false, className: 'region-faint' },
    }).addTo(mapInstance);
    shape.eachLayer((sub) => sub.getElement()?.setAttribute('data-region-faint', code));
    state.map.regionFaint.set(code, { shape, feature });
  }
}

// Inner stroke, for the split overlays: where two neighbours' statuses differ,
// each one's overlay on the shared stretch is masked to its own polygon, so of
// its 2px stroke only the inside 1px shows and the two colours sit side by side
// (1.1.0 masked every outline this way, at double width).
//
// A mask and not a clip-path, because the edge has to be grown. A clip edge is
// antialiased on its own: two neighbours whose edges meet exactly each cover
// only part of a boundary pixel, and between the two strokes a hairline of map
// shows (0.79 of full coverage along a diagonal border). Leaflet also thins each
// polygon separately, so a shared border is never quite the same line on both
// sides. The mask is the polygon plus its own outline stroked REGION_MASK_GROW_PX
// wide, half a pixel past the boundary, so neighbours overlap instead of
// touching and no pixel is left bare. An outer edge, with no neighbour, shows
// that half pixel outside its boundary.
//
// The mask is a separate path, not a <use> of the outline: a clone of the
// outline would carry the outline's own mask and reference itself. Leaflet
// rewrites the outline's d on every zoom and pan, so an observer copies it
// across from the region's outline (areaElement); maskContentUnits default to the outline's own user space, so the copy
// lines up without any transform. The mask region is set in that same space and
// made far larger than any view, so it never crops the outline.
function maskToInnerStroke(pathElement, areaElement = pathElement, growPx = REGION_MASK_GROW_PX) {
  const svg = pathElement.ownerSVGElement;
  if (!svg || typeof MutationObserver === 'undefined') return null;
  const ns = 'http://www.w3.org/2000/svg';
  let defs = svg.querySelector(':scope > defs');
  if (!defs) {
    defs = document.createElementNS(ns, 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  regionMaskSequence += 1;
  const id = `region-mask-${regionMaskSequence}`;
  const mask = document.createElementNS(ns, 'mask');
  mask.setAttribute('id', id);
  mask.setAttribute('maskUnits', 'userSpaceOnUse');
  mask.setAttribute('x', '-100000');
  mask.setAttribute('y', '-100000');
  mask.setAttribute('width', '200000');
  mask.setAttribute('height', '200000');
  const source = document.createElementNS(ns, 'path');
  source.setAttribute('class', 'region-mask');
  // Leaflet draws polygons evenodd, so holes mask out exactly as they render.
  source.setAttribute('fill', '#fff');
  source.setAttribute('fill-rule', 'evenodd');
  source.setAttribute('stroke', '#fff');
  source.setAttribute('stroke-width', String(growPx));
  source.setAttribute('stroke-linejoin', 'round');
  source.setAttribute('d', areaElement.getAttribute('d') || '');
  mask.appendChild(source);
  defs.appendChild(mask);
  const observer = new MutationObserver(() => {
    source.setAttribute('d', areaElement.getAttribute('d') || '');
  });
  observer.observe(areaElement, { attributes: true, attributeFilter: ['d'] });
  pathElement.setAttribute('mask', `url(#${id})`);
  return { mask, observer };
}

function releaseInnerStroke(entry) {
  entry.observer.disconnect();
  entry.mask.remove();
}

// The outline bounds of the selected place, or null when the map should frame
// the plotted observers instead (All, or before the geometry arrives - the
// fetch re-enters renderObserverMap and the changed boundsKey then refits).
// Mapped observers in a place were placed there by its outline, so the frame
// always contains them; a place with none mapped still gets a view of itself
// instead of the map staying wherever it was.
function selectedRegionFrame() {
  if (!state.selectedPlace || !window.L) {
    return null;
  }
  const features = Array.isArray(state.map.regionFeatures) ? state.map.regionFeatures : [];
  const selected = features.filter((item) => item?.properties?.code === state.selectedPlace);
  if (selected.length === 0) {
    return null;
  }
  try {
    const bounds = window.L.geoJSON({ type: 'FeatureCollection', features: selected }).getBounds();
    return bounds.isValid() ? bounds : null;
  } catch {
    return null;
  }
}

// Receipt path map. Only for receipts whose every hop is a 2-byte hash: measured
// on live traffic, 97% of 1-byte hops match several known nodes and over a third
// of the 1-byte hops that do resolve share their prefix with a node the app does
// not know about, so a 1-byte map would draw guesses as route. At 2 bytes 89% of
// hops resolve to a located node and about 1% are shared.
const RECEIPT_PATH_HASH_HEX = 4;

// Points are the hops the server resolved to exactly one located node (it sends
// no position otherwise), in path order. Consecutive hops that resolved to the
// same node collapse into one point. A leg between points that are not adjacent
// in the path passes through hops with no position and is drawn dashed. Null
// when there is nothing honest to draw: not 2-byte, or fewer than two points.
function receiptPathMapData(receipt) {
  const hops = Array.isArray(receipt?.pathHops) ? receipt.pathHops : [];
  if (hops.length < 2) {
    return null;
  }
  if (!hops.every((hop) => String(hop?.hash || '').length === RECEIPT_PATH_HASH_HEX)) {
    return null;
  }
  const points = [];
  hops.forEach((hop, index) => {
    if (hop?.lat == null || hop?.lon == null) {
      return;
    }
    const lat = Number(hop.lat);
    const lon = Number(hop.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    const previous = points[points.length - 1];
    if (previous && hop.key && previous.key === hop.key) {
      previous.lastIndex = index;
      return;
    }
    points.push({
      index,
      lastIndex: index,
      lat,
      lon,
      key: String(hop.key || ''),
      label: receiptHopLabel(hop.label, hop.hash),
      isTerminal: Boolean(hop.isTerminal),
    });
  });
  if (points.length < 2) {
    return null;
  }
  const legs = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    legs.push({ from, to, skipped: to.index - from.lastIndex - 1 });
  }
  return { points, legs, hopCount: hops.length };
}

// The selected receipt, only while its card is actually listed: same session,
// observer inside the region filter, and the heard filter not hiding heard rows.
// Otherwise the selection is dropped, so a path can never sit on the map with no
// card on screen to explain it or to turn it off.
function selectedPathReceipt(session) {
  const selection = state.receiptPath;
  if (!selection.key) {
    return null;
  }
  const receipts = Array.isArray(session?.receipts) ? session.receipts : [];
  const receipt = session && session.id === selection.sessionId
    ? receipts.find((entry) => entry.observerKey === selection.key) || null
    : null;
  const listed = receipt
    && state.receiptHeardFilter !== 'unheard'
    && observersMatchingRegionFilter(mergedObserverRoster(session).all)
      .some((observer) => observer.key === receipt.observerKey);
  if (!listed || !receiptPathMapData(receipt)) {
    selection.key = '';
    selection.sessionId = '';
    return null;
  }
  return receipt;
}

// Above the region outlines (350), below the observer markers (600), so the
// receiving observer's own marker stays on top of the path's last point.
function ensureReceiptPathPane(mapInstance) {
  if (state.map.pathPane) {
    return state.map.pathPane;
  }
  const name = 'receiptPath';
  mapInstance.createPane(name).style.zIndex = '450';
  state.map.pathPane = name;
  return name;
}

// Draws the selected receipt's path and returns its data (null when nothing is
// selected). Rebuilt only when the points change, not on every poll.
function renderReceiptPathLayer(mapInstance, session) {
  const receipt = selectedPathReceipt(session);
  const data = receipt ? receiptPathMapData(receipt) : null;
  const signature = data
    ? `${receipt.observerKey}:${data.points.map((point) => `${point.index}@${point.lat},${point.lon}`).join('|')}`
    : '';
  if (signature === state.map.pathSignature) {
    return data ? { ...data, signature } : null;
  }
  if (state.map.pathLayer) {
    state.map.pathLayer.remove();
    state.map.pathLayer = null;
  }
  state.map.pathSignature = signature;
  if (!data) {
    return null;
  }
  const pane = ensureReceiptPathPane(mapInstance);
  const group = window.L.layerGroup();
  for (const leg of data.legs) {
    const line = window.L.polyline([[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]], {
      pane,
      className: `receipt-path-leg${leg.skipped > 0 ? ' receipt-path-leg--gap' : ''}`,
      interactive: leg.skipped > 0,
    });
    if (leg.skipped > 0) {
      line.bindTooltip(`${leg.skipped} hop${leg.skipped === 1 ? '' : 's'} without a known position`, { sticky: true });
    }
    group.addLayer(line);
  }
  data.points.forEach((point, index) => {
    const role = point.isTerminal
      ? 'Observer'
      : (index === 0 ? 'First repeater in the path' : 'Repeater');
    const marker = window.L.circleMarker([point.lat, point.lon], {
      pane,
      radius: point.isTerminal ? 7 : 5,
      className: `receipt-path-point${point.isTerminal ? ' receipt-path-point--observer' : ''}${
        index === 0 ? ' receipt-path-point--first' : ''}`,
    });
    marker.bindTooltip(`${role}: ${point.label}`);
    group.addLayer(marker);
  });
  group.addTo(mapInstance);
  state.map.pathLayer = group;
  return { ...data, signature };
}

function renderObserverMap(session) {
  // The region filter sits above this map and scopes the map, the observer list
  // and the reports list together, so it renders here rather than inside any one
  // of the panels it governs.
  renderRegionFilter(session);
  renderRegionLocate();

  const locatedObservers = mapKnownObservers(session);
  const mapInstance = ensureObserverMap();
  const regionScope = activeRegionScopeLabel();

  if (locatedObservers.length > 0) {
    const reached = locatedObservers.filter((observer) => observer.seen).length;
    ui.mapObserverNote.textContent = regionScope
      ? `${reached}/${locatedObservers.length} mapped observers reached in ${regionScope}.`
      : `${reached}/${locatedObservers.length} mapped observers reached.`;
  } else if (regionScope) {
    ui.mapObserverNote.textContent = `No mapped observers in ${regionScope}.`;
  } else {
    ui.mapObserverNote.textContent =
      'No observer coordinates yet. The map stays live and will populate as coordinates arrive.';
  }
  // A region with no located observers is a filter result, not missing data, so
  // it must not show the "we have not learned coordinates yet" explainer.
  ui.mapEmpty.classList.toggle('hidden', locatedObservers.length > 0 || Boolean(regionScope));

  if (!mapInstance || !window.L) {
    return;
  }

  if (!state.map.layer || state.map.layerTheme !== state.uiTheme) {
    const nextLayer = currentTileLayer();
    if (state.map.layer) {
      mapInstance.removeLayer(state.map.layer);
    }
    state.map.layer = nextLayer;
    state.map.layerTheme = state.uiTheme;
    if (nextLayer) {
      nextLayer.addTo(mapInstance);
    }
  }

  // Outlines are drawn before the markers so the pane exists below them, and the
  // fetch is fire-and-forget: it re-enters this function once geometry lands.
  ensureRegionBoundaries();
  renderRegionBoundaries(mapInstance, session);
  ensureRegionDetail();

  const activeKeys = new Set(locatedObservers.map((observer) => observer.key));
  for (const [key, marker] of state.map.markers.entries()) {
    if (!activeKeys.has(key)) {
      marker.remove();
      state.map.markers.delete(key);
    }
  }

  const bounds = [];
  for (const observer of locatedObservers) {
    const latLng = [observer.lat, observer.lon];
    bounds.push(latLng);
    let marker = state.map.markers.get(observer.key);
    const seen = Boolean(observer.seen);
    if (!marker) {
      marker = window.L.marker(latLng, { icon: markerIcon(observer) }).addTo(mapInstance);
      marker.healthSeen = seen;
      state.map.markers.set(observer.key, marker);
    } else {
      // Every poll used to setLatLng + setIcon + bindPopup on every marker, which
      // rebuilt each icon's DOM (restarting its CSS animation) and its popup
      // every five seconds whether or not anything had changed. Touch a marker
      // only when its position, heard state or popup text actually moved.
      const current = marker.getLatLng();
      if (current.lat !== observer.lat || current.lng !== observer.lon) {
        marker.setLatLng(latLng);
      }
      if (marker.healthSeen !== seen) {
        marker.setIcon(markerIcon(observer));
        marker.healthSeen = seen;
      }
    }
    const popupHtml = `
      <strong>${escapeHtml(observer.label)}</strong><br>
      ${seen ? 'Heard by this check' : 'Not heard by this check'}<br>
      ${escapeHtml(observer.hash || '--')} · ${escapeHtml(observer.shortKey)}
    `;
    if (marker.healthPopupHtml !== popupHtml) {
      marker.bindPopup(popupHtml);
      marker.healthPopupHtml = popupHtml;
    }
  }

  // A region chip frames the region's outline; everything else frames the
  // plotted observers. boundsKey names the frame, so it only refits when the
  // frame itself changes: narrowing the filter or switching region refits, a
  // poll that adds or ages out an observer inside a selected region does not.
  // A drawn receipt path takes the frame while it is shown; clearing it changes
  // boundsKey back, which refits to the region or observers it replaced.
  const pathData = renderReceiptPathLayer(mapInstance, session);
  const regionFrame = selectedRegionFrame();
  const pathFrame = pathData ? pathData.points.map((point) => [point.lat, point.lon]) : null;
  const frame = pathFrame || regionFrame || (bounds.length > 0 ? bounds : null);
  const boundsKey = pathFrame
    ? `path:${pathData.signature}`
    : regionFrame
      ? `region:${state.selectedPlace}`
      : locatedObservers.map((observer) => observer.key).join('|');
  if (frame && boundsKey !== state.map.boundsKey) {
    mapInstance.fitBounds(frame, { padding: [26, 26], maxZoom: 10 });
    state.map.boundsKey = boundsKey;
  } else if (!frame && !regionScope && state.map.boundsKey !== '__empty__') {
    // Only reset to the world view when there is genuinely nothing to show.
    // Filtering to a region with no coordinates must not yank the viewport out
    // to zoom 2 - the user is still looking at the area they selected.
    mapInstance.setView([20, 0], 2);
    state.map.boundsKey = '__empty__';
  }
  window.setTimeout(() => {
    mapInstance.invalidateSize();
  }, 0);
}

function ordinalLabel(n) {
  const value = Number(n);
  if (!Number.isInteger(value) || value < 1) {
    return '';
  }
  const suffix = value % 100 >= 11 && value % 100 <= 13
    ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' })[value % 10] || 'th';
  return `${value}${suffix}`;
}

// A receipt's prefix follows the same rule as the observer list: the node's own
// confirmed advert width, falling back to the global display default. The server
// recomputes observerHash at serialize time, so this is only the client-side
// fallback for a payload that predates the field.
function receiptHashPrefix(receipt) {
  const explicit = String(receipt?.observerHash || '').trim().toUpperCase();
  const wanted = Math.max(1, Math.min(3, Number(receipt?.observerHashBytes) || 0)) * 2;
  if (Number.isInteger(wanted) && wanted > 0 && explicit.length >= wanted) {
    return explicit.slice(0, wanted);
  }
  if (explicit) {
    return explicit;
  }
  return observerHashPrefix(receipt?.observerKey, {
    hashBytes: receipt?.observerHashBytes ?? null,
  });
}

// The Timeline sub-panel used to repeat every observer as a chip, then the cards
// repeated them again with detail. This folds the chip's ordering, offset, and
// clock time into the card itself, above the Signal bar.
function receiptArrivalIndex(receipts) {
  const timed = receipts
    .filter((receipt) => Number(receipt?.firstSeenAt) > 0)
    .sort((left, right) => left.firstSeenAt - right.firstSeenAt);
  const firstSeenAt = timed.length > 0 ? timed[0].firstSeenAt : 0;
  const lastSeenAt = timed.length > 0 ? timed[timed.length - 1].firstSeenAt : 0;
  const spread = Math.max(0, lastSeenAt - firstSeenAt);
  const byKey = new Map();
  timed.forEach((receipt, index) => {
    const delta = Math.max(0, receipt.firstSeenAt - firstSeenAt);
    byKey.set(receipt.observerKey, {
      order: index + 1,
      total: timed.length,
      orderLabel: `${ordinalLabel(index + 1)} of ${timed.length}`,
      delta,
      offsetLabel: delta === 0 ? 'First receipt' : `+${formatElapsed(delta)} after first`,
      timeLabel: formatTime(receipt.firstSeenAt),
      position: spread > 0 ? (delta / spread) * 100 : 0,
    });
  });
  return { byKey, firstSeenAt, spread, count: timed.length };
}

function receiptArrivalMarkup(arrival) {
  if (!arrival) {
    return '';
  }
  const showTrack = arrival.total > 1;
  return `
    <div class="receipt-arrival">
      <div class="receipt-arrival__copy">
        <strong>${escapeHtml(arrival.offsetLabel)}</strong>
        <span>${escapeHtml(arrival.timeLabel)}</span>
      </div>
      ${showTrack
        ? `<div class="receipt-arrival__track" role="presentation">
             <span class="receipt-arrival__fill" style="width: ${arrival.position}%;"></span>
             <span class="receipt-arrival__dot" style="left: ${Math.min(99, Math.max(1, arrival.position))}%;"></span>
           </div>`
        : ''}
    </div>
  `;
}

// Hops for one receipt, newest serialization first. Older cached or shared
// payloads predate pathHops and carry only the raw hashes, so fall back to those
// rather than rendering an empty path.
function receiptPathHopList(receipt) {
  if (Array.isArray(receipt?.pathHops) && receipt.pathHops.length > 0) {
    return receipt.pathHops;
  }
  return (Array.isArray(receipt?.path) ? receipt.path : [])
    .filter(Boolean)
    .map((hash) => ({
      hash: String(hash), label: String(hash), resolved: false, hasLocation: false, isTerminal: false,
    }));
}

function receiptHopIsNamed(hop) {
  return Boolean(hop?.resolved) && hop.label !== hop.hash;
}

// Shared by the card and the drawer so both name the same repeaters.
function receiptPathMarkup(receipt) {
  const hops = receiptPathHopList(receipt);
  if (hops.length === 0) {
    return '<span class="receipt-path__hop receipt-path__hop--empty">No path data</span>';
  }
  return hops
    .map((hop) => {
      const named = receiptHopIsNamed(hop);
      return `<span class="receipt-path__hop${named ? '' : ' receipt-path__hop--unresolved'}"${
        named ? ` title="${escapeHtml(`${hop.label} \u00b7 ${hop.hash}`)}"` : ' title="This hash does not match exactly one known node, so the repeater cannot be named."'
      }><span class="receipt-path__name">${externalLinkMarkup(
        named ? buildCoreScopeNodeLink(hop.key) : '',
        escapeHtml(hop.label),
        'corescope-link',
        `Open ${hop.label} in CoreScope`,
      )}</span>${
        named ? `<span class="receipt-path__hash">${escapeHtml(hop.hash)}</span>` : ''
      }</span>`;
    })
    .join('');
}

// The same text, linked to that node's CoreScope page when the prefix resolved
// to exactly one node. An unresolved or ambiguous hop stays plain text -- there
// is no single node page to send anyone to.
function receiptHopLabelMarkup(label, hash, key) {
  const text = receiptHopLabel(label, hash);
  const url = buildCoreScopeNodeLink(key);
  return externalLinkMarkup(url, escapeHtml(text), 'corescope-link', url ? `Open ${text} in CoreScope` : '');
}

// Plain-text form for the drawer's monospace blocks.
function receiptPathText(receipt) {
  const hops = receiptPathHopList(receipt);
  if (hops.length === 0) {
    return 'No path data';
  }
  return hops
    .map((hop) => (receiptHopIsNamed(hop) ? `${hop.label} (${hop.hash})` : hop.hash))
    .join(' \u2192 ');
}

// A repeater reads as "Name (HASH)" so the leg list carries the raw prefix
// itself. That is what let the separate chip row above it go: the same repeaters
// were being listed twice, once as prefixed chips and again as leg endpoints.
function receiptHopLabel(label, hash) {
  const name = String(label || '').trim();
  const code = String(hash || '').trim();
  if (!name) {
    return code;
  }
  if (!code || name.toUpperCase() === code.toUpperCase()) {
    return name;
  }
  return `${name} (${code})`;
}

// "285 mi" must never break between the number and the unit, which it did at
// 390px in the header line. A non-breaking space is cheaper and more reliable
// here than a nowrap wrapper, which would also inherit the muted span styling.
function unbreakableDistance(text) {
  return String(text || '').replace(/ /g, '\u00a0');
}

// True when the leg list can stand in for the chip row: every leg endpoint is
// named with its prefix, so the chips would only repeat them.
function receiptHasDistanceLegs(receipt) {
  return Boolean(String(receipt?.pathDistanceText || '').trim())
    && Array.isArray(receipt?.pathDistanceSegments)
    && receipt.pathDistanceSegments.length > 0;
}

// One leg per line, so a multi-hop estimate can be read hop by hop instead of as
// one wrapped paragraph.
function receiptDistanceMarkup(receipt) {
  const distanceText = String(receipt?.pathDistanceText || '').trim();
  const segments = Array.isArray(receipt?.pathDistanceSegments) ? receipt.pathDistanceSegments : [];
  const note = String(receipt?.pathDistanceNote || '').trim();
  if (!distanceText) {
    // State why there is no number rather than borrowing an unrelated one.
    return note
      ? `<div class="receipt-distance receipt-distance--unknown"><span>${escapeHtml(note)}</span></div>`
      : '';
  }
  const legs = segments
    .map((segment, index) => {
      // Its own subordinate line rather than trailing the distance. Appended to
      // the value it made the leg wrap at 390px, and a wrapped value reads as a
      // separate unnumbered row instead of as part of this leg.
      const skipped = segment.estimated ? Number(segment.skippedHopCount) || 0 : 0;
      // "no location", not "unknown": position is the only thing that puts a hop
      // here, and some of them are perfectly well named. Named ones read as
      // "Name (HASH)" like every other repeater; the rest show the bare hash,
      // which is all that is known about them. Capped at three so one long gap
      // cannot turn a leg into a paragraph. Older payloads carry no identities,
      // in which case the count still stands on its own.
      const skippedHops = Array.isArray(segment.skippedHops) ? segment.skippedHops : [];
      const named = skippedHops.slice(0, 3)
        .map((hop) => receiptHopLabelMarkup(hop.label, hop.hash, hop.key));
      const overflow = skippedHops.length - named.length;
      const skipList = named.length > 0
        ? `: ${named.join(', ')}${overflow > 0 ? escapeHtml(` and ${overflow} more`) : ''}`
        : '';
      const skipMarkup = skipped > 0
        ? `<span class="receipt-distance__leg-note">${
          escapeHtml(`via ${skipped} hop${skipped === 1 ? '' : 's'} with no location`)
        }${skipList}</span>`
        : '';
      return `
        <span class="receipt-distance__leg">
          <span class="receipt-distance__leg-index">${index + 1}.</span>
          <span class="receipt-distance__leg-route">${
        receiptHopLabelMarkup(segment.fromLabel, segment.fromHash, segment.fromKey)
      } to ${
        receiptHopLabelMarkup(segment.toLabel, segment.toHash, segment.toKey)
      }</span>
          <span class="receipt-distance__leg-value">${escapeHtml(unbreakableDistance(segment.distanceText))}</span>
          ${skipMarkup}
        </span>
      `;
    })
    .join('');
  const legCount = segments.length;
  // Legs are the lines drawn; spanned hops are what the mileage crosses. They
  // differ only when a hop in between had no position, so both are shown only
  // then -- "14 legs / 14 hops" would be noise on a fully resolved path. Older
  // payloads predate the field, so fall back to the leg count.
  const spannedHopCount = Number(receipt?.pathSpannedHopCount) || legCount;
  // Each count is held together the same way the distance is: at 390px the
  // header broke between "16" and "hops". The slash stays a legal break point.
  const countText = spannedHopCount > legCount
    ? `${unbreakableDistance(`${legCount} leg${legCount === 1 ? '' : 's'}`)} / ${unbreakableDistance(`${spannedHopCount} hops`)}`
    : unbreakableDistance(`${legCount} hop${legCount === 1 ? '' : 's'}`);
  const crow = receipt?.pathCrowFlies;
  const crowText = String(crow?.distanceText || '').trim();
  // Straight-line end to end, stated once above the legs because it describes
  // the whole path rather than any one leg. Older cached or shared payloads
  // predate the field and simply omit the line.
  const crowMarkup = crowText
    ? `<span class="receipt-distance__crow" title="${escapeHtml(`Straight-line distance from ${
      receiptHopLabel(crow.fromLabel, crow.fromHash)
    } to ${receiptHopLabel(crow.toLabel, crow.toHash)}`)}">End to end ${escapeHtml(unbreakableDistance(crowText))} as the crow flies</span>`
    : '';
  // "at least", not a bare total: every leg is a straight line between two
  // located hops, which is the shortest distance those two ends can be apart.
  // Any real routing between them, and any hop we could not place, only adds.
  // So the number is a floor on the distance covered, never an over-estimate.
  return `
        <div class="receipt-distance">
          <strong>Estimated path over ${countText} \u00b7 at least ${escapeHtml(unbreakableDistance(distanceText))}</strong>
          ${crowMarkup}
          ${legs || '<span>Distance estimated from known node positions.</span>'}
        </div>
      `;
}

// The count on this control is the point of it: "Not heard 12" answers "who is
// missing" without scrolling to the end of the list, which is the one thing the
// observer chips did better than a list ordered by arrival.
function renderReceiptHeardFilter(heardCount, unheardCount) {
  if (!ui.receiptsFilter) {
    return;
  }
  const total = heardCount + unheardCount;
  if (total === 0) {
    ui.receiptsFilter.classList.add('hidden');
    ui.receiptsFilter.innerHTML = '';
    return;
  }
  ui.receiptsFilter.classList.remove('hidden');
  ui.receiptsFilter.innerHTML = '';

  const options = [
    {
      key: 'all',
      label: 'All',
      count: total,
      status: unheardCount === 0 ? 'all' : (heardCount === 0 ? 'none' : 'some'),
      title: 'Every observer in this view, heard or not.',
    },
    {
      key: 'heard',
      label: 'Heard',
      count: heardCount,
      status: 'all',
      title: 'Only observers that reported this message.',
    },
    {
      key: 'unheard',
      label: 'Not heard',
      count: unheardCount,
      status: 'none',
      title: 'Only observers that did not report this message.',
    },
  ];

  for (const option of options) {
    const active = state.receiptHeardFilter === option.key;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `region-btn receipts-filter__btn${active ? ' active' : ''}`;
    btn.setAttribute('aria-pressed', String(active));
    btn.title = option.title;

    const dot = document.createElement('span');
    // A zero count has no status to report, so it goes gray rather than claiming
    // green for "nothing was heard".
    dot.className = `region-btn__status region-btn__status--${option.count === 0 ? 'unknown' : option.status}`;
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = option.label;
    btn.appendChild(label);

    const count = document.createElement('span');
    count.className = 'region-btn__count';
    count.textContent = String(option.count);
    btn.appendChild(count);

    btn.addEventListener('click', () => {
      state.receiptHeardFilter = option.key;
      render();
    });
    ui.receiptsFilter.appendChild(btn);
  }
}

function commitReceiptList(list) {
  if (ui.receipts.innerHTML === list.innerHTML) {
    return;
  }
  ui.receipts.replaceChildren(...list.childNodes);
}

// MeshCore routing scope, recorded per heard copy by the server (lib/meshcore-scopes.js).
// Stored names carry the key's leading '#'; MeshCore clients show them without it.
function meshcoreScopeLabel(scope) {
  const names = (Array.isArray(scope?.names) ? scope.names : [])
    .map((name) => String(name).replace(/^#/, ''));
  switch (scope?.state) {
    case 'known': return names[0] || 'Unavailable';
    case 'ambiguous': return `Ambiguous: ${names.join(' or ')}`;
    case 'unscoped': return 'Unscoped';
    case 'unknown': return 'Scoped, name not listed';
    case 'disabled': return 'Scoped (name matching off)';
    case 'not-present': return 'Not recorded';
    default: return 'Unavailable';
  }
}

function receiptScopeLabels(receipt) {
  const scopes = Array.isArray(receipt?.meshcoreScopes) && receipt.meshcoreScopes.length
    ? receipt.meshcoreScopes
    : [{ state: 'not-present', names: [] }];
  return [...new Set(scopes.map(meshcoreScopeLabel))];
}

// One line for the whole code: each distinct label with the number of observers whose
// copies carried it, most common first. An observer heard under two scopes counts in both.
function meshcoreScopeSummary(receipts) {
  if (!receipts.length) return 'No receipts yet.';
  const counts = new Map();
  for (const receipt of receipts) {
    for (const label of receiptScopeLabels(receipt)) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label} (${count})`)
    .join(' · ');
}

function renderMeshcoreScopes(session) {
  const element = document.querySelector('#meshcore-scopes');
  if (!element) return;
  element.textContent = meshcoreScopeSummary(Array.isArray(session?.receipts) ? session.receipts : []);
}

// Passive repeater scope evidence (bayarea.18): network-wide, not per code. The list
// itself is the public JSON route; this line only counts it.
function renderScopeEvidence() {
  const element = document.querySelector('#scope-evidence');
  const evidence = state.snapshot?.scopeEvidence;
  if (!element || !evidence) return;
  const days = Number(evidence.retentionDays) || 7;
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  element.textContent = `last ${plural(days, 'day')}: ${Number(evidence.scopedAdvertisers) || 0} of `
    + `${plural(Number(evidence.advertisers) || 0, 'advertiser')} heard with a default scope · `
    + `${plural(Number(evidence.forwarderHops) || 0, 'path hop')} heard forwarding scoped traffic`;
}

// Regional channel (bayarea.19): the scope the channel name says was meant, against the
// scopes the copies were heard under. The server classifies (compareIntendedScope).
function scopeCheckText(check) {
  const intended = String(check.intended || '').replace(/^#/, '');
  const counts = check.counts || {};
  const plural = (count) => `${count} ${count === 1 ? 'copy' : 'copies'}`;
  const matched = (counts.asIntended || 0) + (counts.ambiguous || 0);
  const ambiguousNote = counts.ambiguous ? `, ${counts.ambiguous} through an ambiguous match` : '';
  const misses = [];
  if (counts.unscoped) misses.push(`${plural(counts.unscoped)} unscoped`);
  if (counts.other) {
    const names = (check.otherNames || []).map((name) => String(name).replace(/^#/, ''));
    misses.push(`${plural(counts.other)} under ${names.join(' or ') || 'another scope'}`);
  }
  switch (check.verdict) {
    case 'as-intended': return `${intended}, heard as intended (${plural(matched)}${ambiguousNote})`;
    case 'mixed': return `${intended}, mixed: ${plural(matched)} as intended${ambiguousNote}, ${misses.join(', ')}`;
    case 'not-as-intended': return `${intended}, not as intended: ${misses.join(', ')}`;
    case 'unrecorded': return `${intended}, scope not recorded for the heard copies`;
    default: return `${intended}, waiting for receipts`;
  }
}

function renderScopeCheck(session) {
  const note = document.querySelector('#scope-check-note');
  const element = document.querySelector('#scope-check');
  if (!note || !element) return;
  const check = session?.scopeCheck;
  note.hidden = !check;
  if (!check) return;
  element.textContent = scopeCheckText(check);
  note.dataset.verdict = check.verdict;
}

function renderRegionalChannelNote(snapshot) {
  const note = document.querySelector('#regional-channel-note');
  if (!note) return;
  const regional = snapshot?.testChannel?.regional;
  const base = snapshot?.testChannel?.name || '';
  note.hidden = !regional?.names?.length || !base;
  if (note.hidden) return;
  const names = regional.names;
  const example = names.find((name) => name.startsWith(`slo-`)) || names[0];
  document.querySelector('#regional-channel-pattern').textContent = `#region-${base}`;
  document.querySelector('#regional-channel-example').textContent = `#${example}`;
  const suffix = `-${base}`;
  document.querySelector('#regional-channel-names').textContent = names
    .map((name) => (name.endsWith(suffix) ? name.slice(0, -suffix.length) : name))
    .join(', ');
}

function renderReceipts(session) {
  renderMeshcoreScopes(session);
  renderScopeCheck(session);
  renderScopeEvidence();
  const allReceipts = Array.isArray(session?.receipts) ? session.receipts : [];
  // Built off-DOM and committed only when the markup changed: the list was
  // emptied and rebuilt on every five-second poll and every socket snapshot,
  // even while it sat collapsed inside Additional Information.
  const list = document.createElement('div');

  // Roster framing, inherited from the deleted Observers panel. Set before the
  // no-session guard so it is populated on a cold load: this sentence describes
  // the scoring target, which exists whether or not a code has been sent. The
  // "Region filter showing N of M listed" suffix it used to carry is gone - the
  // narrowing note at the end of the list already says that, and saying it twice
  // in one panel was the redundancy that made merging worth doing.
  ui.observerAllowlistNote.textContent = observerTargetSummary();

  // With no session there is nothing to report on yet. The roster could be
  // rendered as all-not-heard here, but a wall of empty cards before a code has
  // even been sent is noise.
  if (!session) {
    renderReceiptHeardFilter(0, 0);
    ui.receiptsEmpty.classList.remove('hidden');
    ui.receiptsEmpty.textContent = 'No observer reports yet.';
    commitReceiptList(list);
    return;
  }

  // One row per rostered observer with its receipt attached when there is one,
  // rather than one row per receipt. This is what lets the list say "not heard"
  // at all, and it means a row can no longer vanish because its observer fell
  // out of observerDirectory(): the roster row carries its own region.
  const receiptByKey = new Map(allReceipts.map((receipt) => [receipt.observerKey, receipt]));
  const { all, targeted, seenByKey } = mergedObserverRoster(session);
  const heardStateOf = (observer) => observerHeardState(observer, targeted, seenByKey);

  // Arrival order is a fact about the session, so it stays computed over every
  // receipt - a filtered view still says "2nd of 26", not "1st of 4".
  const arrivals = receiptArrivalIndex(allReceipts);

  // Visibility only, and now tested against the roster record itself rather than
  // a directory entry that may be missing.
  const inRegion = observersMatchingRegionFilter(all);
  const heardCount = inRegion.filter((observer) => heardStateOf(observer) === 'heard').length;
  renderReceiptHeardFilter(heardCount, inRegion.length - heardCount);

  const groupRank = { heard: 0, unheard: 1, unscored: 2 };
  const rows = inRegion
    .filter((observer) => {
      if (state.receiptHeardFilter === 'heard') {
        return heardStateOf(observer) === 'heard';
      }
      if (state.receiptHeardFilter === 'unheard') {
        return heardStateOf(observer) !== 'heard';
      }
      return true;
    })
    // Heard first in arrival order, because that ordering is the story of the
    // packet spreading outwards. Not heard next, then not scored, each
    // alphabetical: neither group has an arrival time to sort on.
    .sort((left, right) => {
      const leftState = heardStateOf(left);
      const byGroup = groupRank[leftState] - groupRank[heardStateOf(right)];
      if (byGroup !== 0) {
        return byGroup;
      }
      if (leftState === 'heard') {
        return (arrivals.byKey.get(left.key)?.order || 0) - (arrivals.byKey.get(right.key)?.order || 0);
      }
      return observerDisplayLabel(left).localeCompare(observerDisplayLabel(right));
    });

  ui.receiptsEmpty.classList.toggle('hidden', rows.length > 0);
  // Distinguish "nothing arrived" from "nothing arrived here" from "the toggle
  // is hiding everything", otherwise an empty list reads as a failed session.
  if (all.length === 0) {
    ui.receiptsEmpty.textContent = 'No observers yet.';
  } else if (inRegion.length === 0) {
    ui.receiptsEmpty.textContent = 'No observers in this region. The region chips change what is listed here; they do not change what this code is scored against.';
  } else if (state.receiptHeardFilter === 'unheard') {
    ui.receiptsEmpty.textContent = 'Every observer in this view heard the message.';
  } else {
    ui.receiptsEmpty.textContent = 'No observer in this view heard the message.';
  }

  // Say so when the list is narrowed, otherwise four cards out of thirty-eight
  // reads as a session that only ever targeted four observers.
  //
  // The heard count needs its own denominator and scope. "Showing 12 of 38
  // observers, 26 heard" was wrong in the Not heard view: it put 26 next to 12
  // rows of which none were heard, reading as though 26 of the 12 shown had
  // heard. The heard tally describes the region, not the rows on screen.
  if (rows.length > 0 && rows.length < all.length) {
    const scope = activeRegionScopeLabel();
    const note = document.createElement('p');
    note.className = 'small-note receipts-filter-note';
    note.textContent = `Showing ${rows.length} of ${all.length} observers. `
      + `${heardCount} of ${inRegion.length} heard${scope ? ` in ${scope}` : ''}.`;
    list.appendChild(note);
  }

  // One visible line ahead of the not-scored cards (1.1.0). The tooltip that
  // explained them is invisible on a phone, so the explanation lives in the list.
  let unscoredNoteShown = false;
  for (const observer of rows) {
    const receipt = receiptByKey.get(observer.key) || null;
    const heardState = heardStateOf(observer);
    if (heardState === 'unscored' && !unscoredNoteShown) {
      const unscoredNote = document.createElement('p');
      unscoredNote.className = 'small-note receipts-unscored-note';
      unscoredNote.textContent = UNSCORED_EXPLANATION;
      list.appendChild(unscoredNote);
      unscoredNoteShown = true;
    }
    const card = document.createElement('article');
    card.className = `receipt-card${receipt ? '' : ' receipt-card--quiet'}`;

    const statusTone = heardState === 'heard' ? 'all' : (heardState === 'unheard' ? 'none' : 'unknown');
    const statusTitle = {
      heard: 'Heard by this check',
      unheard: 'Not heard by this check',
      unscored: UNSCORED_EXPLANATION,
    }[heardState];
    // Textual, not just a coloured dot, so the state is available to a screen
    // reader. The heard card keeps its arrival label in the same slot.
    const stateLabel = heardState === 'heard'
      ? (arrivals.byKey.get(observer.key)?.orderLabel || '')
      : (heardState === 'unheard' ? 'Not heard' : 'Not scored');
    // Prefer the receipt's own hash width where there is a receipt, so heard
    // cards render exactly as before; fall back to the roster otherwise.
    const labelText = receipt ? receipt.observerLabel : observerDisplayLabel(observer);
    const hashText = receipt ? receiptHashPrefix(receipt) : (observer.hash || '--');
    const shortText = receipt ? receipt.observerShortKey : (observer.shortKey || '--');
    // From the roster, not from a directory lookup, so this line can no longer
    // silently disappear for an observer the directory has dropped.
    const detailLine = observerDetailLine(observer);
    const modeNote = observerHashModeNote(observer);
    // The observer's own CoreScope page, not the node page: same public key,
    // different route, and the observer page is the one that carries uptime,
    // packet counts and clock skew for the receiving station. Every observer
    // gets the link, heard or not -- the point of the quiet card is that the
    // station is worth looking at. No link when CORESCOPE_URL is unset, or when
    // the key is not a full public key.
    const observerLink = buildCoreScopeObserverLink(observer.key);
    const labelMarkup = externalLinkMarkup(
      observerLink,
      escapeHtml(labelText),
      'corescope-link',
      `Open ${labelText} in CoreScope`,
    );

    const head = `
      <div class="receipt-head">
        <div class="receipt-ident">
          <h3 class="receipt-title">
            <span class="region-btn__status region-btn__status--${statusTone}" aria-hidden="true" title="${escapeHtml(statusTitle)}"></span>
            ${labelMarkup}
          </h3>
          <div class="receipt-hash">${escapeHtml(hashText)} · ${escapeHtml(shortText)}</div>
          ${detailLine
            ? `<div class="small-note observer-detail">${escapeHtml(detailLine)}${
              modeNote
                ? ` \u00b7 <span class="observer-detail__mode">${escapeHtml(modeNote)}</span>`
                : ''
            }</div>`
            : ''}
        </div>
        <div class="small-note receipt-state">${escapeHtml(stateLabel)}</div>
      </div>
    `;

    // A not-heard observer has no arrival time, no RSSI/SNR, no latency and no
    // path. Rendering those as 0% or n/a would invent measurements that do not
    // exist, so the quiet card stops after the head.
    if (!receipt) {
      card.innerHTML = head;
      list.appendChild(card);
      continue;
    }

    const arrival = arrivals.byKey.get(receipt.observerKey) || {
      orderLabel: '',
      offsetLabel: 'Time not recorded',
      timeLabel: '--',
      position: 0,
      total: 1,
    };
    const arrivalMarkup = receiptArrivalMarkup(arrival);
    const signal = receiptSignalScore(receipt);
    const signalTone = scoreTone(signal);
    const pathMarkup = receiptPathMarkup(receipt);
    const distanceMarkup = receiptDistanceMarkup(receipt);
    // No path distance here. It used to sit in this line as `Path 285 mi`, read
    // from the same receipt.pathDistanceText that the estimate block below
    // prints as "at least 285 mi", so the same number appeared twice on every
    // card. The estimate block is the one that explains itself -- hop count,
    // per-leg breakdown, the crow-flies comparison, and "at least" rather than
    // a bare total -- so the bare copy is the one that goes.
    const metrics = [
      receipt.rssi != null ? `RSSI ${receipt.rssi}` : '',
      receipt.snr != null ? `SNR ${receipt.snr}` : '',
      receipt.duration != null ? `${receipt.duration} ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    card.innerHTML = `
      ${head}
      <p class="receipt-meta">
        Heard ${receipt.count} time${receipt.count === 1 ? '' : 's'}${metrics ? ` · ${metrics}` : ''}
      </p>
      <p class="receipt-meta receipt-scope">Scope: ${escapeHtml(receiptScopeLabels(receipt).join(' · '))}</p>
      ${arrivalMarkup}
      <div class="receipt-meter-grid">
        <div class="receipt-meter">
          <span>Signal</span>
          <div class="meter-track ${signalTone}">
            <span style="width: ${Number.isFinite(signal) ? signal : 12}%;"></span>
          </div>
          <strong>${Number.isFinite(signal) ? `${signal}%` : '--'}</strong>
        </div>
        <div class="receipt-meter">
          <span>Latency</span>
          <div class="meter-track ${receipt.duration != null && receipt.duration > 1500 ? 'warning' : 'good'}">
            <span style="width: ${receipt.duration != null ? clamp((Number(receipt.duration) / 3000) * 100, 12, 100) : 20}%;"></span>
          </div>
          <strong>${receipt.duration != null ? `${receipt.duration} ms` : 'n/a'}</strong>
        </div>
      </div>
      ${receiptHasDistanceLegs(receipt) ? '' : `<div class="receipt-path">${pathMarkup}</div>`}
      ${distanceMarkup}
      ${receiptPathToggleMarkup(receipt, session)}
    `;
    list.appendChild(card);
  }
  commitReceiptList(list);
}

// Offered only when receiptPathMapData can draw something honest, so a 1-byte
// or mostly-unlocated path gets no button rather than a misleading map.
function receiptPathToggleMarkup(receipt, session) {
  const data = receiptPathMapData(receipt);
  if (!data) {
    return '';
  }
  const active = state.receiptPath.key === receipt.observerKey
    && state.receiptPath.sessionId === (session?.id || '');
  const note = active
    ? `<p class="small-note receipt-map-note">On the map: straight lines between the ${data.points.length} of ${
      data.hopCount} hops with a known position, not the radio path. Dashed legs pass through hops with no known position. The sender's position is not part of the path.</p>`
    : '';
  return `
    <div class="receipt-map">
      <button class="ghost-button receipt-map-button" type="button" data-receipt-path="${escapeHtml(receipt.observerKey)}" aria-pressed="${active ? 'true' : 'false'}">${
        active ? 'Hide path on map' : 'Show path on map'}</button>
      ${note}
    </div>
  `;
}

function toggleReceiptPath(observerKey) {
  const session = currentSession();
  const selection = state.receiptPath;
  const turningOn = !(selection.key === observerKey && selection.sessionId === (session?.id || ''));
  selection.key = turningOn ? observerKey : '';
  selection.sessionId = turningOn ? (session?.id || '') : '';
  render();
  // The map sits above the list, so on a phone the path would be drawn
  // off-screen. Bring it into view only when it is not already visible.
  if (turningOn && ui.observerMap) {
    const rect = ui.observerMap.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      ui.observerMap.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

// The code in each row links to that check's share page in a new tab, like
// every other link on the page. The list is this tab's own sessionStorage
// (upsertTrackedSession runs only when this browser mints a code), so a row
// is only ever a check the person at this browser ran; nothing here looks a
// result up by code or lists anyone else's.
let lastHistoryMarkup = null;

function renderHistory(sessions) {
  const markup = sessions.length === 0
    ? '<div class="empty-state compact">No previous checks in this browser session.</div>'
    : sessions.map((session) => {
      const shareUrl = session.shareUrl || `/share/${encodeURIComponent(session.id)}`;
      return `
      <article class="history-item" data-session-id="${escapeHtml(session.id)}">
        <div>
          <div class="history-code">${externalLinkMarkup(shareUrl, escapeHtml(session.code), 'hash-link', `Open the result for ${session.code} in a new tab`)}</div>
          <p>${session.observedCount}/${session.expectedCount} observers · ${escapeHtml(historyHealthLabel(session))}</p>
        </div>
        <div>
          <strong class="${healthClass(session.healthLabel)}">${historyHealthScore(session)}</strong>
          <p>${formatTime(session.createdAt)}</p>
        </div>
      </article>
    `;
    }).join('');
  // render() runs on every live update; rebuilding unchanged rows would swap
  // the link out between press and release and swallow the tap.
  if (lastHistoryMarkup === markup) return;
  lastHistoryMarkup = markup;
  ui.sessionHistory.innerHTML = markup;
}

function drawerStat(label, value) {
  return `
    <div class="drawer-stat">
      <span class="meta-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function drawerListItem(title, detail, meta = '') {
  return `
    <div class="drawer-list__item">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
      ${meta ? `<div class="small-note">${escapeHtml(meta)}</div>` : ''}
    </div>
  `;
}

function buildDrawerContent() {
  const snapshot = state.snapshot;
  const session = currentSession();
  const directory = selectableObservers();
  const mappedObservers = mapKnownObservers(session);
  const receipts = Array.isArray(session?.receipts) ? session.receipts : [];
  const historySessions = state.trackedSessionIds
    .map((id) => state.sessions.get(id))
    .filter(Boolean);
  const transport = snapshot ? transportSummary(snapshot) : null;
  const signal = signalSummary(session);
  const latency = latencySummary(session);

  switch (state.drawer.kind) {
    case 'session':
      return {
        meta: 'Command Sequence',
        title: session ? `Session ${session.code}` : 'Session Control',
        body: `
          <section class="drawer-card">
            <h3>Session Summary</h3>
            <div class="drawer-stat-grid">
              ${drawerStat('Status', session?.status?.toUpperCase() || 'IDLE')}
              ${drawerStat('Share Window', session ? formatDateTime(session.resultExpiresAt) : retentionNote())}
              ${drawerStat('Uses Remaining', session ? String(session.usesRemaining) : '--')}
              ${drawerStat('Hash', session?.messageHash || '--')}
            </div>
          </section>
          <section class="drawer-card">
            <h3>Operator Instructions</h3>
            <pre class="drawer-codeblock">${escapeHtml(session?.instructions || 'Create a session to start listening.')}</pre>
          </section>
          <section class="drawer-card">
            <h3>Matched Message</h3>
            <pre class="drawer-codeblock">${escapeHtml(session?.messageBody || 'Waiting for an incoming message on the configured test channel.')}</pre>
          </section>
        `,
      };
    case 'transport':
      return {
        meta: 'Transport Matrix',
        title: 'Network Transport',
        body: `
          <section class="drawer-card">
            <h3>Live Transport</h3>
            <div class="drawer-stat-grid">
              ${drawerStat('State', transport?.stateLabel || 'Offline')}
              ${drawerStat('Broker', snapshot?.mqtt?.broker || 'Unknown')}
              ${drawerStat('Channel', snapshot?.testChannel?.name ? `#${snapshot.testChannel.name}` : 'Unknown')}
              ${drawerStat('Topics', Array.isArray(snapshot?.mqtt?.topics) ? String(snapshot.mqtt.topics.length) : '0')}
            </div>
          </section>
          <section class="drawer-card">
            <h3>Observer Window</h3>
            <div class="drawer-list">
              ${drawerListItem(
                'Retention Window',
                transport?.summary || 'Awaiting observer directory.',
                transport?.detail || '',
              )}
            </div>
          </section>
        `,
      };
    case 'observers':
      return {
        meta: 'Target Matrix',
        title: 'Observer Targeting',
        body: directory.length > 0
          ? `
            <section class="drawer-card">
              <h3>Target Summary</h3>
              <div class="drawer-stat-grid">
                ${drawerStat('Default Source', snapshot?.defaultObserverSource || 'Unknown')}
                ${drawerStat('Directory Size', String(directory.length))}
                ${drawerStat('Scoring Target', String(defaultObserverKeys().length))}
                ${drawerStat('Active Nodes', String(snapshot?.observerStats?.activeCount || 0))}
              </div>
            </section>
            <section class="drawer-card">
              <h3>Node Inventory</h3>
              <div class="drawer-list">
                ${directory.map((observer) => drawerListItem(
                  observer.label,
                  `${observer.hash || '--'} · ${observer.shortKey}`,
                  `${observer.packetCount || 0} packet${observer.packetCount === 1 ? '' : 's'} · ${observer.hasLocation ? 'mapped' : 'no coordinates'} · ${observer.isActive ? 'active' : 'idle'}`,
                )).join('')}
              </div>
            </section>
          `
          : `
            <section class="drawer-card">
              <h3>Observer Targeting</h3>
              <p>No observers available yet. Node inventory appears as metadata and packets arrive.</p>
            </section>
          `,
      };
    case 'map':
      return {
        meta: 'Geo View',
        title: 'Coverage Map',
        body: mappedObservers.length > 0
          ? `
            <section class="drawer-card">
              <h3>Mapped Observers</h3>
              <div class="drawer-stat-grid">
                ${drawerStat('Mapped', String(mappedObservers.length))}
                ${drawerStat('Reached', String(mappedObservers.filter((observer) => observer.seen).length))}
                ${drawerStat('Theme', state.uiTheme === 'dark' ? 'Dark mode' : 'Light mode')}
                ${drawerStat('Scope', mapObserverScope === 'expected' ? 'Expected' : 'Directory')}
              </div>
            </section>
            <section class="drawer-card">
              <h3>Coordinates</h3>
              <div class="drawer-list">
                ${mappedObservers.map((observer) => drawerListItem(
                  observer.label,
                  `${observer.lat}, ${observer.lon}`,
                  `${observer.seen ? 'Heard by this check' : 'Not heard by this check'} · ${observer.hash || '--'}`,
                )).join('')}
              </div>
            </section>
          `
          : `
            <section class="drawer-card">
              <h3>Coverage Map</h3>
              <p>Waiting for observer coordinates.</p>
            </section>
          `,
      };
    case 'reports':
      return {
        meta: 'Signal Trace',
        title: 'Technical Logs',
        body: receipts.length > 0
          ? `
            <section class="drawer-card">
              <h3>Receipt Summary</h3>
              <div class="drawer-stat-grid">
                ${drawerStat('Signal Quality', signal.value)}
                ${drawerStat('Spread', latency.value)}
                ${drawerStat('Observer Reports', String(receipts.length))}
                ${drawerStat('Longest Packet', session?.longestPacketDistanceText || '--')}
                ${drawerStat('Sender', session?.sender || '--')}
              </div>
            </section>
            <section class="drawer-card">
              <h3>Trace Lines</h3>
              <div class="console-lines">
                ${receipts.map((receipt) => `
                  <div class="console-line">
                    <strong>${escapeHtml(receipt.observerLabel)}</strong>
                    <span>${escapeHtml(formatTime(receipt.firstSeenAt))}</span>
                    <code>${escapeHtml(receipt.messageHash || 'no-hash')}</code>
                    <span>${escapeHtml(receiptPathText(receipt))}</span>
                  </div>
                `).join('')}
              </div>
            </section>
          `
          : `
            <section class="drawer-card">
              <h3>Technical Logs</h3>
              <p>Timeline appears after the first observer report.</p>
            </section>
          `,
      };
    case 'history':
      return {
        meta: 'Session Archive',
        title: 'Recent Sessions',
        body: historySessions.length > 0
          ? `
            <section class="drawer-card">
              <h3>Browser Session History</h3>
              <div class="drawer-list">
                ${historySessions.map((entry) => drawerListItem(
                  entry.code,
                  `${entry.observedCount}/${entry.expectedCount} observers · ${historyHealthScore(entry)}`,
                  `${historyHealthLabel(entry)} · ${formatTime(entry.createdAt)}`,
                )).join('')}
              </div>
            </section>
          `
          : `
            <section class="drawer-card">
              <h3>Recent Sessions</h3>
              <p>No previous checks in this browser session.</p>
            </section>
          `,
      };
    default:
      return null;
  }
}

function renderDrawer() {
  if (!ui.detailDrawer || !ui.drawerBody || !ui.drawerMeta || !ui.drawerTitle) {
    return;
  }
  if (!state.drawer.kind) {
    ui.detailDrawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    return;
  }
  const content = buildDrawerContent();
  if (!content) {
    state.drawer.kind = '';
    state.drawer.key = '';
    ui.detailDrawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    return;
  }
  ui.drawerMeta.textContent = content.meta;
  ui.drawerTitle.textContent = content.title;
  ui.drawerBody.innerHTML = content.body;
  ui.detailDrawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
}

function openDrawer(kind, key = '') {
  state.drawer.kind = kind;
  state.drawer.key = key;
  renderDrawer();
}

function closeDrawer() {
  state.drawer.kind = '';
  state.drawer.key = '';
  renderDrawer();
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  // A background tab still gets the five-second poll and socket snapshots; keep
  // the data current but leave painting to the visibilitychange handler.
  if (document.visibilityState === 'hidden') {
    state.renderDeferred = true;
    return;
  }
  state.renderDeferred = false;
  applyUiTheme();

  const channelLabel = `#${snapshot.testChannel.name}`;
  const historySessions = state.trackedSessionIds
    .map((id) => state.sessions.get(id))
    .filter(Boolean);

  const session = currentSession();
  ui.newSessionButton.disabled = false;
  ui.copySessionCodeButton.disabled = !session;
  ui.shareSessionButton.disabled = !session?.shareUrl;
  applySiteBranding(snapshot);
  if (isSharePage()) {
    ui.mqttPill.textContent = state.sharedSessionMissing ? 'Shared link expired' : 'Shared Result';
    ui.mqttPill.classList.remove('online');
  } else {
    ui.mqttPill.textContent = snapshot.mqtt.connected ? 'MQTT online' : 'MQTT offline';
    ui.mqttPill.classList.toggle('online', snapshot.mqtt.connected);
  }
  ui.heroChannel.textContent = channelLabel;
  if (ui.sessionStepChannel) {
    ui.sessionStepChannel.textContent = channelLabel;
  }
  renderRegionalChannelNote(snapshot);
  // Tapping the code on a phone hands the channel straight to the app; the QR
  // is for the common case of reading this page on a desktop.
  if (ui.channelQr) {
    const inviteUri = snapshot.testChannel?.inviteUri || '';
    const showQr = Boolean(inviteUri) && snapshot.testChannel?.qrAvailable !== false;
    ui.channelQr.hidden = !showQr;
    if (showQr) {
      ui.channelQr.href = inviteUri;
    }
  }
  ui.brokerName.textContent = snapshot.mqtt.broker;
  // The active-observer count used to be repeated in the Observer Reports header
  // as "N active observers in the last 900s" - raw seconds, and the same number
  // System Telemetry already shows as "N active nodes / 15m window" via
  // transportSummary(). One statement of a metric, in the section about the
  // transport, not two in different units.
  if (!session) {
    ui.sessionCode.textContent = 'No active code';
    ui.sessionInstructions.textContent = state.sharedSessionMissing
      ? 'That shared result is no longer available.'
      : 'Create a session to start listening.';
    ui.sessionShareNote.textContent = state.sharedSessionMissing
      ? 'Shared results are removed after their retention window.'
      : retentionNote();
    ui.sessionStatus.textContent = '--';
    setSessionHash('');
    ui.healthLabel.textContent = 'Waiting';
    ui.healthLabel.className = '';
    ui.healthPercent.innerHTML = healthScoreMarkup(0, false);
    ui.observedCount.textContent = '--';
    if (ui.healthNote) {
      ui.healthNote.textContent = '';
      ui.healthNote.classList.add('hidden');
    }
    if (ui.regionCoverage) {
      ui.regionCoverage.textContent = '--';
      ui.regionCoverage.removeAttribute('title');
    }
    if (ui.regionCoverageCard) {
      ui.regionCoverageCard.classList.remove('hidden');
    }
    renderHealthScope(scoreForSelectedScope(null));
    ui.repeaterCount.textContent = '--';
    if (ui.longestPacketDistance) {
      ui.longestPacketDistance.textContent = '--';
    }
    ui.senderName.textContent = '--';
    ui.channelName.textContent = channelLabel;
    setMessagePreview(`Waiting for your ${channelLabel} message.`);
    renderObserverMap(null);
    renderReceipts(null);
    renderHistory(historySessions);
    renderGlanceMetrics(null);
    updateRing(0, 'Waiting');
    renderCodeLife();
    renderDrawer();
    return;
  }

  if (!state.sharedSessionId) {
    state.currentSessionId = session.id;
    sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);
  }

  ui.sessionCode.textContent = session.code;
  renderInstruction(
    ui.sessionInstructions,
    state.sharedSessionId
      ? `This is a saved result for code ${session.code}.`
      : session.instructions,
    session.code,
  );
  ui.sessionShareNote.textContent = `Share link available until ${formatDateTime(session.resultExpiresAt)}.`;
  // A status only means something once the code has been used. Before that,
  // EXPIRED is the leftover of an earlier visit and reads as a fault report, and
  // WAITING just repeats the headline above it. Both render as the same '--' the
  // other unfilled fields use. A code that DID run keeps its real status.
  const sessionRan = Boolean(session.matchedAt) || Number(session.useCount) > 0;
  ui.sessionStatus.textContent = sessionRan ? session.status.toUpperCase() : '--';
  setSessionHash(session.messageHash);
  const healthMeasured = isHealthMeasured(session);
  const score = scoreForSelectedScope(session);
  // Two separate gates. healthMeasured means a message actually landed, so the
  // counters have something to report. healthRated means the scope had enough
  // observers for a grade. Below that the count and the percentage are still
  // shown - they are what was heard - but the headline says "Small sample"
  // instead of a grade word: a one-observer scope is heard or not heard, and
  // dressing that up as 100% VERY HEALTHY is what this prevents.
  const healthRated = healthMeasured && isHealthRated(score);
  const hasTarget = Number(score.expectedCount) > 0;
  ui.healthLabel.textContent = headlineFor(score, healthMeasured, healthRated);
  ui.healthLabel.className = healthRated ? healthClass(score.healthLabel) : '';
  ui.healthPercent.innerHTML = healthScoreMarkup(score.healthPercent, healthMeasured && hasTarget);
  renderHealthScope(score);
  renderHealthNote(score, healthMeasured, healthRated);
  // Until the test message is heard, these counters have no result to report.
  // A measured 0 is meaningful; an unmeasured 0 just looks like a failure.
  ui.observedCount.textContent = healthMeasured
    ? `${score.observedCount} / ${score.expectedCount}`
    : '--';
  renderRegionCoverage(score, healthMeasured && hasTarget);
  ui.repeaterCount.textContent = healthMeasured ? String(session.repeaterCount || 0) : '--';
  if (ui.longestPacketDistance) {
    const distanceText = session.longestPacketDistanceText || '--';
    ui.longestPacketDistance.textContent = session.longestPacketDistanceSource === 'observer-span'
      ? `${distanceText} span`
      : distanceText;
    if (session.longestPacketDistancePair) {
      ui.longestPacketDistance.title =
        `${session.longestPacketDistancePair.fromLabel} to ${session.longestPacketDistancePair.toLabel}`;
    } else {
      ui.longestPacketDistance.removeAttribute('title');
    }
  }
  ui.senderName.textContent = session.sender || '--';
  ui.channelName.textContent = session.channelName ? `#${session.channelName}` : channelLabel;
  if (session.messageBody) {
    setMessagePreview(session.messageBody, session.messageHash);
  } else {
    setMessagePreview(`Waiting for your ${channelLabel} message.`);
  }

  // A small sample fills the ring to its percentage in the neutral colour.
  updateRing(
    healthMeasured && hasTarget ? score.healthPercent : 0,
    healthRated ? score.healthLabel : (healthMeasured && hasTarget ? 'NOT RATED' : 'Waiting'),
  );
  renderObserverMap(session);
  renderReceipts(session);
  renderHistory(historySessions);
  renderGlanceMetrics(session);
  // Runs last, deliberately. Once the code is dead this overrides the
  // instruction, the status and - only when nothing was ever measured - the
  // health headline and matched-message line, all of which are written above.
  // The ring is left alone: it is already neutral for an unmeasured code, and
  // colouring it red would report a network fault that did not happen.
  renderCodeLife();
  renderDrawer();
}

function applySnapshot(snapshot) {
  reconcileRegionSelection(snapshot);
  updateServerSkew(snapshot);
  state.snapshot = snapshot;
  render();
}

async function refreshTrackedSessions() {
  const ids = dedupe([
    ...state.trackedSessionIds,
    state.sharedSessionId,
  ]);
  if (ids.length === 0) {
    return;
  }

  const results = await Promise.all(ids.map(async (sessionId) => {
    const response = await apiFetch(`/api/sessions/${sessionId}`);
    if (response.status === 404) {
      return { sessionId, missing: true };
    }
    if (response.status === 403) {
      return { sessionId, turnstileRequired: true };
    }
    if (!response.ok) {
      return { sessionId, failed: true };
    }
    return {
      sessionId,
      session: await response.json(),
    };
  }));

  for (const result of results) {
    if (result.turnstileRequired) {
      redirectToLanding();
      return;
    }
    if (result.missing) {
      if (result.sessionId === state.sharedSessionId) {
        state.sharedSessionMissing = true;
        state.sessions.delete(result.sessionId);
      }
      removeTrackedSession(result.sessionId);
      continue;
    }
    if (result.failed || !result.session) {
      continue;
    }
    if (result.sessionId === state.sharedSessionId) {
      state.sharedSessionMissing = false;
    }
    state.sessions.set(result.session.id, result.session);
  }
}

async function refreshFromServer() {
  if (state.refreshInFlight) {
    return;
  }
  state.refreshInFlight = true;
  try {
    const response = await apiFetch('/api/bootstrap');
    const snapshot = await response.json();
    if (snapshot.turnstile?.enabled && !snapshot.turnstile.verified && !isSharedRoute()) {
      redirectToLanding();
      return;
    }
    applySnapshot(snapshot);
    await refreshTrackedSessions();
    render();
  } finally {
    state.refreshInFlight = false;
  }
}

function scheduleSocketReconnect() {
  if (state.socket || state.socketRetryTimer) {
    return;
  }
  state.socketRetryTimer = window.setTimeout(() => {
    state.socketRetryTimer = 0;
    connectSocket();
  }, 2000);
}

function connectSocket() {
  if (state.socket) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}`);
  state.socket = socket;

  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'snapshot') {
        applySnapshot(message.data);
        refreshTrackedSessions().then(() => {
          render();
        });
      }
    } catch {
      // ignore malformed frames
    }
  });

  socket.addEventListener('close', () => {
    state.socket = null;
    scheduleSocketReconnect();
  });
}

async function bootstrap() {
  await registerPwa();
  await refreshFromServer();
  if (!state.snapshot) {
    return;
  }
  if (isSharedRoute()) {
    render();
    connectSocket();
    return;
  }
  const restored = currentSession();
  if (!restored) {
    await createSession();
  } else if (isReplaceableOnLoad(restored)) {
    await createSession();
  } else {
    render();
  }
  connectSocket();
}

// The server keeps a session readable for the whole result-retention window -
// days after it stopped accepting the code - so the id in sessionStorage
// rehydrates happily into a code nothing will match. Replacing it is only safe
// here, at load, and only when the code was never used: nothing can be in
// flight against a code that has never been seen. A code that dies while the
// page is open is left exactly where it is, because swapping it under someone
// who has already sent it is the failure this whole change exists to prevent.
function isReplaceableOnLoad(session) {
  if (sessionCodeLife(session).state !== 'expired') {
    return false;
  }
  return Number(session.useCount) === 0 && !session.matchedAt;
}

ui.newSessionButton.addEventListener('click', () => {
  createSession();
});

ui.installAppButton.addEventListener('click', () => {
  installApp();
});

ui.copySessionCodeButton.addEventListener('click', () => {
  copyCurrentCode();
});

ui.shareSessionButton.addEventListener('click', () => {
  copySessionShareLink();
});

clearStoredObserverSelection();

// The observer and reports panels live inside a <details> block that starts
// collapsed. The coverage map was moved out of it and is always visible, so the
// Leaflet invalidateSize()/refit dance on open is no longer needed here.
function syncAdditionalInfo() {
  if (!ui.additionalInfo || !ui.additionalInfoLabel) {
    return;
  }
  const isOpen = ui.additionalInfo.open;
  ui.additionalInfoLabel.textContent = isOpen
    ? 'Hide Additional Information'
    : 'Show Additional Information';
  if (ui.additionalInfoToggle) {
    ui.additionalInfoToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }
  if (!isOpen) {
    return;
  }
  // Panels revealed here were display:none until now, so give them a render pass
  // with real dimensions. The coverage map no longer lives in this block.
  window.setTimeout(render, 0);
}

if (ui.additionalInfo) {
  ui.additionalInfo.addEventListener('toggle', syncAdditionalInfo);
  syncAdditionalInfo();
}

if (ui.uiThemeToggle) {
  ui.uiThemeToggle.addEventListener('click', () => {
    state.uiTheme = state.uiTheme === 'dark' ? 'light' : 'dark';
    saveUiTheme();
    render();
  });
}

if (ui.drawerClose) {
  ui.drawerClose.addEventListener('click', () => {
    closeDrawer();
  });
}

if (ui.drawerScrim) {
  ui.drawerScrim.addEventListener('click', () => {
    closeDrawer();
  });
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const action = event.target.closest('[data-drawer-action]');
  if (action) {
    event.preventDefault();
    openDrawer(action.dataset.drawerAction || '');
    return;
  }
  const pathToggle = event.target.closest('[data-receipt-path]');
  if (pathToggle) {
    event.preventDefault();
    toggleReceiptPath(pathToggle.dataset.receiptPath || '');
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.drawer.kind) {
    closeDrawer();
  }
});

bootstrap();
window.setInterval(() => {
  refreshFromServer();
}, 5000);

// A local clock, deliberately not the five-second network poll. A throttled,
// backgrounded or offline tab is when the poll stops, and it is exactly when
// someone is most likely to come back to a code that quietly died while they
// were away.
window.setInterval(renderCodeLife, CODE_LIFE_TICK_MS);

// Coming back to the tab is the moment the displayed code is most likely to be
// stale, and waiting up to five seconds for the next poll to say so is five
// seconds someone can spend sending a dead code.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    return;
  }
  renderCodeLife();
  if (state.renderDeferred) {
    render();
  }
  refreshFromServer().catch(() => {
    // The poll will try again in a moment; renderCodeLife has already told the
    // truth about the code from the payload we still hold.
  });
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButton();
});
