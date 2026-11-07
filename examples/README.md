# Example suites

A suite file is the body of a `POST /evaluate` request: a `cases` array and an optional `continueOnFailures`. In a real pipeline, your own step runs your AI app on each `input` and writes the answers into `actualOutput` before NoRegress runs.

| File | What it shows | Expected outcome |
| --- | --- | --- |
| `deterministic.json` | Three cases with exact rules only (regex, length, contains, JSON). Fast, needs no judge. | passed |
| `nordlys/good.json` | A support bot for a fictional outdoor shop, Nordlys: 10 cases with exact and semantic rules. | passed |
| `nordlys/good-reworded.json` | The same facts in other words, as a model upgrade would write them. | passed |
| `nordlys/regressed-after-pr.json` | A prompt change made the bot accept a late return and skip the warranty steps. | failed: 8 passed, 2 failed |
| `nordlys/regressed-verbose.json` | A model upgrade made the bot wordy, with markdown. | failed |
| `nordlys/regressed-wrong-facts.json` | The bot lost its policy sheet: polite, concise and wrong. | failed |
| `nordlys/regressed-policy-breach.json` | Rude answers, a competitor named, card details requested. | failed |

Nordlys, its products, orders and email addresses are invented. No text comes from a real customer.
