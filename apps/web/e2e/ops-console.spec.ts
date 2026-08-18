import { expect, test } from '@playwright/test';

test.describe('integration ops console', () => {
  test('shows overview, sync health, dead letters, identity queue, and coverage timeline', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sync overview' })).toBeVisible();
    await expect(page.getByText('Healthy cursors')).toBeVisible();

    await page.locator('a[href="/sync-health"]').first().click();
    await expect(page.getByRole('heading', { name: 'Sync health', exact: true })).toBeVisible();
    await expect(page.getByText('Ferncrest Skilled Nursing Facility')).toBeVisible();

    await page.locator('a[href="/dead-letters"]').first().click();
    await expect(page.getByRole('heading', { name: 'Dead letters', exact: true })).toBeVisible();
    await expect(page.getByText('pcc_forbidden')).toBeVisible();

    await page.locator('a[href="/identity-review"]').first().click();
    await expect(page.getByRole('heading', { name: 'Identity review', exact: true })).toBeVisible();
    await expect(page.getByText('78%')).toBeVisible();

    await page.goto('/patients/demo-betty/coverage');
    await expect(
      page.getByRole('heading', { name: 'Coverage timeline', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: 'MEDICARE' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'MEDICAID' })).toBeVisible();
  });
});
