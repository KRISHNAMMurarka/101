import type { Metadata } from 'next';
import SettingsView from './SettingsView';

export const metadata: Metadata = {
  title: '101 Settings — Appearance on this browser',
  description: 'Preview this page’s appearance and choose whether to save, reset or remove your local choices.',
};
export default function SettingsPage() { return <SettingsView />; }
