# Compare coverage

Open a recent article and expand **Compare coverage** to see nearby reporting from other publishers. The panel shows the shared headline terms behind each suggestion, marks nearly identical wording, and links to both the ThreadNews record and the available publisher link. An official source label identifies who published a record. Different outlets can cite the same original report.

## Request path

1. The article shell loads its primary record and any attached editorial sources. Expanding the panel loads the React and TypeScript bundle and calls `GET /api/news/:id/coverage`.
2. The Worker checks whether the anchor article is visible. It uses the existing `news_page` index to look up at most 80 records on each side of that article's publication time, within 36 hours and the public feed window. The same publication and retraction rules as the public feed apply.
3. A regularized logistic regression model scores eligible headline pairs. The Worker returns up to six suggestions, with one result per publisher and unique source URLs. When a direct publisher URL is available, the response prefers it.
4. The UI can sort by closest match or earliest publication. It handles empty results, temporary errors, and cancellation on navigation. Results use the existing short public API cache. The comparison sends no account cookie and needs no model provider or extra database.

## Reproduce the model and benchmark

From the repository root with Node.js 24 and Python 3:

```sh
python backend/scripts/train_coverage.py
python backend/scripts/train_coverage.py --write-model
node --test --test-name-pattern="coverage comparison" backend/test/content.test.js
npm --prefix backend run check:coverage
```

The first command refits the model and verifies the checked-in artifact, including the SHA-256 hash of the data. The second regenerates the artifact after an intentional change to features or examples. GitHub Actions verifies reproducibility on each source check.

The fixture contains 121 manually labeled pairs drawn from 144 attributed ThreadNews headlines captured on 25 November 2026. Review labels indicate whether the headlines describe the same development. Development group, article ID, and exact headline checks keep those examples in a single split. The 61 training pairs fit the weights, 25 validation pairs select the decision threshold, and 35 held-out pairs measure the result. The production JavaScript extracts features for both fitting and serving so token normalization and feature definitions agree.

| Held-out method | Correct matches | Incorrect matches | Missed matches | Precision | Recall | F0.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Jaccard and containment thresholds | 3 | 0 | 16 | 100% | 15.8% | 0.484 |
| Logistic regression | 12 | 3 | 7 | 80% | 63.2% | 0.760 |

The threshold search favors at least 90% precision on validation, then maximizes F0.5. The learned model recovers more labeled matches on the held-out split and introduces three mistaken suggestions. These are pair-level results on a small, selected snapshot. Production quality also depends on the news mix, what publishers put in their headlines, and which reports enter the bounded candidate window.
