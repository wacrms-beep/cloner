/**
 * LegalView : écran de mentions légales affiché au premier lancement uniquement.
 * L'acceptation est stockée en base SQLite (table legal_acceptance).
 */
import { Api } from '../core/Api.js';
import { store } from '../core/Store.js';
import { Toast } from '../core/Toast.js';
import { icon } from '../core/Icons.js';

export class LegalView {
  constructor(root, params, router) {
    this.root = root;
    this.router = router;
  }

  async mount() {
    this.root.innerHTML = `
      <div class="legal-wrapper">
        <div class="legal-card glass-card-strong">
          <div style="display:flex;align-items:center;gap:12px;">
            <div class="sidebar-brand">${icon('shield')}</div>
            <div>
              <h1>Conditions d’utilisation</h1>
              <p style="color:var(--text-secondary);font-size:13px;">Universal Clone — Exécution 100 % locale</p>
            </div>
          </div>

          <div style="padding:14px;border-radius:var(--radius-md);background:var(--surface-muted);display:flex;flex-direction:column;gap:8px;font-size:13.5px;">
            <p>• Cet outil est destiné à l’archivage, au test, à la rétro-ingénierie autorisée et à la migration de vos propres sites web.</p>
            <p>• L’option <strong>Respecter robots.txt</strong> est activée par défaut.</p>
            <p>• Le contenu protégé par le droit d’auteur ou les marques de tiers demeure sous votre entière responsabilité.</p>
          </div>

          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:600;">
            <input type="checkbox" id="legal-checkbox" style="width:18px;height:18px;" />
            <span>Je confirme avoir le droit de copier et d’analyser les sites ciblés.</span>
          </label>

          <button id="legal-continue-btn" class="btn btn-primary" disabled style="width:100%;padding:13px;">
            ${icon('check')}
            <span>Continuer</span>
          </button>
        </div>
      </div>
    `;

    const checkbox = this.root.querySelector('#legal-checkbox');
    const continueBtn = this.root.querySelector('#legal-continue-btn');

    checkbox.addEventListener('change', () => {
      continueBtn.disabled = !checkbox.checked;
    });

    continueBtn.addEventListener('click', async () => {
      try {
        await Api.invoke('legal:accept', { confirmed: true });
        store.setState({ legalAccepted: true });
        await this.router.navigate('home');
      } catch (err) {
        Toast.show(err.message, { type: 'error' });
      }
    });
  }
}
