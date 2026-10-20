import { createPointerResourceSource, createEphemeralWebIdentity, decodeReceiverInvitationInput } from '@uynis-connect/connect';
import type { ReceiverInvitation, PointerResourceSource } from '@uynis-connect/connect';
const field = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
let source: PointerResourceSource | undefined, timer: ReturnType<typeof setInterval> | undefined;
let reviewed: ReceiverInvitation | undefined, generation = 0;
function stop() { generation++; if (timer !== undefined) clearInterval(timer); timer = undefined; source?.close(); source = undefined; button('move').disabled = true; button('press').disabled = true; }
button('review').onclick = () => {
  reviewed = decodeReceiverInvitationInput(field('invitation').value, Date.now());
  document.getElementById('scope')!.textContent = `${reviewed.applicationId}\n${reviewed.sessionId}`;
  button('connect').disabled = false;
};
button('connect').onclick = async () => {
  stop(); const revision = generation;
  field('offer').value = ''; field('comparison').value = ''; field('answer').value = '';
  const target = reviewed!; button('connect').disabled = true;
  const identity = await createEphemeralWebIdentity();
  if (revision !== generation) return;
  const current = createPointerResourceSource({ identity, invitation: target, clockDomain: 'owned-console-qa-source',
    now: () => performance.now(), platform: 'owned-browser-controller', available: () => true });
  source = current;
  timer = setInterval(() => { current.tick(); const state = current.enrollment();
    field('comparison').value = state.comparisonDigest ?? ''; button('confirm').disabled = state.phase !== 'awaiting-enrollment';
    button('move').disabled = button('press').disabled = !current.status().ready;
    document.getElementById('state')!.textContent = current.status().ready ? 'ready' : state.phase;
  }, 10);
  try { const offer = await current.createOffer(); if (revision === generation) field('offer').value = offer; }
  catch { if (revision === generation) stop(); }
};
button('use-answer').onclick = () => { void source?.acceptAnswer(field('answer').value); };
button('confirm').onclick = () => { source?.confirmEnrollment(field('comparison').value); };
button('move').onclick = () => source?.nudge(.1, 0);
button('press').onclick = () => source?.setContact(true);
button('stop').onclick = stop;
window.addEventListener('pagehide', stop);
