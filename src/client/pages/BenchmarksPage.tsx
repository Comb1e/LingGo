import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {ArrowRight, Gauge} from 'lucide-react'
import {useEffect, useState, type FormEvent} from 'react'
import {useTranslation} from 'react-i18next'
import {Link, useNavigate} from 'react-router-dom'
import {DEFAULT_BENCHMARK_TRAINING_VISITS} from '../../shared/constants'
import type {BenchmarkSession, Color} from '../../shared/types'
import {api} from '../api'
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
  const sessions = useQuery({
    queryKey: ['benchmark-sessions'],
    queryFn: api.benchmarkSessions,
  })
  const legacyRuns = useQuery({
    queryKey: ['benchmarks'],
    queryFn: api.benchmarks,
  })
  const profiles = useQuery({queryKey: ['profiles'], queryFn: api.profiles})
  const [profileId, setProfileId] = useState('builtin-fake-profile')
  const [lifeNotebookId, setLifeNotebookId] = useState('')
  const [ordinaryNotebookId, setOrdinaryNotebookId] = useState('')
  const [finalColor, setFinalColor] = useState<Color>('B')
  const [trainingVisits, setTrainingVisits] = useState(
    DEFAULT_BENCHMARK_TRAINING_VISITS,
  )
  const [evaluationVisits, setEvaluationVisits] = useState(10_000)
  const [notebookTokenBudget, setNotebookTokenBudget] = useState(10_000)
  const [withWinRates, setWithWinRates] = useState(5)
  const [withoutWinRates, setWithoutWinRates] = useState(5)
  const profileNotebooks = useQuery({
    queryKey: ['notebooks', profileId],
    queryFn: () => api.notebooks(profileId),
    enabled: Boolean(profileId),
  })
  const notebookIds = profileNotebooks.data?.map(({id}) => id) ?? []
  const selectedLifeNotebookId = notebookIds.includes(lifeNotebookId)
    ? lifeNotebookId
    : (notebookIds[0] ?? '')
  const selectedOrdinaryNotebookId =
    notebookIds.includes(ordinaryNotebookId) &&
    ordinaryNotebookId !== selectedLifeNotebookId
      ? ordinaryNotebookId
      : (notebookIds.find((id) => id !== selectedLifeNotebookId) ?? '')
  const trainingGameCount = withWinRates + withoutWinRates
  const profileIsLive =
    sessions.data?.some(
      (session) =>
        session.profileId === profileId &&
        !['completed', 'cancelled'].includes(session.status),
    ) ||
    legacyRuns.data?.some(
      (run) =>
        run.config.profileId === profileId &&
        ['queued', 'running', 'paused'].includes(run.status),
    )
  const create = useMutation({
    mutationFn: () =>
      api.createBenchmarkSession({
        profileId,
        lifeDeathNotebookId: selectedLifeNotebookId,
        ordinaryNotebookId: selectedOrdinaryNotebookId,
        finalColor,
        trainingGameCount,
        trainingGamesWithWinRates: withWinRates,
        trainingGamesWithoutWinRates: withoutWinRates,
        trainingFeedback: 'structured',
        notebookTokenBudget,
        trainingVisits,
        evaluationVisits,
      }),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({queryKey: ['benchmark-sessions']})
      void queryClient.invalidateQueries({queryKey: ['benchmarks']})
      navigate(`/benchmark-sessions/${session.id}`)
    },
  })

  useEffect(() => {
    const events = new EventSource('/api/benchmark-sessions/events')
    events.onmessage = (event) => {
      const next = JSON.parse(event.data) as BenchmarkSession[]
      queryClient.setQueryData(['benchmark-sessions'], next)
      for (const session of next)
        queryClient.setQueryData(['benchmark-session', session.id], session)
    }
    return () => events.close()
  }, [queryClient])

  if (sessions.isLoading || profiles.isLoading || legacyRuns.isLoading)
    return (
      <div className="page">
        <Loading />
      </div>
    )

  return (
    <div className="page benchmark-page">
      <PageHeader title={t('benchmarks')} />
      <ErrorBanner
        error={
          create.error ?? sessions.error ?? profiles.error ?? legacyRuns.error
        }
      />
      <form
        className="benchmark-create"
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <div className="benchmark-form-grid session-form-grid">
          <label className="field">
            <span>{t('profile')}</span>
            <select
              value={profileId}
              onChange={(event) => {
                setProfileId(event.target.value)
                setLifeNotebookId('')
                setOrdinaryNotebookId('')
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
          <NotebookManager
            profileId={profileId}
            selectedId={selectedLifeNotebookId}
            onSelect={setLifeNotebookId}
            label={t('lifeDeathNotebook')}
            disabledIds={
              selectedOrdinaryNotebookId ? [selectedOrdinaryNotebookId] : []
            }
            autoSelect={false}
          />
          <NotebookManager
            profileId={profileId}
            selectedId={selectedOrdinaryNotebookId}
            onSelect={setOrdinaryNotebookId}
            label={t('ordinaryGameNotebook')}
            disabledIds={selectedLifeNotebookId ? [selectedLifeNotebookId] : []}
            autoSelect={false}
          />
          <NumberField
            label={t('trainingGamesWithWinRates')}
            value={withWinRates}
            min={0}
            onChange={setWithWinRates}
          />
          <NumberField
            label={t('trainingGamesWithoutWinRates')}
            value={withoutWinRates}
            min={0}
            onChange={setWithoutWinRates}
          />
          <NumberField
            label={t('trainingVisits')}
            value={trainingVisits}
            min={25}
            onChange={(value) => {
              setTrainingVisits(value)
              if (evaluationVisits < value) setEvaluationVisits(value)
            }}
          />
          <NumberField
            label={t('evaluationVisits')}
            value={evaluationVisits}
            min={trainingVisits}
            onChange={setEvaluationVisits}
          />
          <NumberField
            label={t('notebookTokenBudget')}
            value={notebookTokenBudget}
            min={256}
            onChange={setNotebookTokenBudget}
          />
          <Button
            className="primary"
            disabled={
              create.isPending ||
              profileIsLive ||
              !selectedLifeNotebookId ||
              !selectedOrdinaryNotebookId ||
              selectedLifeNotebookId === selectedOrdinaryNotebookId ||
              trainingGameCount < 1
            }
          >
            <Gauge />
            {profileIsLive
              ? t('benchmarkAlreadyRunning')
              : t('startBenchmarkSession')}
          </Button>
        </div>
      </form>

      <section className="benchmark-list">
        <h2>{t('benchmarkSessions')}</h2>
        {!sessions.data?.length && <p className="muted">{t('noBenchmarks')}</p>}
        {sessions.data?.map((session) => (
          <div className="benchmark-row" key={session.id}>
            <Link to={`/benchmark-sessions/${session.id}`}>
              <span>
                <b>{t(`stage_${session.currentStage}`)}</b>
                <small>
                  {new Date(session.createdAt).toLocaleString()} ·{' '}
                  {
                    session.stages.filter(({status}) => status === 'completed')
                      .length
                  }
                  /4
                </small>
              </span>
              <StatusBadge status={session.status} label={t(session.status)} />
              <ArrowRight />
            </Link>
          </div>
        ))}
      </section>

      {!!legacyRuns.data?.filter((run) => !run.sessionId).length && (
        <section className="benchmark-list legacy-benchmark-list">
          <h2>{t('legacyBenchmarkRuns')}</h2>
          {legacyRuns.data
            ?.filter((run) => !run.sessionId)
            .map((run) => (
              <div className="benchmark-row" key={run.id}>
                <Link to={`/benchmarks/${run.id}`}>
                  <span>
                    <b>{run.profileSnapshot.name}</b>
                    <small>{new Date(run.createdAt).toLocaleString()}</small>
                  </span>
                  <StatusBadge status={run.status} label={t(run.status)} />
                  <ArrowRight />
                </Link>
              </div>
            ))}
        </section>
      )}
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string
  value: number
  min: number
  onChange: (value: number) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max="100000"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}
