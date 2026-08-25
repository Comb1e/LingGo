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

test('restores a session API key after server memory is cleared', async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const connectionName = `Restart-safe API ${suffix}`
  await page.goto('/settings')
  await page.getByLabel('Connection name').fill(connectionName)
  await page.getByLabel('Session API key').fill(`sk-session-${suffix}`)
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/connections') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', {name: 'Save connection'}).click()
  const {id} = await (await createdResponse).json()
  const connectionRow = page
    .locator('.existing-row')
    .filter({hasText: connectionName})

  await expect(connectionRow).toContainText('Ready')
  await request.put(`/api/connections/${id}/key`, {data: {apiKey: ''}})
  await expect
    .poll(async () => {
      const response = await request.get('/api/connections')
      const connections = await response.json()
      return connections.find(
        (connection: {id: string}) => connection.id === id,
      )?.hasSessionKey
    })
    .toBe(false)

  await page.reload()
  await expect(connectionRow).toContainText('Ready')
  await expect
    .poll(async () => {
      const response = await request.get('/api/connections')
      const connections = await response.json()
      return connections.find(
        (connection: {id: string}) => connection.id === id,
      )?.hasSessionKey
    })
    .toBe(true)

  page.once('dialog', (dialog) => dialog.accept())
  await connectionRow
    .getByRole('button', {name: `Delete ${connectionName}`})
    .click()
  await expect(connectionRow).toHaveCount(0)
})

test('expands saved model reasoning under LLM commentary', async ({
  page,
  request,
}, testInfo) => {
  const response = await request.post('/api/games', {
    data: {
      size: 9,
      komi: 7.5,
      black: {
        type: 'llm',
        name: 'Local learner',
        profileId: 'builtin-fake-profile',
      },
      white: {type: 'human', name: 'Human'},
      commentsVisible: true,
    },
  })
  const {id} = await response.json()
  await page.goto(`/games/${id}`)

  const toggle = page.getByRole('button', {name: 'Model reasoning'})
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(
    page.getByText(/select the first legal intersection/),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('model-reasoning.png'),
    fullPage: true,
  })
})

test('chooses directly from multiple saved LLM players', async ({
  page,
  request,
}, testInfo) => {
  const runId = `${testInfo.project.name}-${Date.now()}`
  const modelId = `${runId}-go-model-large`
  const profileName = `${runId} territory specialist`
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
  const {id: profileId} = await profile.json()

  await page.goto('/new')
  const whiteSeat = page.locator('.seat-editor.white')
  const savedPlayer = whiteSeat.getByRole('radio', {
    name: new RegExp(modelId),
  })
  await expect(savedPlayer).toContainText(`${profileName} · Team API`)
  await savedPlayer.click()
  await expect(savedPlayer).toHaveAttribute('aria-checked', 'true')

  await request.delete(`/api/profiles/${profileId}`)
  await request.delete(`/api/connections/${connectionId}`)
})

test('edits and deletes a game, player profile, and provider connection', async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const connectionName = `Disposable API ${suffix}`
  const profileName = `Disposable player ${suffix}`
  const blackName = `Disposable Black ${suffix}`
  const editedConnectionName = `Edited API ${suffix}`
  const editedProfileName = `Edited player ${suffix}`
  const editedBlackName = `Edited Black ${suffix}`
  const connection = await request.post('/api/connections', {
    data: {
      name: connectionName,
      kind: 'openai',
      supportsStructuredOutput: true,
    },
  })
  const {id: connectionId} = await connection.json()
  await request.post('/api/profiles', {
    data: {
      name: profileName,
      connectionId,
      modelId: `disposable-model-${suffix}`,
      temperature: 0,
    },
  })

  await page.goto('/settings')
  const connectionRow = page
    .locator('.existing-row')
    .filter({hasText: connectionName})
  await connectionRow
    .getByRole('button', {name: `Edit ${connectionName}`})
    .click()
  await page.getByLabel('Connection name').fill(editedConnectionName)
  await page.getByLabel(/Base URL/).fill('https://edited.example.test/v1')
  await page.getByRole('button', {name: 'Update connection'}).click()
  const editedConnectionRow = page
    .locator('.existing-row')
    .filter({hasText: editedConnectionName})
  await expect(editedConnectionRow).toContainText(
    'https://edited.example.test/v1',
  )

  const profileRow = page
    .locator('.existing-row')
    .filter({hasText: profileName})
  await profileRow.getByRole('button', {name: `Edit ${profileName}`}).click()
  await page.getByLabel('Profile name').fill(editedProfileName)
  await page.getByLabel('Model ID').fill(`gpt-5.6-sol-${suffix}`)
  await page.getByRole('button', {name: 'Update profile'}).click()
  const editedProfileRow = page
    .locator('.existing-row')
    .filter({hasText: editedProfileName})
  await expect(editedProfileRow).toContainText(`gpt-5.6-sol-${suffix}`)

  page.once('dialog', (dialog) => dialog.accept())
  await editedProfileRow
    .getByRole('button', {name: `Delete ${editedProfileName}`})
    .click()
  await expect(editedProfileRow).toHaveCount(0)

  page.once('dialog', (dialog) => dialog.accept())
  await editedConnectionRow
    .getByRole('button', {name: `Delete ${editedConnectionName}`})
    .click()
  await expect(editedConnectionRow).toHaveCount(0)

  const gameResponse = await request.post('/api/games', {
    data: {
      black: {type: 'human', name: blackName},
      white: {type: 'human', name: 'Disposable White'},
    },
  })
  const {id: gameId} = await gameResponse.json()
  await page.goto(`/games/${gameId}`)
  await page.getByRole('button', {name: 'Edit game'}).click()
  await page.getByLabel('Black').fill(editedBlackName)
  await page.getByLabel('White').fill('Edited White')
  await page.getByLabel('Move cap').fill('500')
  await page.getByRole('button', {name: 'Save changes'}).click()
  await expect(
    page.getByRole('heading', {
      name: `${editedBlackName} · Edited White`,
    }),
  ).toBeVisible()

  await page.goto('/games')
  const gameRow = page.locator('.game-row').filter({hasText: editedBlackName})
  page.once('dialog', (dialog) => dialog.accept())
  await gameRow
    .getByRole('button', {name: `Delete ${editedBlackName} vs Edited White`})
    .click()
  await expect(gameRow).toHaveCount(0)
})
