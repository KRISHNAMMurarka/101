import type { Metadata } from 'next';
import WatchSharingView from './WatchSharingView';

export const metadata: Metadata = {
  title: '101 Sharing — Share a read-only page view',
  description: 'Connect browser pages and review separate approvals to display your page controls.',
};
export default function WatchSharingPage() { return <WatchSharingView />; }
