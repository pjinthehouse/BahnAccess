"""Fit a small latent semantic vector store on the source passages."""
import collections
import json
import sys
import numpy as np

documents = json.load(sys.stdin)
vocab = sorted(set(term for document in documents for term in document))
counts = [collections.Counter(document) for document in documents]
matrix = np.array([[count[term] for term in vocab] for count in counts], dtype=float)
idf = np.log((1 + len(documents)) / (1 + (matrix > 0).sum(axis=0))) + 1
features = np.log1p(matrix) * idf
features /= np.linalg.norm(features, axis=1, keepdims=True)
_, _, vt = np.linalg.svd(features, full_matrices=False)
basis = vt[:12].T
rows = features @ basis
rows /= np.linalg.norm(rows, axis=1, keepdims=True)
print(json.dumps({
    "vocab": vocab, "idf": idf.round(8).tolist(), "width": basis.shape[1],
    "basis": basis.round(8).tolist(), "rows": rows.round(8).tolist(),
}, separators=(",", ":")))
