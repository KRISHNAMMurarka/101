import type { Metadata } from 'next';
import ConnectionsView from './ConnectionsView';

export const metadata: Metadata = { title: '101 Connections — Connect an input',
  description: 'Choose an input and where it can act. Both screens stay in control.' };
export default function ConnectionsPage() { return <ConnectionsView />; }
