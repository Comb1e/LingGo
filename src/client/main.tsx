import React from 'react'
import ReactDOM from 'react-dom/client'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {BrowserRouter} from 'react-router-dom'
import './i18n'
import '@sabaki/shudan/css/goban.css'
import './styles.css'
import {App} from './App'

const queryClient = new QueryClient({
  defaultOptions: {queries: {staleTime: 2_000, refetchOnWindowFocus: true}},
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
