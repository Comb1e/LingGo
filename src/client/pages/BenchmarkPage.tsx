import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {
  CopyPlus,
  Download,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Trash2,
  XCircle,
} from 'lucide-react'
import {useEffect} from 'react'
import {useTranslation} from 'react-i18next'
import {Link, useNavigate, useParams} from 'react-router-dom'
import type {BenchmarkProblemView, BenchmarkRun, Game} from '../../shared/types'
import {api} from '../api'
import {Board} from '../Board'
import {
  Button,
  ErrorBanner,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components'
import {Markdown} from '../Markdown'

export function BenchmarkPage() {
  const {id = ''} = useParams()
  const {t} = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['benchmark', id],
    queryFn: () => api.benchmark(id),
    enabled: Boolean(id),
  })
  const notebook = useQuery({
    queryKey: ['benchmark-notebook', id],
    queryFn: () => api.benchmarkNotebook(id),
    enabled: Boolean(id),
  })
  const lifeNotebook = useQuery({
    queryKey: [
      'benchmark-session-notebook',
      query.data?.sessionId,
      'life_death',
    ],
    queryFn: () =>
      api.benchmarkSessionNotebook(query.data!.sessionId!, 'life_death'),
    enabled: Boolean(
      query.data?.sessionId && query.data?.stageKey === 'ordinary',
    ),
  })
  const problemAttempts = useQuery({
    queryKey: ['benchmark-problem-attempts', id],
    queryFn: () => api.benchmarkProblemAttempts(id),
    enabled: Boolean(id && query.data?.config.problemSetId),
  })
  const currentProblem = useQuery({
    queryKey: ['benchmark-current-problem', id],
    queryFn: () => api.benchmarkCurrentProblem(id),
    enabled: Boolean(id && query.data?.config.problemSetId),
  })
  const command = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      api.benchmarkCommand(id, input),
    onSuccess: (run) => queryClient.setQueryData(['benchmark', id], run),
  })
  const publish = useMutation({
    mutationFn: (
      input: {mode: 'replace_source'} | {mode: 'save_new'; name: string},
    ) => api.publishBenchmarkNotebook(id, input),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['notebooks', query.data?.config.profileId],
      }),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteBenchmark(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({queryKey: ['benchmarks']})
      navigate('/benchmarks')
    },
  })

  useEffect(() => {
    if (!id) return
    const events = new EventSource(`/api/benchmarks/${id}/events`)
    events.onmessage = (event) => {
      const run = JSON.parse(event.data) as BenchmarkRun | null
      if (!run) return navigate('/benchmarks')
      queryClient.setQueryData(['benchmark', id], run)
      void queryClient.invalidateQueries({queryKey: ['benchmarks']})
      if (run.notebook.updatedAt)
        void queryClient.invalidateQueries({
          queryKey: ['benchmark-notebook', id],
        })
      if (run.config.problemSetId)
        void queryClient.invalidateQueries({
          queryKey: ['benchmark-current-problem', id],
        })
    }
    return () => events.close()
  }, [id, navigate, queryClient])

  if (query.isLoading || !query.data)
    return (
      <div className="page">
        <Loading />
        <ErrorBanner error={query.error} />
      </div>
    )
  const run = query.data
  const trainingGameCount = benchmarkTrainingGameCount(run.config)
  const trainingProgress = Math.min(run.currentGame, trainingGameCount)
  return (
    <div className="page benchmark-detail">
      <PageHeader
        title={run.profileSnapshot.name}
        actions={
          <>
            <StatusBadge status={run.status} label={t(run.status)} />
            {run.sessionId && (
              <Link
                className="button"
                to={`/benchmark-sessions/${run.sessionId}`}
              >
                {t('benchmarkSession')}
              </Link>
            )}
            {run.status === 'running' && (
              <Button onClick={() => command.mutate({type: 'pause'})}>
                <Pause />
                {t('pause')}
              </Button>
            )}
            {run.status === 'paused' && (
              <Button
                className="primary"
                onClick={() => command.mutate({type: 'resume'})}
              >
                <Play />
                {t('resume')}
              </Button>
            )}
            {['running', 'paused'].includes(run.status) && (
              <Button
                onClick={() => command.mutate({type: 'nextMoveAndPause'})}
                disabled={command.isPending || run.pauseAfterLlmMove}
              >
                <SkipForward />
                {t('nextMoveAndPause')}
              </Button>
            )}
            {['queued', 'running', 'paused'].includes(run.status) && (
              <Button
                className="danger-quiet"
                onClick={() => command.mutate({type: 'cancel'})}
              >
                <XCircle />
                {t('cancel')}
              </Button>
            )}
            {!run.sessionId && (
              <Button
                className="icon-button danger-quiet"
                title={t('delete')}
                onClick={() => {
                  if (window.confirm(t('deleteBenchmarkConfirm')))
                    remove.mutate()
                }}
              >
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <ErrorBanner
        error={command.error ?? publish.error ?? remove.error ?? query.error}
      />
      {run.error && <div className="banner warning-banner">{run.error}</div>}
      <section className="benchmark-progress">
        {run.config.problemSetId && (
          <div className="benchmark-gate">
            <span>{t('lifeDeathProblemSet')}</span>
            <small>{run.currentProblemId ?? ''}</small>
            <strong>
              {run.problemSuccessStreak ?? 0} /{' '}
              {run.metrics?.problemCount ?? '?'}
            </strong>
            <small>
              {run.metrics?.kataGoGateReached
                ? t('gateComplete')
                : t('gameLockedUntilGate')}
            </small>
          </div>
        )}
        <div>
          <span>{t('trainingGames')}</span>
          <strong>
            {trainingProgress} / {trainingGameCount}
          </strong>
        </div>
        {run.config.trainingGamesWithWinRates !== undefined &&
          run.config.trainingGamesWithoutWinRates !== undefined && (
            <>
              <div>
                <span>{t('trainingGamesWithWinRates')}</span>
                <strong>{run.config.trainingGamesWithWinRates}</strong>
              </div>
              <div>
                <span>{t('trainingGamesWithoutWinRates')}</span>
                <strong>{run.config.trainingGamesWithoutWinRates}</strong>
              </div>
            </>
          )}
        {run.config.trainingGamesWithWinRates === undefined &&
          run.config.trainingGamesWithoutWinRates === undefined && (
            <div>
              <span>{t('trainingFeedbackMode')}</span>
              <strong>
                {t(
                  run.config.trainingFeedback ??
                    ((
                      run.config as unknown as {
                        includeTrainingWinRates?: boolean
                      }
                    ).includeTrainingWinRates
                      ? 'structured'
                      : 'none'),
                )}
              </strong>
            </div>
          )}
        <progress max={trainingGameCount} value={trainingProgress} />
        <div>
          <span>{t('phase')}</span>
          <strong>{t(run.phase)}</strong>
          <small>{t(run.substate?.kind ?? 'ready')}</small>
        </div>
        <div>
          <span>{t('currentTurn')}</span>
          <strong>{run.currentTurn}</strong>
        </div>
        <div>
          <span>{t('usage')}</span>
          <strong>
            {run.usage.calls} {t('calls')} ·{' '}
            {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()}{' '}
            {t('tokens')} ·{' '}
            {(run.usage.cachedInputTokens ?? 0).toLocaleString()} {t('cached')}
          </strong>
        </div>
        <div>
          <span>{t('notebookVersion')}</span>
          <strong>v{run.notebookVersion ?? 0}</strong>
        </div>
        <div>
          <span>{t('notebookBudgetUsage')}</span>
          <strong>
            {(run.notebookEstimatedTokens ?? 0).toLocaleString()} /{' '}
            {(run.config.notebookTokenBudget ?? 0).toLocaleString()}
          </strong>
        </div>
        {(run.sourceRunId || run.successorRunId) && (
          <div>
            <span>{t('migrationLineage')}</span>
            <strong>
              {run.sourceRunId && (
                <Link to={`/benchmarks/${run.sourceRunId}`}>
                  {t('sourceRun')}
                </Link>
              )}
              {run.successorRunId && (
                <Link to={`/benchmarks/${run.successorRunId}`}>
                  {t('successorRun')}
                </Link>
              )}
            </strong>
          </div>
        )}
      </section>
      {currentProblem.data && (
        <section className="benchmark-problem-view">
          <header>
            <h2>{currentProblem.data.title ?? currentProblem.data.id}</h2>
            <span>
              {currentProblem.data.sideToMove === 'B' ? t('black') : t('white')}{' '}
              {t('toMove')}
            </span>
          </header>
          <Board
            game={problemAsGame(currentProblem.data)}
            onPoint={() => undefined}
            disabled
          />
        </section>
      )}
      {run.config.problemSetId && problemAttempts.data && (
        <section className="benchmark-attempts">
          <h2>{t('problemAttempts')}</h2>
          {problemAttempts.data.map((attempt) => (
            <div key={attempt.sequence}>
              {attempt.sequence}. {attempt.problemId}{' '}
              {attempt.correct
                ? 'correct'
                : `failed${attempt.failureReason ? `: ${attempt.failureReason}` : ''}`}
            </div>
          ))}
        </section>
      )}

      {run.status === 'paused' && run.currentGame < trainingGameCount && (
        <div className="benchmark-force">
          <Button
            onClick={() =>
              command.mutate({
                type: 'force',
                action: {
                  action: 'pass',
                  comment: 'Operator forced training pass.',
                },
              })
            }
          >
            <SkipForward />
            {t('forcePass')}
          </Button>
        </div>
      )}

      {run.metrics && (
        <section className="metrics-band">
          <div className="rating">
            <span>{t('lingGoScore')}</span>
            <strong>{run.metrics.score.toFixed(1)}</strong>
            <small>/ 100</small>
          </div>
          <Metric label={t('result')} value={run.metrics.result} />
          <Metric
            label={t('moveQuality')}
            value={run.metrics.moveQuality.toFixed(1)}
          />
          <Metric
            label={t('averagePointLoss')}
            value={run.metrics.averagePointLoss.toFixed(2)}
          />
          <Metric
            label={t('averageWinRateLoss')}
            value={`${(run.metrics.averageWinRateLoss * 100).toFixed(2)}%`}
          />
          <Metric
            label={t('moveCount')}
            value={String(run.metrics.moveCount)}
          />
          <Metric
            label={t('outputRepairRate')}
            value={`${((run.metrics.outputRepairRate ?? 0) * 100).toFixed(1)}%`}
          />
          <Metric
            label={t('trainingReviewCount')}
            value={String(run.metrics.trainingReviewCount ?? 0)}
          />
          <Metric
            label={t('notebookGrowth')}
            value={String(run.metrics.notebookGrowthCharacters ?? 0)}
          />
        </section>
      )}

      <div className="benchmark-detail-grid">
        <section className="benchmark-games">
          <h2>{t('games')}</h2>
          {run.gameIds.map((gameId, index) => (
            <Link key={gameId} to={`/games/${gameId}`}>
              <span>
                {index < trainingGameCount
                  ? `${t('training')} ${index + 1}`
                  : t('finalGame')}
              </span>
              <small>
                {index < trainingGameCount
                  ? index % 2 === 0
                    ? t('black')
                    : t('white')
                  : run.config.finalColor === 'B'
                    ? t('black')
                    : t('white')}
              </small>
            </Link>
          ))}
        </section>
        <section className="notebook-panel">
          <header>
            <h2>
              {run.writableNotebookRole
                ? t(
                    run.writableNotebookRole === 'life_death'
                      ? 'lifeDeathNotebook'
                      : 'ordinaryGameNotebook',
                  )
                : t('techniqueNotebook')}
            </h2>
            <div className="notebook-actions">
              {!run.sessionId &&
                run.status === 'completed' &&
                run.config.notebookSeed?.mode === 'refine_existing' && (
                  <Button
                    title={t('replaceSourceNotebook')}
                    disabled={publish.isPending}
                    onClick={() => {
                      if (window.confirm(t('replaceSourceNotebookConfirm')))
                        publish.mutate({mode: 'replace_source'})
                    }}
                  >
                    <RefreshCw />
                    {t('replaceSource')}
                  </Button>
                )}
              {!run.sessionId && run.status === 'completed' && (
                <Button
                  title={t('saveNotebookAsNew')}
                  disabled={publish.isPending}
                  onClick={() => {
                    const name = window.prompt(t('publishedNotebookName'))
                    if (name?.trim())
                      publish.mutate({mode: 'save_new', name: name.trim()})
                  }}
                >
                  <CopyPlus />
                  {t('saveAsNew')}
                </Button>
              )}
              <a
                className="button icon-button"
                href={`/api/benchmarks/${run.id}/notebook.md`}
                download
                title={t('downloadNotebook')}
              >
                <Download />
              </a>
            </div>
          </header>
          <Markdown source={notebook.data ?? ''} />
        </section>
        {run.sessionId && run.stageKey === 'ordinary' && (
          <section className="notebook-panel session-child-readonly-notebook">
            <header>
              <div>
                <h2>{t('lifeDeathNotebook')}</h2>
                <span className="notebook-role-state readonly">
                  {t('readOnlyReference')}
                </span>
              </div>
              <a
                className="button icon-button"
                href={`/api/benchmark-sessions/${run.sessionId}/notebooks/life-death.md`}
                download
                title={t('downloadNotebook')}
              >
                <Download />
              </a>
            </header>
            <Markdown source={lifeNotebook.data ?? ''} />
          </section>
        )}
      </div>
    </div>
  )
}

function benchmarkTrainingGameCount(config: BenchmarkRun['config']) {
  if (
    config.trainingGamesWithWinRates !== undefined &&
    config.trainingGamesWithoutWinRates !== undefined
  )
    return (
      config.trainingGamesWithWinRates + config.trainingGamesWithoutWinRates
    )
  return config.trainingGameCount ?? 10
}

function problemAsGame(problem: BenchmarkProblemView): Game {
  const now = new Date(0).toISOString()
  return {
    id: `problem-${problem.id}`,
    version: 0,
    size: problem.size,
    komi: problem.komi,
    board: problem.board,
    toMove: problem.sideToMove,
    status: 'active',
    black: {type: 'human', name: 'Black'},
    white: {type: 'human', name: 'White'},
    moves: problem.moves,
    captures: problem.captures,
    commentsVisible: false,
    autoplay: false,
    moveCap: 722,
    dead: [],
    approvals: [],
    createdAt: now,
    updatedAt: now,
  }
}

function Metric({label, value}: {label: string; value: string}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
