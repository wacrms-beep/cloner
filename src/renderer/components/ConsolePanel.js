/**
 * Composant ConsolePanel : console de journaux temps réel repliable et filtrable par niveau.
 */
export class ConsolePanel {
  constructor() {
    this.logs = [];
    this.filterLevel = 'all';
    this.collapsed = false;

    this.el = document.createElement('div');
    this.el.className = 'console-panel';

    const header = document.createElement('div');
    header.className = 'console-header';

    const titleWrap = document.createElement('div');
    titleWrap.style.display = 'flex';
    titleWrap.style.alignItems = 'center';
    titleWrap.style.gap = '10px';
    titleWrap.innerHTML = `<strong>Journal temps réel</strong>`;

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '6px';
    controls.style.alignItems = 'center';

    const select = document.createElement('select');
    select.className = 'glass-input';
    select.style.padding = '4px 10px';
    select.style.fontSize = '12px';
    select.innerHTML = `
      <option value="all">Tous</option>
      <option value="info">Info</option>
      <option value="warn">Avertissements</option>
      <option value="error">Erreurs</option>
    `;
    select.addEventListener('change', () => {
      this.filterLevel = select.value;
      this.renderLogs();
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-secondary';
    toggleBtn.style.padding = '4px 12px';
    toggleBtn.style.fontSize = '12px';
    toggleBtn.textContent = 'Replier';
    toggleBtn.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.bodyEl.style.display = this.collapsed ? 'none' : 'flex';
      toggleBtn.textContent = this.collapsed ? 'Déplier' : 'Replier';
    });

    controls.appendChild(select);
    controls.appendChild(toggleBtn);
    header.appendChild(titleWrap);
    header.appendChild(controls);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'console-body';

    this.el.appendChild(header);
    this.el.appendChild(this.bodyEl);
  }

  setLogs(list = []) {
    this.logs = Array.isArray(list) ? [...list] : [];
    this.renderLogs();
  }

  appendLog(entry) {
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    if (this.filterLevel === 'all' || entry.level === this.filterLevel) {
      this._appendDomLine(entry);
      this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    }
  }

  renderLogs() {
    this.bodyEl.innerHTML = '';
    const filtered = this.filterLevel === 'all'
      ? this.logs
      : this.logs.filter((l) => l.level === this.filterLevel);

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = 'var(--text-tertiary)';
      empty.textContent = 'Aucune entrée de journal.';
      this.bodyEl.appendChild(empty);
      return;
    }

    for (const entry of filtered) {
      this._appendDomLine(entry);
    }
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  _appendDomLine(entry) {
    const line = document.createElement('div');
    const level = entry.level || 'info';
    line.className = `log-line ${level}`;

    const badge = document.createElement('span');
    badge.style.fontWeight = '700';
    badge.textContent = `[${String(level).toUpperCase()}]`;

    const phase = document.createElement('span');
    phase.style.color = 'var(--text-secondary)';
    phase.textContent = `[${entry.phase || 'main'}]`;

    const msg = document.createElement('span');
    msg.className = 'selectable';
    msg.textContent = entry.message || '';

    line.appendChild(badge);
    line.appendChild(phase);
    line.appendChild(msg);
    this.bodyEl.appendChild(line);
  }
}
