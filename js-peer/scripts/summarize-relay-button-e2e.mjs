import { appendFile, readFile } from 'node:fs/promises'

const resultPath = 'test-results/relay-button-chat/result.json'
const summaryPath = process.env.GITHUB_STEP_SUMMARY
const icons = { passed: '✅', failed: '❌', pending: '⏳', skipped: '➖' }

let result
try {
  result = JSON.parse(await readFile(resultPath, 'utf8'))
} catch (error) {
  result = {
    error: `No structured Playwright result was available: ${error instanceof Error ? error.message : String(error)}`,
    steps: {},
  }
}

const rows = Object.values(result.steps ?? {}).map((step) => {
  const detail = String(step.detail ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
  return `| ${icons[step.status] ?? '❔'} | ${step.label} | ${detail || '—'} |`
})
const failed = Object.values(result.steps ?? {}).some((step) => step.status === 'failed') || Boolean(result.error)
const summary = [
  '## js-peer Relay Button E2E',
  '',
  `**Result:** ${failed ? '❌ Failed' : '✅ Passed'}`,
  '',
  '| Status | Test step | Details |',
  '| --- | --- | --- |',
  ...rows,
  '',
  result.instanceName ? `- Instance: \`${result.instanceName}\`` : '',
  result.instanceHash ? `- Aleph instance: \`${result.instanceHash}\`` : '',
  result.error ? `- Error: ${String(result.error).replaceAll('\n', ' ')}` : '',
  '',
].filter((line) => line !== '')

const output = `${summary.join('\n')}\n`
if (summaryPath) await appendFile(summaryPath, output)
else process.stdout.write(output)
