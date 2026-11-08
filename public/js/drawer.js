// The chats drawer: one open/close pair keeps the drawer, its scrim, the inert state of the page behind it
// and keyboard focus in step. Every way of leaving the drawer (close button, scrim, Escape, opening a chat)
// goes through close(), so none of that state can go stale.
export function createDrawer({ drawer, scrim, opener, closeButton, background = [], doc = document }) {
  let open = false;

  function show() {
    if (open) return;
    open = true;
    drawer.hidden = false;
    scrim.hidden = false;
    for (const el of background) el.inert = true;
    closeButton.focus();
  }

  function hide() {
    if (!open) return;
    open = false;
    drawer.hidden = true;
    scrim.hidden = true;
    for (const el of background) el.inert = false;
    opener.focus();
  }

  opener.addEventListener('click', show);
  closeButton.addEventListener('click', hide);
  scrim.addEventListener('click', hide);
  doc.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });

  return { open: show, close: hide, isOpen: () => open };
}
