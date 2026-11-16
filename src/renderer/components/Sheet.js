/**
 * Composant Sheet : tiroir modal glassmorphisme centré.
 */
import { icon } from '../core/Icons.js';

export class Sheet {
  static open({ title = 'Options', contentNode, onClose = null }) {
    const root = document.getElementById('sheet-root');
    if (!root) return;
    root.innerHTML = '';

    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop view-enter';

    const modal = document.createElement('div');
    modal.className = 'sheet-modal glass-card-strong';

    const header = document.createElement('div');
    header.className = 'sheet-header';

    const h2 = document.createElement('h2');
    h2.textContent = title;
    header.appendChild(h2);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary btn-icon';
    closeBtn.innerHTML = icon('close');
    closeBtn.title = 'Fermer';

    const close = () => {
      root.innerHTML = '';
      if (typeof onClose === 'function') onClose();
    };

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    header.appendChild(closeBtn);
    modal.appendChild(header);
    modal.appendChild(contentNode);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);

    return { close };
  }
}
