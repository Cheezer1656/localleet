// End-to-end smoke test of the Firefox build against live leetcode.com.
// Installs dist/firefox as a temporary add-on over WebDriver BiDi, runs a
// Python and a C++ solution to Two Sum and checks the LocalLeet tab reports
// "Accepted" for each.
//
//   npm run build:firefox && npm run test:firefox
//   FIREFOX=/path/to/firefox HEADLESS=0 npm run test:firefox

import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extensionDir = fileURLToPath(new URL('../dist/firefox', import.meta.url));
const SOLUTIONS = {
  python3: `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i
`,
  cpp: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> seen;
        for (int i = 0; i < nums.size(); i++) {
            if (seen.count(target - nums[i])) return {seen[target - nums[i]], i};
            seen[nums[i]] = i;
        }
        return {};
    }
};
`,
};

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX ?? execFileSync('which', ['firefox']).toString().trim(),
  headless: process.env.HEADLESS !== '0',
});

try {
  await browser.installExtension(extensionDir);
  const page = await browser.newPage();
  await page.goto('https://leetcode.com/problems/two-sum/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.monaco?.editor?.getModels().length, { timeout: 60000 });
  await page.waitForSelector('#localleet-run-button', { timeout: 30000 });

  for (const [lang, code] of Object.entries(SOLUTIONS)) {
    await page.evaluate(
      (lang, code) => {
        const model = monaco.editor.getModels().find((m) => m.getLanguageId() !== 'plaintext');
        monaco.editor.setModelLanguage(model, lang);
        model.setValue(code);
        // Drop the previous run's verdict so we wait for this one.
        document
          .getElementById('localleet-panel-host')
          ?.shadowRoot?.querySelector('.summary, .error-box')
          ?.remove();
        document.getElementById('localleet-run-button').shadowRoot.querySelector('button').click();
      },
      lang,
      code,
    );

    // The C++ toolchain is large; its first load can take a while.
    const summary = await page.waitForFunction(
      () => {
        const el = document
          .getElementById('localleet-panel-host')
          ?.shadowRoot?.querySelector('.summary, .error-box');
        return el && !/Running/.test(el.textContent) && el.textContent;
      },
      { timeout: 180000, polling: 500 },
    );
    const text = await summary.jsonValue();
    console.log(`${lang}: ${text}`);
    if (!text.startsWith('Accepted')) throw new Error(`${lang}: expected "Accepted", got: ${text}`);
  }
  const docked = await page.evaluate(
    () =>
      document.getElementById('localleet-tab-button')?.classList.contains('flexlayout__tab_button--selected') &&
      !!document.querySelector('#localleet-tab-content #localleet-panel-host'),
  );
  if (!docked) throw new Error('Results were not shown in the LocalLeet tab');
  console.log('Firefox e2e: OK');
} catch (err) {
  console.error('Firefox e2e: FAILED -', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
