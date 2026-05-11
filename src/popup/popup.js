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
  useBackendCrawl: true,
  backendBaseUrl: "http://localhost:8787",
  backendPages: 3,
  useAiAnalysis: true,
  aiProvider: "backend",
  openAiApiKey: "",
  openAiModel: "nlptown/bert-base-multilingual-uncased-sentiment",
  localeMode: "auto"
};

const FIELD_IDS = Object.keys(DEFAULT_SETTINGS);

const minConfidence = document.getElementById("minConfidence");
const minConfidenceValue = document.getElementById("minConfidenceValue");
const statusNode = document.getElementById("status");

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  for (const id of FIELD_IDS) {
    const node = document.getElementById(id);
    if (!node) {
      continue;
    }
    const value = settings[id];
    if (node.type === "checkbox") {
      node.checked = Boolean(value);
    } else {
      node.value = value;
    }
  }
  minConfidenceValue.textContent = String(settings.minConfidence);

  minConfidence.addEventListener("input", () => {
    minConfidenceValue.textContent = minConfidence.value;
  });

  document.getElementById("saveBtn").addEventListener("click", saveSettings);
  document.getElementById("refreshBtn").addEventListener("click", refreshCurrentTab);
  document.getElementById("toggleBtn").addEventListener("click", toggleCurrentTabCard);
}

function collectSettingsFromForm() {
  const output = { ...DEFAULT_SETTINGS };
  for (const id of FIELD_IDS) {
    const node = document.getElementById(id);
    if (!node) {
      continue;
    }
    if (node.type === "checkbox") {
      output[id] = node.checked;
      continue;
    }
    output[id] = node.value;
  }

  output.minConfidence = clamp(parseInt(output.minConfidence, 10) || DEFAULT_SETTINGS.minConfidence, 0, 100);
  output.backendPages = clamp(parseInt(output.backendPages, 10) || DEFAULT_SETTINGS.backendPages, 1, 10);
  output.backendBaseUrl = String(output.backendBaseUrl || "").trim() || DEFAULT_SETTINGS.backendBaseUrl;
  output.openAiModel = String(output.openAiModel || "").trim() || DEFAULT_SETTINGS.openAiModel;
  output.aiProvider = output.aiProvider === "openai_direct" ? "openai_direct" : "backend";
  output.localeMode = ["auto", "en", "es", "de", "fr", "it", "ja"].includes(output.localeMode)
    ? output.localeMode
    : "auto";
  return output;
}

async function saveSettings() {
  const settings = collectSettingsFromForm();
  await chrome.storage.sync.set(settings);
  minConfidenceValue.textContent = String(settings.minConfidence);
  setStatus("Settings saved.");
}

async function refreshCurrentTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("No active tab.");
    return;
  }
  await sendToTab(tab.id, { type: "arx_force_refresh" });
  setStatus("Refresh signal sent to current tab.");
}

async function toggleCurrentTabCard() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("No active tab.");
    return;
  }
  const response = await sendToTab(tab.id, { type: "arx_toggle_visibility" });
  if (response?.ok) {
    setStatus(response.open ? "Card opened." : "Card hidden.");
    return;
  }
  setStatus("Toggle failed on current tab.");
}

function getActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false });
    });
  });
}

function setStatus(message) {
  statusNode.textContent = message;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
