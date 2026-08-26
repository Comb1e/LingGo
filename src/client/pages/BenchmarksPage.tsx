import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {ArrowRight, Gauge, Play, Trash2} from 'lucide-react'
import {useState, type FormEvent} from 'react'
import {useTranslation} from 'react-i18next'
import {Link, useNavigate} from 'react-router-dom'
import {DEFAULT_KATAGO_VISITS} from '../../shared/constants'
import type {Color} from '../../shared/types'
import {api} from '../api'
import {Button, ErrorBanner, Loading, PageHeader, StatusBadge} from '../components'

export function BenchmarksPage() {
  const {t} = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const runs = useQuery({queryKey: ['benchmarks'], queryFn: api.benchmarks})
  const profiles = useQuery({queryKey: ['profiles'], queryFn: api.profiles})
  const [profileId, setProfileId] = useState('builtin-fake-profile')
  const [finalColor, setFinalColor] = useState<Color>('B')
  const [visits, setVisits] = useState(DEFAULT_KATAGO_VISITS)
  const [feedback, setFeedback] = useState(true)
  const [notebookMode, setNotebookMode] = useState<'reset' | 'continue'>('reset')
  const create = useMutation({
    mutationFn: () => api.createBenchmark({profileId, finalColor, visits, includeTrainingWinRates: feedback, notebookMode}),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({queryKey: ['benchmarks']})
      navigate(`/benchmarks/${run.id}`)
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteBenchmark(id),
    onSuccess: () => void queryClient.invalidateQueries({queryKey: ['benchmarks']}),
  })
  const live = runs.data?.some((run) => ['queued', 'running', 'paused'].includes(run.status))

  if (runs.isLoading || profiles.isLoading) return <div className="page"><Loading /></div>
  return (
    <div className="page benchmark-page">
      <PageHeader title={t('benchmarks')} />
      <ErrorBanner error={create.error ?? remove.error ?? runs.error ?? profiles.error} />
      <form className="benchmark-create" onSubmit={(event: FormEvent) => {event.preventDefault(); create.mutate()}}>
        <div className="benchmark-form-grid">
          <label className="field">
            <span>{t('profile')}</span>
            <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              {profiles.data?.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.modelId}</option>)}
            </select>
          </label>
          <div className="field-group">
            <label>{t('finalColor')}</label>
            <div className="segmented">
              {(['B', 'W'] as Color[]).map((color) => (
                <button type="button" className={finalColor === color ? 'selected' : ''} key={color} onClick={() => setFinalColor(color)}>
                  <i className={`stone ${color === 'B' ? 'black-stone' : 'white-stone'}`} />
                  {color === 'B' ? t('black') : t('white')}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{t('kataGoVisits')}</span>
            <input type="number" min="25" max="10000" value={visits} onChange={(event) => setVisits(Number(event.target.value))} />
          </label>
          <div className="field-group">
            <label>{t('notebookStart')}</label>
            <div className="segmented">
              {(['reset', 'continue'] as const).map((mode) => <button type="button" className={notebookMode === mode ? 'selected' : ''} key={mode} onClick={() => setNotebookMode(mode)}>{t(mode)}</button>)}
            </div>
          </div>
          <label className="switch-field">
            <input type="checkbox" checked={feedback} onChange={(event) => setFeedback(event.target.checked)} />
            <span className="switch" />
            <span>{t('trainingFeedback')}</span>
          </label>
          <Button className="primary" disabled={create.isPending || live}>
            <Play />
            {t('startBenchmark')}
          </Button>
        </div>
      </form>

      <section className="benchmark-list">
        <h2>{t('benchmarkRuns')}</h2>
        {runs.data?.length ? runs.data.map((run) => (
          <div className="benchmark-row" key={run.id}>
            <Link to={`/benchmarks/${run.id}`}>
              <Gauge />
              <span><strong>{run.profileSnapshot.name}</strong><small>{run.modelFingerprint.slice(0, 12)} · {run.config.visits} visits</small></span>
              <StatusBadge status={run.status} label={t(run.status)} />
              <b>{run.status === 'completed' ? run.metrics?.score.toFixed(1) : `${Math.min(run.currentGame, 10)}/10`}</b>
              <ArrowRight />
            </Link>
            <Button className="icon-button danger-quiet" title={t('delete')} onClick={() => {if (window.confirm(t('deleteBenchmarkConfirm'))) remove.mutate(run.id)}}><Trash2 /></Button>
          </div>
        )) : <p className="muted">{t('noBenchmarks')}</p>}
      </section>
    </div>
  )
}
