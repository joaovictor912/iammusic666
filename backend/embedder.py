import sys, json
from sentence_transformers import SentenceTransformer
import numpy as np

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

def main():
    print("--- 🐍 PYTHON: O script embedder.py foi ativado e está processando... ---", file=sys.stderr)
    data = json.load(sys.stdin)
    texts = data.get("texts", [])
    if not isinstance(texts, list): texts = []
    try:
        model = SentenceTransformer(MODEL_NAME)
        embs = model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
        # convert to python lists of floats
        out = {"embeddings": [e.tolist() for e in embs]}
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()