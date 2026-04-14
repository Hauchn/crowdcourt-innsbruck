const INNSBRUCK_CENTER = [47.2692, 11.4041];
const SEARCH_RADIUS_METERS = 15000;
const DEFAULT_ROUTE_ORIGIN_NAME = "Marktplatz Innsbruck";
const DEFAULT_ROUTE_ORIGIN_COORDS = [47.26846, 11.39227];
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const OVERPASS_CACHE_KEY = "crowdcourt:overpass-cache-v1";
const OVERPASS_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const ONBOARDING_KEY = "crowdcourt:onboarding-seen";
const COMMENTS_STORAGE_KEY = "crowdcourt:spot-comments-v1";
const USER_ID_KEY = "crowdcourt:user-id-v1";

const sportsConfig = {
  soccer: { label: "Fussball", color: "#16a34a", icon: "⚽" },
  tennis: { label: "Tennis", color: "#dc2626", icon: "🎾" },
  volleyball: { label: "Volleyball", color: "#ea580c", icon: "🏐" },
  table_tennis: { label: "Tischtennis", color: "#7c3aed", icon: "🏓" },
};

const state = {
  activeSports: new Set(),
  markersBySport: new Map(),
  places: [],
  visiblePlaces: [],
  selectedPlaceId: null,
  userLocation: null,
  userMarker: null,
  currentView: "map",
  favorites: new Set(),
  history: [],
  routeLayer: null,
  routeTargetMarker: null,
  routeOriginMarker: null,
  isLoadingPlaces: false,
  isRouting: false,
  isLocating: false,
  lastFailedAction: null,
  lastRoutedPlaceId: null,
  lastLoadedAt: null,
  commentsByPlace: {},
  expandedComments: new Set(),
  crowdBySpotId: {},
  checkedInSpotId: null,
  userId: null,
  heartbeatTimerId: null,
  crowdRefreshTimerId: null,
  backendMode: "unknown",
};

const map = L.map("map", {
  scrollWheelZoom: false,
}).setView(INNSBRUCK_CENTER, 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap-Mitwirkende",
}).addTo(map);

const mapContainer = map.getContainer();
mapContainer.addEventListener(
  "wheel",
  (event) => {
    // On trackpads, two-finger swipe emits wheel deltas.
    // We use them to pan the map instead of zooming.
    if (event.ctrlKey) {
      return;
    }
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : 1;
    map.panBy([event.deltaX * scale, event.deltaY * scale], { animate: false });
  },
  { passive: false }
);

const statusElement = document.getElementById("status");
const filterButtons = document.querySelectorAll(".filter-btn");
const reloadButton = document.getElementById("reload-btn");
const freshLoadButton = document.getElementById("fresh-load-btn");
const locateButton = document.getElementById("locate-btn");
const clearFiltersButton = document.getElementById("clear-filters-btn");
const searchInput = document.getElementById("search-input");
const spotsList = document.getElementById("spots-list");
const navButtons = document.querySelectorAll(".nav-btn");
const panelTitle = document.getElementById("panel-title");
const clearHistoryButton = document.getElementById("clear-history-btn");
const chooseLocationButton = document.getElementById("choose-location-btn");
const selectedSpotCard = document.getElementById("selected-spot-card");
const selectedNameElement = document.getElementById("selected-name");
const selectedDistanceElement = document.getElementById("selected-distance");
const selectedSportsElement = document.getElementById("selected-sports");
const selectedRouteButton = document.getElementById("selected-route-btn");
const selectedCheckinButton = document.getElementById("selected-checkin-btn");
const selectedCheckoutButton = document.getElementById("selected-checkout-btn");
const viewGuidanceElement = document.getElementById("view-guidance");
const lastUpdatedElement = document.getElementById("last-updated");
const recentsStrip = document.getElementById("recents-strip");
const onboardingBanner = document.getElementById("onboarding-banner");
const dismissOnboardingButton = document.getElementById("dismiss-onboarding-btn");
const routeInfoElement = document.getElementById("route-info");
const retryButton = document.getElementById("retry-btn");
let searchDebounceId = null;

function getOrCreateUserId() {
  const existing = localStorage.getItem(USER_ID_KEY);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, created);
  return created;
}

function getSelectedPlace() {
  return state.places.find((place) => place.id === state.selectedPlaceId) || null;
}

function updatePrimaryActionState() {
  if (!chooseLocationButton) {
    return;
  }
  const selectedPlace = getSelectedPlace();
  const hasSelection = Boolean(selectedPlace);
  chooseLocationButton.disabled = !hasSelection || state.isLoadingPlaces || state.isRouting;
  chooseLocationButton.textContent = hasSelection
    ? `Route zu ${selectedPlace.name}`
    : "Wähle zuerst einen Spot";
}

function resetListScroll() {
  const panel = spotsList?.closest(".list-panel");
  if (panel) {
    panel.scrollTop = 0;
  }
}

function setGuidanceText() {
  if (!viewGuidanceElement) {
    return;
  }
  if (state.currentView === "map") {
    viewGuidanceElement.textContent =
      "Flow: Sport filtern, Spot auswählen und dann Route starten.";
    return;
  }
  if (state.currentView === "favorites") {
    viewGuidanceElement.textContent =
      "Favoriten speichern und von hier direkt erneut auswählen.";
    return;
  }
  viewGuidanceElement.textContent =
    "Verlauf zeigt zuletzt genutzte Spots für schnellen Wiedereinstieg.";
}

function updateSelectedSpotCard() {
  if (!selectedSpotCard || !selectedNameElement || !selectedDistanceElement || !selectedSportsElement) {
    return;
  }
  const selected = getSelectedPlace();
  if (!selected) {
    selectedSpotCard.hidden = true;
    return;
  }
  selectedSpotCard.hidden = false;
  selectedNameElement.textContent = selected.name;
  selectedDistanceElement.textContent = formatDistance(selected.distanceMeters);
  selectedSportsElement.textContent = selected.sports.map((sport) => sportsConfig[sport].label).join(", ");
  const crowdData = state.crowdBySpotId[selected.id];
  if (crowdData) {
    selectedSportsElement.textContent += ` · Live: ${crowdPillText(crowdData)}`;
  } else {
    selectedSportsElement.textContent += " · Keine Live-Daten";
  }
}

function updateLastUpdatedLabel() {
  if (!lastUpdatedElement) {
    return;
  }
  if (!state.lastLoadedAt) {
    lastUpdatedElement.textContent = "";
    return;
  }
  const time = new Date(state.lastLoadedAt).toLocaleTimeString("de-AT", {
    hour: "2-digit",
    minute: "2-digit",
  });
  lastUpdatedElement.textContent = `Zuletzt aktualisiert: ${time}`;
}

function crowdPillClass(bucket) {
  if (bucket === "high") {
    return "crowd-high";
  }
  if (bucket === "medium") {
    return "crowd-medium";
  }
  if (bucket === "low") {
    return "crowd-low";
  }
  return "crowd-unknown";
}

function crowdPillText(crowdData) {
  if (!crowdData) {
    return "Keine Live-Daten";
  }
  const level =
    crowdData.bucket === "high"
      ? "Voll"
      : crowdData.bucket === "medium"
        ? "Mittel"
        : "Ruhig";
  return `${level} (${crowdData.count})`;
}

function renderRecentsStrip() {
  if (!recentsStrip) {
    return;
  }
  const recentPlaces = state.history
    .map((entry) => state.places.find((place) => place.id === entry.id))
    .filter(Boolean)
    .slice(0, 4);

  if (recentPlaces.length === 0 || state.currentView !== "map") {
    recentsStrip.hidden = true;
    recentsStrip.innerHTML = "";
    return;
  }

  recentsStrip.hidden = false;
  recentsStrip.innerHTML = recentPlaces
    .map(
      (place) =>
        `<button class="recent-chip" data-recent-id="${place.id}" type="button">${escapeHtml(place.name)}</button>`
    )
    .join("");
}

function initOnboarding() {
  if (!onboardingBanner) {
    return;
  }
  const seen = localStorage.getItem(ONBOARDING_KEY) === "1";
  onboardingBanner.hidden = seen;
}

function updateRetryButton() {
  if (!retryButton) {
    return;
  }
  const canRetry = Boolean(state.lastFailedAction);
  retryButton.hidden = !canRetry;
}

function updateActionStates() {
  if (reloadButton) {
    reloadButton.disabled = state.isLoadingPlaces;
  }
  if (freshLoadButton) {
    freshLoadButton.disabled = state.isLoadingPlaces || state.isRouting;
  }
  if (locateButton) {
    locateButton.disabled = state.isLocating;
    locateButton.textContent = state.isLocating ? "Standort wird ermittelt..." : "Standort nutzen";
  }
  updatePrimaryActionState();
  updateRetryButton();
}

function setFailureState(action, statusMessage) {
  state.lastFailedAction = action;
  statusElement.textContent = statusMessage;
  updateActionStates();
}

function clearFailureState() {
  state.lastFailedAction = null;
  updateActionStates();
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || "Request fehlgeschlagen");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadBackendHealth() {
  try {
    const data = await apiRequest("/api/health", { method: "GET" });
    state.backendMode = data.mode || "unknown";
    if (state.backendMode === "memory") {
      statusElement.textContent =
        "Hinweis: Server läuft ohne Datenbank (temporärer Fallback-Modus).";
    }
  } catch {
    state.backendMode = "offline";
  }
}

async function loadCrowdForSpots(spotIds) {
  if (!Array.isArray(spotIds) || spotIds.length === 0) {
    return;
  }
  try {
    statusElement.textContent = "Live-Belegung wird geladen...";
    const encoded = encodeURIComponent(spotIds.join(","));
    const data = await apiRequest(`/api/crowd?spotIds=${encoded}`);
    state.crowdBySpotId = {
      ...state.crowdBySpotId,
      ...(data.spots || {}),
    };
    clearFailureState();
  } catch (error) {
    console.error(error);
    setFailureState("crowd", "Live-Belegung konnte nicht geladen werden");
  } finally {
    renderList();
  }
}

async function requireUserLocationForContribution() {
  if (!navigator.geolocation) {
    throw new Error("Standortfreigabe nötig, um Crowd beizutragen.");
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve([position.coords.latitude, position.coords.longitude]),
      () => reject(new Error("Standortfreigabe nötig, um Crowd beizutragen.")),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function checkInAtSpot(place) {
  try {
    statusElement.textContent = "Prüfe Standort für Check-in...";
    const [userLat, userLon] = await requireUserLocationForContribution();
    const response = await apiRequest("/api/presence/checkin", {
      method: "POST",
      body: JSON.stringify({
        userId: state.userId,
        spotId: place.id,
        spotLat: place.latLng[0],
        spotLon: place.latLng[1],
        userLat,
        userLon,
      }),
    });
    state.checkedInSpotId = place.id;
    state.crowdBySpotId[place.id] = {
      count: response.activeNow,
      bucket: response.bucket,
      confidence: "medium",
    };
    statusElement.textContent = "Du bist jetzt eingecheckt.";
    startHeartbeatLoop();
    renderList();
    updateSelectedSpotCard();
  } catch (error) {
    if (error.status === 403) {
      statusElement.textContent = "Du bist zu weit vom Spot entfernt.";
      return;
    }
    if (error.status === 429) {
      statusElement.textContent = "Zu viele Anfragen. Bitte kurz warten.";
      return;
    }
    if (error.status >= 500 || error.message.includes("Failed to fetch")) {
      statusElement.textContent = "Backend nicht erreichbar. Bitte Seite neu laden.";
      return;
    }
    statusElement.textContent = "Standortfreigabe nötig, um Crowd beizutragen.";
  }
}

async function checkOutFromSpot(place) {
  try {
    statusElement.textContent = "Checkout wird gesendet...";
    await apiRequest("/api/presence/checkout", {
      method: "POST",
      body: JSON.stringify({
        userId: state.userId,
        spotId: place.id,
      }),
    });
    if (state.checkedInSpotId === place.id) {
      state.checkedInSpotId = null;
    }
    statusElement.textContent = "Du bist ausgecheckt.";
    await loadCrowdForSpots([place.id]);
    startHeartbeatLoop();
  } catch (error) {
    console.error(error);
    statusElement.textContent = "Checkout fehlgeschlagen. Bitte erneut versuchen.";
  }
}

function startHeartbeatLoop() {
  if (state.heartbeatTimerId) {
    clearInterval(state.heartbeatTimerId);
    state.heartbeatTimerId = null;
  }
  if (!state.checkedInSpotId) {
    return;
  }
  state.heartbeatTimerId = setInterval(async () => {
    const spot = state.places.find((p) => p.id === state.checkedInSpotId);
    if (!spot) {
      return;
    }
    try {
      const [userLat, userLon] = await requireUserLocationForContribution();
      await apiRequest("/api/presence/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          userId: state.userId,
          spotId: spot.id,
          spotLat: spot.latLng[0],
          spotLon: spot.latLng[1],
          userLat,
          userLon,
        }),
      });
      await loadCrowdForSpots([spot.id]);
    } catch {
      // silent retry on next run
    }
  }, 5 * 60 * 1000);
}

function startCrowdRefreshLoop() {
  if (state.crowdRefreshTimerId) {
    clearInterval(state.crowdRefreshTimerId);
  }
  state.crowdRefreshTimerId = setInterval(() => {
    const visibleSpotIds = state.visiblePlaces.map((place) => place.id).slice(0, 100);
    if (visibleSpotIds.length > 0) {
      loadCrowdForSpots(visibleSpotIds);
    }
  }, 60 * 1000);
}

function selectPlace(place, { centerMap = false, openPopup = false } = {}) {
  state.selectedPlaceId = place.id;
  updatePrimaryActionState();
  renderList();
  if (centerMap) {
    map.setView(place.latLng, 16);
  }
  if (openPopup) {
    const firstMarker = place.markers[0]?.marker;
    if (firstMarker) {
      firstMarker.openPopup();
    }
  }
}

function loadSavedState() {
  try {
    const favoritesRaw = localStorage.getItem("crowdcourt:favorites");
    const historyRaw = localStorage.getItem("crowdcourt:history");
    if (favoritesRaw) {
      const parsedFavorites = JSON.parse(favoritesRaw);
      if (Array.isArray(parsedFavorites)) {
        state.favorites = new Set(parsedFavorites);
      }
    }
    if (historyRaw) {
      const parsedHistory = JSON.parse(historyRaw);
      if (Array.isArray(parsedHistory)) {
        state.history = parsedHistory.slice(0, 20);
      }
    }
    const commentsRaw = localStorage.getItem(COMMENTS_STORAGE_KEY);
    if (commentsRaw) {
      const parsedComments = JSON.parse(commentsRaw);
      if (parsedComments && typeof parsedComments === "object") {
        state.commentsByPlace = parsedComments;
      }
    }
  } catch (error) {
    console.error("Local storage konnte nicht gelesen werden", error);
  }
}

function saveFavorites() {
  localStorage.setItem("crowdcourt:favorites", JSON.stringify([...state.favorites]));
}

function saveHistory() {
  localStorage.setItem("crowdcourt:history", JSON.stringify(state.history.slice(0, 20)));
}

function saveComments() {
  localStorage.setItem(COMMENTS_STORAGE_KEY, JSON.stringify(state.commentsByPlace));
}

async function fetchOverpassData(query) {
  const cached = readOverpassCache();
  if (cached) {
    return cached;
  }
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: query,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Overpass Status ${response.status} bei ${endpoint}`);
      }
      const data = await response.json();
      writeOverpassCache(data);
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Keine Overpass API erreichbar");
}

function readOverpassCache() {
  try {
    const raw = localStorage.getItem(OVERPASS_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed?.savedAt || !parsed?.data) {
      return null;
    }
    if (Date.now() - parsed.savedAt > OVERPASS_CACHE_TTL_MS) {
      return null;
    }
    state.lastLoadedAt = parsed.savedAt;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeOverpassCache(data) {
  try {
    const payload = { savedAt: Date.now(), data };
    localStorage.setItem(OVERPASS_CACHE_KEY, JSON.stringify(payload));
    state.lastLoadedAt = payload.savedAt;
  } catch {
    // noop
  }
}

function buildOverpassQuery() {
  const sportsRegex = Object.keys(sportsConfig).join("|");
  const [lat, lon] = INNSBRUCK_CENTER;

  return `
[out:json][timeout:30];
(
  node["leisure"="pitch"]["sport"~"${sportsRegex}"](around:${SEARCH_RADIUS_METERS},${lat},${lon});
  way["leisure"="pitch"]["sport"~"${sportsRegex}"](around:${SEARCH_RADIUS_METERS},${lat},${lon});
  relation["leisure"="pitch"]["sport"~"${sportsRegex}"](around:${SEARCH_RADIUS_METERS},${lat},${lon});
  node["leisure"="sports_centre"]["sport"~"${sportsRegex}"](around:${SEARCH_RADIUS_METERS},${lat},${lon});
  way["leisure"="sports_centre"]["sport"~"${sportsRegex}"](around:${SEARCH_RADIUS_METERS},${lat},${lon});
  relation["leisure"="sports_centre"]["sport"~"${sportsRegex}"](around:${SEARCH_RADIUS_METERS},${lat},${lon});
);
out center;
`;
}

function getCoordinates(element) {
  if (typeof element.lat === "number" && typeof element.lon === "number") {
    return [element.lat, element.lon];
  }
  if (element.center?.lat && element.center?.lon) {
    return [element.center.lat, element.center.lon];
  }
  return null;
}

function getSportTypes(tagValue) {
  if (!tagValue) {
    return [];
  }
  const split = tagValue.split(";").map((s) => s.trim());
  return split.filter((sport) => sport in sportsConfig);
}

function markerForSport(latLng, sport, placeName, typeName) {
  const icon = L.divIcon({
    className: "custom-pin",
    html: `<span style="display:inline-block;width:12px;height:12px;border-radius:999px;background:${sportsConfig[sport].color};border:2px solid #fff;box-shadow:0 0 0 1px #11182733;"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  const marker = L.marker(latLng, { icon });
  marker.bindPopup(
    `<strong>${placeName}</strong><br>${typeName}<br><small>${sportsConfig[sport].label}</small>`
  );
  return marker;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clearMarkers() {
  state.markersBySport.forEach((markers) => {
    markers.forEach((marker) => map.removeLayer(marker));
  });
  state.markersBySport.clear();
}

function haversineDistanceMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function formatDistance(meters) {
  if (meters == null) {
    return "Distanz unbekannt";
  }
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function getCrowdLevel(placeId) {
  const crowdData = state.crowdBySpotId[placeId];
  return {
    label: crowdPillText(crowdData),
    className: crowdPillClass(crowdData?.bucket),
  };
}

function formatCommentTime(timestamp) {
  return new Date(timestamp).toLocaleString("de-AT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getCommentsForPlace(placeId) {
  const comments = state.commentsByPlace[placeId];
  return Array.isArray(comments) ? comments : [];
}

function addComment(placeId, comment) {
  const existing = getCommentsForPlace(placeId);
  const next = [comment, ...existing].slice(0, 20);
  state.commentsByPlace[placeId] = next;
  saveComments();
}

function getCommentSummary(placeId) {
  const comments = getCommentsForPlace(placeId);
  if (comments.length === 0) {
    return "Noch keine Community-Meldung";
  }
  const latest = comments[0];
  return `Zuletzt: ${latest.openStatusLabel}, ${latest.crowdStatusLabel}`;
}

function updateVisibilityAndList() {
  const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const visible = [];

  state.places.forEach((place) => {
    const hasActiveSport = place.sports.some((sport) =>
      state.activeSports.has(sport)
    );
    const matchesSearch =
      !searchTerm ||
      place.name.toLowerCase().includes(searchTerm) ||
      place.sportLabels.toLowerCase().includes(searchTerm);
    const isVisible = hasActiveSport && matchesSearch;

    place.markers.forEach((entry) => {
      if (state.activeSports.has(entry.sport) && isVisible) {
        entry.marker.addTo(map);
      } else {
        map.removeLayer(entry.marker);
      }
    });

    if (isVisible) {
      visible.push(place);
    }
  });

  state.visiblePlaces = visible.sort((a, b) => {
    if (a.distanceMeters == null && b.distanceMeters == null) {
      return a.name.localeCompare(b.name);
    }
    if (a.distanceMeters == null) {
      return 1;
    }
    if (b.distanceMeters == null) {
      return -1;
    }
    return a.distanceMeters - b.distanceMeters;
  });

  if (state.selectedPlaceId) {
    const stillVisible = state.visiblePlaces.some((place) => place.id === state.selectedPlaceId);
    if (!stillVisible && state.currentView === "map") {
      state.selectedPlaceId = null;
      updatePrimaryActionState();
    }
  }

  renderList();
  updateSelectedSpotCard();
  renderRecentsStrip();
  const visibleSpotIds = state.visiblePlaces.map((place) => place.id).slice(0, 100);
  if (visibleSpotIds.length > 0) {
    loadCrowdForSpots(visibleSpotIds);
  }
}

function getPlacesForCurrentView() {
  if (state.currentView === "favorites") {
    return state.visiblePlaces.filter((place) => state.favorites.has(place.id));
  }
  if (state.currentView === "history") {
    return state.history
      .map((entry) => state.places.find((place) => place.id === entry.id))
      .filter(Boolean);
  }
  return state.visiblePlaces;
}

function updatePanelState() {
  if (!panelTitle || !clearHistoryButton) {
    return;
  }
  if (state.currentView === "map") {
    panelTitle.textContent = "Spots in deiner Nähe";
    clearHistoryButton.style.display = "none";
    return;
  }
  if (state.currentView === "favorites") {
    panelTitle.textContent = "Deine Favoriten";
    clearHistoryButton.style.display = "none";
    return;
  }
  panelTitle.textContent = "Zuletzt angesehen";
  clearHistoryButton.style.display = "inline-flex";
}

function getEmptyStateText() {
  if (state.isLoadingPlaces) {
    return "";
  }
  if (state.currentView === "map") {
    if (state.activeSports.size === 0) {
      return "Wähle mindestens eine Sportart, um Spots zu sehen.";
    }
    return "Keine Spots für diese Filter gefunden.";
  }
  if (state.currentView === "favorites") {
    return "Du hast noch keine Favoriten gespeichert.";
  }
  return "Dein Verlauf ist noch leer.";
}

function getErrorStateText() {
  if (state.lastFailedAction === "load") {
    return "Spots konnten nicht geladen werden. Tippe auf 'Erneut versuchen'.";
  }
  if (state.lastFailedAction === "crowd") {
    return "Live-Belegung aktuell nicht verfügbar. Erneut versuchen.";
  }
  if (state.lastFailedAction === "route") {
    return "Route fehlgeschlagen. Wähle einen Spot und versuche es erneut.";
  }
  if (state.lastFailedAction === "location") {
    return "Standortzugriff fehlgeschlagen. Standortfreigabe prüfen und erneut versuchen.";
  }
  return "";
}

function renderLoadingSkeleton() {
  spotsList.innerHTML = "";
  for (let i = 0; i < 4; i += 1) {
    const item = document.createElement("li");
    item.className = "skeleton";
    spotsList.appendChild(item);
  }
}

function renderList() {
  spotsList.innerHTML = "";
  updatePanelState();
  setGuidanceText();
  if (state.isLoadingPlaces) {
    renderLoadingSkeleton();
    return;
  }
  const errorText = getErrorStateText();
  if (state.lastFailedAction === "load" && errorText) {
    spotsList.innerHTML = `<li class="error-state">${errorText}</li>`;
    return;
  }
  const placesForView = getPlacesForCurrentView();

  if (placesForView.length === 0) {
    spotsList.innerHTML = `<li class="empty-state">${getEmptyStateText()}</li>`;
    return;
  }

  placesForView.forEach((place) => {
    const item = document.createElement("li");
    item.className = "spot-item";
    const safeName = escapeHtml(place.name);
    const sportChips = place.sports
      .map((sport) => {
        const config = sportsConfig[sport];
        return `<span class="sport-chip">${config.icon} ${escapeHtml(config.label)}</span>`;
      })
      .join("");
    const dist = formatDistance(place.distanceMeters);
    const crowd = getCrowdLevel(place.id);
    const favoriteClass = state.favorites.has(place.id) ? "favorite-active" : "";
    const favoriteText = state.favorites.has(place.id) ? "Favorit" : "Merken";
    const selectedClass = place.id === state.selectedPlaceId ? "selected" : "";
    const comments = getCommentsForPlace(place.id);
    const isExpanded = state.expandedComments.has(place.id);
    const commentsHtml =
      comments.length === 0
        ? '<li class="comment-empty">Noch keine Kommentare. Teile den Status!</li>'
        : comments
            .slice(0, 3)
            .map(
              (comment) =>
                `<li class="comment-item"><div><strong>${escapeHtml(comment.openStatusLabel)}</strong> · ${escapeHtml(comment.crowdStatusLabel)}</div><p>${escapeHtml(comment.text)}</p><small>${formatCommentTime(comment.createdAt)}</small></li>`
            )
            .join("");

    item.innerHTML = `
      <div class="spot-head">
        <h3>${safeName}</h3>
        <span class="crowd-pill ${crowd.className}">Crowd: ${crowd.label}</span>
      </div>
      <p class="spot-meta">Entfernung: ${dist}</p>
      <p class="spot-meta">${getCommentSummary(place.id)}</p>
      <div class="sport-chips">${sportChips}</div>
      <div class="spot-actions">
        <button class="small-btn" data-action="zoom" data-id="${place.id}">Anzeigen</button>
        <button class="small-btn" type="button" data-action="select" data-id="${place.id}">Auswählen</button>
        <button class="small-btn" type="button" data-action="route" data-id="${place.id}">Route</button>
        <button class="small-btn ${favoriteClass}" type="button" data-action="favorite" data-id="${place.id}">💙 ${favoriteText}</button>
        <button class="small-btn" type="button" data-action="toggle-comments" data-id="${place.id}">
          ${isExpanded ? "Community einklappen" : "Community-Status"}
        </button>
        <button class="small-btn" type="button" data-action="checkin" data-id="${place.id}">
          ${state.checkedInSpotId === place.id ? "Eingecheckt" : "Ich bin hier"}
        </button>
        <button class="small-btn" type="button" data-action="checkout" data-id="${place.id}">Ich bin weg</button>
      </div>
      <div class="comment-block ${isExpanded ? "expanded" : ""}">
      <form class="comment-form" data-place-id="${place.id}">
        <label>
          Offen?
          <select name="openStatus" required>
            <option value="open">Geöffnet</option>
            <option value="closed">Geschlossen</option>
            <option value="unclear">Unsicher</option>
          </select>
        </label>
        <label>
          Auslastung
          <select name="crowdStatus" required>
            <option value="calm">Ruhig</option>
            <option value="medium">Mittel</option>
            <option value="busy">Voll</option>
          </select>
        </label>
        <label class="comment-text-label">
          Kommentar
          <input type="text" name="commentText" maxlength="220" placeholder="z. B. offen und nur wenig los" required />
        </label>
        <button class="small-btn" type="submit">Kommentar senden</button>
      </form>
      <ul class="comments-list">${commentsHtml}</ul>
      </div>
    `;
    item.classList.toggle("selected", Boolean(selectedClass));
    spotsList.appendChild(item);
  });
}

function recalculateDistances() {
  state.places.forEach((place) => {
    if (!state.userLocation) {
      place.distanceMeters = null;
      return;
    }
    place.distanceMeters = haversineDistanceMeters(state.userLocation, place.latLng);
  });
}

function updateUserLocationMarker() {
  if (!state.userLocation) {
    return;
  }
  if (state.userMarker) {
    map.removeLayer(state.userMarker);
  }
  state.userMarker = L.circleMarker(state.userLocation, {
    radius: 8,
    color: "#1d4ed8",
    fillColor: "#3b82f6",
    fillOpacity: 0.95,
    weight: 2,
  })
    .addTo(map)
    .bindPopup("Dein Standort");
}

function updateStatusText() {
  const total = state.places.length;
  const visible = state.visiblePlaces.length;
  if (state.activeSports.size === 0) {
    statusElement.textContent = `${total} Sportplätze gefunden - bitte Sportart auswählen`;
    return;
  }
  statusElement.textContent = `${total} Sportplätze gefunden (${visible} sichtbar)`;
}

function clearRouteDisplay() {
  if (state.routeLayer) {
    map.removeLayer(state.routeLayer);
    state.routeLayer = null;
  }
  if (state.routeTargetMarker) {
    map.removeLayer(state.routeTargetMarker);
    state.routeTargetMarker = null;
  }
  if (state.routeOriginMarker) {
    map.removeLayer(state.routeOriginMarker);
    state.routeOriginMarker = null;
  }
  if (routeInfoElement) {
    routeInfoElement.textContent = "";
  }
}

function formatRouteDistance(distanceMeters) {
  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

async function showRouteOnMap(destinationLatLng, destinationName) {
  if (state.isRouting) {
    return;
  }
  state.isRouting = true;
  updateActionStates();
  const originCoords = state.userLocation || DEFAULT_ROUTE_ORIGIN_COORDS;
  const originName = state.userLocation ? "Dein Standort" : `${DEFAULT_ROUTE_ORIGIN_NAME} (Fallback)`;
  const [originLat, originLon] = originCoords;
  const [destLat, destLon] = destinationLatLng;
  const routeUrl = `https://router.project-osrm.org/route/v1/foot/${originLon},${originLat};${destLon},${destLat}?overview=full&geometries=geojson`;

  if (routeInfoElement) {
    routeInfoElement.textContent = "Route wird berechnet...";
  }

  try {
    const response = await fetch(routeUrl);
    if (!response.ok) {
      throw new Error(`Routing API Status ${response.status}`);
    }
    const data = await response.json();
    const route = data.routes?.[0];
    if (!route?.geometry?.coordinates?.length) {
      throw new Error("Keine Route gefunden");
    }

    clearRouteDisplay();

    const latLngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    state.routeLayer = L.polyline(latLngs, {
      color: "#0b5fc6",
      weight: 5,
      opacity: 0.9,
      lineJoin: "round",
    }).addTo(map);

    state.routeOriginMarker = L.circleMarker(originCoords, {
      radius: 7,
      color: "#0f766e",
      fillColor: "#14b8a6",
      fillOpacity: 0.95,
      weight: 2,
    })
      .addTo(map)
      .bindPopup(`Start: ${originName}`);

    state.routeTargetMarker = L.circleMarker(destinationLatLng, {
      radius: 7,
      color: "#9f1239",
      fillColor: "#e11d48",
      fillOpacity: 0.95,
      weight: 2,
    })
      .addTo(map)
      .bindPopup(`Ziel: ${destinationName}`);

    const durationMinutes = Math.max(1, Math.round(route.duration / 60));
    if (routeInfoElement) {
      routeInfoElement.textContent = `Start: ${originName} - ${formatRouteDistance(route.distance)} - ca. ${durationMinutes} min`;
    }
    map.fitBounds(state.routeLayer.getBounds(), { padding: [35, 35] });
    clearFailureState();
  } catch (error) {
    console.error(error);
    if (routeInfoElement) {
      routeInfoElement.textContent = "Route konnte nicht geladen werden";
    }
    setFailureState("route", "Route konnte nicht geladen werden");
  } finally {
    state.isRouting = false;
    updateActionStates();
  }
}

function addToHistory(place) {
  state.history = [{ id: place.id, at: Date.now() }, ...state.history.filter((h) => h.id !== place.id)].slice(0, 20);
  saveHistory();
}

function getPlaceId(element) {
  const elementType = element.type || "element";
  return `${elementType}-${element.id}`;
}

function buildPlaces(elements) {
  const placeMap = new Map();

  elements.forEach((element) => {
    const latLng = getCoordinates(element);
    if (!latLng) {
      return;
    }
    const sports = getSportTypes(element.tags?.sport);
    if (sports.length === 0) {
      return;
    }
    const placeName =
      element.tags?.name || element.tags?.operator || "Sportplatz ohne Namen";
    const typeName = element.tags?.leisure || "Sportanlage";
    const id = getPlaceId(element);

    if (!placeMap.has(id)) {
      placeMap.set(id, {
        id,
        name: placeName,
        typeName,
        sports: [...sports],
        sportLabels: sports.map((sport) => sportsConfig[sport].label).join(", "),
        latLng,
        distanceMeters: null,
        markers: [],
      });
      return;
    }

    const existing = placeMap.get(id);
    const combined = [...new Set([...existing.sports, ...sports])];
    existing.sports = combined;
    existing.sportLabels = combined
      .map((sport) => sportsConfig[sport].label)
      .join(", ");
  });

  return Array.from(placeMap.values());
}

function attachMarkersToPlaces() {
  state.places.forEach((place) => {
    place.sports.forEach((sport) => {
      const marker = markerForSport(place.latLng, sport, place.name, place.typeName);
      marker.on("click", () => {
        selectPlace(place, { openPopup: true });
        addToHistory(place);
        if (state.currentView === "history") {
          renderList();
        }
      });
      place.markers.push({ sport, marker });
      if (!state.markersBySport.has(sport)) {
        state.markersBySport.set(sport, []);
      }
      state.markersBySport.get(sport).push(marker);
    });
  });
}

function setupListActions() {
  spotsList.addEventListener("submit", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) {
      return;
    }
    if (!target.classList.contains("comment-form")) {
      return;
    }
    event.preventDefault();
    const placeId = target.dataset.placeId;
    if (!placeId) {
      return;
    }
    const formData = new FormData(target);
    const openStatus = String(formData.get("openStatus") || "");
    const crowdStatus = String(formData.get("crowdStatus") || "");
    const commentTextRaw = String(formData.get("commentText") || "").trim();
    if (!openStatus || !crowdStatus || !commentTextRaw) {
      return;
    }

    const openStatusMap = {
      open: "Geöffnet",
      closed: "Geschlossen",
      unclear: "Unsicher",
    };
    const crowdStatusMap = {
      calm: "Ruhig",
      medium: "Mittel",
      busy: "Voll",
    };

    addComment(placeId, {
      openStatus,
      crowdStatus,
      openStatusLabel: openStatusMap[openStatus] || "Unbekannt",
      crowdStatusLabel: crowdStatusMap[crowdStatus] || "Unbekannt",
      text: commentTextRaw,
      createdAt: Date.now(),
    });
    renderList();
  });

  spotsList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (!action || !id) {
      return;
    }
    const place = state.places.find((p) => p.id === id);
    if (!place) {
      return;
    }

    if (action === "zoom") {
      selectPlace(place, { centerMap: true, openPopup: true });
      addToHistory(place);
      if (state.currentView === "history") {
        renderList();
      }
      return;
    }
    if (action === "select") {
      selectPlace(place, { centerMap: true, openPopup: true });
      addToHistory(place);
      if (state.currentView === "history") {
        renderList();
      }
      return;
    }
    if (action === "route") {
      selectPlace(place, { centerMap: true, openPopup: true });
      showRouteOnMap(place.latLng, place.name);
      state.lastRoutedPlaceId = place.id;
      addToHistory(place);
      if (state.currentView === "history") {
        renderList();
      }
      return;
    }
    if (action === "favorite") {
      if (state.favorites.has(place.id)) {
        state.favorites.delete(place.id);
      } else {
        state.favorites.add(place.id);
      }
      saveFavorites();
      renderList();
      return;
    }
    if (action === "toggle-comments") {
      if (state.expandedComments.has(place.id)) {
        state.expandedComments.delete(place.id);
      } else {
        state.expandedComments.add(place.id);
      }
      renderList();
      return;
    }
    if (action === "checkin") {
      checkInAtSpot(place);
      return;
    }
    if (action === "checkout") {
      checkOutFromSpot(place);
    }
  });
}

function setView(view) {
  state.currentView = view;
  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  renderList();
  resetListScroll();
  renderRecentsStrip();
}

function requestUserLocation() {
  if (!navigator.geolocation) {
    setFailureState("location", "Geolocation wird von diesem Browser nicht unterstützt");
    return;
  }
  state.isLocating = true;
  updateActionStates();

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.userLocation = [position.coords.latitude, position.coords.longitude];
      updateUserLocationMarker();
      recalculateDistances();
      updateVisibilityAndList();
      updateStatusText();
      map.setView(state.userLocation, 13);
      clearFailureState();
      state.isLocating = false;
      updateActionStates();
    },
    () => {
      state.isLocating = false;
      setFailureState("location", "Standort konnte nicht ermittelt werden");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function wireEvents() {
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      if (searchDebounceId) {
        window.clearTimeout(searchDebounceId);
      }
      searchDebounceId = window.setTimeout(() => {
        updateVisibilityAndList();
        updateStatusText();
      }, 200);
    });
  }

  if (clearFiltersButton) {
    clearFiltersButton.addEventListener("click", () => {
      state.activeSports.clear();
      filterButtons.forEach((button) => button.classList.remove("active"));
      state.selectedPlaceId = null;
      updateVisibilityAndList();
      updateStatusText();
    });
  }

  if (locateButton) {
    locateButton.addEventListener("click", () => {
      requestUserLocation();
    });
  }

  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      if (!view) {
        return;
      }
      setView(view);
    });
  });

  if (clearHistoryButton) {
    clearHistoryButton.addEventListener("click", () => {
      state.history = [];
      saveHistory();
      renderList();
    });
  }

  if (chooseLocationButton) {
    chooseLocationButton.addEventListener("click", () => {
      const selected = getSelectedPlace();
      if (!selected) {
        setFailureState("route", "Bitte zuerst einen Spot auswählen");
        return;
      }
      showRouteOnMap(selected.latLng, selected.name);
      state.lastRoutedPlaceId = selected.id;
      addToHistory(selected);
      if (state.currentView === "history") {
        renderList();
      }
    });
  }

  if (selectedRouteButton) {
    selectedRouteButton.addEventListener("click", () => {
      const selected = getSelectedPlace();
      if (!selected) {
        setFailureState("route", "Bitte zuerst einen Spot auswählen");
        return;
      }
      showRouteOnMap(selected.latLng, selected.name);
      state.lastRoutedPlaceId = selected.id;
      addToHistory(selected);
      renderRecentsStrip();
    });
  }

  if (selectedCheckinButton) {
    selectedCheckinButton.addEventListener("click", () => {
      const selected = getSelectedPlace();
      if (!selected) {
        statusElement.textContent = "Bitte zuerst einen Spot auswählen.";
        return;
      }
      checkInAtSpot(selected);
    });
  }

  if (selectedCheckoutButton) {
    selectedCheckoutButton.addEventListener("click", () => {
      const selected = getSelectedPlace();
      if (!selected) {
        statusElement.textContent = "Bitte zuerst einen Spot auswählen.";
        return;
      }
      checkOutFromSpot(selected);
    });
  }

  if (retryButton) {
    retryButton.addEventListener("click", () => {
      if (state.lastFailedAction === "load") {
        loadSportsPlaces();
        return;
      }
      if (state.lastFailedAction === "route") {
        const selected = getSelectedPlace();
        if (selected) {
          showRouteOnMap(selected.latLng, selected.name);
        }
        return;
      }
      if (state.lastFailedAction === "location") {
        requestUserLocation();
        return;
      }
      if (state.lastFailedAction === "crowd") {
        const spotIds = state.visiblePlaces.map((place) => place.id).slice(0, 100);
        if (spotIds.length > 0) {
          loadCrowdForSpots(spotIds);
        }
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    clearRouteDisplay();
    map.closePopup();
  });

  if (recentsStrip) {
    recentsStrip.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }
      const placeId = target.dataset.recentId;
      if (!placeId) {
        return;
      }
      const place = state.places.find((item) => item.id === placeId);
      if (!place) {
        return;
      }
      selectPlace(place, { centerMap: true, openPopup: true });
    });
  }

  if (dismissOnboardingButton && onboardingBanner) {
    dismissOnboardingButton.addEventListener("click", () => {
      onboardingBanner.hidden = true;
      localStorage.setItem(ONBOARDING_KEY, "1");
    });
  }
}

async function loadSportsPlaces() {
  state.isLoadingPlaces = true;
  updateActionStates();
  statusElement.textContent = "Lade Daten aus OpenStreetMap...";
  clearMarkers();
  state.places = [];
  state.visiblePlaces = [];
  state.selectedPlaceId = null;
  spotsList.innerHTML = "";
  if (routeInfoElement) {
    routeInfoElement.textContent = "";
  }
  renderList();

  try {
    const data = await fetchOverpassData(buildOverpassQuery());
    const elements = Array.isArray(data.elements) ? data.elements : [];
    state.places = buildPlaces(elements);
    recalculateDistances();
    attachMarkersToPlaces();
    updateVisibilityAndList();
    const spotIds = state.places.map((place) => place.id).slice(0, 100);
    if (spotIds.length > 0) {
      await loadCrowdForSpots(spotIds);
    }
    updateStatusText();
    updateLastUpdatedLabel();
    clearFailureState();
  } catch (error) {
    setFailureState("load", "Fehler beim Laden der Daten (API gerade langsam)");
    console.error(error);
  } finally {
    state.isLoadingPlaces = false;
    renderList();
    updateActionStates();
  }
}

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const sport = button.dataset.sport;
    if (!sport) {
      return;
    }

    if (state.activeSports.has(sport)) {
      state.activeSports.delete(sport);
      button.classList.remove("active");
    } else {
      state.activeSports.add(sport);
      button.classList.add("active");
    }

    updateVisibilityAndList();
    updateStatusText();
  });
});

if (reloadButton) {
  reloadButton.addEventListener("click", () => {
    loadSportsPlaces();
  });
}

if (freshLoadButton) {
  freshLoadButton.addEventListener("click", () => {
    const freshUrl = `${window.location.origin}${window.location.pathname}?v=${Date.now()}`;
    window.location.assign(freshUrl);
  });
}

setupListActions();
loadSavedState();
state.userId = getOrCreateUserId();
initOnboarding();
wireEvents();
updateActionStates();
startCrowdRefreshLoop();
loadBackendHealth().finally(() => {
  loadSportsPlaces();
});
