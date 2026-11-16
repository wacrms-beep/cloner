/**
 * Composant StepTimeline : affiche les 6 étapes du clonage :
 * Préparation → Aspiration → Réseau → Schéma → Backend → Emballage
 */
const PHASES = [
  { key: 'prepare', label: 'Préparation' },
  { key: 'crawl', label: 'Aspiration' },
  { key: 'network', label: 'Réseau' },
  { key: 'schema', label: 'Schéma' },
  { key: 'backend', label: 'Backend' },
  { key: 'package', label: 'Emballage' }
];

export class StepTimeline {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'step-timeline';
    this.nodes = new Map();

    PHASES.forEach((p, idx) => {
      const node = document.createElement('div');
      node.className = 'step-node';
      node.innerHTML = `
        <span style="font-size:11px;opacity:0.8;">0${idx + 1}</span>
        <span>${p.label}</span>
      `;
      this.nodes.set(p.key, node);
      this.el.appendChild(node);
    });
  }

  setPhase(activeKey, isCompleted = false) {
    let passedActive = false;
    for (const p of PHASES) {
      const node = this.nodes.get(p.key);
      node.classList.remove('active', 'done');
      if (isCompleted) {
        node.classList.add('done');
      } else if (p.key === activeKey) {
        node.classList.add('active');
        passedActive = true;
      } else if (!passedActive) {
        node.classList.add('done');
      }
    }
  }
}

export function getPhaseLabel(key) {
  const found = PHASES.find((p) => p.key === key);
  return found ? found.label : 'Traitement';
}
