import type { Metadata } from 'next';
import MicrophoneView from './MicrophoneView';

export const metadata: Metadata = { title: '101 — Check microphone levels',
  description: 'Choose one microphone, review its use on this page, check signal levels and stop.' };
export default function MicrophonePage() { return <MicrophoneView />; }
