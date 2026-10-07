import type { Metadata } from 'next';
import AudioView from './AudioView';

export const metadata: Metadata = { title: '101 — Try sound here' };

export default function AudioPage() { return <AudioView />; }
