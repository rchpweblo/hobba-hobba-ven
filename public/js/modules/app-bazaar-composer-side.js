// ═══════════════════════════════════════════════════════════
// Bizarre Bazaar fork: Right side message buttons
// (Settings > Layout & Density > Message Box).
//
// When on, the message box's button bar (upload, emoji, GIF, poll, ...) sits
// on its right, between the box and the Send button, and the pickers it opens
// line up on that side. Kept in this browser, like the other Message Box
// options. A browser that has never had it set asks the server once:
// accounts made from release 26 on start with it on, members who joined
// earlier keep the buttons where they were (src/bazaarComposerSide.js).
// ═══════════════════════════════════════════════════════════

const KEY = 'haven_bz_right_buttons';
const ATTR = 'data-bz-right-buttons';

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; } // storage blocked: read as unset
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: on for this visit only */ }
}

// Flex order moves the bar (or the + of the folded bar) after the text box;
// the Send button stays last. The pickers open from the right edge instead
// of the left, except on a phone, where they already span the screen.
const CSS = `
[${ATTR}] #message-input-area > .input-actions-box,
[${ATTR}] #message-input-area > .btn-composer-plus { order: 1; }
[${ATTR}] #message-input-area > #send-btn { order: 2; }
[${ATTR}][data-compact-composer] #message-input-area > .input-actions-box { left: auto; right: 1.25rem; }
@media (min-width: 481px) {
  [${ATTR}] #message-input-area > #emoji-picker,
  [${ATTR}] #message-input-area > #gif-picker,
  [${ATTR}] #message-input-area > #format-picker { left: auto; right: 1.25rem; }
}
`;

export default {

_bazaarSetupComposerSide() {
  if (!document.getElementById('bz-composer-side-style')) {
    const style = document.createElement('style');
    style.id = 'bz-composer-side-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const box = document.getElementById('bz-right-buttons');
  const apply = (on) => {
    document.documentElement.toggleAttribute(ATTR, on);
    if (box) box.checked = on;
  };
  apply(lsGet(KEY) === 'true');
  box?.addEventListener('change', () => {
    lsSet(KEY, String(box.checked));
    this._closeComposerMenu?.(); // the folded menu reopens on the new side
    apply(box.checked);
  });
  // Never set in this browser: a new account starts with it on.
  this.socket?.on('session-info', (info) => {
    if (lsGet(KEY) !== null || !info || typeof info.bazaarNewAccount !== 'boolean') return;
    lsSet(KEY, String(info.bazaarNewAccount));
    apply(info.bazaarNewAccount);
  });
},

};
