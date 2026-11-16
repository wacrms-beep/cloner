/**
 * Composant GlassCard : carte en verre dépoli avec animation cascade optionnelle.
 */
export function createGlassCard({ title = '', subtitle = '', strong = false, className = '', cascade = false } = {}) {
  const card = document.createElement('section');
  card.className = `${strong ? 'glass-card-strong' : 'glass-card'} ${cascade ? 'cascade-item' : ''} ${className}`.trim();
  card.style.padding = '20px';

  if (title) {
    const header = document.createElement('div');
    header.style.marginBottom = '14px';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    header.appendChild(h3);
    if (subtitle) {
      const p = document.createElement('p');
      p.style.fontSize = '12.5px';
      p.style.color = 'var(--text-secondary)';
      p.style.marginTop = '2px';
      p.textContent = subtitle;
      header.appendChild(p);
    }
    card.appendChild(header);
  }

  return card;
}
