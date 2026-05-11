const DEFAULT_SETTINGS = {
  openByDefault: true,
  compactMode: true,
  minConfidence: 55,
  showPros: true,
  showCons: true,
  showSeller: true,
  showTrust: true,
  showThemes: true,
  showRisks: true,
  showExplainability: true,
  showAlternatives: true,
  showTimeline: true,
  useBackendCrawl: true,
  backendBaseUrl: "http://localhost:8787",
  backendPages: 3,
  useAiAnalysis: true,
  openAiModel: "cardiffnlp/twitter-xlm-roberta-base-sentiment",
  localeMode: "auto",
  userCountry: "Bangladesh",
  budgetMax: "",
  preferredBrands: "",
  avoidBrands: "",
  useCase: "",
  cacheMinutes: 30,
  enableFeedback: true
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (!type) {
    sendResponse({ ok: false, error: "Missing message type." });
    return false;
  }

  if (type === "arx_get_settings") {
    chrome.storage.sync
      .get(DEFAULT_SETTINGS)
      .then((settings) => sendResponse({ ok: true, settings: { ...DEFAULT_SETTINGS, ...settings } }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (type === "arx_backend_crawl") {
    crawlBackend(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === "arx_ai_analyze") {
    runAiAnalysis(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (type === "arx_save_feedback") {
    saveFeedback(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  sendResponse({ ok: false, error: `Unsupported message type: ${type}` });
  return false;
});

async function crawlBackend(payload) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const baseUrl = (payload?.baseUrl || settings.backendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("Backend URL is empty.");
  }
  const asin = payload?.asin || "";
  const url = payload?.url || "";
  const pages = Number(payload?.pages || settings.backendPages || 3);
  const endpoint = new URL(`${baseUrl}/api/reviews/summary`);
  endpoint.searchParams.set("asin", asin);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("pages", String(Math.max(1, Math.min(10, pages))));
  const response = await fetch(endpoint.toString(), { method: "GET" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend crawl failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return response.json();
}

async function runAiAnalysis(payload) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return runBackendAi(payload, settings);
}

async function saveFeedback(payload) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const baseUrl = (payload?.baseUrl || settings.backendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("Backend URL is empty.");
  }
  const response = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload || {})
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Feedback save failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return response.json();
}

async function runBackendAi(payload, settings) {
  const baseUrl = (payload?.baseUrl || settings.backendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("Backend URL is empty.");
  }
  const response = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: payload?.model || settings.openAiModel,
      locale: payload?.locale || "en",
      input: payload?.input || {}
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend AI failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return response.json();
}
