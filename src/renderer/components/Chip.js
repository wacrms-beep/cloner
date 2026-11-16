/**
 * Composant Chip : badge arrondi animé pour compteurs et statuts.
 */
export function createChip({ label, value = null, variant = 'default', iconHtml = '' } = {}) {
  const span = document.createElement('span');
  span.className = `chip ${variant !== 'default' ? `chip-${variant}` : ''}`.trim();

  if (iconHtml) {
    const ic = document.createElement('span');
    ic.innerHTML = iconHtml;
    ic.style.display = 'inline-flex';
    span.appendChild(ic);
  }

  const textNode = document.createElement('span');
  textNode.textContent = value !== null && value !== undefined ? `${label} : ${value}` : label;
  span.appendChild(textNode);

  span.setValue = (newVal) => {
    textNode.textContent = `${label} : ${newVal}`;
  };

  return span;
}
