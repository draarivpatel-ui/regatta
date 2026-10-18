import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/theme.css'
import { App } from './App'
import { AnywherePill } from './anywhere/AnywherePill'

// The same page also draws the small Dictate anywhere pill window (?view=anywhere).
const view = new URLSearchParams(location.search).get('view')
createRoot(document.getElementById('root')!).render(view === 'anywhere' ? <AnywherePill /> : <App />)
