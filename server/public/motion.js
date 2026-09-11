/* Motion for the panel, driven by GSAP.

   Every call is a no-op when GSAP is missing or the reader asked for reduced
   motion, so nothing here changes what the panel does, only how a change lands:
   a page rises into place instead of appearing, the sidebar highlight slides to
   the current link instead of one link losing its background while another
   gains it, and dialogs and menus settle in rather than popping. */
window.rcMotion = (function () {
  'use strict';
  const g = window.gsap;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const on = () => !!g && !reduced();
  const ease = 'power2.out';
  const clear = 'opacity,transform';

  // A page or panel arriving on screen.
  function enter(el) {
    if (!on() || !el || el.hidden) return;
    g.killTweensOf(el);
    g.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.22, ease, clearProps: clear });
  }
  // The breadcrumb's parts, after its text changed.
  function crumbs(el) {
    if (!on() || !el || !el.children.length) return;
    g.killTweensOf(el.children);
    g.fromTo(el.children, { opacity: 0, y: -3 }, { opacity: 1, y: 0, duration: 0.18, ease, stagger: 0.03, clearProps: clear });
  }
  // Rows of a freshly rendered list. Capped so a long list does not queue a wave.
  const ROWS = '.workspace-overview-row,.rc-space-member,.rc-space-card,.cr-conversation-row,.rc-space-file,.workspace-account-list>article';
  function list(root, selector) {
    if (!on() || !root) return;
    const rows = [...root.querySelectorAll(selector || ROWS)].slice(0, 14);
    if (!rows.length) return;
    g.killTweensOf(rows);
    g.fromTo(rows, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.2, ease, stagger: 0.025, clearProps: clear });
  }
  function dialog(d) {
    if (!on() || !d) return;
    g.fromTo(d, { opacity: 0, scale: 0.97, y: 6 }, { opacity: 1, scale: 1, y: 0, duration: 0.18, ease, clearProps: clear });
  }
  function popover(el) {
    if (!on() || !el) return;
    g.fromTo(el, { opacity: 0, y: -4, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.14, ease, clearProps: clear });
  }

  // Sidebar marker: one highlight that travels to the current link. It lives inside
  // the same scroll container as that link, so it scrolls with the list. A list
  // rebuild destroys it; it is then re-attached and placed without a tween.
  let marker = null, markerHost = null;
  function currentLink() {
    const nav = document.getElementById('crProjectNav');
    if (!nav) return null;
    const links = [...nav.querySelectorAll('a[aria-current="page"],button[aria-current="page"]')].filter(a => a.getClientRects().length);
    return links.at(-1) || null;
  }
  function placeMarker() {
    if (!on()) { document.body.classList.remove('rc-marker'); return; }
    const target = currentLink();
    if (!target) { if (marker && marker.isConnected) g.to(marker, { opacity: 0, duration: 0.12 }); document.body.classList.remove('rc-marker'); return; }
    const host = target.closest('#crProjectLinks') || target.closest('.cr-primary-nav') || target.parentElement;
    if (!marker) { marker = document.createElement('div'); marker.className = 'nav-marker'; marker.setAttribute('aria-hidden', 'true'); }
    let jump = false;
    if (markerHost !== host || !marker.isConnected) { host.append(marker); markerHost = host; jump = true; }
    document.body.classList.add('rc-marker');
    const hr = host.getBoundingClientRect(), tr = target.getBoundingClientRect();
    const to = { top: tr.top - hr.top + host.scrollTop, left: tr.left - hr.left + host.scrollLeft, width: tr.width, height: tr.height };
    g.killTweensOf(marker);
    if (jump || !marker.style.width) { g.set(marker, { ...to, opacity: 1 }); return; }
    g.to(marker, { ...to, opacity: 1, duration: 0.22, ease });
  }

  // Dialogs and popovers open from many places; animating the open itself covers
  // all of them without touching a caller.
  if (window.HTMLDialogElement && !HTMLDialogElement.prototype.__rcMotion) {
    const show = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { show.apply(this, arguments); if (!this.dataset.noMotion) dialog(this); };
    HTMLDialogElement.prototype.__rcMotion = true;
  }
  if (window.HTMLElement && HTMLElement.prototype.showPopover && !HTMLElement.prototype.__rcMotion) {
    const show = HTMLElement.prototype.showPopover;
    HTMLElement.prototype.showPopover = function () { show.apply(this, arguments); if (this.id === 'controlMenu' || this.classList.contains('control-menu')) popover(this); };
    HTMLElement.prototype.__rcMotion = true;
  }
  window.addEventListener('resize', () => { if (marker && marker.isConnected) placeMarker(); });

  return { on, enter, crumbs, list, dialog, popover, marker: placeMarker };
})();
