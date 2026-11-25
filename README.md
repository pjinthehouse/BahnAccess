# Germany Accessible Transit RAG

BahnAccess answers questions about scheduled direct trains and recorded station accessibility at Würzburg Hbf, Nürnberg Hbf, München Hbf, Regensburg Hbf and Augsburg Hbf. It uses a fixed 24 November–5 December 2026 timetable extract. All travel times use Europe/Berlin.

## Install and run locally

1. Install Node.js 22 or later using the [official installer](https://nodejs.org/en/download). Verify the installation with `node --version` and `npm --version`.
2. Extract the source ZIP and open the project folder. For example, on macOS:

   ```sh
   cd ~/Downloads
   unzip germany-accessible-transit-v3.zip
   cd germany-accessible-transit-v3
   ```

3. Run `npm run dev` and open http://127.0.0.1:4173. Leave the terminal running while using the planner. Press Ctrl+C to stop it.

The package includes processed data and embeddings. Node.js is the only runtime dependency. The planner runs locally without API keys or a model download. Use `npm run dev -- --port 4174` if port 4173 is occupied.

## Try the app

| Try this question | What to look for |
|---|---|
| Is the exact departure platform step-free on the 09:39 ICE 41 from Wurzbrg to Nurnbrg on 2026-11-24? | A timetable citation, a separate station-level citation and an explicit exact-platform evidence gap. |
| Show the next train from Augsbrug to Munchen on 24 November 2026 after 9 am. | A scheduled direct connection after the requested time. |
| Are there any elevatrs recorded at Augsbrg Hbf? | A station-only answer and a citation to the lift inventory. |
| Show direct trains from Regensburg to Augsburg on 2026-11-24. | A no-direct-departure result for the covered pair. |

The free-text parser supports common misspellings in station names and supported features. For routes, use “from X to Y”. For inventory questions, give one or more covered station names and the feature to check. ISO dates, day-first dates such as 01.12.2026 and 01/12/2026, day-before-month English dates, today and tomorrow are supported. An invalid explicit date triggers a clarification. Use HH:MM or am/pm and specify “depart after”, “arrive at” or “arrive by” to distinguish departure and arrival constraints. For undated questions outside the active coverage dates, the planner opens the snapshot’s first day and labels that date in the result.

## API

```sh
curl http://127.0.0.1:4173/ask \
  --json '{"question":"Can I reach my exact departure platform without stairs on the 09:39 ICE 41 from Wurzbrg to Nurnbrg?","date":"2026-11-24"}'
```

The structured request format also works:

```sh
curl http://127.0.0.1:4173/ask \
  --json '{"origin":"Regensburg","destination":"Nürnberg","date":"2026-11-24","after":"09:30","needs":["step","lifts"]}'
```

`POST /ask` returns `status`, `answer`, `claims`, `citations`, `journey` and available `options`. Possible statuses are `answered`, `partial` and `refused`. A refused result can still include the identified train as context. Status describes support for the requested claims. For example, a question about the next train and its fare returns the cited timetable and identifies the fare as unavailable. A question asking only whether a train is delayed is refused. The optional `retrieval` field accepts `bm25` or `hybrid`. `includeRetrieval: true` exposes the accessibility retrieval rankings for evaluation. `GET /health` checks the server.

## Retrieval and evidence

- `config/stations.json` records the station displays, aliases, GTFS parent stop IDs, OpenStation StopPlace IDs and map positions used by the extractors and app.
- The timetable is filtered by station pair, date, operating calendar and time. The five-station snapshot covers 16 directed station pairs. The service searches direct departures.
- OpenStation records are split by station or platform and accessibility feature. The lexical baseline is BM25. Hybrid retrieval fuses BM25 and cosine similarity over 12-dimensional TF-IDF/SVD embeddings. The free-text branch ranks with the supplied question plus a canonical feature hint. The final citation must match the requested feature and station scope.
- A local template generator attaches record identifiers and excerpts to the claims. Explicit platform evidence, station-level facts, missing assignments, unknown values and live status are handled separately. The runtime has no LLM calls. Station flags alone cannot establish boarding for a specific vehicle.

## Run the evaluation

```sh
npm test
```

The engineering tests check 35 cases in each retrieval mode. They also exercise missing and explicitly unknown fields, route direction, citation values, both new stations and a pair with zero direct journeys in the extract. Free-text regressions cover date formats, arrival-time constraints, unsupported questions, and mixed requests about fares, live status and station equipment. The report includes refusal rate, false-refusal rate, matched labels, citation checks, warm local latency and model-call cost. Run `npm test -- --write-report` to refresh `evaluation/results.json`.

For the course gold evaluation:

1. Copy `evaluation/gold-template.json` to `evaluation/gold.json`. Add questions that mix supported, partially supported and unsupported claims.
2. Have teammates independently read the pinned source records. Fill in `annotators`, `expected` (`answered`, `partial` or `refused`) and `rationale`. For any expected accessibility evidence add `{ "locator": "<StopPlace or Quay ID>", "field": "<field name>" }` to `evidence`. Use an empty array where appropriate. Freeze the labels before comparing outputs.
3. Run `npm run evaluate:gold -- evaluation/gold.json`. The harness reports metrics and per-case label disagreements for both retrievers. Evidence recall is computed over the top five accessibility chunks per claim where targets are supplied.

Refusal rate uses unanswerable questions as its denominator. False-refusal rate uses all fully and partially answerable questions. The bundled labels are engineering regressions. The gold template includes candidate wording and blank labels for the team.

## Data and reproduction

- [GTFS.de Germany Full](https://www.gtfs.de/en/feeds/de_full/) is derived from DELFI e.V. The source feed also credits GTFS.de and OpenStreetMap contributors. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Snapshot dated 21 November 2026. The bundled timetable is a filtered, denormalized extract.
- [DB InfraGO OpenStation NeTEx](https://github.com/dbinfrago/openstation-docs), published 24 November 2026. [XML download](https://bahnhof.de/daten/netex). The bundled extract contains accessibility fields and record IDs. Equipment counts apply to the selected StopPlace.
- The core project contains processed records and retains the raw file hashes in `data/`. The source download URLs can rotate. Matching source hashes are required to reproduce the pinned data. Fresh releases may require updating GTFS parent stop IDs and expected trip IDs.

To regenerate the extracts and embeddings with the two pinned raw files, use Python 3.11 or later and NumPy:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install numpy
python scripts/extract_timetable.py transit-full.zip data/timetable.json \
  --first 2026-11-24 --last 2026-12-05 --snapshot 2026-11-21
python scripts/extract_stations.py openstation.xml data/stations.json
node scripts/build_embeddings.mjs
npm test -- --write-report
```

`npm run build` assembles the Worker at `dist/server/index.js`. The downloadable project builds without a private Sites project identifier.

## Course references

- [NLP Assignment Catalog](https://i-yam.github.io/nlp_milestones/)
- [Advanced RAG](https://huggingface.co/learn/cookbook/advanced_rag)
- [RAG from Scratch](https://www.youtube.com/playlist?list=PLfaIDFEXuae2LXbO1_PKyVJiQ23ZztA0x)
- [BM25S](https://github.com/xhluca/bm25s)
- [RAG with source highlighting](https://huggingface.co/learn/cookbook/structured_generation)
- [RAG Evaluation](https://huggingface.co/learn/cookbook/rag_evaluation)
