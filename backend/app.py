import math
import os
import re
from dataclasses import dataclass
from statistics import mean
from typing import Any

import requests
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

SENTIMENT_MODEL_DEFAULT = os.getenv(
    "SENTIMENT_MODEL",
    "cardiffnlp/twitter-xlm-roberta-base-sentiment",
)
ZERO_SHOT_MODEL_DEFAULT = os.getenv(
    "ZERO_SHOT_MODEL",
    "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli",
)
ENABLE_ZERO_SHOT = os.getenv("ENABLE_ZERO_SHOT", "1").strip().lower() in {"1", "true", "yes", "on"}
REQUEST_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "accept-language": "en-US,en;q=0.9",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


app = FastAPI(title="Amazon Review Lens Python Backend", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class AIAnalyzeRequest(BaseModel):
    model: str = Field(default=SENTIMENT_MODEL_DEFAULT)
    locale: str = Field(default="en")
    input: dict[str, Any] = Field(default_factory=dict)


@dataclass
class ParsedReview:
    stars: float | None
    title: str
    body: str
    helpful: int
    verified: bool


_pipeline_cache: dict[str, Any] = {}
_pipeline_errors: dict[str, str] = {}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "amazon-review-lens-python-backend",
        "sentiment_model_default": SENTIMENT_MODEL_DEFAULT,
        "zero_shot_model_default": ZERO_SHOT_MODEL_DEFAULT,
        "zero_shot_enabled": ENABLE_ZERO_SHOT,
        "loaded_pipelines": list(_pipeline_cache.keys()),
        "pipeline_errors": _pipeline_errors,
    }


@app.get("/api/reviews/summary")
def reviews_summary(
    asin: str = Query(..., min_length=10, max_length=10),
    url: str = Query(..., min_length=8),
    pages: int = Query(3, ge=1, le=10),
) -> dict[str, Any]:
    asin = asin.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{10}", asin):
        raise HTTPException(status_code=400, detail="Invalid ASIN.")

    host = extract_amazon_host(url)
    if not host:
        raise HTTPException(status_code=400, detail="Invalid Amazon URL.")

    crawled = crawl_review_pages(host, asin, pages)
    summary = build_review_summary(crawled["items"], crawled["pages_crawled"])
    return {
        "source": "python_backend",
        "asin": asin,
        "host": host,
        "pagesRequested": pages,
        "pagesCrawled": summary["pages_crawled"],
        "sampleReviews": summary["sample_reviews"],
        "rating": summary["avg_stars"],
        "ratingCount": summary["rating_count"],
        "verifiedRatio": summary["verified_ratio"],
        "helpfulVotes": summary["helpful_votes"],
        "avgReviewStars": summary["avg_stars"],
        "reviewVariance": summary["variance"],
        "pros": summary["pros"],
        "cons": summary["cons"],
        "topPositiveTerms": summary["top_positive_terms"],
        "topNegativeTerms": summary["top_negative_terms"],
        "riskFlags": summary["risk_flags"],
        "authenticityScore": summary["authenticity_score"],
        "confidenceScore": summary["confidence_score"],
    }


@app.post("/api/ai/analyze")
def ai_analyze(payload: AIAnalyzeRequest) -> dict[str, Any]:
    model_name = (payload.model or SENTIMENT_MODEL_DEFAULT).strip()
    data = payload.input or {}
    review_texts = build_review_texts(data)
    if not review_texts:
        review_texts = build_fallback_texts(data)

    star_predictions = predict_stars(review_texts, model_name)
    sentiment_avg = mean(star_predictions) if star_predictions else 3.0
    sentiment_conf = compute_sentiment_confidence(star_predictions)

    aspect_summary = classify_aspects(review_texts) if ENABLE_ZERO_SHOT else {"pros": [], "cons": [], "risks": []}

    authenticity_base = safe_int(data.get("authenticityScore"), 50)
    confidence_base = safe_int(data.get("confidenceScore"), 45)

    authenticity = clamp_int(round((authenticity_base * 0.6) + ((sentiment_avg / 5.0) * 100.0 * 0.4)), 0, 100)
    confidence = clamp_int(round((confidence_base * 0.55) + (sentiment_conf * 0.45)), 0, 100)

    pros = dedupe_strings([*data.get("pros", []), *aspect_summary["pros"]], 6)
    cons = dedupe_strings([*data.get("cons", []), *aspect_summary["cons"]], 6)
    if sentiment_avg >= 4.1 and not pros:
        pros = ["Overall review tone is strongly positive in sampled texts."]
    if sentiment_avg <= 2.5 and not cons:
        cons = ["Overall review tone trends negative in sampled texts."]

    risk_flags = dedupe_strings([*data.get("riskFlags", []), *aspect_summary["risks"]], 8)
    if sentiment_avg <= 2.7:
        risk_flags.insert(0, "Open-source sentiment model detects low average sentiment.")
    if safe_float(data.get("verifiedRatio"), 0.0) < 0.35:
        risk_flags.insert(0, "Low verified-purchase ratio is a trust risk.")
    risk_flags = dedupe_strings(risk_flags, 8)

    seller = str(data.get("seller", "Unknown"))
    seller_notes = [
        f"Seller: {seller}",
        f"Sold by Amazon: {'Yes' if bool(data.get('soldByAmazon')) else 'No'}",
        f"Fulfilled by Amazon: {'Yes' if bool(data.get('fulfilledByAmazon')) else 'No'}",
    ]

    locale = (payload.locale or "en").lower()
    recommendation = build_recommendation(authenticity, confidence, sentiment_avg)
    summary = (
        f"Locale {locale}. Sentiment model average is {sentiment_avg:.2f}/5 "
        f"from {len(star_predictions)} samples. "
        f"Authenticity {authenticity}/100 and confidence {confidence}/100."
    )

    return {
        "summary": summary,
        "pros": pros,
        "cons": cons,
        "sellerNotes": seller_notes,
        "riskFlags": risk_flags,
        "authenticityScore": authenticity,
        "confidenceScore": confidence,
        "recommendation": recommendation,
    }


def crawl_review_pages(host: str, asin: str, pages: int) -> dict[str, Any]:
    items: list[ParsedReview] = []
    pages_crawled = 0
    session = requests.Session()
    session.headers.update(REQUEST_HEADERS)

    for page_num in range(1, pages + 1):
        page_url = (
            f"https://{host}/product-reviews/{asin}/ref=cm_cr_dp_d_show_all_btm"
            f"?ie=UTF8&reviewerType=all_reviews&pageNumber={page_num}&sortBy=recent"
        )
        try:
            resp = session.get(page_url, timeout=20)
            if resp.status_code >= 400:
                continue
            parsed = parse_reviews_from_html(resp.text)
            if not parsed:
                continue
            pages_crawled += 1
            items.extend(parsed)
        except requests.RequestException:
            continue

    return {"items": items, "pages_crawled": pages_crawled}


def parse_reviews_from_html(html: str) -> list[ParsedReview]:
    soup = BeautifulSoup(html, "lxml")
    reviews: list[ParsedReview] = []

    for row in soup.select("[data-hook='review']"):
        stars_text = clean_text(first_text(row, [
            "[data-hook='review-star-rating'] .a-icon-alt",
            "[data-hook='cmps-review-star-rating'] .a-icon-alt",
            ".review-rating .a-icon-alt",
        ]))
        title = clean_text(first_text(row, ["[data-hook='review-title']"]))
        body = clean_text(first_text(row, ["[data-hook='review-body'] span", "[data-hook='review-collapsed']"]))
        helpful = parse_helpful_votes(clean_text(first_text(row, ["[data-hook='helpful-vote-statement']"])))
        verified = row.select_one("[data-hook='avp-badge'], [data-hook='avp-badge-linkless']") is not None
        if not title and not body:
            continue
        reviews.append(
            ParsedReview(
                stars=parse_rating(stars_text),
                title=title,
                body=body,
                helpful=helpful,
                verified=verified,
            )
        )
    return reviews


def build_review_summary(reviews: list[ParsedReview], pages_crawled: int) -> dict[str, Any]:
    positive_words = {
        "great", "excellent", "amazing", "quality", "durable", "comfortable", "reliable",
        "perfect", "recommended", "solid", "premium", "works", "bon", "ottimo", "excelente",
        "gut", "super",
    }
    negative_words = {
        "bad", "poor", "broken", "fake", "slow", "defective", "refund", "return", "issue",
        "problem", "malo", "schlecht", "mauvais", "scarso", "rotto",
    }
    stop_words = {
        "the", "and", "for", "this", "that", "with", "from", "have", "been", "very", "not",
        "product", "item", "para", "con", "und", "der", "die", "pour", "avec", "per",
    }

    helpful_votes = 0
    verified_count = 0
    stars: list[float] = []
    pros: list[str] = []
    cons: list[str] = []
    pos_terms: dict[str, int] = {}
    neg_terms: dict[str, int] = {}

    for review in reviews:
        txt = clean_text(f"{review.title}. {review.body}")
        if not txt:
            continue
        helpful_votes += review.helpful
        if review.verified:
            verified_count += 1
        if review.stars is not None:
            stars.append(review.stars)

        sentence = pick_first_sentence(txt)
        words = tokenize(sentence or txt, stop_words)
        pos_hits = sum(1 for w in words if w in positive_words)
        neg_hits = sum(1 for w in words if w in negative_words)

        if sentence:
            if (review.stars is not None and review.stars >= 4.0) or pos_hits >= neg_hits + 1:
                pros.append(sentence)
            elif (review.stars is not None and review.stars <= 2.0) or neg_hits >= pos_hits + 1:
                cons.append(sentence)

        target = None
        if review.stars is not None and review.stars >= 4.0:
            target = pos_terms
        elif review.stars is not None and review.stars <= 2.0:
            target = neg_terms
        if target is not None:
            for word in words:
                if len(word) >= 5 or word in positive_words or word in negative_words:
                    target[word] = target.get(word, 0) + 1

    sample_reviews = len(reviews)
    rating_count = sample_reviews
    avg_stars = round(mean(stars), 3) if stars else None
    variance = round(compute_variance(stars), 3) if len(stars) > 1 else 0.0
    verified_ratio = (verified_count / sample_reviews) if sample_reviews > 0 else 0.0

    authenticity = 50.0 + ((verified_ratio - 0.5) * 45.0)
    if rating_count >= 120:
      authenticity += 10.0
    elif rating_count < 20:
      authenticity -= 8.0
    if variance > 1.8:
      authenticity -= 4.0
    authenticity_score = clamp_int(round(authenticity), 0, 100)

    confidence = 20.0 + min(40.0, float(rating_count)) * 1.7
    if avg_stars is not None:
      confidence += 10.0
    if pages_crawled > 1:
      confidence += 8.0
    confidence_score = clamp_int(round(confidence), 0, 100)

    risk_flags = []
    if rating_count < 20:
        risk_flags.append("Backend crawl still has limited review volume.")
    if verified_ratio < 0.35 and rating_count >= 24:
        risk_flags.append("Low verified-purchase ratio in crawled sample.")
    if variance > 1.8:
        risk_flags.append("Crawled reviews are highly polarized.")

    return {
        "pages_crawled": pages_crawled,
        "sample_reviews": sample_reviews,
        "rating_count": rating_count,
        "avg_stars": avg_stars,
        "variance": variance,
        "verified_ratio": round(verified_ratio, 4),
        "helpful_votes": helpful_votes,
        "pros": dedupe_strings(pros, 8),
        "cons": dedupe_strings(cons, 8),
        "top_positive_terms": top_terms(pos_terms, 6),
        "top_negative_terms": top_terms(neg_terms, 6),
        "risk_flags": risk_flags,
        "authenticity_score": authenticity_score,
        "confidence_score": confidence_score,
    }


def predict_stars(texts: list[str], model_name: str) -> list[float]:
    classifier = get_classifier(model_name)
    if classifier is None:
        return fallback_sentiment_stars(texts)

    stars: list[float] = []
    for text in texts[:40]:
        try:
            output = classifier(text[:700], truncation=True, max_length=256)
            if isinstance(output, list) and output:
                row = output[0] if isinstance(output[0], dict) else None
                label = str((row or {}).get("label", ""))
                score = float((row or {}).get("score", 0.0))
                mapped = label_to_star(label, score)
                if mapped is not None:
                    stars.append(mapped)
        except Exception:
            continue
    return stars


def get_classifier(model_name: str):
    key = f"text-classification::{model_name}"
    if key in _pipeline_cache:
        return _pipeline_cache[key]
    if key in _pipeline_errors:
        return None
    try:
        from transformers import pipeline  # type: ignore
        classifier = pipeline("text-classification", model=model_name, tokenizer=model_name)
        _pipeline_cache[key] = classifier
        return classifier
    except Exception as exc:
        _pipeline_errors[key] = str(exc)
        return None


def get_zero_shot_classifier(model_name: str):
    key = f"zero-shot-classification::{model_name}"
    if key in _pipeline_cache:
        return _pipeline_cache[key]
    if key in _pipeline_errors:
        return None
    try:
        from transformers import pipeline  # type: ignore
        classifier = pipeline("zero-shot-classification", model=model_name, tokenizer=model_name)
        _pipeline_cache[key] = classifier
        return classifier
    except Exception as exc:
        _pipeline_errors[key] = str(exc)
        return None


def classify_aspects(texts: list[str]) -> dict[str, list[str]]:
    classifier = get_zero_shot_classifier(ZERO_SHOT_MODEL_DEFAULT)
    if classifier is None:
        return {"pros": [], "cons": [], "risks": []}

    candidate_labels = [
        "build quality issue",
        "value for money",
        "shipping or delivery issue",
        "seller trust concern",
        "easy to use",
        "works as expected",
    ]
    pros: list[str] = []
    cons: list[str] = []
    risks: list[str] = []

    for text in texts[:18]:
        try:
            result = classifier(text[:360], candidate_labels, multi_label=True)
        except Exception:
            continue
        labels = result.get("labels", [])
        scores = result.get("scores", [])
        if not labels or not scores:
            continue
        for label, score in zip(labels, scores):
            if score < 0.60:
                continue
            if label in {"value for money", "easy to use", "works as expected"}:
                pros.append(f"{label} signal found.")
            if label in {"build quality issue", "shipping or delivery issue"}:
                cons.append(f"{label} signal found.")
            if label in {"seller trust concern", "shipping or delivery issue"}:
                risks.append(f"{label} signal found.")

    return {
        "pros": dedupe_strings(pros, 4),
        "cons": dedupe_strings(cons, 4),
        "risks": dedupe_strings(risks, 4),
    }


def label_to_star(label: str, score: float) -> float | None:
    normalized = (label or "").strip().lower()
    digit = re.search(r"([1-5])", normalized)
    if digit:
        return float(digit.group(1))
    if "positive" in normalized:
        return 4.0 + min(1.0, score)
    if "neutral" in normalized:
        return 3.0
    if "negative" in normalized:
        return 2.0 - min(1.0, score)
    if normalized in {"label_2"}:
        return 4.5
    if normalized in {"label_1"}:
        return 3.0
    if normalized in {"label_0"}:
        return 1.5
    return None


def fallback_sentiment_stars(texts: list[str]) -> list[float]:
    positive = {"great", "excellent", "amazing", "good", "quality", "love", "bon", "ottimo", "gut", "excelente"}
    negative = {"bad", "poor", "broken", "fake", "slow", "defective", "malo", "schlecht", "mauvais", "scarso"}
    out: list[float] = []
    for text in texts[:40]:
        words = tokenize(text, set())
        pos = sum(1 for w in words if w in positive)
        neg = sum(1 for w in words if w in negative)
        if pos + neg == 0:
            out.append(3.0)
            continue
        score = (pos - neg) / max(1, pos + neg)
        stars = 3.0 + (score * 2.0)
        out.append(max(1.0, min(5.0, stars)))
    return out


def build_review_texts(data: dict[str, Any]) -> list[str]:
    texts: list[str] = []
    for key in ("pros", "cons", "riskFlags", "reviewSnippets"):
        for item in data.get(key, []) or []:
            value = clean_text(str(item))
            if value:
                texts.append(value)
    for key in ("positiveThemes", "negativeThemes"):
        joined = ", ".join(clean_text(str(x)) for x in (data.get(key, []) or []) if clean_text(str(x)))
        if joined:
            texts.append(joined)
    return dedupe_strings(texts, 60)


def build_fallback_texts(data: dict[str, Any]) -> list[str]:
    values = [
        data.get("title", ""),
        f"Rating {data.get('rating', 'N/A')}",
        f"Seller {data.get('seller', 'Unknown')}",
        f"Verified ratio {data.get('verifiedRatio', 0)}",
    ]
    return [clean_text(str(v)) for v in values if clean_text(str(v))]


def build_recommendation(authenticity: int, confidence: int, sentiment_avg: float) -> str:
    if authenticity >= 75 and confidence >= 70 and sentiment_avg >= 3.8:
        return "Looks like a strong buy if price/value fit your needs."
    if authenticity < 45 or confidence < 40 or sentiment_avg <= 2.8:
        return "High caution. Compare alternatives and inspect recent low-star reviews."
    return "Moderate confidence. Verify seller history and latest critical reviews before purchase."


def compute_sentiment_confidence(stars: list[float]) -> int:
    if not stars:
        return 30
    avg = mean(stars)
    spread = math.sqrt(compute_variance(stars)) if len(stars) > 1 else 0.0
    confidence = 55 + (len(stars) * 1.2) - (spread * 10.0) + ((avg - 3.0) * 3.0)
    return clamp_int(round(confidence), 0, 100)


def extract_amazon_host(url: str) -> str | None:
    match = re.match(r"^https?://([^/]+)", url.strip(), re.IGNORECASE)
    if not match:
        return None
    host = match.group(1).lower()
    if "amazon." not in host:
        return None
    return host


def parse_rating(text: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)", text.replace(",", "."))
    if not m:
        return None
    try:
        value = float(m.group(1))
        return value if 0.0 <= value <= 5.0 else None
    except ValueError:
        return None


def parse_helpful_votes(text: str) -> int:
    lowered = text.lower()
    if "one person" in lowered:
        return 1
    m = re.search(r"(\d+)", lowered.replace(",", ""))
    return int(m.group(1)) if m else 0


def first_text(root: Any, selectors: list[str]) -> str:
    for selector in selectors:
        node = root.select_one(selector)
        if node is not None:
            txt = node.get_text(" ", strip=True)
            if txt:
                return txt
    return ""


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def pick_first_sentence(text: str) -> str:
    parts = [clean_text(x) for x in re.split(r"[.!?]", text) if clean_text(x)]
    for part in parts:
        if len(part) >= 20:
            return part
    return ""


def tokenize(text: str, stop_words: set[str]) -> list[str]:
    words = re.findall(r"[^\W\d_']{2,}", text.lower(), flags=re.UNICODE)
    return [w for w in words if w not in stop_words]


def top_terms(counts: dict[str, int], max_items: int) -> list[str]:
    return [k for k, _ in sorted(counts.items(), key=lambda it: it[1], reverse=True)[:max_items]]


def dedupe_strings(items: list[Any], limit: int) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in items:
        text = clean_text(str(raw))
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def compute_variance(values: list[float]) -> float:
    if len(values) <= 1:
        return 0.0
    avg = mean(values)
    return sum((x - avg) ** 2 for x in values) / len(values)


def safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default


def clamp_int(value: int, min_v: int, max_v: int) -> int:
    return max(min_v, min(max_v, value))


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8787"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
