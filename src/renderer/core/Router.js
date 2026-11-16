/**
 * Routeur de vues côté Renderer avec transitions animées.
 */
import { store } from './Store.js';

export class Router {
  constructor(viewRoot, routes) {
    this.viewRoot = viewRoot;
    this.routes = routes;
    this.currentViewInstance = null;
  }

  async navigate(routeName, params = {}) {
    const state = store.getState();
    if (!state.legalAccepted && routeName !== 'legal') {
      routeName = 'legal';
    }

    const ViewFactory = this.routes[routeName];
    if (!ViewFactory) return;

    if (this.currentViewInstance && typeof this.currentViewInstance.unmount === 'function') {
      this.currentViewInstance.unmount();
    }

    store.setState({ route: routeName, routeParams: params });
    this._syncSidebar(routeName);

    this.viewRoot.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'view-enter';
    wrapper.style.height = '100%';
    this.viewRoot.appendChild(wrapper);

    this.currentViewInstance = new ViewFactory(wrapper, params, this);
    await this.currentViewInstance.mount();
  }

  _syncSidebar(routeName) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
      sidebar.style.display = routeName === 'legal' ? 'none' : 'flex';
    }
    const buttons = document.querySelectorAll('#sidebar-nav .nav-btn');
    buttons.forEach((btn) => {
      const target = btn.getAttribute('data-route');
      btn.classList.toggle('active', target === routeName || (routeName === 'job' && target === 'home'));
    });
  }
}
