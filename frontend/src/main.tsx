import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import { start } from './api'

start()
createRoot(document.getElementById('root')!).render(<App />)
