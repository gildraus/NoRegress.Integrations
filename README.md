# EvaluateAI GitHub Action

Evaluates one AI output against deterministic rules through an EvaluateAI API and fails the workflow when its score is below the pass threshold.

## Usage

```yaml
- name: Evaluate AI output
  uses: gildraus/evaluateai-github-action@v1
  with:
    api-key: ${{ secrets.EVALUATEAI_API_KEY }}
    input: ${{ steps.generate.outputs.response }}
    rules: '["contains:order", "maxLength:500", "regex:^.{1,500}$"]'
    pass-threshold: "0.8"
```

`api-key` must be a GitHub Actions secret. The action deliberately does not write the supplied AI output or API key to the workflow log.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `service-url` | No | EvaluateAI API base URL, without `/evaluate`. Defaults to `https://api.noregress.dev`; set it for a self-hosted API. |
| `api-key` | Yes | API key sent as a bearer token. |
| `input` | Yes | AI output to evaluate. |
| `rules` | Yes | JSON array of deterministic rule strings. |
| `pass-threshold` | No | Required score between `0` and `1`; defaults to `0.8`. |

## Rule format

The `rules` input is a JSON array. Each item has the form `type:value`, except `isJson`, which has no value:

```json
[
  "contains:order",
  "maxLength:500",
  "regex:^Your order #[0-9]+$",
  "isJson"
]
```

Supported types are `contains`, `isJson`, `maxLength`, and `regex`. The action sends one case with the supplied threshold and generated deterministic-rule IDs to `POST /evaluate`, reads the streamed case and summary lines, then fails if the returned score is below the returned threshold.

## Outputs

| Output | Description |
| --- | --- |
| `passed` | `true` when the evaluation passed; otherwise the action fails. |
| `score` | Evaluation score. |
