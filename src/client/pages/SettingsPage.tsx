import {useQuery, useQueryClient} from '@tanstack/react-query'
import {
  Activity,
  BookOpen,
  FlaskConical,
  KeyRound,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import {useState, type FormEvent} from 'react'
import {useTranslation} from 'react-i18next'
import {DEFAULT_KATAGO_VISITS} from '../../shared/constants'
import {supportsDeepSeekReasoningControl} from '../../shared/reasoning'
import type {RequestOption} from '../../shared/types'
import {api} from '../api'
import {Button, ErrorBanner, Loading, PageHeader} from '../components'
import {NotebookManager} from '../NotebookManager'

export function SettingsPage() {
  const {t} = useTranslation()
  const queryClient = useQueryClient()
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: api.connections,
  })
  const profiles = useQuery({queryKey: ['profiles'], queryFn: api.profiles})
  const kataGo = useQuery({
    queryKey: ['katago-settings'],
    queryFn: api.kataGoSettings,
  })
  const [error, setError] = useState<unknown>()
  const [saved, setSaved] = useState('')
  const [provider, setProvider] = useState('openai')
  const [connectionName, setConnectionName] = useState('OpenAI')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [editingConnectionId, setEditingConnectionId] = useState('')
  const [profileName, setProfileName] = useState('')
  const [connectionId, setConnectionId] = useState('builtin-fake')
  const [modelId, setModelId] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [reasoningEnabled, setReasoningEnabled] = useState(true)
  const [requestOptions, setRequestOptions] = useState<RequestOption[]>([])
  const [stylePrompt, setStylePrompt] = useState('')
  const [editingProfileId, setEditingProfileId] = useState('')
  const [profileTestBusy, setProfileTestBusy] = useState(false)
  const [profileTestResult, setProfileTestResult] = useState('')
  const [kataDraft, setKataDraft] = useState({
    executablePath: '',
    modelPath: '',
    configPath: '',
    analysisVisits: DEFAULT_KATAGO_VISITS,
  })
  const [kataEdited, setKataEdited] = useState(false)
  const [kataResult, setKataResult] = useState('')
  const [kataBusy, setKataBusy] = useState(false)
  const [notebookProfileId, setNotebookProfileId] = useState('')
  const [notebookId, setNotebookId] = useState('')
  const selectedConnection = connections.data?.find(
    (connection) => connection.id === connectionId,
  )

  const kataValues =
    kataEdited || !kataGo.data
      ? kataDraft
      : {
          executablePath: kataGo.data.executablePath,
          modelPath: kataGo.data.modelPath,
          configPath: kataGo.data.configPath,
          analysisVisits: kataGo.data.analysisVisits,
        }

  const resetConnectionForm = () => {
    setEditingConnectionId('')
    setProvider('openai')
    setConnectionName('OpenAI')
    setBaseUrl('')
    setApiKey('')
  }
  const resetProfileForm = () => {
    setEditingProfileId('')
    setProfileName('')
    setModelId('')
    setTemperature(0.7)
    setReasoningEnabled(true)
    setRequestOptions([])
    setStylePrompt('')
    setProfileTestResult('')
  }

  const saveConnection = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const input = {
        name: connectionName,
        kind: provider,
        baseUrl: baseUrl || undefined,
        supportsStructuredOutput: false,
        apiKey: apiKey || undefined,
      }
      const result = editingConnectionId
        ? await api.updateConnection(editingConnectionId, input)
        : await api.saveConnection(input)
      await queryClient.invalidateQueries({queryKey: ['connections']})
      setConnectionId(result.id)
      setSaved(t(editingConnectionId ? 'updated' : 'saved'))
      resetConnectionForm()
    } catch (caught) {
      setError(caught)
    }
  }
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const input = {
        name: profileName,
        connectionId,
        modelId,
        temperature,
        reasoningEnabled,
        requestOptions: requestOptions.length ? requestOptions : undefined,
        stylePrompt: stylePrompt || undefined,
      }
      if (editingProfileId) await api.updateProfile(editingProfileId, input)
      else await api.saveProfile(input)
      await queryClient.invalidateQueries({queryKey: ['profiles']})
      setSaved(t(editingProfileId ? 'updated' : 'saved'))
      resetProfileForm()
    } catch (caught) {
      setError(caught)
    }
  }
  const editConnection = (id: string) => {
    const item = connections.data?.find((connection) => connection.id === id)
    if (!item) return
    setEditingConnectionId(item.id)
    setProvider(item.kind)
    setConnectionName(item.name)
    setBaseUrl(item.baseUrl ?? '')
    setApiKey('')
    setError(undefined)
    setSaved('')
  }
  const editProfile = (id: string) => {
    const item = profiles.data?.find((profile) => profile.id === id)
    if (!item) return
    setEditingProfileId(item.id)
    setProfileName(item.name)
    setConnectionId(item.connectionId)
    setModelId(item.modelId)
    setTemperature(item.temperature)
    setReasoningEnabled(item.reasoningEnabled !== false)
    setRequestOptions(item.requestOptions?.map((option) => ({...option})) ?? [])
    setStylePrompt(item.stylePrompt ?? '')
    setError(undefined)
    setSaved('')
  }
  const updateRequestOption = (
    index: number,
    field: keyof RequestOption,
    value: string,
  ) => {
    setRequestOptions((current) =>
      current.map((option, optionIndex) =>
        optionIndex === index ? {...option, [field]: value} : option,
      ),
    )
    setProfileTestResult('')
  }
  const testProfile = async () => {
    setError(undefined)
    setSaved('')
    setProfileTestResult('')
    setProfileTestBusy(true)
    try {
      const result = await api.testProfile({
        name: profileName.trim() || 'Profile test',
        connectionId,
        modelId,
        temperature,
        reasoningEnabled,
        requestOptions: requestOptions.length ? requestOptions : undefined,
        stylePrompt: stylePrompt || undefined,
      })
      setProfileTestResult(
        t('profileTestSucceeded', {
          model: result.model,
          latency: result.latencyMs,
          text: result.text.trim().slice(0, 160),
        }),
      )
    } catch (caught) {
      setError(caught)
    } finally {
      setProfileTestBusy(false)
    }
  }
  const deleteConnection = async (id: string) => {
    if (!window.confirm(t('deleteConnectionConfirm'))) return
    setError(undefined)
    setSaved('')
    try {
      await api.deleteConnection(id)
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['connections']}),
        queryClient.invalidateQueries({queryKey: ['profiles']}),
      ])
      if (connectionId === id) setConnectionId('builtin-fake')
      if (editingConnectionId === id) resetConnectionForm()
      const deletedProfileIds =
        profiles.data
          ?.filter((profile) => profile.connectionId === id)
          .map((profile) => profile.id) ?? []
      if (deletedProfileIds.includes(editingProfileId)) resetProfileForm()
      setSaved(t('deleted'))
    } catch (caught) {
      setError(caught)
    }
  }
  const deleteProfile = async (id: string) => {
    if (!window.confirm(t('deleteProfileConfirm'))) return
    setError(undefined)
    setSaved('')
    try {
      await api.deleteProfile(id)
      await queryClient.invalidateQueries({queryKey: ['profiles']})
      if (editingProfileId === id) resetProfileForm()
      setSaved(t('deleted'))
    } catch (caught) {
      setError(caught)
    }
  }
  const saveKataGo = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setKataBusy(true)
    try {
      const result = await api.saveKataGoSettings(kataValues)
      setKataDraft({
        executablePath: result.executablePath,
        modelPath: result.modelPath,
        configPath: result.configPath,
        analysisVisits: result.analysisVisits,
      })
      setKataEdited(false)
      await queryClient.invalidateQueries({queryKey: ['katago-settings']})
      setSaved(t('saved'))
    } catch (caught) {
      setError(caught)
    } finally {
      setKataBusy(false)
    }
  }
  const testKataGo = async () => {
    setError(undefined)
    setKataResult('')
    setKataBusy(true)
    try {
      const result = await api.testKataGo()
      setKataResult(result.message)
      if (!result.ok) setError(new Error(result.message))
    } catch (caught) {
      setError(caught)
    } finally {
      setKataBusy(false)
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader title={t('settings')} />
      <ErrorBanner
        error={error ?? connections.error ?? profiles.error ?? kataGo.error}
      />
      {saved && <div className="banner success-banner">{saved}</div>}
      {connections.isLoading ? (
        <Loading />
      ) : (
        <div className="settings-grid">
          <section className="settings-section">
            <h2>{t('connections')}</h2>
            <div className="existing-list">
              {connections.data?.map((item) => (
                <div className="existing-row" key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.kind}
                      {item.baseUrl ? ` · ${item.baseUrl}` : ''}
                    </small>
                  </span>
                  <div className="existing-actions">
                    <span
                      className={
                        item.hasSessionKey || item.kind === 'fake'
                          ? 'key-ready'
                          : 'key-missing'
                      }
                    >
                      <KeyRound />
                      {item.hasSessionKey || item.kind === 'fake'
                        ? 'Ready'
                        : 'No key'}
                    </span>
                    {item.id !== 'builtin-fake' && (
                      <>
                        <Button
                          type="button"
                          className="icon-button compact-icon"
                          title={`${t('edit')} ${item.name}`}
                          aria-label={`${t('edit')} ${item.name}`}
                          onClick={() => editConnection(item.id)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          className="icon-button danger-quiet compact-icon"
                          title={`${t('delete')} ${item.name}`}
                          aria-label={`${t('delete')} ${item.name}`}
                          onClick={() => void deleteConnection(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <form onSubmit={(event) => void saveConnection(event)}>
              <label className="field">
                <span>{t('providerName')}</span>
                <input
                  required
                  value={connectionName}
                  onChange={(event) => setConnectionName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('provider')}</span>
                <select
                  value={provider}
                  onChange={(event) => {
                    setProvider(event.target.value)
                    setConnectionName(
                      event.target.value === 'google'
                        ? 'Google Gemini'
                        : event.target.value === 'deepseek'
                          ? 'DeepSeek'
                          : event.target.value[0].toUpperCase() +
                            event.target.value.slice(1),
                    )
                  }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="compatible">OpenAI-compatible</option>
                </select>
              </label>
              <label className="field">
                <span>{t('endpoint')}</span>
                <input
                  type="url"
                  required={provider === 'compatible'}
                  placeholder={endpointPlaceholder(provider)}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <small className="field-note">{t('endpointNotice')}</small>
              </label>
              <label className="field">
                <span>{t('apiKey')}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <p className="field-note">{t('keyNotice')}</p>
              <div className="form-actions">
                <Button className="primary">
                  <Save />
                  {t(
                    editingConnectionId ? 'updateConnection' : 'saveConnection',
                  )}
                </Button>
                {editingConnectionId && (
                  <Button type="button" onClick={resetConnectionForm}>
                    <X />
                    {t('cancel')}
                  </Button>
                )}
              </div>
            </form>
          </section>
          <section className="settings-section">
            <h2>{t('profiles')}</h2>
            <div className="existing-list">
              {profiles.data?.map((item) => (
                <div className="existing-row" key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.modelId}</small>
                  </span>
                  <div className="existing-actions">
                    <span>{item.temperature}</span>
                    <Button
                      type="button"
                      className="icon-button compact-icon"
                      title={`${t('techniqueNotebook')} ${item.name}`}
                      aria-label={`${t('techniqueNotebook')} ${item.name}`}
                      onClick={() => {
                        setNotebookProfileId(item.id)
                        setNotebookId('')
                      }}
                    >
                      <BookOpen />
                    </Button>
                    {item.id !== 'builtin-fake-profile' && (
                      <>
                        <Button
                          type="button"
                          className="icon-button compact-icon"
                          title={`${t('edit')} ${item.name}`}
                          aria-label={`${t('edit')} ${item.name}`}
                          onClick={() => editProfile(item.id)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          type="button"
                          className="icon-button danger-quiet compact-icon"
                          title={`${t('delete')} ${item.name}`}
                          aria-label={`${t('delete')} ${item.name}`}
                          onClick={() => void deleteProfile(item.id)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <form onSubmit={(event) => void saveProfile(event)}>
              <label className="field">
                <span>{t('profileName')}</span>
                <input
                  required
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('provider')}</span>
                <select
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                >
                  {connections.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('modelId')}</span>
                <input
                  required
                  placeholder="gpt-5-mini"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                />
              </label>
              {selectedConnection?.kind === 'deepseek' &&
                supportsDeepSeekReasoningControl(modelId) && (
                  <label className="switch-field">
                    <input
                      type="checkbox"
                      checked={reasoningEnabled}
                      onChange={(event) => {
                        setReasoningEnabled(event.target.checked)
                        setProfileTestResult('')
                      }}
                    />
                    <span className="switch" />
                    <span>{t('deepSeekReasoning')}</span>
                  </label>
                )}
              <div className="field request-options-field">
                <span>{t('requestOptions')}</span>
                <small className="field-note">
                  {t('requestOptionsNotice')}
                </small>
                <div className="request-option-list">
                  {requestOptions.map((option, index) => (
                    <div className="request-option-row" key={index}>
                      <label>
                        <span>{t('requestOptionName')}</span>
                        <input
                          required
                          placeholder="reasoning"
                          value={option.name}
                          onChange={(event) =>
                            updateRequestOption(
                              index,
                              'name',
                              event.target.value,
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>{t('requestOptionContent')}</span>
                        <input
                          required
                          placeholder={'{"effort":"high"}'}
                          value={option.content}
                          onChange={(event) =>
                            updateRequestOption(
                              index,
                              'content',
                              event.target.value,
                            )
                          }
                        />
                      </label>
                      <Button
                        type="button"
                        className="icon-button danger-quiet compact-icon"
                        title={t('removeRequestOption')}
                        aria-label={`${t('removeRequestOption')} ${index + 1}`}
                        onClick={() => {
                          setRequestOptions((current) =>
                            current.filter(
                              (_option, optionIndex) => optionIndex !== index,
                            ),
                          )
                          setProfileTestResult('')
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  onClick={() =>
                    setRequestOptions((current) => [
                      ...current,
                      {name: '', content: ''},
                    ])
                  }
                >
                  <Plus />
                  {t('addRequestOption')}
                </Button>
              </div>
              <label className="field">
                <span>
                  {t('temperature')} · {temperature.toFixed(1)}
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(event) =>
                    setTemperature(Number(event.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>{t('stylePrompt')}</span>
                <textarea
                  rows={4}
                  value={stylePrompt}
                  onChange={(event) => setStylePrompt(event.target.value)}
                />
              </label>
              <div className="form-actions">
                <Button className="primary">
                  <Save />
                  {t(editingProfileId ? 'updateProfile' : 'saveProfile')}
                </Button>
                <Button
                  type="button"
                  disabled={profileTestBusy || !modelId.trim()}
                  onClick={() => void testProfile()}
                >
                  <FlaskConical />
                  {t('testProfile')}
                </Button>
                {editingProfileId && (
                  <Button type="button" onClick={resetProfileForm}>
                    <X />
                    {t('cancel')}
                  </Button>
                )}
                {profileTestResult && (
                  <span className="test-result">{profileTestResult}</span>
                )}
              </div>
            </form>
          </section>
          <section className="settings-section katago-settings">
            <h2>KataGo</h2>
            <form onSubmit={(event) => void saveKataGo(event)}>
              <label className="field">
                <span>{t('executablePath')}</span>
                <input
                  required
                  value={kataValues.executablePath}
                  onChange={(event) => {
                    setKataEdited(true)
                    setKataDraft({
                      ...kataValues,
                      executablePath: event.target.value,
                    })
                  }}
                />
              </label>
              <label className="field">
                <span>{t('modelPath')}</span>
                <input
                  required
                  value={kataValues.modelPath}
                  onChange={(event) => {
                    setKataEdited(true)
                    setKataDraft({...kataValues, modelPath: event.target.value})
                  }}
                />
              </label>
              <label className="field">
                <span>{t('configPath')}</span>
                <input
                  required
                  value={kataValues.configPath}
                  onChange={(event) => {
                    setKataEdited(true)
                    setKataDraft({
                      ...kataValues,
                      configPath: event.target.value,
                    })
                  }}
                />
              </label>
              <label className="field">
                <span>{t('ordinaryVisits')}</span>
                <input
                  type="number"
                  min="25"
                  max="100000"
                  required
                  value={kataValues.analysisVisits}
                  onChange={(event) => {
                    setKataEdited(true)
                    setKataDraft({
                      ...kataValues,
                      analysisVisits: Number(event.target.value),
                    })
                  }}
                />
              </label>
              <div className="form-actions">
                <Button className="primary" disabled={kataBusy}>
                  <Save />
                  {t('saveChanges')}
                </Button>
                <Button
                  type="button"
                  disabled={kataBusy}
                  onClick={() => void testKataGo()}
                >
                  <Activity />
                  {t('testKataGo')}
                </Button>
                {kataResult && (
                  <span className="test-result">{kataResult}</span>
                )}
              </div>
            </form>
          </section>
        </div>
      )}
      {notebookProfileId && (
        <section className="profile-notebook-panel">
          <header>
            <h2>{t('techniqueNotebook')}</h2>
            <div>
              <Button
                className="icon-button"
                title={t('cancel')}
                onClick={() => setNotebookProfileId('')}
              >
                <X />
              </Button>
            </div>
          </header>
          <NotebookManager
            profileId={notebookProfileId}
            selectedId={notebookId}
            onSelect={setNotebookId}
          />
        </section>
      )}
    </div>
  )
}

function endpointPlaceholder(provider: string) {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1'
  if (provider === 'google')
    return 'https://generativelanguage.googleapis.com/v1beta'
  if (provider === 'deepseek') return 'https://api.deepseek.com'
  if (provider === 'compatible') return 'https://example.com/v1'
  return 'https://api.openai.com/v1'
}
