import type { Metadata } from 'next';
import HistoryView from './HistoryView';

export const metadata: Metadata = {
  title: '101 — History on this browser',
  description: 'Choose whether to keep this page’s size or position, then separately review download or removal.',
};
export default function HistoryPage() { return <HistoryView />; }
