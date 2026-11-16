/**
 * Gestionnaire de notifications Toast avec support de bouton d'action (ex: Annuler suppression 5s).
 */
export const Toast = {
  show(message, { type = 'info', durationMs = 3800, actionLabel = null, onAction = null } = {}) {
    const root = document.getElementById('toast-root');
    if (!root) return;

    const item = document.createElement('div');
    item.className = `toast-item view-enter toast-${type}`;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    item.appendChild(textSpan);

    if (actionLabel && typeof onAction === 'function') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.style.padding = '4px 12px';
      btn.style.fontSize = '12px';
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => {
        onAction();
        item.remove();
      });
      item.appendChild(btn);
    }

    root.appendChild(item);
    setTimeout(() => {
      if (item.parentNode) {
        item.remove();
      }
    }, durationMs);
  }
};
