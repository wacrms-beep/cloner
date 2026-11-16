/**
 * Bootstrap de l'interface Renderer (src/renderer/app.js)
 * Initialise les icônes de la barre latérale, l'effet ripple sur les boutons,
 * vérifie l'acceptation légale, synchronise le thème et l'indicateur d'état du moteur Python.
 */
import { Api } from './core/Api.js';
import { store } from './core/Store.js';
import { Router } from './core/Router.js';
import { icon } from './core/Icons.js';
import { Toast } from './core/Toast.js';

import { LegalView } from './views/LegalView.js';
import { HomeView } from './views/HomeView.js';
import { JobView } from './views/JobView.js';
import { HistoryView } from './views/HistoryView.js';
import { DataStudioView } from './views/DataStudioView.js';
import { SettingsView } from './views/SettingsView.js';

function initIcons() {
  const brandLogo = document.getElementById('brand-logo');
  if (brandLogo) brandLogo.innerHTML = icon('brand');

  document.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    el.innerHTML = icon(name);
  });
}

function initRippleEffect() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn, .btn-circle-lg');
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple-span';
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 520);
  });
}

function updateEngineBadge(engineState) {
  const dot = document.getElementById('engine-dot');
  const txt = document.getElementById('engine-text');
  if (!dot || !txt) return;

  dot.className = 'status-dot';
  if (engineState === 'ready') {
    dot.classList.add('ready');
    txt.textContent = 'Prêt';
  } else if (engineState === 'busy') {
    dot.classList.add('busy');
    txt.textContent = 'Actif';
  } else if (engineState === 'error') {
    dot.classList.add('error');
    txt.textContent = 'Erreur';
  } else {
    txt.textContent = 'Init...';
  }
}

async function initApp() {
  initIcons();
  initRippleEffect();

  const viewRoot = document.getElementById('view-root');
  const router = new Router(viewRoot, {
    legal: LegalView,
    home: HomeView,
    job: JobView,
    history: HistoryView,
    studio: DataStudioView,
    settings: SettingsView
  });

  // Navigation barre latérale
  document.querySelectorAll('#sidebar-nav .nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-route');
      router.navigate(target);
    });
  });

  // Clic sur la pastille moteur -> ping diagnostic rapide
  document.getElementById('engine-pill')?.addEventListener('click', async () => {
    try {
      const pong = await Api.invoke('engine:ping');
      updateEngineBadge(pong.state);
      Toast.show(`Moteur Python prêt (${pong.latencyMs} ms)`);
    } catch (err) {
      updateEngineBadge('error');
      Toast.show(err.message, { type: 'error' });
    }
  });

  // Écoute des événements du moteur Python
  Api.onEngineEvent((evt) => {
    if (evt.type === 'ready') {
      updateEngineBadge('ready');
    } else if (evt.type === 'engine:state') {
      updateEngineBadge(evt.state);
    }
  });

  // Chargement initial de l'état légal, des réglages et du moteur
  const [legalRes, settings, engineStatus] = await Promise.all([
    Api.invoke('legal:status'),
    Api.invoke('settings:get'),
    Api.invoke('engine:status')
  ]);

  document.documentElement.setAttribute('data-theme', settings.theme || 'light');
  updateEngineBadge(engineStatus.state);

  const accepted = Boolean(legalRes && legalRes.acceptance);
  store.setState({
    legalAccepted: accepted,
    settings,
    engine: engineStatus
  });

  await router.navigate(accepted ? 'home' : 'legal');
}

window.addEventListener('DOMContentLoaded', () => {
  initApp().catch((err) => {
    console.error('Erreur initialisation UI:', err);
  });
});
