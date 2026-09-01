import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {
  Download,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Trash2,
  XCircle,
} from 'lucide-react'
import {useEffect} from 'react'
import {useTranslation} from 'react-i18next'
import {Link, useNavigate, useParams} from 'react-router-dom'
import type {
  BenchmarkNotebookRole,
  BenchmarkSession,
  BenchmarkSessionStage,
} from '../../shared/types'
import {api} from '../api'
import {BenchmarkLlmMessageInspector} from '../BenchmarkLlmMessageInspector'
import {
  Button,
  ErrorBanner,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components'
import {Markdown} from '../Markdown'
import {NotebookChanges} from '../NotebookChanges'

export function BenchmarkSessionPage() {
  const {id = ''} = useParams()
  const {t} = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const sessionQuery = useQuery({
    queryKey: ['benchmark-session', id],
    queryFn: () => api.benchmarkSession(id),
    enabled: Boolean(id),
  })
  const session = sessionQuery.data
  const currentStage = session?.stages.find(
    ({stageKey}) => stageKey === session.currentStage,
  )
  const runQuery = useQuery({
    queryKey: ['benchmark', currentStage?.runId],
    queryFn: () => api.benchmark(currentStage!.runId!),
    enabled: Boolean(currentStage?.runId),
  })
  const llmMessages = useQuery({
    queryKey: ['benchmark-llm-messages', currentStage?.runId],
    queryFn: () => api.benchmarkLlmMessages(currentStage!.runId!),
    enabled: Boolean(currentStage?.runId),
  })
  const showNotebookChanges = Boolean(
    currentStage?.runId &&
    ['easy', 'medium', 'hard'].includes(currentStage.stageKey),
  )
  const notebookSeed = useQuery({
    queryKey: ['benchmark-notebook-seed', currentStage?.runId],
    queryFn: () => api.benchmarkNotebookSeed(currentStage!.runId!),
    enabled: showNotebookChanges,
  })
  const notebookVersions = useQuery({
    queryKey: ['benchmark-notebook-versions', currentStage?.runId],
    queryFn: () => api.benchmarkNotebookVersions(currentStage!.runId!),
    enabled: showNotebookChanges,
  })
  const lifeNotebook = useQuery({
    queryKey: ['benchmark-session-notebook', id, 'life_death'],
    queryFn: () => api.benchmarkSessionNotebook(id, 'life_death'),
    enabled: Boolean(id && session?.notebooks.life_death),
  })
  const ordinaryNotebook = useQuery({
    queryKey: ['benchmark-session-notebook', id, 'ordinary'],
    queryFn: () => api.benchmarkSessionNotebook(id, 'ordinary'),
    enabled: Boolean(id && session?.notebooks.ordinary),
  })
  const action = useMutation({
    mutationFn: (
      kind: 'continue' | 'restart' | 'pause' | 'resume' | 'next' | 'cancel',
    ) => {
      if (kind === 'continue') return api.continueBenchmarkSession(id)
      if (kind === 'restart') return api.restartBenchmarkSessionStage(id)
      return api.benchmarkSessionCommand(id, {
        type: kind === 'next' ? 'nextMoveAndPause' : kind,
      })
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['benchmark-session', id], updated)
      void queryClient.invalidateQueries({queryKey: ['benchmark-sessions']})
      void queryClient.invalidateQueries({queryKey: ['benchmarks']})
    },
  })
  const publish = useMutation({
    mutationFn: ({role, name}: {role: BenchmarkNotebookRole; name: string}) =>
      api.publishBenchmarkSessionNotebook(id, role, {mode: 'save_new', name}),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['notebooks', session?.profileId],
      }),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteBenchmarkSession(id),
    onSuccess: () => {
      queryClient.removeQueries({queryKey: ['benchmark-session', id]})
      void queryClient.invalidateQueries({queryKey: ['benchmark-sessions']})
      void queryClient.invalidateQueries({queryKey: ['benchmarks']})
      navigate('/benchmarks')
    },
  })

  useEffect(() => {
    if (!id) return
    const events = new EventSource(`/api/benchmark-sessions/${id}/events`)
    events.onmessage = (event) => {
      const next = JSON.parse(event.data) as BenchmarkSession | null
      if (!next) return
      queryClient.setQueryData(['benchmark-session', id], next)
      void queryClient.invalidateQueries({queryKey: ['benchmark-sessions']})
      void queryClient.invalidateQueries({
        queryKey: ['benchmark-session-notebook', id],
      })
      const stage = next.stages.find(
        ({stageKey}) => stageKey === next.currentStage,
      )
      if (stage?.runId) {
        void queryClient.invalidateQueries({
          queryKey: ['benchmark', stage.runId],
        })
        void queryClient.invalidateQueries({
          queryKey: ['benchmark-llm-messages', stage.runId],
        })
        void queryClient.invalidateQueries({
          queryKey: ['benchmark-notebook-versions', stage.runId],
        })
      }
    }
    return () => events.close()
  }, [id, queryClient])

  if (sessionQuery.isLoading || !session)
    return (
      <div className="page">
        <Loading />
        <ErrorBanner error={sessionQuery.error} />
      </div>
    )
  const run = runQuery.data
  const hasLifeNotebook = Boolean(session.notebooks.life_death)
  const hasOrdinaryNotebook = Boolean(session.notebooks.ordinary)
  const showOrdinary =
    hasOrdinaryNotebook &&
    (session.config.process === 'ordinary' ||
      session.currentStage === 'ordinary_notebook' ||
      session.currentStage === 'ordinary')
  return (
    <div className="page benchmark-session-detail">
      <PageHeader
        title={
          session.config.process
            ? t(`benchmarkProcess_${session.config.process}`)
            : t('benchmarkSession')
        }
        actions={
          <>
            <StatusBadge status={session.status} label={t(session.status)} />
            {run?.status === 'running' && (
              <Button onClick={() => action.mutate('pause')}>
                <Pause />
                {t('pause')}
              </Button>
            )}
            {run?.status === 'paused' && (
              <Button
                className="primary"
                onClick={() => action.mutate('resume')}
              >
                <Play />
                {t('resume')}
              </Button>
            )}
            {run && ['running', 'paused'].includes(run.status) && (
              <Button onClick={() => action.mutate('next')}>
                <SkipForward />
                {t('nextMoveAndPause')}
              </Button>
            )}
            {!['completed', 'cancelled'].includes(session.status) && (
              <Button
                className="danger-quiet"
                onClick={() => action.mutate('cancel')}
              >
                <XCircle />
                {t('cancel')}
              </Button>
            )}
            <Button
              className="icon-button danger-quiet"
              title={t('delete')}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t('deleteBenchmarkSessionConfirm')))
                  remove.mutate()
              }}
            >
              <Trash2 />
            </Button>
          </>
        }
      />
      <ErrorBanner
        error={
          action.error ??
          publish.error ??
          remove.error ??
          runQuery.error ??
          llmMessages.error ??
          notebookSeed.error ??
          notebookVersions.error
        }
      />

      <section
        className={`session-stage-band stage-count-${session.stages.length}`}
      >
        {session.stages.map((stage, index) => (
          <StageCard
            key={stage.id}
            stage={stage}
            index={index}
            current={stage.stageKey === session.currentStage}
          />
        ))}
      </section>

      {session.status === 'awaiting_continue' && (
        <section className="continue-gate">
          <div>
            <strong>{t('stageComplete')}</strong>
            <span>{t('manualContinueRequired')}</span>
          </div>
          <Button className="primary" onClick={() => action.mutate('continue')}>
            <Play />
            {t('continueToNextStage')}
          </Button>
        </section>
      )}
      {currentStage &&
        ['completed', 'failed'].includes(currentStage.status) && (
          <div className="session-restart-action">
            <Button
              disabled={action.isPending}
              onClick={() => action.mutate('restart')}
            >
              <RotateCcw />
              {t('restartCurrentStage')}
            </Button>
          </div>
        )}

      {run && (
        <>
          <section className="current-stage-summary">
            <div>
              <span>{t('currentStage')}</span>
              <strong>{t(`stage_${session.currentStage}`)}</strong>
            </div>
            <div>
              <span>{t('phase')}</span>
              <strong>{t(run.phase)}</strong>
            </div>
            <div>
              <span>{t('notebookVersion')}</span>
              <strong>v{run.notebookVersion}</strong>
            </div>
            <Link className="button" to={`/benchmarks/${run.id}`}>
              {t('openChildRun')}
            </Link>
          </section>
          <BenchmarkLlmMessageInspector
            sets={llmMessages.data ?? []}
            loading={llmMessages.isLoading}
            label={t(`stage_${session.currentStage}`)}
          />
        </>
      )}

      {showNotebookChanges && (
        <NotebookChanges
          seed={notebookSeed.data ?? ''}
          versions={notebookVersions.data ?? []}
          loading={notebookSeed.isLoading || notebookVersions.isLoading}
        />
      )}

      <div
        className={`session-notebooks${showOrdinary && hasLifeNotebook ? ' two-role' : ''}`}
      >
        {hasLifeNotebook && (
          <NotebookPanel
            role="life_death"
            content={lifeNotebook.data ?? ''}
            readOnly={showOrdinary}
            session={session}
            onPublish={(role) =>
              publishNotebook(role, t('publishedNotebookName'), publish.mutate)
            }
          />
        )}
        {showOrdinary && (
          <NotebookPanel
            role="ordinary"
            content={ordinaryNotebook.data ?? ''}
            readOnly={false}
            session={session}
            onPublish={(role) =>
              publishNotebook(role, t('publishedNotebookName'), publish.mutate)
            }
          />
        )}
      </div>
    </div>
  )
}

function StageCard({
  stage,
  index,
  current,
}: {
  stage: BenchmarkSessionStage
  index: number
  current: boolean
}) {
  const {t} = useTranslation()
  return (
    <article className={`session-stage-card${current ? ' current' : ''}`}>
      <span className="stage-number">{index + 1}</span>
      <div>
        <strong>{t(`stage_${stage.stageKey}`)}</strong>
        <small>{t('attemptNumber', {attempt: stage.attempt || 1})}</small>
      </div>
      <StatusBadge status={stage.status} label={t(stage.status)} />
      {stage.runId && (
        <Link to={`/benchmarks/${stage.runId}`}>{t('childRun')}</Link>
      )}
      {stage.metrics && (
        <small className="stage-metric">
          {stage.stageKey === 'ordinary'
            ? `${t('lingGoScore')}: ${stage.metrics.score.toFixed(1)}`
            : `${t('firstResponseSuccessRate')}: ${((stage.metrics.firstResponseSuccessRate ?? 0) * 100).toFixed(1)}%`}
        </small>
      )}
    </article>
  )
}

function NotebookPanel({
  role,
  content,
  readOnly,
  session,
  onPublish,
}: {
  role: BenchmarkNotebookRole
  content: string
  readOnly: boolean
  session: BenchmarkSession
  onPublish: (role: BenchmarkNotebookRole) => void
}) {
  const {t} = useTranslation()
  const rolePath = role === 'life_death' ? 'life-death' : role
  const publishReady = session.stages.some(
    (stage) =>
      stage.stageKey === (role === 'life_death' ? 'hard' : 'ordinary') &&
      stage.status === 'completed',
  )
  return (
    <section className="notebook-panel session-notebook-panel">
      <header>
        <div>
          <h2>
            {t(
              role === 'life_death'
                ? 'lifeDeathNotebook'
                : 'ordinaryGameNotebook',
            )}
          </h2>
          <span
            className={`notebook-role-state ${readOnly ? 'readonly' : 'writable'}`}
          >
            {t(readOnly ? 'readOnlyReference' : 'activeWritableNotebook')}
          </span>
        </div>
        <div className="notebook-actions">
          {publishReady && (
            <Button onClick={() => onPublish(role)}>{t('saveAsNew')}</Button>
          )}
          <a
            className="button icon-button"
            href={`/api/benchmark-sessions/${session.id}/notebooks/${rolePath}.md`}
            download
            title={t('downloadNotebook')}
          >
            <Download />
          </a>
        </div>
      </header>
      <Markdown source={content} />
    </section>
  )
}

function publishNotebook(
  role: BenchmarkNotebookRole,
  prompt: string,
  publish: (input: {role: BenchmarkNotebookRole; name: string}) => void,
) {
  const name = window.prompt(prompt)
  if (name?.trim()) publish({role, name: name.trim()})
}
