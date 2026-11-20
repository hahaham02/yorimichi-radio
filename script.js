const RADIUS_METERS = 500;
const REFRESH_DISTANCE_METERS = 120;
const REFRESH_INTERVAL_MS = 45000;
const STORY_GAP_MS = 18000;
const API_TIMEOUT_MS = 18000;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const elements = {
  playButton: document.querySelector("#play-button"),
  playLabel: document.querySelector("#play-label"),
  playIcon: document.querySelector(".play-icon"),
  playerCard: document.querySelector(".player-card"),
  stopButton: document.querySelector("#stop-button"),
  previousStoryButton: document.querySelector("#previous-story"),
  nextStoryButton: document.querySelector("#next-story"),
  storyPosition: document.querySelector("#story-position"),
  locationLabel: document.querySelector("#location-label"),
  distanceLabel: document.querySelector("#distance-label"),
  onAir: document.querySelector(".on-air"),
  onAirLabel: document.querySelector("#on-air-label"),
  trackKicker: document.querySelector("#track-kicker"),
  trackTitle: document.querySelector("#track-title"),
  trackDescription: document.querySelector("#track-description"),
  progressBar: document.querySelector("#progress-bar"),
  storyCount: document.querySelector("#story-count"),
  sectionStatus: document.querySelector("#section-status"),
  storyList: document.querySelector("#story-list"),
  announcer: document.querySelector("#announcer"),
};

const state = {
  active: false,
  paused: false,
  watchId: null,
  position: null,
  lastSearch: null,
  lastSearchAt: 0,
  stories: [],
  spoken: new Set(),
  currentStoryId: null,
  selectedStoryId: null,
  speechToken: 0,
  startedSpeechToken: 0,
  speechStartTimer: null,
  audioStarted: false,
  scanController: null,
  timer: null,
  wakeLock: null,
  sourceErrors: [],
};

function setStatus(message, announce = false) {
  elements.sectionStatus.textContent = message;
  if (announce) {
    elements.announcer.textContent = message;
  }
}

function setOnAir(message, playing = false) {
  elements.onAirLabel.textContent = message;
  elements.onAir.classList.toggle("is-playing", playing);
  elements.playerCard.classList.toggle("is-playing", playing);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatDistance(distance) {
  return distance < 1000 ? `${Math.round(distance / 10) * 10}m` : `${(distance / 1000).toFixed(1)}km`;
}

function distanceBetween(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(first.latitude);
  const lat2 = radians(second.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(second.longitude - first.longitude);
  const arc = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function stableId(story) {
  return `${story.source}:${story.id}`;
}

function getVoiceForLanguage(language) {
  const voices = window.speechSynthesis.getVoices();
  const normalizedLanguage = language.toLowerCase();
  const matchingVoices = voices.filter((voice) =>
    voice.lang.toLowerCase() === normalizedLanguage
      || voice.lang.toLowerCase().startsWith(`${normalizedLanguage.split("-")[0]}-`));
  return matchingVoices.find((voice) => /natural|neural|online|premium/i.test(voice.name))
    ?? matchingVoices.find((voice) => voice.default)
    ?? matchingVoices[0];
}

function isEnglishStory(story) {
  return story.source === "wikipedia" && story.sourceLabel.includes("English");
}

function spokenSummary(story) {
  const text = (story.narration || story.summary || "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = text.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [];
  const selected = [];
  let length = 0;
  for (const sentence of sentences) {
    const part = sentence.trim();
    if (!part) continue;
    if (selected.length >= 3 || length + part.length > 240) break;
    selected.push(part);
    length += part.length;
  }
  if (selected.length) return selected.join(" ");
  return text.slice(0, 240).trim();
}

function buildNarration(story) {
  const summary = spokenSummary(story);
  const english = isEnglishStory(story);
  const walkingDistance = story.distance < 30
    ? english ? "It's just nearby." : "すぐそばです。"
    : story.distance < 100
      ? english ? "It's about a minute's walk from here." : "歩いて1分ほどです。"
      : english
        ? `It's about a ${Math.max(1, Math.round(story.distance / 80))}-minute walk from here.`
        : `ここから歩いて${Math.max(1, Math.round(story.distance / 80))}分ほどです。`;

  if (english) {
    return `Coming up on our walk: ${story.title}. ${summary} ${walkingDistance}`;
  }
  return `さて、今回のよりみちは「${story.title}」です。${summary} ${walkingDistance}`;
}

function renderStories() {
  const sorted = getOrderedStories();
  elements.storyCount.textContent = `${sorted.length} ${sorted.length === 1 ? "SPOT" : "SPOTS"}`;
  elements.distanceLabel.textContent = state.position
    ? `近くに ${sorted.length} 件のスポット`
    : "位置情報はまだありません";

  elements.storyList.innerHTML = sorted.map((story, index) => {
    const url = story.url ? `<a class="story-source" href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(story.sourceLabel)}で読む ↗</a>` : "";
    const summary = story.summary ? `<span class="story-summary">${escapeHtml(story.summary)}</span>` : "";
    return `<li class="story-card">
      <button class="story-select-button" type="button" data-story-id="${escapeHtml(stableId(story))}" aria-pressed="${stableId(story) === state.selectedStoryId}">
        <span class="story-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="story-content">
          <span class="story-label">${escapeHtml(story.category)}</span>
          <span class="story-title">${escapeHtml(story.title)}</span>
          ${summary}
        </span>
        <span class="story-distance">${formatDistance(story.distance)}</span>
      </button>
      ${url}
    </li>`;
  }).join("");
  updateStoryNavigation(sorted);
}

function getOrderedStories() {
  return [...state.stories].sort((a, b) => a.distance - b.distance);
}

function updateStoryNavigation(stories = getOrderedStories()) {
  const selectedIndex = stories.findIndex((story) => stableId(story) === state.selectedStoryId);
  const hasSelection = selectedIndex !== -1;
  elements.storyPosition.textContent = hasSelection
    ? `${selectedIndex + 1} / ${stories.length}`
    : `— / ${stories.length || "—"}`;
  elements.previousStoryButton.disabled = !hasSelection || selectedIndex === 0;
  elements.nextStoryButton.disabled = !hasSelection || selectedIndex === stories.length - 1;
}

function overpassCategory(tags) {
  if (tags.historic) return `史跡・${tags.historic}`;
  if (tags.memorial || tags["memorial:type"]) return "記念碑・モニュメント";
  if (tags.tourism === "museum") return "博物館・資料館";
  if (tags.tourism) return "見どころ";
  if (tags.place) return "地名・まち";
  if (tags.heritage) return "文化遺産";
  return "まちのスポット";
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("通信がタイムアウトしました。")), API_TIMEOUT_MS);
  const forwardAbort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`情報源から応答がありませんでした（HTTP ${response.status}）。`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error("情報の取得がタイムアウトしました。通信環境を確認してください。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function fetchWikipediaStories(position, language, signal) {
  const api = `https://${language}.wikipedia.org/w/api.php`;
  const params = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${position.latitude}|${position.longitude}`,
    gsradius: String(RADIUS_METERS),
    gslimit: "20",
    gsnamespace: "0",
    format: "json",
    origin: "*",
  });
  const result = await fetchWithTimeout(`${api}?${params}`, { signal });
  const places = result.query?.geosearch ?? [];
  if (!places.length) return [];

  const pageParams = new URLSearchParams({
    action: "query",
    pageids: places.map((place) => place.pageid).join("|"),
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
    format: "json",
    origin: "*",
  });
  const pages = await fetchWithTimeout(`${api}?${pageParams}`, { signal });
  const pagesById = pages.query?.pages ?? {};
  const languageLabel = language === "ja" ? "Wikipedia" : "Wikipedia (English)";

  return places.map((place) => {
    const page = pagesById[place.pageid];
    return {
      id: `${language}:${place.pageid}`,
      title: place.title.replaceAll("_", " "),
      category: "まちの歴史・読みもの",
      summary: page?.extract?.replace(/\s+/g, " ").trim().slice(0, 380) ?? "",
      distance: place.dist,
      source: "wikipedia",
      sourceLabel: languageLabel,
      url: page?.fullurl ?? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(place.title)}`,
      narration: page?.extract?.replace(/\s+/g, " ").trim() ?? "",
    };
  });
}

async function fetchOpenStreetMapStories(position, signal) {
  const query = `[out:json][timeout:15];
(
  nwr(around:${RADIUS_METERS},${position.latitude},${position.longitude})["name"]["historic"];
  nwr(around:${RADIUS_METERS},${position.latitude},${position.longitude})["name"]["heritage"];
  nwr(around:${RADIUS_METERS},${position.latitude},${position.longitude})["name"]["memorial"];
  nwr(around:${RADIUS_METERS},${position.latitude},${position.longitude})["name"]["tourism"~"museum|attraction|artwork"];
  nwr(around:${RADIUS_METERS},${position.latitude},${position.longitude})["name"]["place"~"city|town|village|suburb|neighbourhood|hamlet|locality|square|quarter"];
  nwr(around:${RADIUS_METERS},${position.latitude},${position.longitude})["name"]["wikipedia"];
);
out center;`;
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await fetchWithTimeout(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query }),
        signal,
      });
      break;
    } catch (error) {
      const temporaryServerError = /HTTP (?:429|500|502|503|504)\b/.test(error.message);
      if (signal.aborted || !temporaryServerError || attempt === 1) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
  }

  return (result.elements ?? []).map((element) => {
    const tags = element.tags ?? {};
    const coordinates = element.lat && element.lon
      ? { latitude: element.lat, longitude: element.lon }
      : element.center
        ? { latitude: element.center.lat, longitude: element.center.lon }
        : null;
    if (!coordinates || !tags.name) return null;
    const wikiTag = tags.wikipedia?.split(":").pop();
    return {
      id: `${element.type}/${element.id}`,
      title: tags.name,
      category: overpassCategory(tags),
      summary: "",
      distance: distanceBetween(position, coordinates),
      source: "openstreetmap",
      sourceLabel: "OpenStreetMap",
      url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      wikipediaTitle: wikiTag,
      tags,
    };
  }).filter(Boolean).filter((story) => story.distance <= RADIUS_METERS);
}

function mergeStories(wikipediaStories, mapStories) {
  const articlesByName = new Map(wikipediaStories.map((story) => [story.title.toLocaleLowerCase("ja"), story]));
  const merged = [...wikipediaStories];
  for (const mapStory of mapStories) {
    const article = articlesByName.get(mapStory.title.toLocaleLowerCase("ja"));
    if (article) {
      article.distance = Math.min(article.distance, mapStory.distance);
      continue;
    }
    if (mapStory.wikipediaTitle) {
      const linkedArticle = [...articlesByName.values()].find((story) =>
        story.title.replaceAll(" ", "_").toLocaleLowerCase("ja")
          === mapStory.wikipediaTitle.replaceAll(" ", "_").toLocaleLowerCase("ja"));
      if (linkedArticle) {
        linkedArticle.distance = Math.min(linkedArticle.distance, mapStory.distance);
        continue;
      }
    }
    merged.push({
      ...mapStory,
      narration: `${mapStory.title}は、この近くにある${mapStory.category}です。OpenStreetMapの地図情報から見つかりました。詳しい由来や出来事は、現地の案内板などでも確かめてみてください。`,
    });
  }
  return merged.sort((a, b) => a.distance - b.distance);
}

async function discoverNearby(position) {
  if (!state.active) return;
  state.scanController?.abort();
  const controller = new AbortController();
  state.scanController = controller;
  state.lastSearch = position;
  state.lastSearchAt = Date.now();
  setStatus("半径500mの物語を探しています…");
  setOnAir("TUNING IN…");

  const tasks = [
    fetchWikipediaStories(position, "ja", controller.signal),
    fetchWikipediaStories(position, "en", controller.signal),
    fetchOpenStreetMapStories(position, controller.signal),
  ];
  const results = await Promise.allSettled(tasks);
  if (!state.active || controller.signal.aborted) return;

  const wikiStories = [...(results[0].status === "fulfilled" ? results[0].value : []),
    ...(results[1].status === "fulfilled" ? results[1].value : [])];
  const mapStories = results[2].status === "fulfilled" ? results[2].value : [];
  const failedSources = [];
  if (results[0].status === "rejected" && results[1].status === "rejected") failedSources.push("Wikipedia");
  if (results[2].status === "rejected") failedSources.push("OpenStreetMap");
  state.sourceErrors = failedSources;

  if (!wikiStories.length && !mapStories.length && failedSources.length === 2) {
    setStatus("近くの情報を取得できませんでした。通信環境を確認して、もう一度お試しください。", true);
    setOnAir("NO SIGNAL");
    elements.trackKicker.textContent = "CONNECTION LOST";
    elements.trackTitle.textContent = "まちの電波を<br>探しています。";
    elements.trackDescription.textContent = "接続を確認すると、もう一度自動で探します。";
    return;
  }

  const freshStories = mergeStories(wikiStories, mapStories);
  const knownIds = new Set(state.stories.map(stableId));
  for (const story of freshStories) {
    if (!knownIds.has(stableId(story))) {
      state.stories.push(story);
      knownIds.add(stableId(story));
    }
  }
  renderStories();

  const sourceNote = failedSources.length
    ? `${failedSources.join("・")}に接続できません。利用できる情報のみ表示しています。`
    : "スポット情報：Wikipedia・OpenStreetMap";
  document.querySelector("#source-note").textContent = sourceNote;

  if (!freshStories.length) {
    const message = "この範囲の解説はまだ見つかりませんでした。歩き進めると、また探します。";
    setStatus(message, true);
    elements.trackKicker.textContent = "MORE STORIES AHEAD";
    elements.trackTitle.textContent = "この先でまた、<br>探してみます。";
    elements.trackDescription.textContent = message;
    setOnAir(state.paused ? "PAUSED" : "WALKING");
    return;
  }

  const count = state.stories.length;
  setStatus(`${count}件のスポットが見つかりました。タップ、または前へ・次へで選べます。`, true);
  if (state.currentStoryId === null && !state.paused) {
    window.clearTimeout(state.timer);
    state.timer = null;
    speakNextStory();
  } else {
    setOnAir(state.paused ? "PAUSED" : "MORE STORIES FOUND");
  }
}

function speakNextStory() {
  if (!state.active || state.paused || !("speechSynthesis" in window)) return;
  const stories = getOrderedStories();
  const selectedIndex = stories.findIndex((story) => stableId(story) === state.selectedStoryId);
  const remainingStories = [...stories.slice(selectedIndex + 1), ...stories.slice(0, selectedIndex + 1)];
  const nextStory = remainingStories.find((story) =>
    !state.spoken.has(stableId(story)) && !isEnglishStory(story))
    ?? remainingStories.find((story) => !state.spoken.has(stableId(story)));

  if (!nextStory) {
    state.currentStoryId = null;
    setOnAir(state.sourceErrors.length ? "LIMITED RECEPTION" : "YOU’RE ALL CAUGHT UP");
    elements.trackDescription.textContent = "近くの物語は聴き終わりました。前へ・次へ、または一覧から選べます。";
    return;
  }

  showStory(nextStory);
  playStory(nextStory);
}

function showStory(story) {
  state.selectedStoryId = stableId(story);
  elements.trackKicker.textContent = `${story.category} · ${formatDistance(story.distance)}先`;
  elements.trackTitle.textContent = story.title;
  elements.trackDescription.textContent = story.summary || "近くの地図に記されたスポットです。";
  elements.progressBar.style.width = "0%";
  updateStoryNavigation();
  for (const button of elements.storyList.querySelectorAll(".story-select-button")) {
    button.setAttribute("aria-pressed", String(button.dataset.storyId === state.selectedStoryId));
  }
}

function selectStory(storyId) {
  const stories = getOrderedStories();
  const index = stories.findIndex((story) => stableId(story) === storyId);
  if (index === -1) return;
  if (!state.active) beginWalk();
  if (!state.active) return;

  if (state.paused) {
    state.paused = false;
    startWatching();
    acquireWakeLock();
  }
  setActiveControls();
  for (const story of stories.slice(0, index)) {
    state.spoken.add(stableId(story));
  }
  state.spoken.delete(storyId);
  window.clearTimeout(state.timer);
  state.timer = null;
  window.clearTimeout(state.speechStartTimer);
  state.speechStartTimer = null;
  state.speechToken += 1;
  window.speechSynthesis.cancel();
  showStory(stories[index]);
  playStory(stories[index]);
}

function navigateStory(direction) {
  const stories = getOrderedStories();
  const index = stories.findIndex((story) => stableId(story) === state.selectedStoryId);
  const nextIndex = index + direction;
  if (index === -1 || nextIndex < 0 || nextIndex >= stories.length) return;
  selectStory(stableId(stories[nextIndex]));
}

function playStory(nextStory) {
  const storyId = stableId(nextStory);
  state.currentStoryId = storyId;
  state.speechToken += 1;
  const token = state.speechToken;
  state.audioStarted = false;
  setOnAir("TUNING IN…");
  const narration = new SpeechSynthesisUtterance(buildNarration(nextStory));
  narration.lang = isEnglishStory(nextStory) ? "en-US" : "ja-JP";
  const voice = getVoiceForLanguage(narration.lang);
  if (voice) narration.voice = voice;
  narration.rate = 0.97;
  narration.pitch = 1.02;
  narration.onstart = () => {
    if (token !== state.speechToken) return;
    state.audioStarted = true;
    state.startedSpeechToken = token;
    window.clearTimeout(state.speechStartTimer);
    state.spoken.add(storyId);
    setOnAir("ON AIR · YOUR LOCAL STORY", true);
  };
  narration.onend = () => {
    if (token !== state.speechToken || !state.active) return;
    state.currentStoryId = null;
    elements.progressBar.style.width = "100%";
    setOnAir("STORY COMPLETE");
    state.timer = window.setTimeout(() => {
      state.timer = null;
      speakNextStory();
    }, STORY_GAP_MS);
  };
  narration.onerror = (event) => {
    if (token !== state.speechToken || event.error === "canceled" || event.error === "interrupted") return;
    state.currentStoryId = null;
    state.spoken.delete(storyId);
    showSpeechFailure(event.error);
    elements.trackDescription.textContent = "画面に表示された解説をお読みいただけます。";
  };
  try {
    window.speechSynthesis.speak(narration);
    state.speechStartTimer = window.setTimeout(() => {
      if (token === state.speechToken && state.startedSpeechToken !== token && state.active) {
        state.currentStoryId = null;
        state.spoken.delete(storyId);
        showSpeechFailure("start-timeout");
      }
    }, 12000);
  } catch (error) {
    state.currentStoryId = null;
    state.spoken.delete(storyId);
    showSpeechFailure("synthesis-failed");
    console.error("音声の読み上げを開始できませんでした。", error);
  }
}

function showSpeechFailure(errorCode) {
  if (state.active) {
    state.paused = true;
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    window.clearTimeout(state.timer);
    state.timer = null;
    window.speechSynthesis.cancel();
    state.wakeLock?.release();
    state.wakeLock = null;
    setActiveControls();
  }
  const messages = {
    "not-allowed": "音声の再生がブラウザーにブロックされました。「ラジオを再開」をタップして、もう一度お試しください。",
    "voice-unavailable": "日本語の読み上げ音声が見つかりません。端末に日本語音声を追加してからお試しください。",
    "language-unavailable": "日本語の読み上げ音声が利用できません。端末の音声設定を確認してください。",
    "audio-busy": "端末のほかの音声が使用中です。少し待ってからもう一度お試しください。",
    "audio-hardware": "音声を出力できません。端末の音量やイヤホンの接続を確認してください。",
    "start-timeout": "音声が始まりません。端末の音量・サイレント設定を確認して、もう一度タップしてください。",
  };
  const message = messages[errorCode] ?? "音声を再生できませんでした。端末の音量と読み上げ設定を確認して、もう一度お試しください。";
  setOnAir("AUDIO UNAVAILABLE");
  setStatus(message, true);
}

function speakIntro() {
  const synthesis = window.speechSynthesis;
  synthesis.cancel();
  state.audioStarted = false;
  const intro = new SpeechSynthesisUtterance("よりみちラジオを始めます。近くの物語を探しています。");
  intro.lang = "ja-JP";
  intro.rate = 1;
  const voice = getVoiceForLanguage(intro.lang);
  if (voice) intro.voice = voice;
  intro.onstart = () => {
    state.audioStarted = true;
    window.clearTimeout(state.speechStartTimer);
  };
  intro.onerror = (event) => {
    if (event.error !== "canceled" && event.error !== "interrupted") {
      showSpeechFailure(event.error);
    }
  };
  synthesis.speak(intro);
  state.speechStartTimer = window.setTimeout(() => {
    if (state.active && !state.audioStarted) showSpeechFailure("start-timeout");
  }, 10000);
}

function startWatching() {
  if (!("geolocation" in navigator)) {
    setStatus("このブラウザーでは位置情報を使えません。対応ブラウザーでお試しください。", true);
    setOnAir("LOCATION UNAVAILABLE");
    return;
  }
  if (state.watchId !== null) return;

  state.watchId = navigator.geolocation.watchPosition(onPosition, onLocationError, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 20000,
  });
}

function onPosition(result) {
  const position = {
    latitude: result.coords.latitude,
    longitude: result.coords.longitude,
  };
  state.position = position;
  elements.locationLabel.textContent = "現在地周辺の音声ガイド";
  renderStories();

  const shouldSearch = !state.lastSearch
    || distanceBetween(state.lastSearch, position) >= REFRESH_DISTANCE_METERS
    || Date.now() - state.lastSearchAt >= REFRESH_INTERVAL_MS;
  if (shouldSearch) {
    discoverNearby(position);
  }
}

function onLocationError(error) {
  const messages = {
    1: "位置情報が許可されていません。ブラウザーの設定で位置情報を許可してください。",
    2: "現在地を取得できませんでした。GPSや通信環境を確認してください。",
    3: "現在地の取得がタイムアウトしました。開けた場所で再度お試しください。",
  };
  setStatus(messages[error.code] ?? "現在地を取得できませんでした。位置情報の設定を確認してください。", true);
  setOnAir("LOCATION UNAVAILABLE");
  elements.locationLabel.textContent = "現在地を確認できません";
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    }, { once: true });
  } catch (error) {
    state.wakeLock = null;
    if (error.name !== "NotAllowedError") {
      console.warn("画面のスリープを抑止できませんでした。", error);
    }
  }
}

function setActiveControls() {
  elements.stopButton.hidden = !state.active;
  if (!state.active) {
    elements.playButton.disabled = false;
    elements.playLabel.textContent = "散歩をはじめる";
    elements.playIcon.textContent = "▶";
    elements.playButton.setAttribute("aria-label", "散歩ラジオをはじめる");
    return;
  }
  elements.playButton.disabled = false;
  elements.playLabel.textContent = state.paused ? "ラジオを再開" : "ひと休み";
  elements.playIcon.textContent = state.paused ? "▶" : "Ⅱ";
  elements.playButton.setAttribute("aria-label", state.paused ? "音声ガイドを再開する" : "音声ガイドを一時停止する");
}

function beginWalk() {
  if (!("speechSynthesis" in window)) {
    setStatus("このブラウザーは音声読み上げに対応していません。対応ブラウザーでお試しください。", true);
    setOnAir("AUDIO UNAVAILABLE");
    return;
  }
  state.active = true;
  state.paused = false;
  state.audioStarted = false;
  setActiveControls();
  setStatus("現在地を確認しています…");
  setOnAir("FINDING YOUR LOCATION");
  try {
    speakIntro();
  } catch (error) {
    showSpeechFailure("synthesis-failed");
    console.error("音声の読み上げを開始できませんでした。", error);
  }
  if (!state.paused) {
    startWatching();
    acquireWakeLock();
  }
}

function pauseWalk() {
  state.paused = true;
  window.clearTimeout(state.timer);
  state.timer = null;
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  window.speechSynthesis.pause();
  state.wakeLock?.release();
  setActiveControls();
  setOnAir("PAUSED");
  setStatus("一時停止中です。再開すると、現在地から続きを探します。", true);
}

function resumeWalk() {
  state.paused = false;
  setActiveControls();
  startWatching();
  if (window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
    setOnAir("ON AIR · YOUR LOCAL STORY", true);
  } else if (state.currentStoryId === null && state.stories.some((story) => !state.spoken.has(stableId(story)))) {
    speakNextStory();
  } else if (!state.lastSearch) {
    setOnAir("FINDING YOUR LOCATION");
  } else {
    setOnAir("WALKING");
  }
  acquireWakeLock();
  setStatus("ラジオを再開しました。歩いている間も、近くの物語を探します。", true);
}

function endWalk() {
  state.active = false;
  state.paused = false;
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  state.scanController?.abort();
  state.scanController = null;
  window.clearTimeout(state.timer);
  window.clearTimeout(state.speechStartTimer);
  window.speechSynthesis?.cancel();
  state.speechToken += 1;
  state.currentStoryId = null;
  state.wakeLock?.release();
  state.wakeLock = null;
  setActiveControls();
  setOnAir("READY WHEN YOU ARE");
  elements.progressBar.style.width = "0%";
  setStatus("散歩を終了しました。いつでもまた、まちの物語を探せます。", true);
}

elements.playButton.addEventListener("click", () => {
  if (!state.active) {
    beginWalk();
  } else if (state.paused) {
    resumeWalk();
  } else {
    pauseWalk();
  }
});
elements.stopButton.addEventListener("click", endWalk);
elements.previousStoryButton.addEventListener("click", () => navigateStory(-1));
elements.nextStoryButton.addEventListener("click", () => navigateStory(1));
elements.storyList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest(".story-select-button");
  if (button instanceof HTMLButtonElement) {
    selectStory(button.dataset.storyId);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.active && !state.paused) {
    acquireWakeLock();
  }
});

renderStories();
