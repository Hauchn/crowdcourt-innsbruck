const INNSBRUCK_CENTER = [47.2692, 11.4041];
const SEARCH_RADIUS_METERS = 15000;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const OVERPASS_CACHE_KEY = "crowdcourt:overpass-cache-v1";
const OVERPASS_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const ONBOARDING_KEY = "crowdcourt:onboarding-seen";
const COMMENTS_STORAGE_KEY = "crowdcourt:spot-comments-v1";
const COMMUNITY_FRIENDS_KEY = "crowdcourt:community-friends-v1";
const COMMUNITY_MEETUPS_KEY = "crowdcourt:community-meetups-v1";
const USER_ID_KEY = "crowdcourt:user-id-v1";
const AUTO_PRESENCE_OPTIN_KEY = "crowdcourt:auto-presence-optin-v1";

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
  currentView: "home",
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
  autoPresenceOptIn: false,
  communityFriends: [],
  communityMeetups: [],
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
const presenceOptinToggle = document.getElementById("presence-optin-toggle");
const searchInput = document.getElementById("search-input");
const spotsList = document.getElementById("spots-list");
const navButtons = document.querySelectorAll(".nav-btn");
const panelTitle = document.getElementById("panel-title");
const clearHistoryButton = document.getElementById("clear-history-btn");
const chooseLocationButton = document.getElementById("choose-location-btn");
const homeHub = document.getElementById("home-hub");
const communityHub = document.getElementById("community-hub");
const mapStage = document.querySelector(".map-stage");
const contentSection = document.querySelector(".content");
const friendForm = document.getElementById("friend-form");
const meetupForm = document.getElementById("meetup-form");
const friendNameInput = document.getElementById("friend-name-input");
const meetupSpotInput = document.getElementById("meetup-spot-input");
const meetupTimeInput = document.getElementById("meetup-time-input");
const meetupNoteInput = document.getElementById("meetup-note-input");
const friendsList = document.getElementById("friends-list");
const meetupsList = document.getElementById("meetups-list");
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
const closeButton = document.querySelector(".close-btn");
const layoutElement = document.querySelector(".layout");
let searchDebounceId = null;

function getViewFromHash() {
  const hash = String(window.location.hash || "").replace(/^#\/?/, "");
  if (hash === "map" || hash === "favorites" || hash === "home" || hash === "community") {
    return hash;
  }
  return "home";
}

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
  chooseLocationButton.dataset.state = hasSelection ? "ready" : "idle";
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
  if (state.currentView === "home") {
    viewGuidanceElement.textContent = "Start: Sport wählen und dann Karte, Favoriten oder Community öffnen.";
    return;
  }
  const selectedPlace = getSelectedPlace();
  if (state.currentView === "map") {
    if (!selectedPlace) {
      viewGuidanceElement.textContent = "Nächster Schritt: Spot auswählen, um die Route zu starten.";
      return;
    }
    viewGuidanceElement.textContent = `Nächster Schritt: Route zu ${selectedPlace.name} starten.`;
    return;
  }
  if (state.currentView === "favorites") {
    viewGuidanceElement.textContent = "Markiere Spots, um sie hier schnell wiederzufinden.";
    return;
  }
  if (state.currentView === "community") {
    viewGuidanceElement.textContent = "Community: Freunde hinzufügen und Treffpunkte planen.";
    return;
  }
  viewGuidanceElement.textContent = "Zuletzt geöffnete Spots erscheinen hier für den schnellen Wiedereinstieg.";
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
  const sportsMarkup = selected.sports
    .map((sport) => {
      const config = sportsConfig[sport];
      if (!config) {
        return "";
      }
      return `<span class="sport-chip">${config.icon} ${escapeHtml(config.label)}</span>`;
    })
    .filter(Boolean)
    .join("");
  const crowdData = state.crowdBySpotId[selected.id];
  const crowdLabel = crowdData
    ? `<span class="crowd-pill ${crowdPillClass(crowdData.bucket)}">Live: ${escapeHtml(crowdPillText(crowdData))}</span>`
    : '<span class="crowd-pill crowd-unknown">Keine Live-Daten</span>';
  const confidenceHint = crowdData?.confidence
    ? `<span class="crowd-confidence">Verlässlichkeit: ${escapeHtml(crowdConfidenceText(crowdData.confidence))}</span>`
    : "";
  selectedSportsElement.innerHTML = `${sportsMarkup}${crowdLabel}${confidenceHint}`;
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

function crowdConfidenceText(confidence) {
  if (confidence === "high") {
    return "hoch";
  }
  if (confidence === "medium") {
    return "mittel";
  }
  return "niedrig";
}

function crowdFreshnessText(freshnessSeconds) {
  if (typeof freshnessSeconds !== "number") {
    return "Aktualität unbekannt";
  }
  if (freshnessSeconds < 60) {
    return "vor <1 min aktualisiert";
  }
  const minutes = Math.round(freshnessSeconds / 60);
  return `vor ${minutes} min aktualisiert`;
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
        `<button class="recent-chip ${state.selectedPlaceId === place.id ? "active" : ""}" data-recent-id="${place.id}" type="button">${escapeHtml(place.name)}</button>`
    )
    .join("");
}

function initOnboarding() {
  if (!onboardingBanner) {
    return;
  }
  const seen = localStorage.getItem(ONBOARDING_KEY) === "1";
  if (seen) {
    onboardingBanner.remove();
    return;
  }
  onboardingBanner.hidden = false;
  if (dismissOnboardingButton) {
    dismissOnboardingButton.onclick = (event) => {
      event.preventDefault();
      dismissOnboarding();
    };
  }
}

function dismissOnboarding() {
  if (!onboardingBanner) {
    return;
  }
  localStorage.setItem(ONBOARDING_KEY, "1");
  onboardingBanner.remove();
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
  if (retryButton) {
    const labelByAction = {
      load: "Spots neu laden",
      route: "Route erneut versuchen",
      location: "Standort erneut anfragen",
      crowd: "Live-Daten neu laden",
    };
    retryButton.textContent = labelByAction[state.lastFailedAction] || "Erneut versuchen";
  }
  if (chooseLocationButton) {
    chooseLocationButton.hidden = state.currentView !== "map";
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
    const freshnessValues = Object.values(data.spots || {})
      .map((entry) => entry?.freshnessSeconds)
      .filter((value) => typeof value === "number");
    if (freshnessValues.length > 0) {
      const freshest = Math.min(...freshnessValues);
      lastUpdatedElement.textContent = `Live: ${crowdFreshnessText(freshest)}`;
    }
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

async function ensureRoutingOrigin() {
  if (state.userLocation) {
    return state.userLocation;
  }
  const [lat, lon] = await requireUserLocationForContribution();
  state.userLocation = [lat, lon];
  updateUserLocationMarker();
  recalculateDistances();
  updateVisibilityAndList();
  return state.userLocation;
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
  if (!state.autoPresenceOptIn) {
    return;
  }
  state.heartbeatTimerId = setInterval(async () => {
    if (document.visibilityState !== "visible") {
      return;
    }
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
    if (document.visibilityState !== "visible") {
      return;
    }
    const visibleSpotIds = state.visiblePlaces.map((place) => place.id).slice(0, 100);
    if (visibleSpotIds.length > 0) {
      loadCrowdForSpots(visibleSpotIds);
    }
  }, 60 * 1000);
}

function selectPlace(place, { centerMap = false, openPopup = false } = {}) {
  state.selectedPlaceId = place.id;
  statusElement.textContent = `Spot ausgewählt: ${place.name}. Du kannst jetzt die Route starten.`;
  updatePrimaryActionState();
  renderList();
  renderRecentsStrip();
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

function focusVisiblePlacesOnMap() {
  if (state.currentView !== "map" || state.visiblePlaces.length === 0) {
    return;
  }
  const bounds = L.latLngBounds(state.visiblePlaces.slice(0, 120).map((place) => place.latLng));
  if (!bounds.isValid()) {
    return;
  }
  map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
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
    const friendsRaw = localStorage.getItem(COMMUNITY_FRIENDS_KEY);
    if (friendsRaw) {
      const parsedFriends = JSON.parse(friendsRaw);
      if (Array.isArray(parsedFriends)) {
        state.communityFriends = parsedFriends.slice(0, 50);
      }
    }
    const meetupsRaw = localStorage.getItem(COMMUNITY_MEETUPS_KEY);
    if (meetupsRaw) {
      const parsedMeetups = JSON.parse(meetupsRaw);
      if (Array.isArray(parsedMeetups)) {
        state.communityMeetups = parsedMeetups.slice(0, 80);
      }
    }
    state.autoPresenceOptIn = localStorage.getItem(AUTO_PRESENCE_OPTIN_KEY) === "1";
  } catch (error) {
    console.error("Local storage konnte nicht gelesen werden", error);
  }
}

function syncAutoPresenceUI() {
  if (!presenceOptinToggle) {
    return;
  }
  presenceOptinToggle.checked = state.autoPresenceOptIn;
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

function saveCommunity() {
  localStorage.setItem(COMMUNITY_FRIENDS_KEY, JSON.stringify(state.communityFriends.slice(0, 50)));
  localStorage.setItem(COMMUNITY_MEETUPS_KEY, JSON.stringify(state.communityMeetups.slice(0, 80)));
}

function renderCommunity() {
  if (friendsList) {
    if (state.communityFriends.length === 0) {
      friendsList.innerHTML = "<li>Noch keine Freunde gespeichert.</li>";
    } else {
      friendsList.innerHTML = state.communityFriends
        .slice(0, 12)
        .map((friend) => `<li>👤 ${escapeHtml(friend.name)}</li>`)
        .join("");
    }
  }

  if (meetupsList) {
    if (state.communityMeetups.length === 0) {
      meetupsList.innerHTML = "<li>Noch keine Treffen geplant.</li>";
    } else {
      meetupsList.innerHTML = state.communityMeetups
        .slice(0, 12)
        .map(
          (meetup) =>
            `<li>📍 <strong>${escapeHtml(meetup.spot)}</strong> · ${escapeHtml(meetup.time)}<br><span>${escapeHtml(meetup.note || "Ohne Notiz")}</span></li>`
        )
        .join("");
    }
  }
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
  const confidenceLabel = crowdData?.confidence
    ? `, Verlässlichkeit ${crowdConfidenceText(crowdData.confidence)}`
    : "";
  return {
    label: `${crowdPillText(crowdData)}${confidenceLabel}`,
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
    if (!stillVisible) {
      state.selectedPlaceId = null;
      if (state.currentView === "map") {
        statusElement.textContent = "Auswahl zurückgesetzt: Spot passt nicht mehr zu den aktiven Filtern.";
      }
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
  if (state.currentView === "favorites") {
    panelTitle.textContent = "Deine Favoriten";
    clearHistoryButton.style.display = "none";
    return;
  }
  panelTitle.textContent = "Spots in deiner Nähe";
  clearHistoryButton.style.display = "none";
}

function getEmptyStateText() {
  if (state.isLoadingPlaces) {
    return "";
  }
  const searchTerm = String(searchInput?.value || "").trim();
  if (state.currentView === "map") {
    if (state.places.length === 0) {
      return "Noch keine Daten geladen. Tippe auf 'Neu laden', um Spots abzurufen.";
    }
    if (searchTerm && state.visiblePlaces.length === 0) {
      return `Keine Treffer für "${searchTerm}". Suche anpassen oder Filter zurücksetzen.`;
    }
    if (state.activeSports.size === 0) {
      return "Wähle mindestens eine Sportart, um Spots zu sehen.";
    }
    return "Keine Spots für diese Filter gefunden. Filter lockern oder neu laden.";
  }
  if (state.currentView === "favorites") {
    return "Du hast noch keine Favoriten gespeichert. Tippe bei einem Spot auf 'Merken'.";
  }
  return "Dein Verlauf ist noch leer. Oeffne einen Spot, damit er hier erscheint.";
}

function getErrorStateText() {
  if (state.lastFailedAction === "load") {
    return "Spots konnten nicht geladen werden. Nutze den Retry-Button für einen neuen Abruf.";
  }
  if (state.lastFailedAction === "crowd") {
    return "Live-Belegung aktuell nicht verfügbar. Starte den Abruf erneut.";
  }
  if (state.lastFailedAction === "route") {
    return "Route fehlgeschlagen. Spot prüfen und erneut starten.";
  }
  if (state.lastFailedAction === "location") {
    return "Standortzugriff fehlgeschlagen. Freigabe prüfen und Standort erneut anfragen.";
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
  try {
    const originCoords = await ensureRoutingOrigin();
    const originName = "Dein Standort";
    const [originLat, originLon] = originCoords;
    const [destLat, destLon] = destinationLatLng;
    const routeUrl = `https://router.project-osrm.org/route/v1/foot/${originLon},${originLat};${destLon},${destLat}?overview=full&geometries=geojson`;

    if (routeInfoElement) {
      routeInfoElement.textContent = "Route wird berechnet...";
    }

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
    if (String(error?.message || "").includes("Standortfreigabe nötig")) {
      if (routeInfoElement) {
        routeInfoElement.textContent = "Standortfreigabe nötig, um Route zu starten.";
      }
      setFailureState("location", "Standortfreigabe nötig, um Route zu starten.");
    } else {
      if (routeInfoElement) {
        routeInfoElement.textContent = "Route konnte nicht geladen werden";
      }
      setFailureState("route", "Route konnte nicht geladen werden");
    }
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

function setView(view, { syncHash = true } = {}) {
  state.currentView = view;
  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  if (layoutElement) {
    layoutElement.classList.remove("view-home", "view-map", "view-favorites");
    layoutElement.classList.add(`view-${view}`);
  }
  if (homeHub) {
    homeHub.hidden = view !== "home";
  }
  if (communityHub) {
    communityHub.hidden = view !== "community";
  }
  if (mapStage) {
    mapStage.hidden = view !== "map";
  }
  if (contentSection) {
    contentSection.hidden = view === "home" || view === "community";
  }
  renderCommunity();
  renderList();
  resetListScroll();
  renderRecentsStrip();
  setGuidanceText();
  updateActionStates();
  if (syncHash) {
    window.location.hash = `/${view}`;
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "map") {
    window.setTimeout(() => {
      map.invalidateSize();
      if (!state.userLocation) {
        map.setView(INNSBRUCK_CENTER, 12);
      }
    }, 80);
    window.setTimeout(() => {
      map.invalidateSize();
    }, 220);
  }
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

  if (presenceOptinToggle) {
    presenceOptinToggle.addEventListener("change", () => {
      state.autoPresenceOptIn = presenceOptinToggle.checked;
      localStorage.setItem(AUTO_PRESENCE_OPTIN_KEY, state.autoPresenceOptIn ? "1" : "0");
      if (state.autoPresenceOptIn) {
        statusElement.textContent = "Auto-Presence aktiv: Live-Daten werden im Vordergrund aktualisiert.";
      } else {
        statusElement.textContent = "Auto-Presence deaktiviert: nur manuelle Check-ins bleiben aktiv.";
      }
      startHeartbeatLoop();
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

  if (homeHub) {
    homeHub.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }
      const action = target.dataset.homeAction;
      if (action === "map" || action === "favorites" || action === "community") {
        setView(action);
      }
    });
  }

  if (friendForm) {
    friendForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = String(friendNameInput?.value || "").trim();
      if (!name) {
        return;
      }
      state.communityFriends = [{ name, createdAt: Date.now() }, ...state.communityFriends].slice(0, 50);
      saveCommunity();
      renderCommunity();
      if (friendNameInput) {
        friendNameInput.value = "";
      }
      statusElement.textContent = `Freund hinzugefügt: ${name}`;
    });
  }

  if (meetupForm) {
    meetupForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const spot = String(meetupSpotInput?.value || "").trim();
      const time = String(meetupTimeInput?.value || "").trim();
      const note = String(meetupNoteInput?.value || "").trim();
      if (!spot || !time) {
        return;
      }
      state.communityMeetups = [{ spot, time, note, createdAt: Date.now() }, ...state.communityMeetups].slice(0, 80);
      saveCommunity();
      renderCommunity();
      if (meetupSpotInput) {
        meetupSpotInput.value = "";
      }
      if (meetupTimeInput) {
        meetupTimeInput.value = "";
      }
      if (meetupNoteInput) {
        meetupNoteInput.value = "";
      }
      statusElement.textContent = `Treffen geplant: ${spot} um ${time}`;
    });
  }

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
      addToHistory(place);
    });
  }

  if (dismissOnboardingButton && onboardingBanner) {
    dismissOnboardingButton.addEventListener("click", () => {
      dismissOnboarding();
    });
  }

  if (closeButton) {
    closeButton.addEventListener("click", () => {
      clearRouteDisplay();
      map.closePopup();
      state.selectedPlaceId = null;
      renderList();
      updateSelectedSpotCard();
      updatePrimaryActionState();
      setGuidanceText();
      statusElement.textContent = "Auswahl und Route wurden zurückgesetzt.";
    });
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target.id === "dismiss-onboarding-btn") {
      event.preventDefault();
      dismissOnboarding();
    }
  });
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
    if (state.currentView === "map") {
      if (state.visiblePlaces.length > 0) {
        focusVisiblePlacesOnMap();
      } else {
        statusElement.textContent =
          "Keine Spots mit diesen Filtern gefunden. Andere Sportart wählen oder Suche leeren.";
      }
    }
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
syncAutoPresenceUI();
initOnboarding();
wireEvents();
window.addEventListener("hashchange", () => {
  const nextView = getViewFromHash();
  if (nextView !== state.currentView) {
    setView(nextView, { syncHash: false });
  }
});
setView(getViewFromHash(), { syncHash: false });
updateActionStates();
startCrowdRefreshLoop();
loadBackendHealth().finally(() => {
  loadSportsPlaces();
});
