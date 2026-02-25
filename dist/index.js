const core = require('@actions/core');
const axios = require('axios');
const fg = require('fast-glob');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

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
  form.append(
    'meta',
    JSON.stringify({
      source: 'github-action',
      filePath
    })
  );

  const response = await axios.post(endpoint, form, {
    headers: {
      ...form.getHeaders(),
      ...(apiKey ? { 'X-API-KEY': apiKey } : {})
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true
  });

  return {
    filePath,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    body: response.data
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
        error: error.message
      });
      core.warning(`Upload failed for ${file}: ${error.message}`);
    }
  }

  const validatedCount = results.filter((x) => x.ok).length;
  const failedCount = results.length - validatedCount;

  core.setOutput('validated-count', String(validatedCount));
  core.setOutput('failed-count', String(failedCount));
  core.setOutput('success', String(failedCount === 0));
  core.setOutput('results-json', JSON.stringify(results));

  if (failedCount > 0) {
    core.setFailed(`Validation failed for ${failedCount} file(s).`);
  }
}

run().catch((error) => {
  core.setFailed(error.message);
});
