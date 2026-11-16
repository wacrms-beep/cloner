/**
 * Composant Switch : interrupteur iOS accessible au clavier et à la souris.
 */
export function createSwitch({ checked = false, onChange = () => {}, label = '' } = {}) {
  let state = Boolean(checked);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.role = 'switch';
  btn.ariaChecked = String(state);
  if (label) btn.ariaLabel = label;
  btn.className = `ios-switch ${state ? 'checked' : ''}`.trim();

  const thumb = document.createElement('span');
  thumb.className = 'ios-switch-thumb';
  btn.appendChild(thumb);

  btn.addEventListener('click', () => {
    state = !state;
    btn.ariaChecked = String(state);
    btn.classList.toggle('checked', state);
    onChange(state);
  });

  btn.getValue = () => state;
  btn.setValue = (val) => {
    state = Boolean(val);
    btn.ariaChecked = String(state);
    btn.classList.toggle('checked', state);
  };

  return btn;
}
