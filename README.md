# NoRegress Integrations

CI integrations for [NoRegress](https://noregress.dev): fail the build when your AI output gets worse after a model, prompt or setting change.

- **GitHub Action**: `gildraus/NoRegress.Integrations@v2`
- **Azure DevOps task**: `NoRegress@1`, from the Visual Studio Marketplace

Both do the same thing with the same code: read your suite file, send it to the NoRegress API in batches of up to 50 cases, print each case's result, write a JUnit XML file and pass or fail the step.

## How it fits in your pipeline

1. You keep a **suite file** in your repository: test questions and the rules each answer must follow.
2. A step of your own runs your AI app on each question and writes the answers into the suite file (`actualOutput`). NoRegress never calls your app.
3. The NoRegress step sends the suite to NoRegress and fails the build if any case fails.

## The suite file

A suite file is the body of a `POST /evaluate` request: a `cases` array and an optional `continueOnFailures`.

```json
{
  "cases": [
    {
      "id": "refund-timing-01",
      "input": "When do I get my money back?",
      "actualOutput": "Refunds reach your card 5 to 10 business days after we receive the return.",
      "expectedOutput": "Refunds take 5 to 10 business days after the return arrives.",
      "passThreshold": 0.8,
      "deterministicRules": [
        { "id": "business-days", "type": "contains", "value": "business days" },
        { "id": "short", "type": "maxLength", "value": 600 }
      ],
      "semanticRules": [
        { "id": "polite", "criterion": "The response is polite and professional." }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique name of the case, shown in the results |
| `input` | The question your app was asked (optional, gives the judge context) |
| `actualOutput` | Your app's answer: the text being checked |
| `expectedOutput` | Optional key points a good answer covers, graded by the judge |
| `passThreshold` | Share of rules that must pass, from 0 to 1 (default 0.8) |
| `deterministicRules` | Exact checks: `maxLength`, `contains`, `notContains`, `regex`, `isJson` |
| `semanticRules` | Plain-English rules graded by the AI judge |
| `continueOnFailures` | Top level, optional: `true` reports failures without failing the step |

See [`examples/`](examples/) for complete suites, including a 10-case support bot.

## GitHub Actions

```yaml
jobs:
  ai-regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Your step: run your AI app and write the answers into the suite file.
      - run: ./generate-answers.sh tests/support-bot.json

      - uses: gildraus/NoRegress.Integrations@v2
        with:
          suite: tests/support-bot.json
          api-key: ${{ secrets.NOREGRESS_API_KEY }}
```

Add the key as a repository secret (Settings > Secrets and variables > Actions). The run page shows a summary table with one row per case.

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `suite` | yes | | Path to the suite file, relative to the repository root |
| `api-key` | yes | | Your NoRegress API key, from a secret |
| `service-url` | no | `https://api.noregress.dev` | Only for a self-hosted NoRegress API |
| `batch-size` | no | `50` | Cases per request |
| `junit-file` | no | `noregress-results.xml` | Where the JUnit XML file is written |

| Output | Meaning |
| --- | --- |
| `outcome` | `passed` or `failed`; an evaluation that could not finish is `failed` |
| `cases`, `passed-cases`, `failed-cases`, `inconclusive-cases`, `not-graded-cases` | Counts |
| `junit-file` | Absolute path of the JUnit XML file |

GitHub has no built-in test results tab. To see the cases as tests, pass `junit-file` to a test report action of your choice, or upload it as an artifact.

## Azure DevOps

Install the NoRegress extension from the Visual Studio Marketplace into your organization, add the key as a secret pipeline variable, and add the task:

```yaml
steps:
  # Your step: run your AI app and write the answers into the suite file.
  - script: ./generate-answers.sh tests/support-bot.json

  - task: NoRegress@1
    inputs:
      suite: tests/support-bot.json
      apiKey: $(NoRegressApiKey)
```

The inputs are the same as the GitHub Action's, in Azure DevOps naming: `suite`, `apiKey`, `serviceUrl`, `batchSize`, `junitFile`. The task publishes the JUnit file, so every case appears in the run's **Tests** tab. Output variables: `outcome`, `cases`, `passedCases`, `failedCases`, `inconclusiveCases`, `notGradedCases`, `junitFile`. It runs on Linux and Windows agents.

## What the step prints

```
NoRegress: evaluating 10 cases from tests/support-bot.json in 1 request(s) of at most 50 cases.
Waiting: The judge model is loading. (30s)
PASSED       order-status-01  score 1.00 / threshold 0.80
FAILED       return-window-01  score 0.78 / threshold 1.00  (failed rules: declines-return)
...
NoRegress: 10 cases: 8 passed, 2 failed, 0 inconclusive, 0 not graded. Outcome: failed.
```

A case is **inconclusive** when the judge could not grade one of its rules; that fails the step like a failed case. A case is **not graded** when all its rules were skipped (the judge is turned off); that does not fail the step.

The step fails without an outcome when the API key is rejected, the suite is invalid, or the evaluation stops before the end. It waits as long as the API keeps reporting progress, so a slow judge does not fail the run.

## Your data

The step prints, outputs and writes to the JUnit file only case ids, results, scores, thresholds and rule ids. It never shows your questions, answers, expected outputs, rules or judge reasons, and it never shows the API key. NoRegress does not store what you send; for semantic rules and `expectedOutput`, the answers are sent to the configured AI judge.

## Version 1

`@v1` is the earlier single-output action: one `input`, a JSON array of exact `rules` such as `["contains:order", "maxLength:500"]`, and a `pass-threshold`. It keeps working unchanged. New pipelines should use `@v2`.

## Development

```sh
npm test                      # unit tests, no network
npm run package:azure         # builds dist/*.vsix
```

The code is plain JavaScript with no dependencies: `src/core.js` holds the logic, `src/github.js` and `src/azure.js` adapt it to each CI system. Publishing steps for maintainers are in [`docs/owner-setup.md`](docs/owner-setup.md).

## License

MIT. See [LICENSE](LICENSE). The license covers this repository only; calling the hosted NoRegress API needs an API key.
