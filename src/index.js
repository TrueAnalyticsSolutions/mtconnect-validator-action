const core = require('@actions/core');
const axios = require('axios');
const fg = require('fast-glob');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

function buildValidationMeta(filePath) {
  const actor = process.env.GITHUB_ACTOR || 'github-actions[bot]';
  const runId = process.env.GITHUB_RUN_ID || `${Date.now()}`;
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runUrl = repo && process.env.GITHUB_SERVER_URL
    ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${runId}`
    : undefined;

  const notes = {
    schema: 1,
    source: 'github-action',
    repo,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    path: filePath,
    run_id: runId,
    workflow: process.env.GITHUB_WORKFLOW,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    run_url: runUrl,
    job: process.env.GITHUB_JOB,
    workspaceKey: repo && filePath ? `${repo}:${filePath}` : undefined,
    trackKey: repo && filePath ? `${repo}:${filePath}` : undefined
  };

  return {
    Author: actor,
    Notes: JSON.stringify(notes)
  };
}

function summarizeValidationBody(body) {
  if (!Array.isArray(body)) {
    return {
      compliant: false,
      validationErrorCount: 0,
      validationWarningCount: 0,
      validationMessage: 'Validation API response was not an array.'
    };
  }

  const validationErrorCount = body.reduce((sum, item) => sum + Number(item?.ErrorCount || 0), 0);
  const validationWarningCount = body.reduce((sum, item) => sum + Number(item?.WarningCount || 0), 0);
  const compliant = body.every((item) => item?.IsValid === true || item?.isValid === true);

  return {
    compliant,
    validationErrorCount,
    validationWarningCount,
    validationMessage: compliant
      ? 'Document is compliant.'
      : `Document is non-compliant (${validationErrorCount} error(s)).`
  };
}

function parseFileListInput(value) {
  if (!value || !value.trim()) {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (error) {
      core.warning(`files input looked like JSON but could not be parsed: ${error.message}`);
    }
  }

  return trimmed
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function resolveFiles(filesInput, fileRegexInput) {
  const explicitFiles = parseFileListInput(filesInput);
  if (explicitFiles.length > 0) {
    return explicitFiles;
  }

  const regex = new RegExp(fileRegexInput || '(^|/)Devices\\.xml$', 'i');
  const allFiles = await fg(['**/*'], {
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: true,
    ignore: ['**/node_modules/**', '**/.git/**']
  });

  return allFiles.filter((file) => regex.test(file.replace(/\\/g, '/')));
}

async function uploadFile(endpoint, apiKey, filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'application/xml'
  });
  form.append('meta', JSON.stringify(buildValidationMeta(filePath)));

  const response = await axios.post(endpoint, form, {
    headers: {
      ...form.getHeaders(),
      ...(apiKey ? { 'X-API-KEY': apiKey } : {})
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true
  });

  const summary = response.status >= 200 && response.status < 300
    ? summarizeValidationBody(response.data)
    : {
      compliant: false,
      validationErrorCount: 0,
      validationWarningCount: 0,
      validationMessage: `Validation API returned HTTP ${response.status}`
    };

  return {
    filePath,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    body: response.data,
    compliant: summary.compliant,
    validationErrorCount: summary.validationErrorCount,
    validationWarningCount: summary.validationWarningCount,
    validationMessage: summary.validationMessage
  };
}

async function run() {
  const endpoint = core.getInput('api-endpoint') || 'https://validator.tams.ai/api/validation/validate';
  const apiKey = core.getInput('api-key');
  const fileRegex = core.getInput('file-regex') || '(^|/)Devices\\.xml$';
  const filesInput = core.getInput('files');

  const files = await resolveFiles(filesInput, fileRegex);
  if (files.length === 0) {
    core.setOutput('validated-count', '0');
    core.setOutput('failed-count', '0');
    core.setOutput('non-compliant-count', '0');
    core.setOutput('compliant-count', '0');
    core.setOutput('success', 'true');
    core.setOutput('results-json', JSON.stringify([]));
    core.info('No files matched input criteria.');
    return;
  }

  core.info(`Found ${files.length} file(s) to validate.`);

  const results = [];
  for (const file of files) {
    core.info(`Uploading ${file}...`);
    try {
      const result = await uploadFile(endpoint, apiKey, file);
      results.push(result);
      if (!result.ok) {
        core.warning(`Validation API returned ${result.status} for ${file}`);
      }
    } catch (error) {
      results.push({
        filePath: file,
        ok: false,
        status: 0,
        compliant: false,
        validationErrorCount: 0,
        validationWarningCount: 0,
        validationMessage: error.message,
        error: error.message
      });
      core.warning(`Upload failed for ${file}: ${error.message}`);
    }
  }

  const validatedCount = results.filter((x) => x.ok).length;
  const failedCount = results.filter((x) => !x.ok).length;
  const nonCompliantCount = results.filter((x) => x.ok && !x.compliant).length;
  const compliantCount = results.filter((x) => x.ok && x.compliant).length;

  core.setOutput('validated-count', String(validatedCount));
  core.setOutput('failed-count', String(failedCount));
  core.setOutput('non-compliant-count', String(nonCompliantCount));
  core.setOutput('compliant-count', String(compliantCount));
  core.setOutput('success', String(failedCount === 0 && nonCompliantCount === 0));
  core.setOutput('results-json', JSON.stringify(results));

  if (failedCount > 0 || nonCompliantCount > 0) {
    core.setFailed(`Validation failed: ${failedCount} upload/API failure(s), ${nonCompliantCount} non-compliant file(s).`);
  }
}

run().catch((error) => {
  core.setFailed(error.message);
});
