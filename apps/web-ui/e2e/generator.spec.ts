import { test, expect } from '@playwright/test';

test.describe('Agent Harness Generator UI', () => {
  test('loads with no console errors and renders the hero', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Agent Harness/i })).toBeVisible();
    await expect(page.getByText(/Scaffold your own focused AI agent harness/i)).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('full-harness flow: live preview updates and zip downloads', async ({ page }) => {
    await page.goto('/');

    // The default scaffold preview should be present.
    await expect(page.getByText('Generated harness')).toBeVisible();

    // Change the harness name and confirm it propagates into package.json.
    const nameInput = page.getByLabel('Harness name');
    await nameInput.fill('contract-sentinel');
    // Click package.json in the file tree.
    await page.getByRole('button', { name: 'package.json' }).click();
    await expect(page.locator('pre')).toContainText('"name": "contract-sentinel"');

    // Toggle a host on and confirm the codex adapter file appears.
    await page.getByRole('button', { name: /OpenAI Codex/ }).click();
    await expect(page.getByRole('button', { name: 'config.toml' })).toBeVisible();

    // Download the zip.
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-harness').click(),
    ]);
    expect(dl.suggestedFilename()).toBe('contract-sentinel.zip');
  });

  test('quick-start gallery: picking a template updates the description + agents', async ({ page }) => {
    await page.goto('/');
    // Pick the Agentics template from the gallery.
    await page.getByTestId('tpl-vertical:agentics').click();
    await expect(page.getByLabel('Description')).toHaveValue(/swarm/i);
    // Its orchestrator agent file should appear in the tree.
    await expect(page.getByRole('button', { name: 'orchestrator.ts' })).toBeVisible();
  });

  test('invalid name blocks download and shows the reason', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Harness name').fill('Bad--Name');
    await expect(page.getByTestId('download-harness')).toBeDisabled();
    await expect(page.getByText(/kebab-case|consecutive hyphens/i)).toBeVisible();
  });

  test('artifact flow: author a custom skill and download the .md', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Skill / Agent / Command' }).click();

    // Switch to author mode.
    await page.getByRole('button', { name: 'Author', exact: true }).click();
    await page.getByLabel('id').fill('clause-extractor');
    await page.getByLabel('description').fill('Pull obligations from a contract');
    // The rendered SKILL.md content lives in the <pre>; its path is in the header.
    await expect(page.locator('pre')).toContainText('name: clause-extractor');
    await expect(page.locator('pre')).toContainText('Pull obligations from a contract');
    await expect(page.getByText('clause-extractor/SKILL.md').first()).toBeVisible();

    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-md').click(),
    ]);
    expect(dl.suggestedFilename()).toBe('clause-extractor-SKILL.md');
  });

  test('command artifact emits command-only frontmatter', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Skill / Agent / Command' }).click();
    await page.getByRole('button', { name: 'Command', exact: true }).click();
    await expect(page.locator('pre')).toContainText('description:');
  });
});
