/**
 * Store réactif global pour l'état de l'interface.
 */
class Store {
  constructor() {
    this.state = {
      route: 'home',
      routeParams: {},
      legalAccepted: false,
      settings: null,
      engine: { state: 'starting', version: null, activeCloneId: null, queueLength: 0 },
      activeClone: null,
      recentClones: []
    };
    this.listeners = new Set();
  }

  getState() {
    return this.state;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) {
      fn(this.state);
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const store = new Store();
