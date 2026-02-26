# MTConnect Validator GitHub Action (Template)

This template provides a public GitHub Action that discovers MTConnect XML files in a checked-out repository and uploads them to the MTConnect Validator API.

It is intended to be copied into a separate public repository and published as your reusable action.

## What this action does

- Accepts either:
  - an explicit list of files (`files`), or
  - a regex (`file-regex`) used to discover files from the repository workspace.
- Uploads each file to the validator API endpoint as `multipart/form-data`.
- Includes optional API key authentication via `X-API-KEY` header.
- Returns upload/compliance counts and a machine-readable JSON result payload.

## Prerequisites

1. The workflow using this action must run `actions/checkout` first.
2. The target API endpoint must be reachable from the GitHub runner.
3. If your endpoint requires authentication, define a secret (recommended standard name: `MTC_VALIDATOR_API_KEY`) and pass it via the `api-key` input.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `api-endpoint` | No | `https://validator.tams.ai/api/validation/validate` | API URL used for file validation uploads. |
| `api-key` | No | _(empty)_ | API key sent as the `X-API-KEY` header. |
| `file-regex` | No | `(^|/)Devices\\.xml$` | JavaScript regex used to discover files if `files` is not provided. |
| `files` | No | _(empty)_ | Explicit files to validate. Supports JSON array, newline-separated list, or comma-separated list. |

> Priority rule: if `files` is provided and non-empty, regex discovery is skipped.

## Outputs

| Name | Description |
|---|---|
| `validated-count` | Number of files with successful (HTTP 2xx) validation responses. |
| `failed-count` | Number of files that failed upload or returned non-2xx responses. |
| `non-compliant-count` | Number of successfully uploaded files that were still non-compliant (`ErrorCount > 0` and/or `IsValid = false`). |
| `compliant-count` | Number of successfully uploaded files that are compliant. |
| `success` | `true` only when every file both uploads successfully and is compliant. |
| `results-json` | JSON array with per-file status/body plus compliance fields (`compliant`, `validationErrorCount`, etc.). |

## Example workflow

```yaml
name: validate-mtconnect

on:
  pull_request:
  push:
    branches: [ main ]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Validate MTConnect files
        id: mtc
        continue-on-error: true
        uses: TrueAnalyticsSolutions/validator-mtconnect-action@v2
        with:
          api-endpoint: https://validator.tams.ai/api/validation/validate
          api-key: ${{ secrets.MTC_VALIDATOR_API_KEY }}
          file-regex: '(^|/)Devices\.xml$'

      - name: Print results
        run: |
          echo "validated: ${{ steps.mtc.outputs.validated-count }}"
          echo "failed: ${{ steps.mtc.outputs.failed-count }}"
          echo "non-compliant: ${{ steps.mtc.outputs.non-compliant-count }}"
          echo "compliant: ${{ steps.mtc.outputs.compliant-count }}"
          echo "success: ${{ steps.mtc.outputs.success }}"
          echo '${{ steps.mtc.outputs.results-json }}'

      - name: Fail workflow when any document is non-compliant
        env:
          RESULTS_JSON: ${{ steps.mtc.outputs.results-json }}
        run: |
          failed_uploads=$(echo "$RESULTS_JSON" | jq '[.[] | select(.ok != true)] | length')
          non_compliant=$(echo "$RESULTS_JSON" | jq '[.[] | select(.ok == true and .compliant != true)] | length')

          if [ "$failed_uploads" -gt 0 ] || [ "$non_compliant" -gt 0 ]; then
            echo "Validation failed ($failed_uploads upload/API failure(s), $non_compliant non-compliant file(s))."
            exit 1
          fi
```

## Local build

```bash
npm install
npm run build
```

This compiles `src/index.js` into `dist/index.js` using webpack.

The action now sends CI metadata (`Author` + structured `Notes`) with each upload so Enterprise CI Bulk Validation views can trace repository, run, and file context.
