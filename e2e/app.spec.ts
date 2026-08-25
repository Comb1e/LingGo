import {expect, test} from '@playwright/test'

test('creates a default 19x19 human game and plays a move', async ({
  page,
}, testInfo) => {
  await page.goto('/new')
  await expect(page.getByRole('radio', {name: '19×19'})).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.getByRole('button', {name: /Human/}).nth(1).click()
  await page.getByRole('button', {name: 'Create game'}).click()
  await expect(page).toHaveURL(/\/games\//)
  const board = page.getByLabel('19 by 19 Go board')
  await expect(board).toBeVisible()
  await expect(board.locator('.shudan-vertex')).toHaveCount(361)
  await board.locator('.shudan-vertex').nth(180).click()
  await expect(page.getByText('1', {exact: true}).first()).toBeVisible()
  await page.screenshot({path: testInfo.outputPath('game.png'), fullPage: true})
})

test('switches the interface to Simplified Chinese', async ({page}) => {
  await page.goto('/games')
  await page.getByTitle('Language').click()
  await expect(page.getByRole('heading', {name: '最近对局'})).toBeVisible()
  await expect(
    page.getByLabel('Primary').getByRole('link', {name: '新对局'}),
  ).toBeVisible()
})

test('chooses directly from multiple saved LLM players', async ({
  page,
  request,
}, testInfo) => {
  const modelId = `${testInfo.project.name}-go-model-large`
  const profileName = `${testInfo.project.name} territory specialist`
  const connection = await request.post('/api/connections', {
    data: {
      name: 'Team API',
      kind: 'openai',
      baseUrl: 'https://models.example.test/v1',
      supportsStructuredOutput: true,
    },
  })
  expect(connection.ok()).toBeTruthy()
  const {id: connectionId} = await connection.json()
  const profile = await request.post('/api/profiles', {
    data: {
      name: profileName,
      connectionId,
      modelId,
      temperature: 0.3,
    },
  })
  expect(profile.ok()).toBeTruthy()

  await page.goto('/new')
  const whiteSeat = page.locator('.seat-editor.white')
  const savedPlayer = whiteSeat.getByRole('radio', {
    name: new RegExp(modelId),
  })
  await expect(savedPlayer).toContainText(`${profileName} · Team API`)
  await savedPlayer.click()
  await expect(savedPlayer).toHaveAttribute('aria-checked', 'true')
})
