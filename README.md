# Amazon Review Lens

Amazon product intelligence extension with:
- Compact floating card (shown before product section, not across the full page)
- Local review parsing (pros, cons, seller trust, risk signals)
- Decision Mode (`BUY` / `MAYBE` / `AVOID`) with reasons + "what would change"
- Popup settings (compact mode, thresholds, section toggles, personalization, cache, feedback)
- Multilingual dictionaries (`en`, `es`, `de`, `fr`, `it`, `ja`, plus auto detect)
- Python backend review crawling for stronger confidence/authenticity scoring
- Open-source AI integration (no OpenAI key required) via backend endpoint
- Suspicion score (repetition + burst + imbalance), timeline trend, and alternatives comparison
- Explainability panel with clickable evidence snippets and feedback loop

## Architecture
- Extension:
  - `manifest.json`
  - `src/content/content.js`
  - `src/content/content.css`
  - `src/background/service-worker.js`
  - `src/popup/popup.html`
  - `src/popup/popup.css`
  - `src/popup/popup.js`
- Backend API:
  - `backend/app.py`
  - `backend/requirements.txt`
  - `backend/.env.example`

## Extension install
1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select `d:\amz_product-ext`
5. Open an Amazon product page (`/dp/...` or `/gp/product/...`)

## Python backend setup (required for open-source AI + crawl)
1. Open terminal in `d:\amz_product-ext\backend`
2. `python -m venv .venv`
3. `.venv\Scripts\activate`
4. `pip install -r requirements.txt`
5. Copy `.env.example` to `.env` (optional)
6. `python app.py`

Default backend URL is `http://localhost:8787`.

## Using AI integration
From extension popup:
1. Enable `AI scoring`
2. Keep backend running (`http://localhost:8787`)
3. Choose model (default `cardiffnlp/twitter-xlm-roberta-base-sentiment`)
4. Refresh current product page from popup

## Important notes
- Open-source backend model requires first-time model download from Hugging Face.
- Amazon anti-bot protections can limit backend crawl quality depending on IP/region/traffic.
- This is a production-grade scaffold; add monitoring, retries, caching, and stricter validation before public release.
