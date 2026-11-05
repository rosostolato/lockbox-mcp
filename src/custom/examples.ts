/**
 * Worked definitions an agent can adapt (REQ-021). Each one must pass
 * `parseDefinition`; `test/custom/examples.test.ts` keeps them honest.
 */

export const CUSTOM_DEFINITION_EXAMPLES = Object.freeze({
  env_file: {
    kind: 'file',
    label: 'Project .env',
    path: '.env',
    template: '{{name}}={{secret}}',
    mode: 'env',
  },
  google_secret_manager: {
    kind: 'command',
    label: 'Google Secret Manager',
    executable: '/opt/homebrew/bin/gcloud',
    args: [
      'secrets',
      'versions',
      'add',
      'stripe-secret-key',
      '--project',
      'acme-prod',
      '--data-file=-',
    ],
    stdin: '{{secret}}',
  },
  http_api: {
    kind: 'http',
    label: 'Internal secrets API',
    url: 'https://secrets.example.com/v1/projects/acme/secrets',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { type: 'json', value: { name: '{{name}}', value: '{{secret}}' } },
    reference: '$.id',
  },
});
