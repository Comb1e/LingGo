import {expect, test} from '@playwright/test'

test('creates a default 19x19 human game and plays a move', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'desktop')
    await page.setViewportSize({width: 1600, height: 1100})
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
  await expect(page.locator('.move-row')).toHaveCount(1)
  await board.locator('.shudan-vertex').nth(181).click()
  await expect(page.locator('.move-row')).toHaveCount(2)
  await expect(page.getByText('Move 2 / 2')).toBeVisible()
  await page.getByRole('button', {name: 'Previous board position'}).click()
  await expect(page.getByText('Move 1 / 2')).toBeVisible()
  await page.route('**/positions/1/katago', async (route) => {
    await route.fulfill({
      json: {
        gameId: 'reviewed-game',
        turn: 1,
        toMove: 'W',
        visits: 5000,
        candidates: [
          {move: 'D4', point: [3, 15], winRate: 0.634, visits: 1500},
          {move: 'Q16', point: [15, 3], winRate: 0.621, visits: 1200},
          {move: 'D16', point: [3, 3], winRate: 0.61, visits: 900},
          {move: 'Q4', point: [15, 15], winRate: 0.598, visits: 700},
          {move: 'K6', point: [9, 13], winRate: 0.587, visits: 500},
        ],
      },
    })
  })
  await page
    .getByRole('button', {name: 'Analyze current position with KataGo'})
    .click()
  const topChoice = board.locator('[data-x="3"][data-y="15"]')
  await expect(topChoice).toHaveClass(/shudan-sign_-1/)
  await expect(topChoice.locator('.shudan-marker')).toHaveText('63%')
  await expect(topChoice).toHaveAttribute('title', /#1 D4: 63\.4% win rate/)
  await expect(board.locator('.shudan-marker_label')).toHaveCount(5)
  await page.screenshot({
    path: testInfo.outputPath('katago-review.png'),
    fullPage: true,
  })
  await board.locator('.shudan-vertex').nth(182).click()
  await expect(page.locator('.move-row')).toHaveCount(2)
  await page.getByRole('button', {name: 'Latest board position'}).click()
  await expect(page.getByText('Move 2 / 2')).toBeVisible()
  await expect(page.locator('.winrate-chart')).toBeVisible()
  await expect
    .poll(() => page.locator('.black-line').getAttribute('d'))
    .toContain(' C ')
  const turnCursor = page.getByRole('slider', {name: 'Selected turn'})
  await expect(turnCursor).toHaveAttribute('aria-valuemin', '1')
  await expect(turnCursor).toHaveAttribute('aria-valuenow', '1')
  await page.getByRole('button', {name: 'Next turn'}).click()
  await expect(turnCursor).toHaveAttribute('aria-valuenow', '2')
  await expect(page.getByText('Black score lead:')).toBeVisible()
  const cursorHandle = page.locator('.chart-cursor-hitbox')
  await cursorHandle.scrollIntoViewIfNeeded()
  const cursorLine = await cursorHandle.boundingBox()
  const firstTurnDot = await page.locator('.black-dot').first().boundingBox()
  if (!cursorLine || !firstTurnDot)
    throw new Error('Chart cursor is not visible')
  await page.mouse.move(
    cursorLine.x + cursorLine.width / 2,
    cursorLine.y + cursorLine.height / 2,
  )
  await page.mouse.down()
  const cursorCenterX = cursorLine.x + cursorLine.width / 2
  const firstTurnCenterX = firstTurnDot.x + firstTurnDot.width / 2
  const dragTargetX = cursorCenterX + (firstTurnCenterX - cursorCenterX) * 0.25
  await page.mouse.move(dragTargetX, cursorLine.y + cursorLine.height / 2, {
    steps: 3,
  })
  await expect
    .poll(async () => {
      const marker = await page.locator('.chart-cursor-line').boundingBox()
      return marker
        ? Math.abs(marker.x + marker.width / 2 - dragTargetX)
        : Infinity
    })
    .toBeLessThan(2)
  await page.mouse.move(
    firstTurnDot.x + firstTurnDot.width / 2,
    firstTurnDot.y + firstTurnDot.height / 2,
  )
  await page.mouse.up()
  await expect(turnCursor).toHaveAttribute('aria-valuenow', '1')
  await page.getByRole('button', {name: 'Next turn'}).click()
  await expect(turnCursor).toHaveAttribute('aria-valuenow', '2')
  await page.getByRole('button', {name: 'Previous turn'}).click()
  await expect(turnCursor).toHaveAttribute('aria-valuenow', '1')
  const shareToggle = page.getByLabel('Share with LLM')
  await expect(shareToggle).toBeVisible()
  const sharingSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/analysis'),
  )
  await shareToggle.click()
  expect((await sharingSaved).ok()).toBe(true)
  await expect(shareToggle).toBeChecked()
  await page.screenshot({path: testInfo.outputPath('game.png'), fullPage: true})
})

test('retains the displayed board while another historical turn loads', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/games', {
    data: {
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'Black'},
      white: {type: 'human', name: 'White'},
      commentsVisible: true,
    },
  })
  let game = await created.json()
  for (const coordinate of ['A9', 'B9', 'C9']) {
    const response = await request.post(`/api/games/${game.id}/commands`, {
      data: {expectedVersion: game.version, type: 'play', coordinate},
    })
    game = await response.json()
  }

  let releasePosition: (() => void) | undefined
  let positionRequestStarted = false
  const positionReleased = new Promise<void>((resolve) => {
    releasePosition = resolve
  })
  await page.route(`**/api/games/${game.id}/positions/1`, async (route) => {
    positionRequestStarted = true
    await positionReleased
    await route.continue()
  })
  await page.goto(`/games/${game.id}`)
  const board = page.getByLabel('9 by 9 Go board')
  const previous = page.getByRole('button', {
    name: 'Previous board position',
  })

  await previous.click()
  await expect(page.getByText('Move 2 / 3')).toBeVisible()
  await expect(board.locator('.shudan-vertex').nth(0)).toHaveClass(
    /shudan-sign_1/,
  )
  await expect(board.locator('.shudan-vertex').nth(1)).toHaveClass(
    /shudan-sign_-1/,
  )
  await expect(board.locator('.shudan-vertex').nth(2)).toHaveClass(
    /shudan-sign_0/,
  )

  await previous.click()
  await expect.poll(() => positionRequestStarted).toBe(true)
  await expect(previous).toBeDisabled()
  await expect(page.getByText('Move 2 / 3')).toBeVisible()
  await expect(board.locator('.shudan-vertex').nth(0)).toHaveClass(
    /shudan-sign_1/,
  )
  await expect(board.locator('.shudan-vertex').nth(1)).toHaveClass(
    /shudan-sign_-1/,
  )
  await expect(board.locator('.shudan-vertex').nth(2)).toHaveClass(
    /shudan-sign_0/,
  )

  releasePosition?.()
  await expect(page.getByText('Move 1 / 3')).toBeVisible()
  await expect(board.locator('.shudan-vertex').nth(0)).toHaveClass(
    /shudan-sign_1/,
  )
  await expect(board.locator('.shudan-vertex').nth(1)).toHaveClass(
    /shudan-sign_0/,
  )
  await request.delete(`/api/games/${game.id}`)
})

test('tests KataGo settings and completes a benchmark with a notebook', async ({
  page,
}, testInfo) => {
  await page.goto('/settings')
  await expect(page.getByLabel('Ordinary-game visits')).toHaveValue('5000')
  await page.getByRole('button', {name: 'Test KataGo'}).click()
  await expect(page.getByText('Deterministic KataGo is ready.')).toBeVisible()

  await page.goto('/benchmarks')
  await expect(
    page.getByRole('heading', {name: 'Benchmark', exact: true}),
  ).toBeVisible()
  await expect(page.getByLabel('KataGo visits')).toHaveValue('5000')
  page.once('dialog', (dialog) => dialog.accept('E2E notebook'))
  await page.getByRole('button', {name: 'Create notebook'}).click()
  await expect(page.getByLabel('Technique notebook')).toHaveValue(/.+/)
  page.once('dialog', (dialog) => dialog.accept('E2E renamed'))
  await page.getByRole('button', {name: 'Rename notebook'}).click()
  await expect(page.getByLabel('Technique notebook')).toContainText(
    'E2E renamed',
  )
  await page.getByLabel('Training games').fill('1')
  await page.getByRole('button', {name: 'Start benchmark'}).click()
  await expect(page).toHaveURL(/\/benchmarks\//)
  const benchmarkUrl = page.url()
  await expect(page.getByText('Completed')).toBeVisible()
  await expect(page.getByText('LingGo score')).toBeVisible()
  await expect(page.locator('.benchmark-games a')).toHaveCount(2)
  await expect(
    page.getByText('Check liberties before every move.'),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('benchmark-complete.png'),
    fullPage: true,
  })

  await page.locator('.benchmark-games a').first().click()
  await expect(page.locator('.in-game-reflections-panel')).toHaveCount(0)
  await expect(page.locator('.move-reflections')).toHaveCount(0)
  await page.getByRole('button', {name: 'Previous board position'}).click()
  await expect(page.getByText(/Move \d+ \/ \d+/)).toBeVisible()
  await page.getByRole('button', {name: 'Latest board position'}).click()
  await page.screenshot({
    path: testInfo.outputPath('benchmark-game.png'),
    fullPage: true,
  })
  await page.goBack()
  await expect(page.getByText('Completed')).toBeVisible()

  await page.goto('/settings')
  await page
    .getByRole('button', {name: 'Technique notebook Local learner'})
    .click()
  const notebookManager = page.locator(
    '.profile-notebook-panel .notebook-manager',
  )
  const notebookSelect = notebookManager.getByRole('combobox')
  await notebookSelect.selectOption({label: 'E2E renamed'})
  await notebookManager.getByRole('button', {name: 'Preview notebook'}).click()
  await expect(
    page.getByText('Check liberties before every move.'),
  ).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await notebookManager.getByRole('button', {name: 'Delete notebook'}).click()
  await expect(notebookSelect).not.toContainText('E2E renamed')

  await page.goto(benchmarkUrl)
  await expect(
    page.getByText('Check liberties before every move.'),
  ).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByTitle('Delete').click()
  await expect(page).toHaveURL(/\/benchmarks$/)
})

test('switches the interface to Simplified Chinese', async ({page}) => {
  await page.goto('/games')
  await page.getByTitle('Language').click()
  await expect(page.getByRole('heading', {name: '最近对局'})).toBeVisible()
  await expect(
    page.getByLabel('Primary').getByRole('link', {name: '新对局'}),
  ).toBeVisible()
})

test('restores a browser API key after server memory and session storage are cleared', async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const connectionName = `Restart-safe API ${suffix}`
  await page.goto('/settings')
  await page.getByLabel('Provider').first().selectOption('deepseek')
  await expect(page.getByLabel('Base URL (optional)')).toHaveAttribute(
    'placeholder',
    'https://api.deepseek.com',
  )
  await page.getByLabel('Provider').first().selectOption('openai')
  await page.getByLabel('Connection name').fill(connectionName)
  await page.getByLabel('Browser API key').fill(`sk-session-${suffix}`)
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

  await page.evaluate(() => sessionStorage.clear())
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

test('adds, tests, and saves custom profile request options', async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const profileName = `Request options ${suffix}`
  await page.goto('/settings')
  await page.getByLabel('Profile name').fill(profileName)
  await page.getByLabel('Model ID').fill('deterministic-v1')
  await page.getByRole('button', {name: 'Add request option'}).click()
  await page.getByLabel('Field name').fill('reasoning')
  await page.getByLabel('Content').fill('{"effort":"high"}')

  await page.getByRole('button', {name: 'Test profile'}).click()
  await expect(
    page.getByText(/deterministic-v1 replied in \d+ ms/),
  ).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('request-options.png'),
    fullPage: true,
  })

  await page.getByRole('button', {name: 'Save profile'}).click()
  const profileRow = page
    .locator('.existing-row')
    .filter({hasText: profileName})
  await expect(profileRow).toBeVisible()

  await profileRow.getByRole('button', {name: `Edit ${profileName}`}).click()
  await expect(page.getByLabel('Field name')).toHaveValue('reasoning')
  await expect(page.getByLabel('Content')).toHaveValue('{"effort":"high"}')

  page.once('dialog', (dialog) => dialog.accept())
  await profileRow.getByRole('button', {name: `Delete ${profileName}`}).click()
  await expect(profileRow).toHaveCount(0)
})

test('saves disabled reasoning for a DeepSeek profile', async ({
  page,
  request,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`
  const connectionName = `DeepSeek reasoning ${suffix}`
  const profileName = `Direct DeepSeek ${suffix}`
  const connectionResponse = await request.post('/api/connections', {
    data: {
      name: connectionName,
      kind: 'deepseek',
      supportsStructuredOutput: false,
    },
  })
  const connection = await connectionResponse.json()

  await page.goto('/settings')
  await page.getByLabel('Profile name').fill(profileName)
  await page
    .getByRole('combobox', {name: 'Provider'})
    .nth(1)
    .selectOption(connection.id)
  await page.getByLabel('Model ID').fill('deepseek-chat')
  await expect(
    page.getByRole('checkbox', {name: 'DeepSeek reasoning', exact: true}),
  ).toHaveCount(0)
  await page.getByLabel('Model ID').fill('deepseek-v4-pro')
  const reasoning = page.getByRole('checkbox', {
    name: 'DeepSeek reasoning',
    exact: true,
  })
  await expect(reasoning).toBeChecked()
  await reasoning.uncheck()
  await page.screenshot({
    path: testInfo.outputPath('deepseek-reasoning-disabled.png'),
    fullPage: true,
  })
  await page.getByRole('button', {name: 'Save profile'}).click()

  const profileRow = page
    .locator('.existing-row')
    .filter({hasText: profileName})
  await profileRow.getByRole('button', {name: `Edit ${profileName}`}).click()
  await expect(reasoning).not.toBeChecked()

  page.once('dialog', (dialog) => dialog.accept())
  await profileRow.getByRole('button', {name: `Delete ${profileName}`}).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page
    .locator('.existing-row')
    .filter({hasText: connectionName})
    .getByRole('button', {name: `Delete ${connectionName}`})
    .click()
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

test('keeps DeepSeek reasoning together under its move-history control', async ({
  page,
  request,
}, testInfo) => {
  const response = await request.post('/api/games', {
    data: {
      size: 9,
      komi: 7.5,
      black: {type: 'human', name: 'Black'},
      white: {type: 'human', name: 'White'},
      commentsVisible: true,
    },
  })
  const game = await response.json()
  game.status = 'paused'
  game.board[3][3] = 1
  game.toMove = 'W'
  game.moves = [
    {
      number: 1,
      color: 'B',
      action: 'play',
      point: [3, 3],
      coordinate: 'D6',
      comment: 'Take the open corner.',
      reasoning: 'Compare both sides. Keep sente.',
      captured: 0,
      model: 'deepseek-v4-pro',
      providerKind: 'deepseek',
    },
  ]
  await page.route(`/api/games/${game.id}`, (route) =>
    route.fulfill({json: game}),
  )
  await page.route(`/api/games/${game.id}/events`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(game)}\n\n`,
    }),
  )

  await page.goto(`/games/${game.id}`)
  await expect(
    page.locator('.move-row').getByText('Take the open corner.'),
  ).toBeVisible()
  const toggle = page.getByRole('button', {name: 'Model reasoning'})
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(page.locator('.reasoning-text')).toHaveText(
    'Compare both sides. Keep sente.',
  )
  await page.screenshot({
    path: testInfo.outputPath('deepseek-reasoning.png'),
    fullPage: true,
  })

  await request.delete(`/api/games/${game.id}`)
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
