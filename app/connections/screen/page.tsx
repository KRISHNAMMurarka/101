import type { Metadata } from 'next';
import ScreenView from './ScreenView';

export const metadata: Metadata = { title: '101 — Brief screen preview', description: 'Review separate permissions for a brief local screen or window sample, choose explicitly, and stop whenever you are done.' };
export default function ScreenPage() { return <ScreenView />; }
