# NoRegress for Azure Pipelines

Fail the pipeline when your AI output gets worse after a model, prompt or setting change.

Your pipeline runs your AI app on a fixed set of test questions and writes the answers into a suite file. The NoRegress task sends that suite to NoRegress, which checks every answer against your rules: exact rules (length, required or forbidden text, regular expressions, valid JSON) and plain-English rules graded by an AI judge. You get one pass or fail, and every case appears in the run's **Tests** tab.

## Use it

```yaml
steps:
  # Your step: run your AI app and write the answers into the suite file.
  - script: ./generate-answers.sh tests/support-bot.json

  - task: NoRegress@1
    inputs:
      suite: tests/support-bot.json
      apiKey: $(NoRegressApiKey)   # a secret variable
```

The step fails when any case fails or the evaluation cannot finish.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `suite` | yes | | Path to the suite file, relative to the repository root |
| `apiKey` | yes | | Your NoRegress API key, from a secret variable |
| `serviceUrl` | no | `https://api.noregress.dev` | Only for a self-hosted NoRegress API |
| `batchSize` | no | `50` | Cases per request |
| `junitFile` | no | `noregress-results.xml` | Where the results file is written |

Output variables: `outcome`, `cases`, `passedCases`, `failedCases`, `inconclusiveCases`, `notGradedCases`, `junitFile`.

## The suite file

```json
{
  "cases": [
    {
      "id": "refund-timing-01",
      "input": "When do I get my money back?",
      "actualOutput": "Refunds reach your card 5 to 10 business days after we receive the return.",
      "deterministicRules": [{ "id": "business-days", "type": "contains", "value": "business days" }],
      "semanticRules": [{ "id": "polite", "criterion": "The response is polite." }]
    }
  ]
}
```

More examples and the full format: [github.com/gildraus/NoRegress.Integrations](https://github.com/gildraus/NoRegress.Integrations).

## Your data

The task logs only case ids, results, scores and rule ids, never your questions, answers, rules or judge reasons. NoRegress does not store what you send. For plain-English rules, the answers are sent to the configured AI judge.
