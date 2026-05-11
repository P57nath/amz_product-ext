(function () {
  if (window.__arxReviewLensLoaded) {
    return;
  }
  window.__arxReviewLensLoaded = true;

  const ROOT_ID = "arx-root";
  const LAUNCHER_ID = "arx-launcher";
  const REFRESH_DEBOUNCE_MS = 900;
  const CACHE_PREFIX = "arx_cache_v1_";
  const SELLER_HISTORY_PREFIX = "arx_seller_hist_v1_";

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

  const LANG_PACKS = {
    en: {
      positive: ["great", "excellent", "amazing", "durable", "comfortable", "reliable", "easy", "value", "recommended", "solid", "premium", "fast"],
      negative: ["bad", "poor", "broken", "fake", "slow", "cheap", "defective", "refund", "return", "issue", "problem", "worst"],
      stop: ["the", "and", "for", "with", "this", "that", "from", "have", "been", "they", "you", "your", "not", "very", "just", "product", "item"]
    },
    es: {
      positive: ["excelente", "bueno", "increible", "comodo", "rapido", "calidad", "recomendado", "perfecto", "util", "fiable"],
      negative: ["malo", "defectuoso", "lento", "falso", "caro", "decepcion", "problema", "roto", "devolver", "pesimo"],
      stop: ["para", "con", "este", "esta", "muy", "pero", "como", "que", "del", "por", "producto", "articulo"]
    },
    de: {
      positive: ["gut", "ausgezeichnet", "hochwertig", "schnell", "zuverlassig", "empfehlenswert", "stabil", "bequem", "praktisch", "super"],
      negative: ["schlecht", "kaputt", "falsch", "langsam", "problem", "defekt", "ruckgabe", "enttauschend", "teuer", "mangelhaft"],
      stop: ["und", "der", "die", "das", "mit", "fur", "nicht", "sehr", "aber", "produkt", "artikel"]
    },
    fr: {
      positive: ["excellent", "bon", "super", "qualite", "rapide", "fiable", "recommande", "parfait", "solide", "pratique"],
      negative: ["mauvais", "lent", "faux", "defaut", "probleme", "retour", "deception", "casse", "cher", "nul"],
      stop: ["avec", "pour", "dans", "mais", "tres", "pas", "produit", "article", "cette", "ceci"]
    },
    it: {
      positive: ["ottimo", "buono", "eccellente", "qualita", "veloce", "consigliato", "affidabile", "perfetto", "comodo", "utile"],
      negative: ["scarso", "rotto", "falso", "lento", "problema", "difetto", "reso", "deludente", "costoso", "pessimo"],
      stop: ["con", "per", "questo", "questa", "molto", "non", "ma", "prodotto", "articolo"]
    },
    ja: {
      positive: [],
      negative: [],
      stop: []
    }
  };

  let state = {
    open: true,
    expanded: true,
    url: location.href,
    settings: { ...DEFAULT_SETTINGS },
    lastData: null,
    requestId: 0,
    evidenceRefs: [],
    statusText: "Initializing...",
    statusSource: "local"
  };
  let renderTimer = null;
  let observer = null;
  let observedNode = null;

  function isProductPage() {
    if (/\b(?:dp|gp\/product|gp\/aw\/d|product)\/[A-Z0-9]{10}\b/i.test(location.pathname)) {
      return true;
    }
    return Boolean(document.querySelector("#dp, #productTitle, #ppd"));
  }

  function detectAsin() {
    const urlMatch = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})/i);
    if (urlMatch) {
      return urlMatch[1].toUpperCase();
    }
    const input = document.querySelector("#ASIN, input[name='ASIN'], input[name='asin']");
    return (input?.value || "N/A").toUpperCase();
  }

  function sanitizeExtractedText(value, maxLen = 260) {
    let text = (value || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "";
    }
    const codeStartMatchers = [/if\s*\(\s*window\./i, /window\.[A-Za-z_$]/, /P\.when\(/, /function\s*\(/, /var\s+[A-Za-z_$][\w$]*\s*=/, /\._[A-Za-z0-9-]+_style_/, /mix_csa/i];
    let cutAt = -1;
    for (const matcher of codeStartMatchers) {
      const match = text.match(matcher);
      if (match && match.index !== undefined) {
        cutAt = cutAt === -1 ? match.index : Math.min(cutAt, match.index);
      }
    }
    if (cutAt > 0) {
      text = text.slice(0, cutAt).trim();
    }
    text = text.replace(/\s{2,}/g, " ").replace(/\b(Add to Cart|Add to List|See Similar Items|Similar items shipping to)\b[\s\S]*$/i, "").trim();
    if ((text.match(/[{};]/g) || []).length >= 8) {
      return "";
    }
    if (text.length > maxLen) {
      text = `${text.slice(0, maxLen - 3).trimEnd()}...`;
    }
    return text;
  }

  function textFrom(node, maxLen = 260) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, template").forEach((el) => el.remove());
    return sanitizeExtractedText(clone.textContent || "", maxLen);
  }

  function findText(selectors, maxLen = 260) {
    for (const selector of selectors) {
      const value = textFrom(document.querySelector(selector), maxLen);
      if (value) return value;
    }
    return "";
  }

  function findFirstCleanText(selectors, maxLen = 260) {
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const value = textFrom(node, maxLen);
        if (value) return value;
      }
    }
    return "";
  }

  function findAttr(selectors, attr) {
    for (const selector of selectors) {
      const value = (document.querySelector(selector)?.getAttribute(attr) || "").trim();
      if (value) return value;
    }
    return "";
  }

  function parseRating(value) {
    const match = (value || "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const num = Number.parseFloat(match[1]);
    return Number.isFinite(num) ? num : null;
  }

  function parseCount(value) {
    const normalized = (value || "").replace(/,/g, "").toLowerCase();
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*([km]?)/);
    if (!match) return 0;
    let count = Number.parseFloat(match[1]);
    if (!Number.isFinite(count)) return 0;
    if (match[2] === "k") count *= 1000;
    else if (match[2] === "m") count *= 1000000;
    return Math.round(count);
  }

  function parseHelpfulVotes(value) {
    const text = (value || "").toLowerCase().replace(/,/g, "");
    if (text.includes("one person")) return 1;
    const match = text.match(/(\d+)/);
    return match ? Number.parseInt(match[1], 10) : 0;
  }

  function parsePriceValue(text) {
    const match = String(text || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function dedupe(items, maxItems) {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
      const clean = String(item || "").trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "N/A";
    return new Intl.NumberFormat().format(value);
  }

  function percent(value) {
    if (!Number.isFinite(value)) return "0%";
    return `${Math.round(value * 100)}%`;
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function detectLocale() {
    if (state.settings.localeMode && state.settings.localeMode !== "auto") return state.settings.localeMode;
    const htmlLang = (document.documentElement?.lang || "").toLowerCase();
    if (htmlLang.startsWith("es")) return "es";
    if (htmlLang.startsWith("de")) return "de";
    if (htmlLang.startsWith("fr")) return "fr";
    if (htmlLang.startsWith("it")) return "it";
    if (htmlLang.startsWith("ja")) return "ja";
    const host = location.hostname.toLowerCase();
    if (host.endsWith(".co.jp")) return "ja";
    if (host.endsWith(".de")) return "de";
    if (host.endsWith(".fr")) return "fr";
    if (host.endsWith(".it")) return "it";
    if (host.endsWith(".es")) return "es";
    return "en";
  }

  function getLanguagePack() {
    const locale = detectLocale();
    const base = LANG_PACKS[locale] || LANG_PACKS.en;
    const en = LANG_PACKS.en;
    return {
      locale,
      positive: new Set([...en.positive, ...base.positive].map((word) => word.toLowerCase())),
      negative: new Set([...en.negative, ...base.negative].map((word) => word.toLowerCase())),
      stop: new Set([...en.stop, ...base.stop].map((word) => word.toLowerCase()))
    };
  }

  function tokenize(text, stopWords) {
    const terms = [];
    const matches = (text || "").toLowerCase().match(/[\p{L}\p{N}'-]{2,}/gu) || [];
    for (const raw of matches) {
      const word = raw.replace(/^'+|'+$/g, "");
      if (word.length < 2 || stopWords.has(word)) continue;
      terms.push(word);
    }
    return terms;
  }

  function normalizeSnippet(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
  }

  function extractMonthKey(raw) {
    const text = String(raw || "").toLowerCase();
    const year = text.match(/(20\d{2})/);
    if (!year) return "";
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    for (let i = 0; i < months.length; i += 1) {
      if (text.includes(months[i])) return `${year[1]}-${String(i + 1).padStart(2, "0")}`;
    }
    return year[1];
  }

  function parseReviewBlocks() {
    const blocks = Array.from(document.querySelectorAll("[data-hook='review']")).slice(0, 40);
    return blocks.map((block, idx) => {
      if (!block.dataset.arxReviewId) {
        block.dataset.arxReviewId = `arx-review-${idx}-${Math.random().toString(36).slice(2, 7)}`;
      }
      const starText = textFrom(block.querySelector("[data-hook='review-star-rating'] .a-icon-alt")) || textFrom(block.querySelector("[data-hook='cmps-review-star-rating'] .a-icon-alt")) || textFrom(block.querySelector(".review-rating .a-icon-alt"));
      const title = textFrom(block.querySelector("[data-hook='review-title']"));
      const body = textFrom(block.querySelector("[data-hook='review-body'] span")) || textFrom(block.querySelector("[data-hook='review-collapsed']")) || textFrom(block.querySelector(".review-text-content span"));
      return {
        reviewId: block.dataset.arxReviewId,
        title,
        body,
        dateText: textFrom(block.querySelector("[data-hook='review-date']"), 120),
        stars: parseRating(starText),
        helpfulVotes: parseHelpfulVotes(textFrom(block.querySelector("[data-hook='helpful-vote-statement']"))),
        verified: Boolean(block.querySelector("[data-hook='avp-badge'], [data-hook='avp-badge-linkless']"))
      };
    });
  }

  function buildReviewSnippets(reviews) {
    return dedupe(
      reviews
        .map((review) => `${review.title || ""}. ${review.body || ""}`.trim())
        .filter((text) => text.length >= 22)
        .map((text) => (text.length > 280 ? `${text.slice(0, 277).trimEnd()}...` : text)),
      24
    );
  }

  function buildProsFromBullets() {
    return dedupe(
      Array.from(document.querySelectorAll("#feature-bullets .a-list-item, #featurebullets_feature_div .a-list-item")).map((node) => textFrom(node)).filter((line) => line.length >= 16 && !/^see more/i.test(line)),
      4
    );
  }

  function collectBadges() {
    const selectors = ["#acBadge_feature_div", "#dealBadge_feature_div", "#zeitgeistBadge_feature_div", "#social-proofing-faceout-title-tk_bought", "#social-proofing-faceout-title-tk_trending", "#applicablePromotionList_feature_div"];
    return dedupe(
      selectors.map((selector) => textFrom(document.querySelector(selector))).filter((text) => text && text.length < 100),
      6
    );
  }

  function parseAlternatives(currentTitle) {
    const selectors = ["#sp_detail .s-card-container", "#sp_detail .puis-card-container", "#similarities_feature_div .a-carousel-card", "#sims-fbt .a-carousel-card", "#sp_detail .a-carousel-card"];
    const alt = [];
    const seen = new Set();
    for (const selector of selectors) {
      const cards = Array.from(document.querySelectorAll(selector));
      for (const card of cards) {
        const title = textFrom(card.querySelector("h2 a span, h2 span, .a-size-base-plus, .a-size-medium, a.a-link-normal span"), 140);
        if (!title || title.length < 20) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        if (currentTitle && key.includes(currentTitle.toLowerCase().slice(0, 30))) continue;
        seen.add(key);
        alt.push({
          title,
          price: textFrom(card.querySelector(".a-price .a-offscreen"), 40) || "N/A",
          rating: parseRating(textFrom(card.querySelector(".a-icon-alt"), 20)),
          ratingCount: parseCount(textFrom(card.querySelector(".a-size-small .a-link-normal, .a-size-base.s-underline-text"), 40))
        });
        if (alt.length >= 3) return alt;
      }
      if (alt.length >= 3) break;
    }
    return alt;
  }

  function analyzeReviews(reviews, langPack) {
    let verifiedCount = 0;
    let helpfulVotes = 0;
    let starSum = 0;
    let starCount = 0;
    const starValues = [];
    const pros = [];
    const cons = [];
    const posTerms = new Map();
    const negTerms = new Map();
    const evidenceSnippets = [];

    for (const review of reviews) {
      const combined = `${review.title || ""}. ${review.body || ""}`.trim();
      if (!combined) continue;
      const terms = tokenize(combined, langPack.stop);
      const star = Number.isFinite(review.stars) ? review.stars : null;
      if (review.verified) verifiedCount += 1;
      helpfulVotes += review.helpfulVotes || 0;
      if (star !== null) {
        starSum += star;
        starCount += 1;
        starValues.push(star);
      }

      const sentences = combined.split(/[.!?]/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 20).slice(0, 2);
      for (const sentence of sentences) {
        const words = tokenize(sentence, langPack.stop);
        const posHits = words.filter((word) => langPack.positive.has(word)).length;
        const negHits = words.filter((word) => langPack.negative.has(word)).length;
        if (star !== null && star >= 4) {
          pros.push(sentence);
          evidenceSnippets.push({ text: sentence, reviewId: review.reviewId });
          break;
        }
        if (star !== null && star <= 2) {
          cons.push(sentence);
          evidenceSnippets.push({ text: sentence, reviewId: review.reviewId });
          break;
        }
        if (posHits >= negHits + 2) {
          pros.push(sentence);
          evidenceSnippets.push({ text: sentence, reviewId: review.reviewId });
          break;
        }
        if (negHits >= posHits + 2) {
          cons.push(sentence);
          evidenceSnippets.push({ text: sentence, reviewId: review.reviewId });
          break;
        }
      }

      if (star !== null && star >= 4) {
        for (const term of terms) {
          if (term.length >= 5 || langPack.positive.has(term)) posTerms.set(term, (posTerms.get(term) || 0) + 1);
        }
      } else if (star !== null && star <= 2) {
        for (const term of terms) {
          if (term.length >= 5 || langPack.negative.has(term)) negTerms.set(term, (negTerms.get(term) || 0) + 1);
        }
      }
    }

    const avgStars = starCount > 0 ? starSum / starCount : null;
    const verifiedRatio = reviews.length > 0 ? verifiedCount / reviews.length : 0;
    const variance = starValues.length > 1 ? starValues.reduce((acc, value) => acc + (value - (avgStars || 0)) ** 2, 0) / starValues.length : 0;
    return {
      avgStars,
      verifiedRatio,
      helpfulVotes,
      variance,
      stars: starValues,
      pros: dedupe(pros, 5),
      cons: dedupe(cons, 5),
      evidenceSnippets: dedupe(evidenceSnippets.map((x) => JSON.stringify(x)), 8).map((s) => JSON.parse(s)),
      topPositiveTerms: Array.from(posTerms.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([term]) => term),
      topNegativeTerms: Array.from(negTerms.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([term]) => term)
    };
  }

  function computeSuspicion(reviews, stars) {
    const normalized = reviews.map((r) => normalizeSnippet(`${r.title || ""}. ${r.body || ""}`)).filter((x) => x.length > 40);
    const counts = new Map();
    for (const text of normalized) counts.set(text, (counts.get(text) || 0) + 1);
    const repeated = Array.from(counts.values()).filter((v) => v > 1).reduce((a, b) => a + b, 0);
    const repetitionScore = normalized.length >= 4 ? (repeated / normalized.length) * 100 : 0;

    const monthCounts = new Map();
    for (const review of reviews) {
      const key = extractMonthKey(review.dateText);
      if (!key) continue;
      monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
    }
    let burstScore = 0;
    const totalMonthReviews = Array.from(monthCounts.values()).reduce((a, b) => a + b, 0);
    if (totalMonthReviews >= 6 && monthCounts.size > 0) {
      const topMonth = Math.max(...monthCounts.values());
      const concentration = topMonth / totalMonthReviews;
      if (concentration > 0.34) burstScore = (concentration - 0.34) * 180;
    }

    const hist = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const star of stars || []) {
      hist[String(clamp(Math.round(star), 1, 5))] += 1;
    }
    const total = stars.length || 1;
    const imbalance = Math.abs((hist["4"] + hist["5"]) / total - (hist["1"] + hist["2"]) / total) * 100;
    const score = clamp(Math.round((repetitionScore * 0.45) + (burstScore * 0.35) + (imbalance * 0.2)), 0, 100);

    const signals = [];
    if (repetitionScore >= 45) signals.push("Repeated wording across reviews.");
    if (burstScore >= 45) signals.push("Date concentration suggests review burst.");
    if (imbalance >= 75 && stars.length >= 18) signals.push("Strong imbalance between high and low ratings.");

    return { suspicionScore: score, suspicionSignals: signals, starHistogram: hist };
  }

  function computeTrend(stars) {
    if (!stars || stars.length < 9) {
      return { direction: "unknown", recentAvg: null, olderAvg: null, message: "Not enough trend data." };
    }
    const chunk = Math.max(3, Math.floor(stars.length / 3));
    const recent = stars.slice(0, chunk);
    const older = stars.slice(-chunk);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const delta = recentAvg - olderAvg;
    if (delta >= 0.35) return { direction: "improving", recentAvg: Number(recentAvg.toFixed(2)), olderAvg: Number(olderAvg.toFixed(2)), message: "Recent reviews are stronger than older reviews." };
    if (delta <= -0.35) return { direction: "declining", recentAvg: Number(recentAvg.toFixed(2)), olderAvg: Number(olderAvg.toFixed(2)), message: "Recent reviews are weaker than older reviews." };
    return { direction: "stable", recentAvg: Number(recentAvg.toFixed(2)), olderAvg: Number(olderAvg.toFixed(2)), message: "Recent and older reviews are stable." };
  }

  function computeScores(data) {
    let authenticity = 48;
    authenticity += (data.verifiedRatio - 0.5) * 45;
    if (data.ratingCount >= 2000) authenticity += 12;
    else if (data.ratingCount >= 400) authenticity += 8;
    else if (data.ratingCount < 50) authenticity -= 8;
    if (data.soldByAmazon || data.fulfilledByAmazon) authenticity += 9;
    if (data.rating !== null && data.rating > 4.9) authenticity -= 5;
    if (data.reviewVariance > 1.7) authenticity -= 4;
    if (data.sampleReviews < 8) authenticity -= 6;
    authenticity -= (data.suspicionScore || 0) * 0.08;

    let confidence = 24;
    confidence += Math.min(30, data.sampleReviews) * 2;
    if (data.ratingCount > 0) confidence += 10;
    if (data.rating !== null) confidence += 8;
    if (data.seller && !/unknown/i.test(data.seller)) confidence += 8;
    if (data.sampleReviews === 0) confidence = 15;
    if (data.trend?.direction === "declining") confidence -= 6;

    return {
      authenticityScore: clamp(Math.round(authenticity), 0, 100),
      confidenceScore: clamp(Math.round(confidence), 0, 100)
    };
  }

  function buildRiskFlags(data) {
    const flags = [];
    if (data.sampleReviews < 8) flags.push("Visible review sample is small.");
    if (data.ratingCount > 0 && data.ratingCount < 60) flags.push("Low rating count for a strong confidence purchase.");
    if (data.rating !== null && data.rating >= 4.9 && data.verifiedRatio < 0.35 && data.sampleReviews >= 10) flags.push("Very high rating with limited visible verified-purchase evidence.");
    if (data.reviewVariance > 1.7) flags.push("High rating variance indicates polarized sentiment.");
    if (!data.seller || /unknown/i.test(data.seller)) flags.push("Seller identity is unclear.");
    for (const signal of data.suspicionSignals || []) flags.push(signal);
    if (data.trend?.direction === "declining") flags.push("Recent trend is declining.");
    return dedupe(flags, 8);
  }

  function parseCsvList(value) {
    return String(value || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.toLowerCase());
  }

  function computeFitScore(data) {
    let fit = 50;
    const reasons = [];
    const budget = Number.parseFloat(String(state.settings.budgetMax || "").replace(/,/g, ""));
    const priceValue = parsePriceValue(data.price);
    if (Number.isFinite(budget) && budget > 0 && priceValue !== null) {
      if (priceValue <= budget) {
        fit += 15;
        reasons.push("Price is inside your budget.");
      } else {
        fit -= 15;
        reasons.push("Price is above your budget.");
      }
    }
    const brand = String(data.brand || "").toLowerCase();
    const preferred = parseCsvList(state.settings.preferredBrands);
    const avoid = parseCsvList(state.settings.avoidBrands);
    if (preferred.some((b) => brand.includes(b))) {
      fit += 15;
      reasons.push("Matches your preferred brand list.");
    }
    if (avoid.some((b) => brand.includes(b))) {
      fit -= 30;
      reasons.push("Brand is in your avoid list.");
    }
    const useCase = String(state.settings.useCase || "").toLowerCase().trim();
    if (useCase) {
      const combined = [...data.pros, ...data.reviewSnippets].join(" ").toLowerCase();
      if (combined.includes(useCase)) {
        fit += 8;
        reasons.push("Pros mention your use case.");
      }
    }
    const country = String(state.settings.userCountry || "").toLowerCase().trim();
    if (country && data.availability) {
      const availability = data.availability.toLowerCase();
      if (availability.includes("cannot be shipped")) {
        fit -= 20;
        reasons.push("Shipping limitation detected for selected location.");
      } else if (availability.includes(country)) {
        fit += 8;
        reasons.push("Availability text matches your delivery country.");
      }
    }
    return { fitScore: clamp(Math.round(fit), 0, 100), fitReasons: dedupe(reasons, 4) };
  }

  function buildDecision(data) {
    const score = (data.authenticityScore * 0.38) + (data.confidenceScore * 0.3) + ((100 - data.suspicionScore) * 0.17) + (data.fitScore * 0.15);
    const reasons = [];
    const changes = [];
    if (data.authenticityScore >= 72) reasons.push("Authenticity score is strong.");
    if (data.confidenceScore >= 70) reasons.push("Confidence score is strong.");
    if (data.suspicionScore <= 30) reasons.push("Suspicion score is low.");
    if (data.fitScore >= 65) reasons.push("Fit score aligns with your preferences.");
    if (data.confidenceScore < 60) changes.push("More review volume would increase confidence.");
    if (data.suspicionScore > 45) changes.push("Lower repetition and burst patterns would reduce risk.");
    if (data.fitScore < 55) changes.push("Adjust budget/brand or choose a closer-fit alternative.");
    if (data.verifiedRatio < 0.45) changes.push("Higher verified-purchase ratio would improve trust.");

    let label = "MAYBE";
    if (score >= 72 && data.confidenceScore >= state.settings.minConfidence && data.suspicionScore <= 45) label = "BUY";
    else if (score <= 45 || data.suspicionScore >= 70) label = "AVOID";
    return { label, score: Number(score.toFixed(1)), reasons: dedupe(reasons, 4), whatWouldChange: dedupe(changes, 4) };
  }

  function buildEvidence(data) {
    const evidence = [
      { key: "auth", label: "Authenticity", evidence: `Verified ratio ${percent(data.verifiedRatio)} with ${formatNumber(data.sampleReviews)} reviews sampled.` },
      { key: "conf", label: "Confidence", evidence: `Confidence combines sample size, seller clarity, and rating consistency.` },
      { key: "susp", label: "Suspicion", evidence: `Suspicion score ${data.suspicionScore}/100 from repetition, date concentration, and star imbalance.` },
      { key: "trend", label: "Trend", evidence: data.trend?.message || "Trend unavailable." },
      { key: "fit", label: "Fit", evidence: data.fitReasons?.join(" ") || "No personalization preferences provided." }
    ];
    const refs = [];
    for (const snippet of data.evidenceSnippets || []) {
      refs.push({ text: snippet.text, reviewId: snippet.reviewId || "" });
    }
    return { evidence, refs: dedupe(refs.map((x) => JSON.stringify(x)), 8).map((x) => JSON.parse(x)) };
  }

  function updateSellerHistory(data) {
    const key = `${SELLER_HISTORY_PREFIX}${data.asin}`;
    try {
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      const last = list[list.length - 1];
      if (!last || last.seller !== data.seller) {
        list.push({ seller: data.seller, ts: Date.now() });
      }
      const trimmed = list.slice(-8);
      localStorage.setItem(key, JSON.stringify(trimmed));
      if (trimmed.length > 1 && trimmed[trimmed.length - 2].seller !== data.seller) {
        data.riskFlags = dedupe([`Seller changed from "${trimmed[trimmed.length - 2].seller}" to "${data.seller}".`, ...data.riskFlags], 8);
      }
      data.sellerHistory = trimmed;
    } catch {
      data.sellerHistory = [];
    }
  }

  function analyzeLocal() {
    const langPack = getLanguagePack();
    const reviews = parseReviewBlocks();
    const reviewAnalysis = analyzeReviews(reviews, langPack);
    const sellerInfo = findFirstCleanText(["#merchant-info", "#merchantInfoFeature_feature_div", "#tabular-buybox .tabular-buybox-text", "#tabular-buybox-truncate-1", "#aod-offer-soldBy .a-size-small", "#shipsFromSoldBy_feature_div"], 220);
    const sellerName = findFirstCleanText(["#sellerProfileTriggerId", "#merchant-info a[href*='seller']", "#tabular-buybox #sellerProfileTriggerId", "#aod-offer-soldBy .a-size-small a", "#aod-offer-soldBy .a-size-small", "#shipsFromSoldBy_feature_div a"], 120) || "Unknown";
    const soldByAmazon = /sold by amazon/i.test(sellerInfo) || /amazon\./i.test(sellerName);
    const fulfilledByAmazon = /fulfilled by amazon/i.test(sellerInfo) || /ships from amazon/i.test(sellerInfo);
    const ratingText = findAttr(["#acrPopover", "span[data-hook='rating-out-of-text']", "#averageCustomerReviews #acrPopover"], "title") || findText(["#averageCustomerReviews .a-icon-alt", "#acrPopover span.a-icon-alt"]);
    const suspicion = computeSuspicion(reviews, reviewAnalysis.stars);
    const trend = computeTrend(reviewAnalysis.stars);

    const base = {
      asin: detectAsin(),
      locale: langPack.locale,
      url: location.href,
      title: findText(["#productTitle", "#title", "h1 span#title"]) || "Product",
      brand: findText(["#bylineInfo", "#brand", "#brandSnapshot_feature_div"], 140) || "Not specified",
      price: findText(["#corePrice_feature_div .a-price .a-offscreen", "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen", "#tp_price_block_total_price_ww .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice", ".a-price .a-offscreen"], 80) || "N/A",
      rating: parseRating(ratingText),
      ratingCount: parseCount(findText(["#acrCustomerReviewText", "span[data-hook='total-review-count']", "#reviews-medley-footer .a-link-normal"], 60)),
      availability: findFirstCleanText(["#availability .a-size-medium", "#availability span.a-size-medium", "#availability span", "#outOfStock", "#deliveryBlockMessage"], 220) || "N/A",
      seller: sellerName,
      soldByAmazon,
      fulfilledByAmazon,
      badges: collectBadges(),
      alternatives: parseAlternatives(findText(["#productTitle", "#title"], 140)),
      sampleReviews: reviews.length,
      verifiedRatio: reviewAnalysis.verifiedRatio,
      helpfulVotes: reviewAnalysis.helpfulVotes,
      avgReviewStars: reviewAnalysis.avgStars,
      reviewVariance: reviewAnalysis.variance,
      pros: dedupe([...buildProsFromBullets(), ...reviewAnalysis.pros], 6),
      cons: dedupe(reviewAnalysis.cons, 6),
      reviewSnippets: buildReviewSnippets(reviews),
      evidenceSnippets: reviewAnalysis.evidenceSnippets,
      topPositiveTerms: reviewAnalysis.topPositiveTerms,
      topNegativeTerms: reviewAnalysis.topNegativeTerms,
      suspicionScore: suspicion.suspicionScore,
      suspicionSignals: suspicion.suspicionSignals,
      starHistogram: suspicion.starHistogram,
      trend,
      riskFlags: []
    };

    const scores = computeScores(base);
    base.authenticityScore = scores.authenticityScore;
    base.confidenceScore = scores.confidenceScore;
    const fit = computeFitScore(base);
    base.fitScore = fit.fitScore;
    base.fitReasons = fit.fitReasons;
    base.decision = buildDecision(base);
    const evidencePack = buildEvidence(base);
    base.evidence = evidencePack.evidence;
    base.evidenceRefs = evidencePack.refs;
    base.riskFlags = buildRiskFlags(base);
    updateSellerHistory(base);
    return base;
  }

  async function requestMessage(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "Empty response." });
      });
    });
  }

  function mergeBackendData(local, backendResponse) {
    const remote = backendResponse?.data || backendResponse;
    if (!remote || typeof remote !== "object") return local;
    const merged = { ...local };

    const localSample = Number(local.sampleReviews || 0);
    const localRatingCount = Number(local.ratingCount || 0);
    const remoteSample = Number(remote.sampleReviews || 0);
    const remoteRatingCount = Number(remote.ratingCount || 0);

    const localQuality = localSample + Math.min(500, localRatingCount / 5);
    const remoteQuality = remoteSample + Math.min(500, remoteRatingCount / 5);
    const weakRemote =
      (remoteSample === 0 && remoteRatingCount === 0) ||
      (remoteSample < 5 && remoteQuality < localQuality * 0.35);

    if (!weakRemote) {
      if (remoteSample > 0) merged.sampleReviews = remoteSample;
      if (remoteRatingCount > 0) merged.ratingCount = remoteRatingCount;
      if (Number.isFinite(remote.helpfulVotes) && remote.helpfulVotes >= 0) merged.helpfulVotes = remote.helpfulVotes;
      if (Number.isFinite(remote.avgReviewStars) && remote.avgReviewStars > 0) merged.avgReviewStars = remote.avgReviewStars;
      if (Number.isFinite(remote.reviewVariance) && remote.reviewVariance >= 0) merged.reviewVariance = remote.reviewVariance;
      if (Number.isFinite(remote.rating) && remote.rating > 0) merged.rating = remote.rating;
      if (Number.isFinite(remote.verifiedRatio) && remote.verifiedRatio >= 0 && remote.verifiedRatio <= 1 && remoteSample >= 5) {
        merged.verifiedRatio = remote.verifiedRatio;
      }
      if (Number.isFinite(remote.suspicionScore)) merged.suspicionScore = remote.suspicionScore;
      if (remote.trend) merged.trend = remote.trend;
      if (remote.evidence) merged.evidence = remote.evidence;
      if (remote.decision) merged.decision = remote.decision;
    } else {
      merged.riskFlags = dedupe(
        ["Backend crawl returned sparse data; keeping strong on-page metrics.", ...(merged.riskFlags || [])],
        8
      );
    }

    merged.pros = dedupe([...(remote.pros || []), ...merged.pros], 6);
    merged.cons = dedupe([...(remote.cons || []), ...merged.cons], 6);
    merged.topPositiveTerms = dedupe([...(remote.topPositiveTerms || []), ...merged.topPositiveTerms], 6);
    merged.topNegativeTerms = dedupe([...(remote.topNegativeTerms || []), ...merged.topNegativeTerms], 6);
    merged.badges = dedupe([...(remote.badges || []), ...merged.badges], 6);
    merged.riskFlags = dedupe([...(remote.riskFlags || []), ...merged.riskFlags], 8);
    merged.suspicionSignals = dedupe([...(remote.suspicionSignals || []), ...(merged.suspicionSignals || [])], 5);
    if (Number.isFinite(remote.authenticityScore)) merged.authenticityScore = clamp(Math.round(remote.authenticityScore), 0, 100);
    if (Number.isFinite(remote.confidenceScore)) merged.confidenceScore = clamp(Math.round(remote.confidenceScore), 0, 100);
    merged.remoteSamplePages = remote.pagesCrawled || null;
    merged.remoteSource = remote.source || "backend";
    return merged;
  }

  function mergeAiData(local, aiResponse) {
    const ai = aiResponse?.data || aiResponse;
    if (!ai || typeof ai !== "object") return local;
    const merged = { ...local };
    merged.aiSummary = typeof ai.summary === "string" ? ai.summary.trim() : "";
    merged.aiRecommendation = typeof ai.recommendation === "string" ? ai.recommendation.trim() : "";
    merged.pros = dedupe([...(ai.pros || []), ...merged.pros], 6);
    merged.cons = dedupe([...(ai.cons || []), ...merged.cons], 6);
    merged.riskFlags = dedupe([...(ai.riskFlags || []), ...merged.riskFlags], 8);
    merged.sellerNotes = dedupe(ai.sellerNotes || [], 5);
    if (Number.isFinite(ai.authenticityScore)) merged.authenticityScore = clamp(Math.round(ai.authenticityScore), 0, 100);
    if (Number.isFinite(ai.confidenceScore)) merged.confidenceScore = clamp(Math.round(ai.confidenceScore), 0, 100);
    merged.aiEnabled = true;
    return merged;
  }

  function applyDerivedFields(data) {
    const scores = computeScores(data);
    data.authenticityScore = scores.authenticityScore;
    data.confidenceScore = scores.confidenceScore;
    const fit = computeFitScore(data);
    data.fitScore = fit.fitScore;
    data.fitReasons = fit.fitReasons;
    data.decision = buildDecision(data);
    const evidencePack = buildEvidence(data);
    data.evidence = dedupe([...(data.evidence || []).map((x) => x.evidence || ""), ...evidencePack.evidence.map((x) => x.evidence)], 6).map((e, i) => ({ key: `mix-${i}`, label: "Evidence", evidence: e }));
    data.evidenceRefs = dedupe([...(data.evidenceRefs || []).map((x) => JSON.stringify(x)), ...evidencePack.refs.map((x) => JSON.stringify(x))], 8).map((x) => JSON.parse(x));
    data.riskFlags = buildRiskFlags(data);
    return data;
  }

  function scoreToneClass(score) {
    if (score >= 75) return "arx-good";
    if (score >= 50) return "arx-mid";
    return "arx-risk";
  }

  function decisionClass(label) {
    if (label === "BUY") return "arx-good";
    if (label === "AVOID") return "arx-risk";
    return "arx-mid";
  }

  function renderList(items, emptyMessage) {
    const list = items && items.length > 0 ? items : [emptyMessage];
    return list.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  }

  function renderTags(items, emptyMessage) {
    if (!items || items.length === 0) return `<span class="arx-tag arx-tag-muted">${escapeHtml(emptyMessage)}</span>`;
    return items.map((item) => `<span class="arx-tag">${escapeHtml(item)}</span>`).join("");
  }

  function buildSummaryLine(data) {
    return [
      data.rating !== null ? `${data.rating.toFixed(1)}/5` : "No rating",
      `${formatNumber(data.ratingCount)} ratings`,
      `${percent(data.verifiedRatio)} verified`,
      `ASIN ${data.asin}`
    ].join(" | ");
  }

  function buildCacheKey(asin) {
    return `${CACHE_PREFIX}${location.hostname}:${asin}`;
  }

  function buildLocalHash(data) {
    return JSON.stringify({
      asin: data.asin,
      rating: data.rating,
      ratingCount: data.ratingCount,
      sampleReviews: data.sampleReviews,
      seller: data.seller,
      price: data.price,
      snippets: (data.reviewSnippets || []).slice(0, 4)
    });
  }

  function loadCache(asin) {
    try {
      const raw = localStorage.getItem(buildCacheKey(asin));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveCache(asin, localHash, data) {
    try {
      localStorage.setItem(buildCacheKey(asin), JSON.stringify({ ts: Date.now(), localHash, data }));
    } catch {}
  }

  function isCacheFresh(entry) {
    if (!entry || !entry.ts) return false;
    const ttlMs = clamp(Number(state.settings.cacheMinutes || 30), 1, 240) * 60 * 1000;
    return Date.now() - entry.ts <= ttlMs;
  }

  function renderPanel(data) {
    const root = ensureRoot();
    if (!root) return;
    const lowConfidence = data.confidenceScore < state.settings.minConfidence;
    const expanded = state.expanded;
    state.evidenceRefs = data.evidenceRefs || [];

    root.innerHTML = `
      <div class="arx-card-shell ${expanded ? "arx-expanded" : "arx-collapsed"}">
        <header class="arx-head">
          <div class="arx-title-row">
            <span class="arx-pill">Review Lens</span>
            <button class="arx-icon-btn" type="button" data-arx-action="collapse">Hide</button>
          </div>
          <h2>${escapeHtml(data.title)}</h2>
          <p>${escapeHtml(buildSummaryLine(data))}</p>
          <p class="arx-status">Source: ${escapeHtml(state.statusSource)} | ${escapeHtml(state.statusText)}</p>
        </header>

        <section class="arx-decision-block">
          <div>
            <span>Decision Mode</span>
            <strong class="${decisionClass(data.decision?.label)}">${escapeHtml(data.decision?.label || "MAYBE")}</strong>
            <small>Decision score ${escapeHtml(String(data.decision?.score ?? "N/A"))}</small>
          </div>
          <div>
            <span>Suspicion</span>
            <strong class="${scoreToneClass(100 - (data.suspicionScore || 0))}">${escapeHtml(String(data.suspicionScore || 0))}</strong>
            <small>Lower is better</small>
          </div>
          <div>
            <span>Fit For You</span>
            <strong class="${scoreToneClass(data.fitScore || 0)}">${escapeHtml(String(data.fitScore || 0))}</strong>
            <small>${escapeHtml(state.settings.userCountry || "Country not set")}</small>
          </div>
        </section>

        <section class="arx-score-row">
          <article>
            <span>Authenticity</span>
            <strong class="${scoreToneClass(data.authenticityScore)}">${data.authenticityScore}</strong>
          </article>
          <article>
            <span>Confidence</span>
            <strong class="${lowConfidence ? "arx-risk" : scoreToneClass(data.confidenceScore)}">${data.confidenceScore}</strong>
          </article>
          <article>
            <span>Seller</span>
            <strong>${escapeHtml(data.seller)}</strong>
          </article>
        </section>

        ${lowConfidence ? `<div class="arx-alert">Confidence is below your threshold (${state.settings.minConfidence}).</div>` : ""}
        ${data.aiSummary ? `<section class="arx-ai"><h3>AI Summary</h3><p>${escapeHtml(data.aiSummary)}</p></section>` : ""}

        <div class="arx-actions">
          <button class="arx-btn arx-btn-light" type="button" data-arx-action="toggle-details">${expanded ? "Compact" : "Expand"}</button>
          <button class="arx-btn" type="button" data-arx-action="refresh">Refresh</button>
        </div>

        ${state.settings.enableFeedback ? `
          <div class="arx-feedback">
            <span>Was this helpful?</span>
            <button class="arx-icon-btn" type="button" data-arx-action="feedback_good">Yes</button>
            <button class="arx-icon-btn" type="button" data-arx-action="feedback_bad">No</button>
          </div>
        ` : ""}

        <section class="arx-details ${expanded ? "" : "arx-hidden"}">
          <article class="arx-block"><h3>Why this decision</h3><ul>${renderList(data.decision?.reasons || [], "No strong positive reasons detected.")}</ul><div class="arx-label">What would change this</div><ul>${renderList(data.decision?.whatWouldChange || [], "No change actions generated.")}</ul></article>
          ${state.settings.showPros ? `<article class="arx-block"><h3>Pros</h3><ul>${renderList(data.pros, "No strong pros found from visible data.")}</ul></article>` : ""}
          ${state.settings.showCons ? `<article class="arx-block"><h3>Cons</h3><ul>${renderList(data.cons, "No clear weak points found from visible data.")}</ul></article>` : ""}
          ${state.settings.showSeller ? `<article class="arx-block"><h3>Seller & Delivery</h3><ul><li>Seller: ${escapeHtml(data.seller)}</li><li>Sold by Amazon: ${data.soldByAmazon ? "Yes" : "No"}</li><li>Fulfilled by Amazon: ${data.fulfilledByAmazon ? "Yes" : "No"}</li><li>Availability: ${escapeHtml(data.availability)}</li><li>Price: ${escapeHtml(data.price)}</li></ul></article>` : ""}
          ${state.settings.showTrust ? `<article class="arx-block"><h3>Trust Signals</h3><ul><li>Visible sample reviews: ${formatNumber(data.sampleReviews)}</li><li>Helpful votes in sample: ${formatNumber(data.helpfulVotes)}</li><li>Verified purchase ratio: ${percent(data.verifiedRatio)}</li><li>Suspicion score: ${data.suspicionScore}/100</li>${data.remoteSamplePages ? `<li>Backend pages crawled: ${escapeHtml(String(data.remoteSamplePages))}</li>` : ""}${data.aiRecommendation ? `<li>AI recommendation: ${escapeHtml(data.aiRecommendation)}</li>` : ""}</ul></article>` : ""}
          ${state.settings.showTimeline ? `<article class="arx-block"><h3>Timeline Trend</h3><ul><li>Direction: ${escapeHtml(data.trend?.direction || "unknown")}</li><li>Recent avg: ${data.trend?.recentAvg ?? "N/A"} | Older avg: ${data.trend?.olderAvg ?? "N/A"}</li><li>${escapeHtml(data.trend?.message || "No trend insight available.")}</li></ul></article>` : ""}
          ${state.settings.showRisks ? `<article class="arx-block"><h3>Risk Flags</h3><ul>${renderList(data.riskFlags, "No high-risk pattern detected.")}</ul></article>` : ""}
          ${state.settings.showThemes ? `<article class="arx-block"><h3>Review Themes</h3><div class="arx-label">Positive</div><div class="arx-tags">${renderTags(data.topPositiveTerms, "Insufficient text")}</div><div class="arx-label">Negative</div><div class="arx-tags">${renderTags(data.topNegativeTerms, "Insufficient text")}</div><div class="arx-label">Badges</div><div class="arx-tags">${renderTags(data.badges, "No major badge found")}</div></article>` : ""}
          ${state.settings.showAlternatives ? `<article class="arx-block"><h3>Alternatives Compare</h3><ul>${renderList((data.alternatives || []).map((a) => `${a.title} | ${a.price} | ${a.rating ? `${a.rating.toFixed(1)}/5` : "N/A"} (${formatNumber(a.ratingCount || 0)})`), "No alternatives parsed on this page.")}</ul></article>` : ""}
          ${state.settings.showExplainability ? `<article class="arx-block"><h3>Explainability</h3><ul>${renderList((data.evidence || []).map((e) => `${e.label}: ${e.evidence}`), "No evidence details available.")}</ul><div class="arx-label">Clickable evidence snippets</div><div class="arx-evidence-list">${(state.evidenceRefs || []).map((ref, i) => `<button class="arx-evidence-btn" type="button" data-arx-action="evidence" data-arx-index="${i}">${escapeHtml(ref.text)}</button>`).join("") || `<span class="arx-tag arx-tag-muted">No linked snippets</span>`}</div></article>` : ""}
        </section>
      </div>
    `;

    const rootNode = document.getElementById(ROOT_ID);
    rootNode?.querySelectorAll("[data-arx-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.getAttribute("data-arx-action");
        if (action === "collapse") {
          setOpenState(false);
          return;
        }
        if (action === "toggle-details") {
          state.expanded = !state.expanded;
          renderPanel(data);
          return;
        }
        if (action === "refresh") {
          renderNow(true);
          return;
        }
        if (action === "evidence") {
          const index = Number(button.getAttribute("data-arx-index") || "-1");
          jumpToEvidence(index);
          return;
        }
        if (action === "feedback_good" || action === "feedback_bad") {
          await submitFeedback(action === "feedback_good");
        }
      });
    });
  }

  function jumpToEvidence(index) {
    const ref = state.evidenceRefs[index];
    if (!ref) return;
    const selector = ref.reviewId ? `[data-arx-review-id="${CSS.escape(ref.reviewId)}"]` : "";
    const node = selector ? document.querySelector(selector) : null;
    if (node) {
      document.querySelectorAll(".arx-evidence-hit").forEach((el) => el.classList.remove("arx-evidence-hit"));
      node.classList.add("arx-evidence-hit");
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const text = String(ref.text || "").slice(0, 70).toLowerCase();
    const reviews = Array.from(document.querySelectorAll("[data-hook='review']"));
    const match = reviews.find((review) => textFrom(review, 500).toLowerCase().includes(text));
    if (match) {
      match.scrollIntoView({ behavior: "smooth", block: "center" });
      match.classList.add("arx-evidence-hit");
    }
  }

  async function submitFeedback(helpful) {
    if (!state.settings.enableFeedback || !state.lastData) return;
    const comment = window.prompt("Optional feedback note (short):", "") || "";
    const payload = {
      baseUrl: state.settings.backendBaseUrl,
      asin: state.lastData.asin,
      url: location.href,
      decision: state.lastData.decision?.label || "",
      helpful,
      comment,
      context: {
        authenticityScore: state.lastData.authenticityScore,
        confidenceScore: state.lastData.confidenceScore,
        suspicionScore: state.lastData.suspicionScore,
        fitScore: state.lastData.fitScore
      }
    };
    await requestMessage("arx_save_feedback", payload);
  }

  function ensureRoot() {
    if (!isProductPage()) {
      removeUI();
      return null;
    }
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("section");
    root.id = ROOT_ID;
    root.className = "arx-host";
    const anchor = document.querySelector("#dp, #ppd, #centerCol") || document.body.firstElementChild;
    if (anchor?.parentNode) anchor.parentNode.insertBefore(root, anchor);
    else document.body.prepend(root);
    return root;
  }

  function ensureLauncher() {
    let launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) return launcher;
    launcher = document.createElement("button");
    launcher.id = LAUNCHER_ID;
    launcher.className = "arx-launcher";
    launcher.textContent = "Review Lens";
    launcher.type = "button";
    launcher.addEventListener("click", () => {
      setOpenState(true);
      renderNow(false);
    });
    document.body.appendChild(launcher);
    return launcher;
  }

  function setOpenState(open) {
    state.open = open;
    const root = document.getElementById(ROOT_ID);
    const launcher = ensureLauncher();
    if (root) root.style.display = open ? "flex" : "none";
    launcher.style.display = open ? "none" : "inline-flex";
  }

  function removeUI() {
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(LAUNCHER_ID)?.remove();
  }

  async function renderNow(forceRefresh = false) {
    if (!isProductPage()) {
      removeUI();
      return;
    }
    const requestId = ++state.requestId;
    const settings = state.settings;
    let data = analyzeLocal();
    const localHash = buildLocalHash(data);
    const cacheEntry = loadCache(data.asin);

    if (!forceRefresh && cacheEntry && isCacheFresh(cacheEntry) && cacheEntry.localHash === localHash) {
      state.statusSource = "cache";
      state.statusText = "Using cached enhanced analysis.";
      data = applyDerivedFields({ ...cacheEntry.data });
      state.lastData = data;
      ensureLauncher();
      renderPanel(data);
      setOpenState(state.open);
      attachObservers();
      return;
    }

    state.statusSource = "local";
    state.statusText = "Instant local analysis ready.";
    data = applyDerivedFields(data);
    state.lastData = data;
    ensureLauncher();
    renderPanel(data);
    setOpenState(state.open);
    attachObservers();

    if (settings.useBackendCrawl) {
      state.statusSource = "backend";
      state.statusText = "Fetching deeper review pages...";
      renderPanel(data);
      const backendResult = await requestMessage("arx_backend_crawl", {
        asin: data.asin,
        url: location.href,
        pages: settings.backendPages,
        baseUrl: settings.backendBaseUrl
      });
      if (requestId !== state.requestId) return;
      if (backendResult?.ok) {
        data = mergeBackendData(data, backendResult.data);
        data = applyDerivedFields(data);
        state.statusSource = "backend";
        state.statusText = "Backend crawl merged.";
        state.lastData = data;
        renderPanel(data);
      } else if (backendResult?.error) {
        data.riskFlags = dedupe([`Backend crawl failed: ${backendResult.error}`, ...data.riskFlags], 8);
        state.statusSource = "backend";
        state.statusText = "Backend crawl failed.";
        renderPanel(data);
      }
    }

    if (settings.useAiAnalysis) {
      state.statusSource = "ai";
      state.statusText = "Running model analysis...";
      renderPanel(data);
      const aiResult = await requestMessage("arx_ai_analyze", {
        model: settings.openAiModel,
        baseUrl: settings.backendBaseUrl,
        locale: data.locale,
        input: {
          title: data.title,
          asin: data.asin,
          price: data.price,
          rating: data.rating,
          ratingCount: data.ratingCount,
          seller: data.seller,
          soldByAmazon: data.soldByAmazon,
          fulfilledByAmazon: data.fulfilledByAmazon,
          verifiedRatio: data.verifiedRatio,
          sampleReviews: data.sampleReviews,
          helpfulVotes: data.helpfulVotes,
          badges: data.badges,
          pros: data.pros,
          cons: data.cons,
          reviewSnippets: data.reviewSnippets || [],
          positiveThemes: data.topPositiveTerms,
          negativeThemes: data.topNegativeTerms,
          riskFlags: data.riskFlags,
          userCountry: settings.userCountry,
          useCase: settings.useCase
        }
      });
      if (requestId !== state.requestId) return;
      if (aiResult?.ok) {
        data = mergeAiData(data, aiResult.data);
        data = applyDerivedFields(data);
        state.statusSource = "ai";
        state.statusText = "Model refinement merged.";
        state.lastData = data;
        renderPanel(data);
      } else if (aiResult?.error) {
        data.riskFlags = dedupe([`AI analysis failed: ${aiResult.error}`, ...data.riskFlags], 8);
        state.statusSource = "ai";
        state.statusText = "Model analysis failed.";
        renderPanel(data);
      }
    }

    data.badges = dedupe([`Enhanced by ${settings.useAiAnalysis ? "AI" : "rules"}${settings.useBackendCrawl ? " + backend" : ""}`, ...data.badges], 6);
    data = applyDerivedFields(data);
    state.lastData = data;
    state.statusSource = settings.useAiAnalysis ? "final(ai)" : settings.useBackendCrawl ? "final(backend)" : "final(local)";
    state.statusText = "Analysis complete.";
    renderPanel(data);
    saveCache(data.asin, localHash, data);
  }

  function queueRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderNow(false);
    }, REFRESH_DEBOUNCE_MS);
  }

  function attachObservers() {
    const node = document.querySelector("#cm-cr-dp-review-list") || document.querySelector("#reviewsMedley") || document.querySelector("#dp");
    if (!node) return;
    if (observer && observedNode === node) return;
    observer?.disconnect();
    observedNode = node;
    observer = new MutationObserver(() => {
      queueRender();
    });
    observer.observe(node, { childList: true, subtree: true });
  }

  async function loadSettings() {
    const response = await requestMessage("arx_get_settings", {});
    const settings = response?.ok ? { ...DEFAULT_SETTINGS, ...(response.settings || {}) } : { ...DEFAULT_SETTINGS };
    state.settings = settings;
    state.open = Boolean(settings.openByDefault);
    state.expanded = !settings.compactMode;
  }

  function watchUrlChanges() {
    setInterval(() => {
      if (state.url === location.href) return;
      state.url = location.href;
      queueRender();
    }, 900);
  }

  function setupListeners() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;
      let changed = false;
      for (const [key, entry] of Object.entries(changes)) {
        if (!(key in DEFAULT_SETTINGS)) continue;
        state.settings[key] = entry.newValue;
        changed = true;
      }
      if (changed) {
        state.expanded = !state.settings.compactMode;
        queueRender();
      }
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "arx_force_refresh") {
        renderNow(true);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === "arx_toggle_visibility") {
        setOpenState(!state.open);
        sendResponse({ ok: true, open: state.open });
      }
    });
  }

  async function boot() {
    await loadSettings();
    setupListeners();
    watchUrlChanges();
    renderNow(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      boot();
    }, { once: true });
  } else {
    boot();
  }
})();
