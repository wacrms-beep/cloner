/**
 * Composant ProgressRing : anneau de progression SVG fluide.
 */
export class ProgressRing {
  constructor({ size = 168, stroke = 12 } = {}) {
    this.size = size;
    this.stroke = stroke;
    this.radius = (size - stroke) / 2;
    this.circumference = 2 * Math.PI * this.radius;

    this.el = document.createElement('div');
    this.el.className = 'progress-ring-wrap';
    this.el.style.width = `${size}px`;
    this.el.style.height = `${size}px`;

    this.el.innerHTML = `
      <svg class="progress-ring-svg" width="${size}" height="${size}">
        <circle
          class="progress-ring-bg"
          stroke-width="${stroke}"
          fill="transparent"
          r="${this.radius}"
          cx="${size / 2}"
          cy="${size / 2}"
        />
        <circle
          class="progress-ring-bar"
          stroke-width="${stroke}"
          fill="transparent"
          r="${this.radius}"
          cx="${size / 2}"
          cy="${size / 2}"
          stroke-dasharray="${this.circumference} ${this.circumference}"
          stroke-dashoffset="${this.circumference}"
        />
      </svg>
      <div class="progress-ring-center">
        <span class="progress-ring-value">0%</span>
        <span class="progress-ring-sub">Préparation</span>
      </div>
    `;

    this.barEl = this.el.querySelector('.progress-ring-bar');
    this.valEl = this.el.querySelector('.progress-ring-value');
    this.subEl = this.el.querySelector('.progress-ring-sub');
  }

  update(percent = 0, label = '') {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const offset = this.circumference - (clamped / 100) * this.circumference;
    this.barEl.style.strokeDashoffset = `${offset}`;
    this.valEl.textContent = `${Math.round(clamped)}%`;
    if (label) {
      this.subEl.textContent = label;
    }
  }
}
