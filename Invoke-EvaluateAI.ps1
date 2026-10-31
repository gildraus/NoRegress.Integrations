[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ServiceUrl,

    [Parameter(Mandatory)]
    [string]$ApiKey,

    [Parameter(Mandatory)]
    [string]$ActualOutput,

    [Parameter(Mandatory)]
    [string]$Rules,

    [Parameter(Mandatory)]
    [string]$PassThreshold
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not [uri]::TryCreate($ServiceUrl, [UriKind]::Absolute, [ref]$null)) {
    throw "service-url must be an absolute URL."
}

$threshold = 0.0
if (-not [double]::TryParse(
        $PassThreshold,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$threshold) -or $threshold -lt 0 -or $threshold -gt 1) {
    throw "pass-threshold must be a number between 0 and 1."
}

try {
    $ruleStrings = $Rules | ConvertFrom-Json -NoEnumerate
}
catch {
    throw "rules must be a JSON array of strings, for example: [""contains:order"", ""maxLength:500""]. $($_.Exception.Message)"
}

if ($ruleStrings -is [string] -or $ruleStrings -isnot [System.Collections.IEnumerable]) {
    throw "rules must be a JSON array of strings."
}

$deterministicRules = [System.Collections.Generic.List[object]]::new()
$ruleNumber = 0
foreach ($ruleString in $ruleStrings) {
    $ruleNumber++
    if ($ruleString -isnot [string] -or [string]::IsNullOrWhiteSpace($ruleString)) {
        throw "rules[$($ruleNumber - 1)] must be a non-empty string."
    }

    $parts = $ruleString.Split(":", 2)
    $type = $parts[0].Trim()
    $rawValue = if ($parts.Count -eq 2) { $parts[1] } else { $null }

    switch ($type) {
        "isJson" {
            if ($null -ne $rawValue -and $rawValue.Length -gt 0) {
                throw "rules[$($ruleNumber - 1)] isJson does not accept a value. Use ""isJson""."
            }

            $deterministicRules.Add([ordered]@{
                    id = "rule-$ruleNumber"
                    type = $type
                })
        }
        "maxLength" {
            $maximumLength = 0
            if ($null -eq $rawValue -or -not [int]::TryParse(
                    $rawValue,
                    [Globalization.NumberStyles]::Integer,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [ref]$maximumLength) -or $maximumLength -lt 0) {
                throw "rules[$($ruleNumber - 1)] maxLength requires a non-negative integer, for example ""maxLength:500""."
            }

            $deterministicRules.Add([ordered]@{
                    id = "rule-$ruleNumber"
                    type = $type
                    value = $maximumLength
                })
        }
        { $_ -in "contains", "regex" } {
            if ([string]::IsNullOrEmpty($rawValue)) {
                throw "rules[$($ruleNumber - 1)] $type requires a value, for example ""$type:value""."
            }

            $deterministicRules.Add([ordered]@{
                    id = "rule-$ruleNumber"
                    type = $type
                    value = $rawValue
                })
        }
        default {
            throw "rules[$($ruleNumber - 1)] has unsupported type ""$type"". Supported types are contains, isJson, maxLength, and regex."
        }
    }
}

# The API evaluates a list of cases and streams one JSON line per case, "waiting" lines while the judge is slow,
# then a final "summary" line. This action sends one case and reads its line plus the summary.
$caseId = "github-action"
$request = @{
    cases = @(
        [ordered]@{
            id = $caseId
            actualOutput = $ActualOutput
            passThreshold = $threshold
            deterministicRules = $deterministicRules
        }
    )
}

$uri = "$($ServiceUrl.TrimEnd('/'))/evaluate"
$response = Invoke-WebRequest `
    -Method Post `
    -Uri $uri `
    -Headers @{ Authorization = "Bearer $ApiKey"; Accept = "application/x-ndjson" } `
    -ContentType "application/json" `
    -Body ($request | ConvertTo-Json -Depth 10 -Compress) `
    -SkipHttpErrorCheck

# Invoke-WebRequest keeps the body as bytes for content types it does not know, such as application/x-ndjson.
$body = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }

if ($response.StatusCode -eq 400) {
    # Validation errors name request fields and rule ids only, never the evaluated text.
    throw "EvaluateAI rejected the request (HTTP 400): $body"
}

if ($response.StatusCode -ne 200) {
    throw "EvaluateAI returned HTTP $($response.StatusCode). The workflow cannot determine a passing evaluation."
}

$caseLine = $null
$summaryLine = $null
$errorLine = $null
foreach ($rawLine in $body -split "`n") {
    if ([string]::IsNullOrWhiteSpace($rawLine)) {
        continue
    }

    try {
        $line = $rawLine | ConvertFrom-Json
    }
    catch {
        throw "EvaluateAI returned an invalid JSON line. $($_.Exception.Message)"
    }

    switch ($line.type) {
        "case" {
            if ($line.id -eq $caseId) {
                $caseLine = $line
            }
        }
        "summary" { $summaryLine = $line }
        "error" { $errorLine = $line }
        "waiting" { Write-Host "EvaluateAI is waiting for the judge: $($line.reason) ($($line.elapsedSeconds)s)" }
    }
}

if ($null -ne $errorLine) {
    throw "EvaluateAI stopped the evaluation: $($errorLine.reason)"
}

if ($null -eq $caseLine -or $null -eq $summaryLine) {
    throw "EvaluateAI returned an incomplete evaluation response."
}

if ($null -eq $caseLine.PSObject.Properties["passThreshold"]) {
    throw "EvaluateAI returned an incomplete evaluation response."
}

$returnedThreshold = [double]$caseLine.passThreshold
# score and passed are null when nothing could be evaluated; that never passes.
$hasScore = $null -ne $caseLine.score
$score = if ($hasScore) { [double]$caseLine.score } else { 0.0 }
$passed = $caseLine.passed -eq $true -and $hasScore -and $score -ge $returnedThreshold -and $summaryLine.outcome -eq "passed"

$scoreText = if ($hasScore) { "$score" } else { "none" }
Write-Host "EvaluateAI score: $scoreText; threshold: $returnedThreshold; passed: $passed"

if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "passed=$($passed.ToString().ToLowerInvariant())"
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "score=$scoreText"
}

if (-not $passed) {
    throw "EvaluateAI evaluation failed: score $scoreText is below threshold $returnedThreshold."
}
