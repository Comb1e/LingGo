import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {ArrowRight, Gauge, Pause, Play, Trash2} from 'lucide-react'
import {useEffect, useState, type FormEvent} from 'react'
import {useTranslation} from 'react-i18next'
import {Link, useNavigate} from 'react-router-dom'
import {DEFAULT_KATAGO_VISITS} from '../../shared/constants'
import type {BenchmarkRun, Color} from '../../shared/types'
import {api} from '../api'
import {hasLiveBenchmarkForProfile} from '../benchmarkAvailability'
import {NotebookManager} from '../NotebookManager'
import {
  Button,
  ErrorBanner,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components'

export function BenchmarksPage() {
  const {t} = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const runs = useQuery({queryKey: ['benchmarks'], queryFn: api.benchmarks})
  const profiles = useQuery({queryKey: ['profiles'], queryFn: api.profiles})
  const [profileId, setProfileId] = useState('builtin-fake-profile')
  const [finalColor, setFinalColor] = useState<Color>('B')
  const [trainingVisits, setTrainingVisits] = useState(DEFAULT_KATAGO_VISITS)
  const [evaluationVisits, setEvaluationVisits] = useState(10_000)
  const [notebookTokenBudget, setNotebookTokenBudget] = useState(8000)
  const [feedback, setFeedback] = useState(true)
  const [trainingGameCount, setTrainingGameCount] = useState(10)
  const [notebookId, setNotebookId] = useState('')
  const [seedMode, setSeedMode] = useState<'rules_only' | 'refine_existing'>(
    'rules_only',
  )
  const create = useMutation({
    mutationFn: () =>
      api.createBenchmark({
        profileId,
        finalColor,
        trainingGameCount,
        notebookSeed:
          seedMode === 'rules_only'
            ? {mode: 'rules_only'}
            : {mode: 'refine_existing', notebookId},
        trainingFeedback: feedback ? 'structured' : 'none',
        notebookTokenBudget,
        trainingVisits,
        evaluationVisits,
      }),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({queryKey: ['benchmarks']})
      navigate(`/benchmarks/${run.id}`)
    },
  })
  const [pendingById, setPendingById] = useState<Record<string, string>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, unknown>>({})
  const profileIsLive = hasLiveBenchmarkForProfile(runs.data, profileId)

  useEffect(() => {
    const events = new EventSource('/api/benchmarks/events')
    events.onmessage = (event) => {
      const next = JSON.parse(event.data) as BenchmarkRun[]
      queryClient.setQueryData(['benchmarks'], next)
      for (const run of next)
        queryClient.setQueryData(['benchmark', run.id], run)
    }
    return () => events.close()
  }, [queryClient])

  const command = async (run: BenchmarkRun, type: 'pause' | 'resume') => {
    setPendingById((current) => ({...current, [run.id]: type}))
    setRowErrors((current) => ({...current, [run.id]: undefined}))
    try {
      const updated = await api.benchmarkCommand(run.id, {type})
      queryClient.setQueryData<BenchmarkRun[]>(['benchmarks'], (current) =>
        current?.map((value) => (value.id === updated.id ? updated : value)),
      )
      queryClient.setQueryData(['benchmark', updated.id], updated)
    } catch (error) {
      setRowErrors((current) => ({...current, [run.id]: error}))
    } finally {
      setPendingById((current) => {
        const next = {...current}
        delete next[run.id]
        return next
      })
    }
  }

  const remove = async (run: BenchmarkRun) => {
    if (!window.confirm(t('deleteBenchmarkConfirm'))) return
    setPendingById((current) => ({...current, [run.id]: 'delete'}))
    setRowErrors((current) => ({...current, [run.id]: undefined}))
    try {
      await api.deleteBenchmark(run.id)
      queryClient.removeQueries({queryKey: ['benchmark', run.id]})
      await queryClient.invalidateQueries({queryKey: ['benchmarks']})
    } catch (error) {
      setRowErrors((current) => ({...current, [run.id]: error}))
    } finally {
      setPendingById((current) => {
        const next = {...current}
        delete next[run.id]
        return next
      })
    }
  }

  if (runs.isLoading || profiles.isLoading)
    return (
      <div className="page">
        <Loading />
      </div>
    )
  return (
    <div className="page benchmark-page">
      <PageHeader title={t('benchmarks')} />
      <ErrorBanner error={create.error ?? runs.error ?? profiles.error} />
      <form
        className="benchmark-create"
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <div className="benchmark-form-grid">
          <label className="field">
            <span>{t('profile')}</span>
            <select
              value={profileId}
              onChange={(event) => {
                setProfileId(event.target.value)
                setNotebookId('')
              }}
            >
              {profiles.data?.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.modelId}
                </option>
              ))}
            </select>
          </label>
          <div className="field-group">
            <label>{t('finalColor')}</label>
            <div className="segmented">
              {(['B', 'W'] as Color[]).map((color) => (
                <button
                  type="button"
                  className={finalColor === color ? 'selected' : ''}
                  key={color}
                  onClick={() => setFinalColor(color)}
                >
                  <i
                    className={`stone ${color === 'B' ? 'black-stone' : 'white-stone'}`}
                  />
                  {color === 'B' ? t('black') : t('white')}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{t('trainingVisits')}</span>
            <input
              type="number"
              min="25"
              max="100000"
              value={trainingVisits}
              onChange={(event) =>
                setTrainingVisits(Number(event.target.value))
              }
            />
          </label>
          <label className="field">
            <span>{t('evaluationVisits')}</span>
            <input
              type="number"
              min={trainingVisits}
              max="100000"
              value={evaluationVisits}
              onChange={(event) =>
                setEvaluationVisits(Number(event.target.value))
              }
            />
          </label>
          <label className="field">
            <span>{t('trainingGames')}</span>
            <input
              type="number"
              min="1"
              max="1000"
              required
              value={trainingGameCount}
              onChange={(event) =>
                setTrainingGameCount(Number(event.target.value))
              }
            />
          </label>
          <div className="field-group notebook-seed-field">
            <label>{t('notebookSeed')}</label>
            <div className="segmented">
              <button
                type="button"
                className={seedMode === 'rules_only' ? 'selected' : ''}
                onClick={() => setSeedMode('rules_only')}
              >
                {t('rulesOnly')}
              </button>
              <button
                type="button"
                className={seedMode === 'refine_existing' ? 'selected' : ''}
                onClick={() => setSeedMode('refine_existing')}
              >
                {t('refineExisting')}
              </button>
            </div>
          </div>
          {seedMode === 'refine_existing' && (
            <NotebookManager
              profileId={profileId}
              selectedId={notebookId}
              onSelect={setNotebookId}
            />
          )}
          <label className="field">
            <span>{t('notebookTokenBudget')}</span>
            <input
              type="number"
              min="256"
              max="100000"
              value={notebookTokenBudget}
              onChange={(event) =>
                setNotebookTokenBudget(Number(event.target.value))
              }
            />
          </label>
          <label className="switch-field">
            <input
              type="checkbox"
              checked={feedback}
              onChange={(event) => setFeedback(event.target.checked)}
            />
            <span className="switch" />
            <span>{t('trainingFeedback')}</span>
          </label>
          <Button
            className="primary"
            disabled={
              create.isPending ||
              profileIsLive ||
              evaluationVisits < trainingVisits ||
              (seedMode === 'refine_existing' && !notebookId)
            }
          >
            <Play />
            {t('startBenchmark')}
          </Button>
        </div>
      </form>

      <section className="benchmark-list">
        <h2>{t('benchmarkRuns')}</h2>
        {runs.data?.length ? (
          runs.data.map((run) => (
            <div className="benchmark-row" key={run.id}>
              <Link to={`/benchmarks/${run.id}`}>
                <Gauge />
                <span>
                  <strong>{run.profileSnapshot.name}</strong>
                  <small>
                    v{run.protocolVersion ?? 1} ·{' '}
                    {run.protocolVersion === 2
                      ? `${run.config.trainingVisits}/${run.config.evaluationVisits}`
                      : ((run.config as unknown as {visits?: number}).visits ??
                        'legacy')}{' '}
                    visits
                  </small>
                </span>
                <StatusBadge status={run.status} label={t(run.status)} />
                <b>
                  {run.status === 'completed'
                    ? run.metrics?.score.toFixed(1)
                    : `${Math.min(run.currentGame, run.config.trainingGameCount ?? 10)}/${run.config.trainingGameCount ?? 10}`}
                </b>
                <ArrowRight />
              </Link>
              <div className="benchmark-row-actions">
                {['queued', 'running'].includes(run.status) && (
                  <Button
                    className="icon-button"
                    title={t('pauseBenchmark')}
                    aria-label={t('pauseBenchmark')}
                    disabled={Boolean(pendingById[run.id])}
                    onClick={() => void command(run, 'pause')}
                  >
                    <Pause />
                  </Button>
                )}
                {run.status === 'paused' && (
                  <Button
                    className="icon-button primary"
                    title={t('resumeBenchmark')}
                    aria-label={t('resumeBenchmark')}
                    disabled={Boolean(pendingById[run.id])}
                    onClick={() => void command(run, 'resume')}
                  >
                    <Play />
                  </Button>
                )}
                <Button
                  className="icon-button danger-quiet"
                  title={t('delete')}
                  aria-label={t('delete')}
                  disabled={Boolean(pendingById[run.id])}
                  onClick={() => void remove(run)}
                >
                  <Trash2 />
                </Button>
              </div>
              {Boolean(rowErrors[run.id]) && (
                <div className="benchmark-row-error">
                  <ErrorBanner error={rowErrors[run.id]} />
                </div>
              )}
            </div>
          ))
        ) : (
          <p className="muted">{t('noBenchmarks')}</p>
        )}
      </section>
    </div>
  )
}
