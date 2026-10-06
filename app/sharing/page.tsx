import type { Metadata } from 'next';
import SharingView from './SharingView';

export const metadata: Metadata = {
  title: '101 Sharing — Choose who can use your play area',
  description: 'Review, divide, transfer and stop sharing the controls on this page.',
};
export default function SharingPage() { return <SharingView />; }
