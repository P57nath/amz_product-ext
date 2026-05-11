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
  const provider = payload?.provider || settings.aiProvider || "openai_direct";
  if (provider === "backend") {
    return runBackendAi(payload, settings);
  }
  return runOpenAiDirect(payload, settings);
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

async function runOpenAiDirect(payload, settings) {
  const apiKey = (payload?.apiKey || settings.openAiApiKey || "").trim();
  if (!apiKey) {
    throw new Error("OpenAI API key is missing in extension settings.");
  }
  const model = payload?.model || settings.openAiModel || "gpt-5-mini";
  const locale = payload?.locale || "en";
  const promptPayload = payload?.input || {};

  const schema = {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "pros",
      "cons",
      "sellerNotes",
      "riskFlags",
      "authenticityScore",
      "confidenceScore",
      "recommendation"
    ],
    properties: {
      summary: { type: "string" },
      pros: { type: "array", items: { type: "string" }, maxItems: 6 },
      cons: { type: "array", items: { type: "string" }, maxItems: 6 },
      sellerNotes: { type: "array", items: { type: "string" }, maxItems: 4 },
      riskFlags: { type: "array", items: { type: "string" }, maxItems: 6 },
      authenticityScore: { type: "integer", minimum: 0, maximum: 100 },
      confidenceScore: { type: "integer", minimum: 0, maximum: 100 },
      recommendation: { type: "string" }
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are a product review authenticity analyst. Return JSON only, no markdown. Stay concise and practical."
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Locale: ${locale}\n` +
                "Analyze the provided product review snapshot and return structured JSON with factual caution. " +
                "Do not invent unavailable evidence.\n\n" +
                JSON.stringify(promptPayload)
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "review_ai_analysis",
          schema,
          strict: true
        }
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${text.slice(0, 280)}`);
  }

  const data = await response.json();
  const parsed = parseStructuredResponse(data);
  if (!parsed) {
    throw new Error("Failed to parse structured AI response.");
  }
  return parsed;
}

function parseStructuredResponse(responseJson) {
  if (!responseJson) {
    return null;
  }
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim().startsWith("{")) {
    try {
      return JSON.parse(responseJson.output_text);
    } catch {
      return null;
    }
  }

  const output = Array.isArray(responseJson.output) ? responseJson.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      const candidate = chunk?.text || chunk?.output_text || "";
      if (typeof candidate === "string" && candidate.trim().startsWith("{")) {
        try {
          return JSON.parse(candidate);
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}
