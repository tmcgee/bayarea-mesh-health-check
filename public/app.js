const SESSION_STORAGE_KEY = 'mesh-health-check-session-id';
const SESSION_HISTORY_STORAGE_KEY = 'mesh-health-check-session-history';
const OBSERVER_ALLOWLIST_STORAGE_KEY = 'mesh-health-check-observer-allowlist';
const UI_THEME_STORAGE_KEY = 'mesh-health-check-ui-theme';
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
  expectedObservers: document.querySelector('#expected-observers'),
  observerAllowlistNote: document.querySelector('#observer-allowlist-note'),
  regionFilter: document.querySelector('#region-filter'),
  uiThemeToggle: document.querySelector('#ui-theme-toggle'),
  mapObserverNote: document.querySelector('#map-observer-note'),
  mapEmpty: document.querySelector('#map-empty'),
  additionalInfo: document.querySelector('#additional-info'),
  additionalInfoLabel: document.querySelector('#additional-info-label'),
  additionalInfoToggle: document.querySelector('#additional-info-toggle'),
  observerMap: document.querySelector('#observer-map'),
  activeObserverNote: document.querySelector('#active-observer-note'),
  receiptsEmpty: document.querySelector('#receipts-empty'),
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
  selectedRegionGroup: null,
  selectedRegion: null,
  uiTheme: loadUiTheme(),
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
    region: null,
    regionGroup: null,
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
  if (source === 'top-window') {
    const days = Math.max(1, Number(state.snapshot?.observerStats?.topWindowDays || 7));
    return `Top ${count} observer${count === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'}.`;
  }
  const windowSeconds = Math.max(1, Number(state.snapshot?.observerStats?.windowSeconds || 900));
  const minutes = Math.max(1, Math.round(windowSeconds / 60));
  return `${count} observer${count === 1 ? '' : 's'} active in the last ${minutes} min.`;
}

// Says out loud why a grade is missing. Silence would read as a rendering bug,
// and the old behaviour - a confident 100% next to "1 / 1" - was worse than
// either. Only shown when there is something to explain.
function renderHealthNote(session, healthMeasured, healthRated) {
  if (!ui.healthNote) {
    return;
  }
  if (!healthMeasured || healthRated) {
    ui.healthNote.textContent = '';
    ui.healthNote.classList.add('hidden');
    return;
  }
  const target = Number(session?.expectedCount) || 0;
  const minimum = Number(session?.minScoringSet) || 3;
  ui.healthNote.textContent = session?.healthUnratedReason === 'target-too-small'
    ? `Not rated: this code targeted ${target} observer${target === 1 ? '' : 's'}, below the ${minimum} needed for a percentage to mean anything. The count above is still what was heard.`
    : 'Not rated: this code cannot be scored.';
  ui.healthNote.classList.remove('hidden');
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
  const coverage = session?.regionCoverage;
  if (!healthMeasured || !coverage || !Number(coverage.total)) {
    ui.regionCoverage.textContent = '--';
    ui.regionCoverage.removeAttribute('title');
    return;
  }
  ui.regionCoverage.textContent = `${coverage.reached} / ${coverage.total}`;
  const groups = Array.isArray(coverage.groups) ? coverage.groups : [];
  const reached = groups.filter((entry) => Number(entry.seenCount) > 0);
  const missed = groups.filter((entry) => !Number(entry.seenCount));
  const lines = [];
  if (reached.length > 0) {
    lines.push(`Reached: ${reached.map((entry) => `${entry.group} (${entry.seenCount}/${entry.observerCount})`).join(', ')}`);
  }
  if (missed.length > 0) {
    lines.push(`No report: ${missed.map((entry) => `${entry.group} (0/${entry.observerCount})`).join(', ')}`);
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
    return {
      value: '--',
      label: 'Awaiting telemetry.',
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

function packetHashLink(hash) {
  const coreScopeUrl = buildCoreScopePacketLink(hash);
  if (coreScopeUrl) {
    return coreScopeUrl;
  }
  return `${ANALYZER_BASE_URL}${encodeURIComponent(hash)}`;
}

function setSessionHash(hash) {
  const value = String(hash || '').trim();
  if (!value) {
    ui.sessionHash.textContent = 'Pending';
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

function renderRegionFilter() {
  if (!ui.regionFilter) return;
  const { hasGroups, regions } = regionFilterOptions();

  if (regions.length === 0 || regions.every((entry) => entry.regions.length === 0)) {
    ui.regionFilter.classList.add('hidden');
    ui.regionFilter.innerHTML = '';
    return;
  }
  ui.regionFilter.classList.remove('hidden');
  ui.regionFilter.innerHTML = '';

  const groupRow = document.createElement('div');
  groupRow.className = 'region-filter__row';

  const locatedObserverCount = regions.reduce((sum, entry) => sum + (entry.count || 0), 0);
  const inferredObserverCount = regions.reduce((sum, entry) => sum + (entry.inferredCount || 0), 0);
  groupRow.appendChild(createRegionButton({
    className: 'region-btn--all',
    active: state.selectedRegionGroup === null && state.selectedRegion === null,
    label: hasGroups ? 'All regions' : 'All',
    count: locatedObserverCount,
    inferredCount: inferredObserverCount,
    onClick: () => {
      state.selectedRegionGroup = null;
      state.selectedRegion = null;
      applyRegionSelection();
    },
  }));

  if (hasGroups) {
    for (const entry of regions.filter((item) => item.group)) {
      groupRow.appendChild(createRegionButton({
        className: 'region-btn--group',
        active: state.selectedRegionGroup === entry.group && state.selectedRegion === null,
        label: entry.group,
        count: entry.count,
        inferredCount: entry.inferredCount || 0,
        onClick: () => {
          state.selectedRegionGroup = entry.group;
          state.selectedRegion = null;
          applyRegionSelection();
        },
      }));
    }
  }
  ui.regionFilter.appendChild(groupRow);

  const selectedGroup = state.selectedRegionGroup
    ? regions.find((entry) => entry.group === state.selectedRegionGroup)
    : null;
  const subregionSource = hasGroups
    ? selectedGroup?.regions || []
    : regions.flatMap((entry) => entry.regions);

  if (subregionSource.length > 0) {
    const subregionRow = document.createElement('div');
    subregionRow.className = 'region-filter__row region-filter__row--subregions';

    if (selectedGroup) {
      subregionRow.appendChild(createRegionButton({
        className: 'region-btn--child',
        active: state.selectedRegion === null,
        label: `All ${selectedGroup.group}`,
        count: selectedGroup.count,
        inferredCount: selectedGroup.inferredCount || 0,
        onClick: () => {
          state.selectedRegion = null;
          applyRegionSelection();
        },
      }));
    }

    for (const region of subregionSource) {
      subregionRow.appendChild(createRegionButton({
        className: 'region-btn--child',
        active: state.selectedRegion === region.name,
        label: region.name,
        count: region.count,
        onClick: () => {
          state.selectedRegion = region.name;
          if (!state.selectedRegionGroup && hasGroups) {
            const parent = regions.find((entry) => entry.regions.some((item) => item.name === region.name));
            state.selectedRegionGroup = parent?.group || null;
          }
          applyRegionSelection();
        },
      }));
    }
    ui.regionFilter.appendChild(subregionRow);
  }
}

function regionFilterOptions(snapshot = state.snapshot) {
  const hierarchy = Array.isArray(snapshot?.regionHierarchy)
    ? snapshot.regionHierarchy.filter((entry) => (Array.isArray(entry.regions) && entry.regions.length > 0)
      || (entry.group && (entry.inferredCount || 0) > 0))
    : [];
  const flatRegions = Array.isArray(snapshot?.availableRegions)
    ? snapshot.availableRegions.map((name) => ({ name, count: 0 }))
    : [];
  const regions = hierarchy.length > 0
    ? hierarchy
    : [{ group: '', count: flatRegions.length, regions: flatRegions }];
  const namedGroupCount = regions.filter((entry) => entry.group).length;
  const hasUngroupedRegions = regions.some((entry) => !entry.group && entry.regions.length > 0);
  const hasGroups = namedGroupCount > 1 || (namedGroupCount > 0 && hasUngroupedRegions);
  return { hasGroups, regions };
}

function createRegionButton({ className, active, label, count, inferredCount = 0, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `region-btn ${className}${active ? ' active' : ''}`;

  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  btn.appendChild(labelEl);

  if (Number.isFinite(count) && count > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'region-btn__count';
    countEl.textContent = String(count);
    btn.appendChild(countEl);
  }

  // Observers placed in this group by their uplink code rather than by
  // coordinates. Shown as a separate +N so the mapped count stays honest.
  if (Number.isFinite(inferredCount) && inferredCount > 0) {
    const inferredEl = document.createElement('span');
    inferredEl.className = 'region-btn__count region-btn__count--inferred';
    inferredEl.textContent = `+${inferredCount}`;
    inferredEl.title = `${inferredCount} observer${inferredCount === 1 ? '' : 's'} grouped by uplink code - scored like any other, but no coordinates so no map marker and no Regions Reached credit`;
    btn.appendChild(inferredEl);
  }

  btn.addEventListener('click', onClick);
  return btn;
}

function reconcileRegionSelection(snapshot) {
  const { hasGroups, regions } = regionFilterOptions(snapshot);
  if (!hasGroups && state.selectedRegionGroup !== null) {
    state.selectedRegionGroup = null;
  }
  if (state.selectedRegionGroup !== null) {
    const group = regions.find((entry) => entry.group === state.selectedRegionGroup);
    if (!group) {
      state.selectedRegionGroup = null;
      state.selectedRegion = null;
      return;
    }
    if (state.selectedRegion !== null && !group.regions.some((region) => region.name === state.selectedRegion)) {
      state.selectedRegion = null;
    }
    return;
  }

  if (state.selectedRegion !== null) {
    const regionExists = regions.some((entry) => entry.regions.some((region) => region.name === state.selectedRegion));
    if (!regionExists) {
      state.selectedRegion = null;
      return;
    }
    if (hasGroups) {
      const parent = regions.find((entry) => entry.regions.some((region) => region.name === state.selectedRegion));
      state.selectedRegionGroup = parent?.group || null;
    }
  }
}

// The region filter narrows what the observer list *shows*, and nothing else. It
// used to set the scoring target, which meant clicking a region silently
// redefined it: picking North Bay - one located observer - produced a
// one-observer allowlist and a session reporting "1 / 1, 100% VERY HEALTHY" off a
// single receipt. Nothing in the UI can narrow the target now.
function applyRegionSelection() {
  render();
}

// Visibility only. Uplink-inferred observers have a regionGroup but no county, so
// they show under their group chip and disappear under a county chip - which is
// exactly right: a group is all their uplink code can tell us.
function observersMatchingRegionFilter(observers) {
  if (state.selectedRegion === null && state.selectedRegionGroup === null) {
    return observers;
  }
  return observers.filter((observer) => {
    if (state.selectedRegion) {
      return observer.region === state.selectedRegion
        && (!state.selectedRegionGroup || observer.regionGroup === state.selectedRegionGroup);
    }
    return observer.regionGroup === state.selectedRegionGroup;
  });
}

// Everything that used to be split between the scrollable "Observers" list and
// the "Score Against" grid, in one place. The two panels had become two views of
// the same set that disagreed on both membership and detail, and reconciling them
// was left to the reader. There is one list now: the observers this code is
// scored against, each stating its own region, position status and receipt state.
function observerDetailLine(observer) {
  const parts = [];
  if (observer.regionInferred) {
    // The group is the metro of the uplink gateway, so name the code that
    // supplied it rather than implying we know where the node is.
    parts.push(`${observer.regionGroup} via ${observer.uplinkCode || 'uplink'}`);
  } else if (observer.region) {
    parts.push(observer.regionGroup ? `${observer.region}, ${observer.regionGroup}` : observer.region);
  } else if (observer.regionGroup) {
    parts.push(observer.regionGroup);
  } else {
    parts.push('no region');
  }
  parts.push(observer.hasLocation ? 'mapped' : 'no coordinates');
  if (observer.isRetained === false) {
    parts.push('not recently heard');
  }
  return parts.join(' \u00b7 ');
}

// Rendered as its own element rather than appended to the detail string, because
// .observer-detail sets overflow-wrap: anywhere for long region names and that
// happily split "2-BYTE PATH" after the hyphen. Only stated when the node's own
// advert confirmed the width: a prefix seen inside somebody else's forwarded
// path is not evidence of that node's setting.
function observerHashModeNote(observer) {
  if (!observer?.hashBytesConfirmed) {
    return '';
  }
  return `${observerHashBytes(observer)}-byte path`;
}

function renderObservers(session) {
  renderRegionFilter();

  const expected = Array.isArray(session?.expectedObservers)
    ? session.expectedObservers.filter((observer) => observer?.key)
    : [];
  const seenByKey = new Map(expected.map((observer) => [observer.key, Boolean(observer.seen)]));
  // With no session yet the panel previews what the next code will target, so a
  // cold load shows the roster instead of an empty box.
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

  if (all.length === 0) {
    ui.observerAllowlistNote.textContent = 'No observers yet.';
    ui.expectedObservers.innerHTML =
      '<div class="empty-state compact">Observers appear as metadata and packets arrive.</div>';
    return;
  }

  const rows = observersMatchingRegionFilter(all);
  const baseNote = observerTargetSummary();
  ui.observerAllowlistNote.textContent = rows.length === all.length
    ? baseNote
    // "of N listed" rather than a bare N, because the sentence above counts the
    // scoring target and the list also carries observers that are not in it.
    : `${baseNote} Region filter showing ${rows.length} of ${all.length} listed.`;

  if (rows.length === 0) {
    ui.expectedObservers.innerHTML =
      '<div class="empty-state compact">No observers in this region. The region chips change what is listed here; they do not change what this code is scored against.</div>';
    return;
  }

  ui.expectedObservers.innerHTML = '';
  for (const observer of rows) {
    const inTarget = targeted.has(observer.key);
    const seen = Boolean(seenByKey.get(observer.key));
    const status = !inTarget ? 'Not Scored' : (seen ? 'Seen' : 'Not Seen');
    const item = document.createElement('div');
    item.className = `observer-pill ${inTarget ? (seen ? 'seen' : 'waiting') : 'untargeted'}`
      + `${observer.regionInferred ? ' unlocated' : ''}`;
    if (!inTarget) {
      item.title = 'Not heard inside the active window, so this code is not scored against it.';
    } else if (observer.regionInferred) {
      item.title = 'Group inferred from the uplink gateway code because this observer publishes no position. It is scored like any other observer, but it cannot appear on the coverage map and does not count toward Regions Reached.';
    }
    item.innerHTML = `
      <div class="observer-main">
        <strong class="observer-label">${escapeHtml(observerDisplayLabel(observer))}</strong>
        <div class="small-note observer-hash">${escapeHtml(observer.hash || '--')}</div>
        <div class="small-note observer-detail">${escapeHtml(observerDetailLine(observer))}${
          observerHashModeNote(observer)
            ? ` \u00b7 <span class="observer-detail__mode">${escapeHtml(observerHashModeNote(observer))}</span>`
            : ''
        }</div>
      </div>
      <span class="status">${status}</span>
    `;
    ui.expectedObservers.appendChild(item);
  }
}

function applySiteBranding(snapshot) {
  const site = snapshot?.site || {};
  applyMapTileConfig(site.map);
  const title = site.title || 'Mesh Health Check';
  const version = String(site.version || '').trim() || '0.0.0';
  const eyebrow = site.eyebrow || 'MeshCore Observer Coverage';
  const headline = site.headline || 'Check your mesh reach.';
  const repoUrl = site.repoUrl || 'https://github.com/yellowcooln/meshcore-health-check';
  const changesUrl = site.changesUrl || `${repoUrl}/blob/main/CHANGES.md`;
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
    ui.heroDescriptionPrefix.textContent = 'This page is read-only. Review the result from';
    ui.heroDescriptionSuffix.textContent = 'or open the full dashboard to run your own check.';
    return;
  }
  ui.heroEyebrow.textContent = eyebrow;
  ui.heroTitle.textContent = headline;
  // The channel chip only has a home when the description contains the literal
  // phrase "configured channel" to split on. Without it the sentence stands
  // alone, so hide the chip instead of trailing a bare channel name after it.
  const hasChannelSlot = suffixParts.length > 0;
  ui.heroDescriptionPrefix.textContent = (prefix || '').trimEnd() || 'Generate a test code, send it to';
  ui.heroDescriptionSuffix.textContent = (suffix || '').trimStart();
  if (ui.heroChannel) {
    ui.heroChannel.hidden = !hasChannelSlot;
  }
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
  return source
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
    subdomains: 'abcd',
    attribution,
  });
}

function markerIcon(observer) {
  return window.L.divIcon({
    className: 'observer-map-icon-shell',
    html: `<span class="observer-map-icon ${observer.seen ? 'seen' : 'missed'}"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function renderObserverMap(session) {
  const locatedObservers = mapKnownObservers(session);
  const mapInstance = ensureObserverMap();

  ui.mapObserverNote.textContent = locatedObservers.length > 0
    ? `${locatedObservers.filter((observer) => observer.seen).length}/${locatedObservers.length} mapped observers reached.`
    : 'No observer coordinates yet. The map stays live and will populate as coordinates arrive.';
  ui.mapEmpty.classList.toggle('hidden', locatedObservers.length > 0);

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
    if (!marker) {
      marker = window.L.marker(latLng, { icon: markerIcon(observer) }).addTo(mapInstance);
      state.map.markers.set(observer.key, marker);
    } else {
      marker.setLatLng(latLng);
      marker.setIcon(markerIcon(observer));
    }
    marker.bindPopup(`
      <strong>${escapeHtml(observer.label)}</strong><br>
      ${observer.seen ? 'Seen by this check' : 'Not seen by this check'}<br>
      ${escapeHtml(observer.hash || '--')} · ${escapeHtml(observer.shortKey)}
    `);
  }

  const boundsKey = locatedObservers.map((observer) => observer.key).join('|');
  if (bounds.length > 0 && boundsKey !== state.map.boundsKey) {
    mapInstance.fitBounds(bounds, { padding: [26, 26], maxZoom: 10 });
    state.map.boundsKey = boundsKey;
  } else if (bounds.length === 0 && state.map.boundsKey !== '__empty__') {
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

function renderReceipts(session) {
  const receipts = Array.isArray(session?.receipts) ? session.receipts : [];
  ui.receipts.innerHTML = '';
  ui.receiptsEmpty.classList.toggle('hidden', receipts.length > 0);

  const arrivals = receiptArrivalIndex(receipts);

  for (const receipt of receipts) {
    const card = document.createElement('article');
    card.className = 'receipt-card';
    card.dataset.observerKey = receipt.observerKey;
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
    const pathMarkup = receipt.path.length > 0
      ? receipt.path.map((hop) => `<span>${escapeHtml(hop)}</span>`).join('')
      : '<span>No path data</span>';
    const distanceText = String(receipt.displayDistanceText || receipt.pathDistanceText || '').trim();
    const distanceSource = String(receipt.displayDistanceSource || '').trim();
    const distanceLabel = String(receipt.displayDistanceLabel || '').trim();
    const distanceSegments = Array.isArray(receipt.pathDistanceSegments)
      ? receipt.pathDistanceSegments
      : [];
    // One leg per line. Joining them with a middle dot ran a four-hop estimate
    // into a single wrapped paragraph that could not be read hop by hop.
    const segmentLines = distanceSegments
      .map((segment) => `
        <span class="receipt-distance__leg">
          <span class="receipt-distance__leg-route">${escapeHtml(`${segment.fromLabel} to ${segment.toLabel}`)}</span>
          <span class="receipt-distance__leg-value">${escapeHtml(String(segment.distanceText || ''))}${
            segment.estimated
              ? escapeHtml(` estimated over ${segment.skippedHopCount} unknown hop${segment.skippedHopCount === 1 ? '' : 's'}`)
              : ''
          }</span>
        </span>
      `)
      .join('');
    const distanceMarkup = distanceText
      ? `
        <div class="receipt-distance">
          <strong>${distanceSource === 'observer-span' ? 'Observer span' : 'Estimated path'} ${escapeHtml(distanceText)}</strong>
          ${distanceSource === 'observer-span'
            ? `<span>${escapeHtml(distanceLabel || 'Estimated from receipt observer coordinates.')}</span>`
            : segmentLines
            || '<span>Distance estimated from known observer coordinates.</span>'}
        </div>
      `
      : '';
    const metrics = [
      receipt.rssi != null ? `RSSI ${receipt.rssi}` : '',
      receipt.snr != null ? `SNR ${receipt.snr}` : '',
      receipt.duration != null ? `${receipt.duration} ms` : '',
      distanceText ? `${distanceSource === 'observer-span' ? 'Span' : 'Path'} ${distanceText}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    card.innerHTML = `
      <div class="receipt-head">
        <div>
          <h3 class="receipt-title">${escapeHtml(receipt.observerLabel)}</h3>
          <div class="receipt-hash">${escapeHtml(receiptHashPrefix(receipt))} · ${escapeHtml(receipt.observerShortKey)}</div>
        </div>
        <div class="small-note">${escapeHtml(arrival.orderLabel)}</div>
      </div>
      <p class="receipt-meta">
        Seen ${receipt.count} time${receipt.count === 1 ? '' : 's'}${metrics ? ` · ${metrics}` : ''}
      </p>
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
      <div class="receipt-path">${pathMarkup}</div>
      ${distanceMarkup}
    `;
    ui.receipts.appendChild(card);
  }
}

function renderHistory(sessions) {
  ui.sessionHistory.innerHTML = '';
  if (sessions.length === 0) {
    ui.sessionHistory.innerHTML =
      '<div class="empty-state compact">No previous checks in this browser session.</div>';
    return;
  }
  for (const session of sessions) {
    const item = document.createElement('article');
    item.className = 'history-item';
    item.dataset.sessionId = session.id;
    item.innerHTML = `
      <div>
        <div class="history-code">${escapeHtml(session.code)}</div>
        <p>${session.observedCount}/${session.expectedCount} observers · ${escapeHtml(historyHealthLabel(session))}</p>
      </div>
      <div>
        <strong class="${healthClass(session.healthLabel)}">${historyHealthScore(session)}</strong>
        <p>${formatTime(session.createdAt)}</p>
      </div>
    `;
    ui.sessionHistory.appendChild(item);
  }
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
              ${drawerStat('Hash', session?.messageHash || 'Pending')}
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
                  `${observer.seen ? 'Seen by this check' : 'Not seen by this check'} · ${observer.hash || '--'}`,
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
                ${drawerStat('Sender', session?.sender || 'Pending')}
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
                    <span>${escapeHtml((receipt.path || []).join(' -> ') || 'No path data')}</span>
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
    case 'receipt': {
      const receipt = receipts.find((entry) => entry.observerKey === state.drawer.key);
      if (!receipt) {
        return null;
      }
      return {
        meta: 'Packet Detail',
        title: receipt.observerLabel,
        body: `
          <section class="drawer-card">
            <h3>Receipt Metrics</h3>
            <div class="drawer-stat-grid">
              ${drawerStat('First Seen', formatTime(receipt.firstSeenAt))}
              ${drawerStat('Message Hash', receipt.messageHash || 'Pending')}
              ${drawerStat('RSSI', receipt.rssi != null ? String(receipt.rssi) : 'n/a')}
              ${drawerStat('SNR', receipt.snr != null ? String(receipt.snr) : 'n/a')}
              ${drawerStat('Duration', receipt.duration != null ? `${receipt.duration} ms` : 'n/a')}
              ${drawerStat('Distance', receipt.displayDistanceText || receipt.pathDistanceText || 'n/a')}
              ${drawerStat('Packets', String(receipt.count))}
            </div>
          </section>
          <section class="drawer-card">
            <h3>Path Trace</h3>
            <pre class="drawer-codeblock">${escapeHtml((receipt.path || []).join(' -> ') || 'No path data')}</pre>
          </section>
        `,
      };
    }
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
  ui.activeObserverNote.textContent =
    `${snapshot.observerStats.activeCount} active observer${snapshot.observerStats.activeCount === 1 ? '' : 's'} in the last ${snapshot.observerStats.windowSeconds}s`;
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
    ui.repeaterCount.textContent = '--';
    if (ui.longestPacketDistance) {
      ui.longestPacketDistance.textContent = '--';
    }
    ui.senderName.textContent = 'Pending';
    ui.channelName.textContent = channelLabel;
    ui.messagePreview.textContent = `Waiting for your ${channelLabel} message.`;
    ui.messagePreview.title = '';
    renderObservers(null);
    renderObserverMap(null);
    renderReceipts(null);
    renderHistory(historySessions);
    renderGlanceMetrics(null);
    updateRing(0, 'Waiting');
    renderDrawer();
    return;
  }

  if (!state.sharedSessionId) {
    state.currentSessionId = session.id;
    sessionStorage.setItem(SESSION_STORAGE_KEY, session.id);
  }

  ui.sessionCode.textContent = session.code;
  ui.sessionInstructions.textContent = state.sharedSessionId
    ? `This is a saved result for code ${session.code}.`
    : session.instructions;
  ui.sessionShareNote.textContent = `Share link available until ${formatDateTime(session.resultExpiresAt)}.`;
  // An expired code that was never used carries no information: it is the
  // leftover of an earlier visit, and rendering EXPIRED on arrival reads as a
  // fault report. Withhold it until there is a real status to show. An expired
  // code that DID run keeps its status, because then it means something.
  const sessionRan = Boolean(session.matchedAt) || Number(session.useCount) > 0;
  ui.sessionStatus.textContent = session.status === 'expired' && !sessionRan
    ? '--'
    : session.status.toUpperCase();
  setSessionHash(session.messageHash);
  // healthMeasured is absent on cached payloads from an older server; fall back to
  // the label so the placeholder still shows instead of a red zero.
  const healthMeasured = session.healthMeasured != null
    ? Boolean(session.healthMeasured)
    : !isHealthPending(session.healthLabel);
  // Two separate gates. healthMeasured means a message actually landed, so the
  // counters have something to report. healthRated means the target set was big
  // enough for a percentage to mean anything - a one-observer target is heard or
  // not heard, and dressing that up as 100% VERY HEALTHY is what this prevents.
  const healthRated = healthMeasured && isHealthRated(session);
  ui.healthLabel.textContent = healthRated
    ? session.healthLabel
    : (healthMeasured ? 'Not rated' : 'Waiting');
  ui.healthLabel.className = healthRated ? healthClass(session.healthLabel) : '';
  ui.healthPercent.innerHTML = healthScoreMarkup(session.healthPercent, healthRated);
  renderHealthNote(session, healthMeasured, healthRated);
  // Until the test message is heard, these counters have no result to report.
  // A measured 0 is meaningful; an unmeasured 0 just looks like a failure. The
  // raw count is still shown when the score is unrated - 1 / 1 is honest, it is
  // only the percentage derived from it that is not.
  ui.observedCount.textContent = healthMeasured
    ? `${session.observedCount} / ${session.expectedCount}`
    : '--';
  renderRegionCoverage(session, healthRated);
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
  ui.senderName.textContent = session.sender || 'Pending';
  ui.channelName.textContent = session.channelName ? `#${session.channelName}` : channelLabel;
  ui.messagePreview.textContent = session.messageBody || `Waiting for your ${channelLabel} message.`;
  ui.messagePreview.title = session.messageBody || '';

  updateRing(healthRated ? session.healthPercent : 0, healthRated ? session.healthLabel : 'Waiting');
  renderObservers(session);
  renderObserverMap(session);
  renderReceipts(session);
  renderHistory(historySessions);
  renderGlanceMetrics(session);
  renderDrawer();
}

function applySnapshot(snapshot) {
  reconcileRegionSelection(snapshot);
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
  } else if (!currentSession()) {
    await createSession();
  } else {
    render();
  }
  connectSocket();
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

function targetIsPanelInteractive(target) {
  return Boolean(target.closest(
    'button, a, input, label, .leaflet-container, .leaflet-control-container, .leaflet-popup, .leaflet-marker-pane, .detail-drawer',
  ));
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

  const receiptCard = event.target.closest('.receipt-card[data-observer-key]');
  if (receiptCard && ui.receipts?.contains(receiptCard) && !targetIsPanelInteractive(event.target)) {
    openDrawer('receipt', receiptCard.dataset.observerKey || '');
    return;
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

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButton();
});
