import '../src/lib/app.css'
import App from './App.svelte'
import { mount } from 'svelte'

// Mount the app
const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
