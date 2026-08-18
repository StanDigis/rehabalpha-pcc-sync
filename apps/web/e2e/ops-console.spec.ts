import { expect, test } from '@playwright/test';

test.describe('integration ops console', () => {
  test('shows sync health, dead letters, identity queue, and coverage timeline', async ({
    page,
  }) => {
    await page.goto('/sync-health');
    await expect(page.getByRole('heading', { name: 'Sync health' })).toBeVisible();
    await expect(page.getByText('Ferncrest Skilled Nursing Facility')).toBeVisible();

    await page.getByRole('link', { name: 'Dead letters' }).click();
    await expect(page.getByRole('heading', { name: 'Dead letters' })).toBeVisible();
    await expect(page.getByText('pcc_forbidden')).toBeVisible();

    await page.getByRole('link', { name: 'Identity review' }).click();
    await expect(page.getByRole('heading', { name: 'Identity review' })).toBeVisible();
    await expect(page.getByText('78%')).toBeVisible();

    await page.goto('/patients/demo-betty/coverage');
    await expect(page.getByRole('heading', { name: 'Coverage timeline' })).toBeVisible();
    await expect(page.getByText('MEDICARE')).toBeVisible();
    await expect(page.getByText('MEDICAID')).toBeVisible();
  });
});
