import { createConsoleReceiver, receiverAvailability } from './receiver.ts';
import type { ReceiverState } from './receiver.ts';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const field = (id: string) => element<HTMLTextAreaElement>(id);
const surface = element('surface'), pointer = element('pointer');
function render(state: ReceiverState) {
  element('status').textContent = state.message;
  field('invitation').value = state.invitation; field('answer').value = state.answer; field('comparison').value = state.comparison;
  button('invite').disabled = state.phase === 'preparing' || state.phase === 'unavailable';
  button('cancel').disabled = !['preparing', 'invitation', 'connecting', 'comparison', 'connected', 'active'].includes(state.phase);
  button('use-offer').disabled = state.phase !== 'invitation';
  button('confirm').disabled = !state.comparison || state.confirmed || state.phase === 'stopped';
  button('allow').disabled = !state.canAllow;
  surface.dataset.active = String(state.phase === 'active'); surface.dataset.contact = String(state.contact);
  pointer.hidden = !state.position;
  if (state.position) { pointer.style.left = `${state.position.x}px`; pointer.style.top = `${state.position.y}px`; }
  const description = state.position ? `Pointer ${state.contact ? 'pressed' : 'released'}.` : 'No pointer allowed.';
  surface.setAttribute('aria-label', `Controller surface. ${description}`); element('effect').textContent = description;
}
const receiver = createConsoleReceiver({ onChange: render });
render(receiver.state());
const availability = () => receiverAvailability({ href: location.href, secure: isSecureContext,
  rtc: typeof RTCPeerConnection === 'function', crypto: !!globalThis.crypto?.subtle });
button('invite').onclick = () => { field('offer').value = ''; if (availability() !== 'ready') receiver.unavailable(); else void receiver.createInvitation(); };
button('use-offer').onclick = () => { void receiver.acceptOffer(field('offer').value); };
button('confirm').onclick = () => { receiver.confirm(field('comparison').value); };
button('allow').onclick = () => { receiver.allow(); };
button('cancel').onclick = () => { field('offer').value = ''; receiver.stop('Request cancelled. Create a fresh invitation when you are ready.'); };
button('stop').onclick = () => { field('offer').value = ''; receiver.stop(); };
const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect) receiver.resize(rect.width, rect.height); });
observer.observe(surface);
const hidden = () => { if (document.hidden) receiver.stop('Screen hidden. Control is released. Create a fresh invitation to reconnect.'); };
const close = () => { observer.disconnect(); receiver.stop('Screen left. Control is released. Create a fresh invitation to reconnect.'); receiver.close(); };
document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', close);
window.addEventListener('pageshow', event => { if (event.persisted) observer.observe(surface); });
if (availability() !== 'ready') receiver.unavailable();
