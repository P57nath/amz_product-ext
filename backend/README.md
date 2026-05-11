# Amazon Review Lens Backend (Python)

Python backend API for:
- Multi-page Amazon review crawling
- Local AI scoring with open-source model (no OpenAI key required)

Default sentiment model: `cardiffnlp/twitter-xlm-roberta-base-sentiment`  
Default zero-shot model: `MoritzLaurer/mDeBERTa-v3-base-mnli-xnli`

## Setup
1. `cd backend`
2. `python -m venv .venv`
3. Windows: `.venv\\Scripts\\activate`
4. `pip install -r requirements.txt`
5. Copy `.env.example` to `.env` (optional)
6. `python app.py`

Server runs at `http://localhost:8787`.

## Endpoints
- `GET /health`
- `GET /api/reviews/summary?asin=<ASIN>&url=<AmazonProductURL>&pages=3`
- `POST /api/ai/analyze`
- `POST /api/feedback`

### `POST /api/ai/analyze` sample body
```json
{
  "model": "cardiffnlp/twitter-xlm-roberta-base-sentiment",
  "locale": "en",
  "input": {
    "title": "Product title",
    "pros": ["Good battery life"],
    "cons": ["Plastic build"]
  }
}
```

## Notes
- First model load downloads weights from Hugging Face.
- If model loading fails, backend falls back to rule-based sentiment heuristics.
- Amazon may throttle automated crawling depending on IP, region, and request volume.
- Feedback records are stored in `feedback.jsonl` (or `FEEDBACK_FILE` path).
