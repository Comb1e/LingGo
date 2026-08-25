import {
  Gamepad2,
  Gauge,
  Languages,
  List,
  Plus,
  Settings as SettingsIcon,
} from 'lucide-react'
import {NavLink, Navigate, Route, Routes} from 'react-router-dom'
import {useEffect} from 'react'
import {useTranslation} from 'react-i18next'
import {api} from './api'
import {GamesPage} from './pages/GamesPage'
import {NewGamePage} from './pages/NewGamePage'
import {GamePage} from './pages/GamePage'
import {SettingsPage} from './pages/SettingsPage'
import {BenchmarksPage} from './pages/BenchmarksPage'
import {BenchmarkPage} from './pages/BenchmarkPage'

export function App() {
  const {t, i18n} = useTranslation()
  useEffect(() => {
    void api.restoreSessionKeys()
  }, [])
  const changeLanguage = () => {
    const next = i18n.language.startsWith('zh') ? 'en' : 'zh'
    void i18n.changeLanguage(next)
    localStorage.setItem('linggo-language', next)
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Gamepad2 aria-hidden="true" />
          <span>LingGo</span>
        </div>
        <nav aria-label="Primary">
          <NavItem to="/new" icon={<Plus />} label={t('newGame')} />
          <NavItem to="/games" icon={<List />} label={t('games')} />
          <NavItem to="/benchmarks" icon={<Gauge />} label={t('benchmarks')} />
          <NavItem
            to="/settings"
            icon={<SettingsIcon />}
            label={t('settings')}
          />
        </nav>
        <button
          className="language-button"
          onClick={changeLanguage}
          title={t('language')}
        >
          <Languages />
          <span>{i18n.language.startsWith('zh') ? 'English' : '简体中文'}</span>
        </button>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Navigate to="/games" replace />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/games/:id" element={<GamePage />} />
          <Route path="/new" element={<NewGamePage />} />
          <Route path="/benchmarks" element={<BenchmarksPage />} />
          <Route path="/benchmarks/:id" element={<BenchmarkPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  )
}

function NavItem({
  to,
  icon,
  label,
}: {
  to: string
  icon: React.ReactNode
  label: string
}) {
  return (
    <NavLink to={to} className={({isActive}) => (isActive ? 'active' : '')}>
      {icon}
      <span>{label}</span>
    </NavLink>
  )
}
